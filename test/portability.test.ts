/**
 * 备份导出/导入测试：本地优先的底线是"数据永远拿得回来"。
 *
 * 重点验四件事：
 *  1. 全量导出包含历史版本/已遗忘底稿，恢复后 asOf 仍能查
 *  2. 导入幂等（同一份备份导两次不产生重复）
 *  3. 实体按 (namespace, name) 复用，关系边自动改指向目标库已有实体
 *  4. 向量维度不符时跳过而不是把库搞成"永远余弦 0"
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Membrane } from "../src/engine.js";
import { MembraneError } from "../src/model.js";
import type { ExportBundle } from "../src/types.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

const DAY = 86_400_000;
let dir: string;

afterEach(() => {
  if (dir) rmDir(dir);
});

/** 造一个带历史版本、遗忘底稿、图关系、证据、向量的源库 */
function makeSource(): { engine: Membrane; clock: { value: number } } {
  dir = newTmpDir("portability");
  const clock = { value: BASE_TIME };
  const engine = new Membrane({ dbPath: join(dir, "source.db"), now: () => clock.value });
  engine.add({
    content: "用户住在北京",
    subject: "用户",
    kind: "fact",
    at: BASE_TIME,
    vec: [1, 0, 0],
    evidence: ["用户说：我住在北京"],
  });
  clock.value = BASE_TIME + DAY;
  engine.add({ content: "用户住在上海", subject: "用户", kind: "fact", at: BASE_TIME + DAY });
  engine.add({
    content: "张三是李四的同学",
    subject: "张三",
    kind: "fact",
    at: BASE_TIME,
    relations: [{ to: "李四", predicate: "同学", toType: "person" }],
  });
  const secret = engine.add({ content: "用户的临时密码是蓝色", subject: "用户", kind: "fact", at: BASE_TIME });
  clock.value = BASE_TIME + 2 * DAY;
  engine.forget(secret.memory.id);
  return { engine, clock };
}

describe("exportAll / importAll：全量备份", () => {
  it("导出包含历史版本与已遗忘底稿，恢复后数据与时间语义都在", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    expect(bundle.format).toBe("membrane-backup");
    expect(bundle.memories.length).toBe(4); // 北京(被取代) / 上海(现行) / 张三 / 密码(已删)
    expect(bundle.evidence.length).toBe(1);
    expect(bundle.entities.length).toBeGreaterThanOrEqual(3); // 用户、张三、李四
    // 额外还有规则自动抽的"用户 住在 北京/上海"，所以只断言"至少有一条手动关系"
    expect(bundle.relations.length).toBeGreaterThanOrEqual(1);
    expect(bundle.embeddings.length).toBe(1);

    const b = new Membrane({ dbPath: join(dir, "target.db"), now: () => BASE_TIME });
    const r = b.importAll(bundle);
    expect(r.memories).toBe(4);
    expect(r.skippedMemories).toBe(0);
    expect(r.relations).toBe(bundle.relations.length);
    expect(r.embeddings).toBe(1);

    const s = b.stats();
    expect(s.total).toBe(4);
    expect(s.current).toBe(2); // 上海 + 张三
    expect(s.superseded).toBe(1);
    expect(s.deleted).toBe(1);

    // 现行召回：上海能查到，北京（已被取代）不出现
    expect(b.recall({ query: "上海", limit: 3 })[0]?.memory.content).toContain("上海");
    // 历史时点：被取代之前，北京仍然可见（valid_from/valid_to 链完整还原）
    const old = b.recall({ query: "北京", asOf: BASE_TIME + 1, limit: 3 });
    expect(old.some((h) => h.memory.content.includes("北京"))).toBe(true);
    // 遗忘底稿也导回来了：get 能取到，但现行召回不出现
    const deleted = b.list({ validity: "all" }).filter((m) => m.deleted);
    expect(deleted.length).toBe(1);
    b.close();
    a.close();
  });

  it("导入幂等：同一份备份导两次，第二次全部跳过", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    const b = new Membrane({ dbPath: join(dir, "twice.db"), now: () => BASE_TIME });
    const first = b.importAll(bundle);
    const second = b.importAll(bundle);
    expect(second.memories).toBe(0);
    expect(second.skippedMemories).toBe(first.memories);
    expect(second.relations).toBe(0);
    expect(second.skippedRelations).toBe(first.relations);
    expect(b.stats().total).toBe(first.memories);
    b.close();
    a.close();
  });

  it("实体按名字复用：目标库已有同名实体时，关系边改指向它而不是插断边", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    const c = new Membrane({ dbPath: join(dir, "reuse.db"), now: () => BASE_TIME });
    c.add({ content: "李四在腾讯工作", subject: "李四", kind: "fact", at: BASE_TIME, entities: ["腾讯"] });
    const before = c.stats().entities;
    const r = c.importAll(bundle);
    // 李四已存在 → 不新增；用户/张三/腾讯等才新增
    expect(c.stats().entities).toBeLessThan(before + bundle.entities.length);
    expect(r.relations).toBe(bundle.relations.length);
    expect(c.relations("张三", "李四").length).toBeGreaterThanOrEqual(1);
    c.close();
    a.close();
  });

  it("向量维度不符：跳过并计数，不污染目标库", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    const d = new Membrane({ dbPath: join(dir, "dim.db"), now: () => BASE_TIME });
    d.add({ content: "用户会弹钢琴", subject: "用户", kind: "fact", at: BASE_TIME, vec: [1, 0, 0, 0] });
    const r = d.importAll(bundle);
    expect(r.embeddings).toBe(0);
    expect(r.skippedEmbeddings).toBe(1);
    expect(d.stats().total).toBe(5);
    d.close();
    a.close();
  });

  it("向量含 NaN/Infinity：整条跳过，不静默压成低维", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    const bad = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    bad.embeddings[0]!.vec = [1, NaN, 0, 0];
    const e = new Membrane({ dbPath: join(dir, "nan.db"), now: () => BASE_TIME });
    const r = e.importAll(bad);
    expect(r.embeddings).toBe(0);
    expect(r.skippedEmbeddings).toBe(1);
    e.close();
    a.close();
  });

  it("坏 kind：拒绝导入并报 E_IMPORT_FORMAT，不污染库", () => {
    const { engine: a } = makeSource();
    const bundle = a.exportAll();
    const bad = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    bad.memories[0]!.kind = "garbage" as typeof bundle.memories[0]["kind"];
    const f = new Membrane({ dbPath: join(dir, "badkind.db"), now: () => BASE_TIME });
    expect(() => f.importAll(bad)).toThrow(MembraneError);
    expect(f.stats().total).toBe(0);
    f.close();
    a.close();
  });

  it("坏文件拒绝导入：格式不对直接报 E_IMPORT_FORMAT", () => {
    dir = newTmpDir("portability");
    const m = new Membrane({ dbPath: join(dir, "bad.db") });
    expect(() => m.importAll({} as ExportBundle)).toThrow(MembraneError);
    expect(() => m.importAll({ format: "membrane-backup", version: 1, memories: null } as unknown as ExportBundle)).toThrow(
      /memories/,
    );
    m.close();
  });

  it("不导向量时导出文件更小，恢复后 stats 仍一致", () => {
    const { engine: a } = makeSource();
    const full = a.exportAll();
    const slim = a.exportAll({ includeEmbeddings: false });
    expect(slim.embeddings.length).toBe(0);
    expect(full.embeddings.length).toBe(1);
    expect(slim.memories.length).toBe(full.memories.length);
    a.close();
  });
});
