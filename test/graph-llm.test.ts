/**
 * 可选 LLM 关系抽取测试：全部用注入 fetch，不打真网络。
 * 覆盖：正常 JSON、围栏、失败回退规则、空结果回退、手动关系优先。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { extractGraphWithLlm, parseGraphResponse } from "../src/graph-extract-llm.js";
import { MembraneError } from "../src/model.js";
import type { FetchLike } from "../src/llm.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = newTmpDir("graph-llm");
});
afterEach(() => {
  rmDir(dir);
});

const LLM = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
};

function fakeLlm(content: string, calls?: { n: number }): FetchLike {
  return async () => {
    if (calls) calls.n++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
}

function makeMembrane(): Membrane {
  return new Membrane({ dbPath: `${dir}/m.db`, now: () => BASE_TIME, llm: LLM });
}

describe("parseGraphResponse", () => {
  it("纯 JSON", () => {
    expect(parseGraphResponse('{"entities":[],"relations":[]}')).toEqual({ entities: [], relations: [] });
  });
  it("容忍代码围栏和前后废话", () => {
    const raw = '```json\n{"entities":[{"name":"张三"}],"relations":[]}\n```';
    expect(parseGraphResponse(raw)).toHaveProperty("entities");
  });
  it("垃圾输入抛 E_GRAPH_PARSE", () => {
    expect(() => parseGraphResponse("不是 JSON")).toThrow(MembraneError);
  });
});

describe("extractGraphWithLlm", () => {
  it("解析实体和关系，保留 subject 的类型映射", async () => {
    const content = JSON.stringify({
      entities: [
        { name: "张三", type: "person" },
        { name: "李四", type: "person" },
        { name: "北京", type: "place" },
      ],
      relations: [
        { from: "张三", fromType: "person", to: "李四", toType: "person", predicate: "同事" },
        { from: "张三", fromType: "person", to: "北京", toType: "place", predicate: "住在" },
      ],
    });
    const r = await extractGraphWithLlm("张三和李四是同事，住在北京", "张三", "person", LLM, {
      injectFetch: fakeLlm(content),
    });
    expect(r.relations).toHaveLength(2);
    expect(r.relations[0]!.confidence).toBe(0.8);
    expect(r.entities.find((e) => e.name === "北京")!.type).toBe("place");
  });

  it("代词/省略起点映射到 subject；没有 subject 则丢弃", async () => {
    const content = JSON.stringify({
      entities: [{ name: "北京", type: "place" }],
      relations: [{ to: "北京", toType: "place", predicate: "住在" }],
    });
    const withSubject = await extractGraphWithLlm("我住在北京", "用户", "person", LLM, {
      injectFetch: fakeLlm(content),
    });
    expect(withSubject.relations[0]!.from).toBe("用户");
    const noSubject = await extractGraphWithLlm("他住在北京", null, "unknown", LLM, {
      injectFetch: fakeLlm(content),
    });
    expect(noSubject.relations).toHaveLength(0);
  });

  it("HTTP 失败抛 E_GRAPH_HTTP", async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 500, text: async () => "" });
    await expect(extractGraphWithLlm("张三住在北京", "张三", "person", LLM, { injectFetch: bad }))
      .rejects.toMatchObject({ code: "E_GRAPH_HTTP" });
  });
});

describe("addAsync：LLM 关系抽取与回退", () => {
  it("LLM 关系优先于规则，且不再重复抽规则", async () => {
    const m = makeMembrane();
    const llm = JSON.stringify({
      entities: [{ name: "张三", type: "person" }, { name: "李四", type: "person" }],
      relations: [{ from: "张三", fromType: "person", to: "李四", toType: "person", predicate: "同事" }],
    });
    const r = await m.addAsync(
      { content: "张三是李四的同学", subject: "张三", subjectType: "person" },
      { relationExtraction: "llm", injectFetch: fakeLlm(llm) },
    );
    const rels = m.relations("张三", "李四");
    expect(rels).toHaveLength(1);
    expect(rels[0]!.predicate).toBe("同事");
    expect(r.relations).toHaveLength(1);
    m.close();
  });

  it("LLM 失败时回退规则，并在 note 里说明", async () => {
    const m = makeMembrane();
    const bad: FetchLike = async () => ({ ok: false, status: 500, text: async () => "" });
    const r = await m.addAsync(
      { content: "张三是李四的同学", subject: "张三", subjectType: "person" },
      { relationExtraction: "llm", injectFetch: bad },
    );
    const rels = m.relations("张三", "李四");
    expect(rels).toHaveLength(1);
    expect(rels[0]!.predicate).toBe("同学");
    expect(r.note).toContain("回退规则");
    m.close();
  });

  it("LLM 返回空关系时回退规则", async () => {
    const m = makeMembrane();
    await m.addAsync(
      { content: "张三是李四的同学", subject: "张三", subjectType: "person" },
      { relationExtraction: "llm", injectFetch: fakeLlm('{"entities":[],"relations":[]}') },
    );
    expect(m.relations("张三", "李四")[0]!.predicate).toBe("同学");
    m.close();
  });

  it("手动 relations 永远最优先，LLM 根本不该被调用", async () => {
    const m = makeMembrane();
    const calls = { n: 0 };
    const fetch = fakeLlm('{"entities":[],"relations":[{"from":"张三","to":"李四","predicate":"同事"}]}', calls);
    await m.addAsync(
      {
        content: "张三是李四的同学",
        subject: "张三",
        subjectType: "person",
        relations: [{ from: "张三", to: "王五", predicate: "朋友" }],
      },
      { relationExtraction: "llm", injectFetch: fetch },
    );
    expect(calls.n).toBe(0);
    expect(m.relations("张三", "王五")[0]!.predicate).toBe("朋友");
    expect(m.relations("张三", "李四")).toHaveLength(0);
    m.close();
  });
});
