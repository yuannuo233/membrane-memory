/**
 * 规则关系抽取的可复现评测（不是"自己测自己"的 doctor）。
 *
 * 用法：
 *   node scripts/eval-extract.mjs
 *   node scripts/eval-extract.mjs --min-f1 0.8
 *   node scripts/eval-extract.mjs --json
 *
 * 口径：
 * - 输入：bench/extraction-cases.json（人工写的句子 + 期望关系）
 * - 输出：逐条命中/漏抽/多抽，以及 micro precision / recall / F1
 * - 只评"关系三元组"完全匹配；实体类型不单独计分（类型错了不影响召回）
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGraph } from "../dist/graph-extract.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const casesPath = join(root, "bench", "extraction-cases.json");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}

const minF1 = Number(arg("min-f1", 0));
const asJson = arg("json", false) === true;
if (!Number.isFinite(minF1) || minF1 < 0 || minF1 > 1) throw new Error("--min-f1 必须在 0~1");

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
if (!Array.isArray(cases)) throw new Error("评测文件必须是数组");

const keyOf = (r) => `${r.from}|${r.predicate}|${r.to}`;
let tp = 0;
let fp = 0;
let fn = 0;
const rows = [];

for (const c of cases) {
  if (!c || typeof c.text !== "string") throw new Error(`用例缺 text：${JSON.stringify(c)}`);
  const got = extractGraph(c.text, c.subject ?? null, c.subjectType ?? "unknown").relations;
  const expected = Array.isArray(c.expected) ? c.expected : [];
  const gotKeys = new Set(got.map(keyOf));
  const expKeys = new Set(expected.map(keyOf));
  const missing = [...expKeys].filter((k) => !gotKeys.has(k));
  const extra = [...gotKeys].filter((k) => !expKeys.has(k));
  tp += [...expKeys].filter((k) => gotKeys.has(k)).length;
  fp += extra.length;
  fn += missing.length;
  rows.push({
    id: c.id ?? c.text,
    text: c.text,
    expected: [...expKeys],
    got: [...gotKeys],
    missing,
    extra,
    ok: missing.length === 0 && extra.length === 0,
  });
}

const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

if (asJson) {
  console.log(JSON.stringify({ cases: rows.length, tp, fp, fn, precision, recall, f1, rows }, null, 2));
} else {
  console.log(`\n=== 规则关系抽取评测（${rows.length} 条用例） ===`);
  for (const row of rows) {
    if (row.ok) {
      console.log(`  ✓ ${row.id}`);
      continue;
    }
    console.log(`  ✗ ${row.id}  ${row.text}`);
    if (row.missing.length) console.log(`      漏抽：${row.missing.join(", ")}`);
    if (row.extra.length) console.log(`      多抽：${row.extra.join(", ")}`);
  }
  console.log(`\nTP=${tp} FP=${fp} FN=${fn}`);
  console.log(`precision=${precision.toFixed(4)} recall=${recall.toFixed(4)} F1=${f1.toFixed(4)}`);
}

if (f1 < minF1) {
  console.error(`\nF1 ${f1.toFixed(4)} 低于阈值 ${minF1}`);
  process.exitCode = 1;
}
