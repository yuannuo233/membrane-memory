<div align="center">

# Membrane 🧠

[简体中文](README.md) | English

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![Zero Dependency](https://img.shields.io/badge/dependencies-zero-success.svg)](DESIGN.md)
[![CI](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.2.5-blue.svg)](CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=social)](https://github.com/yuannuo233/membrane-memory)

**Temporal-aware, local-first, explainable memory engine for AI agents.**

A long-term memory layer for AI agents / LLM memory / agent memory / chatbot memory.
**Zero npm runtime dependencies** (only `ulid`), a single SQLite file, no telemetry, fully offline.
Ships an MCP (Model Context Protocol) server — one process plugs into Claude Code, Cursor,
Cline, Windsurf, Zed, AstrBot and any other MCP client. MIT licensed, self-hosted, privacy-first.

</div>

> Give your agent a memory that never forgets — and tells you **why** it recalled each item.
> Works out of the box: no network, no model download, no API key, no native dependencies.

> 🧩 **What "zero dependency" actually means here** (to avoid a common misreading):
> it means **installing pulls no third-party npm packages** beyond `ulid`, and there is no
> native build step. It does **not** mean no browser is ever needed — the CLI, the MCP server
> and the SDK are pure command-line / pure code and never touch a browser. Only
> `membrane-memory serve` (the optional web console) renders in one. Skip it and you lose
> nothing functionally.

> 🔴 **Honest disclosure (read this first)**: This is an early v0.2 project — solo-developed, 222 tests (verified live by CI), **no real-world users yet**.
> The [Known Limitations](#known-limitations-read-this-first) section below lists every weakness we have. Read it before deciding to use this.
> We do **not** chase "number one on benchmarks" — that is exactly how comparable projects fell from grace.


---

## Known Limitations (read this first)

**This section matters more than every feature above.** Here is exactly what we do *not* do.

### Not implemented yet

| Missing | Impact | Note |
|---|---|---|
| **Graph retrieval relies on rules, so coverage is narrow** | Only 6 Chinese sentence patterns (lives in / works or studies at X / A is B's X / A's X is B / likes / dislikes) | Complex sentences yield nothing. Annotate `relations` manually for accuracy; rules are a best-effort fallback |
| **Vector search needs your own embedding endpoint** | Without one it falls back to full-text (CJK bigram; synonyms won't match) | Any OpenAI-compatible `/embeddings` works (`MEMBRANE_LLM_BASE_URL` + `MEMBRANE_EMBED_MODEL`); you can also pass `vec` / `queryVec` computed elsewhere |
| **Entity typing is heuristic, not model-based** | "Beijing" is typed as a place via suffix rules, but "Apple" can't be disambiguated between company and fruit | Type is only a hint — a wrong guess never hurts recall, only how you read `why` |
| **Multilingual quality not guaranteed** | Chinese (bigram) + English (word) work; Japanese/Korean/others untested | Only Chinese & English have been verified |
| **No hosted cloud** | Self-run and self-backup only | Deliberate (local-first), but you must migrate the DB manually across machines |

### Engineering honesty

| Item | Current state | Risk |
|---|---|---|
| **No real-world users yet** | All 222 tests are ours, testing scenarios *we* imagined | Real usage may hit cases we missed |
| **Tasks share memory within one namespace** | Only `namespace` isolation; no automatic `task_id`; task memories in one namespace become candidates together | Use `task-<id>` per task, see the isolation section above |
| **Cross-process concurrency = WAL only** | SQLite single-writer; concurrent writers queue | Fine for personal use; a bottleneck under load |
| **Performance stress-tested only to 100k records** | 100k × 1536-dim: ~300ms pure vector, ~460ms hybrid (LSH bucket index) | Millions, real embedding distributions, and extreme bucket skew are unverified; use `exactVectorSearch` for exact parity |
| **The default vector index is approximate** | At 100k scale, LSH buckets keep top-1 stable; extreme bucket skew may miss some neighbors | When exact parity with brute force is required, enable `exactVectorSearch` (~11s/query) or run `bench-scale` to audit |
| **Doctor sample is tiny** | 5 recall cases / 8 update pairs | **Regression self-check, not a benchmark** — not a basis for cross-project comparison |
| **Solo maintainer** | No team, no SLA | Issues may take days |
| **Weights/half-lives are guesses** | 0.4/0.3/0.2/0.1/0.1 and 90/14/365/60 days are untuned | You may need to tune for your workload |

### Explicit non-goals

- ❌ No cloud service / multi-tenant SaaS (local-first is the positioning, not a defect)
- ❌ No built-in LLM (extraction/embedding are yours to configure — we won't burn your budget)
- ❌ No benchmark chasing (we only promise reproducible doctor numbers)

> If you need turnkey high-quality graph retrieval, a mature vector index (HNSW/faiss), or a
> stress-tested large-scale solution — a mature alternative project is the better fit. We won't pretend otherwise.

---

## Why

There are already mature projects in the agent-memory space. Membrane picks a different set of trade-offs:

| Common pain | Our approach |
|---|---|
| Requires cloud embedding / LLM to work at all | **Zero telemetry, zero native deps**: Node's built-in `node:sqlite`, one local file |
| Stale retrieval — ask "where does the user live now?" and get an old address (see StaleBench) | **Temporal as a first-class citizen**: every memory has `valid_from`/`valid_to`/`superseded_by`; `asOf(t)` historical queries |
| Recall is a black box — "why did you give me this?" | **Explainable recall**: every hit returns `why` + a 5-component score breakdown (text RRF / vector / graph path / freshness / confidence) |
| Integration means rewriting code per vendor SDK | **MCP built in**: one server plugs into WorkBuddy / zcode / Claude / Cursor / Google Antigravity / AstrBot and more |
| Performance numbers you can't reproduce yourself | **Ship doctor with the package**: every number in this README comes from the `doctor` command — clone the repo and reproduce it yourself |

---

## Quick start

### 1. Install

Requires **Node ≥ 24**. Reason: the built-in `node:sqlite` is experimental in 22.x and 23.x and needs `--experimental-sqlite`; it is enabled by default from Node 24 onward. Setting the floor at 24 means no flags to remember.

> ⚠️ **Not published to npm yet.** `npm install -g membrane-memory` currently returns 404.
> Use one of the two methods below; this section will be updated once it is on npm.

**Option A: build from source** (recommended — verifies the tests pass on your machine)

```bash
git clone https://github.com/yuannuo233/membrane-memory.git
cd membrane-memory
npm install        # dev dependencies only (typescript/vitest/tsx); the only runtime dep is ulid
npm test           # all pass (222 cases at the moment)
npm run build
node dist/cli.js doctor    # should report all checks passed
```

Then use `node dist/cli.js <command>`, or `npm link` to get a global `membrane-memory` command.

**Option B: install the release tarball**

Grab `membrane-memory-x.y.z.tgz` from [Releases](https://github.com/yuannuo233/membrane-memory/releases), then:

```bash
npm install -g ./membrane-memory-0.2.2.tgz
membrane-memory doctor
```

On Windows you can also double-click `一键安装.bat` (compile + init DB + self-check).

> The examples below assume `membrane-memory` is on your PATH. If you used Option A
> without `npm link`, replace `membrane-memory` with `node dist/cli.js`.

### 2. Add & recall

```bash
membrane-memory add "User lives in Beijing" --subject user --kind fact
membrane-memory search "where does user live"

# custom DB path (default ./membrane.db)
set MEMBRANE_DB=E:/my-memory/membrane.db
```

As a library:

```js
import { Membrane } from "membrane-memory";

const m = new Membrane({ dbPath: "./membrane.db" });
m.add({ content: "User lives in Beijing", subject: "user", kind: "fact" });

const hits = m.recall({ query: "where does user live" });
console.log(hits[0].why);        // why it matched
console.log(hits[0].breakdown);  // rrfText / freshness / confidence / weights…
m.close();
```

### 3. Plug into your AI tool

Start the MCP server with `membrane-memory mcp`, then add to your tool's config (e.g. WorkBuddy `mcp.json`):

```json
"membrane": {
  "command": "node",
  "args": ["<membrane-dir>/dist/cli.js", "mcp"],
  "env": { "MEMBRANE_DB": "<absolute-path>/membrane.db" }
}
```

**Templates for every major tool** in [适配配置/各工具接入配置.md](适配配置/各工具接入配置.md) (zcode, Claude Code, Cursor, Cline, Antigravity, AstrBot, DeepSeek Harness…).

Web console: double-click `启动控制台.bat`, open `http://127.0.0.1:8317`.

The **Ops / Admin** tab is the operator view: runtime status, DB schema/size, whether LLM/embedding is configured, request logs (default `membrane.db.log`, **never memory content or queries**), an MCP connections panel (which AI agent connected over MCP, how many calls it made, and the last tool it used — handshake/call metadata only, **never memory content or queries**), and a one-click multi-task isolation probe. Read-only endpoints: `/api/admin/diagnostics`, `/api/admin/logs`, `/api/admin/mcp-clients`, `/api/admin/isolation-check`.

---

## Core features

### Temporal aware (signature feature)

```js
m.add({ content: "User lives in Beijing", subject: "user" });        // t0
m.add({ content: "User lives in Shanghai", subject: "user", at: t1 }); // old value invalidated, chain recorded

m.recall({ query: "where does user live" });                 // → Shanghai (current)
m.recall({ query: "where does user live", asOf: t0 + 1 });   // → Beijing (past)
m.history(id);                                               // full add/supersede audit trail
```

- Configurable conflict policy: `supersede` / `keep-both` / `error`
- `pin` exempts a memory from auto-supersede
- Soft delete (forget) keeps a tombstone; historical queries still see it

### Graph retrieval: answer "how are Alice and Bob related"

```js
// Manual annotation (most accurate): attach relations while writing the memory
m.add({
  content: "Alice is Bob's classmate",
  subject: "Alice",
  relations: [{ to: "Bob", predicate: "classmate", toType: "person" }],
});

// Rule extraction (optional): 6 high-confidence sentence patterns, nothing forced
m.add({ content: "用户住在北京", subject: "用户" });   // → 用户 --住在--> 北京

m.relations("Alice", "Bob");            // → Alice 与 Bob：classmate
m.relations("张三和李四是什么关系");      // a whole sentence works too (entities auto-detected)
m.relations("Alice", "Acme", { maxHops: 2 }); // two hops: Alice → Bob → Acme
```

Relations are **temporal too**: superseding or forgetting a memory closes the relations it derived,
while `asOf(t)` still returns them. The graph path also joins the unified score as a **fifth candidate
source**, so memories with zero lexical overlap but a matching relation can still be recalled —
`why` spells out the path (`关系第 1 名（甲 --谓词--> 乙）`).

### Vector search: bring your own embedding endpoint

```bash
# Any OpenAI-compatible /embeddings endpoint (skip it and you get pure full-text, identical to v0.1)
set MEMBRANE_LLM_BASE_URL=https://api.openai.com/v1
set MEMBRANE_LLM_API_KEY=sk-...
set MEMBRANE_EMBED_MODEL=text-embedding-3-small

membrane-memory add "User lives in Beijing" --subject user   # embeddings computed automatically
membrane-memory search "where does he live"                  # query vector fused with full-text
membrane-memory embed-backfill                               # one-off backfill for older DBs (batched)
membrane-memory export --out backup.json                     # full backup (memories/evidence/graph/vectors)
membrane-memory import backup.json                           # restore; idempotent, never overwrites existing ids
```

Fully offline is also fine: pass precomputed vectors via `add({ vec })` and `recall({ queryVec })`.
**A failed embedding never blocks a write** — the memory is stored, simply without a vector.

### Token economy: don't write-then-query every turn

Memory ops are **tool calls**, and every call costs tokens. Batch, and query only when needed.

| Anti-pattern | Cost | Advice |
|---|---|---|
| ❌ `add` on every single message | High (one extra call per turn) | Batch writes at the end of a turn |
| ❌ `recall` before every answer | High | Only on topic switch, or when context is genuinely needed |
| ❌ Use `full` detail by default | Highest (~2,400 tokens / 8 hits) | Reserve `full` for debugging |

**Three detail levels** (measured, 8 hits):

| `detail` | tokens | Contains | Use when |
|---|---|---|---|
| `ultra` | ~310 | id / content / score | The agent just needs to recall what was stored |
| `brief` (default) | ~600 | + kind / subject / validFrom / evidenceCount | Normal retrieval |
| `full` | ~2,400 | + full score breakdown + `why` | Debugging "why did this rank here?" |

```js
m.recall({ query: "what does the user like" });                  // brief by default
m.recall({ query: "what does the user like", detail: "ultra" });  // half the size again
m.recall({ query: "what does the user like", detail: "full" });   // debugging only
```

**Agent prompt snippet** (copy-paste):

```
Memory policy:
- Collect facts worth remembering during the turn, then call membrane_add once per fact at the end.
- Before answering, decide if history is actually needed; if unsure, skip recall.
- Do not pass detail on recall — use the default brief form.
- Only use detail="full" when the user asks why a memory was recalled.
```

> In short: memory shouldn't be touched on every sentence — no engine can save you from call overhead.

### Explainable recall

FTS5 (CJK bigram tokenizer) + optional vectors + optional graph paths, RRF-fused. Each hit returns:

- `why`: human-readable reason (including graph explanations like `关系第 1 名（甲 --谓词--> 乙）`)
- `breakdown`: `rrfText` / `rrfVec` / `vecSim` / `rrfGraph` / `graphPaths` / `freshness` / `confidence` / `ageDays` / `halfLifeDays` / `weights`

The five weights are **relative**: a missing source is zeroed and the rest are rescaled to sum to 1,
so the score bound stays at 1.0.

### Interfaces

| Interface | Command | Notes |
|---|---|---|
| SDK | `import { Membrane }` | ESM + full TypeScript types |
| CLI | `add / search / relations / link / entities / embed-backfill / list / stats / export / import / mcp-config / mcp / serve / doctor` | complete |
| MCP | `membrane-memory mcp` | stdio, 10 tools |
| REST | `membrane-memory serve` | mem0-compatible subset (`/v1/memories`) + web console, binds 127.0.0.1 |

### Web console: view, edit, forget

Open `http://127.0.0.1:8317` after `membrane-memory serve`:

- **Bilingual UI** (`中文 / EN` switch in the top bar, persisted): static copy and dynamic results switch together
- **Three token modes** in the top bar (persisted): `ultra` + 3 hits / `brief` + 8 / `full` + 8
- **Detail drawer**: content, validity window, tags, entities, relations, evidence, full audit chain
- **Edit**: content/kind/subject/confidence/tags/pin → saved as a **new version**, old version kept in history
- **Forget**: soft delete; tombstones remain auditable; ledger filters by namespace/kind/history
- **Export**: one-click full JSON backup

REST equivalent: `PATCH|PUT /api/memories/:id`, `DELETE /api/memories/:id`.
For non-MCP clients see [适配配置/REST与SDK接入.md](适配配置/REST与SDK接入.md) (OpenAI tools schema, Node/Python zero-dependency clients, Docker).

### Multi-task / multi-user isolation (read this)

`namespace` is a hard filter across FTS, fuzzy, vector, graph, list, and stats; the entity unique key is `(namespace, name)`.

- **Within one namespace, memories from multiple tasks will be recalled together.** Task A ("DB is PostgreSQL") and Task B ("DB is MySQL") both become candidates for the query "database". It is not a database race; it is semantic candidate mixing.
- **Different namespaces never mix**: A returns only A, B only B (doctor scenario 6 and the Ops isolation probe verify zero leakage).
- Recommended: one namespace per task, `task-<taskId>` (letters/digits/underscore/hyphen only); put shared knowledge in `shared` and query task namespace + `shared` separately, merging in your application.
- There is **no automatic `task_id`/`session` field** yet; automatic per-task isolation would require a full schema v3 migration and is not implemented.

---

## Reproducible self-check (doctor)

Every number here comes from `membrane-memory doctor` — **same result on any machine** (fixed clock + in-memory DB).

```
Doctor Report v0.2.2
Scenario 1 · Write & recall    hit rate 100%  (5/5)
Scenario 2 · Stale update      current@1 88%  (7/8)
                               contamination@5 0%
Scenario 3 · Cross-session     recalled after restart ✓
Scenario 4 · Vector search     vector-only hit ✓  cosine 1.00  vec component applied
Scenario 5 · Graph retrieval   answered "张三 与 李四：同学" ✓
                               2 edges within 2 hops, graph path applied

Overall: all passed ✓
```

Scenarios 4/5 are **fully offline**: vectors are hand-built unit vectors and relations are manually
annotated, so the numbers are identical on any machine and a dead network never turns CI red.

**Metric definitions** (to avoid comparison mistakes):
- "Write & recall" is **retrieval hit rate**, not end-to-end QA accuracy.
- `contamination@5` = fraction of top-5 results containing an already-superseded version (key StaleBench metric; `current@1` alone ranks 13/42 strategies backwards).
- Small sample (5 recalls / 8 updates) — for regression self-check, **not** a cross-vendor benchmark.

Running the command writes a full report (JSON + text) locally; reproduce the numbers yourself.

---

## Privacy & security

- All data in one local `membrane.db`, **zero telemetry, zero upload**; delete the file to erase everything.
- REST binds `127.0.0.1` by default; binding externally requires `MEMBRANE_TOKEN` (Bearer).
- FTS queries are allow-list tokenized (injection-safe); all SQL uses prepared statements.

---

## Docs

- [DESIGN.md](DESIGN.md) — living spec: architecture, data model, algorithms, progress (source of truth)
- [CHANGELOG.md](CHANGELOG.md) — **what changed in each version** (why it was a bug, how it was fixed, which files were touched)
- [适配配置/](适配配置/) — integration templates

Stack: TypeScript / Node `node:sqlite` / zero runtime deps (except `ulid`).

## License

MIT © 2026 Membrane Contributors
