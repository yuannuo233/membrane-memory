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
import { llmFromEnv } from "./llm.js";
import { randomUUID } from "node:crypto";
import {
  asBoolean as bool,
  asEntityInputs as entityInputs,
  asEntityType as entityType,
  asFiniteNumber as num,
  asKind as kind,
  asNumberArray as numArray,
  asRelationInputs as relationInputs,
  asString as str,
  asStringArray as strArray,
} from "./input.js";

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
        subjectType: {
          type: "string",
          enum: ["person", "place", "org", "concept", "unknown"],
          description: "主语的实体类型（图检索用），不传则按规则推断",
        },
        entities: {
          type: "array",
          description: "这条记忆涉及的其他实体名（手动标注，会优先于规则抽取）",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["person", "place", "org", "concept", "unknown"] },
                },
                required: ["name"],
              },
            ],
          },
        },
        relations: {
          type: "array",
          description: "手动标注的关系（优先于规则抽取）；from 省略时取 subject",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "起点实体名，省略=subject" },
              to: { type: "string", description: "终点实体名" },
              predicate: { type: "string", description: "关系谓词，如 同学 / 住在 / 工作于" },
              fromType: { type: "string", enum: ["person", "place", "org", "concept", "unknown"] },
              toType: { type: "string", enum: ["person", "place", "org", "concept", "unknown"] },
            },
            required: ["to", "predicate"],
          },
        },
        embedding: {
          type: "array",
          items: { type: "number" },
          description: "预先算好的向量（可选）；配置了 MEMBRANE_EMBED_MODEL 时可省略",
        },
        embed: {
          type: "boolean",
          description:
            "是否在写入时调用 embedding 端点算向量。默认 true（仅在配置了 MEMBRANE_EMBED_MODEL 时生效）",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "membrane_recall",
    description:
      "召回记忆。全文 + 向量 + 关系三路候选，RRF 融合 + 时间新鲜度 + 置信度打分，每条返回 why 入选理由和分数明细。可用 asOf 做历史时点查询；查询里出现已知实体时会自动走关系图路。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询文本（必填）" },
        limit: { type: "number", description: "返回条数，默认 8" },
        asOf: { type: "number", description: "历史时点 unix 毫秒：只看该时刻有效的记忆" },
        kind: { type: "string", enum: ["fact", "episode", "preference", "procedure"] },
        subject: { type: "string", description: "按主语过滤" },
        namespace: { type: "string", description: "命名空间（多租户隔离），默认 default" },
        entities: {
          type: "array",
          items: { type: "string" },
          description: "手动指定查询涉及的实体（默认由规则从 query 里认）",
        },
        hops: { type: "number", description: "关系图路最多几跳，默认 1" },
        noGraph: { type: "boolean", description: "关闭关系图路（只走全文/向量）" },
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
    name: "membrane_link",
    description:
      "手动建立一条关系（图检索）。例：from=张三, to=李四, predicate=同学。关系也遵守时间感知（asOf 可查历史）。",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "起点实体名（必填）" },
        to: { type: "string", description: "终点实体名（必填）" },
        predicate: { type: "string", description: "关系谓词，如 同学 / 住在 / 工作于" },
        fromType: { type: "string", enum: ["person", "place", "org", "concept", "unknown"] },
        toType: { type: "string", enum: ["person", "place", "org", "concept", "unknown"] },
        confidence: { type: "number", description: "置信度 0~1，默认 1" },
        memoryId: { type: "string", description: "这条关系出自哪条记忆（溯源，可选）" },
        namespace: { type: "string", description: "命名空间，默认 default" },
      },
      required: ["from", "to", "predicate"],
    },
  },
  {
    name: "membrane_relations",
    description:
      "查关系，直接回答'张三和李四是什么关系'。只传 a=查某实体的一跳邻居；传 a+b=查两人之间的最短路径（默认 1 跳）。可传整句，会自动认实体。",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "实体名（或整句查询）" },
        b: { type: "string", description: "第二个实体名（可选）" },
        asOf: { type: "number", description: "历史时点 unix 毫秒：查当时成立的关系" },
        maxHops: { type: "number", description: "最多几跳，默认 1，上限 4" },
        limit: { type: "number", description: "返回条数，默认 32" },
        namespace: { type: "string", description: "命名空间，默认 default" },
      },
      required: ["a"],
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

/** 把任意结果包成 MCP text content */
function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorResult(msg: string): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: "Error: " + msg }], isError: true };
}

/** 执行一个工具调用（异步：配置了 embedding 模型时要先算向量） */
async function callTool(
  engine: Membrane,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  switch (name) {
    case "membrane_add": {
      const content = str(arg(args, "content"));
      if (!content) return errorResult("content 必填且必须是字符串");
      return textResult(
        await engine.addAsync(
          {
            content,
            kind: kind(arg(args, "kind")),
            subject: str(arg(args, "subject")),
            subjectType: entityType(arg(args, "subjectType")),
            tags: strArray(arg(args, "tags")),
            confidence: num(arg(args, "confidence")),
            source: str(arg(args, "source")),
            pin: bool(arg(args, "pin")),
            namespace: str(arg(args, "namespace")),
            vec: numArray(arg(args, "embedding")),
            entities: entityInputs(arg(args, "entities")),
            relations: relationInputs(arg(args, "relations")),
          },
          { embed: bool(arg(args, "embed")) },
        ),
      );
    }
    case "membrane_recall": {
      const query = str(arg(args, "query"));
      if (!query) return errorResult("query 必填且必须是字符串");
      const detail = str(arg(args, "detail")) ?? "brief";
      const hits = await engine.recallAsync({
        query,
        limit: num(arg(args, "limit")),
        asOf: num(arg(args, "asOf")),
        kind: kind(arg(args, "kind")),
        subject: str(arg(args, "subject")),
        namespace: str(arg(args, "namespace")),
        entities: strArray(arg(args, "entities")),
        hops: num(arg(args, "hops")),
        noGraph: bool(arg(args, "noGraph")),
      });
      // 三档返回：ultra 最省（只 id+内容+分数）、brief 默认、full 排查用
      if (detail === "full") return textResult(hits);
      if (detail === "ultra") return textResult(hits.map(toUltraBrief));
      return textResult(hits.map(toBrief));
    }
    case "membrane_link": {
      const from = str(arg(args, "from"));
      const to = str(arg(args, "to"));
      const predicate = str(arg(args, "predicate"));
      if (!from || !to || !predicate) return errorResult("from / to / predicate 都必填");
      return textResult(
        engine.link({
          from,
          fromType: entityType(arg(args, "fromType")),
          to,
          toType: entityType(arg(args, "toType")),
          predicate,
          confidence: num(arg(args, "confidence")),
          memoryId: str(arg(args, "memoryId")),
          namespace: str(arg(args, "namespace")),
        }),
      );
    }
    case "membrane_relations": {
      const a = str(arg(args, "a"));
      if (!a) return errorResult("a 必填（实体名或整句查询）");
      return textResult(
        engine.relations(a, str(arg(args, "b")), {
          asOf: num(arg(args, "asOf")),
          maxHops: num(arg(args, "maxHops")),
          limit: num(arg(args, "limit")),
          namespace: str(arg(args, "namespace")),
        }),
      );
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

/** 启动 MCP server（stdio），每个进程生成一个会话 id 用于登记客户端。 */
export function startMcpServer(engine: Membrane): void {
  const sessionId = randomUUID();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        void handleLine(engine, line, sessionId)
          .then((out) => {
            if (out !== null) process.stdout.write(out + "\n");
          })
          .catch((e) => {
            // 兜底：任何未捕获异常只上 stderr，绝不杀死 stdio 协议进程
            console.error("[membrane-mcp] handler error:", e);
          });
      }
    }
  });

  const closeSession = (): void => {
    try {
      engine.storage.closeMcpClient(sessionId);
    } catch {
      // 进程退出阶段数据库可能已关闭，忽略即可；last_seen 超时仍会兜底
    }
  };
  process.once("SIGINT", () => {
    closeSession();
    engine.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    closeSession();
    engine.close();
    process.exit(0);
  });
  process.on("exit", closeSession);
  // 客户端关闭 stdin（正常断开）也要落 closed，而不是等 5 分钟超时
  process.stdin.on("end", () => {
    closeSession();
    engine.close();
    process.exit(0);
  });
  console.error("[membrane-mcp] started, db=" + engine.storage.path);
}

/** 处理一行 JSON-RPC（导出以便单测直接喂报文）。sessionId 用于登记客户端。 */
export async function handleLine(
  engine: Membrane,
  line: string,
  sessionId?: string,
): Promise<string | null> {
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
    const params = msg.params as
      | { protocolVersion?: string; clientInfo?: { name?: string; version?: string } }
      | undefined;
    const requested = params?.protocolVersion;
    const clientInfo = params?.clientInfo;
    const protocolVersion = requested || "2024-11-05";
    // 登记是可观测性功能，best-effort：写库失败（磁盘满/锁超时）绝不能拖垮协议响应
    if (sessionId) {
      try {
        engine.storage.recordMcpClient({
          sessionId,
          clientName: str(clientInfo?.name),
          clientVersion: str(clientInfo?.version),
          protocolVersion,
          transport: "stdio",
          pid: process.pid,
          cwd: process.cwd(),
          startedAt: Date.now(),
        });
      } catch (e) {
        console.error("[membrane-mcp] client registry write failed:", e);
      }
    }
    return send({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "membrane-memory", version: "0.2.3" },
      instructions:
        "Membrane 记忆脑：用 membrane_add 记住事实，用 membrane_recall 按语义召回并查看 why 理由，用 membrane_relations 查实体之间的关系，用 membrane_link 手动建立关系，用 membrane_forget 遗忘。",
    });
  }
  if (method && method.startsWith("notifications/")) return null;
  if (method === "ping") return send({});
  if (method === "tools/list") return send({ tools: TOOLS });
  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    // 同上：调用计数 best-effort，失败不影响工具结果
    if (sessionId) {
      try {
        engine.storage.touchMcpClient(sessionId, name);
      } catch {
        /* 计数失败可容忍 */
      }
    }
    try {
      const result = await callTool(engine, name, params.arguments);
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
  // llm 从环境变量读：配了 MEMBRANE_EMBED_MODEL 才有向量，没配就是纯全文（零依赖不变）
  startMcpServer(new Membrane({ dbPath: path, llm: llmFromEnv() }));
}
