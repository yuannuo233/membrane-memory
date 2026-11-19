#!/usr/bin/env node
/**
 * CLI 入口。所有接入面的公共底座：
 * - membrane-memory mcp           启动 MCP server（stdio，给 Agent 工具用）
 * - membrane-memory add "..."     直写一条记忆
 * - membrane-memory search "..."  召回记忆（带 why/分数明细）
 * - membrane-memory list/stats    列出/统计
 * - membrane-memory doctor        自检
 *
 * 零依赖：只用 node:sqlite（经引擎）+ 内置模块。用法/错误一律中文。
 */
import { Membrane } from "./engine.js";
import { runMcp } from "./mcp.js";
import { startServer } from "./server.js";
import { runDoctor, formatDoctorReport, writeDoctorReport } from "./doctor.js";
import { MEMORY_KINDS, type MemoryKind } from "./types.js";
import { join } from "node:path";

const argv = process.argv.slice(2);
const cmd = (argv[0] ?? "--help").toLowerCase();
const dbPath = process.env["MEMBRANE_DB"] ?? "./membrane.db";

function help(): void {
  console.log(`Membrane 记忆脑 —— 时间感知、本地优先、可解释的 Agent 记忆引擎

用法：
  membrane-memory mcp                      启动 MCP server（给 WorkBuddy/Claude/Cline/AstrBot 等用）
  membrane-memory serve                    启动 REST API + Web 控制台（默认 http://127.0.0.1:8317）
  membrane-memory add "内容" [选项]        写入一条记忆
  membrane-memory search "查询" [选项]     召回记忆（显示 why 和分数明细）
  membrane-memory list [选项]              列出记忆
  membrane-memory stats                    库况速览
  membrane-memory doctor                   自检
  membrane-memory --help                   显示本帮助

add 选项：
  --kind fact|episode|preference|procedure   记忆种类（默认 fact）
  --subject "主语"                           主语/实体名
  --tags "标签1,标签2"                       逗号分隔的标签
  --pin                                      钉选（永不自动取代）
  --namespace "名字"                         命名空间（多租户隔离，默认 default）

search 选项：
  --limit N     返回条数（默认 8）
  --as-of MS    历史时点查询（unix 毫秒）
  --subject X   按主语过滤

环境变量：
  MEMBRANE_DB   SQLite 数据库路径（默认当前目录 ./membrane.db）

示例：
  membrane-memory add "用户住在北京" --subject 用户 --kind fact
  membrane-memory search "用户住哪" --limit 3
  set MEMBRANE_DB=E:/我的记忆/membrane.db && membrane-memory mcp`);
}

/** 解析 --key value 形式的选项 */
function opts(args: string[]): { flags: Set<string>; kv: Map<string, string> } {
  const flags = new Set<string>();
  const kv = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      kv.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, kv };
}

function parseKind(v: string | undefined): MemoryKind | undefined {
  if (!v) return undefined;
  if (!MEMORY_KINDS.includes(v as MemoryKind)) {
    console.error(`kind 必须是 ${MEMORY_KINDS.join(" / ")} 之一，收到：${v}`);
    process.exit(2);
  }
  return v as MemoryKind;
}

function main(): void {
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    help();
    return;
  }
  if (cmd === "mcp") {
    runMcp(undefined);
    return;
  }
  if (cmd === "serve") {
    // REST API + Web Dashboard。引擎交给 server 管理生命周期，不在 main 末尾 close。
    startServer(new Membrane({ dbPath }));
    return;
  }

  const m = new Membrane({ dbPath });
  try {
    if (cmd === "add") {
      const content = argv.slice(1).find((a) => !a.startsWith("--"));
      if (!content) {
        console.error("请提供记忆内容：membrane-memory add \"用户住在北京\"");
        process.exit(2);
      }
      const { flags, kv } = opts(argv.slice(1));
      const r = m.add({
        content,
        kind: parseKind(kv.get("kind")),
        subject: kv.get("subject"),
        tags: kv.get("tags")?.split(",").map((s) => s.trim()).filter(Boolean),
        pin: flags.has("pin"),
        source: "cli",
        namespace: kv.get("namespace"),
      });
      console.log(`[${r.status}] ${r.note}`);
      console.log(`  id: ${r.memory.id}`);
      if (r.superseded.length) console.log(`  取代了: ${r.superseded.map((x) => x.id).join(", ")}`);
    } else if (cmd === "search" || cmd === "recall") {
      const query = argv.slice(1).find((a) => !a.startsWith("--"));
      if (!query) {
        console.error("请提供查询：membrane-memory search \"用户住哪\"");
        process.exit(2);
      }
      const { kv } = opts(argv.slice(1));
      const hits = m.recall({
        query,
        limit: kv.has("limit") ? Number(kv.get("limit")) : undefined,
        asOf: kv.has("as-of") ? Number(kv.get("as-of")) : undefined,
        subject: kv.get("subject"),
        namespace: kv.get("namespace"),
      });
      if (hits.length === 0) {
        console.log("没有找到相关记忆。");
        return;
      }
      hits.forEach((h, i) => {
        console.log(`\n${i + 1}. [${h.score.toFixed(4)}] ${h.memory.content}`);
        console.log(`   kind=${h.memory.kind} subject=${h.memory.subject ?? "-"} id=${h.memory.id}`);
        console.log(`   为什么: ${h.why}`);
      });
    } else if (cmd === "list") {
      const { kv } = opts(argv.slice(1));
      const rows = m.list({
        validity: kv.get("validity") === "all" ? "all" : "current",
        kind: parseKind(kv.get("kind")),
        subject: kv.get("subject"),
        namespace: kv.get("namespace"),
        limit: kv.has("limit") ? Number(kv.get("limit")) : undefined,
      });
      if (rows.length === 0) console.log("（空）");
      rows.forEach((r) => console.log(`${r.id}  [${r.kind}]  ${r.content}`));
    } else if (cmd === "stats") {
      const s = m.stats();
      console.log(`记忆库：${dbPath}`);
      console.log(`  总计 ${s.total} | 现行 ${s.current} | 被取代 ${s.superseded} | 已删 ${s.deleted} | 钉选 ${s.pinned}`);
      console.log(`  分布 ${Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      console.log(`  大小 ${(s.dbBytes / 1024).toFixed(1)} KB`);
    } else if (cmd === "doctor") {
      const report = runDoctor();
      console.log(formatDoctorReport(report));
      const paths = writeDoctorReport(report, join(process.cwd(), "reports"));
      console.log(`\nJSON 报告：${paths.json}`);
      console.log(`文本报告：${paths.text}`);
      if (!report.summary.passed) process.exitCode = 1;
    } else {
      console.error(`未知命令：${cmd}。用 --help 查看用法。`);
      process.exit(2);
    }
  } finally {
    m.close();
  }
}

main();
