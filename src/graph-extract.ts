/**
 * 规则式实体/关系抽取（图检索的"规则兜底"那一半，零依赖、零 API、确定性）。
 *
 * 为什么不直接用 LLM 抽：调 LLM 要钱、要网、结果不稳定；而且这是个"本地优先"的项目。
 * 所以分三层：
 *   1. 手动标注最优先（add 的 subject / entities / relations 参数）
 *   2. 规则兜底（本文件）——只认高置信度的少数句式，宁可漏，不要错
 *   3. LLM 抽取留给上层自己做（结果仍走 add 的 relations 参数进来）
 *
 * 设计原则：**宁缺毋滥**。一条抽错的关系会污染"张三和李四什么关系"的答案，
 * 比少抽十条更糟。所以只认几种结构极清楚的句子，且要求实体名长度 ≥ 2。
 */
import type { EntityType } from "./types.js";

/** 一个待写入的实体 */
export interface RuleEntity {
  name: string;
  type: EntityType;
}

/** 一条待写入的关系 */
export interface RuleRelation {
  from: string;
  fromType: EntityType;
  to: string;
  toType: EntityType;
  predicate: string;
}

/** 代词：句子里出现"我/他"时，真正的实体是记忆的 subject */
const PRONOUNS = new Set(["我", "你", "他", "她", "它", "我们", "你们", "他们", "她们", "它们", "本人", "自己"]);

/** 地名后缀（行政区划 + 常见地形） */
const PLACE_SUFFIX = /(?:市|省|区|县|镇|乡|村|国|州|路|街|巷|城|岛|港|湾|山|河|湖|海|园|苑|郡|旗|胡同)$/;
/** 机构后缀 */
const ORG_SUFFIX = /(?:公司|集团|大学|学院|学校|中学|小学|医院|银行|法院|检察院|派出所|中心|研究院|研究所|事务所|工作室|委员会|部门|局|厅|委|办|厂|店|馆|协会|联盟|基金会)$/;
/** 常见汉族姓氏（够用即可；不是人口普查，是"看着像人名"的启发式） */
const SURNAMES = new Set(
  (
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛" +
    "奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康" +
    "伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵" +
    "席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗" +
    "丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫" +
    "乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄"
  ).split(""),
);

/** 实体名字里不该出现的动词/方位词（抽出来会导致"用户住在"这种怪名字） */
const NAME_STOP = new Set([
  "住在", "搬到", "位于", "工作", "上班", "任职", "就职", "读书", "上学", "学习",
  "的", "了", "在", "和", "与", "跟", "是", "有", "去", "来", "说", "想", "要",
]);

/** 名字前缀动词（"喝绿茶" → "绿茶"）。
 *  审查修复（M-13b）：长分支必须放在交替最前——"去"排在"去了一趟"前面时，
 *  "去了趟北京"只会剥掉"去"，剩下"了趟北京"这种脏实体名。 */
const LEADING_VERB = /^(?:去了一趟|去了|去过|学过|练过|喝|吃|玩|看|听|读|买|用|做|来|去)+/;
/** 名字尾部语气词/连接词 */
const TRAILING_PARTICLE = /[的了呢啊吗吧和与跟，。、；：！？\s]+$/g;

/** 清洗候补实体名：去首尾杂字、去动词前缀、去语气词 */
export function cleanEntityName(raw: string): string | null {
  let s = raw.replace(/^[的了呢啊吗吧和与跟，。、；：！？\s]+/g, "").trim();
  // 去动词前缀，但**不能把名字削到 1 个字**："用户"里的"用"是名字的一部分，
  // 削掉就只剩"户"，整条关系会被误判成"名字不合法"而丢弃。
  const stripped = s.replace(LEADING_VERB, "").replace(TRAILING_PARTICLE, "").trim();
  s = stripped.length >= 2 ? stripped : s.replace(TRAILING_PARTICLE, "").trim();
  if (s.length < 2) return null; // 单字极易误抽（"王"不是姓名，"京"不是地名）
  if (NAME_STOP.has(s)) return null;
  return s;
}

/** 按后缀推断实体类型 */
export function inferEntityType(name: string): EntityType {
  if (PLACE_SUFFIX.test(name)) return "place";
  if (ORG_SUFFIX.test(name)) return "org";
  if (name.length >= 2 && name.length <= 4 && SURNAMES.has(name.slice(0, 1))) return "person";
  if (/^[A-Za-z]/.test(name)) {
    // 拉丁名：首字母大写视为人名/机构，全小写视为普通概念
    return /^[A-Z]/.test(name) ? "person" : "concept";
  }
  return "unknown";
}

/**
 * 一条规则：从捕获组里取实体 A / B（以及可能的谓词名词）。
 * 每条规则都明确声明自己哪个捕获组是起点、哪个是终点——
 * 因为中文句式里"张三的同学是李四"和"张三是李四的同学"词序相反，
 * 靠"第 1 组一定是 A"的隐含约定迟早抽错方向。
 */
interface Rule {
  re: RegExp;
  /** 起点实体所在的捕获组下标（1-based） */
  aSlot: number;
  /** 终点实体所在的捕获组下标（1-based） */
  bSlot: number;
  /** 谓词来源：固定字面，或从某个捕获组取（如"同学/同事"） */
  predicate: string | { slot: number; fallback: string };
  /** 类型提示（只在规则有把握时给，例如"住在"后面一定是地点） */
  fromType?: EntityType;
  toType?: EntityType;
}

const SLOT_BODY = "[\\u4e00-\\u9fa5A-Za-z0-9·]{1,10}";
const SLOT = `(${SLOT_BODY})`;
/** 实体和谓词之间允许中文标点/空白（"张三，住在北京" 不该因为一个逗号漏抽） */
const GAP = "[，,、；;\\s]*";

const RULES: Rule[] = [
  // 用户住在北京 / 张三搬到杭州 / 公司位于深圳市南山区
  {
    re: new RegExp(`${SLOT}${GAP}(?:住在|居住在|搬到|搬到了|生活在|位于)${GAP}${SLOT}`),
    aSlot: 1,
    bSlot: 2,
    predicate: "住在",
    toType: "place",
  },
  // 用户在北京工作 / 张教授在清华大学任职 / 小李在北大读书
  {
    re: new RegExp(`${SLOT}${GAP}在${GAP}${SLOT}${GAP}(工作|上班|任职|就职|读书|上学|学习)`),
    aSlot: 1,
    bSlot: 2,
    predicate: { slot: 3, fallback: "工作于" },
  },
  // 张三是李四的同学 / 王经理是阿里巴巴的员工（A 是 B 的 X）
  {
    re: new RegExp(
      `${SLOT}${GAP}是${GAP}${SLOT}${GAP}的${GAP}(同学|同事|朋友|老板|上司|下属|老师|学生|领导|客户|合伙人|妻子|丈夫|妈妈|爸爸|儿子|女儿|哥哥|姐姐|弟弟|妹妹|邻居|室友|员工)`,
    ),
    aSlot: 1,
    bSlot: 2,
    predicate: { slot: 3, fallback: "关联" },
  },
  // 张三的同学是李四（词序相反，方向仍是 张三 → 李四）
  {
    re: new RegExp(
      `${SLOT}${GAP}的${GAP}(同学|同事|朋友|老板|上司|下属|老师|学生|领导|客户|合伙人|妻子|丈夫|妈妈|爸爸|儿子|女儿|哥哥|姐姐|弟弟|妹妹|邻居|室友|员工)${GAP}(?:是|叫|名叫)${GAP}${SLOT}`,
    ),
    aSlot: 1,
    bSlot: 3,
    predicate: { slot: 2, fallback: "关联" },
  },
  // 张三和李四是同学 / 张三、李四是同事（对称关系，方向按 A → B 记）
  {
    re: new RegExp(
      `${SLOT}${GAP}(?:和|与|跟|同|、)${GAP}${SLOT}${GAP}(?<!不)(?:是|为)${GAP}(同学|同事|朋友|合伙人|邻居|室友)`,
    ),
    aSlot: 1,
    bSlot: 2,
    predicate: { slot: 3, fallback: "关联" },
  },
  // 用户喜欢喝绿茶 / 张三爱打篮球
  {
    re: new RegExp(`${SLOT}${GAP}(?:喜欢|爱|热爱)${GAP}${SLOT}`),
    aSlot: 1,
    bSlot: 2,
    predicate: "喜欢",
    toType: "concept",
  },
  // 张三讨厌下雨天
  {
    re: new RegExp(`${SLOT}${GAP}讨厌${GAP}${SLOT}`),
    aSlot: 1,
    bSlot: 2,
    predicate: "讨厌",
    toType: "concept",
  },
];

/** 从规则里取谓词（"读书"→就读于 这类映射在 resolvePredicate） */
function resolvePredicate(rule: Rule, m: RegExpMatchArray): string {
  const raw =
    typeof rule.predicate === "string" ? rule.predicate : (m[rule.predicate.slot] ?? rule.predicate.fallback);
  const txt = raw.trim();
  if (/读书|上学|学习/.test(txt)) return "就读于";
  if (/任职|就职|上班|工作/.test(txt)) return "工作于";
  return txt;
}

/**
 * 从正文里抽实体与关系。
 *
 * @param text      记忆正文
 * @param subject   记忆的 subject（代词会映射到它；null 时代词关系直接丢弃）
 * @param subjectType 主语的类型（传了就用它，不靠猜）
 */
export function extractGraph(
  text: string,
  subject: string | null,
  subjectType: EntityType = "unknown",
): { entities: RuleEntity[]; relations: RuleRelation[] } {
  const entities = new Map<string, EntityType>();
  const relations: RuleRelation[] = [];
  const seen = new Set<string>();

  const addEntity = (name: string, type: EntityType): void => {
    const old = entities.get(name);
    // unknown 不该覆盖已知类型（先抽到的具体类型更可信）
    if (old === undefined || (old === "unknown" && type !== "unknown")) entities.set(name, type);
  };

  const resolve = (raw: string, hint?: EntityType): { name: string; type: EntityType } | null => {
    // 代词要**先判**：'我/他/她'都是单字，若先走 cleanEntityName 会被"单字不合法"挡掉
    const bare = raw.replace(/[，。、；：！？\s]/g, "").trim();
    if (PRONOUNS.has(bare) || PRONOUNS.has(raw.trim())) {
      if (!subject) return null;
      return { name: subject, type: subjectType };
    }
    const cleaned = cleanEntityName(raw);
    if (!cleaned) return null;
    if (PRONOUNS.has(cleaned)) {
      if (!subject) return null;
      return { name: subject, type: subjectType };
    }
    return { name: cleaned, type: hint ?? subjectTypeIfSame(cleaned, subject, subjectType) ?? inferEntityType(cleaned) };
  };

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, "g");
    for (const m of text.matchAll(re)) {
      const a = resolve(m[rule.aSlot] ?? "", rule.fromType);
      if (!a) continue;
      const predicate = resolvePredicate(rule, m);
      if (!predicate) continue;
      // 喜欢/讨厌的宾语可能是并列项："讨厌下雨天和堵车" → 两条关系，而不是一个怪名字
      const rawB = m[rule.bSlot] ?? "";
      const parts =
        predicate === "喜欢" || predicate === "讨厌"
          ? rawB.split(/[和与、]/).map((s) => s.trim()).filter(Boolean)
          : [rawB];
      for (const part of parts) {
        const b = resolve(part, rule.toType);
        if (!b || a.name === b.name) continue;
        const key = `${a.name}|${predicate}|${b.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addEntity(a.name, a.type);
        addEntity(b.name, b.type);
        relations.push({ from: a.name, fromType: a.type, to: b.name, toType: b.type, predicate });
      }
    }
  }

  // subject 本身永远是一个实体（哪怕没抽到关系）——这样"用户"类记忆也能进图
  if (subject) addEntity(subject, subjectType);

  return {
    entities: [...entities.entries()].map(([name, type]) => ({ name, type })),
    relations,
  };
}

/** 名字与 subject 相同时沿用主语类型（"用户"不是人名后缀能猜的类型） */
function subjectTypeIfSame(name: string, subject: string | null, subjectType: EntityType): EntityType | null {
  return subject && name === subject && subjectType !== "unknown" ? subjectType : null;
}
