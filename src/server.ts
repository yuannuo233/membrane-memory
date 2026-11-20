/**
 * HTTP 服务——零依赖，只用 node:http 内置模块。
 *
 * 两个职责：
 * 1) REST API：mem0 兼容子集 + Membrane 原生端点（供第三方工具/脚本调用）
 * 2) 静态托管 web/ 目录（Dashboard UI）
 *
 * 安全（审查修复 M-1 后的口径）：
 * - **数据接口（/api/* 与 /v1/*）一律要求 Bearer 令牌**，没有"本机绑定就免鉴权"的豁免——
 *   否则用户浏览器里打开的任意网页都能借 127.0.0.1 读写/删除全部记忆（drive-by 攻击面）。
 * - 没配置令牌时**自动生成** 24 字节随机令牌，保存到 settings（重启复用），控制台打印
 *   带 token 的完整 URL；Dashboard 首次打开 ?token=xxx 即存 localStorage，之后走 Bearer。
 * - **CORS 默认零放行**（同源控制台不需要 CORS 头）；需要跨源时用
 *   MEMBRANE_CORS_ORIGIN / --cors-origin 显式指定 Origin，绝不反射任意来源。
 * - 默认绑定 127.0.0.1；改绑 0.0.0.0 时控制台给出安全警告。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
  /** 访问令牌；缺省时自动生成并持久化到 settings（推荐做法） */
  token?: string;
  /** 跨源放行的指定 Origin（如 https://dash.example.com）；缺省=零 CORS 放行（审查修复 M-1） */
  corsOrigin?: string;
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
  corsOrigin?: string;
  version?: string;
}

type ApiResult = { status?: number; body: unknown };

/**
 * 统一的 JSON 响应。
 * 审查修复（M-1）：默认**零 CORS 头**——数据接口一律要求令牌，任何网页都
 * 不能借用户浏览器跨源读写本机记忆。需要跨源时由启动参数显式放行指定 Origin。
 */
function json(res: ServerResponse, status: number, body: unknown, corsOrigin?: string): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }
  res.writeHead(status, headers);
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
    // 审查修复（M-1 配套）：health 免鉴权仅用于探活，但**只暴露版本号**——
    // 数据库路径等敏感信息在受令牌保护的 /api/admin/diagnostics 里
    return { body: { ok: true, service: "membrane-memory", version: VERSION } };
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
      // 评测/对账用：强制精确全扫，关闭 LSH 桶索引
      exactVectorSearch: asBoolean(body.exactVector),
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

  // mem0 兼容子集。mem0 官方 REST 习惯带尾斜杠（/v1/memories/），部分客户端不带——
  // 两种写法都接受（v0.2.7 修复：此前一个只认带斜杠、一个只认不带，drop-in 兼容面缺了一半）
  if (method === "POST" && (urlPath === "/v1/memories" || urlPath === "/v1/memories/")) {
    return route(engine, "POST", "/api/memories", body, webDir);
  }
  if (method === "POST" && (urlPath === "/v1/memories/search" || urlPath === "/v1/memories/search/")) {
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
  const corsOrigin = opts.corsOrigin ?? (process.env["MEMBRANE_CORS_ORIGIN"] || undefined);
  // 审查修复（M-1）：令牌**永远必填**——没配置就自动生成 24 字节随机令牌并存入
  // settings（重启复用，用户的 localStorage 不会失效）。不再有"本机绑定免鉴权"的口子。
  const token = opts.token ?? process.env["MEMBRANE_TOKEN"] ?? "";
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
  // 首次启动：生成随机令牌并存 settings（重启复用，Dashboard 的 localStorage 不失效）
  let authToken = token;
  if (!authToken) {
    const saved = engine.storage.getSetting("auth_token");
    authToken = saved ?? randomBytes(24).toString("base64url");
    if (saved !== authToken) engine.storage.setSetting("auth_token", authToken);
  }
  const ctx: RouteContext = {
    logger,
    startedAt: Date.now(),
    host,
    port,
    tokenConfigured: true,
    corsOrigin,
    version: VERSION,
  };
  if (host !== "127.0.0.1" && host !== "localhost") {
    logger.warn("server.exposed", { host });
    console.warn(`[membrane] ⚠️ 绑定在 ${host}：局域网内任何设备都能访问本服务，请保管好访问令牌`);
  }

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const pathForLog = (req.url ?? "/").split("?")[0]!;
    let status = 500;
    void (async () => {
      try {
        // CORS 预检：默认零 CORS 头（审查修复 M-1——数据接口一律要令牌，
        // 预检放行跨源等于给网页开读写通道）；配置 MEMBRANE_CORS_ORIGIN 后才带放行头
        if (method === "OPTIONS") {
          const headers: Record<string, string | number> = {
            "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          };
          if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
          res.writeHead(204, headers);
          res.end();
          return;
        }
        // 审查修复（M-3）：base 用固定字符串——绑定 "::" 等特殊地址时
        // `http://${host}` 是非法 URL，每个请求都会在 new URL 抛异常（全 500）
        const u = new URL(req.url ?? "/", "http://localhost");
        // 只锁数据接口；静态控制台必须能先加载（浏览器要先拿到页面才能填 token）
        const isApiPath = u.pathname.startsWith("/api/") || u.pathname.startsWith("/v1/");
        // 审查修复（M-1）：数据接口**一律要求令牌**（自动生成）。
        // 唯一豁免：GET /api/health——只返回版本号、无任何数据，专供探活/监控使用。
        // 这是 DESIGN.md 第 9 节的既定意图，v0.2.7 落地（此前实现与文档矛盾，实测 401）。
        // 常量时间比较防时序侧信道；兼容 Bearer 头与 ?token= 两种来源；
        // Bearer scheme 大小写不敏感（RFC 7235，v0.2.7 修复）。
        const isHealthProbe = method === "GET" && u.pathname === "/api/health";
        if (isApiPath && !isHealthProbe) {
          const auth = req.headers["authorization"];
          const qToken = u.searchParams.get("token");
          let provided = "";
          if (typeof auth === "string") {
            const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
            if (m) provided = `Bearer ${m[1]}`;
          } else if (qToken) {
            provided = `Bearer ${qToken}`;
          }
          if (!safeEqual(provided, `Bearer ${authToken}`)) {
            status = 401;
            logger.warn("http.auth_failed", { method, path: pathForLog });
            json(res, 401, { error: "Unauthorized" }, corsOrigin);
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
        json(res, status, result.body, corsOrigin);
      } catch (e) {
        status = e instanceof MembraneError && e.code.startsWith("E_") ? 400 : 500;
        logger.error("http.error", {
          method,
          path: pathForLog,
          status,
          code: e instanceof MembraneError ? e.code : "E_INTERNAL",
        });
        json(res, status, { error: e instanceof Error ? e.message : String(e) }, corsOrigin);
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
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    console.log(`[membrane] REST + Dashboard 已启动：http://${displayHost}:${actualPort}`);
    console.log(`[membrane] 本机访问（令牌已自动生成并保存，重启不变）：`);
    console.log(`  http://${displayHost}:${actualPort}/?token=${authToken}`);
    console.log(`[membrane] 数据接口一律需要令牌（Bearer 头或 ?token=）；静态控制台免鉴权`);
    if (corsOrigin) console.log(`[membrane] 跨源放行 Origin：${corsOrigin}`);
    console.log(`[membrane] 运维后台：http://${displayHost}:${actualPort}/#ops（日志 ${logger.path ?? "memory only"}）`);
    // 一键启动配套（v0.2.7）：把带令牌的完整控制台地址写到库文件旁（<db>.url），
    // 启动脚本等它出现后直接用这个地址开浏览器——新用户不用再手工复制 ?token=。
    // 文件与数据库同目录，同一个信任边界；写入失败不致命（控制台里仍有完整 URL）。
    if (engine.storage.path !== ":memory:") {
      try {
        writeFileSync(
          `${engine.storage.path}.url`,
          `http://${displayHost}:${actualPort}/?token=${authToken}`,
          "utf8",
        );
      } catch {
        /* best effort */
      }
    }
  });
  // 审查修复（M-5）：端口占用等启动错误给中文提示，不再甩原始堆栈
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[membrane] 端口 ${port} 已被占用。换个端口：set MEMBRANE_PORT=8318 后重试。`);
    } else {
      console.error(`[membrane] 服务错误：${err.message}`);
    }
    process.exitCode = 1;
  });
  return server;
}
