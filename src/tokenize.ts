/**
 * 中文友好的 FTS 分词器（bigram 方案，DESIGN.md 第 3 节实现注记）。
 *
 * 为什么自建：SQLite FTS5 内置 `unicode61` 把一整段连续汉字当成一个 token
 * （"用户住在北京市" 只有一个词），中文检索等于废掉；`trigram` 又要求查询≥3字，
 * 两个字的地名（"北京"）搜不到。业界通用解法是 bigram：相邻两字滑窗。
 *
 * 索引侧：content → token 序列（CJK bigram + 拉丁/数字整词小写）
 * 查询侧：query   → 同法分词，构建 `"tok"*` 形式的 FTS5 查询（AND 失败降级 OR）
 *
 * 注入无害化：token 只保留字母/数字/下划线（含 CJK 区段），其余字符直接丢弃，
 * 再用双引号包裹成 phrase，FTS5 语法字符（OR/AND/NOT/NEAR/括号/星号等）
 * 全部失效——这是 FTS 注入无害化的第一道防线（另有专项测试）。
 */

/**
 * CJK 标点/符号：分词前先去掉，而不是当成"分隔符"。
 *
 * 为什么：如果标点当分隔符，"用户，住在北京" 会被切成两段，丢掉跨逗号的
 * "户住" bigram；而无标点的查询 "用户住在北京" 恰好需要这个 bigram，
 * AND 精确检索就会失败、被迫降级 OR，召回变宽。统一先剥离标点，
 * 让"带不带标点"两种写法产生同一套 token。
 *
 * 注意只剥中文/全角标点，ASCII 标点（. , ! ?）仍作为拉丁词的分隔符。
 */
const CJK_PUNCT =
  /[\u3000-\u303F\u00B7\u2010-\u2027\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/g;

/** 从文本里切出"连续 CJK 段"或"拉丁/数字/下划线词" */
const RUN_SPLIT = /([\u2E80-\u2EFF\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]+)|([A-Za-z0-9_]+)/g;

/**
 * 分词：CJK 连续段 → 相邻两字滑窗（bigram）；单字段 → 该字本身；
 * 拉丁/数字/下划线段 → 整词小写。
 *
 * 例："用户住在北京市" → ["用户","户住","住在","在北","北京","京市"]
 * 例："Hello 世界" → ["hello","世界"]
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const clean = text.replace(CJK_PUNCT, "");
  for (const match of clean.matchAll(RUN_SPLIT)) {
    const cjk = match[1];
    const word = match[2];
    if (cjk !== undefined) {
      if (cjk.length === 1) {
        tokens.push(cjk);
      } else {
        for (let i = 0; i < cjk.length - 1; i++) {
          tokens.push(cjk.slice(i, i + 2));
        }
      }
    } else if (word !== undefined) {
      tokens.push(word.toLowerCase());
    }
  }
  return tokens;
}

/**
 * 查询分词：去重（保序）。与 tokenize 相同，语义上分开命名以便阅读。
 */
export function tokenizeQuery(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * 把查询 token 构建成 FTS5 MATCH 表达式。
 * - `"tok"*`：phrase + 前缀，语法字符全部中和；
 * - mode=and：全部 token 都要命中（精确优先）；fts5 里空格连接即 AND；
 * - mode=or ：任一命中（宽召回，AND 无结果时降级用）。
 *
 * token 里不可能出现双引号（tokenize 只保留字母数字下划线），所以直接包裹安全。
 */
export function buildFtsQuery(tokens: string[], mode: "and" | "or"): string | null {
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t}"*`);
  return mode === "and" ? quoted.join(" ") : quoted.join(" OR ");
}

/**
 * 语义相似度用的 token 集合。
 * 与 FTS 索引同一套分词，保证"冲突检测看到的"和"检索看到的"一致。
 * 重叠度算法见 tokenOverlap 的注释（|A∩B|/max，不是包含系数）。
 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * 归一化重叠度：|A∩B| / max(|A|,|B|)。
 *
 * 为什么不用 |A∩B| / min(|A|,|B|)（包含系数）：它是非对称的，短句只要
 * 完整出现在长句里就得到 1.0——"北京市" 会以 1.0 的相似度取代
 * "用户住在北京市海淀区"，等于用碎片覆盖完整事实。
 * 除以较大集合后：短句 vs 长句 = 短/长（很低），同长度改写 = 交集/长度
 * （"用户住在北京"→"用户住在上海" = 3/5 = 0.6，仍能落取代带）。
 */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  return inter / Math.max(a.size, b.size);
}

/** CJK 单字判定（与 RUN_SPLIT 的区段保持一致，不含标点） */
const CJK_CHAR = /[\u2E80-\u2EFF\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
/** 拉丁/数字词 */
const LATIN_WORD = /[a-z0-9]+/g;

/**
 * 把文本拆成"模糊匹配用的检索单元"：
 * - CJK 按单字（解决"养猫"vs"养了一只猫"的隔字问题）
 * - 拉丁/数字按整词（"zzzz不存在的词qqqq" 不能被拆成单字母碰巧命中）
 * 返回去重后的集合，供 charIndex（写入建索引）与 charScore（查询打分）共用。
 */
export function fuzzyUnits(text: string): Set<string> {
  const out = new Set<string>();
  const clean = text.replace(CJK_PUNCT, "");
  const lower = clean.toLowerCase();
  for (const c of clean) if (CJK_CHAR.test(c)) out.add(c);
  for (const w of lower.match(LATIN_WORD) ?? []) out.add(w);
  return out;
}

/**
 * 字符覆盖率打分：query 的检索单元有多大比例出现在 text 中。
 * 返回 0~1。两边都先用 fuzzyUnits 归一化，保证索引与查询口径一致。
 */
export function charScore(queryUnits: Set<string>, text: string): number {
  if (queryUnits.size === 0) return 0;
  const textUnits = fuzzyUnits(text);
  let hit = 0;
  for (const u of queryUnits) if (textUnits.has(u)) hit++;
  return hit / queryUnits.size;
}

