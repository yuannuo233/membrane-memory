/**
 * MCP 协议测试：直接喂 JSON-RPC 报文，验证 initialize / tools/list / tools/call。
 * 不打网络、不起子进程（handleLine 是纯函数式）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { handleLine } from "../src/mcp.js";
import { newTmpDir, rmDir, BASE_TIME } from "./helpers.js";

let dir: string;
let m: Membrane;

beforeEach(() => {
  dir = newTmpDir("mcp");
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => BASE_TIME });
});
afterEach(() => {
  m.close();
  rmDir(dir);
});

async function rpc(line: string): Promise<Record<string, unknown>> {
  const out = await handleLine(m, line);
  expect(out).not.toBeNull();
  return JSON.parse(out!) as Record<string, unknown>;
}

describe("MCP 协议", () => {
  it("initialize 返回 protocolVersion / capabilities / serverInfo", async () => {
    const r = await rpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    );
    expect(r.result).toMatchObject({ protocolVersion: "2024-11-05" });
    const result = r.result as Record<string, unknown>;
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo).toMatchObject({ name: "membrane-memory" });
  });

  it("initialize 登记 clientInfo，tools/call 更新调用统计", async () => {
    const sessionId = "sess-test";
    const init = await handleLine(
      m,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "Claude Desktop", version: "1.2.3" },
        },
      }),
      sessionId,
    );
    expect(init).not.toBeNull();
    let rows = m.storage.listMcpClients();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      clientName: "Claude Desktop",
      clientVersion: "1.2.3",
      protocolVersion: "2025-06-18",
      transport: "stdio",
      calls: 0,
      status: "active",
    });

    await handleLine(
      m,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "membrane_stats", arguments: {} },
      }),
      sessionId,
    );
    rows = m.storage.listMcpClients();
    expect(rows[0]).toMatchObject({ calls: 1, lastTool: "membrane_stats", status: "active" });

    m.storage.closeMcpClient(sessionId);
    expect(m.storage.listMcpClients()[0]!.status).toBe("closed");
  });

  it("ping 返回空 result", async () => {
    expect((await rpc(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }))).result).toEqual({});
  });

  it("tools/list 列出全部 10 个工具且 schema 合法", async () => {
    const r = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    const tools = (r.result as { tools: unknown[] }).tools as {
      name: string;
      inputSchema: { type: string };
    }[];
    expect(tools).toHaveLength(10);
    expect(tools.map((t) => t.name)).toContain("membrane_add");
    expect(tools.map((t) => t.name)).toContain("membrane_recall");
    expect(tools.map((t) => t.name)).toContain("membrane_link");
    expect(tools.map((t) => t.name)).toContain("membrane_relations");
    expect(tools.map((t) => t.name)).toContain("membrane_evidence");
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("tools/call add → recall 全流程（默认精简返回）", async () => {
    const add = await rpc(
      JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "membrane_add", arguments: { content: "用户住在北京", subject: "用户" } },
      }),
    );
    const addText = ((add.result as { content: { text: string }[] }).content[0]!.text);
    expect(addText).toContain("created");

    const recall = await rpc(
      JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "membrane_recall", arguments: { query: "用户住哪" } },
      }),
    );
    const hits = JSON.parse((recall.result as { content: { text: string }[] }).content[0]!.text) as {
      id: string; content: string; score: number;
    }[];
    expect(hits.length).toBeGreaterThan(0);
    // 默认 brief：有 id/内容/分数，但没有 why/breakdown（省 token）
    expect(hits[0]!.content).toContain("北京");
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]).not.toHaveProperty("why");
  });

  it("detail=full 时返回 why 与完整 breakdown", async () => {
    m.add({ content: "用户住在上海", subject: "用户" });
    const recall = await rpc(
      JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "membrane_recall", arguments: { query: "上海", detail: "full" } },
      }),
    );
    const hits = JSON.parse((recall.result as { content: { text: string }[] }).content[0]!.text) as {
      why: string; breakdown: { weights: unknown };
    }[];
    expect(hits[0]!.why).toContain("全文");
    expect(hits[0]!.breakdown.weights).toBeDefined();
  });

  it("detail=ultra 时只返回 id/内容/分数", async () => {
    m.add({ content: "用户喜欢喝茶" });
    const recall = await rpc(
      JSON.stringify({
        jsonrpc: "2.0", id: 8, method: "tools/call",
        params: { name: "membrane_recall", arguments: { query: "喝茶", detail: "ultra" } },
      }),
    );
    const hits = JSON.parse((recall.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>[];
    expect(Object.keys(hits[0]!).sort()).toEqual(["content", "id", "score"]);
  });

  it("tools/call stats 返回库况", async () => {
    m.add({ content: "测试记忆" });
    const r = await rpc(
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "membrane_stats" } }),
    );
    const stats = JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text);
    expect(stats.total).toBe(1);
  });

  it("未知方法返回 JSON-RPC error", async () => {
    const r = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "no/such/method" }));
    expect(r.error).toMatchObject({ code: -32601 });
  });

  it("非法 JSON 行返回 null（不崩溃）", async () => {
    expect(await handleLine(m, "这不是 json")).toBeNull();
  });
});
