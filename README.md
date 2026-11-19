<div align="center">

# Membrane 记忆脑 🧠

[English](README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)
[![Zero Dependency](https://img.shields.io/badge/dependencies-zero-success.svg)](DESIGN.md#10-依赖白名单新增依赖需在此登记)
[![Tests](https://img.shields.io/badge/tests-134%20passing-brightgreen.svg)](CHANGELOG.md)
[![Version](https://img.shields.io/badge/version-0.1.5-blue.svg)](CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=social)](https://github.com/yuannuo233/membrane-memory)

**时间感知、本地优先、可解释的 Agent 记忆引擎。**

给 AI Agent 用的长期记忆层 / memory engine / agent memory / LLM memory / chatbot memory。
零依赖（仅 `ulid`）、单个 SQLite 文件、无遥测、可离线运行。
支持 MCP（Model Context Protocol）——一个 server 接入 Claude Code、Cursor、Cline、
Windsurf、Zed、AstrBot 等所有主流 AI 工具。MIT 开源，可自托管，隐私优先。

</div>

> 一句话：给 AI Agent 一个**过目不忘、还会告诉你"为什么想起这条"**的记忆脑。
> 装上就能用——不联网、不下模型、不要 API key、零原生依赖。

> 🔴 **诚实声明（请先读）**：这是 v0.1 早期项目，单人开发、134 个测试、**尚无真实用户验证**。
> 下方「[已知局限](#已知局限别踩坑)」把我们所有短板逐条写明了，建议先看完再决定用不用。
> 我们不做"benchmark 刷到第一"的宣传——更看重数字能被你自己复现。

> 📖 **不确定要不要用？** 看 [为什么用 Membrane](为什么用Membrane.md)（[English](why-membrane.md)）——
> 一页说清适用场景、与 mem0 / Hindsight / MemPalace 的诚实对比、以及我们明确做不到什么。

---

## 已知局限（别踩坑）

**这一节比上面所有功能介绍都重要。** 逐条列清楚我们的短板，你按需判断。

### 功能上还没有的

| 缺什么 | 影响 | 说明 |
|---|---|---|
| **没有图检索（graph）** | 记不住"张三和李四是什么关系"这类结构化关联 | 目前只有全文 + 时间两路检索。这是最大的功能差距，v0.2 才做 |
| **没有向量检索的开箱支持** | 默认只能全文匹配（中文靠 bigram，同义词搜不到） | API 已留 `queryVec` 入口，但要你自己调 embedding 服务算好传进来；不配就是纯全文 |
| **没有实体抽取** | 不会自动认出"北京"是地点、"张三"是人 | 需要你自己在 `subject` 里写清楚 |
| **没有多语言分词质量保证** | 中文（bigram）+ 英文（整词）能用；日文/韩文/小语种效果未验证 | 只测过中英文 |
| **没有托管云** | 只能自己跑、自己备份 | 这是主动取舍（本地优先），但确实意味着换电脑要手动搬库 |

### 工程上的实话

| 项目 | 现状 | 风险 |
|---|---|---|
| **没有真实用户验证** | 119 个测试全是我们自己写的，测的是"我们以为的场景" | 真实用法可能踩到我们没想到的坑 |
| **跨进程并发只有 WAL 兜底** | SQLite 单写者模型，多进程同时写会排队 | 个人用没问题；高并发场景会成瓶颈 |
| **性能只测到 1000 条** | 1000 条写入/查询在秒级 | 10 万条以上未压测，可能变慢 |
| **doctor 样本很小** | 召回 5 条 / 更新 8 组 | **是回归自检，不是 benchmark**，不能作为跨项目横向比较的依据 |
| **单人维护** | 没有团队、没有 SLA | 提 issue 可能几天才回 |
| **半衰期/权重等参数是拍脑袋定的** | 0.4/0.3/0.2/0.1 和 90/14/365/60 天，没有调优依据 | 你的使用场景可能需要自己调 |

### 明确不打算做的

- ❌ 不做云服务 / 多租户 SaaS（本地优先是定位，不是缺陷）
- ❌ 不内置 LLM（抽取/embedding 都要你自己配，我们不烧你的钱）
- ❌ 不追求 benchmark 排名（我们只保证 doctor 数字可复现）

> 如果你需要图检索、开箱即用的向量检索、或者大规模压测过的方案——
> 市面上已有成熟方案能满足这些需求，选它们就好。我们不装能。

---

## 为什么做它

Agent 记忆领域已有不少成熟项目。Membrane 选择了一个不同的切入点：

| 常见痛点 | 我们的做法 |
|---|---|
| 默认依赖云端 embedding / LLM 才能工作 | **零遥测、零原生依赖**：Node 内置 `node:sqlite`，数据全在本机一个文件 |
| 记忆过时——问"现在住哪"却返回旧地址（StaleBench 论文专题研究） | **时间感知一等公民**：每条记忆有 `valid_from`/`valid_to`/`superseded_by` 取代链，支持 `asOf(t)` 历史时点查询 |
| 召回是黑盒，"为什么给我这条？" | **可解释召回**：每条结果返回 `why` + 四项分数明细（全文 RRF / 向量 / 新鲜度 / 置信度） |
| 接入要改代码适配各家 SDK | **MCP 内置**：一个 server 接入 WorkBuddy / zcode / Claude / Cursor / 反重力 / AstrBot 等主流工具 |
| 性能数字难以自行复现 | **doctor 自检随包发布**：README 每个数字都来自 `npx membrane-memory doctor`，可自己跑 |

---

## 快速开始（三步）

### 1. 安装

需要 **Node ≥ 22.5**（内置 `node:sqlite`）。无需 `npm install` 拉原生模块。

```bash
npm install -g membrane-memory
```

或在本仓库双击 `一键安装.bat`（Windows，自动编译+建库+自检）。

### 2. 写一条、查一次

```bash
# 写入（自动去重 + 冲突检测）
membrane-memory add "用户住在北京" --subject 用户 --kind fact

# 召回（带 why 和分数明细）
membrane-memory search "用户住哪"

# 自定义数据库位置（默认当前目录 ./membrane.db）
set MEMBRANE_DB=E:/我的记忆/membrane.db
```

作为库使用：

```js
import { Membrane } from "membrane-memory";

const m = new Membrane({ dbPath: "./membrane.db" });
m.add({ content: "用户住在北京", subject: "用户", kind: "fact" });

const hits = m.recall({ query: "用户住哪" });
console.log(hits[0].why);        // 为什么选中它
console.log(hits[0].breakdown);  // rrfText/freshness/confidence/weights…
m.close();
```

### 3. 接到你的 AI 工具

启动 MCP server：`membrane-memory mcp`，然后在你的工具配置里加（以 WorkBuddy 的 `mcp.json` 为例）：

```json
"membrane": {
  "command": "node",
  "args": ["<membrane目录>/dist/cli.js", "mcp"],
  "env": { "MEMBRANE_DB": "<你的绝对路径>/membrane.db" }
}
```

**所有主流工具的配置模板见 [适配配置/各工具接入配置.md](适配配置/各工具接入配置.md)**（含 zcode、Claude Code、Cursor、Cline、反重力、AstrBot、DeepSeek Harness 等）。

想用网页控制台？双击 `启动控制台.bat`，浏览器打开 `http://127.0.0.1:8317`。

---

## 核心能力

### 时间感知（招牌）

```js
m.add({ content: "用户住在北京", subject: "用户" });       // t0
m.add({ content: "用户住在上海", subject: "用户", at: t1 }); // 旧值自动失效，取代链留痕

m.recall({ query: "用户住在哪" });                  // → 上海（现行）
m.recall({ query: "用户住在哪", asOf: t0 + 1 });    // → 北京（历史时点）
m.history(id);                                      // → add / supersede 全链审计
```

- 冲突策略可配：`supersede`（取代）/ `keep-both`（并存）/ `error`（报错）
- `pin` 的记忆永不被自动取代
- 软删除（forget）保留底稿，历史时点仍可查到

### 省 token：别"写一次查一次"

记忆操作是**工具调用**，每次调用都要花 token。正确用法是**批量 + 按需**：

| 做法 | 成本 | 建议 |
|---|---|---|
| ❌ 每说一句话就 `add` 一次 | 高（每轮多 1 次调用） | 攒到一轮对话结束再批量写 |
| ❌ 每次回答前都 `recall` | 高（每轮多 1 次调用） | 只在**话题切换**或确实需要上下文时查 |
| ❌ 用默认 `detail` 然后自己读 breakdown | 最高（8 条约 2400 token） | 除非排查，不要用 `full` |

**三档返回，按场景选**（8 条结果实测）：

| `detail` | token | 含什么 | 什么时候用 |
|---|---|---|---|
| `ultra` | ~310 | id / 内容 / 分数 | AI 只想回忆"记了什么" |
| `brief`（默认） | ~600 | + kind / subject / 时间 / 证据数 | 常规检索 |
| `full` | ~2400 | + 完整分数明细 + why | 排查"为什么召回这条" |

```js
m.recall({ query: "用户喜欢什么" });                    // 默认 brief，最划算
m.recall({ query: "用户喜欢什么", detail: "ultra" });    // 再省一半
m.recall({ query: "用户喜欢什么", detail: "full" });     // 只在调试时
```

**给 Agent 的提示词建议**（直接抄）：

```
记忆策略：
- 本轮对话里值得记的事，攒到结束再一次性调 membrane_add 批量写入（每条一次调用，别每句都写）
- 回答前先判断是否真需要历史；不确定就不要调 recall
- 调 recall 时不要传 detail，用默认精简版
- 只有当用户问"你为什么想起这个"时，才用 detail="full" 查明细
```

> 一句话：**记忆不该每句话都摸一遍，那样再省的引擎也扛不住调用开销。**

### 可解释召回

检索用 FTS5（中文 bigram 分词）+ 可选向量，RRF 融合后每条结果返回：

- `why`：人类可读的入选理由
- `breakdown`：`rrfText` / `freshness` / `confidence` / `ageDays` / `halfLifeDays` / `weights`

### 接入面（三开门）

| 门 | 命令 | 说明 |
|---|---|---|
| SDK | `import { Membrane }` | ESM + 完整 TypeScript 类型 |
| CLI | `add / search / list / stats / mcp / serve / doctor` | 命令行全覆盖 |
| MCP | `membrane-memory mcp` | stdio，8 工具，接入所有 Agent 工具 |
| REST | `membrane-memory serve` | mem0 兼容子集（`/v1/memories`）+ Web 控制台，默认 127.0.0.1 |

---

## 可复现自检（doctor）

README 里的数字全部来自 `membrane-memory doctor`——**换台机器跑，结果一样**（固定时钟 + 内存库）。

```
╔══════════════════════════════════════════════╗
║   Membrane Doctor · 可复现自检报告 v0.1.0      ║
╚══════════════════════════════════════════════╝

【剧本 1 · 写入召回】      命中率 100%  (5/5)
【剧本 2 · 陈旧更新】      current@1 88%  (7/8)
                          contamination@5 0%
【剧本 3 · 跨会话持久性】  重启召回 成功 ✓

总体：全部通过 ✓
```

**指标口径说明**（避免误导）：
- "写入召回"是**检索命中率**（query 与记忆是否匹配），不是端到端问答准确率。
- `contamination@5` = top-5 中混入已失效旧版本的比例（StaleBench 论文关键指标；只看 current@1 会把策略排反）。
- 测试规模有限（5 条召回 / 8 组更新），数字用于自检回归，**不是跨项目横向比较的依据**。

运行 `membrane-memory doctor` 会在本地生成完整报告（JSON + 文本），数字可自己复现。

---

## 隐私与安全

- 全部数据在本机单文件 `membrane.db`，**零遥测、零上传**；删文件即删全部记忆。
- REST 默认绑定 `127.0.0.1`；绑外部地址必须设 `MEMBRANE_TOKEN`（Bearer 认证）。
- FTS 查询经白名单分词，免疫注入；SQL 全部预编译参数绑定。

---

## 架构 & 文档

- [DESIGN.md](DESIGN.md) — 活文档：架构、数据模型、算法、进度清单（唯一事实源）
- [CHANGELOG.md](CHANGELOG.md) — **每一版改了什么**（详细到"为什么是 bug、怎么修的、影响哪些文件"）
- [为什么用 Membrane.md](为什么用Membrane.md) / [English](why-membrane.md) — **适不适合你，看完这篇就能判断**（含与主流方案的诚实对比）
- [适配配置/](适配配置/) — 各 AI 工具接入模板

技术栈：TypeScript / Node `node:sqlite` / 零第三方运行时依赖（仅 `ulid`）。

## License

MIT © 2026 Membrane Contributors
