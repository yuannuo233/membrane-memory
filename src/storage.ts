/**
 * 存储层 Storage（DESIGN.md 第 2/3 节）。
 *
 * 选型：Node 内置 `node:sqlite`（DatabaseSync），零原生依赖——决策与理由见
 * DESIGN.md 第 10 节。同步 API，单进程内串行写，天然规避并发写竞态；
 * 多进程场景由 SQLite 文件锁 + WAL 兜底。
 *
 * 表结构：memories / memory_fts(FTS5) / embeddings / history / settings。
 * FTS 索引列存的是"正文 bigram 分词后的 token 串"（中文检索需要，见 src/tokenize.ts），
 * rowid 与 memories.rowid 对齐，由本类统一维护增删改。
 *
 * 参数绑定：所有 SQL 一律走预编译语句 + `?` 占位符，禁止字符串拼接用户输入
 * （FTS 注入无害化的第二道防线；MATCH 表达式本身另经 tokenize 白名单化）。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { rowToRecord, toRecords, type Row } from "./model.js";
import { MembraneError } from "./model.js";
import { buildFtsQuery, tokenize, tokenizeQuery } from "./tokenize.js";
import type { HistoryEntry, MemoryKind, MemoryRecord, MembraneStats } from "./types.js";

/** 当前 schema 版本：表结构变更时递增并写迁移逻辑 */
const SCHEMA_VERSION = 1;

/**
 * "现行有效"的 SQL 条件（未软删除且未被取代）。
 * 集中一处定义——这是时间感知的核心语义，散落各处最容易改漏。
 * 带表别名时用 CURRENT_SQL("m")。
 */
const CURRENT_SQL = (alias = ""): string => {
  const p = alias ? alias + "." : "";
  return `${p}deleted = 0 AND ${p}valid_to IS NULL`;
};

/** FTS5 检索命中的原始行（bm25 为 SQLite 原生分，越小（越负）越相关） */
export interface FtsHit {
  record: MemoryRecord;
  bm25: number;
}

/** searchFts 的过滤条件 */
export interface FtsSearchOptions {
  limit: number;
  /** 历史时点查询（unix ms）：返回该时刻有效的记忆；缺省=只看现行有效 */
  asOf?: number;
  kind?: MemoryKind;
  kinds?: MemoryKind[];
  /** 主语过滤；null 表示"主语为空的全局记忆" */
  subject?: string | null;
  /** 命名空间过滤，默认 "default" */
  namespace?: string;
}

/** list 的状态过滤 */
export type ListValidity = "current" | "all";

export interface ListOptions {
  validity?: ListValidity;
  kind?: MemoryKind;
  subject?: string | null;
  /** 命名空间过滤，默认 "default" */
  namespace?: string;
  limit?: number;
}

/**
 * Storage：对 SQLite 的薄封装。
 * 上层（Ingest/Recall）只通过本类访问数据库，保证 FTS 与主表永远一致。
 */
export class Storage {
  private readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, StatementSync>();
  /** close 幂等标记 */
  private closed = false;
  /** 事务嵌套深度（0=不在事务中；>0 时内层用 SAVEPOINT） */
  private txDepth = 0;
  /** 数据库文件路径（:memory: 表示内存库） */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      // 数据库所在目录不存在则创建（例如首次在 ./data/ 下建库）
      const dir = dirname(path);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      // WAL：写不阻塞读，进程崩溃后自动回滚日志（本地优先的可靠性底线）
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.ensureSchema();
  }

  // ---------- 基础设施 ----------

  /** 预编译语句缓存：同一 SQL 只 prepare 一次 */
  private stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  /**
   * 事务包装（**可重入**）。
   * 最外层用 BEGIN IMMEDIATE；嵌套层用 SAVEPOINT/RELEASE，这样 insert() 这类
   * 需要原子性的底层方法可以自己包事务，而不会被上层 add() 的事务搞成嵌套 BEGIN 报错。
   */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      if (depth === 0) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.txDepth--;
      if (depth === 0) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      }
      throw err;
    }
  }

  /** 建表（幂等）：DESIGN.md 第 3 节结构 + FTS5 虚拟表 + 触发器缺省由代码维护 */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        content       TEXT NOT NULL,
        subject       TEXT,
        tags          TEXT,
        confidence    REAL NOT NULL DEFAULT 1,
        source        TEXT,
        namespace     TEXT NOT NULL DEFAULT 'default',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        valid_from    INTEGER NOT NULL,
        valid_to      INTEGER,
        superseded_by TEXT,
        deleted       INTEGER NOT NULL DEFAULT 0,
        pin           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(deleted, valid_to, valid_from);
      CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject, kind, valid_to);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content_index);
      CREATE TABLE IF NOT EXISTS embeddings (
        id  TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        op        TEXT NOT NULL,
        at        INTEGER NOT NULL,
        detail    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_memory ON history(memory_id, seq);
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      -- 证据链：一条记忆可有多条 supporting quote。独立表，不动主表 → 零迁移。
      CREATE TABLE IF NOT EXISTS evidence (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        quote     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence(memory_id, seq);
    `);
    // 向后兼容迁移：老库没有 namespace 列时补上（ALTER TABLE 加列，幂等）。
    // 注意顺序：必须先加列，再建依赖该列的索引——否则老库升级会报 no such column。
    this.ensureColumn("memories", "namespace", "TEXT NOT NULL DEFAULT 'default'");
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_ns ON memories(namespace, deleted, valid_to);`,
    );
    // schema 版本检查：老库带新代码时给明确报错而不是神秘崩溃
    const ver = this.getSetting("schema_version");
    if (ver === null) {
      this.setSetting("schema_version", String(SCHEMA_VERSION));
    } else if (Number(ver) !== SCHEMA_VERSION) {
      // 报错前先关库：Windows 下文件句柄不释放会让后续清理/换库全部失败
      this.close();
      throw new MembraneError(
        "E_SCHEMA_VERSION",
        `数据库 schema 版本不匹配：文件是 v${ver}，代码要求 v${SCHEMA_VERSION}。` +
          `请升级 membrane 或迁移数据文件。`,
      );
    }
  }

  /** 确保列存在（老库自动补列，幂等；SQLite 不支持 IF NOT EXISTS 加列，故查 PRAGMA） */
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  // ---------- memories CRUD ----------

  /**
   * 插入一条记忆（含 FTS 索引），返回其 rowid（FTS 对齐用）。
   * 主表写入与全文索引写入必须在同一事务里——否则中途崩溃会留下
   * "记录存在但搜不到"的幽灵数据（写入成功、索引缺失）。
   */
  insert(record: MemoryRecord): number {
    return this.transaction(() => {
      const info = this.stmt(
        `INSERT INTO memories
           (id, kind, content, subject, tags, confidence, source, namespace,
            created_at, updated_at, valid_from, valid_to, superseded_by, deleted, pin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.kind,
        record.content,
        record.subject,
        JSON.stringify(record.tags),
        record.confidence,
        record.source,
        record.namespace ?? "default",
        record.createdAt,
        record.updatedAt,
        record.validFrom,
        record.validTo,
        record.supersededBy,
        record.deleted ? 1 : 0,
        record.pin ? 1 : 0,
      );
      const rowid = Number(info.lastInsertRowid);
      this.ftsInsert(rowid, record.content);
      return rowid;
    });
  }

  /** 按 id 取记忆（任何状态都返回，含软删除/被取代；调用方按需过滤） */
  get(id: string): MemoryRecord | null {
    const row = this.stmt(`SELECT * FROM memories WHERE id = ?`).get(id);
    return row ? rowToRecord(row as Row) : null;
  }

  /**
   * 冲突检测候选：同 (subject, kind) 的现行有效记忆。
   * `subject IS ?` 兼容 NULL（SQLite 的 IS 对 NULL 做相等比较）。
   */
  currentBySubjectKind(subject: string | null, kind: MemoryKind, namespace = "default"): MemoryRecord[] {
    const rows = this.stmt(
      `SELECT * FROM memories WHERE kind = ? AND subject IS ? AND namespace = ? AND ${CURRENT_SQL()}`,
    ).all(kind, subject, namespace);
    return toRecords(rows as unknown[]);
  }

  /** 标记被取代：valid_to=at、superseded_by=新 id（取代链落库） */
  markSuperseded(id: string, byId: string, at: number): void {
    const info = this.stmt(
      `UPDATE memories
       SET valid_to = ?, superseded_by = ?, updated_at = ?
       WHERE id = ? AND valid_to IS NULL AND deleted = 0`,
    ).run(at, byId, at, id);
    if (Number(info.changes) !== 1) {
      // 竞态或已被取代：明确报错，绝不静默
      throw new MembraneError(
        "E_SUPERSEDE_RACE",
        `取代失败：记忆 ${id} 不存在、已软删除或已被其他记忆取代。`,
      );
    }
  }

  /** 软删除（Forget）：deleted=1 且 valid_to=at——asOf 在删除前的时点仍能查到它 */
  softDelete(id: string, at: number): void {
    // WHERE 带 deleted=0 守卫：重复遗忘/已删记忆再次删除一律拒绝，绝不静默
    const info = this.stmt(
      `UPDATE memories SET deleted = 1, valid_to = ?, updated_at = ?
       WHERE id = ? AND deleted = 0`,
    ).run(at, at, id);
    if (Number(info.changes) !== 1) {
      throw new MembraneError("E_FORGET_RACE", `遗忘失败：记忆 ${id} 不存在或已被删除。`);
    }
  }

  /** 列出记忆（默认现行有效；export --all 用 validity='all'） */
  list(options: ListOptions = {}): MemoryRecord[] {
    const validity = options.validity ?? "current";
    const where: string[] = ["namespace = ?"];
    const params: (string | number | null)[] = [options.namespace ?? "default"];
    if (validity === "current") {
      where.push(CURRENT_SQL());
    }
    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.subject !== undefined) {
      if (options.subject === null) {
        where.push("subject IS NULL");
      } else {
        where.push("subject = ?");
        params.push(options.subject);
      }
    }
    const limit = options.limit && options.limit > 0 ? options.limit : -1;
    const sql = `SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC, id DESC LIMIT ${limit === -1 ? -1 : "?"}`;
    const rows =
      limit === -1
        ? this.stmt(sql).all(...params)
        : this.stmt(sql).all(...params, limit);
    return toRecords(rows as unknown[]);
  }

  // ---------- FTS5 ----------

  /** 写入 FTS 索引：正文 → bigram token 串 */
  private ftsInsert(rowid: number, content: string): void {
    const indexed = tokenize(content).join(" ");
    this.stmt(`INSERT INTO memory_fts(rowid, content_index) VALUES (?, ?)`).run(rowid, indexed);
  }

  /**
   * 全文检索（BM25）。
   * 查询侧先用 AND（精确），0 命中降级 OR（宽召回）——见 tokenize.ts 的说明。
   * FTS MATCH 表达式由 buildFtsQuery 白名单化，天然免疫注入。
   */
  searchFts(query: string, options: FtsSearchOptions): FtsHit[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];
    for (const mode of ["and", "or"] as const) {
      const match = buildFtsQuery(tokens, mode);
      if (!match) return [];
      const hits = this.searchFtsOnce(match, options);
      if (hits.length > 0 || mode === "or") return hits;
    }
    return []; // 理论不可达（for 循环两轮必 return）
  }

  private searchFtsOnce(matchExpr: string, options: FtsSearchOptions): FtsHit[] {
    const where: string[] = ["memory_fts MATCH ?", "m.namespace = ?"];
    const params: (string | number | null)[] = [matchExpr, options.namespace ?? "default"];
    if (options.asOf === undefined) {
      where.push(CURRENT_SQL("m")); // 现行有效
    } else {
      // 历史时点：valid_from <= t 且 (valid_to 为空或 > t)——软删除行靠 valid_to 自然排除
      where.push("m.valid_from <= ?", "(m.valid_to IS NULL OR m.valid_to > ?)");
      params.push(options.asOf, options.asOf);
    }
    if (options.kind) {
      where.push("m.kind = ?");
      params.push(options.kind);
    } else if (options.kinds && options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
    }
    if (options.subject !== undefined) {
      if (options.subject === null) {
        where.push("m.subject IS NULL");
      } else {
        where.push("m.subject = ?");
        params.push(options.subject);
      }
    }
    const sql = `SELECT m.*, bm25(memory_fts) AS _bm
                 FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
                 WHERE ${where.join(" AND ")}
                 ORDER BY _bm ASC
                 LIMIT ?`;
    const rows = this.stmt(sql).all(...params, options.limit);
    return (rows as Row[]).map((row) => ({
      record: rowToRecord(row),
      bm25: Number(row["_bm"]),
    }));
  }

  // ---------- embeddings（向量缓存，可选） ----------

  /** 写/刷新一条记忆的向量（Float32 存 BLOB） */
  upsertEmbedding(id: string, vec: Float32Array): void {
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.stmt(
      `INSERT INTO embeddings (id, dim, vec) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`,
    ).run(id, vec.length, blob);
  }

  getEmbedding(id: string): Float32Array | null {
    const row = this.stmt(`SELECT dim, vec FROM embeddings WHERE id = ?`).get(id) as
      | { dim: number; vec: Uint8Array }
      | undefined;
    if (!row) return null;
    const ab = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength);
    return new Float32Array(ab);
  }

  /** 全量向量（向量检索是本地线性扫，规模千级无压力；更大的库留到 v0.2 接 sqlite-vec） */
  getAllEmbeddings(): Map<string, Float32Array> {
    const rows = this.stmt(`SELECT id, vec FROM embeddings`).all() as {
      id: string;
      vec: Uint8Array;
    }[];
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      const ab = row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength);
      map.set(row.id, new Float32Array(ab));
    }
    return map;
  }

  /** 删除记忆时同步清理向量缓存 */
  deleteEmbedding(id: string): void {
    this.stmt(`DELETE FROM embeddings WHERE id = ?`).run(id);
  }

  // ---------- history（审计） ----------

  /** 追加一条审计记录（add/supersede/forget/keep-both） */
  historyAppend(memoryId: string, op: string, at: number, detail: unknown): void {
    this.stmt(`INSERT INTO history (memory_id, op, at, detail) VALUES (?, ?, ?, ?)`).run(
      memoryId,
      op,
      at,
      detail === undefined || detail === null ? null : JSON.stringify(detail),
    );
  }

  /** 某条记忆的增改史（按时间升序） */
  historyFor(memoryId: string): HistoryEntry[] {
    const rows = this.stmt(
      `SELECT seq, memory_id, op, at, detail FROM history WHERE memory_id = ? ORDER BY seq ASC`,
    ).all(memoryId) as Row[];
    return rows.map((r) => ({
      seq: Number(r["seq"]),
      memoryId: String(r["memory_id"]),
      op: String(r["op"]),
      at: Number(r["at"]),
      detail: r["detail"] == null ? null : String(r["detail"]),
    }));
  }

  // ---------- evidence（证据链） ----------

  /** 追加一条 supporting quote（内部用，证据写入统一走 evidenceReplace） */
  private evidenceAdd(memoryId: string, quote: string, at: number): void {
    this.stmt(`INSERT INTO evidence (memory_id, quote, created_at) VALUES (?, ?, ?)`).run(
      memoryId,
      quote,
      at,
    );
  }

  /** 某条记忆的全部证据（按时间升序） */
  evidenceFor(memoryId: string): { quote: string; at: number }[] {
    const rows = this.stmt(
      `SELECT quote, created_at FROM evidence WHERE memory_id = ? ORDER BY seq ASC`,
    ).all(memoryId) as { quote: string; created_at: number }[];
    return rows.map((r) => ({ quote: String(r.quote), at: Number(r.created_at) }));
  }

  /** 批量替换证据（先清后加；调用方保证在事务内） */
  evidenceReplace(memoryId: string, quotes: string[], at: number): void {
    this.stmt(`DELETE FROM evidence WHERE memory_id = ?`).run(memoryId);
    for (const q of quotes) {
      if (q.trim().length > 0) this.evidenceAdd(memoryId, q.trim(), at);
    }
  }

  /** 所有记忆的证据条数（一次查询，供 recall 打明细，避免 N+1） */
  evidenceCountAll(): Map<string, number> {
    const rows = this.stmt(
      `SELECT memory_id, COUNT(*) AS n FROM evidence GROUP BY memory_id`,
    ).all() as { memory_id: string; n: number }[];
    return new Map(rows.map((r) => [String(r.memory_id), Number(r.n)]));
  }

  // ---------- settings ----------

  getSetting(key: string): string | null {
    const row = this.stmt(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.stmt(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  // ---------- 统计 / 生命周期 ----------

  /** 库况速览（CLI stats / MCP stats / doctor 用） */
  stats(): MembraneStats {
    const row = this.stmt(
      `SELECT
         COUNT(*)                                                        AS total,
         SUM(CASE WHEN deleted = 0 AND valid_to IS NULL THEN 1 ELSE 0 END) AS current,
         SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END)       AS superseded,
         SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END)                     AS deleted,
         SUM(CASE WHEN pin = 1 THEN 1 ELSE 0 END)                         AS pinned
       FROM memories`,
    ).get() as Row;
    const byKindRows = this.stmt(`SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind`).all() as {
      kind: MemoryKind;
      n: number;
    }[];
    const byKind = { fact: 0, episode: 0, preference: 0, procedure: 0 };
    for (const r of byKindRows) byKind[r.kind] = Number(r.n);
    let dbBytes = 0;
    if (this.path !== ":memory:" && existsSync(this.path)) {
      dbBytes = statSync(this.path).size;
    }
    return {
      total: Number(row["total"] ?? 0),
      current: Number(row["current"] ?? 0),
      superseded: Number(row["superseded"] ?? 0),
      deleted: Number(row["deleted"] ?? 0),
      pinned: Number(row["pinned"] ?? 0),
      byKind,
      dbBytes,
    };
  }

  // ---------- 生命周期 ----------

  /** 关闭数据库（WAL checkpoint 随之完成）；幂等（重复调用不会二次 close） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    this.db.close();
  }
}
