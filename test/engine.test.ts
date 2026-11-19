/**
 * 引擎核心测试：add（去重/取代/并存/error 策略/pin 保护）、
 * recall（打分明细/asOf 历史/权重/kind 过滤）、forget、history、stats。
 * 覆盖 DESIGN.md 第 4/5 节的可解释召回与时间感知承诺。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane, cosine, rrfNormalized, freshness, toBrief, toUltraBrief } from "../src/engine.js";
import { charCoverage } from "../src/tokenize.js";
import { MembraneError } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
let m: Membrane;
let t: number;

beforeEach(() => {
  dir = newTmpDir("engine");
  t = BASE_TIME;
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => t });
});

afterEach(() => {
  m.close();
  rmDir(dir);
});

describe("纯函数：RRF / 新鲜度 / 余弦", () => {
  it("rrfNormalized：未命中=0，第1名=1.0，名次越大越小", () => {
    expect(rrfNormalized(null)).toBe(0);
    expect(rrfNormalized(0)).toBe(0);
    expect(rrfNormalized(1)).toBe(1);
    expect(rrfNormalized(10)).toBeLessThan(rrfNormalized(2));
  });

  it("freshness：真·半衰期公式 exp(-ln2·age/halfLife)", () => {
// 校准断言：age = halfLife 时新鲜度恰好 0.5
    expect(freshness(0, 90)).toBe(1);
    expect(freshness(90, 90)).toBeCloseTo(0.5, 5);
    expect(freshness(180, 90)).toBeCloseTo(0.25, 5);
  });

  it("cosine：相同向量=1，正交=0", () => {
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]))).toBeCloseTo(0);
  });
});

describe("Membrane.add：去重与冲突", () => {
  it("首次写入 = created，时间/字段正确", () => {
    const r = m.add({ content: "用户住在北京市", subject: "用户" });
    expect(r.status).toBe("created");
    expect(r.memory.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.memory.kind).toBe("fact");
    expect(r.memory.createdAt).toBe(BASE_TIME);
    expect(r.memory.validTo).toBeNull();
  });

  it("完全相同的内容重复写入 = duplicate，不新增", () => {
    m.add({ content: "用户住在北京市", subject: "用户" });
    const r = m.add({ content: "  用户住在北京市  ", subject: "用户" }); // trim + 空白归一
    expect(r.status).toBe("duplicate");
    expect(m.stats().total).toBe(1);
  });

  it("换地名的高相似改写 = superseded（包含系数落取代带）", () => {
    // 用 DESIGN.md 原例："用户住在北京"→"用户住在上海"，bigram 包含系数=0.6 ≥ 0.55
    m.add({ content: "用户住在北京", subject: "用户", kind: "fact" });
    const r = m.add({ content: "用户住在上海", subject: "用户", kind: "fact" });
    expect(r.status).toBe("superseded");
    expect(r.superseded.length).toBeGreaterThan(0);
    const old = m.get(r.superseded[0]!.id)!;
    expect(old.validTo).toBe(BASE_TIME);
    expect(old.supersededBy).toBe(r.memory.id);
    expect(m.stats().current).toBe(1);
  });

  it("不同 subject 之间不冲突", () => {
    m.add({ content: "住在北京", subject: "张三" });
    const r = m.add({ content: "住在北京", subject: "李四" });
    expect(r.status).toBe("created");
    expect(m.stats().current).toBe(2);
  });

  it("error 策略：检测到相似记忆直接报错，不写入", () => {
    const strict = new Membrane({
      dbPath: `${dir}/strict.db`,
      now: () => t,
      conflictPolicy: "error",
    });
    strict.add({ content: "用户住在北京市", subject: "用户" });
    expect(() => strict.add({ content: "用户住在上海市", subject: "用户" })).toThrow(MembraneError);
    expect(strict.stats().total).toBe(1);
    strict.close();
  });

  it("keep-both 策略：相似记忆并存不取代", () => {
    const kb = new Membrane({
      dbPath: `${dir}/kb.db`,
      now: () => t,
      conflictPolicy: "keep-both",
    });
    kb.add({ content: "用户住在北京市", subject: "用户" });
    const r = kb.add({ content: "用户住在上海市", subject: "用户" });
    expect(r.status).toBe("kept-both");
    expect(kb.stats().current).toBe(2);
    kb.close();
  });

  it("pin 的旧记忆不会被自动取代，note 里有提醒", () => {
    m.add({ content: "用户住在北京", subject: "用户", pin: true });
    const r = m.add({ content: "用户住在上海", subject: "用户" });
    expect(r.superseded.length).toBe(0);
    expect(r.note).toContain("钉选");
  });
});

describe("read-path resolver：字符覆盖率兜底", () => {
  it("charCoverage：隔字查询也能算覆盖率，拉丁按整词", () => {
    expect(charCoverage("养猫", "用户养了一只猫")).toBe(1); // 养/猫 都在
    expect(charCoverage("zzzz", "用户养了一只猫")).toBe(0); // 拉丁词无匹配
    expect(charCoverage("北京", "养了一只猫")).toBe(0);
  });

  it("FTS 未连续命中时，模糊召回兜底（养猫 → 用户养了一只猫）", () => {
    const mm = new Membrane({ dbPath: `${dir}/fuzzy.db`, now: () => BASE_TIME });
    mm.add({ content: "用户养了一只猫", subject: "用户" });
    const hits = mm.recall({ query: "养猫" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.memory.content).toContain("猫");
    expect(hits[0]!.why).toContain("模糊匹配"); // why 里如实标注走了兜底
    mm.close();
  });

  it("弱覆盖不误召回（无关查询返回空）", () => {
    const mm = new Membrane({ dbPath: `${dir}/fuzzy2.db`, now: () => BASE_TIME });
    mm.add({ content: "用户养了一只猫", subject: "用户" });
    expect(mm.recall({ query: "量子物理" }).length).toBe(0);
    mm.close();
  });
});

describe("Membrane.recall：可解释召回", () => {
  beforeEach(() => {
    m.add({ content: "用户住在北京市海淀区", subject: "用户", kind: "fact" });
    m.add({ content: "用户喜欢喝咖啡", subject: "用户", kind: "preference" });
    m.add({ content: "用户昨天去了健身房", subject: "用户", kind: "episode" });
  });

  it("命中返回分数明细：why / breakdown / 权重齐全", () => {
    const hits = m.recall({ query: "北京" });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.why).toContain("全文");
    // 无 queryVec 时 vec 权重归零、其余三项按比例归一（和恒为 1，分数上界 1.0）
    const w = top.breakdown.weights;
    expect(w.vec).toBe(0);
    expect(w.text + w.time + w.conf).toBeCloseTo(1, 6);
    expect(w.text).toBeGreaterThan(0.5); // 原 0.4 / 0.7 ≈ 0.571
    expect(top.breakdown.rrfText).toBeGreaterThan(0);
    expect(top.breakdown.freshness).toBeGreaterThan(0);
    expect(top.score).toBeGreaterThan(0);
  });

  it("无向量时分数上界为 1.0（不会因丢失 vec 分量被压低）", () => {
    // 造一条完美命中：全文第 1、刚写入、置信度 1
    const r = m.add({ content: "完美命中测试", confidence: 1 });
    expect(r.status).toBe("created");
    const hit = m.recall({ query: "完美命中测试", limit: 1 })[0]!;
    // rrfText=1, freshness=1, confidence=1，权重归一后三项和为 1 → 分数应接近 1
    expect(hit.score).toBeGreaterThan(0.99);
  });

  it("全文未命中时返回空", () => {
    expect(m.recall({ query: "zzzz不存在的词qqqq" })).toHaveLength(0);
  });

  it("kind 过滤只返回指定种类", () => {
    const hits = m.recall({ query: "用户", kind: "preference" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.memory.kind).toBe("preference");
  });

  it("limit 生效", () => {
    expect(m.recall({ query: "用户", limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("权重覆盖影响得分", () => {
    const a = m.recall({ query: "北京", weights: { text: 1, vec: 0, time: 0, conf: 0 } });
    const b = m.recall({ query: "北京", weights: { text: 0, vec: 0, time: 1, conf: 0 } });
    expect(a[0]?.breakdown.weights.text).toBe(1);
    expect(b[0]?.breakdown.weights.time).toBe(1);
  });
});

describe("Membrane：向量增强（可选）", () => {
  it("不传 queryVec 时 vec 分量为 0（零依赖底线）", () => {
    const r = m.add({ content: "向量测试记忆" });
    const hit = m.recall({ query: "向量" })[0]!;
    expect(hit.breakdown.rrfVec).toBe(0);
    expect(hit.breakdown.vecSim).toBeNull();
  });

  it("传 queryVec + 库里有 embedding 时，vec 分量参与打分", () => {
    const r = m.add({ content: "向量测试记忆" });
    m.storage.upsertEmbedding(r.memory.id, new Float32Array([1, 0, 0]));
    const hit = m.recall({ query: "向量", queryVec: new Float32Array([1, 0, 0]) })[0]!;
    expect(hit.breakdown.vecSim).toBeCloseTo(1, 5);
    expect(hit.breakdown.rrfVec).toBeGreaterThan(0);
    expect(hit.why).toContain("向量第 1 名");
  });
});

describe("Membrane：证据链（supporting evidence）", () => {
  it("add 带 evidence → evidence() 取回，recall 的 breakdown 有 evidenceCount", () => {
    const r = m.add({
      content: "用户住在上海",
      subject: "用户",
      evidence: ["用户原话：我上周搬到上海了", "聊天记录 #42"],
    });
    const ev = m.evidence(r.memory.id);
    expect(ev).toHaveLength(2);
    expect(ev[0]!.quote).toContain("搬到上海");
    const hits = m.recall({ query: "上海" });
    expect(hits[0]!.breakdown.evidenceCount).toBe(2);
  });

  it("无证据的记忆 evidenceCount=0", () => {
    m.add({ content: "一条没有证据的记忆" });
    expect(m.recall({ query: "没有证据" })[0]!.breakdown.evidenceCount).toBe(0);
  });
});

describe("Membrane：时间感知（asOf）与遗忘", () => {
  it("asOf 旧时点能查到已被取代的旧值", () => {
    m.add({ content: "用户住在北京", subject: "用户", at: BASE_TIME });
    t = BASE_TIME + 10_000;
    m.add({ content: "用户住在上海", subject: "用户", at: t });
    // 当前时点：旧值应被过滤
    const nowHits = m.recall({ query: "住在" });
    expect(nowHits.every((h) => h.memory.content.includes("上海"))).toBe(true);
    // asOf 早于取代时刻：旧值应可见
    const oldHits = m.recall({ query: "住在", asOf: BASE_TIME + 5_000 });
    expect(oldHits.some((h) => h.memory.content.includes("北京"))).toBe(true);
  });

  it("forget 软删除：现行召回查不到，但历史行还在", () => {
    const r = m.add({ content: "用户住在北京市", subject: "用户" });
    m.forget(r.memory.id);
    expect(m.recall({ query: "北京" })).toHaveLength(0);
    expect(m.get(r.memory.id)!.deleted).toBe(true);
    expect(m.stats().deleted).toBe(1);
  });

  it("history 记录 add / supersede / forget 全链路", () => {
    const a = m.add({ content: "用户住在北京", subject: "用户" });
    t = BASE_TIME + 1000;
    const b = m.add({ content: "用户住在上海", subject: "用户" });
    m.forget(b.memory.id);
    const ops = m.history(a.memory.id).map((h) => h.op);
    expect(ops).toContain("add");
    expect(ops).toContain("supersede");
    expect(m.history(b.memory.id).map((h) => h.op)).toContain("forget");
  });
});

describe("toBrief / toUltraBrief：省 token 的精简返回", () => {
  it("toBrief 保留关键字段、去掉重复的 weights/halfLife", () => {
    m.add({ content: "用户喜欢猫", subject: "用户", evidence: ["用户原话"] });
    const hit = m.recall({ query: "喜欢猫" })[0]!;
    const brief = toBrief(hit);
    expect(brief.id).toBe(hit.memory.id);
    expect(brief.content).toBe("用户喜欢猫");
    expect(brief.kind).toBe("fact");
    expect(brief.subject).toBe("用户");
    expect(brief.score).toBe(hit.score);
    expect(brief.evidenceCount).toBe(1);
    expect(brief).not.toHaveProperty("breakdown");
    expect(brief).not.toHaveProperty("why");
  });

  it("toUltraBrief 只留 id/内容/分数", () => {
    m.add({ content: "用户喜欢猫" });
    const hit = m.recall({ query: "喜欢猫" })[0]!;
    const ultra = toUltraBrief(hit);
    expect(Object.keys(ultra).sort()).toEqual(["content", "id", "score"]);
    expect(ultra.content).toBe("用户喜欢猫");
  });

  it("精简后体积显著小于完整结果", () => {
    for (let i = 0; i < 10; i++) m.add({ content: `第${i}条记忆内容示例`, subject: "用户" });
    const hits = m.recall({ query: "记忆内容", limit: 8 });
    const fullSize = JSON.stringify(hits).length;
    const briefSize = JSON.stringify(hits.map(toBrief)).length;
    const ultraSize = JSON.stringify(hits.map(toUltraBrief)).length;
    expect(briefSize).toBeLessThan(fullSize * 0.5);
    expect(ultraSize).toBeLessThan(briefSize);
  });
});

describe("混合检索：向量路独立发现候选", () => {
  it("语义相近但词面不沾的记忆，靠向量也能召回", () => {
    // 两条记忆：一条词面命中查询，一条只在向量空间相近（词面完全不同）
    const hit1 = m.add({ content: "用户养了一只橘猫" });
    const hit2 = m.add({ content: "家里有只小动物毛茸茸" });
    // 只给第二条写向量，且让它在向量空间里与查询向量同向
    m.storage.upsertEmbedding(hit2.memory.id, new Float32Array([1, 0, 0]));
    m.storage.upsertEmbedding(hit1.memory.id, new Float32Array([0, 1, 0]));

    const hits = m.recall({ query: "猫咪", queryVec: new Float32Array([1, 0, 0]), limit: 5 });
    const ids = hits.map((h) => h.memory.id);
    // 第二条词面不含"猫"字，但向量相近 → 必须出现在结果里
    expect(ids).toContain(hit2.memory.id);
  });

  it("向量候选也遵守 namespace 隔离", () => {
    const a = m.add({ content: "甲的向量记忆", namespace: "a" });
    const b = m.add({ content: "乙的向量记忆", namespace: "b" });
    m.storage.upsertEmbedding(a.memory.id, new Float32Array([1, 0]));
    m.storage.upsertEmbedding(b.memory.id, new Float32Array([1, 0]));
    const hits = m.recall({ query: "完全无关的词", queryVec: new Float32Array([1, 0]), namespace: "a" });
    expect(hits.every((h) => h.memory.namespace === "a")).toBe(true);
    expect(hits.map((h) => h.memory.id)).not.toContain(b.memory.id);
  });
});
