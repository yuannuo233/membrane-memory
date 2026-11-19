# Why Membrane?

> This page is not an advertisement. It is a **trade-off document**: who Membrane is for,
> who it is *not* for, and where it falls short of established alternatives.
> Read it and you can decide whether to bother — without wasting time trying it.

[简体中文](为什么用Membrane.md) | English

---

## In one sentence

Most options for giving an AI agent memory either **depend on a cloud service** (API key,
data leaves your machine, telemetry) or **require a local model** (hundreds of MB, VRAM).

Membrane takes a third path: **one SQLite file + zero dependencies + fully offline**,
plus two things most alternatives don't offer —
**temporal awareness** (remembering *when* something was true) and
**explainable recall** (saying *why* a memory was returned).

---

## Three real situations — how many apply to you?

### Situation A: You don't want to hand your chat history to someone else's server

**Typical alternatives**: mem0 defaults to the OpenAI cloud; its OSS build also bundles
PostHog telemetry.
**Membrane**: `npm i -g membrane-memory`. Data stays on your disk. No network calls.

> Good fit for: privacy-sensitive work, internal tools, environments where data
> cannot leave the country or the company.

### Situation B: The user changed their mind, but the AI still answers from the old value

You said "I moved to Shanghai". A week later you ask "where do I live" and get "Beijing".

**What Membrane does**: when a new fact is written, the old one is marked as no longer
valid (`valid_to`) — but it is **not deleted**. Ask "where did I live in March" and it
can still find it.

This is a real **supersede chain**: `valid_from` / `valid_to` / `superseded_by`,
with `asOf(t)` historical queries.

> Good fit for: facts that change often, audit trails, anything that needs to
> distinguish "the current value" from "the value at the time".

### Situation C: The AI says "I remember you said…" and you don't believe it

Most memory stores return a list of results with no explanation.

**Every Membrane result carries**:
- `why` — a human-readable reason, e.g. "full-text rank 1, freshness 92%, confidence 100%"
- `breakdown` — the five score components (full-text RRF / vector / graph path / freshness / confidence),
  including the weights used

> Good fit for: debugging retrieval quality, explaining results to end users,
> situations where trust matters.

---

## Comparison with established alternatives (honest version)

| | Membrane | mem0 | Hindsight | MemPalace |
|---|---|---|---|---|
| **Deployment** | single SQLite file | cloud / self-host needs a DB | needs PostgreSQL + LLM | needs to download a model |
| **Dependencies** | only `ulid` | many | many | heavy |
| **Telemetry** | none | PostHog in OSS build | — | — |
| **Temporal awareness** | ✅ built-in supersede chain + `asOf` | paid platform only | ✅ yes (strongest) | partial |
| **Graph retrieval** | ✅ yes (3 tables + 1–3 hops; annotate manually or rely on 6 sentence patterns) | platform tier | ✅ yes | ✅ yes |
| **Vector search** | ✅ yes (turnkey with an OpenAI-compatible `/embeddings` endpoint; or pass your own vectors) | ✅ built in | ✅ built in | ✅ built in |
| **Explainability** | ✅ 5 components + `why` | partial | ✅ evidence chain | partial |
| **MCP integration** | ✅ 10 tools built in | partial | ✅ | ✅ 47 tools |

**Bottom line**:
- Need **graph-database-grade relational reasoning** or **large-scale vector indexing** → use Hindsight
- Need **cloud hosting** or **multi-language SDKs** → use mem0
- Need **a single file, offline, explainable, with queryable history — and relational questions** → use Membrane

---

## What it explicitly cannot do

(Listed up front so you don't waste time discovering it later.)

| Cannot | Detail |
|---|---|
| Search synonyms (unconfigured) | Without an embedding endpoint, stored "Beijing" won't be found by "capital". Set `MEMBRANE_EMBED_MODEL` and you get semantic search |
| Relational questions in complex sentences | Rules cover 6 patterns (lives in / works or studies at X / A is B's X / A's X is B / likes / dislikes). Annotate `relations` manually for accuracy |
| Disambiguate entities | "Beijing" is typed as a place by suffix rules, but "Apple" can't be told apart between company and fruit. Type is a hint only |
| Handle very large scale | Benchmarked only to 100k records; queries that match a large fraction of the corpus are slow (a SQLite FTS5 property) |
| Tokenize Japanese/Korean | Only Chinese and English have been verified |

Full list in the [README's Known Limitations section](README.en.md#known-limitations-read-this-first).

---

## Getting started

```bash
# 1. Install (not on npm yet — build from source; requires Node >= 24)
git clone https://github.com/yuannuo233/membrane-memory.git
cd membrane-memory && npm install && npm test && npm run build

# 2. Run the self-check to confirm it works on your machine
node dist/cli.js doctor

# 3. Connect your AI tool (Claude Code / Cursor / Cline / AstrBot …)
node dist/cli.js mcp
```

Integration templates: [适配配置/各工具接入配置.md](适配配置/各工具接入配置.md) (Chinese).

---

## If you find it useful

**A star is the most concrete help.** Not for vanity —
the star count determines whether this project shows up when someone searches
"AI agent memory", and whether an AI assistant knows it exists at all.

A new project with no stars, no inbound links, and no presence in model training data
effectively does not exist.

[![Star this repo](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=for-the-badge&logo=github&label=Star)](https://github.com/yuannuo233/membrane-memory/stargazers)

Other ways to help:
- Open an [issue](https://github.com/yuannuo233/membrane-memory/issues) describing your
  use case or where you got stuck
- Write a post or article mentioning it (inbound links help search ranking the most)
- Link to it from your own project's README

---

## Finally

This is a solo-developed early version (v0.2.1, 201 tests, no real-world users yet).
It is not perfect, but every number in the docs is something you can verify yourself —
`membrane-memory doctor` ships with the package, is deterministic, and produces the same
result on any machine running the same code.

We would rather ship slowly than publish claims that cannot be reproduced.
