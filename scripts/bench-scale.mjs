/**
 * 10 万级规模压测（可复现、无外部依赖）。
 *
 * 目的：回答"1 万条以上向量检索会不会线性变慢"，并给优化前后一个同一口径的数字。
 *
 * 用法：
 *   node scripts/bench-scale.mjs --count 100000 --dim 1536 --queries 30
 *   node scripts/bench-scale.mjs --count 10000 --dim 1536 --queries 10 --keep-db
 *
 * 口径：
 * - 写入：直接走 Storage.insert + upsertEmbedding，绕开 add() 的冲突检测/图抽取，
 *   只测"存 + 索引"的吞吐（真实 add() 还会做冲突检测，写入会更慢，见 README 口径说明）。
 * - 查询：Membrane.recall()，分别测纯全文、纯向量、混合三档；
 *   纯向量用 query="zzzz-no-text" 保证 FTS 不命中，只走向量路。
 * - 向量是确定性伪随机（同一 index 每次生成同一向量），查询向量取第 count/2 条的精确向量，
 *   因此可以同时验证"top-1 是否真的是目标"，不只是测时间。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../dist/storage.js";
import { Membrane } from "../dist/engine.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}

const countArg = Number(arg("count", 100_000));
const queries = Number(arg("queries", 20));
const keepDb = arg("keep-db", false) === true;
const reuse = arg("reuse", false) === true;
const exact = arg("exact", false) === true;
const recall = arg("recall", false) === true;
const recallQueries = Number(arg("recall-queries", 3));
const recallK = Number(arg("recall-k", 100));
const batchLog = Number(arg("log-every", 20_000));
const vectorsPath = arg("vectors", null);
const queryVectorsPath = arg("query-vectors", null);

/** 真实向量入口：JSONL，一行 {"id","vec","content","subject","namespace"} */
function readJsonl(path) {
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function toVec(raw, where) {
  if (!Array.isArray(raw) || raw.length < 8) throw new Error(`${where} 的 vec 必须是长度 ≥8 的数组`);
  const vec = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const x = Number(raw[i]);
    if (!Number.isFinite(x)) throw new Error(`${where} 的 vec[${i}] 不是有限数字`);
    vec[i] = x;
  }
  return vec;
}

let realRows = null;
let queryVecs = null;
let count = countArg;
let dim = Number(arg("dim", 1536));
if (vectorsPath) {
  realRows = readJsonl(resolve(root, vectorsPath));
  if (realRows.length < 2) throw new Error("--vectors 至少需要 2 行");
  realRows = realRows.map((row, i) => {
    if (!row || typeof row !== "object") throw new Error(`--vectors 第 ${i + 1} 行不是对象`);
    const vec = toVec(row.vec, `--vectors 第 ${i + 1} 行`);
    return { ...row, id: String(row.id ?? `real-${i}`), vec };
  });
  dim = realRows[0].vec.length;
  if (realRows.some((r) => r.vec.length !== dim)) throw new Error("--vectors 里向量维度不一致");
  const ns = String(realRows[0].namespace ?? "bench");
  if (realRows.some((r) => String(r.namespace ?? "bench") !== ns)) {
    throw new Error("--vectors 必须同属一个 namespace（压测查询只打一个命名空间）");
  }
  count = realRows.length;
}
if (queryVectorsPath) {
  queryVecs = readJsonl(resolve(root, queryVectorsPath)).map((row, i) => {
    const raw = Array.isArray(row) ? row : row?.vec ?? row?.queryVec;
    return toVec(raw, `--query-vectors 第 ${i + 1} 行`);
  });
  if (queryVecs.length === 0) throw new Error("--query-vectors 为空");
  if (queryVecs.some((v) => v.length !== dim)) throw new Error("--query-vectors 维度与库不一致");
}

if (!Number.isInteger(count) || count < (realRows ? 2 : 1000)) throw new Error("--count 至少 1000（或用 --vectors 提供 ≥2 行）");
if (!Number.isInteger(dim) || dim < 8) throw new Error("--dim 至少 8");
if (!Number.isInteger(recallQueries) || recallQueries < 1) throw new Error("--recall-queries 至少 1");
if (!Number.isInteger(recallK) || recallK < 10) throw new Error("--recall-k 至少 10");

const benchDir = join(root, ".bench");
mkdirSync(benchDir, { recursive: true });
const dbArg = arg("db", null);
const dbPath = dbArg
  ? resolve(root, dbArg)
  : join(
      benchDir,
      realRows
        ? `real-${basename(vectorsPath).replace(/[^\w.-]+/g, "_")}-${count}-${dim}.db`
        : `scale-${count}-${dim}.db`,
    );
const canReuse = reuse && existsSync(dbPath);
if (!canReuse) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/** 50 个语义簇的中心（确定性，保证每次压测数据一致） */
const CLUSTERS = 50;
const centers = Array.from({ length: CLUSTERS }, (_, c) => {
  const v = new Float32Array(dim);
  let x = (c + 1) * 2654435761 >>> 0;
  for (let k = 0; k < dim; k++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    v[k] = (x / 4294967296) - 0.5;
  }
  return v;
});

/**
 * 确定性向量：第 i 条 = 第 i%50 个簇中心 + 12% 噪声。
 * 这样真实近邻（同簇）存在，才能验证 ANN 的 recall，而不是拿
 * "高维随机向量互相都正交"的数据自欺欺人。
 */
function vecFor(i, d) {
  const center = centers[i % CLUSTERS];
  const v = new Float32Array(d);
  let x = (i + 1) * 2654435761 >>> 0;
  for (let k = 0; k < d; k++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    v[k] = center[k] + ((x / 4294967296) - 0.5) * 0.12;
  }
  return v;
}

/** 给查询向量加确定性噪声，模拟"真实查询和记忆不完全一样" */
function perturb(vec, ratio, seed) {
  const out = new Float32Array(vec.length);
  let x = (seed + 1) * 2654435761 >>> 0;
  for (let k = 0; k < vec.length; k++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[k] = vec[k] + ((x / 4294967296) - 0.5) * ratio;
  }
  return out;
}

const benchNamespace = realRows ? String(realRows[0].namespace ?? "bench") : "bench";
const now = Date.now();
const target = Math.floor(count / 2);
const targetId = realRows ? String(realRows[target].id) : `bench-${target}`;
const targetVec = realRows ? realRows[target].vec : vecFor(target, dim);

let seedMs = 0;
if (!canReuse) {
  const storage = new Storage(dbPath);
  const seedStart = performance.now();
  storage.transaction(() => {
    for (let i = 0; i < count; i++) {
      const row = realRows?.[i];
      const id = row ? String(row.id) : `bench-${i}`;
      const t = now - (count - i) * 1000;
      storage.insert({
        id,
        kind: "fact",
        content: row?.content
          ? String(row.content)
          : `压测记忆 ${i} 关于主题 ${i % 50}，用户编号 ${i % 1000}`,
        subject: row?.subject ? String(row.subject) : `用户${i % 1000}`,
        tags: [],
        confidence: 1,
        source: row?.source ? String(row.source) : realRows ? "real-vectors" : "bench",
        namespace: row?.namespace ? String(row.namespace) : "bench",
        createdAt: t,
        updatedAt: t,
        validFrom: t,
        validTo: null,
        supersededBy: null,
        deleted: false,
        pin: false,
      });
      storage.upsertEmbedding(id, row ? row.vec : vecFor(i, dim));
      if (batchLog > 0 && (i + 1) % batchLog === 0) {
        const secs = (performance.now() - seedStart) / 1000;
        console.log(`  seed ${i + 1}/${count}  ${secs.toFixed(1)}s`);
      }
    }
  });
  seedMs = performance.now() - seedStart;
  storage.close();
} else {
  console.log("  reuse 已存在的库，跳过写入（只测查询）");
}

const fileBytes = statSync(dbPath).size;

const m = new Membrane({ dbPath, now: () => now });
// 预热：第一次查询可能触发老库的 LSH 补建 / 页缓存冷启动，不把它算进 p95
m.recall({ query: "zzzz-no-text", namespace: benchNamespace, limit: 10, queryVec: targetVec });
const bench = (label, fn) => {
  const times = [];
  let last = null;
  for (let q = 0; q < queries; q++) {
    const t0 = performance.now();
    last = fn(q);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1];
  console.log(
    `  ${label.padEnd(12)} avg ${avg.toFixed(1).padStart(8)} ms   p50 ${p50.toFixed(1).padStart(8)} ms   p95 ${p95.toFixed(1).padStart(8)} ms`,
  );
  return { avgMs: avg, p50Ms: p50, p95Ms: p95, last };
};

console.log(`\n=== Membrane 规模压测 ===`);
console.log(`count=${count} dim=${dim} queries=${queries} db=${dbPath}`);
console.log(`seed           ${(seedMs / 1000).toFixed(1)} s   (${(count / (seedMs / 1000)).toFixed(0)} 条/s)`);
console.log(`db size        ${(fileBytes / 1024 / 1024).toFixed(1)} MB`);

const ftsOnly = bench("fts-only", () => m.recall({ query: "压测记忆", namespace: benchNamespace, limit: 10 }));
const vecOnly = bench("vector-only", (q) =>
  m.recall({
    query: "zzzz-no-text",
    namespace: benchNamespace,
    limit: 10,
    queryVec: queryVecs ? queryVecs[q % queryVecs.length] : targetVec,
    exactVectorSearch: exact,
  }),
);
const hybrid = bench("hybrid", (q) =>
  m.recall({
    query: "压测记忆 关于主题",
    namespace: benchNamespace,
    limit: 10,
    queryVec: queryVecs ? queryVecs[q % queryVecs.length] : targetVec,
    exactVectorSearch: exact,
  }),
);

const vecTop = vecOnly.last?.[0]?.memory;
console.log(`vector top-1  ${vecTop?.id === targetId ? "命中目标 ✓" : `未命中（${vecTop?.id ?? "空"}）`}`);

// 召回质量：同一查询向量分别走 LSH 和精确全扫，比较 top-10/top-100 重合率。
// 这不是"LSH 一定不准"的证明，而是给真实数据对账提供一个可复现口径。
let recallMeasured = null;
if (recall) {
  const overlap10 = [];
  const overlap100 = [];
  const exactMs = [];
  const fastMs = [];
  console.log(`\n  recall@k  （${recallQueries} 个带 15% 噪声的查询，k=${recallK}）`);
  for (let q = 0; q < recallQueries; q++) {
    const qi = (target + q * 7919) % count;
    const qv = queryVecs ? queryVecs[q % queryVecs.length] : perturb(vecFor(qi, dim), 0.15, qi + 999);
    const t0 = performance.now();
    const exactHits = m.recall({
      query: "zzzz-no-text",
      namespace: benchNamespace,
      limit: recallK,
      queryVec: qv,
      exactVectorSearch: true,
    });
    exactMs.push(performance.now() - t0);
    const t1 = performance.now();
    const fastHits = m.recall({
      query: "zzzz-no-text",
      namespace: benchNamespace,
      limit: recallK,
      queryVec: qv,
    });
    fastMs.push(performance.now() - t1);
    const exactIds = new Set(exactHits.map((h) => h.memory.id));
    const fastIds = fastHits.map((h) => h.memory.id);
    const top10Fast = fastIds.slice(0, 10);
    const top100Fast = fastIds.slice(0, recallK);
    overlap10.push(top10Fast.filter((id) => exactIds.has(id)).length / Math.min(10, exactIds.size));
    overlap100.push(top100Fast.filter((id) => exactIds.has(id)).length / Math.min(recallK, exactIds.size));
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  recallMeasured = {
    k: recallK,
    queries: recallQueries,
    recallAt10: avg(overlap10),
    recallAtK: avg(overlap100),
    exactAvgMs: avg(exactMs),
    lshAvgMs: avg(fastMs),
  };
  console.log(`  recall@10  ${(recallMeasured.recallAt10 * 100).toFixed(1)}%`);
  console.log(`  recall@${recallK}   ${(recallMeasured.recallAtK * 100).toFixed(1)}%`);
  console.log(`  精确全扫 avg ${exactMs.reduce((a, b) => a + b, 0).toFixed(1)} ms   LSH avg ${fastMs.reduce((a, b) => a + b, 0).toFixed(1)} ms`);
}

const result = {
  generatedAt: new Date().toISOString(),
  source: realRows ? "real-vectors" : "synthetic",
  namespace: benchNamespace,
  count,
  dim,
  queries,
  exactVectorSearch: exact,
  recall: recallMeasured,
  seedSeconds: seedMs / 1000,
  seedPerSecond: seedMs === 0 ? null : count / (seedMs / 1000),
  dbBytes: fileBytes,
  ftsOnly: { avgMs: ftsOnly.avgMs, p50Ms: ftsOnly.p50Ms, p95Ms: ftsOnly.p95Ms },
  vectorOnly: { avgMs: vecOnly.avgMs, p50Ms: vecOnly.p50Ms, p95Ms: vecOnly.p95Ms, top1Hit: vecTop?.id === targetId },
  hybrid: { avgMs: hybrid.avgMs, p50Ms: hybrid.p50Ms, p95Ms: hybrid.p95Ms },
  rssBytes: process.memoryUsage().rss,
};
writeFileSync(join(benchDir, `result-${count}-${dim}.json`), JSON.stringify(result, null, 2));
console.log(`result         ${join(".bench", `result-${count}-${dim}.json`)}`);

m.close();
if (!keepDb) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  console.log("db            已删除（--keep-db 可保留）");
}
