/**
 * Doctor 自检（DESIGN.md 第 8 节）——把"数字可复现"落成可执行脚本。
 *
 * 六套剧本，全部确定性（注入固定时钟 + 内存库 + 固定数据）：
 *   1. 写入召回：N 条事实 + 干扰项 → 命中率
 *   2. 更新陈旧：写入→更新→按旧问法查询→应返回新值（对抗 stale retrieval）
 *   3. 跨会话：模拟进程重启（关库重开同一路径）→ 记忆仍在
 *   4. 向量检索：离线向量命中
 *   5. 图检索：关系问答 + 两跳
 *   6. 多任务隔离：同 namespace 会串 / 分 namespace 不串
 *
 * 关键指标 contamination@k：top-k 里同时出现 current 与 stale 版本——
 * StaleBench 论文证明它比 current@k 更能正确评价策略（current@1 会把 13/42 策略排反）。
 *
 * 输出 JSON（机器读）+ 人类可读文本，README 里的数字必须来自这里。
 */
import { Membrane } from "./engine.js";
import { probeTaskIsolation } from "./isolation.js";
import { VERSION } from "./version.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

/** 固定时钟锚点（doctor 每次都用它，保证跨机器结果一致） */
const T0 = 1_760_000_000_000; // 2025-10-30 附近
const DAY = 86_400_000;

export interface DoctorReport {
  version: string;
  generatedAt: string;
  deterministic: boolean;
  scenarios: {
    writeRecall: { hits: number; total: number; hitRate: number; latencyMs: number };
    staleUpdate: {
      currentReturned: number;
      trials: number;
      successRate: number;
      contaminationAt5: number;
      contaminationAt1: number;
      latencyMs: number;
    };
    crossSession: { recalled: boolean; recordCount: number; latencyMs: number };
    vector: {
      entries: number;
      recalledByVector: boolean;
      vecSimilarity: number | null;
      rrfVecApplied: boolean;
      latencyMs: number;
    };
    graph: {
      edges: number;
      answered: boolean;
      sentence: string;
      multiHopEdges: number;
      graphScoreApplied: boolean;
      latencyMs: number;
    };
    isolation: {
      sameNamespaceMixed: boolean;
      sameNamespaceTasks: number;
      taskAHits: number;
      taskBHits: number;
      leakage: number;
      pass: boolean;
      latencyMs: number;
    };
  };
  summary: { passed: boolean; checks: { name: string; pass: boolean; detail: string }[] };
}

/** 剧本 1：写入召回 */
function scenarioWriteRecall(): DoctorReport["scenarios"]["writeRecall"] {
  const m = new Membrane({ dbPath: ":memory:", now: () => T0 });
  const facts = [
    ["用户住在北京", "用户"],
    ["用户喜欢喝绿茶", "用户"],
    ["用户在腾讯工作", "用户"],
    ["用户养了一只猫", "用户"],
    ["用户会弹钢琴", "用户"],
  ] as const;
  for (const [content, subject] of facts) m.add({ content, subject, kind: "fact" });
  // 用真实检索场景的关键词（与记忆有词面重叠）；"喝什么茶"这类零重叠问法
  // 属于 query 端解析要解决的问题（由 query 端解析处理），不放进基础召回剧本。
  const queries = ["北京", "绿茶", "腾讯", "养猫", "钢琴"];
  let hits = 0;
  const t0 = Date.now();
  for (const q of queries) {
    const r = m.recall({ query: q, limit: 3 });
    if (r.length > 0) hits++;
  }
  const latencyMs = Date.now() - t0;
  m.close();
  return { hits, total: queries.length, hitRate: hits / queries.length, latencyMs };
}

/** 剧本 2：更新陈旧 + contamination@k */
function scenarioStaleUpdate(): DoctorReport["scenarios"]["staleUpdate"] {
  let currentReturned = 0;
  let contaminated5 = 0;
  let contaminated1 = 0;
  const trials = 8;
  // 每条是"同一槽位的新旧值"：句式一致、只有值变化（论文 value-agnostic 查询场景）。
  // 用足够长的共同前缀确保包含系数达取代阈值——这正是我们要验证的取代链行为。
  const pairs = [
    ["用户住在北京", "用户住在上海"], ["用户喜欢喝绿茶", "用户喜欢喝红茶"],
    ["用户在腾讯工作", "用户在字节工作"], ["用户养了一只猫", "用户养了一只狗"],
    ["用户会弹钢琴", "用户会弹吉他"], ["用户住在朝阳区", "用户住在海淀区"],
    ["用户用 Windows 系统", "用户用 Linux 系统"], ["用户每天喝咖啡", "用户每天喝茶"],
  ] as const;
  const t0 = Date.now();
  for (const [oldText, newText] of pairs) {
    const m = new Membrane({ dbPath: ":memory:", now: () => T0 });
    m.add({ content: oldText, subject: "用户", kind: "fact", at: T0 });
    // 用 at 覆盖写入时刻（冲突检测会把旧值取代，valid_to=T0+DAY）
    m.add({ content: newText, subject: "用户", kind: "fact", at: T0 + DAY });
    // value-agnostic 查询：用共同部分查，top-1 应返回新值（current@1）
    const hits = m.recall({ query: "用户", limit: 5 });
    const newMarker = newText.slice(-2); // 新值末尾两字
    if (
      hits.length > 0 &&
      hits[0]!.memory.content.includes(newMarker) &&
      !hits[0]!.memory.deleted &&
      hits[0]!.memory.validTo === null
    ) {
      currentReturned++;
    }
    // contamination：召回的 top-k 里是否混入已被取代的旧版本（valid_to 非空）。
    // 这是关键指标；我们的召回层应过滤掉这些 stale 条目 → 期望 0。
    if (hits.some((h) => h.memory.validTo !== null || h.memory.deleted)) contaminated5++;
    // contam@1 复用同一批结果的第一条，不再单独查一次
    if (hits.length > 0 && (hits[0]!.memory.validTo !== null || hits[0]!.memory.deleted)) {
      contaminated1++;
    }
    m.close();
  }
  const latencyMs = Date.now() - t0;
  return {
    currentReturned, trials, successRate: currentReturned / trials,
    contaminationAt5: contaminated5 / trials,
    contaminationAt1: contaminated1 / trials,
    latencyMs,
  };
}

/**
 * 剧本 4：向量检索（**离线确定性**）
 *
 * 不调真 embedding 端点：手工构造 4 维单位向量，语义=维度含义。
 * 这样任何机器跑出来的数字都一样，既验证"写入带向量 → 召回命中"整条链路，
 * 又不会因为断网/欠费让 CI 变红。
 */
function scenarioVector(): DoctorReport["scenarios"]["vector"] {
  const t0 = Date.now();
  const m = new Membrane({ dbPath: ":memory:", now: () => T0 });
  const facts: [string, number[]][] = [
    ["用户住在北京", [1, 0, 0, 0]],
    ["用户喜欢喝咖啡", [0, 1, 0, 0]],
    ["用户养了一只猫", [0, 0, 1, 0]],
    ["用户会弹钢琴", [0, 0, 0, 1]],
  ];
  for (const [content, vec] of facts) {
    m.add({ content, subject: "用户", kind: "fact", vec, at: T0 });
  }
  // 查询用一个"全文完全搜不到"的词，逼着向量路独立发现候选
  const hits = m.recall({ query: "zzzz-vector-only-zzzz", queryVec: new Float32Array([1, 0, 0, 0]), limit: 3 });
  const top = hits[0];
  const recalledByVector = top !== undefined && top.memory.content.includes("北京");
  const vecSimilarity = top?.breakdown.vecSim ?? null;
  const rrfVecApplied = (top?.breakdown.rrfVec ?? 0) > 0;
  const entries = m.stats().total;
  m.close();
  return { entries, recalledByVector, vecSimilarity, rrfVecApplied, latencyMs: Date.now() - t0 };
}

/**
 * 剧本 5：图检索（**离线确定性**）
 *
 * 只用手动标注的关系（不依赖规则抽取得准不准），验证三件事：
 *   1. "张三和李四是什么关系" 能直接答出来
 *   2. 关系也遵守时间感知（这里只验存在性与跳数）
 *   3. 图路能作为一路候选进入综合打分（rrfGraph > 0）
 */
function scenarioGraph(): DoctorReport["scenarios"]["graph"] {
  const t0 = Date.now();
  const m = new Membrane({ dbPath: ":memory:", now: () => T0 });
  m.add({
    content: "张三是李四的同学",
    subject: "张三",
    kind: "fact",
    at: T0,
    relations: [{ to: "李四", predicate: "同学", toType: "person" }],
  });
  m.add({
    content: "李四在腾讯工作",
    subject: "李四",
    kind: "fact",
    at: T0,
    relations: [{ to: "腾讯", predicate: "工作于", toType: "org" }],
  });

  // 直接问关系（传整句也行：会自动从里面认实体）
  const direct = m.relations("张三和李四是什么关系");
  // 两跳：张三 → 李四 → 腾讯
  const multi = m.relations("张三", "腾讯", { maxHops: 2 });
  // 图路进综合打分
  const hits = m.recall({ query: "张三和李四是什么关系", limit: 3 });
  const graphScoreApplied = hits.some((h) => h.breakdown.rrfGraph > 0);

  const result = {
    edges: direct.length,
    answered: direct.length > 0,
    sentence: direct[0]?.sentence ?? "",
    multiHopEdges: multi.length,
    graphScoreApplied,
    latencyMs: 0,
  };
  m.close();
  result.latencyMs = Date.now() - t0;
  return result;
}

/** 剧本 3：跨会话持久性（关库重开同一文件） */
function scenarioCrossSession(path: string): DoctorReport["scenarios"]["crossSession"] {
  const t0 = Date.now();
  const a = new Membrane({ dbPath: path, now: () => T0 });
  a.add({ content: "跨会话记忆：用户的密钥是蓝色", subject: "用户", kind: "fact", pin: true });
  const before = a.stats().total;
  a.close(); // 模拟进程退出
  const b = new Membrane({ dbPath: path, now: () => T0 + DAY });
  const hits = b.recall({ query: "用户的密钥是什么颜色", limit: 3 });
  const recalled = hits.some((h) => h.memory.content.includes("蓝色"));
  const after = b.stats().total;
  const latencyMs = Date.now() - t0;
  b.close();
  return { recalled, recordCount: Math.min(before, after), latencyMs };
}

/** 剧本 6：多任务隔离（同 namespace 串 / 分 namespace 不串） */
function scenarioIsolation(): DoctorReport["scenarios"]["isolation"] {
  const t0 = Date.now();
  const r = probeTaskIsolation();
  return {
    sameNamespaceMixed: r.sharedNamespace.mixed,
    sameNamespaceTasks: r.sharedNamespace.tasks.length,
    taskAHits: r.separatedNamespaces.taskA.hits,
    taskBHits: r.separatedNamespaces.taskB.hits,
    leakage: r.separatedNamespaces.leakage,
    pass: r.separatedNamespaces.pass,
    latencyMs: Date.now() - t0,
  };
}

/** 生成报告（doctor 命令调用） */
export function runDoctor(dbPath?: string): DoctorReport {
  const path = dbPath ?? join(process.cwd(), ".tmp-test", "doctor.db");
  if (dirname(path) && !existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  // 清掉上次的库，保证确定性
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* ignore */ } }
  }

  const writeRecall = scenarioWriteRecall();
  const staleUpdate = scenarioStaleUpdate();
  const crossSession = scenarioCrossSession(path);
  const vector = scenarioVector();
  const graph = scenarioGraph();
  const isolation = scenarioIsolation();

  const checks = [
    { name: "写入召回命中率 ≥ 80%", pass: writeRecall.hitRate >= 0.8, detail: `${(writeRecall.hitRate * 100).toFixed(0)}% (${writeRecall.hits}/${writeRecall.total})` },
    { name: "陈旧更新：current@1 ≥ 75%", pass: staleUpdate.successRate >= 0.75, detail: `${(staleUpdate.successRate * 100).toFixed(0)}% (${staleUpdate.currentReturned}/${staleUpdate.trials})` },
    { name: "contamination@5 = 0（无新旧混杂）", pass: staleUpdate.contaminationAt5 === 0, detail: `${(staleUpdate.contaminationAt5 * 100).toFixed(0)}%` },
    { name: "跨会话持久性：重启后能召回", pass: crossSession.recalled, detail: crossSession.recalled ? "recalled" : "lost" },
    { name: "向量检索：写入带向量后能纯向量命中", pass: vector.recalledByVector && vector.rrfVecApplied, detail: `${vector.recalledByVector ? "hit" : "miss"} / rrfVec=${vector.rrfVecApplied ? ">0" : "0"}` },
    { name: "图检索：能回答关系问题", pass: graph.answered, detail: graph.answered ? `"${graph.sentence}"` : "未答出" },
    { name: "图检索：两跳可达 + 图路参与打分", pass: graph.multiHopEdges >= 2 && graph.graphScoreApplied, detail: `两跳 ${graph.multiHopEdges} 边 / rrfGraph ${graph.graphScoreApplied ? ">0" : "0"}` },
    { name: "多任务隔离：不同 namespace 串扰 = 0", pass: isolation.pass, detail: `泄漏 ${isolation.leakage} 条 / A ${isolation.taskAHits} 条 / B ${isolation.taskBHits} 条` },
    { name: "多任务串扰：同 namespace 混召回可复现", pass: isolation.sameNamespaceMixed, detail: isolation.sameNamespaceMixed ? `命中 ${isolation.sameNamespaceTasks} 个任务（风险成立）` : "未复现（请检查分词）" },
  ];
  return {
    version: VERSION,
    generatedAt: new Date(T0).toISOString(),
    deterministic: true,
    scenarios: { writeRecall, staleUpdate, crossSession, vector, graph, isolation },
    summary: { passed: checks.every((c) => c.pass), checks },
  };
}

/** 人类可读报告 */
export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════╗");
  lines.push("║   Membrane Doctor · 可复现自检报告 v" + r.version + "      ║");
  lines.push("╚══════════════════════════════════════════════╝");
  lines.push("");
  lines.push("【剧本 1 · 写入召回】");
  lines.push(`  命中率      ${(r.scenarios.writeRecall.hitRate * 100).toFixed(0)}%  (${r.scenarios.writeRecall.hits}/${r.scenarios.writeRecall.total})`);
  lines.push(`  耗时        ${r.scenarios.writeRecall.latencyMs} ms`);
  lines.push("");
  lines.push("【剧本 2 · 陈旧更新 + 污染度】");
  lines.push(`  current@1   ${(r.scenarios.staleUpdate.successRate * 100).toFixed(0)}%  (${r.scenarios.staleUpdate.currentReturned}/${r.scenarios.staleUpdate.trials})`);
  lines.push(`  contam@5    ${(r.scenarios.staleUpdate.contaminationAt5 * 100).toFixed(0)}%`);
  lines.push(`  contam@1    ${(r.scenarios.staleUpdate.contaminationAt1 * 100).toFixed(0)}%`);
  lines.push(`  耗时        ${r.scenarios.staleUpdate.latencyMs} ms`);
  lines.push("");
  lines.push("【剧本 3 · 跨会话持久性】");
  lines.push(`  重启召回    ${r.scenarios.crossSession.recalled ? "成功 ✓" : "失败 ✗"}`);
  lines.push(`  记录数      ${r.scenarios.crossSession.recordCount}`);
  lines.push("");
  lines.push("【剧本 4 · 向量检索（离线确定性）】");
  lines.push(`  写入带向量  ${r.scenarios.vector.entries} 条`);
  lines.push(`  纯向量命中  ${r.scenarios.vector.recalledByVector ? "成功 ✓" : "失败 ✗"}`);
  lines.push(`  余弦相似度  ${r.scenarios.vector.vecSimilarity === null ? "无" : r.scenarios.vector.vecSimilarity.toFixed(2)}`);
  lines.push(`  vec 分量    ${r.scenarios.vector.rrfVecApplied ? "已参与打分 ✓" : "未参与 ✗"}`);
  lines.push(`  耗时        ${r.scenarios.vector.latencyMs} ms`);
  lines.push("");
  lines.push("【剧本 5 · 图检索】");
  lines.push(`  直接答关系  ${r.scenarios.graph.answered ? "成功 ✓" : "失败 ✗"}  ${r.scenarios.graph.sentence}`);
  lines.push(`  两跳可达    ${r.scenarios.graph.multiHopEdges} 条边`);
  lines.push(`  图路打分    ${r.scenarios.graph.graphScoreApplied ? "已参与 ✓" : "未参与 ✗"}`);
  lines.push(`  耗时        ${r.scenarios.graph.latencyMs} ms`);
  lines.push("");
  lines.push("【剧本 6 · 多任务隔离】");
  lines.push(`  同 namespace ${r.scenarios.isolation.sameNamespaceMixed ? "会互相召回（风险成立）" : "未复现"} / ${r.scenarios.isolation.sameNamespaceTasks} 个任务`);
  lines.push(`  任务A 独立    ${r.scenarios.isolation.taskAHits} 条`);
  lines.push(`  任务B 独立    ${r.scenarios.isolation.taskBHits} 条`);
  lines.push(`  串扰         ${r.scenarios.isolation.leakage} 条 ${r.scenarios.isolation.pass ? "✓" : "✗"}`);
  lines.push(`  耗时         ${r.scenarios.isolation.latencyMs} ms`);
  lines.push("");
  lines.push("【验收检查】");
  for (const c of r.summary.checks) lines.push(`  ${c.pass ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  lines.push("");
  lines.push(r.summary.passed ? "总体：全部通过 ✓" : "总体：有未通过项 ✗");
  return lines.join("\n");
}

/** 把报告写到文件 */
export function writeDoctorReport(r: DoctorReport, dir: string): { json: string; text: string } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const json = join(dir, "doctor-report.json");
  const text = join(dir, "doctor-report.txt");
  writeFileSync(json, JSON.stringify(r, null, 2), "utf8");
  writeFileSync(text, formatDoctorReport(r), "utf8");
  return { json, text };
}
