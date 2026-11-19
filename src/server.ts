/**
 * HTTP 服务——零依赖，只用 node:http 内置模块。
 *
 * 两个职责：
 * 1) REST API：mem0 兼容子集 + Membrane 原生端点（供第三方工具/脚本调用）
 * 2) 静态托管 web/ 目录（Dashboard UI）
 *
 * 安全：默认绑定 127.0.0.1（本机环回）；--host 0.0.0.0 时必须给 token，否则拒绝启动。
 * Bearer token 校验：MEMBRANE_TOKEN 环境变量或构造参数。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Membrane, toBrief, toUltraBrief } from "./engine.js";
import { MembraneError } from "./model.js";
import { MemoryLogger, type LogLevel } from "./logger.js";
import { probeTaskIsolation } from "./isolation.js";
import { VERSION } from "./version.js";
import {
  asBoolean,
  asEntityInputs,
  asEntityType,
  asFiniteNumber,
  asKind,
  asNumberArray,
  asRelationInputs,
  asString,
  asStringArray,
} from "./input.js";
import type { MemoryKind } from "./types.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  token?: string;
  /** 静态资源目录（默认项目 web/） */
  webDir?: string;
  /** 结构化运行日志；不传则自动落到 `<db>.log` */
  logger?: MemoryLogger;
  /** 日志文件路径覆盖（仅当未传 logger 时生效） */
  logFile?: string;
}

/** 后台诊断/日志路由需要的运行时上下文（单测可直接省略） */
export interface RouteContext {
  logger?: MemoryLogger;
  startedAt?: number;
  host?: string;
  port?: number;
  tokenConfigured?: boolean;
  version?: string;
}

type ApiResult = { status?: number; body: unknown };

/**
 * 统一的 JSON 响应。
 * CORS 用 `*`：本服务默认只绑 127.0.0.1，跨域风险由网络层兜住；
 * 绑 0.0.0.0 且配了 token 时，`*` 才能让浏览器类客户端正常调用
 * （写死 127.0.0.1 会导致远程访问被浏览器 CORS 拦截）。
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(payload);
}

/** 从请求体读 JSON（限 1MB，防呆） */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let aborted = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (aborted) return;
      raw += c;
      if (raw.length > 1_000_000) {
        aborted = true;
        req.destroy(); // 真正中断，别继续占内存
        reject(new MembraneError("E_BODY", "请求体超过 1MB"));
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new MembraneError("E_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

/**
 * 常量时间字符串比较（防时序侧信道）。
 * 长度不同时也不早退——用固定次数累积差异，最后统一判长度与内容。
 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/** 判断 MCP 进程是否还活着：信号 0 只探测不发送；EPERM 代表进程存在但没权限，也算活着 */
function pidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET query 里的多值/CSV：`?kinds=fact,episode` 或 `?kinds=fact&kinds=episode`（后者只留最后一个） */
function asKindsCsv(v: unknown): MemoryKind[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => asKind(x)).filter((x): x is MemoryKind => x !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === "string") {
    const out = v
      .split(",")
      .map((s) => asKind(s.trim()))
      .filter((x): x is MemoryKind => x !== undefined);
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 路由分发（导出以便单测直接喂请求，不必起真端口） */
export async function route(
  engine: Membrane,
  method: string,
  urlPath: string,
  body: Record<string, unknown>,
  webDir: string,
  ctx: RouteContext = {},
): Promise<ApiResult> {
  // ---- Dashboard 静态资源 ----
  if (method === "GET" && (urlPath === "/" || urlPath === "/index.html")) {
    const f = join(webDir, "index.html");
    if (existsSync(f)) {
      return { status: 200, body: { __file: f } }; // 由 server 特判发文件
    }
    return { status: 404, body: { error: "Dashboard 未找到（web/index.html 缺失）" } };
  }
  if (method === "GET" && (urlPath.startsWith("/app.") || urlPath.startsWith("/assets/"))) {
    // 只允许 webDir 内的文件（防路径穿越）
    const rel = urlPath.replace(/^\//, "");
    const f = resolve(webDir, rel);
    if (!f.startsWith(resolve(webDir) + sep) && f !== resolve(webDir)) {
      return { status: 403, body: { error: "Forbidden" } };
    }
    if (existsSync(f)) return { status: 200, body: { __file: f } };
    return { status: 404, body: { error: "Not found" } };
  }

  // ---- API ----
  if (method === "GET" && urlPath === "/api/stats") {
    return { body: engine.stats() };
  }
  if (method === "GET" && urlPath === "/api/health") {
    return {
      body: { ok: true, service: "membrane-memory", version: VERSION, db: engine.storage.path },
    };
  }
  // ---- 运维后台（给懂的人看；不返回任何记忆正文） ----
  if (method === "GET" && urlPath === "/api/admin/logs") {
    const levelRaw = asString(body.level);
    const level: LogLevel | undefined =
      levelRaw === "info" || levelRaw === "warn" || levelRaw === "error" ? levelRaw : undefined;
    const limit = Math.min(500, Math.max(1, asFiniteNumber(body.limit) ?? 100));
    const entries = ctx.logger?.tail(limit, level) ?? [];
    return {
      status: 200,
      body: {
        entries,
        count: entries.length,
        logging: ctx.logger?.stats() ?? { path: null, buffered: 0, written: 0, dropped: 0, fileError: null },
      },
    };
  }
  if (method === "GET" && urlPath === "/api/admin/diagnostics") {
    const stats = engine.stats();
    const capabilities = {
      llmConfigured: !!engine.llm,
      extractionModel: engine.llm?.model ?? null,
      embeddingConfigured: !!engine.llm?.embeddingModel,
      embeddingModel: engine.llm?.embeddingModel ?? null,
      graphEnabled: true,
    };
    return {
      status: 200,
      body: {
        ok: true,
        service: "membrane-memory",
        version: ctx.version ?? VERSION,
        uptimeMs: ctx.startedAt === undefined ? null : Date.now() - ctx.startedAt,
        pid: process.pid,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        memoryRssBytes: process.memoryUsage().rss,
        db: { path: engine.storage.path, schemaVersion: engine.storage.schemaVersion, bytes: stats.dbBytes },
        stats,
        capabilities,
        security: {
          host: ctx.host ?? null,
          port: ctx.port ?? null,
          tokenConfigured: ctx.tokenConfigured ?? false,
        },
        logging: ctx.logger?.stats() ?? {
          path: null,
          buffered: 0,
          written: 0,
          dropped: 0,
          fileError: null,
          maxEntries: 0,
        },
      },
    };
  }
  if (method === "GET" && urlPath === "/api/admin/mcp-clients") {
    // MCP 是 stdio：每个 AI 客户端 spawn 一个独立进程，握手/工具调用元数据写同一 SQLite 库，
    // 这里只读登记表，不碰记忆正文。PID 探活判断进程是否已退出；5 分钟无活动 → stale。
    const now = Date.now();
    const limit = asFiniteNumber(body.limit) ?? 50;
    const clients = engine.storage.listMcpClients(limit).map((c) => ({
      ...c,
      state:
        c.status === "closed" || (c.pid !== null && !pidAlive(c.pid))
          ? "closed"
          : now - c.lastSeen >= 5 * 60 * 1000
            ? "stale"
            : "active",
    }));
    ctx.logger?.info("admin.mcp_clients", {
      total: clients.length,
      active: clients.filter((c) => c.state === "active").length,
    });
    return {
      status: 200,
      body: {
        clients,
        total: clients.length,
        active: clients.filter((c) => c.state === "active").length,
        generatedAt: now,
        staleAfterMs: 5 * 60 * 1000,
      },
    };
  }
  if (method === "GET" && urlPath === "/api/admin/isolation-check") {
    // 只跑 :memory: 临时库，绝不碰用户数据；给后台/curl 一个"当场证明"按钮
    const probe = probeTaskIsolation();
    ctx.logger?.info("admin.isolation_probe", { pass: probe.separatedNamespaces.pass, mixed: probe.sharedNamespace.mixed });
    return { status: 200, body: probe };
  }
  if (method === "GET" && urlPath === "/api/export") {
    // Dashboard 的"导出备份"按钮走这里；默认带向量，?noEmbeddings=1 可省
    const includeEmbeddings = asString(body.noEmbeddings) !== "1";
    return { status: 200, body: engine.exportAll({ includeEmbeddings }) };
  }
  if (method === "GET" && urlPath === "/api/memories") {
    const validity = asString(body.validity) === "all" ? "all" : "current";
    return {
      body: engine.list({
        validity,
        kind: asKind(body.kind),
        kinds: asKindsCsv(body.kinds),
        // GET 的 query 全是字符串：以前这里判 typeof === "number"，导致 ?limit= 永远失效
        limit: asFiniteNumber(body.limit),
        namespace: asString(body.namespace),
      }),
    };
  }
  if (method === "POST" && urlPath === "/api/recall") {
    const query = asString(body.query) ?? "";
    if (!query) return { status: 400, body: { error: "query 必填" } };
    const hits = await engine.recallAsync({
      query,
      limit: asFiniteNumber(body.limit),
      asOf: asFiniteNumber(body.asOf),
      kind: asKind(body.kind),
      kinds: asKindsCsv(body.kinds),
      subject: asString(body.subject),
      namespace: asString(body.namespace),
      entities: asStringArray(body.entities),
      hops: asFiniteNumber(body.hops),
      noGraph: asBoolean(body.noGraph),
    });
    // 默认 brief：REST 与 MCP/README 口径一致，避免"省 token"卖点被远程调用打脸
    const detail = asString(body.detail) ?? "brief";
    if (detail === "ultra") {
      return { body: { results: hits.map(toUltraBrief), count: hits.length } };
    }
    if (detail === "brief") {
      return { body: { results: hits.map(toBrief), count: hits.length } };
    }
    return { body: { results: hits, count: hits.length } };
  }
  if (method === "POST" && urlPath === "/api/memories") {
    const content = asString(body.content) ?? "";
    if (!content) return { status: 400, body: { error: "content 必填" } };
    // 向量既可以直接传（embedding 数组），也可以让服务端调 embedding 端点算（配了 model 时默认算）
    const r = await engine.addAsync(
      {
        content,
        kind: asKind(body.kind),
        subject: asString(body.subject),
        subjectType: asEntityType(body.subjectType),
        tags: asStringArray(body.tags),
        confidence: asFiniteNumber(body.confidence),
        pin: body.pin === true,
        evidence: asStringArray(body.evidence),
        namespace: asString(body.namespace),
        source: asString(body.source) ?? "rest",
        vec: asNumberArray(body.embedding),
        // 支持 ["李四", {name:"腾讯", type:"org"}] 两种写法（与 MCP 对齐）
        entities: asEntityInputs(body.entities),
        relations: asRelationInputs(body.relations),
      },
      { embed: body.embed === false ? false : undefined },
    );
    return { status: 201, body: r };
  }

  // ---- 图检索 ----
  if (method === "GET" && urlPath === "/api/relations") {
    const a = asString(body.a) ?? asString(body.from) ?? "";
    if (!a) return { status: 400, body: { error: "a（或 from）必填" } };
    const b = asString(body.b) ?? asString(body.to) ?? null;
    return {
      body: {
        relations: engine.relations(a, b, {
          asOf: asFiniteNumber(body.asOf),
          maxHops: asFiniteNumber(body.maxHops),
          limit: asFiniteNumber(body.limit),
          namespace: asString(body.namespace),
        }),
      },
    };
  }
  if (method === "POST" && urlPath === "/api/relations") {
    const from = asString(body.from) ?? "";
    const to = asString(body.to) ?? "";
    const predicate = asString(body.predicate) ?? "";
    if (!from || !to || !predicate) {
      return { status: 400, body: { error: "from / to / predicate 都必填" } };
    }
    const rel = engine.link({
      from,
      fromType: asEntityType(body.fromType),
      to,
      toType: asEntityType(body.toType),
      predicate,
      confidence: asFiniteNumber(body.confidence),
      memoryId: asString(body.memoryId) ?? null,
      namespace: asString(body.namespace),
    });
    return { status: 201, body: rel };
  }
  if (method === "GET" && urlPath === "/api/entities") {
    const ns = asString(body.namespace);
    const limit = asFiniteNumber(body.limit);
    const memoryId = asString(body.memoryId);
    return {
      body: {
        entities: memoryId ? engine.entitiesFor(memoryId) : engine.listEntities(ns, limit),
      },
    };
  }

  // mem0 兼容子集
  if (method === "POST" && urlPath === "/v1/memories/") {
    return route(engine, "POST", "/api/memories", body, webDir);
  }
  if (method === "POST" && urlPath === "/v1/memories/search") {
    return route(engine, "POST", "/api/recall", body, webDir);
  }

  const mHistory = urlPath.match(/^\/api\/memories\/([^/]+)\/history$/);
  if (method === "GET" && mHistory) {
    return { body: engine.history(decodeURIComponent(mHistory[1]!)) };
  }
  const mEvidence = urlPath.match(/^\/api\/memories\/([^/]+)\/evidence$/);
  if (method === "GET" && mEvidence) {
    return { body: engine.evidence(decodeURIComponent(mEvidence[1]!)) };
  }
  const mForget = urlPath.match(/^\/api\/memories\/([^/]+)\/forget$/);
  if (method === "POST" && mForget) {
    engine.forget(decodeURIComponent(mForget[1]!));
    return { body: { ok: true } };
  }
  const mEdit = urlPath.match(/^\/api\/memories\/([^/]+)$/);
  if ((method === "PATCH" || method === "PUT") && mEdit) {
    const r = await engine.updateAsync(
      decodeURIComponent(mEdit[1]!),
      {
        content: asString(body.content),
        kind: asKind(body.kind),
        // subject 显式传 null = 清空主语；不传 = 沿用旧值
        subject: body.subject === null ? null : asString(body.subject),
        tags: asStringArray(body.tags),
        confidence: asFiniteNumber(body.confidence),
        source: body.source === null ? null : asString(body.source),
        pin: asBoolean(body.pin),
        evidence: asStringArray(body.evidence),
        entities: asEntityInputs(body.entities),
        relations: asRelationInputs(body.relations),
        subjectType: asEntityType(body.subjectType),
        vec: asNumberArray(body.embedding),
      },
      { embed: body.embed === false ? false : undefined },
    );
    return { status: 200, body: r };
  }
  if (method === "DELETE" && mEdit) {
    engine.forget(decodeURIComponent(mEdit[1]!));
    return { status: 200, body: { ok: true, id: decodeURIComponent(mEdit[1]!) } };
  }
  const mGet = urlPath.match(/^\/api\/memories\/([^/]+)$/);
  if (method === "GET" && mGet) {
    return { body: engine.get(decodeURIComponent(mGet[1]!)) };
  }
  if (method === "GET" && urlPath === "/v1/memories") {
    return route(engine, "GET", "/api/memories", body, webDir);
  }
  const mV1 = urlPath.match(/^\/v1\/memories\/([^/]+)(?:\/history)?$/);
  if (method === "GET" && mV1) {
    const id = decodeURIComponent(mV1[1]!);
    return { body: urlPath.endsWith("/history") ? engine.history(id) : engine.get(id) };
  }

  return { status: 404, body: { error: "Not found", path: urlPath } };
}

/** 启动 HTTP 服务 */
export function startServer(engine: Membrane, opts: ServerOptions = {}): ReturnType<typeof createServer> {
  const host = opts.host ?? process.env["MEMBRANE_HOST"] ?? "127.0.0.1";
  const token = opts.token ?? process.env["MEMBRANE_TOKEN"] ?? "";
  if (host !== "127.0.0.1" && host !== "localhost" && !token) {
    throw new MembraneError("E_TOKEN", "绑定非本机地址时必须设置 MEMBRANE_TOKEN（Bearer 认证）");
  }
  const port = opts.port ?? Number(process.env["MEMBRANE_PORT"] ?? 8317);
  // web 目录定位：优先环境变量 → 显式参数 → 相对本文件(dist/server.js)的 ../web。
  // 关键：不能用 process.cwd()——用户可能从任意目录启动 CLI，那样 UI 会 404。
  const here = dirname(fileURLToPath(import.meta.url)); // 运行时 = <pkg>/dist
  const defaultWebDir = resolve(here, "..", "web");
  const webDir = opts.webDir ?? process.env["MEMBRANE_WEB_DIR"] ?? defaultWebDir;

  // 日志：默认落在库文件旁边（membrane.db.log），只记请求元数据，不记记忆正文。
  // 内存库/测试可显式传 logger 或 logFile；`:memory:` 默认不落盘。
  const logPath =
    opts.logFile ??
    process.env["MEMBRANE_LOG_FILE"] ??
    (engine.storage.path === ":memory:" ? undefined : `${engine.storage.path}.log`);
  const logger = opts.logger ?? new MemoryLogger({ path: logPath });
  const ctx: RouteContext = {
    logger,
    startedAt: Date.now(),
    host,
    port,
    tokenConfigured: !!token,
    version: VERSION,
  };

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const pathForLog = (req.url ?? "/").split("?")[0]!;
    let status = 500;
    void (async () => {
      try {
        // CORS 预检必须早于鉴权：浏览器预检不会带 Authorization
        if (method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          });
          res.end();
          return;
        }
        const u = new URL(req.url ?? "/", `http://${host}`);
        // 只锁数据接口；静态控制台必须能先加载，否则浏览器地址栏永远打不开
        const isApiPath = u.pathname.startsWith("/api/") || u.pathname.startsWith("/v1/");
        // token 校验（配了才要求）；用常量时间比较，避免时序侧信道。
        // 兼容两种来源：Authorization: Bearer xxx（脚本/客户端），?token=xxx（浏览器首次打开后存 localStorage）
        if (token && isApiPath) {
          const auth = req.headers["authorization"];
          const qToken = u.searchParams.get("token");
          const provided = typeof auth === "string" ? auth : qToken ? `Bearer ${qToken}` : "";
          if (!safeEqual(provided, `Bearer ${token}`)) {
            status = 401;
            logger.warn("http.auth_failed", { method, path: pathForLog });
            json(res, 401, { error: "Unauthorized" });
            return;
          }
        }
        const query: Record<string, unknown> = {};
        u.searchParams.forEach((v, k) => (query[k] = v));
        // PATCH/PUT 也带 JSON body；之前只读 POST，导致真实 HTTP 编辑时内容被当成空对象
        const hasBody = req.method === "POST" || req.method === "PATCH" || req.method === "PUT";
        const body = hasBody ? await readBody(req) : query;
        const result = await route(engine, req.method ?? "GET", u.pathname, body, webDir, ctx);
        status = result.status ?? 200;
        const b = result.body as { __file?: string };
        if (b && typeof b === "object" && "__file" in b) {
          const file = b.__file!;
          const ext = extname(file);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          res.end(readFileSync(file));
          return;
        }
        json(res, status, result.body);
      } catch (e) {
        status = e instanceof MembraneError && e.code.startsWith("E_") ? 400 : 500;
        logger.error("http.error", {
          method,
          path: pathForLog,
          status,
          code: e instanceof MembraneError ? e.code : "E_INTERNAL",
        });
        json(res, status, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        // 只记 API 请求，静态资源不刷屏；query/body 一律不落日志
        if (pathForLog.startsWith("/api/")) {
          logger.info("http.request", {
            method,
            path: pathForLog,
            status,
            ms: Date.now() - startedAt,
          });
        }
      }
    })();
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : port;
    ctx.port = actualPort;
    logger.info("server.start", { host, port: actualPort, db: engine.storage.path, logFile: logger.path });
    console.log(`[membrane] REST + Dashboard 已启动：http://${host}:${actualPort}`);
    console.log(`[membrane] 健康检查：http://${host}:${actualPort}/api/health`);
    console.log(`[membrane] 运维后台：http://${host}:${actualPort}/#ops（日志 ${logger.path ?? "memory only"}）`);
  });
  return server;
}
