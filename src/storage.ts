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
import { buildFtsQuery, fuzzyUnits, tokenize, tokenizeQuery } from "./tokenize.js";
import type {
  EntityType,
  GraphEntity,
  HistoryEntry,
  MemoryKind,
  MemoryRecord,
  MembraneStats,
  Relation,
} from "./types.js";

/** 当前 schema 版本：表结构变更时递增并写迁移逻辑。v2 新增图检索三表 + MCP 客户端登记表（纯加法） */
const SCHEMA_VERSION = 2;

/**
 * "现行有效"的 SQL 条件（未软删除且未被取代）。
 * 集中一处定义——这是时间感知的核心语义，散落各处最容易改漏。
 * 带表别名时用 CURRENT_SQL("m")。
 */
const CURRENT_SQL = (alias = ""): string => {
  const p = alias ? alias + "." : "";
  return `${p}deleted = 0 AND ${p}valid_to IS NULL`;
};

/**
 * 记忆的时间过滤条件（现行有效 / 指定时点历史）。
 * 单点定义：FTS、模糊、向量扫描三处共用——以前三处各抄一份，
 * 改语义时漏一处就会"全文过滤对了、向量没过滤"这类幽灵 bug。
 */
function memoryTemporalSql(alias: string, asOf?: number): { sql: string; params: number[] } {
  if (asOf === undefined) return { sql: CURRENT_SQL(alias), params: [] };
  const p = alias ? alias + "." : "";
  // 历史时点只看有效区间：不要把 deleted 标志带进来——
  // 软删除会把 valid_to 设为删除时刻，asOf 早于它时这条记忆"当时确实存在"。
  return {
    sql: `${p}valid_from <= ? AND (${p}valid_to IS NULL OR ${p}valid_to > ?)`,
    params: [asOf, asOf],
  };
}

/** 关系边的时间过滤（关系没有 deleted 列：关闭即 valid_to 非空） */
function relationTemporalSql(asOf?: number): { sql: string; params: number[] } {
  if (asOf === undefined) return { sql: "valid_to IS NULL", params: [] };
  return { sql: "valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)", params: [asOf, asOf] };
}

/** FTS5 检索命中的原始行（bm25 为 SQLite 原生分，越小（越负）越相关） */
export interface FtsHit {
  record: MemoryRecord;
  bm25: number;
}

/** MCP 客户端登记（只记录握手/调用元数据，不记录正文或查询） */
export interface McpClientInput {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  transport?: string;
  pid?: number;
  cwd?: string;
  startedAt?: number;
}

export interface McpClientRecord {
  sessionId: string;
  clientName: string;
  clientVersion: string | null;
  protocolVersion: string | null;
  transport: string;
  pid: number | null;
  cwd: string | null;
  startedAt: number;
  lastSeen: number;
  calls: number;
  lastTool: string | null;
  status: string;
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

/** 分批扫向量的过滤条件（图/向量检索共用同一套时点语义） */
export interface VectorScanOptions {
  namespace: string;
  /** 历史时点：只扫该时刻有效的记忆 */
  asOf?: number;
  kind?: MemoryKind;
  kinds?: MemoryKind[];
  subject?: string | null;
  /** 每批读多少条（默认 512）。内存占用 ≈ batchSize × 维度 × 4 字节 */
  batchSize?: number;
}

/** BLOB → Float32Array（复制到独立 ArrayBuffer，避免共享 buffer 被后续读取污染） */
function blobToVec(raw: Uint8Array): Float32Array {
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return new Float32Array(ab);
}

/** 实体行 → 领域对象 */
function rowToEntity(row: Row): GraphEntity {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    type: (row["type"] == null ? "unknown" : String(row["type"])) as EntityType,
    namespace: row["namespace"] == null ? "default" : String(row["namespace"]),
    createdAt: Number(row["created_at"]),
  };
}

/** 关系行 → 领域对象 */
function rowToRelation(row: Row): Relation {
  return {
    id: String(row["id"]),
    fromId: String(row["from_id"]),
    toId: String(row["to_id"]),
    predicate: String(row["predicate"]),
    memoryId: row["memory_id"] == null ? null : String(row["memory_id"]),
    confidence: Number(row["confidence"]),
    validFrom: Number(row["valid_from"]),
    validTo: row["valid_to"] == null ? null : Number(row["valid_to"]),
    namespace: row["namespace"] == null ? "default" : String(row["namespace"]),
  };
}

export interface ListOptions {
  validity?: ListValidity;
  kind?: MemoryKind;
  /** 多 kind 过滤（kind 优先；两者都给时 kind 生效） */
  kinds?: MemoryKind[];
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
      // busy_timeout：多个进程写同一个库时，后到的写入**等待**锁释放而不是立刻
      // 抛 "database is locked"。SQLite 默认是 0（不等待），实测 4 进程并发写
      // 会丢掉近三成写入。5 秒足够覆盖正常的写事务竞争。
      this.db.exec("PRAGMA busy_timeout = 5000;");
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

  /** 当前代码要求的 schema 版本（诊断用） */
  get schemaVersion(): number {
    return SCHEMA_VERSION;
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
      -- 模糊检索的倒排索引：单字/词 → 记忆 id。
      -- 用于 FTS 未命中时的隔字兜底（"养猫" vs "养了一只猫"），避免全表扫描。
      CREATE TABLE IF NOT EXISTS char_index (
        unit      TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        PRIMARY KEY (unit, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_char_index_memory ON char_index(memory_id);
      -- 图检索：实体节点。名字唯一（同命名空间内），type 是属性而非身份——
      -- "苹果"是公司还是水果交给上层，不给同一个名字造两个节点。
      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL DEFAULT 'unknown',
        namespace  TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(namespace, name);
      -- 图检索：有向关系边。valid_from / valid_to 与记忆同一套时间感知语义。
      CREATE TABLE IF NOT EXISTS relations (
        id          TEXT PRIMARY KEY,
        from_id     TEXT NOT NULL,
        to_id       TEXT NOT NULL,
        predicate   TEXT NOT NULL,
        memory_id   TEXT,
        confidence  REAL NOT NULL DEFAULT 1,
        valid_from  INTEGER NOT NULL,
        valid_to    INTEGER,
        namespace   TEXT NOT NULL DEFAULT 'default'
      );
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(namespace, from_id, valid_to);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(namespace, to_id, valid_to);
      CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id);
      -- 图检索：记忆 ↔ 实体多对多（一条记忆提到哪些实体）
      CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
      -- MCP 客户端登记：stdio 每个客户端一个进程，写同一 SQLite 库，
      -- 让 REST/Ops 能看到“谁连过、调了什么工具”。只存元数据，不存正文/查询。
      CREATE TABLE IF NOT EXISTS mcp_clients (
        session_id       TEXT PRIMARY KEY,
        client_name      TEXT NOT NULL DEFAULT 'unknown',
        client_version   TEXT,
        protocol_version TEXT,
        transport        TEXT NOT NULL DEFAULT 'stdio',
        pid              INTEGER,
        cwd              TEXT,
        started_at       INTEGER NOT NULL,
        last_seen        INTEGER NOT NULL,
        calls            INTEGER NOT NULL DEFAULT 0,
        last_tool        TEXT,
        status           TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_clients_last_seen ON mcp_clients(last_seen DESC);
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
    } else if (Number(ver) < SCHEMA_VERSION) {
      // 加法式迁移：新表/新列都在上面的 DDL 里 IF NOT EXISTS 建好了，
      // 只需把版本号推上去。老库（v1）升级不会丢数据，也不会报错。
      this.setSetting("schema_version", String(SCHEMA_VERSION));
    } else if (Number(ver) > SCHEMA_VERSION) {
      // 报错前先关库：Windows 下文件句柄不释放会让后续清理/换库全部失败
      this.close();
      throw new MembraneError(
        "E_SCHEMA_VERSION",
        `数据库 schema 版本不匹配：文件是 v${ver}，代码要求 v${SCHEMA_VERSION}。` +
          `请升级 membrane 或迁移数据文件。`,
      );
    }
    // 倒排索引自愈：老库升级后 char_index 是空表，模糊兜底会静默失效。
    // 检测"有记忆但没有索引"就整体重建（幂等，只在新表或损坏时触发）。
    this.rebuildCharIndexIfNeeded();
  }

  /**
   * 检测并修复 char_index：若存在记忆却没有任何索引行，说明是老库升级或索引损坏，
   * 从 memories 全量重建。正常情况下这里只是一次 COUNT 查询，开销可忽略。
   */
  private rebuildCharIndexIfNeeded(): void {
    const indexed = this.stmt(`SELECT COUNT(*) AS n FROM char_index`).get() as { n: number };
    if (Number(indexed.n) > 0) return; // 已有索引，无需处理
    const total = this.stmt(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
    if (Number(total.n) === 0) return; // 空库，无需处理

    this.transaction(() => {
      const rows = this.stmt(`SELECT id, content FROM memories`).all() as {
        id: string;
        content: string;
      }[];
      for (const row of rows) this.charIndexInsert(String(row.id), String(row.content));
    });
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
      this.charIndexInsert(record.id, record.content);
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
    // 注意：char_index 不在此删除。历史时点查询（asOf）仍可能需要命中旧记忆，
    // 现行/历史过滤统一由 fuzzyCandidates 的 SQL 条件负责。
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
    // 注意：char_index 不在此删除——asOf 历史查询可能仍需命中该记忆（软删除保留底稿）。
    // 现行/历史过滤由 fuzzyCandidates 的 SQL 条件负责。
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
    } else if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
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
    const temporal = memoryTemporalSql("m", options.asOf);
    where.push(temporal.sql);
    params.push(...temporal.params);
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
    // 排序开销说明：FTS5 的 ORDER BY bm25 必须给每个命中行算分后建临时 B 树排序，
    // 无法提前终止（实测 10 万条、查询命中全部记忆时约 45-55 ms；命中几百条时 <1 ms）。
    // 这是 SQLite FTS5 的固有行为，不是本项目的 bug。
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

  // ---------- 模糊检索倒排索引（char_index） ----------

  /** 写入一条记忆的模糊检索单元（与 ftsInsert 同一事务，保证一致） */
  private charIndexInsert(memoryId: string, content: string): void {
    const stmt = this.stmt(`INSERT OR IGNORE INTO char_index (unit, memory_id) VALUES (?, ?)`);
    for (const unit of fuzzyUnits(content)) stmt.run(unit, memoryId);
  }

  /**
   * 按查询单元批量取候选记忆 id，附命中单元数（用于算覆盖率）。
   *
   * 这是模糊兜底的核心：用倒排索引只捞出"至少命中一个单元"的记忆，
   * 而不是把整个命名空间的记忆全读进内存逐条算（O(n) → O(命中数)）。
   * 排序在 SQL 里完成（命中单元数降序），调用方只需按覆盖率复核。
   *
   * @param asOf 给定时按历史时点语义过滤（与 searchFtsOnce 一致）；缺省只看现行有效
   */
  fuzzyCandidates(
    units: string[],
    limit: number,
    namespace = "default",
    asOf?: number,
  ): { id: string; hits: number }[] {
    if (units.length === 0) return [];
    const placeholders = units.map(() => "?").join(",");
    const params: (string | number)[] = [...units, namespace];
    const temporal = memoryTemporalSql("m", asOf);
    params.push(...temporal.params);
    const rows = this.stmt(
      `SELECT ci.memory_id AS id, COUNT(*) AS hits
         FROM char_index ci
         JOIN memories m ON m.id = ci.memory_id
        WHERE ci.unit IN (${placeholders})
          AND m.namespace = ?
          AND ${temporal.sql}
        GROUP BY ci.memory_id
        ORDER BY hits DESC
        LIMIT ?`,
    ).all(...params, limit) as { id: string; hits: number }[];
    return rows.map((r) => ({ id: String(r.id), hits: Number(r.hits) }));
  }

  /** 批量按 id 取记忆（模糊兜底用，避免 N+1） */
  getMany(ids: string[]): Map<string, MemoryRecord> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.stmt(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(
      ...ids,
    ) as Row[];
    return new Map(rows.map((r) => [String(r["id"]), rowToRecord(r)]));
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
    return row ? blobToVec(row.vec) : null;
  }

  /** 全量向量（保留给 SDK/测试；引擎内部一律走 scanEmbeddings 分批，不再用这个） */
  getAllEmbeddings(): Map<string, Float32Array> {
    const rows = this.stmt(`SELECT id, vec FROM embeddings`).all() as {
      id: string;
      vec: Uint8Array;
    }[];
    const map = new Map<string, Float32Array>();
    for (const row of rows) map.set(row.id, blobToVec(row.vec));
    return map;
  }

  /** 删除记忆时同步清理向量缓存 */
  deleteEmbedding(id: string): void {
    this.stmt(`DELETE FROM embeddings WHERE id = ?`).run(id);
  }

  /**
   * 库内已有向量的维度分布（维度 → 条数）。
   * 用途：防止混用两套 embedding 模型——维度不同的向量余弦恒为 0，
   * 混进来会静默地"永远召不中"，必须在写入时就拦下并说明。
   */
  embeddingDims(): Map<number, number> {
    const rows = this.stmt(`SELECT dim, COUNT(*) AS n FROM embeddings GROUP BY dim`).all() as {
      dim: number;
      n: number;
    }[];
    return new Map(rows.map((r) => [Number(r.dim), Number(r.n)]));
  }

  /** 按 id 批量取向量（候选重排用；比 getAllEmbeddings 全表扫省得多） */
  getEmbeddingsByIds(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    if (ids.length === 0) return out;
    // SQLite 变量上限 999（老版本 127），按 400 一批切分，宁多跑几次也不炸
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = this.stmt(
        `SELECT id, vec FROM embeddings WHERE id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as { id: string; vec: Uint8Array }[];
      for (const row of rows) out.set(String(row.id), blobToVec(row.vec));
    }
    return out;
  }

  /** 缺向量的现行记忆（回填用；只回填仍有效的，历史版本不必花 API 钱） */
  memoriesMissingEmbedding(namespace = "default", limit = -1): MemoryRecord[] {
    const sql = `SELECT m.* FROM memories m
                 LEFT JOIN embeddings e ON e.id = m.id
                 WHERE m.namespace = ? AND ${CURRENT_SQL("m")} AND e.id IS NULL
                 ORDER BY m.valid_from ASC, m.id ASC
                 ${limit > 0 ? "LIMIT ?" : ""}`;
    const rows =
      limit > 0 ? this.stmt(sql).all(namespace, limit) : this.stmt(sql).all(namespace);
    return toRecords(rows as unknown[]);
  }

  /**
   * 分批扫描向量（向量检索的**内存可控**实现）。
   *
   * 为什么不是 getAllEmbeddings：1000 条 × 1536 维 float32 ≈ 6MB 还行，
   * 10 万条就是 600MB，直接把进程拖死。这里用 keyset 分页（e.rowid > 上一批最大值）
   * 每次只物化 batchSize 条，调用方边扫边维护 top-K，内存只跟 batchSize 有关。
   *
   * 过滤（命名空间/现行/kind/subject/时点）全部下推到 SQL，避免把别租户的向量读出来。
   * e.rowid 是稳定递增的，keyset 分页不会漏行也不会重复（不像 OFFSET 会被并发写打乱）。
   */
  scanEmbeddings(
    options: VectorScanOptions,
    onBatch: (items: { record: MemoryRecord; vec: Float32Array }[]) => void,
  ): void {
    const batch = options.batchSize && options.batchSize > 0 ? options.batchSize : 512;
    const where: string[] = ["e.rowid > ?", "m.namespace = ?"];
    const base: (string | number | null)[] = [0, options.namespace];
    const temporal = memoryTemporalSql("m", options.asOf);
    where.push(temporal.sql);
    base.push(...temporal.params);
    if (options.kind) {
      where.push("m.kind = ?");
      base.push(options.kind);
    } else if (options.kinds && options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => "?").join(",")})`);
      base.push(...options.kinds);
    }
    if (options.subject !== undefined) {
      if (options.subject === null) where.push("m.subject IS NULL");
      else {
        where.push("m.subject = ?");
        base.push(options.subject);
      }
    }
    const sql = `SELECT m.*, e.vec AS _vec, e.rowid AS _erowid
                 FROM embeddings e JOIN memories m ON m.id = e.id
                 WHERE ${where.join(" AND ")}
                 ORDER BY e.rowid ASC
                 LIMIT ?`;
    let last = 0;
    while (true) {
      const rows = this.stmt(sql).all(last, ...base.slice(1), batch) as Row[];
      if (rows.length === 0) return;
      const items: { record: MemoryRecord; vec: Float32Array }[] = [];
      for (const row of rows) {
        const raw = row["_vec"];
        if (!(raw instanceof Uint8Array)) continue;
        items.push({ record: rowToRecord(row), vec: blobToVec(raw) });
      }
      last = Number(rows[rows.length - 1]!["_erowid"]);
      onBatch(items);
      if (rows.length < batch) return;
    }
  }

  // ---------- entities / relations（图检索） ----------

  /** 按名字取实体（同命名空间内名字唯一） */
  getEntityByName(name: string, namespace = "default"): GraphEntity | null {
    const row = this.stmt(
      `SELECT id, name, type, namespace, created_at FROM entities
       WHERE namespace = ? AND name = ?`,
    ).get(namespace, name) as Row | undefined;
    return row ? rowToEntity(row) : null;
  }

  /** 插入实体（id 由引擎生成，保证与记忆 id 同一套单调 ULID） */
  insertEntity(entity: GraphEntity): void {
    this.stmt(
      `INSERT INTO entities (id, name, type, namespace, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(entity.id, entity.name, entity.type, entity.namespace, entity.createdAt);
  }

  /** 修正实体类型（unknown → 具体类型） */
  updateEntityType(id: string, type: EntityType): void {
    this.stmt(`UPDATE entities SET type = ? WHERE id = ?`).run(type, id);
  }

  /** 命名空间内全部实体（查询侧按名字找实体用；实体数量远小于记忆，可接受） */
  listEntities(namespace = "default", limit = 5000): GraphEntity[] {
    const rows = this.stmt(
      `SELECT id, name, type, namespace, created_at FROM entities
       WHERE namespace = ? ORDER BY name ASC LIMIT ?`,
    ).all(namespace, limit) as Row[];
    return rows.map(rowToEntity);
  }

  /** 记一条"这条记忆提到这个实体" */
  linkMemoryEntity(memoryId: string, entityId: string): void {
    this.stmt(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`).run(
      memoryId,
      entityId,
    );
  }

  /** 写一条关系边 */
  insertRelation(rel: Relation): void {
    this.stmt(
      `INSERT INTO relations
         (id, from_id, to_id, predicate, memory_id, confidence, valid_from, valid_to, namespace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rel.id,
      rel.fromId,
      rel.toId,
      rel.predicate,
      rel.memoryId,
      rel.confidence,
      rel.validFrom,
      rel.validTo,
      rel.namespace,
    );
  }

  /**
   * 取关系。`ids` 给出时只返回**任一端**落在这些实体上的边（一跳邻居）。
   * 时点语义与记忆一致：缺省只看现行（valid_to IS NULL），给 asOf 则按区间判断。
   */
  relationsTouching(
    ids: string[],
    options: { namespace?: string; asOf?: number; limit?: number } = {},
  ): Relation[] {
    if (ids.length === 0) return [];
    const ns = options.namespace ?? "default";
    const where: string[] = ["namespace = ?"];
    const params: (string | number)[] = [ns];
    const temporal = relationTemporalSql(options.asOf);
    where.push(temporal.sql);
    params.push(...temporal.params);
    const placeholders = ids.map(() => "?").join(",");
    const limit = options.limit && options.limit > 0 ? options.limit : 1000;
    const rows = this.stmt(
      `SELECT id, from_id, to_id, predicate, memory_id, confidence, valid_from, valid_to, namespace
         FROM relations
        WHERE ${where.join(" AND ")}
          AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
        ORDER BY confidence DESC, valid_from DESC
        LIMIT ?`,
    ).all(...params, ...ids, ...ids, limit) as Row[];
    return rows.map(rowToRelation);
  }

  /**
   * 关闭某条记忆派生的全部关系（记忆被取代/遗忘时调用）。
   * 不删行：asOf 历史查询仍要能查到"当时那条关系成立"。
   */
  closeRelationsForMemory(memoryId: string, at: number): void {
    this.stmt(
      `UPDATE relations SET valid_to = ? WHERE memory_id = ? AND valid_to IS NULL`,
    ).run(at, memoryId);
  }

  /** 记忆 → 实体 id 列表（答"这条记忆涉及谁"用） */
  entitiesForMemory(memoryId: string): GraphEntity[] {
    const rows = this.stmt(
      `SELECT e.id, e.name, e.type, e.namespace, e.created_at
         FROM memory_entities me JOIN entities e ON e.id = me.entity_id
        WHERE me.memory_id = ? ORDER BY e.name ASC`,
    ).all(memoryId) as Row[];
    return rows.map(rowToEntity);
  }

  /** 遗忘时清掉"这条记忆提到谁"的关联（实体本身可能还被别的记忆引用，不删） */
  deleteMemoryEntities(memoryId: string): void {
    this.stmt(`DELETE FROM memory_entities WHERE memory_id = ?`).run(memoryId);
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

  /** 追加一条证据（导入还原用；正常写入统一走 evidenceReplace） */
  appendEvidence(memoryId: string, quote: string, at: number): void {
    if (quote.trim().length > 0) this.evidenceAdd(memoryId, quote.trim(), at);
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
    for (const r of byKindRows) {
      // 只统计四种合法 kind：脏数据（手改库/旧实验数据）不能往固定形状的对象上乱写键
      if (Object.prototype.hasOwnProperty.call(byKind, r.kind)) byKind[r.kind] = Number(r.n);
    }
    const graph = this.stmt(
      `SELECT (SELECT COUNT(*) FROM entities) AS entities,
              (SELECT COUNT(*) FROM relations) AS relations`,
    ).get() as Row;
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
      entities: Number(graph["entities"] ?? 0),
      relations: Number(graph["relations"] ?? 0),
    };
  }

  // ---------- MCP 客户端登记（只记录元数据，不记录正文/查询） ----------

  /** 首次 initialize / 重复握手：写入或更新会话元数据 */
  recordMcpClient(input: McpClientInput): void {
    const now = Date.now();
    this.stmt(
      `INSERT INTO mcp_clients
         (session_id, client_name, client_version, protocol_version, transport, pid, cwd,
          started_at, last_seen, calls, last_tool, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active')
       ON CONFLICT(session_id) DO UPDATE SET
         client_name = excluded.client_name,
         client_version = excluded.client_version,
         protocol_version = excluded.protocol_version,
         transport = excluded.transport,
         pid = excluded.pid,
         cwd = excluded.cwd,
         last_seen = excluded.last_seen,
         status = 'active'`,
    ).run(
      input.sessionId,
      input.clientName?.trim() || "unknown",
      input.clientVersion ?? null,
      input.protocolVersion ?? null,
      input.transport ?? "stdio",
      input.pid ?? null,
      input.cwd ?? null,
      input.startedAt ?? now,
      now,
    );
  }

  /** 每次 tools/call 更新“最后活动 / 调用次数 / 最后工具” */
  touchMcpClient(sessionId: string, tool?: string): void {
    this.stmt(
      `UPDATE mcp_clients
          SET last_seen = ?, calls = calls + 1, last_tool = ?, status = 'active'
        WHERE session_id = ?`,
    ).run(Date.now(), tool ?? null, sessionId);
  }

  /** 进程正常退出：标记为已断开；异常退出靠 last_seen 超时识别 */
  closeMcpClient(sessionId: string): void {
    this.stmt(
      `UPDATE mcp_clients SET last_seen = ?, status = 'closed' WHERE session_id = ?`,
    ).run(Date.now(), sessionId);
  }

  /** Ops 页面：最近活动的 MCP 客户端 */
  listMcpClients(limit = 50): McpClientRecord[] {
    // NaN/非数值兜底为默认值，否则 SQL LIMIT 绑定 NaN 会直接抛错
    const safeLimit = Number.isFinite(limit) ? limit : 50;
    const rows = this.stmt(
      `SELECT session_id, client_name, client_version, protocol_version, transport, pid, cwd,
              started_at, last_seen, calls, last_tool, status
         FROM mcp_clients
        ORDER BY last_seen DESC
        LIMIT ?`,
    ).all(Math.max(1, Math.min(200, safeLimit))) as Row[];
    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      clientName: String(r["client_name"] ?? "unknown"),
      clientVersion: r["client_version"] == null ? null : String(r["client_version"]),
      protocolVersion: r["protocol_version"] == null ? null : String(r["protocol_version"]),
      transport: String(r["transport"] ?? "stdio"),
      pid: r["pid"] == null ? null : Number(r["pid"]),
      cwd: r["cwd"] == null ? null : String(r["cwd"]),
      startedAt: Number(r["started_at"]),
      lastSeen: Number(r["last_seen"]),
      calls: Number(r["calls"] ?? 0),
      lastTool: r["last_tool"] == null ? null : String(r["last_tool"]),
      status: String(r["status"] ?? "active"),
    }));
  }

  // ---------- 导出 / 导入（备份与迁移用） ----------

  /** 全部记忆（含历史版本/已删除的底稿；备份要"全"，恢复才不丢取代链） */
  allMemories(): MemoryRecord[] {
    const rows = this.stmt(`SELECT * FROM memories ORDER BY valid_from ASC, id ASC`).all();
    return toRecords(rows as unknown[]);
  }

  /** 全部证据（按写入顺序，保序才能还原"观察先后"） */
  allEvidence(): { memoryId: string; quote: string; at: number }[] {
    const rows = this.stmt(
      `SELECT memory_id, quote, created_at FROM evidence ORDER BY seq ASC`,
    ).all() as { memory_id: string; quote: string; created_at: number }[];
    return rows.map((r) => ({
      memoryId: String(r.memory_id),
      quote: String(r.quote),
      at: Number(r.created_at),
    }));
  }

  /** 全部实体（跨命名空间；备份不能只导 default） */
  allEntities(): GraphEntity[] {
    const rows = this.stmt(
      `SELECT id, name, type, namespace, created_at FROM entities ORDER BY created_at ASC, id ASC`,
    ).all() as Row[];
    return rows.map(rowToEntity);
  }

  /** 全部关系边（含已关闭的，保留时间语义） */
  allRelations(): Relation[] {
    const rows = this.stmt(
      `SELECT id, from_id, to_id, predicate, memory_id, confidence, valid_from, valid_to, namespace
         FROM relations ORDER BY valid_from ASC, id ASC`,
    ).all() as Row[];
    return rows.map(rowToRelation);
  }

  /** 记忆 ↔ 实体关联全量（导入时还原"这条记忆提到谁"） */
  allMemoryEntities(): { memoryId: string; entityId: string }[] {
    const rows = this.stmt(`SELECT memory_id, entity_id FROM memory_entities`).all() as {
      memory_id: string;
      entity_id: string;
    }[];
    return rows.map((r) => ({ memoryId: String(r.memory_id), entityId: String(r.entity_id) }));
  }

  /** 关系 id 是否已存在（导入幂等：重复导入同一份备份不产生重复边） */
  hasRelation(id: string): boolean {
    return this.stmt(`SELECT 1 FROM relations WHERE id = ?`).get(id) !== undefined;
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
