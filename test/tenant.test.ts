/**
 * 多租户隔离测试：namespace 隔离写入、召回、列表、取代、统计。
 * 核心断言：不同命名空间互不可见，取代链不会跨命名空间误伤。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { normalizeNamespace, DEFAULT_NAMESPACE, ValidationError } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
let m: Membrane;

beforeEach(() => {
  dir = newTmpDir("tenant");
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => BASE_TIME });
});
afterEach(() => {
  m.close();
  rmDir(dir);
});

describe("normalizeNamespace", () => {
  it("空/undefined → default", () => {
    expect(normalizeNamespace(undefined)).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace("")).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace("   ")).toBe(DEFAULT_NAMESPACE);
  });
  it("合法名保留", () => {
    expect(normalizeNamespace("user_a-1")).toBe("user_a-1");
  });
  it("非法字符抛 E_NAMESPACE", () => {
    expect(() => normalizeNamespace("坏名字!")).toThrow(ValidationError);
    expect(() => normalizeNamespace("a/b")).toThrow();
  });
  it("超长抛错", () => {
    expect(() => normalizeNamespace("x".repeat(200))).toThrow();
  });
});

describe("命名空间隔离", () => {
  it("同内容不同命名空间可共存（不判重）", () => {
    const a = m.add({ content: "用户住在北京", namespace: "alice" });
    const b = m.add({ content: "用户住在北京", namespace: "bob" });
    expect(a.status).toBe("created");
    expect(b.status).toBe("created"); // 不是 duplicate
    expect(a.memory.id).not.toBe(b.memory.id);
  });

  it("召回只看自己的命名空间", () => {
    m.add({ content: "alice 的秘密是蓝色", namespace: "alice" });
    m.add({ content: "bob 的秘密是红色", namespace: "bob" });
    const aliceHits = m.recall({ query: "秘密", namespace: "alice" });
    const bobHits = m.recall({ query: "秘密", namespace: "bob" });
    expect(aliceHits.every((h) => h.memory.namespace === "alice")).toBe(true);
    expect(bobHits.every((h) => h.memory.namespace === "bob")).toBe(true);
    expect(aliceHits.some((h) => h.memory.content.includes("红色"))).toBe(false);
  });

  it("模糊召回也不跨命名空间", () => {
    m.add({ content: "alice 养了一只猫", namespace: "alice" });
    m.add({ content: "bob 养了一只狗", namespace: "bob" });
    const hits = m.recall({ query: "养猫", namespace: "alice" });
    expect(hits.every((h) => h.memory.namespace === "alice")).toBe(true);
  });

  it("取代链不跨命名空间误伤", () => {
    m.add({ content: "用户住在北京", namespace: "alice" });
    // bob 写相似记忆，不应取代 alice 的
    const r = m.add({ content: "用户住在上海", namespace: "bob" });
    expect(r.superseded).toHaveLength(0);
    // alice 的记忆仍现行有效
    const aliceCurrent = m.list({ namespace: "alice" });
    expect(aliceCurrent).toHaveLength(1);
    expect(aliceCurrent[0]!.content).toContain("北京");
  });

  it("list 按命名空间过滤", () => {
    m.add({ content: "A 的记忆", namespace: "a" });
    m.add({ content: "B 的记忆", namespace: "b" });
    expect(m.list({ namespace: "a" })).toHaveLength(1);
    expect(m.list({ namespace: "b" })).toHaveLength(1);
    expect(m.list({ namespace: "c" })).toHaveLength(0);
  });

  it("不传 namespace 时默认走 default，看不到其他租户", () => {
    m.add({ content: "默认租户记忆" });
    m.add({ content: "别的租户记忆", namespace: "other" });
    const hits = m.recall({ query: "记忆" });
    expect(hits.every((h) => h.memory.namespace === DEFAULT_NAMESPACE)).toBe(true);
    expect(hits).toHaveLength(1);
  });
});
