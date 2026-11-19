/**
 * REST + Dashboard 路由测试：直接测 route()（不起真端口不打网络）。
 * 覆盖 health/stats/memories CRUD/recall/审计链/mem0 兼容路径/静态资源/路径穿越防护。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { route, startServer } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { MemoryLogger } from "../src/logger.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

let dir: string;
let m: Membrane;
let webDir: string;

beforeEach(() => {
  dir = newTmpDir("server");
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => BASE_TIME });
  webDir = dir;
  writeFileSync(join(webDir, "index.html"), "<html>Membrane</html>");
});
afterEach(() => {
  m.close();
  rmDir(dir);
});

async function r(method: string, path: string, body: Record<string, unknown> = {}) {
  return route(m, method, path, body, webDir);
}

describe("REST API", () => {
  it("health 返回服务信息", async () => {
    const res = await r("GET", "/api/health");
    expect(res.body).toMatchObject({ ok: true, service: "membrane-memory", version: VERSION });
  });

  it("空库 stats 全 0", async () => {
    const res = await r("GET", "/api/stats");
    expect(res.body).toMatchObject({ total: 0, current: 0 });
  });

  it("admin diagnostics 暴露运行状态，但不泄露 apiKey", async () => {
    const logger = new MemoryLogger({ maxEntries: 20 });
    const res = await route(m, "GET", "/api/admin/diagnostics", {}, webDir, {
      logger,
      startedAt: Date.now() - 5000,
      host: "127.0.0.1",
      port: 8317,
      tokenConfigured: true,
      version: "0.2.2",
    });
    const body = res.body as {
      db: { schemaVersion: number };
      capabilities: Record<string, unknown>;
      security: Record<string, unknown>;
      logging: { maxEntries: number };
      uptimeMs: number;
    };
    expect(body.db.schemaVersion).toBe(2);
    expect(body.uptimeMs).toBeGreaterThan(0);
    expect(body.security.tokenConfigured).toBe(true);
    expect(body.logging.maxEntries).toBe(20);
    expect(body.capabilities).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("admin logs 返回 ring 内容，且不返回正文/查询", async () => {
    const logger = new MemoryLogger();
    logger.info("test.event", { content: "不能出现的正文", query: "不能出现的查询", path: "/api/recall" });
    const res = await route(m, "GET", "/api/admin/logs", { limit: "10" }, webDir, { logger });
    const body = res.body as { entries: { event: string; path: string }[]; count: number };
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({ event: "test.event", path: "/api/recall" });
    expect(JSON.stringify(body)).not.toContain("不能出现");
  });

  it("admin mcp-clients 返回接入登记，且不泄露正文", async () => {
    m.storage.recordMcpClient({
      sessionId: "sess-server-test",
      clientName: "Cursor",
      clientVersion: "0.48",
      protocolVersion: "2024-11-05",
      pid: process.pid,
      cwd: "E:/tmp/project",
    });
    m.storage.touchMcpClient("sess-server-test", "membrane_recall");
    const res = await route(m, "GET", "/api/admin/mcp-clients", { limit: "10" }, webDir);
    const body = res.body as {
      clients: Array<{ clientName: string; calls: number; lastTool: string; state: string }>;
      total: number;
      active: number;
    };
    expect(body.total).toBe(1);
    expect(body.active).toBe(1);
    expect(body.clients[0]).toMatchObject({
      clientName: "Cursor",
      calls: 1,
      lastTool: "membrane_recall",
      state: "active",
    });
    expect(JSON.stringify(body)).not.toContain("用户住在北京");
  });

  it("admin isolation-check 当场证明跨 namespace 不串", async () => {
    const res = await r("GET", "/api/admin/isolation-check");
    const body = res.body as {
      sharedNamespace: { mixed: boolean };
      separatedNamespaces: { leakage: number; pass: boolean };
    };
    expect(body.sharedNamespace.mixed).toBe(true);
    expect(body.separatedNamespaces.leakage).toBe(0);
    expect(body.separatedNamespaces.pass).toBe(true);
  });

  it("POST memories 写入 → GET 取回 → recall 命中", async () => {
    const add = await r("POST", "/api/memories", { content: "用户住在北京", subject: "用户", kind: "fact" });
    expect(add.status).toBe(201);
    const id = (add.body as { memory: { id: string } }).memory.id;

    const got = await r("GET", `/api/memories/${id}`);
    expect((got.body as { content: string }).content).toBe("用户住在北京");

    const rc = await r("POST", "/api/recall", { query: "用户住哪" });
    expect((rc.body as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it("缺 content 返回 400", async () => {
    expect((await r("POST", "/api/memories", {})).status).toBe(400);
  });

  it("GET /api/memories 的 limit 对 query 字符串生效（回归：以前 typeof number 判断永远失效）", async () => {
    await r("POST", "/api/memories", { content: "第一条记忆" });
    await r("POST", "/api/memories", { content: "第二条记忆" });
    const res = await r("GET", "/api/memories", { limit: "1" });
    expect((res.body as unknown[]).length).toBe(1);
    // mem0 兼容路径复用同一处理，一起生效
    const v1 = await r("GET", "/v1/memories", { limit: "1" });
    expect((v1.body as unknown[]).length).toBe(1);
  });

  it("POST /api/recall 支持 kinds 与 detail=brief", async () => {
    await r("POST", "/api/memories", { content: "用户喜欢喝绿茶", subject: "用户", kind: "preference" });
    await r("POST", "/api/memories", { content: "用户住在北京", subject: "用户", kind: "fact" });
    const res = await r("POST", "/api/recall", { query: "用户", kinds: ["preference"], detail: "brief" });
    const results = (res.body as { results: Record<string, unknown>[] }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((x) => x["kind"] === "preference")).toBe(true);
    expect(results.every((x) => !("breakdown" in x))).toBe(true); // brief 不带分数明细
  });

  it("POST /api/memories 接受 {name,type} 实体对象（与 MCP/SDK 对齐）", async () => {
    const add = await r("POST", "/api/memories", {
      content: "张三是李四的同学",
      subject: "张三",
      entities: [{ name: "李四", type: "person" }],
    });
    const id = (add.body as { memory: { id: string } }).memory.id;
    const ents = await r("GET", "/api/entities", { memoryId: id });
    const list = (ents.body as { entities: { name: string; type: string }[] }).entities;
    const li = list.find((e) => e.name === "李四");
    expect(li).toBeDefined();
    expect(li!.type).toBe("person");
  });

  it("PATCH 编辑记忆：返回新版本，旧版本被取代", async () => {
    const add = await r("POST", "/api/memories", { content: "用户住在北京", subject: "用户" });
    const oldId = (add.body as { memory: { id: string } }).memory.id;
    const edit = await r("PATCH", `/api/memories/${oldId}`, { content: "用户住在上海" });
    const body = edit.body as { status: string; memory: { id: string; content: string }; superseded: { id: string }[] };
    expect(edit.status).toBe(200);
    expect(body.status).toBe("created");
    expect(body.memory.content).toBe("用户住在上海");
    expect(body.superseded[0]!.id).toBe(oldId);
    const old = await r("GET", `/api/memories/${oldId}`);
    expect((old.body as { validTo: number | null }).validTo).not.toBeNull();
  });

  it("DELETE 遗忘记忆（REST 语义便捷版）", async () => {
    const add = await r("POST", "/api/memories", { content: "要删除的记忆" });
    const id = (add.body as { memory: { id: string } }).memory.id;
    const del = await r("DELETE", `/api/memories/${id}`);
    expect(del.status).toBe(200);
    const got = await r("GET", `/api/memories/${id}`);
    expect((got.body as { deleted: boolean }).deleted).toBe(true);
  });

  it("GET /api/export 导出完整备份（含记忆与实体）", async () => {
    await r("POST", "/api/memories", { content: "用户住在北京", subject: "用户" });
    const res = await r("GET", "/api/export");
    const bundle = res.body as { format: string; memories: unknown[]; entities: unknown[] };
    expect(bundle.format).toBe("membrane-backup");
    expect(bundle.memories.length).toBeGreaterThan(0);
    expect(bundle.entities.length).toBeGreaterThan(0);
  });

  it("真实 HTTP PATCH 能读到 JSON body（防回归：只读 POST 的坑）", async () => {
    const add = await r("POST", "/api/memories", { content: "用户住在北京", subject: "用户" });
    const oldId = (add.body as { memory: { id: string } }).memory.id;
    const srv = startServer(m, { port: 0, webDir });
    await once(srv, "listening");
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/memories/${oldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "用户住在上海（HTTP）" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; memory: { content: string } };
      expect(body.status).toBe("created");
      expect(body.memory.content).toContain("上海");
    } finally {
      srv.close();
    }
  });

  it("配 token 后静态控制台仍能打开，API 仍受保护", async () => {
    const srv = startServer(m, { port: 0, webDir, token: "secret-token" });
    await once(srv, "listening");
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // 浏览器地址栏不可能带 Authorization：静态页必须免鉴权
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Membrane");

      // 数据接口无 token → 401
      const denied = await fetch(`${base}/api/health`);
      expect(denied.status).toBe(401);

      // Bearer 头与 ?token= 两种方式都放行
      const byHeader = await fetch(`${base}/api/health`, {
        headers: { Authorization: "Bearer secret-token" },
      });
      expect(byHeader.status).toBe(200);
      const byQuery = await fetch(`${base}/api/health?token=secret-token`);
      expect(byQuery.status).toBe(200);

      // CORS 预检不需要 token
      const preflight = await fetch(`${base}/api/memories`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    } finally {
      srv.close();
    }
  });

  it("REST recall 默认 brief（不返回 why，和 MCP/README 口径一致）", async () => {
    await r("POST", "/api/memories", { content: "用户喜欢喝龙井", subject: "用户" });
    const res = await r("POST", "/api/recall", { query: "用户喝什么" });
    const results = (res.body as { results: Record<string, unknown>[] }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).not.toHaveProperty("why");
    expect(results[0]).toHaveProperty("content");
  });

  it("审计链端点返回 add 记录", async () => {
    const add = await r("POST", "/api/memories", { content: "测试记忆" });
    const id = (add.body as { memory: { id: string } }).memory.id;
    const hist = await r("GET", `/api/memories/${id}/history`);
    expect((hist.body as { op: string }[])[0]!.op).toBe("add");
  });

  it("证据端点返回 supporting quotes", async () => {
    const add = await r("POST", "/api/memories", {
      content: "带证据的记忆",
      evidence: ["原文引用一", "原文引用二"],
    });
    const id = (add.body as { memory: { id: string } }).memory.id;
    const ev = await r("GET", `/api/memories/${id}/evidence`);
    expect((ev.body as { quote: string }[]).length).toBe(2);
  });

  it("mem0 兼容路径 /v1/memories 与 /v1/memories/search 可用", async () => {
    const add = await r("POST", "/v1/memories/", { content: "兼容路径测试" });
    expect(add.status).toBe(201);
    const rc = await r("POST", "/v1/memories/search", { query: "兼容" });
    expect((rc.body as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it("forget 端点软删除", async () => {
    const add = await r("POST", "/api/memories", { content: "要忘掉的记忆" });
    const id = (add.body as { memory: { id: string } }).memory.id;
    await r("POST", `/api/memories/${id}/forget`);
    const stats = await r("GET", "/api/stats");
    expect((stats.body as { deleted: number }).deleted).toBe(1);
  });
});

describe("Dashboard 静态资源", () => {
  it("根路径返回 index.html 文件标记", async () => {
    const res = await r("GET", "/");
    expect(res.status).toBe(200);
    expect((res.body as { __file?: string }).__file).toBeTruthy();
  });

  it("路径穿越被拒绝（403）", async () => {
    const res = await r("GET", "/assets/../../../secret.txt");
    expect(res.status).toBe(403);
  });

  it("未知 API 返回 404", async () => {
    expect((await r("GET", "/api/no-such-route")).status).toBe(404);
  });
});
