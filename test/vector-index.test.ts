/**
 * P2：可选向量索引适配层测试。
 *
 * 用一个内存假索引验证：
 * - 注入后写入/查询能走到适配器；
 * - 适配器返回 [] = 索引可用但没候选（不能偷偷全扫）；
 * - 适配器返回 null = 不可用，回退 LSH/精确全扫；
 * - 适配器自带 id 会被 namespace 过滤，跨命名空间不串；
 * - 重启后从 embeddings 重建索引。
 *
 * 不装 hnswlib-node 也能跑：HnswVectorIndex 的“缺依赖报错”单独断言。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import type { VectorIndex } from "../src/vector-index.js";
import { VectorIndexUnavailableError } from "../src/vector-index.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
const engines: Membrane[] = [];
beforeEach(() => {
  dir = newTmpDir("vector-index");
});
afterEach(() => {
  for (const e of engines.splice(0)) {
    try {
      e.close();
    } catch {
      // 已关闭
    }
  }
  rmDir(dir);
});

class FakeVectorIndex implements VectorIndex {
  readonly name = "fake";
  private readonly vectors = new Map<string, Float32Array>();
  /** null = 模拟适配器不可用；[] = 模拟可用但没候选 */
  mode: "normal" | "null" | "empty" = "normal";
  upserts = 0;
  removes = 0;
  searches = 0;

  upsert(id: string, vec: Float32Array): void {
    this.upserts++;
    this.vectors.set(id, new Float32Array(vec));
  }
  remove(id: string): void {
    this.removes++;
    this.vectors.delete(id);
  }
  search(queryVec: Float32Array, limit: number): string[] | null {
    this.searches++;
    if (this.mode === "null") return null;
    if (this.mode === "empty") return [];
    const scored = [...this.vectors.entries()].map(([id, vec]) => {
      let dot = 0;
      for (let i = 0; i < queryVec.length; i++) dot += (queryVec[i] ?? 0) * (vec[i] ?? 0);
      return { id, dot };
    });
    scored.sort((a, b) => b.dot - a.dot);
    return scored.slice(0, Math.max(1, limit)).map((x) => x.id);
  }
  size(): number {
    return this.vectors.size;
  }
  clear(): void {
    this.vectors.clear();
  }
}

function make(index?: VectorIndex, db = `${dir}/m.db`): Membrane {
  const m = new Membrane({ dbPath: db, now: () => BASE_TIME, vectorIndex: index });
  engines.push(m);
  return m;
}

describe("可选向量索引", () => {
  it("注入后写入走适配器，查询能命中", () => {
    const idx = new FakeVectorIndex();
    const m = make(idx);
    m.add({ content: "alpha", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    expect(idx.size()).toBe(1);
    expect(idx.upserts).toBe(1);

    const hits = m.recall({ query: "zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.memory.content).toBe("alpha");
    expect(idx.searches).toBeGreaterThan(0);
    m.close();
  });

  it("适配器返回 []：当作可用但没候选，不偷偷全扫", () => {
    const idx = new FakeVectorIndex();
    const m = make(idx);
    m.add({ content: "alpha", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    idx.mode = "empty";
    const hits = m.recall({ query: "zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits).toEqual([]);
    m.close();
  });

  it("适配器返回 null：回退 LSH/精确全扫仍能命中", () => {
    const idx = new FakeVectorIndex();
    const m = make(idx);
    m.add({ content: "alpha", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    idx.mode = "null";
    const hits = m.recall({ query: "zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits.some((h) => h.memory.content === "alpha")).toBe(true);
    m.close();
  });

  it("适配器返回别的命名空间的 id 会被过滤掉", () => {
    const idx = new FakeVectorIndex();
    const m = make(idx);
    m.add({ content: "alpha", subject: "用户", namespace: "a", vec: new Float32Array([1, 0, 0]) });
    m.add({ content: "alpha", subject: "用户", namespace: "b", vec: new Float32Array([1, 0, 0]) });
    expect(idx.size()).toBe(2);
    const hits = m.recall({ query: "zzzz", namespace: "a", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits.every((h) => h.memory.namespace === "a")).toBe(true);
    m.close();
  });

  it("重启后从 embeddings 重建索引（不依赖旧进程内存）", () => {
    const first = make(undefined);
    first.add({ content: "alpha", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    first.close();

    const idx = new FakeVectorIndex();
    const second = make(idx);
    const hits = second.recall({ query: "zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits.some((h) => h.memory.content === "alpha")).toBe(true);
    expect(idx.size()).toBe(1);
    second.close();
  });

  it("删除记忆时同步删适配器里的向量", () => {
    const idx = new FakeVectorIndex();
    const m = make(idx);
    const a = m.add({ content: "alpha", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    m.forget(a.memory.id);
    expect(idx.size()).toBe(0);
    expect(idx.removes).toBe(1);
    m.close();
  });

  it("缺可选包时 HnswVectorIndex 抛 E_VECTOR_INDEX_UNAVAILABLE（不会静默降级）", async () => {
    const mod = await import("../src/vector-index-hnsw.js");
    let threw: unknown;
    try {
      new mod.HnswVectorIndex({ dim: 3, maxElements: 10 });
    } catch (e) {
      threw = e;
    }
    // 开发机默认没装这个可选包；装了的话这条测试会失败并提醒改成显式注入
    expect(threw).toBeInstanceOf(VectorIndexUnavailableError);
    expect((threw as Error).message).toContain("hnswlib-node");
  });

  it("缺 vec0 扩展时 SqliteVecVectorIndex 抛 E_VECTOR_INDEX_UNAVAILABLE", async () => {
    const mod = await import("../src/vector-index-sqlite-vec.js");
    let threw: unknown;
    try {
      new mod.SqliteVecVectorIndex({ dim: 3 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(VectorIndexUnavailableError);
    expect((threw as Error).message).toContain("sqlite-vec");
  });
});
