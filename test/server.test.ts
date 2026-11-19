/**
 * REST + Dashboard 路由测试：直接测 route()（不起真端口不打网络）。
 * 覆盖 health/stats/memories CRUD/recall/审计链/mem0 兼容路径/静态资源/路径穿越防护。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { route } from "../src/server.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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
    expect(res.body).toMatchObject({ ok: true, service: "membrane-memory" });
  });

  it("空库 stats 全 0", async () => {
    const res = await r("GET", "/api/stats");
    expect(res.body).toMatchObject({ total: 0, current: 0 });
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
