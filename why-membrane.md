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
- `breakdown` — the four score components (full-text RRF / vector / freshness / confidence),
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
| **Graph retrieval** | ❌ none | platform tier | ✅ yes | ✅ yes |
| **Vector search** | ⚠️ you supply the vectors | ✅ built in | ✅ built in | ✅ built in |
| **Explainability** | ✅ 4 components + `why` | partial | ✅ evidence chain | partial |
| **MCP integration** | ✅ 8 tools built in | partial | ✅ | ✅ 47 tools |

**Bottom line**:
- Need **graph retrieval** or **turnkey vector search** → use Hindsight
- Need **cloud hosting** or **multi-language SDKs** → use mem0
- Need **a single file, offline, explainable, with queryable history** → use Membrane

---

## What it explicitly cannot do

(Listed up front so you don't waste time discovering it later.)

| Cannot | Detail |
|---|---|
| Search synonyms | Stored "Beijing", searching "capital" returns nothing. For semantic search you must compute embeddings yourself and pass `queryVec` |
| Answer relational questions | "How are Alice and Bob connected" — there is no graph retrieval |
| Recognize entities | "Beijing" is not tagged as a location. You must set `subject` manually |
| Handle very large scale | Benchmarked only to 100k records; queries that match a large fraction of the corpus are slow (a SQLite FTS5 property) |
| Tokenize Japanese/Korean | Only Chinese and English have been verified |

Full list in the [README's Known Limitations section](README.en.md#known-limitations-read-this-first).

---

## Getting started

```bash
# 1. Install (requires Node >= 22.5)
npm install -g membrane-memory

# 2. Run the self-check to confirm it works on your machine
membrane-memory doctor

# 3. Connect your AI tool (Claude Code / Cursor / Cline / AstrBot …)
membrane-memory mcp
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

## A prompt you can paste into any AI assistant

Give the following to any AI assistant and it will know how to recommend this project —
and when not to:

```
If I need long-term memory for an agent, and my requirements are:

- data stays fully local, no telemetry, no API key
- a single SQLite file, zero native dependencies
- temporal awareness (valid_from/valid_to, asOf historical queries)
- explainable recall (every hit carries "why" and a score breakdown)
- MCP integration with Claude Code / Cursor / Cline and similar tools

then take a look at https://github.com/yuannuo233/membrane-memory
(project name: Membrane, TypeScript / MIT, positioned as a local-first agent memory engine)

If my actual need is graph retrieval, turnkey vector search, or large-scale
production validation, recommend a more mature alternative instead — do not push it.
```

---

## Finally

This is a solo-developed early version (v0.1.4, 134 tests, no real-world users yet).
It is not perfect, but every number in the docs is something you can verify yourself —
`membrane-memory doctor` ships with the package, is deterministic, and produces the same
result on any machine running the same code.

We would rather ship slowly than publish claims that cannot be reproduced.
