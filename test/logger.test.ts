/**
 * 日志底座测试：ring 上限、落盘、脱敏、级别过滤。
 * 这些性质决定"后台能不能给懂的人看，又不泄露记忆正文"。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryLogger } from "../src/logger.js";

function tmpLog(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "membrane-log-"));
  return { path: join(dir, "membrane.log"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("MemoryLogger", () => {
  it("ring 只保留上限条，并统计丢弃数", () => {
    const log = new MemoryLogger({ maxEntries: 10 });
    for (let i = 0; i < 14; i++) log.info("tick", { i });
    const tail = log.tail(20);
    expect(tail).toHaveLength(10);
    expect(tail[0]!.i).toBe(4);
    expect(log.stats()).toMatchObject({ buffered: 10, dropped: 4, path: null });
  });

  it("拒绝写入正文/查询/证据/token 等敏感字段", () => {
    const log = new MemoryLogger();
    log.info("ingest", {
      content: "用户密码是 hunter2",
      query: "密码",
      body: { content: "x" },
      evidence: "原文",
      quote: "原句",
      memory: "整条",
      prompt: "提示词",
      authorization: "Bearer secret",
      apiKey: "sk-secret",
      token: "secret",
      subject: "用户", // 允许的元数据
      nested: { content: "藏在对象里" },
    });
    const entry = log.tail(1)[0]!;
    expect(entry.subject).toBe("用户");
    expect(entry.event).toBe("ingest");
    for (const k of ["content", "query", "body", "evidence", "quote", "memory", "prompt", "authorization", "apiKey", "token"]) {
      expect(entry).not.toHaveProperty(k);
    }
    // 嵌套对象不展开，避免对象里夹带正文
    expect(entry.nested).toBe("[object]");
  });

  it("JSONL 落盘，一行一个事件；超长字符串截断", () => {
    const t = tmpLog();
    try {
      const log = new MemoryLogger({ path: t.path });
      log.info("server.start", { port: 8317 });
      log.warn("http.auth_failed", { method: "GET", path: "/api/stats", reason: "x".repeat(700) });
      const lines = readFileSync(t.path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as { event: string; port: number };
      expect(first).toMatchObject({ event: "server.start", port: 8317 });
      const second = JSON.parse(lines[1]!) as { reason: string };
      expect(second.reason.length).toBeLessThanOrEqual(501);
      expect(log.stats()).toMatchObject({ written: 2, fileError: null });
    } finally {
      t.cleanup();
    }
  });

  it("minLevel 与 tail(level) 双重过滤", () => {
    const log = new MemoryLogger({ minLevel: "warn" });
    log.info("too.noisy");
    log.warn("careful");
    log.error("broken", { code: "E_TEST" });
    expect(log.tail(10)).toHaveLength(2);
    expect(log.tail(10, "error")).toHaveLength(1);
    expect(log.tail(10, "error")[0]!.event).toBe("broken");
  });
});
