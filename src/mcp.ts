/**
 * MCP Server（stdio）——让所有支持 MCP 的 Agent 工具接入 Membrane。
 *
 * 零依赖手写 JSON-RPC，不引任何 SDK：
 * 协议只需要 initialize / tools/list / tools/call / ping 四个方法，手写反而更可控、
 * 更契合"本地优先、零依赖"招牌。stdio 传输 = 一个客户端一个进程，天然隔离。
 *
 * 数据库路径：环境变量 MEMBRANE_DB（建议配绝对路径），否则用 cwd 下的 ./membrane.db。
 * 日志一律走 stderr（stdout 被 MCP 协议占用，写任何额外字符都会破坏协议）。
 */
import { Membrane, toBrief, toUltraBrief } from "./engine.js";
import type { MemoryKind } from "./types.js";

/** MCP 工具定义（JSON Schema，MCP 原生格式，不依赖 zod） */
const TOOLS = [
  {
    name: "membrane_add",
    description:
      "写入一条记忆。自动去重、检测冲突并按策略取代/并存，全程留审计链。返回 status(created/duplicate/superseded/kept-both) 与说明。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆正文（必填，一句话自包含）" },
        kind: {
          type: "string",
          enum: ["fact", "episode", "preference", "procedure"],
          description: "记忆种类，默认 fact",
        },
        subject: { type: "string", description: "主语（人/实体名），冲突检测键的一部分" },
        tags: { type: "array", items: { type: "string" }, description: "标签数组" },
        confidence: { type: "number", description: "置信度 0~1，默认 1" },
        source: { type: "string", description: "来源标记（如 agent 名）" },
        pin: { type: "boolean", description: "钉选：永不自动取代" },
        namespace: { type: "string", description: "命名空间（多租户隔离），默认 default" },
      },
      required: ["content"],
    },
  },
  {
    name: "membrane_recall",
    description:
      "召回记忆。全文检索 + RRF 融合 + 时间新鲜度 + 置信度打分，每条返回 why 入选理由和四项分数明细。可用 asOf 做历史时点查询。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询文本（必填）" },
        limit: { type: "number", description: "返回条数，默认 8" },
        asOf: { type: "number", description: "历史时点 unix 毫秒：只看该时刻有效的记忆" },
        kind: { type: "string", enum: ["fact", "episode", "preference", "procedure"] },
        subject: { type: "string", description: "按主语过滤" },
        namespace: { type: "string", description: "命名空间（多租户隔离），默认 default" },
        detail: {
          type: "string",
          enum: ["ultra", "brief", "full"],
          description:
            "返回详细度。ultra=只 id+内容+分数（最省）；brief=默认，加 kind/subject/时间/证据数；full=完整分数明细（排查用，贵 4 倍）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "membrane_forget",
    description: "遗忘（软删除）一条记忆。保留审计链，历史时点仍可查到删除前的样子。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
  },
  {
    name: "membrane_get",
    description: "按 id 取一条记忆（任何状态都返回，含被取代/软删除的）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
  },
  {
    name: "membrane_history",
    description: "查看一条记忆的完整审计链（add/supersede/keep-both/forget）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
  },
  {
    name: "membrane_list",
    description: "列出记忆。默认只看现行有效，validity=all 可看全部（含历史版本）。",
    inputSchema: {
      type: "object",
      properties: {
        validity: { type: "string", enum: ["current", "all"], description: "默认 current" },
        kind: { type: "string", enum: ["fact", "episode", "preference", "procedure"] },
        subject: { type: "string" },
        namespace: { type: "string", description: "命名空间过滤" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "membrane_evidence",
    description: "查看一条记忆的支撑证据（原文引用 + 观察时刻）。可解释性的溯源层。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
  },
  {
    name: "membrane_stats",
    description: "库况速览：总数/现行/被取代/已删除/钉选，按 kind 分布，数据库字节数。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
] as const;

type JsonRpcRequest = {
  id?: number | string;
  method?: string;
  params?: { arguments?: Record<string, unknown>; [k: string]: unknown };
};

function arg(args: Record<string, unknown> | undefined, key: string): unknown {
  return args?.[key];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}
function kind(v: unknown): MemoryKind | undefined {
  return v === "fact" || v === "episode" || v === "preference" || v === "procedure"
    ? v
    : undefined;
}

/** 把任意结果包成 MCP text content */
function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorResult(msg: string): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: "Error: " + msg }], isError: true };
}

/** 执行一个工具调用 */
function callTool(engine: Membrane, name: string, args: Record<string, unknown> | undefined): unknown {
  switch (name) {
    case "membrane_add": {
      const content = str(arg(args, "content"));
      if (!content) return errorResult("content 必填且必须是字符串");
      return textResult(
        engine.add({
          content,
          kind: kind(arg(args, "kind")),
          subject: str(arg(args, "subject")),
          tags: strArray(arg(args, "tags")),
          confidence: num(arg(args, "confidence")),
          source: str(arg(args, "source")),
          pin: bool(arg(args, "pin")),
          namespace: str(arg(args, "namespace")),
        }),
      );
    }
    case "membrane_recall": {
      const query = str(arg(args, "query"));
      if (!query) return errorResult("query 必填且必须是字符串");
      const detail = str(arg(args, "detail")) ?? "brief";
      const hits = engine.recall({
        query,
        limit: num(arg(args, "limit")),
        asOf: num(arg(args, "asOf")),
        kind: kind(arg(args, "kind")),
        subject: str(arg(args, "subject")),
        namespace: str(arg(args, "namespace")),
      });
      // 三档返回：ultra 最省（只 id+内容+分数）、brief 默认、full 排查用
      if (detail === "full") return textResult(hits);
      if (detail === "ultra") return textResult(hits.map(toUltraBrief));
      return textResult(hits.map(toBrief));
    }
    case "membrane_forget": {
      const id = str(arg(args, "id"));
      if (!id) return errorResult("id 必填");
      engine.forget(id);
      return textResult({ ok: true, id });
    }
    case "membrane_get": {
      const id = str(arg(args, "id"));
      if (!id) return errorResult("id 必填");
      return textResult(engine.get(id));
    }
    case "membrane_history": {
      const id = str(arg(args, "id"));
      if (!id) return errorResult("id 必填");
      return textResult(engine.history(id));
    }
    case "membrane_list": {
      const validity = str(arg(args, "validity"));
      return textResult(
        engine.list({
          validity: validity === "all" ? "all" : "current",
          kind: kind(arg(args, "kind")),
          subject: str(arg(args, "subject")),
          namespace: str(arg(args, "namespace")),
          limit: num(arg(args, "limit")),
        }),
      );
    }
    case "membrane_evidence": {
      const id = str(arg(args, "id"));
      if (!id) return errorResult("id 必填");
      return textResult(engine.evidence(id));
    }
    case "membrane_stats":
      return textResult(engine.stats());
    default:
      return errorResult("未知工具: " + name);
  }
}

/** 启动 MCP server（stdio）。返回引擎实例，便于测试关闭。 */
export function startMcpServer(engine: Membrane): void {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        void handleLine(engine, line).then((out) => {
          if (out !== null) process.stdout.write(out + "\n");
        });
      }
    }
  });

  process.on("SIGINT", () => {
    engine.close();
    process.exit(0);
  });
  console.error("[membrane-mcp] started, db=" + engine.storage.path);
}

/** 处理一行 JSON-RPC（导出以便单测直接喂报文） */
export async function handleLine(engine: Membrane, line: string): Promise<string | null> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return null;
  }
  const { id, method } = msg;
  const send = (result: unknown): string =>
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });

  if (method === "initialize") {
    const requested = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    return send({
      protocolVersion: requested || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "membrane-memory", version: "0.1.7" },
      instructions:
        "Membrane 记忆脑：用 membrane_add 记住事实，用 membrane_recall 按语义召回并查看 why 理由，用 membrane_forget 遗忘。",
    });
  }
  if (method && method.startsWith("notifications/")) return null;
  if (method === "ping") return send({});
  if (method === "tools/list") return send({ tools: TOOLS });
  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    try {
      const result = callTool(engine, name, params.arguments);
      return send(result);
    } catch (e) {
      return send(errorResult(e instanceof Error ? e.message : String(e)));
    }
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32601, message: "Method not found: " + String(method) },
  });
}

/** 供 CLI 调用的启动函数：建引擎 + 挂 stdio */
export function runMcp(dbPath: string | undefined): void {
  const path = dbPath ?? process.env["MEMBRANE_DB"] ?? "./membrane.db";
  startMcpServer(new Membrane({ dbPath: path }));
}
