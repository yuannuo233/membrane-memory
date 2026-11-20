/**
 * 可选向量索引适配层（P2）。
 *
 * 默认不装：Membrane 仍然用内置的零依赖 LSH 桶索引。
 * 需要 HNSW / sqlite-vec 的用户，可以注入一个实现了本接口的对象；
 * 索引失败/不可用必须返回 null，让引擎回退 LSH，而不是悄悄返回空结果。
 *
 * 设计边界：
 * - 适配器只负责"给候选 id"；最终余弦排序仍由引擎做，避免近似分数污染 RRF。
 * - 适配器抛错只影响本次查询，不影响写入（写入路径会 catch）。
 */
export interface VectorIndex {
  /** 适配器名字，用于诊断/日志 */
  readonly name: string;
  /** 写入/更新一条向量（幂等：同 id 覆盖） */
  upsert(id: string, vec: Float32Array): void;
  /** 删除一条向量（不存在则忽略） */
  remove(id: string): void;
  /**
   * 返回候选 id；`null` = 本适配器不可用/没建好，调用方应回退 LSH。
   * `[]` = 可用但没有候选，调用方应返回空结果（不要回退全扫）。
   */
  search(queryVec: Float32Array, limit: number): string[] | null;
  /** 当前索引里的有效条数（诊断用） */
  size(): number;
  /** 清空索引（重建前用；可选） */
  clear?(): void;
  /** 释放资源（可选） */
  close?(): void;
}

/** 适配器构造失败时抛这个错误（例如可选包没装） */
export class VectorIndexUnavailableError extends Error {
  readonly code = "E_VECTOR_INDEX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "VectorIndexUnavailableError";
  }
}
