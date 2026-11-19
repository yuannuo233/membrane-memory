/**
 * 记忆编辑（版本化更新）测试。
 *
 * 编辑不是"改数据库行"，而是"产生新版本并把旧版本取代"：
 * 这样历史、证据、关系都不会因为一次手滑而消失。
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Membrane } from "../src/engine.js";
import { MembraneError } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

const DAY = 86_400_000;
let dir: string;

afterEach(() => {
  if (dir) rmDir(dir);
});

function makeEngine(): { m: Membrane; clock: { value: number } } {
  dir = newTmpDir("update");
  const clock = { value: BASE_TIME };
  const m = new Membrane({ dbPath: join(dir, "m.db"), now: () => clock.value });
  return { m, clock };
}

describe("Membrane.update：版本化编辑", () => {
  it("改正文 → 新版本生效，旧版本 superseded，内容与历史都对", () => {
    const { m, clock } = makeEngine();
    const first = m.add({ content: "用户住在北京", subject: "用户", kind: "fact", at: BASE_TIME });
    clock.value = BASE_TIME + DAY;
    const up = m.update(first.memory.id, { content: "用户住在上海" });

    expect(up.status).toBe("created");
    expect(up.memory.content).toBe("用户住在上海");
    expect(up.superseded[0]!.id).toBe(first.memory.id);
    expect(m.get(first.memory.id)!.validTo).toBe(BASE_TIME + DAY);
    expect(m.get(first.memory.id)!.supersededBy).toBe(up.memory.id);

    // 现行只看到新值
    expect(m.recall({ query: "上海", limit: 3 })[0]?.memory.content).toContain("上海");
    // 历史时点仍能看到旧值
    const old = m.recall({ query: "北京", asOf: BASE_TIME + 1, limit: 3 });
    expect(old.some((h) => h.memory.content.includes("北京"))).toBe(true);
    // 审计链两条：新版本 add(editOf) + 旧版本 supersede
    expect(m.history(first.memory.id).some((h) => h.op === "supersede")).toBe(true);
    expect(m.history(up.memory.id).some((h) => h.op === "add")).toBe(true);
    m.close();
  });

  it("证据默认沿用旧版本（编辑正文不等于丢掉出处）", () => {
    const { m, clock } = makeEngine();
    const first = m.add({
      content: "用户住在北京",
      subject: "用户",
      evidence: ["用户原话：我住北京"],
      at: BASE_TIME,
    });
    clock.value = BASE_TIME + DAY;
    const up = m.update(first.memory.id, { content: "用户住在北京市朝阳区" });
    expect(m.evidence(up.memory.id)).toEqual([{ quote: "用户原话：我住北京", at: BASE_TIME }]);
    m.close();
  });

  it("只改元数据（标签/pin）也留版本，并沿用旧向量", () => {
    const { m, clock } = makeEngine();
    const first = m.add({
      content: "用户喜欢喝绿茶",
      subject: "用户",
      kind: "preference",
      vec: [1, 0, 0],
      tags: ["饮食"],
      at: BASE_TIME,
    });
    clock.value = BASE_TIME + DAY;
    const up = m.update(first.memory.id, { tags: ["饮食", "茶"], pin: true });
    expect(up.memory.tags).toEqual(["饮食", "茶"]);
    expect(up.memory.pin).toBe(true);
    // 正文没变 → 向量必须还在，否则一次改标签就把语义检索废了
    expect(m.storage.getEmbedding(up.memory.id)).not.toBeNull();
    m.close();
  });

  it("内容完全没变时返回 duplicate，不制造无意义版本", () => {
    const { m } = makeEngine();
    const first = m.add({ content: "用户养了一只猫", subject: "用户", at: BASE_TIME });
    const up = m.update(first.memory.id, { content: "用户养了一只猫" });
    expect(up.status).toBe("duplicate");
    expect(m.stats().total).toBe(1);
    m.close();
  });

  it("已遗忘 / 已被取代的记忆拒绝编辑（明确错误码）", () => {
    const { m, clock } = makeEngine();
    const gone = m.add({ content: "临时记忆", at: BASE_TIME });
    clock.value = BASE_TIME + DAY;
    m.forget(gone.memory.id);
    expect(() => m.update(gone.memory.id, { content: "改一下" })).toThrow(MembraneError);
    expect(() => m.update(gone.memory.id, { content: "改一下" })).toThrow(/已被遗忘/);

    const old = m.add({ content: "用户住在北京", subject: "用户", at: BASE_TIME });
    const up = m.update(old.memory.id, { content: "用户住在上海" });
    expect(() => m.update(old.memory.id, { content: "再改" })).toThrow(/已被取代/);
    expect(up.memory.id).not.toBe(old.memory.id);
    m.close();
  });

  it("改关系标注 → 旧关系关闭（asOf 仍可查），新关系生效", () => {
    const { m, clock } = makeEngine();
    const first = m.add({
      content: "张三是李四的同学",
      subject: "张三",
      at: BASE_TIME,
      relations: [{ to: "李四", predicate: "同学" }],
    });
    clock.value = BASE_TIME + DAY;
    m.update(first.memory.id, {
      content: "张三是王五的同学",
      relations: [{ to: "王五", predicate: "同学" }],
    });

    expect(m.relations("张三", "李四")).toEqual([]); // 现行：旧关系已关闭
    expect(m.relations("张三", "王五").length).toBeGreaterThan(0); // 新关系生效
    const historical = m.relations("张三", "李四", { asOf: BASE_TIME + 1 });
    expect(historical.length).toBeGreaterThan(0); // 历史：旧关系还在
    m.close();
  });
});
