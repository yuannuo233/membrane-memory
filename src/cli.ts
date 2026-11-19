#!/usr/bin/env node
/**
 * CLI 入口。所有接入面的公共底座：
 * - membrane-memory mcp            启动 MCP server（stdio，给 Agent 工具用）
 * - membrane-memory serve          启动 REST + Web 控制台
 * - membrane-memory add "..."      直写一条记忆（配了 embedding 模型就顺带算向量）
 * - membrane-memory search "..."   召回记忆（带 why/分数明细）
 * - membrane-memory link A 谓词 B  手动建立一条关系（图检索）
 * - membrane-memory relations A [B] 查关系（回答"谁和谁什么关系"）
 * - membrane-memory entities       列出实体
 * - membrane-memory embed-backfill 给老记忆批量补向量
 * - membrane-memory list/stats/doctor
 *
 * 零依赖：只用 node:sqlite（经引擎）+ 内置模块。用法/错误一律中文。
 * 配了 LLM/embedding 才联网；不配就是纯全文，行为与 v0.1 完全一致。
 */
import { Membrane } from "./engine.js";
import { runMcp } from "./mcp.js";
import { startServer } from "./server.js";
import { runDoctor, formatDoctorReport, writeDoctorReport } from "./doctor.js";
import { llmFromEnv } from "./llm.js";
import { ENTITY_TYPES, MEMORY_KINDS, type EntityType, type MemoryKind } from "./types.js";
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
  membrane-memory relations "A" ["B"]      查关系（只给 A=看一跳邻居；给 A+B=查两人之间）
  membrane-memory link A 谓词 B [选项]     手动建立一条关系
  membrane-memory entities [选项]          列出实体（图检索的节点）
  membrane-memory embed-backfill [选项]    给已有记忆批量补向量（会调 embedding 端点）
  membrane-memory list [选项]              列出记忆
  membrane-memory stats                    库况速览
  membrane-memory doctor                   自检
  membrane-memory --help                   显示本帮助

add 选项：
  --kind fact|episode|preference|procedure   记忆种类（默认 fact）
  --subject "主语"                           主语/实体名
  --subject-type ${ENTITY_TYPES.join("|")}
  --tags "标签1,标签2"                       逗号分隔的标签
  --pin                                      钉选（永不自动取代）
  --namespace "名字"                         命名空间（多租户隔离，默认 default）
  --no-embed                                 本次不调 embedding（快）

search 选项：
  --limit N       返回条数（默认 8）
  --as-of MS      历史时点查询（unix 毫秒）
  --subject X     按主语过滤
  --hops N        关系图路最多几跳（默认 1）
  --no-graph      关闭关系图路

relations 选项：
  --hops N        最多几跳（默认 1，上限 4）
  --as-of MS      查当时成立的关系
  --limit N       返回条数（默认 32）

link 选项：
  --memory ID     这条关系出自哪条记忆（溯源）
  --from-type / --to-type  实体类型

embed-backfill 选项：
  --namespace X   只补某个命名空间
  --limit N       最多补 N 条

环境变量：
  MEMBRANE_DB              SQLite 数据库路径（默认当前目录 ./membrane.db）
  MEMBRANE_LLM_BASE_URL    OpenAI 兼容端点（如 https://api.openai.com/v1）
  MEMBRANE_LLM_API_KEY     端点 key
  MEMBRANE_LLM_MODEL       抽取用模型名
  MEMBRANE_EMBED_MODEL     embedding 模型名（配了才有向量检索）
  MEMBRANE_LLM_TIMEOUT_MS  请求超时毫秒（默认 30000）

示例：
  membrane-memory add "用户住在北京" --subject 用户 --kind fact
  membrane-memory add "张三是李四的同学" --subject 张三
  membrane-memory relations "张三" "李四"
  membrane-memory link 张三 老板 王五
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

/**
 * 取位置参数（第一个不以 -- 开头、且不是某个选项值的参数）。
 * 不能简单用 find(!startsWith("--"))——那样 `--kind fact` 里的 `fact` 会被误当成内容。
 */
function positional(args: string[]): string | undefined {
  return positionals(args)[0];
}

/** 取全部位置参数（link 需要三个：起点、谓词、终点） */
function positionals(args: string[]): string[] {
  const valueSet = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) valueSet.add(next);
    }
  }
  return args.filter((a) => !a.startsWith("--") && !valueSet.has(a));
}

function parseKind(v: string | undefined): MemoryKind | undefined {
  if (!v) return undefined;
  if (!MEMORY_KINDS.includes(v as MemoryKind)) {
    console.error(`kind 必须是 ${MEMORY_KINDS.join(" / ")} 之一，收到：${v}`);
    process.exit(2);
  }
  return v as MemoryKind;
}

/** 解析实体类型（未知名直接报错，避免把类型写错的锅甩给引擎） */
function parseEntityType(v: string | undefined): EntityType | undefined {
  if (!v) return undefined;
  if (!isEntityType(v)) {
    console.error(`实体类型必须是 ${ENTITY_TYPES.join(" / ")} 之一，收到：${v}`);
    process.exit(2);
  }
  return v as EntityType;
}

/** 实体类型白名单检查（拆出来是为了让 parseEntityType 的意图一眼看清） */
function isEntityType(v: string): boolean {
  return (ENTITY_TYPES as readonly string[]).includes(v);
}

/** 取数字选项（非法值报错，不静默变 NaN） */
function numOpt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`数字选项非法：${v}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
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
    startServer(new Membrane({ dbPath, llm: llmFromEnv() }));
    return;
  }

  const m = new Membrane({ dbPath, llm: llmFromEnv() });
  try {
    if (cmd === "add") {
      const content = positional(argv.slice(1));
      if (!content) {
        console.error('请提供记忆内容：membrane-memory add "用户住在北京"');
        process.exit(2);
      }
      const { flags, kv } = opts(argv.slice(1));
      const r = await m.addAsync(
        {
          content,
          kind: parseKind(kv.get("kind")),
          subject: kv.get("subject"),
          subjectType: parseEntityType(kv.get("subject-type")),
          tags: kv.get("tags")?.split(",").map((s) => s.trim()).filter(Boolean),
          pin: flags.has("pin"),
          source: "cli",
          namespace: kv.get("namespace"),
        },
        { embed: !flags.has("no-embed") },
      );
      console.log(`[${r.status}] ${r.note}`);
      console.log(`  id: ${r.memory.id}`);
      if (r.embeddingStatus === "stored") console.log("  向量: 已写入");
      if (r.relations && r.relations.length > 0) {
        console.log(`  关系: ${r.relations.map((x) => x.sentence).join("；")}`);
      }
      if (r.superseded.length) console.log(`  取代了: ${r.superseded.map((x) => x.id).join(", ")}`);
    } else if (cmd === "search" || cmd === "recall") {
      const query = positional(argv.slice(1));
      if (!query) {
        console.error('请提供查询：membrane-memory search "用户住哪"');
        process.exit(2);
      }
      const { flags, kv } = opts(argv.slice(1));
      const hits = await m.recallAsync({
        query,
        limit: numOpt(kv.get("limit")),
        asOf: numOpt(kv.get("as-of")),
        subject: kv.get("subject"),
        namespace: kv.get("namespace"),
        hops: numOpt(kv.get("hops")),
        noGraph: flags.has("no-graph"),
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
    } else if (cmd === "relations" || cmd === "graph") {
      const vals = positionals(argv.slice(1));
      const a = vals[0];
      if (!a) {
        console.error('请提供实体：membrane-memory relations "张三" "李四"');
        process.exit(2);
      }
      const { kv } = opts(argv.slice(1));
      const rels = m.relations(a, vals[1] ?? null, {
        asOf: numOpt(kv.get("as-of")),
        maxHops: numOpt(kv.get("hops")),
        limit: numOpt(kv.get("limit")),
        namespace: kv.get("namespace"),
      });
      if (rels.length === 0) {
        console.log("没有找到关系。");
        return;
      }
      for (const r of rels) {
        console.log(
          `${r.hops}. ${r.sentence}   [${r.fromType} → ${r.toType}]  置信 ${(r.confidence * 100).toFixed(0)}%`,
        );
        if (r.memoryId) console.log(`   来源记忆: ${r.memoryId}`);
      }
    } else if (cmd === "link") {
      const vals = positionals(argv.slice(1));
      if (vals.length < 3) {
        console.error("用法：membrane-memory link 张三 同学 李四");
        process.exit(2);
      }
      const { kv } = opts(argv.slice(1));
      const rel = m.link({
        from: vals[0]!,
        fromType: parseEntityType(kv.get("from-type")),
        predicate: vals[1]!,
        to: vals[2]!,
        toType: parseEntityType(kv.get("to-type")),
        memoryId: kv.get("memory"),
        namespace: kv.get("namespace"),
      });
      console.log(`已建立：${rel.sentence}  (${rel.fromType} → ${rel.toType})`);
      console.log(`  id: ${rel.id}`);
    } else if (cmd === "entities") {
      const { kv } = opts(argv.slice(1));
      const rows = m.listEntities(kv.get("namespace"), numOpt(kv.get("limit")));
      if (rows.length === 0) {
        console.log("（没有实体。写入带 subject 的记忆，或用 link 手动建立关系）");
        return;
      }
      rows.forEach((e) => console.log(`${e.id}  [${e.type}]  ${e.name}`));
    } else if (cmd === "embed-backfill") {
      const { kv } = opts(argv.slice(1));
      if (!m.llm?.embeddingModel) {
        console.error(
          "未配置 embedding 模型。请设环境变量 MEMBRANE_EMBED_MODEL（以及 MEMBRANE_LLM_BASE_URL / MEMBRANE_LLM_API_KEY）。",
        );
        process.exit(2);
      }
      console.log("开始回填向量……（每条记忆都会调一次 embedding 端点，慢是正常的）");
      const r = await m.backfillEmbeddings({
        namespace: kv.get("namespace"),
        limit: numOpt(kv.get("limit")),
        onProgress: (done, total) => {
          if (total > 0 && (done === total || done % 10 === 0)) {
            console.log(`  进度 ${done}/${total}`);
          }
        },
      });
      console.log(`\n完成：待补 ${r.total} 条，成功 ${r.embedded} 条，失败 ${r.failed} 条。`);
      for (const f of r.failures.slice(0, 10)) console.log(`  失败样例: ${f}`);
    } else if (cmd === "list") {
      const { kv } = opts(argv.slice(1));
      const rows = m.list({
        validity: kv.get("validity") === "all" ? "all" : "current",
        kind: parseKind(kv.get("kind")),
        subject: kv.get("subject"),
        namespace: kv.get("namespace"),
        limit: numOpt(kv.get("limit")),
      });
      if (rows.length === 0) console.log("（空）");
      rows.forEach((r) => console.log(`${r.id}  [${r.kind}]  ${r.content}`));
    } else if (cmd === "stats") {
      const s = m.stats();
      console.log(`记忆库：${dbPath}`);
      console.log(
        `  总计 ${s.total} | 现行 ${s.current} | 被取代 ${s.superseded} | 已删 ${s.deleted} | 钉选 ${s.pinned}`,
      );
      console.log(`  分布 ${Object.entries(s.byKind).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      console.log(`  实体 ${m.listEntities().length} 个`);
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

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
