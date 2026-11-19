/**
 * 向量检索测试（v0.2 新增）。
 *
 * 覆盖交接文档 5.3 的验收标准：
 *  - 写入带向量 → 立刻能被 queryVec 召回命中
 *  - 不传向量时一切行为与 v0.1 一致（零依赖底线）
 *  - 算向量失败不阻断写入（断网不丢记忆）
 *  - 老库有回填路径（backfillEmbeddings）
 *  - 维度不一致要拦（混用两套 embedding 模型会让余弦恒为 0）
 *  - 大批量向量走分批扫描（内存可控，结果仍正确）
 *
 * 全部离线：embedding 端点用注入的假 fetch 模拟，不打真网络。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Membrane } from "../src/engine.js";
import { MembraneError } from "../src/model.js";
import { BASE_TIME, newTmpDir, rmDir } from "./helpers.js";
import type { LlmConfig } from "../src/types.js";

let dir: string;
let m: Membrane;
let t: number;

/** 假 embedding 端点：按文本里是否含"住"给两套正交向量，确定性、可断言 */
function fakeEmbedFetch(record?: string[]): (url: string, init?: { body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}> {
  return async (url, init) => {
    expect(url).toContain("/embeddings");
    const body = JSON.parse(init?.body ?? "{}") as { input?: string | string[] };
    const input = Array.isArray(body.input) ? (body.input[0] ?? "") : (body.input ?? "");
    if (record) record.push(input);
    const vec = /住/.test(input) ? [1, 0, 0] : [0, 1, 0];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ embedding: vec }] }),
    };
  };
}

const llm: LlmConfig = {
  baseUrl: "https://fake.example/v1",
  apiKey: "k",
  model: "chat-model",
  embeddingModel: "embed-model",
};

beforeEach(() => {
  dir = newTmpDir("vector");
  t = BASE_TIME;
  m = new Membrane({ dbPath: `${dir}/m.db`, now: () => t });
});

afterEach(() => {
  m.close();
  rmDir(dir);
});

describe("向量：同步写入（预先算好的向量）", () => {
  it("add 带 vec → 同一事务落库，queryVec 能纯向量命中", () => {
    const a = m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    expect(a.embeddingStatus).toBe("stored");
    // 查询词故意和记忆没有词面重叠，逼向量路独立发现候选
    const hits = m.recall({ query: "zzzz-vector-only-zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.id).toBe(a.memory.id);
    expect(hits[0]!.breakdown.vecSim).toBeCloseTo(1, 5);
    expect(hits[0]!.breakdown.vecRank).toBe(1);
    expect(hits[0]!.breakdown.rrfVec).toBe(1);
  });

  it("LSH 桶索引：200 条向量仍命中目标，且与精确全扫 top-1 一致", () => {
    const vecOf = (i: number): Float32Array => {
      const v = new Float32Array(16);
      let x = (i + 1) * 2654435761 >>> 0;
      for (let k = 0; k < 16; k++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        v[k] = (x / 4294967296) - 0.5;
      }
      return v;
    };
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      ids.push(m.add({ content: `LSH 测试记忆 ${i}`, subject: `用户${i}`, vec: vecOf(i) }).memory.id);
    }
    const q = vecOf(100);
    const fast = m.recall({ query: "zzzz-qwerty", queryVec: q, limit: 5 });
    const exact = m.recall({ query: "zzzz-qwerty", queryVec: q, limit: 5, exactVectorSearch: true });
    expect(fast[0]!.memory.id).toBe(ids[100]);
    expect(exact[0]!.memory.id).toBe(ids[100]);
  });

  it("不传 vec 时 embeddingStatus=none，行为与纯全文完全一致（零依赖底线）", () => {
    const a = m.add({ content: "用户住在北京", subject: "用户" });
    expect(a.embeddingStatus).toBe("none");
    const hits = m.recall({ query: "北京" });
    expect(hits[0]!.breakdown.rrfVec).toBe(0);
    expect(hits[0]!.breakdown.vecSim).toBeNull();
    expect(hits[0]!.breakdown.weights.vec).toBe(0);
  });

  it("add 的 vec 也支持 number[]（REST/MCP 传 JSON 数组）", () => {
    const a = m.add({ content: "用户住在上海", subject: "用户", vec: [0, 0, 1] });
    expect(a.embeddingStatus).toBe("stored");
    expect(m.storage.getEmbedding(a.memory.id)?.length).toBe(3);
  });

  it("维度与库内已有向量不一致 → 跳过落库并说明（不阻断写入）", () => {
    m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    const b = m.add({ content: "用户喜欢喝咖啡", subject: "用户", vec: new Float32Array([0, 1, 0, 0]) });
    expect(b.status).toBe("created");
    expect(b.embeddingStatus).toBe("skipped");
    expect(b.note).toContain("维度");
    expect(m.storage.getEmbedding(b.memory.id)).toBeNull();
  });

  it("setVector：非法维度拒绝、正常维度写入", () => {
    const a = m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    expect(() => m.setVector(a.memory.id, new Float32Array([1, 0]))).toThrow(MembraneError);
    const b = m.add({ content: "用户喜欢咖啡", subject: "用户" });
    m.setVector(b.memory.id, new Float32Array([0, 1, 0]));
    expect(m.storage.getEmbedding(b.memory.id)?.length).toBe(3);
    expect(() => m.setVector("不存在的id", [1, 0, 0])).toThrow(MembraneError);
  });
});

describe("向量：异步写入（自动算向量）", () => {
  it("addAsync 配了 embeddingModel → 自动算向量并落库，recallAsync 能命中", async () => {
    const engine = new Membrane({ dbPath: `${dir}/auto.db`, now: () => t, llm });
    try {
      const a = await engine.addAsync({ content: "用户住在北京", subject: "用户" }, { injectFetch: fakeEmbedFetch() });
      expect(a.embeddingStatus).toBe("stored");
      expect(engine.storage.getEmbedding(a.memory.id)?.length).toBe(3);

      const hits = await engine.recallAsync({ query: "他现在住哪儿", injectFetch: fakeEmbedFetch() });
      expect(hits[0]!.memory.id).toBe(a.memory.id);
      expect(hits[0]!.breakdown.vecSim).toBeCloseTo(1, 5);
    } finally {
      engine.close();
    }
  });

  it("算向量失败（断网/端点 500）→ 记忆照样写进去，note 里说明", async () => {
    const engine = new Membrane({ dbPath: `${dir}/fail.db`, now: () => t, llm });
    const failing = async (): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      throw new Error("connect ECONNREFUSED（示例：网断了）");
    };
    const a = await engine.addAsync({ content: "用户住在北京", subject: "用户" }, { injectFetch: failing as never });
    expect(a.status).toBe("created");
    expect(a.embeddingStatus).toBe("none");
    expect(a.note).toContain("向量计算失败");
    expect(engine.stats().total).toBe(1);
    expect(engine.storage.getEmbedding(a.memory.id)).toBeNull();
    engine.close();
  });

  it("没配 embeddingModel 时 addAsync 等价于 add（不联网、不报错）", async () => {
    const a = await m.addAsync({ content: "用户住在北京", subject: "用户" });
    expect(a.embeddingStatus).toBe("none");
  });

  it("embed:false 显式关掉自动算向量", async () => {
    const engine = new Membrane({ dbPath: `${dir}/off.db`, now: () => t, llm });
    const a = await engine.addAsync(
      { content: "用户住在北京", subject: "用户" },
      { embed: false, injectFetch: fakeEmbedFetch() },
    );
    expect(a.embeddingStatus).toBe("none");
    engine.close();
  });
});

describe("向量：老库回填", () => {
  it("backfillEmbeddings 只补缺向量的现行记忆，第二次是 0 条", async () => {
    m.add({ content: "用户住在北京", subject: "用户" }); // 老数据，没有向量
    m.add({ content: "用户喜欢喝咖啡", subject: "用户" });
    const withVec = m.add({ content: "用户会弹钢琴", subject: "用户", vec: new Float32Array([1, 0, 0]) });
    expect(withVec.embeddingStatus).toBe("stored");

    const engine = new Membrane({ dbPath: `${dir}/m.db`, now: () => t, llm });
    const r1 = await engine.backfillEmbeddings({ injectFetch: fakeEmbedFetch() });
    expect(r1.total).toBe(2); // 只补两条没向量的
    expect(r1.embedded).toBe(2);
    expect(r1.failed).toBe(0);

    const r2 = await engine.backfillEmbeddings({ injectFetch: fakeEmbedFetch() });
    expect(r2.total).toBe(0);
    engine.close();
  });

  it("回填时端点全挂 → 全部记为失败，不抛（数据没坏）", async () => {
    m.add({ content: "用户住在北京", subject: "用户" });
    const engine = new Membrane({ dbPath: `${dir}/m.db`, now: () => t, llm });
    const failing = async (): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
      throw new Error("timeout");
    };
    const r = await engine.backfillEmbeddings({ injectFetch: failing as never });
    expect(r.total).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toContain("timeout");
    engine.close();
  });

  it("没配 embeddingModel → 回填抛明确中文错误", async () => {
    await expect(m.backfillEmbeddings()).rejects.toThrow(MembraneError);
    await expect(m.backfillEmbeddings()).rejects.toThrow(/embedding 模型/);
  });
});

describe("向量：分批扫描与过滤", () => {
  it("batchSize 很小时 top-K 仍正确（分批扫描不丢结果）", () => {
    // 每条给不同主语，避免互相"取代"导致只剩一条现行；向量角度随 i 递增，i=29 最接近查询
    for (let i = 0; i < 30; i++) {
      m.add({ content: `编号${i}的记忆`, subject: `用户${i}`, vec: new Float32Array([1, i + 1, 0]) });
    }
    const top = m.recall({ query: "zzzz-batch-zzzz", queryVec: new Float32Array([1, 30, 0]), limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]!.memory.content).toContain("编号29");
    // 直接用 storage 的分批接口验证一次（batchSize=7 会切 5 批）
    let scanned = 0;
    m.storage.scanEmbeddings({ namespace: "default", batchSize: 7 }, (items) => {
      scanned += items.length;
    });
    expect(scanned).toBe(30);
  });

  it("向量检索遵守命名空间隔离（不跨租户）", () => {
    const a = m.add({ content: "甲公司住址", namespace: "a", vec: new Float32Array([1, 0, 0]) });
    m.add({ content: "乙公司住址", namespace: "b", vec: new Float32Array([1, 0, 0]) });
    const hits = m.recall({ query: "zzzz-ns-zzzz", queryVec: new Float32Array([1, 0, 0]), namespace: "a" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.id).toBe(a.memory.id);
  });

  it("被取代的记忆不会通过向量路召回（现行过滤在 SQL 里做）", () => {
    m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]), at: BASE_TIME });
    const b = m.add({
      content: "用户住在上海",
      subject: "用户",
      vec: new Float32Array([1, 0, 0]),
      at: BASE_TIME + 86_400_000,
    });
    expect(b.status).toBe("superseded");
    const hits = m.recall({ query: "zzzz-super-zzzz", queryVec: new Float32Array([1, 0, 0]) });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.content).toContain("上海");
  });

  it("asOf 历史时点 + 向量：能查到当时有效的那条", () => {
    m.add({ content: "用户住在北京", subject: "用户", vec: new Float32Array([1, 0, 0]), at: BASE_TIME });
    m.add({
      content: "用户住在上海",
      subject: "用户",
      vec: new Float32Array([1, 0, 0]),
      at: BASE_TIME + 86_400_000,
    });
    const past = m.recall({
      query: "zzzz-asof-zzzz",
      queryVec: new Float32Array([1, 0, 0]),
      asOf: BASE_TIME,
    });
    expect(past).toHaveLength(1);
    expect(past[0]!.memory.content).toContain("北京");
  });
});
