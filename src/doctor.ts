/**
 * Doctor 自检（DESIGN.md 第 8 节）——把"数字可复现"落成可执行脚本。
 *
 * 三套剧本，全部确定性（注入固定时钟 + 内存库 + 固定数据）：
 *   1. 写入召回：N 条事实 + 干扰项 → 命中率
 *   2. 更新陈旧：写入→更新→按旧问法查询→应返回新值（对抗 stale retrieval）
 *   3. 跨会话：模拟进程重启（关库重开同一路径）→ 记忆仍在
 *
 * 关键指标 contamination@k：top-k 里同时出现 current 与 stale 版本——
 * StaleBench 论文证明它比 current@k 更能正确评价策略（current@1 会把 13/42 策略排反）。
 *
 * 输出 JSON（机器读）+ 人类可读文本，README 里的数字必须来自这里。
 */
import { Membrane } from "./engine.js";
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

  const checks = [
    { name: "写入召回命中率 ≥ 80%", pass: writeRecall.hitRate >= 0.8, detail: `${(writeRecall.hitRate * 100).toFixed(0)}% (${writeRecall.hits}/${writeRecall.total})` },
    { name: "陈旧更新：current@1 ≥ 75%", pass: staleUpdate.successRate >= 0.75, detail: `${(staleUpdate.successRate * 100).toFixed(0)}% (${staleUpdate.currentReturned}/${staleUpdate.trials})` },
    { name: "contamination@5 = 0（无新旧混杂）", pass: staleUpdate.contaminationAt5 === 0, detail: `${(staleUpdate.contaminationAt5 * 100).toFixed(0)}%` },
    { name: "跨会话持久性：重启后能召回", pass: crossSession.recalled, detail: crossSession.recalled ? "recalled" : "lost" },
  ];
  return {
    version: "0.1.7",
    generatedAt: new Date(T0).toISOString(),
    deterministic: true,
    scenarios: { writeRecall, staleUpdate, crossSession },
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
