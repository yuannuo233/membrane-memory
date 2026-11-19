<div align="center">

# Membrane 🧠

[简体中文](README.md) | English

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)
[![Zero Dependency](https://img.shields.io/badge/dependencies-zero-success.svg)](DESIGN.md)
[![CI](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.1.7-blue.svg)](CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=social)](https://github.com/yuannuo233/membrane-memory)

**Temporal-aware, local-first, explainable memory engine for AI agents.**

A long-term memory layer for AI agents / LLM memory / agent memory / chatbot memory.
Zero runtime dependencies (only `ulid`), a single SQLite file, no telemetry, fully offline.
Ships an MCP (Model Context Protocol) server — one process plugs into Claude Code, Cursor,
Cline, Windsurf, Zed, AstrBot and any other MCP client. MIT licensed, self-hosted, privacy-first.

</div>

> Give your agent a memory that never forgets — and tells you **why** it recalled each item.
> Works out of the box: no network, no model download, no API key, no native dependencies.

> 🔴 **Honest disclosure (read this first)**: This is an early v0.1 project — solo-developed, 133 tests (verified live by CI), **no real-world users yet**.
> The [Known Limitations](#known-limitations-read-this-first) section below lists every weakness we have. Read it before deciding to use this.
> We do **not** chase "number one on benchmarks" — that is exactly how comparable projects fell from grace.

> 📖 **Not sure if this fits?** Read [Why Membrane](why-membrane.md) — one page covering the
> suitable scenarios, an honest comparison with mem0 / Hindsight / MemPalace, and what we
> explicitly cannot do.

---

## Known Limitations (read this first)

**This section matters more than every feature above.** Here is exactly what we do *not* do.

### Not implemented yet

| Missing | Impact | Note |
|---|---|---|
| **No graph retrieval** | Can't answer "how are Alice and Bob related" style structural links | Currently full-text + time only. Biggest gap, planned for v0.2 |
| **No vector search out of the box** | Default is full-text only (CJK bigram; synonyms won't match) | The `queryVec` API exists, but you must compute embeddings yourself and pass them in |
| **No entity extraction** | Won't auto-detect that "Beijing" is a place or "Alice" is a person | You must put entities in `subject` manually |
| **Multilingual quality not guaranteed** | Chinese (bigram) + English (word) work; Japanese/Korean/others untested | Only Chinese & English have been verified |
| **No hosted cloud** | Self-run and self-backup only | Deliberate (local-first), but you must migrate the DB manually across machines |

### Engineering honesty

| Item | Current state | Risk |
|---|---|---|
| **No real-world users yet** | All 133 tests are ours, testing scenarios *we* imagined | Real usage may hit cases we missed |
| **Cross-process concurrency = WAL only** | SQLite single-writer; concurrent writers queue | Fine for personal use; a bottleneck under load |
| **Performance tested only to 1,000 records** | Writes/queries in seconds at 1k | 100k+ not stress-tested |
| **Doctor sample is tiny** | 5 recall cases / 8 update pairs | **Regression self-check, not a benchmark** — not a basis for cross-project comparison |
| **Solo maintainer** | No team, no SLA | Issues may take days |
| **Weights/half-lives are guesses** | 0.4/0.3/0.2/0.1 and 90/14/365/60 days are untuned | You may need to tune for your workload |

### Explicit non-goals

- ❌ No cloud service / multi-tenant SaaS (local-first is the positioning, not a defect)
- ❌ No built-in LLM (extraction/embedding are yours to configure — we won't burn your budget)
- ❌ No benchmark chasing (we only promise reproducible doctor numbers)

> If you need graph retrieval, turnkey vector search, or a stress-tested large-scale solution —
> a mature alternative project is the better fit. We won't pretend otherwise.

---

## Why

There are already mature projects in the agent-memory space. Membrane picks a different set of trade-offs:

| Common pain | Our approach |
|---|---|
| Requires cloud embedding / LLM to work at all | **Zero telemetry, zero native deps**: Node's built-in `node:sqlite`, one local file |
| Stale retrieval — ask "where does the user live now?" and get an old address (see StaleBench) | **Temporal as a first-class citizen**: every memory has `valid_from`/`valid_to`/`superseded_by`; `asOf(t)` historical queries |
| Recall is a black box — "why did you give me this?" | **Explainable recall**: every hit returns `why` + a 4-component score breakdown |
| Integration means rewriting code per vendor SDK | **MCP built in**: one server plugs into WorkBuddy / zcode / Claude / Cursor / Google Antigravity / AstrBot and more |
| Performance numbers you can't reproduce yourself | **Ship doctor with the package**: every number in this README comes from the `doctor` command — clone the repo and reproduce it yourself |

---

## Quick start

### 1. Install

Requires **Node ≥ 22.5** (for built-in `node:sqlite`). No native build step.

```bash
> ⚠️ **Not published to npm yet.** `npm install -g membrane-memory` currently returns 404.
> Use one of the two methods below; this section will be updated once it is on npm.

**Option A: build from source** (recommended — verifies the tests pass on your machine)

```bash
git clone https://github.com/yuannuo233/membrane-memory.git
cd membrane-memory
npm install        # dev dependencies only (typescript/vitest/tsx); the only runtime dep is ulid
npm test           # all pass (133 cases at the moment)
npm run build
node dist/cli.js doctor    # should report all checks passed
```

Then use `node dist/cli.js <command>`, or `npm link` to get a global `membrane-memory` command.

**Option B: install the release tarball**

Grab `membrane-memory-x.y.z.tgz` from [Releases](https://github.com/yuannuo233/membrane-memory/releases), then:

```bash
npm install -g ./membrane-memory-0.1.7.tgz
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

FTS5 (CJK bigram tokenizer) + optional vectors, RRF-fused. Each hit returns:

- `why`: human-readable reason
- `breakdown`: `rrfText` / `freshness` / `confidence` / `ageDays` / `halfLifeDays` / `weights`

### Interfaces

| Interface | Command | Notes |
|---|---|---|
| SDK | `import { Membrane }` | ESM + full TypeScript types |
| CLI | `add / search / list / stats / mcp / serve / doctor` | complete |
| MCP | `membrane-memory mcp` | stdio, 8 tools |
| REST | `membrane-memory serve` | mem0-compatible subset (`/v1/memories`) + web console, binds 127.0.0.1 |

---

## Reproducible self-check (doctor)

Every number here comes from `membrane-memory doctor` — **same result on any machine** (fixed clock + in-memory DB).

```
Doctor Report v0.1.0
Scenario 1 · Write & recall    hit rate 100%  (5/5)
Scenario 2 · Stale update      current@1 88%  (7/8)
                               contamination@5 0%
Scenario 3 · Cross-session     recalled after restart ✓

Overall: all passed ✓
```

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
- [why-membrane.md](why-membrane.md) — **is this the right fit?** (honest comparison with mem0 / Hindsight / MemPalace, plus what we cannot do)
- [适配配置/](适配配置/) — integration templates

Stack: TypeScript / Node `node:sqlite` / zero runtime deps (except `ulid`).

## License

MIT © 2026 Membrane Contributors
