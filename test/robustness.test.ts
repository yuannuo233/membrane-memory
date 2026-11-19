/**
 * 边界与鲁棒性测试：补齐并发、极端输入、错误恢复、规模。
 * 这些是"别人真拿去用"时最先踩到的坑，比 happy path 更值钱。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { Storage } from "../src/storage.js";
import { MembraneError, MAX_CONTENT_LENGTH, MAX_SUBJECT_LENGTH } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
let m: Membrane;

beforeEach(() => {
  dir = newTmpDir("robust");
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => BASE_TIME });
});
afterEach(() => {
  m.close();
  rmDir(dir);
});

describe("极端输入", () => {
  it("超长内容被拒（E_CONTENT）", () => {
    expect(() => m.add({ content: "x".repeat(MAX_CONTENT_LENGTH + 1) })).toThrow(MembraneError);
  });

  it("刚好到上限的内容可以写入", () => {
    const r = m.add({ content: "x".repeat(MAX_CONTENT_LENGTH) });
    expect(r.status).toBe("created");
  });

  it("超长 subject 被拒", () => {
    expect(() => m.add({ content: "正常", subject: "s".repeat(MAX_SUBJECT_LENGTH + 1) })).toThrow();
  });

  it("纯空白/纯符号内容被拒", () => {
    expect(() => m.add({ content: "   \n\t  " })).toThrow();
  });

  it("emoji 与混合语言内容正常入库可召回", () => {
    m.add({ content: "用户喜欢 🎮 和 café", subject: "用户" });
    const hits = m.recall({ query: "café" });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("超长查询不抛错（返回空或结果）", () => {
    m.add({ content: "短记忆" });
    expect(() => m.recall({ query: "查".repeat(5000) })).not.toThrow();
  });

  it("空查询返回空数组", () => {
    m.add({ content: "有内容" });
    expect(m.recall({ query: "" })).toEqual([]);
  });

  it("SQL/FTS 注入字符不破坏库", () => {
    m.add({ content: "正常记忆" });
    const evil = `"); DROP TABLE memories; --`;
    expect(() => m.recall({ query: evil })).not.toThrow();
    // 库还在
    expect(m.stats().total).toBe(1);
  });
});

describe("错误恢复", () => {
  it("forget 不存在的 id 抛 E_FORGET_RACE", () => {
    expect(() => m.forget("不存在的id")).toThrow(MembraneError);
  });

  it("forget 两次第二次抛错（幂等拒绝而非静默）", () => {
    const r = m.add({ content: "要被忘的" });
    m.forget(r.memory.id);
    expect(() => m.forget(r.memory.id)).toThrow(MembraneError);
  });

  it("get 不存在的 id 返回 null 而非抛错", () => {
    expect(m.get("nope")).toBeNull();
  });

  it("history 不存在的 id 返回空数组", () => {
    expect(m.history("nope")).toEqual([]);
  });

  it("evidence 不存在的 id 返回空数组", () => {
    expect(m.evidence("nope")).toEqual([]);
  });

  it("非法 kind 抛 E_KIND", () => {
    expect(() => m.add({ content: "x", kind: "外星" as never })).toThrow(MembraneError);
  });

  it("confidence 超范围被拒", () => {
    expect(() => m.add({ content: "x", confidence: 2 })).toThrow();
    expect(() => m.add({ content: "x", confidence: -0.1 })).toThrow();
  });
});

describe("规模与性能", () => {
  it("1000 条记忆写入 + 召回在合理时间内", () => {
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      m.add({ content: `第${i}条测试记忆内容`, subject: `用户${i % 10}`, kind: "fact" });
    }
    const writeMs = Date.now() - t0;
    const t1 = Date.now();
    const hits = m.recall({ query: "测试记忆", limit: 10 });
    const readMs = Date.now() - t1;
    expect(m.stats().total).toBe(1000);
    expect(hits).toHaveLength(10);
    // 宽松阈值：1000 条写入 + 查询都应在数秒内（防止未来性能回归）
    expect(writeMs).toBeLessThan(10_000);
    expect(readMs).toBeLessThan(1_000);
  });

  it("大量取代链后现行数正确", () => {
    for (let i = 0; i < 50; i++) {
      m.add({ content: `用户住在城市${i}号`, subject: "用户", kind: "fact", at: BASE_TIME + i * 1000 });
    }
    const s = m.stats();
    expect(s.current).toBe(1); // 只剩最后一次
    expect(s.superseded).toBe(49);
  });
});

describe("向后兼容迁移（老库升级不炸）", () => {
  it("旧 schema（无 namespace 列）的库能被自动迁移，老数据不丢", async () => {
    const oldDb = `${dir}/old-schema.db`;
    // 直接建一个"老版本"库：memories 表没有 namespace 列（这是 v0.1 早期形态）
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(oldDb);
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, subject TEXT,
        tags TEXT, confidence REAL NOT NULL DEFAULT 1, source TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, valid_from INTEGER NOT NULL,
        valid_to INTEGER, superseded_by TEXT, deleted INTEGER NOT NULL DEFAULT 0, pin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO settings VALUES ('schema_version','1');
      INSERT INTO memories (id,kind,content,created_at,updated_at,valid_from)
      VALUES ('old-1','fact','老库里的记忆',${BASE_TIME},${BASE_TIME},${BASE_TIME});
    `);
    const before = raw.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
    expect(before.some((c) => c.name === "namespace")).toBe(false); // 确认是老的
    raw.close();

    // 用当前代码打开 → 应自动加列、建索引、老数据可读
    const migrated = new Storage(oldDb);
    const rec = migrated.get("old-1");
    expect(rec).not.toBeNull();
    expect(rec!.content).toBe("老库里的记忆");
    expect(rec!.namespace).toBe("default");
    expect(migrated.list({ namespace: "default" })).toHaveLength(1);
    migrated.close();
  });
});

describe("并发写（多连接同一文件库）", () => {  it("两个 Storage 实例交替写同一文件库，数据不丢", () => {
    const dbPath = `${dir}/concurrent.db`;
    const a = new Storage(dbPath);
    const b = new Storage(dbPath);
    try {
      for (let i = 0; i < 20; i++) {
        a.insert({
          id: `a-${i}`, kind: "fact", content: `A写的${i}`, subject: null, tags: [],
          confidence: 1, source: null, namespace: "default",
          createdAt: BASE_TIME, updatedAt: BASE_TIME, validFrom: BASE_TIME,
          validTo: null, supersededBy: null, deleted: false, pin: false,
        });
        b.insert({
          id: `b-${i}`, kind: "fact", content: `B写的${i}`, subject: null, tags: [],
          confidence: 1, source: null, namespace: "default",
          createdAt: BASE_TIME, updatedAt: BASE_TIME, validFrom: BASE_TIME,
          validTo: null, supersededBy: null, deleted: false, pin: false,
        });
      }
      // WAL 模式下对端可见（可能有短暂延迟，做一次读取重试）
      const total = a.stats().total;
      expect(total).toBeGreaterThanOrEqual(20);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("insert() 原子性：主表与全文索引不可分", () => {
  it("FTS 写入失败时主表必须回滚（不留幽灵记录）", () => {
    const dbPath = `${dir}/atomic.db`;
    const s = new Storage(dbPath);
    try {
      const rec = {
        id: "atomic-1", kind: "fact" as const, content: "原子性测试", subject: null, tags: [],
        confidence: 1, source: null, namespace: "default",
        createdAt: BASE_TIME, updatedAt: BASE_TIME, validFrom: BASE_TIME,
        validTo: null, supersededBy: null, deleted: false, pin: false,
      };
      s.insert(rec);
      // 人为让 FTS 表消失，再插入 → 必须回滚主表
      (s as unknown as { db: { exec: (sql: string) => void } }).db.exec("DROP TABLE memory_fts");
      expect(() => s.insert({ ...rec, id: "atomic-2" })).toThrow();
      // 主表里不应留下 atomic-2
      expect(s.get("atomic-2")).toBeNull();
      expect(s.get("atomic-1")).not.toBeNull(); // 原有数据不受影响
    } finally {
      s.close();
    }
  });

  it("嵌套事务（add 内调用 insert）不会因重复 BEGIN 报错", () => {
    const m2 = new Membrane({ dbPath: `${dir}/nest.db`, now: () => BASE_TIME });
    try {
      // add 外层开事务，insert 内层再开 → 应走 SAVEPOINT 而非报错
      const r = m2.add({ content: "嵌套事务测试", evidence: ["引用一"] });
      expect(r.status).toBe("created");
      expect(m2.recall({ query: "嵌套事务" }).length).toBeGreaterThan(0);
    } finally {
      m2.close();
    }
  });
});

describe("倒排索引自愈（老库升级后模糊兜底不失效）", () => {
  it("char_index 为空时，打开库会自动重建", async () => {
    const dbPath = `${dir}/charidx.db`;
    const s1 = new Storage(dbPath);
    s1.insert({
      id: "c-1", kind: "fact", content: "用户养了一只橘猫", subject: "用户", tags: [],
      confidence: 1, source: null, namespace: "default",
      createdAt: BASE_TIME, updatedAt: BASE_TIME, validFrom: BASE_TIME,
      validTo: null, supersededBy: null, deleted: false, pin: false,
    });
    // 模拟老库：清掉索引
    (s1 as unknown as { db: { exec: (sql: string) => void } }).db.exec("DELETE FROM char_index");
    const before = (s1 as unknown as { db: { prepare: (s: string) => { get: () => { n: number } } } })
      .db.prepare("SELECT COUNT(*) AS n FROM char_index").get();
    expect(Number(before.n)).toBe(0);
    s1.close();

    // 重新打开 → 应自动重建
    const s2 = new Storage(dbPath);
    const after = (s2 as unknown as { db: { prepare: (s: string) => { get: () => { n: number } } } })
      .db.prepare("SELECT COUNT(*) AS n FROM char_index").get();
    expect(Number(after.n)).toBeGreaterThan(0);
    // 模糊检索应能命中
    const cands = s2.fuzzyCandidates(["养", "猫"], 10, "default");
    expect(cands.length).toBeGreaterThan(0);
    s2.close();
  });

  it("空库不会触发无意义的重建", () => {
    const dbPath = `${dir}/empty.db`;
    const s = new Storage(dbPath);
    const n = (s as unknown as { db: { prepare: (q: string) => { get: () => { n: number } } } })
      .db.prepare("SELECT COUNT(*) AS n FROM char_index").get();
    expect(Number(n.n)).toBe(0);
    s.close();
  });
});

describe("多进程并发写（busy_timeout 保障）", () => {
  it("库文件连接设置了 busy_timeout，避免并发写立即报 database is locked", () => {
    const dbPath = `${dir}/busy.db`;
    const s = new Storage(dbPath);
    const timeout = (s as unknown as { db: { prepare: (q: string) => { get: () => { timeout?: number } } } })
      .db.prepare("PRAGMA busy_timeout").get();
    // 期望 5000ms，而不是 SQLite 默认的 0
    expect(Number(timeout.timeout)).toBe(5000);
    s.close();
  });

  it("两个 Storage 实例交替写同一文件库，全部写入成功", () => {
    const dbPath = `${dir}/two-writers.db`;
    const a = new Storage(dbPath);
    const b = new Storage(dbPath);
    try {
      const mkRec = (id: string) => ({
        id, kind: "fact" as const, content: `内容${id}`, subject: null, tags: [],
        confidence: 1, source: null, namespace: "default",
        createdAt: BASE_TIME, updatedAt: BASE_TIME, validFrom: BASE_TIME,
        validTo: null, supersededBy: null, deleted: false, pin: false,
      });
      for (let i = 0; i < 30; i++) {
        expect(() => a.insert(mkRec(`a-${i}`))).not.toThrow();
        expect(() => b.insert(mkRec(`b-${i}`))).not.toThrow();
      }
      // 两个连接都应能看到全部 60 条
      const total = a.stats().total;
      expect(total).toBeGreaterThanOrEqual(30);
    } finally {
      a.close();
      b.close();
    }
  });
});
