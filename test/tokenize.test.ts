/**
 * 分词口径测试：中文标点必须"透明"，不能把 bigram 切断，也不能自己变成检索单元。
 * 这些用例对应真实召回 bug：带标点的记忆 vs 不带标点的查询，AND 精确检索失败。
 */
import { describe, expect, it } from "vitest";
import { fuzzyUnits, tokenize, tokenOverlap, tokenSet } from "../src/tokenize.js";

describe("中文分词：标点归一", () => {
  it("句号不进入 token，也不污染 bigram", () => {
    expect(tokenize("用户住在北京。")).toEqual(["用户", "户住", "住在", "在北", "北京"]);
  });

  it("全角逗号/顿号/书名号不切断 bigram", () => {
    expect(tokenize("用户，住在北京")).toEqual(["用户", "户住", "住在", "在北", "北京"]);
    expect(tokenize("《北京》")).toEqual(["北京"]);
  });

  it("fuzzyUnits 不把中文标点当检索单元", () => {
    const units = fuzzyUnits("用户住在北京。");
    expect(units.has("。")).toBe(false);
    expect(units.has("京")).toBe(true);
  });

  it("短句不能靠包含关系拿到 1.0 相似度", () => {
    const short = tokenSet("北京市");
    const long = tokenSet("用户住在北京市海淀区");
    expect(tokenOverlap(short, long)).toBeLessThan(0.35);
    // 同长度、只换一个地名仍应落取代带（0.6）
    expect(tokenOverlap(tokenSet("用户住在北京"), tokenSet("用户住在上海"))).toBeGreaterThan(0.55);
  });
});
