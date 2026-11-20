/**
 * Storage 测试：建表/CRUD/FTS5/history/settings/embeddings/持久化往返/注入无害化。
 * 覆盖 DESIGN.md 第 3 节数据模型与第 9 节安全要求（FTS 注入无害化）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "../src/storage.js";
import { MembraneError, rowToRecord } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";
import type { MemoryRecord } from "../src/types.js";

/** 造一条最小记忆对象（测试用工厂） */
function makeRec(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  const at = partial.createdAt ?? BASE_TIME;
  return {
    id: partial.id ?? "rec-" + Math.random().toString(36).slice(2, 10),
    kind: partial.kind ?? "fact",
    content: partial.content ?? "用户住在北京市海淀区",
    subject: partial.subject === undefined ? "用户" : partial.subject,
    tags: partial.tags ?? [],
    confidence: partial.confidence ?? 1,
    source: partial.source ?? "test",
    createdAt: at,
    updatedAt: partial.updatedAt ?? at,
    validFrom: partial.validFrom ?? at,
    validTo: partial.validTo ?? null,
    supersededBy: partial.supersededBy ?? null,
    deleted: partial.deleted ?? false,
    pin: partial.pin ?? false,
  };
}

let dir: string;
let db: Storage;
let dbPath: string;

beforeEach(() => {
  dir = newTmpDir("storage");
  dbPath = `${dir}/membrane.db`;
  db = new Storage(dbPath);
});

afterEach(() => {
  db.close();
  rmDir(dir);
});

describe("Storage：CRUD 与往返", () => {
  it("插入后按 id 读回，字段无损（tags/布尔/时间）", () => {
    const rec = makeRec({ tags: ["住址", "北京"], pin: true, confidence: 0.9 });
    db.insert(rec);
    const got = db.get(rec.id);
    expect(got).not.toBeNull();
    expect(got!.content).toBe("用户住在北京市海淀区");
    expect(got!.tags).toEqual(["住址", "北京"]);
    expect(got!.pin).toBe(true);
    expect(got!.deleted).toBe(false);
    expect(got!.validTo).toBeNull();
    expect(got!.confidence).toBeCloseTo(0.9);
  });

  it("查不存在的 id 返回 null", () => {
    expect(db.get("no-such-id")).toBeNull();
  });

  it("currentBySubjectKind 只取同主语同 kind 的现行有效记忆", () => {
    db.insert(makeRec({ id: "a", kind: "fact", subject: "用户" }));
    db.insert(makeRec({ id: "b", kind: "preference", subject: "用户" }));
    db.insert(makeRec({ id: "c", kind: "fact", subject: "同事" }));
    const dead = makeRec({ id: "d", kind: "fact", subject: "用户", validTo: BASE_TIME + 1 });
    db.insert(dead);

    const hits = db.currentBySubjectKind("用户", "fact");
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    // 主语为 null 的全局记忆也能按 NULL 查询
    db.insert(makeRec({ id: "e", subject: null, kind: "fact" }));
    expect(db.currentBySubjectKind(null, "fact").map((h) => h.id)).toEqual(["e"]);
  });

  it("markSuperseded 落库 valid_to/superseded_by，重复取代报 E_SUPERSEDE_RACE", () => {
    db.insert(makeRec({ id: "old" }));
    db.markSuperseded("old", "new", BASE_TIME + 10);
    const after = db.get("old")!;
    expect(after.validTo).toBe(BASE_TIME + 10);
    expect(after.supersededBy).toBe("new");
    // 已被取代后再取代一次：拒绝（取代链只允许单向一次）
    expect(() => db.markSuperseded("old", "another", BASE_TIME + 20)).toThrowError(/E_SUPERSEDE_RACE|取代失败/);
  });

  it("softDelete 置 deleted/valid_to，重复删除报 E_FORGET_RACE", () => {
    db.insert(makeRec({ id: "x" }));
    db.softDelete("x", BASE_TIME + 5);
    expect(db.get("x")!.deleted).toBe(true);
    expect(db.get("x")!.validTo).toBe(BASE_TIME + 5);
    expect(() => db.softDelete("x", BASE_TIME + 6)).toThrowError(/E_FORGET_RACE|遗忘失败/);
  });

  it("list：默认现行有效，validity=all 全量", () => {
    db.insert(makeRec({ id: "a" }));
    db.insert(makeRec({ id: "b" }));
    db.markSuperseded("b", "c", BASE_TIME + 1);
    db.insert(makeRec({ id: "d", deleted: true, validTo: BASE_TIME + 1 }));
    expect(db.list().map((r) => r.id)).toEqual(["a"]);
    expect(db.list({ validity: "all" }).map((r) => r.id).sort()).toEqual(["a", "b", "d"]);
  });

  it("rowToRecord 对损坏的 tags JSON 降级为空数组（脏行不炸库）", () => {
    expect(rowToRecord({ id: "z", kind: "fact", content: "c", subject: null, tags: "{oops", confidence: 1, source: null, created_at: 1, updated_at: 1, valid_from: 1, valid_to: null, superseded_by: null, deleted: 0, pin: 0 }).tags).toEqual([]);
  });

  it("getMany 大批量：405 条全取回 + 4 万个不存在的 id 不炸（v0.2.7 修复：真按 400 分批）", () => {
    const ids: string[] = [];
    for (let i = 0; i < 405; i++) {
      const rec = makeRec({ id: `bulk-${i}`, content: `批量记忆${i}` });
      db.insert(rec);
      ids.push(rec.id);
    }
    // 405 = 跨过 400 的分批边界；4 万个缺失 id 验证占位符不再超 SQLite 变量上限
    const missing = Array.from({ length: 40_000 }, (_, i) => `missing-${i}`);
    const got = db.getMany([...ids, ...missing]);
    expect(got.size).toBe(405);
    expect(got.get("bulk-0")?.content).toBe("批量记忆0");
    expect(got.get("bulk-404")?.content).toBe("批量记忆404");
  });
});

describe("Storage：FTS5 检索", () => {
  it("中文 bigram 检索：两字词命中，未收录词不命中", () => {
    db.insert(makeRec({ id: "home" }));
    db.insert(makeRec({ id: "work", content: "办公室在国贸三期", subject: "用户" }));
    const hits = db.searchFts("北京", { limit: 10 });
    expect(hits.map((h) => h.record.id)).toEqual(["home"]);
    expect(db.searchFts("上海", { limit: 10 })).toEqual([]);
    // 长查询：子串 bigram 全命中
    expect(db.searchFts("用户住在", { limit: 10 }).map((h) => h.record.id)).toEqual(["home"]);
  });

  it("拉丁词大小写不敏感、前缀命中", () => {
    db.insert(makeRec({ id: "dev", content: "Deploy with Docker on Friday", subject: null }));
    expect(db.searchFts("docker", { limit: 5 }).map((h) => h.record.id)).toEqual(["dev"]);
    expect(db.searchFts("DEP", { limit: 5 }).map((h) => h.record.id)).toEqual(["dev"]);
  });

  it("kind/subject 过滤与 asOf 历史时点查询", () => {
    db.insert(makeRec({ id: "old", content: "用户住在北京市海淀区" }));
    // old 在 t+10 被取代
    db.markSuperseded("old", "new", BASE_TIME + 10);
    db.insert(makeRec({ id: "new", content: "用户住在上海市浦东新区", createdAt: BASE_TIME + 10, validFrom: BASE_TIME + 10 }));

    // 现行只看得到 new
    expect(db.searchFts("住在", { limit: 10 }).map((h) => h.record.id)).toEqual(["new"]);
    // asOf 在取代前：看得到 old
    expect(db.searchFts("住在", { limit: 10, asOf: BASE_TIME + 5 }).map((h) => h.record.id)).toEqual(["old"]);
    // asOf 在取代后：跟现行一致
    expect(db.searchFts("住在", { limit: 10, asOf: BASE_TIME + 20 }).map((h) => h.record.id)).toEqual(["new"]);
    // asOf 早于写入时间：什么都查不到
    expect(db.searchFts("住在", { limit: 10, asOf: BASE_TIME - 1 })).toEqual([]);
  });

  it("软删除的记忆在现行检索中消失，asOf 删除前仍可见", () => {
    db.insert(makeRec({ id: "gone", content: "我的银行卡密码是123456" }));
    db.softDelete("gone", BASE_TIME + 10);
    expect(db.searchFts("银行卡", { limit: 5 })).toEqual([]);
    expect(db.searchFts("银行卡", { limit: 5, asOf: BASE_TIME + 1 }).map((h) => h.record.id)).toEqual(["gone"]);
  });

  it("FTS 注入无害化：语法字符查询不抛错、不返回全库、库完好", () => {
    db.insert(makeRec({ id: "a", content: "正常记忆内容" }));
    db.insert(makeRec({ id: "b", content: "另一条记忆" }));
    const bombs = [
      '" OR 1=1 --',
      '"))* OR ("',
      "* OR NOT NULL",
      'NOT NEAR ("',
      "OR OR AND AND",
      '"(("*))',
      "\\\\\\' OR 1=1",
      "NEAR() OR bm25(a) --",
    ];
    for (const q of bombs) {
      // 不抛错（异常即失败）
      const hits = db.searchFts(q, { limit: 10 });
      // 注入不能把别人的行带出来：结果要么空，要么确因 token 相似命中
      for (const h of hits) {
        expect(["a", "b"]).toContain(h.record.id);
      }
      expect(hits.length).toBeLessThanOrEqual(2);
    }
    // 库完好：正常查询仍可用
    expect(db.searchFts("正常", { limit: 5 }).map((h) => h.record.id)).toEqual(["a"]);
  });
});

describe("Storage：history / settings / embeddings / stats", () => {
  it("history 追加与读取（detail 存 JSON）", () => {
    db.historyAppend("m1", "add", BASE_TIME, { note: "直写" });
    db.historyAppend("m1", "supersede", BASE_TIME + 1, { by: "m2", sim: 0.6 });
    const entries = db.historyFor("m1");
    expect(entries.map((e) => e.op)).toEqual(["add", "supersede"]);
    expect(JSON.parse(entries[1]!.detail ?? "{}")).toMatchObject({ by: "m2", sim: 0.6 });
    expect(db.historyFor("m-none")).toEqual([]);
  });

  it("settings 读写与覆盖", () => {
    expect(db.getSetting("k")).toBeNull();
    db.setSetting("k", "v1");
    db.setSetting("k", "v2");
    expect(db.getSetting("k")).toBe("v2");
  });

  it("embeddings 写读往返（Float32 精度）", () => {
    const vec = new Float32Array([0.1, -0.25, 3.5, 1e-6]);
    db.upsertEmbedding("m1", vec);
    db.upsertEmbedding("m1", new Float32Array([9, 8, 7])); // 覆盖写
    const got = db.getEmbedding("m1")!;
    expect(Array.from(got)).toEqual([9, 8, 7]);
    expect(db.getEmbedding("none")).toBeNull();
    db.upsertEmbedding("m2", vec);
    expect(db.getAllEmbeddings().size).toBe(2);
    db.deleteEmbedding("m2");
    expect(db.getAllEmbeddings().size).toBe(1);
  });

  it("stats 计数正确", () => {
    db.insert(makeRec({ id: "a", kind: "fact" }));
    db.insert(makeRec({ id: "b", kind: "fact" }));
    db.insert(makeRec({ id: "c", kind: "preference" }));
    db.insert(makeRec({ id: "d", pin: true }));
    db.markSuperseded("b", "x", BASE_TIME + 1);
    db.softDelete("c", BASE_TIME + 1);
    const s = db.stats();
    expect(s.total).toBe(4);
    expect(s.current).toBe(2);
    expect(s.superseded).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.pinned).toBe(1);
    expect(s.byKind).toMatchObject({ fact: 3, preference: 1 });
    expect(s.dbBytes).toBeGreaterThan(0);
  });
});

describe("Storage：持久化往返（跨会话的地基）", () => {
  it("关闭后重开文件库，数据/FTS/向量全在", () => {
    const rec = makeRec({ id: "persist", content: "重启后仍能检索到这条记忆" });
    db.insert(rec);
    db.upsertEmbedding("persist", new Float32Array([1, 2, 3]));
    db.historyAppend("persist", "add", BASE_TIME, {});
    db.close();

    const db2 = new Storage(dbPath);
    expect(db2.get("persist")!.content).toBe(rec.content);
    expect(db2.searchFts("重启", { limit: 5 }).map((h) => h.record.id)).toEqual(["persist"]);
    expect(Array.from(db2.getEmbedding("persist")!)).toEqual([1, 2, 3]);
    expect(db2.historyFor("persist").length).toBe(1);
    db2.close();
  });

  it("schema 版本不匹配给明确报错（E_SCHEMA_VERSION）", () => {
    db.setSetting("schema_version", "999");
    db.close();
    expect(() => new Storage(dbPath)).toThrowError(MembraneError);
    try {
      new Storage(dbPath);
    } catch (err) {
      expect((err as MembraneError).code).toBe("E_SCHEMA_VERSION");
    }
  });
});
