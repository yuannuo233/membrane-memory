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

/** CJK 区段：CJK 部首扩展~兼容表意、假名、谚文等（覆盖中日韩常用文字） */
const CJK_RUN = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]+/;
/** 从文本里切出"连续 CJK 段"或"拉丁/数字/下划线词" */
const RUN_SPLIT = /([\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]+)|([A-Za-z0-9_]+)/g;

/**
 * 分词：CJK 连续段 → 相邻两字滑窗（bigram）；单字段 → 该字本身；
 * 拉丁/数字/下划线段 → 整词小写。
 *
 * 例："用户住在北京市" → ["用户","户住","住在","在北","北京","京市"]
 * 例："Hello 世界" → ["hello","世界"]
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(RUN_SPLIT)) {
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
 * 语义相似度用的 token 集合（DESIGN.md 第 4 节：包含系数 = |A∩B|/min(|A|,|B|)）。
 * 与 FTS 索引同一套分词，保证"冲突检测看到的"和"检索看到的"一致。
 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** 包含系数：交集除以较小集合的大小；任一为空集时返回 0 */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  return inter / Math.min(a.size, b.size);
}

/**
 * 字符覆盖率（read-path resolver 兜底，StaleBench 论文的模糊匹配思路）。
 *
 * 为什么需要：bigram 要求"养猫"在原句里连续出现，但"用户养了一只猫"里
 * "养"和"猫"隔了字，bigram 一个都不匹配 → FTS 漏召回。字符覆盖率不要求相邻：
 * 查询里的每个 CJK 单字只要出现在记忆里就算命中。
 *
 * 返回 0~1：query 中能在 text 里找到的字符比例。
 * 为避免"的/了/用户"这类高频字造成误召回，同时要求至少命中一个"实词字"
 * （这里简化为：覆盖率 × 命中字数，调用方用阈值过滤）。
 */
export function charCoverage(query: string, text: string): number {
  // CJK：按单字覆盖（解决"养猫"vs"养了一只猫"的隔字问题）
  const cjkRe = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
  const qChars = new Set([...query].filter((c) => cjkRe.test(c)));
  // 拉丁/数字：按完整词匹配（"zzzz不存在的词qqqq" 不能被拆成单字母碰巧命中）
  const qWords = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const total = qChars.size + qWords.length;
  if (total === 0) return 0;

  const textLower = text.toLowerCase();
  const textChars = new Set([...text].filter((c) => cjkRe.test(c)));
  let hit = 0;
  for (const c of qChars) if (textChars.has(c)) hit++;
  for (const w of qWords) if (textLower.includes(w)) hit++;
  return hit / total;
}

