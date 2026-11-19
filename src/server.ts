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
      body: { ok: true, service: "membrane-memory", version: "0.2.1", db: engine.storage.path },
    };
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
      noGraph: body.noGraph === true,
    });
    const detail = asString(body.detail) ?? "full";
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

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // token 校验（配了才要求）；用常量时间比较，避免时序侧信道
        if (token) {
          const auth = req.headers["authorization"];
          if (typeof auth !== "string" || !safeEqual(auth, `Bearer ${token}`)) {
            json(res, 401, { error: "Unauthorized" });
            return;
          }
        }
        const u = new URL(req.url ?? "/", `http://${host}`);
        const query: Record<string, unknown> = {};
        u.searchParams.forEach((v, k) => (query[k] = v));
        // PATCH/PUT 也带 JSON body；之前只读 POST，导致真实 HTTP 编辑时内容被当成空对象
        const hasBody = req.method === "POST" || req.method === "PATCH" || req.method === "PUT";
        const body = hasBody ? await readBody(req) : query;
        const result = await route(engine, req.method ?? "GET", u.pathname, body, webDir);
        const b = result.body as { __file?: string };
        if (b && typeof b === "object" && "__file" in b) {
          const file = b.__file!;
          const ext = extname(file);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          res.end(readFileSync(file));
          return;
        }
        json(res, result.status ?? 200, result.body);
      } catch (e) {
        const status = e instanceof MembraneError && e.code.startsWith("E_") ? 400 : 500;
        json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  server.listen(port, host, () => {
    console.log(`[membrane] REST + Dashboard 已启动：http://${host}:${port}`);
    console.log(`[membrane] 健康检查：http://${host}:${port}/api/health`);
  });
  return server;
}
