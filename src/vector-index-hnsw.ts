/**
 * 可选 HNSW 适配器（P2）——默认不装、不引依赖。
 *
 * 用法（用户自己安装可选包，Membrane 核心不把它写进 dependencies）：
 *   npm install hnswlib-node
 *   import { HnswVectorIndex } from "membrane-memory";
 *   const vi = new HnswVectorIndex({ dim: 1536, maxElements: 100_000 });
 *   const m = new Membrane({ vectorIndex: vi });
 *
 * 设计取舍：
 * - 只在显式构造时 require 可选包；没装会抛 E_VECTOR_INDEX_UNAVAILABLE，
 *   不会影响默认 LSH 路径。
 * - 适配器只返回候选 id，最终余弦排序仍由 engine 做；这样近似索引不会篡改 RRF 分数。
 * - 删除用 markDelete；大量删除后建议重建（HNSW 的 tombstone 会占内存）。
 */
import { createRequire } from "node:module";
import type { VectorIndex } from "./vector-index.js";
import { VectorIndexUnavailableError } from "./vector-index.js";

interface HnswIndexLike {
  initIndex(maxElements: number, m?: number, efConstruction?: number): void;
  addPoint(point: number[] | Float32Array, label: number): void;
  markDelete(label: number): void;
  searchKnn(point: number[] | Float32Array, k: number): { neighbors: number[]; distances: number[] };
  resizeIndex(maxElements: number): void;
  getCurrentCount(): number;
}

interface HnswLibLike {
  HierarchicalNSW: new (space: string, dim: number) => HnswIndexLike;
}

export interface HnswVectorIndexOptions {
  dim: number;
  /** 初始容量；满了会自动 resize（默认 100k） */
  maxElements?: number;
  /** HNSW M 参数，默认 16 */
  m?: number;
  /** 构建时候选列表，默认 200 */
  efConstruction?: number;
  /** 查询时候选列表；当前 hnswlib-node API 不直接暴露，保留给未来适配 */
  efSearch?: number;
}

function loadHnsw(): HnswLibLike {
  const require = createRequire(import.meta.url);
  for (const name of ["hnswlib-node", "@blocklet/hnswlib-node"]) {
    try {
      return require(name) as HnswLibLike;
    } catch {
      // 继续试下一个包名
    }
  }
  throw new VectorIndexUnavailableError(
    "HNSW 适配器需要可选依赖 hnswlib-node；请先 npm install hnswlib-node（不装不影响默认 LSH）",
  );
}

export class HnswVectorIndex implements VectorIndex {
  readonly name = "hnsw";
  private readonly index: HnswIndexLike;
  private readonly dim: number;
  private readonly m: number;
  private readonly efConstruction: number;
  private maxElements: number;
  private nextLabel = 0;
  private readonly idToLabel = new Map<string, number>();
  private readonly labelToId = new Map<number, string>();
  private readonly deletedLabels = new Set<number>();

  constructor(opts: HnswVectorIndexOptions) {
    if (!Number.isInteger(opts.dim) || opts.dim <= 0) throw new Error("HnswVectorIndex dim 必须是正整数");
    this.dim = opts.dim;
    this.maxElements = Math.max(1, opts.maxElements ?? 100_000);
    this.m = Math.max(2, opts.m ?? 16);
    this.efConstruction = Math.max(4, opts.efConstruction ?? 200);
    const lib = loadHnsw();
    this.index = new lib.HierarchicalNSW("cosine", this.dim);
    this.index.initIndex(this.maxElements, this.m, this.efConstruction);
  }

  upsert(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) throw new Error(`HNSW 维度不一致：期望 ${this.dim}，收到 ${vec.length}`);
    const old = this.idToLabel.get(id);
    if (old !== undefined) {
      this.index.markDelete(old);
      this.deletedLabels.add(old);
    }
    // 容量检查：hnswlib 的 label 需要从 0 递增；满了先扩容
    if (this.nextLabel >= this.maxElements) {
      this.maxElements = Math.max(this.maxElements * 2, this.nextLabel + 1);
      this.index.resizeIndex(this.maxElements);
    }
    const label = this.nextLabel++;
    this.index.addPoint(Array.from(vec), label);
    this.idToLabel.set(id, label);
    this.labelToId.set(label, id);
  }

  remove(id: string): void {
    const label = this.idToLabel.get(id);
    if (label === undefined) return;
    this.index.markDelete(label);
    this.idToLabel.delete(id);
    this.labelToId.delete(label);
    this.deletedLabels.add(label);
  }

  search(queryVec: Float32Array, limit: number): string[] | null {
    if (queryVec.length !== this.dim) return null;
    const count = this.size();
    if (count === 0) return [];
    const k = Math.min(Math.max(1, limit), count);
    const result = this.index.searchKnn(Array.from(queryVec), k);
    const out: string[] = [];
    for (const label of result.neighbors) {
      if (label < 0 || this.deletedLabels.has(label)) continue;
      const id = this.labelToId.get(label);
      if (id) out.push(id);
    }
    return out;
  }

  size(): number {
    return this.idToLabel.size;
  }

  clear(): void {
    // 直接重建一个空索引，避免 hnswlib 没有 clear API 的兼容问题
    const lib = loadHnsw();
    const fresh = new lib.HierarchicalNSW("cosine", this.dim);
    fresh.initIndex(this.maxElements, this.m, this.efConstruction);
    (this as unknown as { index: HnswIndexLike }).index = fresh;
    this.nextLabel = 0;
    this.idToLabel.clear();
    this.labelToId.clear();
    this.deletedLabels.clear();
  }

  close(): void {
    // hnswlib-node 没有显式 close；交给 GC
  }
}
