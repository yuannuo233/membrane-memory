/**
 * 图检索测试（v0.2 新增）。
 *
 * 覆盖交接文档 6.4 的验收标准：
 *  - 能回答"张三和李四是什么关系"（手动录入 + 规则抽取两条路都要通）
 *  - 关系遵守时间感知（asOf 能查历史关系；记忆被取代后旧关系失效）
 *  - 遵守 namespace 隔离
 *  - 不影响现有全文检索
 *  - 图路作为一路候选进入综合打分（rrfGraph），而不是独立接口走另一套
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { extractGraph } from "../src/graph-extract.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
let m: Membrane;
let t: number;

beforeEach(() => {
  dir = newTmpDir("graph");
  t = BASE_TIME;
  m = new Membrane({ dbPath: `${dir}/g.db`, now: () => t });
});

afterEach(() => {
  m.close();
  rmDir(dir);
});

describe("规则抽取：实体与关系", () => {
  it("『用户住在北京』→ 住在 关系，北京识别为地点", () => {
    const g = extractGraph("用户住在北京", "用户");
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]).toMatchObject({ from: "用户", to: "北京", predicate: "住在", toType: "place" });
    expect(g.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["用户", "北京"]));
  });

  it("代词映射到 subject（『我住在杭州』）", () => {
    const g = extractGraph("我住在杭州", "用户");
    expect(g.relations[0]).toMatchObject({ from: "用户", to: "杭州", predicate: "住在" });
  });

  it("没有 subject 时代词关系直接丢弃（不造一个叫『我』的实体）", () => {
    const g = extractGraph("我住在杭州", null);
    expect(g.relations).toHaveLength(0);
  });

  it("『张三是李四的同学』方向是 张三 → 李四，不是反的", () => {
    const g = extractGraph("张三是李四的同学", "张三");
    expect(g.relations[0]).toMatchObject({ from: "张三", to: "李四", predicate: "同学" });
  });

  it("『张三的同学是李四』词序相反，方向仍正确", () => {
    const g = extractGraph("张三的同学是李四", "张三");
    expect(g.relations[0]).toMatchObject({ from: "张三", to: "李四", predicate: "同学" });
  });

  it("『用户在北京工作』→ 工作于；『小李在北大读书』→ 就读于", () => {
    const g1 = extractGraph("用户在北京工作", "用户");
    expect(g1.relations[0]).toMatchObject({ from: "用户", to: "北京", predicate: "工作于" });
    const g2 = extractGraph("小李在北大读书", "小李");
    expect(g2.relations[0]).toMatchObject({ from: "小李", to: "北大", predicate: "就读于" });
  });

  it("没有结构关系的普通句子一条都不抽（宁缺毋滥）", () => {
    const g = extractGraph("今天天气不错，出去散步吧", "用户");
    expect(g.relations).toHaveLength(0);
  });
});

describe("写入：实体/关系随记忆一起落库", () => {
  it("add 返回本次建立的关系，实体表里有节点", () => {
    const r = m.add({ content: "张三是李四的同学", subject: "张三", subjectType: "person" });
    expect(r.relations?.length).toBe(1);
    expect(r.relations?.[0]?.sentence).toContain("张三");
    const names = m.listEntities().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["张三", "李四"]));
    expect(m.listEntities().find((e) => e.name === "张三")?.type).toBe("person");
  });

  it("手动标注优先于规则：给了 relations 就不再跑规则抽取", () => {
    const r = m.add({
      content: "用户住在北京",
      subject: "用户",
      relations: [{ to: "杭州", predicate: "住在", toType: "place" }],
    });
    expect(r.relations).toHaveLength(1);
    expect(r.relations?.[0]?.to).toBe("杭州");
    // 北京这个实体根本不该被创建（规则没跑）
    expect(m.listEntities().map((e) => e.name)).not.toContain("北京");
  });

  it("关掉规则抽取（graph.autoExtract=false）→ 只剩 subject 这一个实体", () => {
    const quiet = new Membrane({
      dbPath: `${dir}/quiet.db`,
      now: () => t,
      graph: { autoExtract: false },
    });
    quiet.add({ content: "用户住在北京", subject: "用户" });
    expect(quiet.listEntities().map((e) => e.name)).toEqual(["用户"]);
    quiet.close();
  });

  it("entities 参数可标注『这条记忆还提到谁』", () => {
    m.add({ content: "周末一起爬香山", subject: "张三", entities: [{ name: "李四", type: "person" }] });
    const ents = m.entitiesFor(m.list()[0]!.id).map((e) => e.name);
    expect(ents).toEqual(expect.arrayContaining(["张三", "李四"]));
  });
});

describe("关系查询：回答『谁和谁什么关系』", () => {
  beforeEach(() => {
    m.add({
      content: "张三是李四的同学",
      subject: "张三",
      kind: "fact",
      at: BASE_TIME,
      relations: [{ to: "李四", predicate: "同学", toType: "person" }],
    });
    m.add({
      content: "李四在腾讯工作",
      subject: "李四",
      kind: "fact",
      at: BASE_TIME,
      relations: [{ to: "腾讯", predicate: "工作于", toType: "org" }],
    });
  });

  it("relations(A, B) 返回两人之间的关系（带人话句子）", () => {
    const rels = m.relations("张三", "李四");
    expect(rels).toHaveLength(1);
    expect(rels[0]!.predicate).toBe("同学");
    expect(rels[0]!.sentence).toBe("张三 与 李四：同学");
    expect(rels[0]!.hops).toBe(1);
    expect(rels[0]!.fromType).toBe("unknown"); // 张三 是 subject，没有 subjectType 就按 unknown
  });

  it("传整句也能自己认实体：『张三和李四是什么关系』", () => {
    const rels = m.relations("张三和李四是什么关系");
    expect(rels).toHaveLength(1);
    expect(rels[0]!.predicate).toBe("同学");
  });

  it("只给 A 时返回一跳邻居（不分方向）", () => {
    const rels = m.relations("李四");
    const predicates = rels.map((r) => r.predicate).sort();
    expect(predicates).toEqual(["同学", "工作于"]);
  });

  it("两跳可达：张三 → 李四 → 腾讯", () => {
    const rels = m.relations("张三", "腾讯", { maxHops: 2 });
    expect(rels.map((r) => r.predicate)).toEqual(["同学", "工作于"]);
    expect(rels.map((r) => r.hops)).toEqual([1, 2]);
  });

  it("超过 maxHops 就返回空（默认 1 跳，不会偷偷给两跳的结果）", () => {
    expect(m.relations("张三", "腾讯")).toHaveLength(0);
  });

  it("查不存在的实体返回空，不报错", () => {
    expect(m.relations("王五")).toEqual([]);
    expect(m.relations("王五", "赵六")).toEqual([]);
  });

  it("link() 手动建关系，不需要先有记忆", () => {
    const rel = m.link({ from: "王五", to: "赵六", predicate: "同事" });
    expect(rel.sentence).toBe("王五 与 赵六：同事");
    expect(m.relations("王五", "赵六")).toHaveLength(1);
  });

  it("link() 幂等：重复建立同一关系不产生重复边，反方向不算同一条（v0.2.7）", () => {
    m.link({ from: "孙七", to: "周八", predicate: "朋友" });
    m.link({ from: "孙七", to: "周八", predicate: "朋友" });
    m.link({ from: "孙七", to: "周八", predicate: "朋友" });
    expect(m.relations("孙七")).toHaveLength(1);
    // 方向敏感：李四→张三是另一条边
    m.link({ from: "周八", to: "孙七", predicate: "朋友" });
    expect(m.relations("孙七")).toHaveLength(2);
  });
});

describe("关系的时间感知与生命周期", () => {
  it("记忆被取代 → 它派生的旧关系失效；asOf 仍能查到当时的关系", () => {
    m.add({ content: "用户住在北京", subject: "用户", at: BASE_TIME });
    m.add({ content: "用户住在上海", subject: "用户", at: BASE_TIME + 86_400_000 });

    // 现行：只剩上海（北京那条随老记忆一起失效）
    const now = m.relations("用户").map((r) => r.to);
    expect(now).toEqual(["上海"]);

    // 历史时点：北京关系仍在（当时还没被取代）
    const pastTos = m.relations("用户", null, { asOf: BASE_TIME }).map((r) => r.to);
    expect(pastTos).toEqual(["北京"]);
  });

  it("forget 之后关系也消失（不让被遗忘的记忆通过关系继续说话）", () => {
    const a = m.add({ content: "张三是李四的同学", subject: "张三" });
    expect(m.relations("张三", "李四")).toHaveLength(1);
    t = BASE_TIME + 86_400_000; // 第二天才遗忘
    m.forget(a.memory.id);
    expect(m.relations("张三", "李四")).toHaveLength(0);
    // 但历史时点仍可查（软删除的时间语义与记忆本身一致）
    expect(m.relations("张三", "李四", { asOf: BASE_TIME })).toHaveLength(1);
  });

  it("命名空间隔离：a 的关系在 b 里查不到", () => {
    m.add({ content: "张三是李四的同学", subject: "张三", namespace: "a" });
    expect(m.relations("张三", "李四", { namespace: "a" })).toHaveLength(1);
    expect(m.relations("张三", "李四", { namespace: "b" })).toHaveLength(0);
    expect(m.listEntities("b")).toEqual([]);
  });

  it("关库重开后实体与关系都还在（落的是 SQLite，不是内存）", () => {
    m.add({ content: "张三是李四的同学", subject: "张三" });
    m.close();
    const again = new Membrane({ dbPath: `${dir}/g.db`, now: () => t });
    expect(again.relations("张三", "李四")).toHaveLength(1);
    expect(again.listEntities().map((e) => e.name)).toEqual(expect.arrayContaining(["张三", "李四"]));
    again.close();
    // 让 afterEach 的 close 幂等（Storage.close 已幂等）
    m = again;
  });
});

describe("图路融入综合打分", () => {
  it("图路能独立发现候选：全文零重叠，靠关系找回记忆", () => {
    const a = m.add({
      content: "他是我大学同窗",
      subject: "张三",
      relations: [{ from: "张三", to: "李四", predicate: "同学" }],
    });
    const hits = m.recall({ query: "张三和李四是什么关系", limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits.find((h) => h.memory.id === a.memory.id)!;
    expect(top).toBeDefined();
    expect(top.breakdown.rrfText).toBe(0); // 全文没命中
    expect(top.breakdown.graphRank).toBe(1);
    expect(top.breakdown.rrfGraph).toBe(1);
    expect(top.breakdown.graphPaths?.[0]).toContain("同学");
    expect(top.relations?.[0]?.predicate).toBe("同学");
    expect(top.why).toContain("关系第 1 名");
  });

  it("查询里没有实体时图路不干扰（权重归零、分数上界仍是 1.0）", () => {
    m.add({ content: "用户住在北京，今天天气不错", subject: "用户" });
    const hits = m.recall({ query: "天气" });
    expect(hits[0]!.breakdown.rrfGraph).toBe(0);
    expect(hits[0]!.breakdown.weights.graph).toBe(0);
    const sum =
      hits[0]!.breakdown.weights.text +
      hits[0]!.breakdown.weights.vec +
      hits[0]!.breakdown.weights.time +
      hits[0]!.breakdown.weights.conf +
      hits[0]!.breakdown.weights.graph;
    expect(sum).toBeCloseTo(1, 6);
  });

  it("noGraph=true 可以关掉图路", () => {
    m.add({
      content: "他是我大学同窗",
      subject: "张三",
      relations: [{ from: "张三", to: "李四", predicate: "同学" }],
    });
    expect(m.recall({ query: "张三和李四是什么关系", noGraph: true })).toHaveLength(0);
  });

  it("图路候选也遵守 kind 过滤", () => {
    m.add({
      content: "他是我大学同窗",
      subject: "张三",
      kind: "episode",
      relations: [{ from: "张三", to: "李四", predicate: "同学" }],
    });
    expect(m.recall({ query: "张三和李四是什么关系", kind: "episode" }).length).toBe(1);
    expect(m.recall({ query: "张三和李四是什么关系", kind: "fact" }).length).toBe(0);
  });
});
