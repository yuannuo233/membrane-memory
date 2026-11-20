/**
 * 可选 sqlite-vec 适配器（P2）——默认不装、不引依赖。
 *
 * 两种接法（都要求用户自己提供扩展，不把二进制塞进 Membrane）：
 *   1) npm install sqlite-vec，构造时自动 require 并 load；
 *   2) 传 extensionPath 指向 vec0 动态库（.dll/.so/.dylib）。
 *
 * 索引放在独立的内存 SQLite 里，不碰主库；重启后由 Storage 从 embeddings 重建。
 * 这样 sqlite-vec 扩展崩了也污染不到主数据文件。
 */
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import type { VectorIndex } from "./vector-index.js";
import { VectorIndexUnavailableError } from "./vector-index.js";

export interface SqliteVecVectorIndexOptions {
  dim: number;
  /** vec0 扩展路径；不传则尝试 npm 包 sqlite-vec */
  extensionPath?: string;
}

interface SqliteVecPackage {
  load(db: DatabaseSync): void;
}

function loadExtension(db: DatabaseSync, extensionPath?: string): void {
  db.enableLoadExtension(true);
  if (extensionPath) {
    db.loadExtension(extensionPath);
  } else {
    const require = createRequire(import.meta.url);
    let mod: SqliteVecPackage;
    try {
      mod = require("sqlite-vec") as SqliteVecPackage;
    } catch {
      throw new VectorIndexUnavailableError(
        "sqlite-vec 适配器需要 npm install sqlite-vec，或用 extensionPath 指定 vec0 动态库（不装不影响默认 LSH）",
      );
    }
    mod.load(db);
  }
  // 加载完立刻关掉，减少后续误加载面
  db.enableLoadExtension(false);
}

export class SqliteVecVectorIndex implements VectorIndex {
  readonly name = "sqlite-vec";
  private readonly db: DatabaseSync;
  private readonly dim: number;
  private readonly idToRowid = new Map<string, number>();
  private readonly rowidToId = new Map<number, string>();
  private nextRowid = 1;

  constructor(opts: SqliteVecVectorIndexOptions) {
    if (!Number.isInteger(opts.dim) || opts.dim <= 0) throw new Error("SqliteVecVectorIndex dim 必须是正整数");
    this.dim = opts.dim;
    this.db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      loadExtension(this.db, opts.extensionPath);
      this.db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding FLOAT[${this.dim}])`);
    } catch (e) {
      this.db.close();
      if (e instanceof VectorIndexUnavailableError) throw e;
      throw new VectorIndexUnavailableError(`sqlite-vec 加载失败：${(e as Error).message}`);
    }
  }

  upsert(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) throw new Error(`sqlite-vec 维度不一致：期望 ${this.dim}，收到 ${vec.length}`);
    const old = this.idToRowid.get(id);
    if (old !== undefined) {
      this.db.prepare(`DELETE FROM vec_items WHERE rowid = ?`).run(old);
      this.rowidToId.delete(old);
    }
    const rowid = this.nextRowid++;
    this.db
      .prepare(`INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)`)
      .run(rowid, JSON.stringify(Array.from(vec)));
    this.idToRowid.set(id, rowid);
    this.rowidToId.set(rowid, id);
  }

  remove(id: string): void {
    const rowid = this.idToRowid.get(id);
    if (rowid === undefined) return;
    this.db.prepare(`DELETE FROM vec_items WHERE rowid = ?`).run(rowid);
    this.idToRowid.delete(id);
    this.rowidToId.delete(rowid);
  }

  search(queryVec: Float32Array, limit: number): string[] | null {
    if (queryVec.length !== this.dim) return null;
    if (this.idToRowid.size === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT rowid FROM vec_items
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(JSON.stringify(Array.from(queryVec)), Math.max(1, limit)) as { rowid: number }[];
    const out: string[] = [];
    for (const row of rows) {
      const id = this.rowidToId.get(Number(row.rowid));
      if (id) out.push(id);
    }
    return out;
  }

  size(): number {
    return this.idToRowid.size;
  }

  clear(): void {
    this.db.exec(`DELETE FROM vec_items`);
    this.idToRowid.clear();
    this.rowidToId.clear();
    this.nextRowid = 1;
  }

  close(): void {
    this.db.close();
  }
}
