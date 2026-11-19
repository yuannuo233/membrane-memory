/**
 * 抽取模式测试：全用注入的假 fetch，不打真网络（DESIGN.md 第 9 节零外发底线）。
 * 覆盖：JSON 解析（围栏/废话容忍）、无 LLM 降级、脏候选跳过、HTTP 错误。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { extract, parseCandidates } from "../src/extract.js";
import type { FetchLike } from "../src/extract.js";
import { MembraneError } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = newTmpDir("extract");
});
afterEach(() => {
  rmDir(dir);
});

function makeMembrane(withLlm: boolean): Membrane {
  return new Membrane({
    dbPath: `${dir}/m.db`,
    now: () => BASE_TIME,
    llm: withLlm
      ? { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "test-model" }
      : undefined,
  });
}

/** 造一个假 fetch：返回指定 content 作为 LLM 答复 */
function fakeFetch(content: string): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content } }] }),
  });
}

describe("parseCandidates：稳健解析", () => {
  it("纯 JSON 数组", () => {
    expect(parseCandidates('[{"kind":"fact","content":"x"}]')).toHaveLength(1);
  });
  it("容忍 markdown 代码围栏", () => {
    const raw = '```json\n[{"content":"用户喜欢猫"}]\n```';
    expect(parseCandidates(raw)[0]!.content).toBe("用户喜欢猫");
  });
  it("容忍数组外的说明文字", () => {
    const raw = '好的，结果如下：[{"content":"用户住在北京"}] 以上。';
    expect(parseCandidates(raw)[0]!.content).toBe("用户住在北京");
  });
  it("垃圾输入抛 E_EXTRACT_PARSE", () => {
    expect(() => parseCandidates("完全不是 json")).toThrow(MembraneError);
  });
});

describe("extract：抽取入库", () => {
  it("无 LLM 配置时抛 E_NO_LLM（零依赖降级底线）", async () => {
    const m = makeMembrane(false);
    await expect(extract(m, "一段对话")).rejects.toMatchObject({ code: "E_NO_LLM" });
    m.close();
  });

  it("正常抽取：候选逐条入库，返回 added", async () => {
    const m = makeMembrane(true);
    const content = JSON.stringify([
      { kind: "preference", subject: "用户", content: "用户喜欢喝绿茶", tags: ["饮食"] },
      { kind: "fact", subject: "用户", content: "用户住在广州" },
    ]);
    const r = await extract(m, "对话文本", { injectFetch: fakeFetch(content) });
    expect(r.added).toHaveLength(2);
    expect(r.candidates).toHaveLength(2);
    expect(m.stats().current).toBe(2);
    m.close();
  });

  it("脏候选（content 空 / kind 非法）被跳过，不中断整批", async () => {
    const m = makeMembrane(true);
    const content = JSON.stringify([
      { kind: "fact", content: "" },
      { kind: "外星类型", content: "这条 kind 非法" },
      { kind: "fact", subject: "用户", content: "用户养了一只猫" },
    ]);
    const r = await extract(m, "对话", { injectFetch: fakeFetch(content) });
    expect(r.added).toHaveLength(1);
    expect(r.skipped).toHaveLength(2);
    m.close();
  });

  it("空数组候选：什么也不存", async () => {
    const m = makeMembrane(true);
    const r = await extract(m, "没啥可记的", { injectFetch: fakeFetch("[]") });
    expect(r.added).toHaveLength(0);
    expect(m.stats().total).toBe(0);
    m.close();
  });

  it("HTTP 错误抛 E_EXTRACT_HTTP", async () => {
    const m = makeMembrane(true);
    const badFetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => "" });
    await expect(extract(m, "对话", { injectFetch: badFetch })).rejects.toMatchObject({
      code: "E_EXTRACT_HTTP",
    });
    m.close();
  });
});
