/**
 * 多任务记忆隔离测试。
 *
 * 回答用户的问题：一个 Agent 同时跑多个任务，记忆会不会串？
 * - 同 namespace：会（两条任务事实都进入候选）；
 * - 分 namespace：不会（硬过滤，泄漏 0）。
 */
import { describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { probeTaskIsolation } from "../src/isolation.js";

describe("多任务记忆隔离", () => {
  it("探针：同 namespace 混召回，独立 namespace 串扰 0", () => {
    const r = probeTaskIsolation();
    expect(r.sharedNamespace.hits).toBeGreaterThanOrEqual(2);
    expect(r.sharedNamespace.mixed).toBe(true);
    expect(r.sharedNamespace.tasks).toEqual(expect.arrayContaining(["任务A", "任务B"]));
    expect(r.separatedNamespaces.leakage).toBe(0);
    expect(r.separatedNamespaces.pass).toBe(true);
    expect(r.separatedNamespaces.taskA.tasks).toEqual(["任务A"]);
    expect(r.separatedNamespaces.taskB.tasks).toEqual(["任务B"]);
  });

  it("真实引擎：同 namespace 两条都召回；分 namespace 后各查各的", () => {
    const m = new Membrane({ dbPath: ":memory:" });
    try {
      m.add({ content: "任务A 的数据库使用 PostgreSQL", subject: "任务A", namespace: "same" });
      m.add({ content: "任务B 的数据库使用 MySQL", subject: "任务B", namespace: "same" });
      const mixed = m.recall({ query: "数据库", namespace: "same", limit: 5 });
      expect(mixed.map((h) => h.memory.subject)).toEqual(expect.arrayContaining(["任务A", "任务B"]));

      m.add({ content: "任务A 的数据库使用 PostgreSQL", subject: "任务A", namespace: "task-a" });
      m.add({ content: "任务B 的数据库使用 MySQL", subject: "任务B", namespace: "task-b" });
      const a = m.recall({ query: "数据库", namespace: "task-a", limit: 5 });
      const b = m.recall({ query: "数据库", namespace: "task-b", limit: 5 });
      expect(a.every((h) => h.memory.subject === "任务A")).toBe(true);
      expect(b.every((h) => h.memory.subject === "任务B")).toBe(true);
      expect(a.some((h) => h.memory.subject === "任务B")).toBe(false);
    } finally {
      m.close();
    }
  });
});
