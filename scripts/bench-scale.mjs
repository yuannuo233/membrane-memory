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
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const count = Number(arg("count", 100_000));
const dim = Number(arg("dim", 1536));
const queries = Number(arg("queries", 20));
const keepDb = arg("keep-db", false) === true;
const reuse = arg("reuse", false) === true;
const exact = arg("exact", false) === true;
const batchLog = Number(arg("log-every", 20_000));

if (!Number.isInteger(count) || count < 1000) throw new Error("--count 至少 1000");
if (!Number.isInteger(dim) || dim < 8) throw new Error("--dim 至少 8");

const benchDir = join(root, ".bench");
mkdirSync(benchDir, { recursive: true });
const dbPath = join(benchDir, `scale-${count}-${dim}.db`);
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

const now = Date.now();
const target = Math.floor(count / 2);
const targetId = `bench-${target}`;
const targetVec = vecFor(target, dim);

let seedMs = 0;
if (!canReuse) {
  const storage = new Storage(dbPath);
  const seedStart = performance.now();
  storage.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `bench-${i}`;
      const t = now - (count - i) * 1000;
      storage.insert({
        id,
        kind: "fact",
        content: `压测记忆 ${i} 关于主题 ${i % 50}，用户编号 ${i % 1000}`,
        subject: `用户${i % 1000}`,
        tags: [],
        confidence: 1,
        source: "bench",
        namespace: "bench",
        createdAt: t,
        updatedAt: t,
        validFrom: t,
        validTo: null,
        supersededBy: null,
        deleted: false,
        pin: false,
      });
      storage.upsertEmbedding(id, vecFor(i, dim));
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
m.recall({ query: "zzzz-no-text", namespace: "bench", limit: 10, queryVec: targetVec });
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

const ftsOnly = bench("fts-only", () => m.recall({ query: "压测记忆", namespace: "bench", limit: 10 }));
const vecOnly = bench("vector-only", () =>
  m.recall({ query: "zzzz-no-text", namespace: "bench", limit: 10, queryVec: targetVec, exactVectorSearch: exact }),
);
const hybrid = bench("hybrid", () =>
  m.recall({ query: "压测记忆 关于主题", namespace: "bench", limit: 10, queryVec: targetVec, exactVectorSearch: exact }),
);

const vecTop = vecOnly.last?.[0]?.memory;
console.log(`vector top-1  ${vecTop?.id === targetId ? "命中目标 ✓" : `未命中（${vecTop?.id ?? "空"}）`}`);

const result = {
  generatedAt: new Date().toISOString(),
  count,
  dim,
  queries,
  exactVectorSearch: exact,
  seedSeconds: seedMs / 1000,
  seedPerSecond: count / (seedMs / 1000),
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
