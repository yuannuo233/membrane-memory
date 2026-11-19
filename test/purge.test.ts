/**
 * embed-purge 审查修复（M-4）测试：切换 embedding 模型不能被旧维度卡死。
 * purge 清空向量与桶索引后，维度守卫从零重新开始——新维度可以直接写入。
 */
import { describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";

describe("embed-purge（审查 M-4）", () => {
  it("purge 清空向量与维度守卫：purge 后可写入新维度", () => {
    const m = new Membrane({ dbPath: ":memory:" });
    m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    expect(m.storage.embeddingDims().has(3)).toBe(true);

    m.storage.purgeEmbeddings();
    expect(m.storage.embeddingDims().size).toBe(0);

    // 换 4 维模型：不再被旧维度卡死
    const current = m.list({});
    expect(current.length).toBeGreaterThan(0);
    m.setVector(current[0]!.id, new Float32Array([1, 0, 0, 0]));
    expect(m.storage.embeddingDims().has(4)).toBe(true);
    m.close();
  });

  it("purge 后向量检索降级为纯全文，不再用旧向量（不报错）", () => {
    const m = new Membrane({ dbPath: ":memory:" });
    m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    m.storage.purgeEmbeddings();
    // 无 queryVec 的召回照常工作（零依赖降级路径）
    const hits = m.recall({ query: "北京" });
    expect(hits.length).toBeGreaterThan(0);
    m.close();
  });
});
