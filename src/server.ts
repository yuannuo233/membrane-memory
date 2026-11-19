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
import { Membrane } from "./engine.js";
import { MembraneError } from "./model.js";
import type { EntityType, MemoryKind, RelationInput } from "./types.js";

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

/** 从请求体解析 kind（非法值当未指定，交给引擎用默认 fact） */
function parseKind(v: unknown): MemoryKind | undefined {
  return v === "fact" || v === "episode" || v === "preference" || v === "procedure" ? v : undefined;
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

/** 从请求体取字符串数组（非字符串项丢弃） */
function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/** GET 的 query 参数是字符串，POST 的是数字——统一取数（非法值返回 undefined） */
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 解析实体类型（非法当未指定） */
function parseEntityType(v: unknown): EntityType | undefined {
  return v === "person" || v === "place" || v === "org" || v === "concept" || v === "unknown"
    ? v
    : undefined;
}

/** 解析手动标注的关系数组（脏项丢弃，不因为一条写错拒掉整条记忆） */
function parseRelations(v: unknown): RelationInput[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RelationInput[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const to = typeof o["to"] === "string" ? o["to"] : "";
    const predicate = typeof o["predicate"] === "string" ? o["predicate"] : "";
    if (!to || !predicate) continue;
    out.push({
      from: typeof o["from"] === "string" ? o["from"] : null,
      fromType: parseEntityType(o["fromType"]),
      to,
      toType: parseEntityType(o["toType"]),
      predicate,
      confidence: num(o["confidence"]),
    });
  }
  return out.length > 0 ? out : undefined;
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
    return { body: { ok: true, service: "membrane-memory", db: engine.storage.path } };
  }
  if (method === "GET" && urlPath === "/api/memories") {
    const validity = typeof body.validity === "string" ? body.validity : "current";
    const kind = parseKind(body.kind);
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const namespace = typeof body.namespace === "string" ? body.namespace : undefined;
    return { body: engine.list({ validity: validity === "all" ? "all" : "current", kind, limit, namespace }) };
  }
  if (method === "POST" && urlPath === "/api/recall") {
    const query = typeof body.query === "string" ? body.query : "";
    if (!query) return { status: 400, body: { error: "query 必填" } };
    const hits = await engine.recallAsync({
      query,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      asOf: typeof body.asOf === "number" ? body.asOf : undefined,
      kind: parseKind(body.kind),
      subject: typeof body.subject === "string" ? body.subject : undefined,
      namespace: typeof body.namespace === "string" ? body.namespace : undefined,
      entities: strList(body.entities),
      hops: typeof body.hops === "number" ? body.hops : undefined,
      noGraph: body.noGraph === true,
    });
    return { body: { results: hits, count: hits.length } };
  }
  if (method === "POST" && urlPath === "/api/memories") {
    const content = typeof body.content === "string" ? body.content : "";
    if (!content) return { status: 400, body: { error: "content 必填" } };
    // 向量既可以直接传（embedding 数组），也可以让服务端调 embedding 端点算（配了 model 时默认算）
    const embedding = Array.isArray(body.embedding) ? body.embedding : undefined;
    const entities = [
      ...(strList(body.entities) ?? []),
    ];
    const relations = parseRelations(body.relations);
    const r = await engine.addAsync(
      {
        content,
        kind: parseKind(body.kind),
        subject: typeof body.subject === "string" ? body.subject : undefined,
        subjectType: parseEntityType(body.subjectType),
        tags: strList(body.tags),
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        pin: body.pin === true,
        evidence: strList(body.evidence),
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        source: typeof body.source === "string" ? body.source : "rest",
        vec: embedding as number[] | undefined,
        entities: entities.length > 0 ? entities : undefined,
        relations,
      },
      { embed: body.embed === false ? false : undefined },
    );
    return { status: 201, body: r };
  }

  // ---- 图检索 ----
  if (method === "GET" && urlPath === "/api/relations") {
    const a = typeof body.a === "string" ? body.a : typeof body.from === "string" ? body.from : "";
    if (!a) return { status: 400, body: { error: "a（或 from）必填" } };
    const b = typeof body.b === "string" ? body.b : typeof body.to === "string" ? body.to : null;
    return {
      body: {
        relations: engine.relations(a, b, {
          asOf: num(body.asOf),
          maxHops: num(body.maxHops),
          limit: num(body.limit),
          namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        }),
      },
    };
  }
  if (method === "POST" && urlPath === "/api/relations") {
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";
    const predicate = typeof body.predicate === "string" ? body.predicate : "";
    if (!from || !to || !predicate) {
      return { status: 400, body: { error: "from / to / predicate 都必填" } };
    }
    const rel = engine.link({
      from,
      fromType: parseEntityType(body.fromType),
      to,
      toType: parseEntityType(body.toType),
      predicate,
      confidence: typeof body.confidence === "number" ? body.confidence : undefined,
      memoryId: typeof body.memoryId === "string" ? body.memoryId : null,
      namespace: typeof body.namespace === "string" ? body.namespace : undefined,
    });
    return { status: 201, body: rel };
  }
  if (method === "GET" && urlPath === "/api/entities") {
    const ns = typeof body.namespace === "string" ? body.namespace : undefined;
    const limit = num(body.limit);
    const memoryId = typeof body.memoryId === "string" ? body.memoryId : undefined;
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
        const body = req.method === "POST" ? await readBody(req) : query;
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
