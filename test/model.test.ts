/**
 * 模型校验测试（DESIGN.md 第 3 节：kind 枚举、content 非空、时间戳）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_LENGTH,
  MembraneError,
  normalizeAddInput,
  normalizeSubject,
  normalizeTags,
  validateConfidence,
  validateContent,
  validateKind,
  validateTimestamp,
} from "../src/model.js";
import { BASE_TIME } from "./helpers.js";

describe("model 校验：kind 枚举", () => {
  it("合法 kind 全部通过", () => {
    for (const k of ["fact", "episode", "preference", "procedure"]) {
      expect(() => validateKind(k)).not.toThrow();
    }
  });

  it("非法 kind 报 E_KIND 且中文可读", () => {
    expect(() => validateKind("secret")).toThrowError(MembraneError);
    try {
      validateKind("secret");
    } catch (err) {
      expect((err as MembraneError).code).toBe("E_KIND");
      expect((err as MembraneError).message).toContain("fact");
    }
  });
});

describe("model 校验：content", () => {
  it("非空字符串通过并 trim", () => {
    expect(validateContent("  你好  ")).toBe("你好");
  });

  it("空串/纯空白/非字符串报 E_CONTENT", () => {
    expect(() => validateContent("")).toThrowError(/E_CONTENT|content/);
    expect(() => validateContent("   \n\t ")).toThrowError(/E_CONTENT|content/);
    expect(() => validateContent(42 as unknown as string)).toThrowError(MembraneError);
  });

  it("超长 content 报 E_CONTENT", () => {
    expect(() => validateContent("a".repeat(MAX_CONTENT_LENGTH + 1))).toThrowError(/超长/);
  });
});

describe("model 校验：confidence / 时间戳", () => {
  it("confidence 0~1 通过", () => {
    expect(validateConfidence(0)).toBe(0);
    expect(validateConfidence(1)).toBe(1);
    expect(validateConfidence(0.5)).toBe(0.5);
  });

  it("confidence 越界/NaN 报 E_CONFIDENCE", () => {
    expect(() => validateConfidence(-0.1)).toThrowError(MembraneError);
    expect(() => validateConfidence(1.1)).toThrowError(MembraneError);
    expect(() => validateConfidence(Number.NaN)).toThrowError(MembraneError);
  });

  it("时间戳必须是正整数 unix ms", () => {
    expect(validateTimestamp(BASE_TIME, "at")).toBe(BASE_TIME);
    expect(() => validateTimestamp(0, "at")).toThrowError(MembraneError);
    expect(() => validateTimestamp(-1, "at")).toThrowError(MembraneError);
    expect(() => validateTimestamp(1.5, "at")).toThrowError(MembraneError);
    expect(() => validateTimestamp(Number.POSITIVE_INFINITY, "at")).toThrowError(MembraneError);
  });
});

describe("model 校验：tags / subject 归一化", () => {
  it("tags 去空白、去空项、去重保序", () => {
    expect(normalizeTags([" 工作 ", "工作", "", "生活 ", " 工作"])).toEqual(["工作", "生活"]);
  });

  it("tags 非法类型报 E_TAGS", () => {
    expect(() => normalizeTags("工作" as unknown as string[])).toThrowError(MembraneError);
    expect(() => normalizeTags([1] as unknown as string[])).toThrowError(MembraneError);
  });

  it("subject 空白归一化为 null", () => {
    expect(normalizeSubject(undefined)).toBeNull();
    expect(normalizeSubject(null)).toBeNull();
    expect(normalizeSubject("   ")).toBeNull();
    expect(normalizeSubject(" 用户 ")).toBe("用户");
  });
});

describe("normalizeAddInput：Ingest 的统一入口", () => {
  const defaults = { at: BASE_TIME, source: "cli" };

  it("缺省字段自动补齐（kind=fact、confidence=1、validFrom=at）", () => {
    const n = normalizeAddInput({ content: "用户喜欢北京烤鸭" }, defaults);
    expect(n).toMatchObject({
      content: "用户喜欢北京烤鸭",
      kind: "fact",
      subject: null,
      tags: [],
      confidence: 1,
      source: "cli",
      pin: false,
      validFrom: BASE_TIME,
      at: BASE_TIME,
    });
  });

  it("显式 at / validFrom 生效", () => {
    const n = normalizeAddInput(
      { content: "x", at: BASE_TIME + 100, validFrom: BASE_TIME + 50 },
      defaults,
    );
    expect(n.at).toBe(BASE_TIME + 100);
    expect(n.validFrom).toBe(BASE_TIME + 50);
  });

  it("非法时间戳被拒绝（E_TIME）", () => {
    expect(() => normalizeAddInput({ content: "x", at: 0 }, defaults)).toThrowError(MembraneError);
    expect(() =>
      normalizeAddInput({ content: "x", validFrom: Number.NaN }, defaults),
    ).toThrowError(MembraneError);
  });

  it("显式 source 覆盖默认来源", () => {
    const n = normalizeAddInput({ content: "x", source: "agent:claude" }, defaults);
    expect(n.source).toBe("agent:claude");
  });
});
