<div align="center">

# Membrane 记忆脑 🧠

[English](README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![Zero Dependency](https://img.shields.io/badge/dependencies-zero-success.svg)](DESIGN.md#10-依赖白名单新增依赖需在此登记)
[![CI](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/yuannuo233/membrane-memory/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.2.1-blue.svg)](CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=social)](https://github.com/yuannuo233/membrane-memory)

**时间感知、本地优先、可解释的 Agent 记忆引擎。**

给 AI Agent 用的长期记忆层 / memory engine / agent memory / LLM memory / chatbot memory。
零依赖（仅 `ulid`）、单个 SQLite 文件、无遥测、可离线运行。
支持 MCP（Model Context Protocol）——一个 server 接入 Claude Code、Cursor、Cline、
Windsurf、Zed、AstrBot 等所有主流 AI 工具。MIT 开源，可自托管，隐私优先。

</div>

> 一句话：给 AI Agent 一个**过目不忘、还会告诉你"为什么想起这条"**的记忆脑。
> 装上就能用——不联网、不下模型、不要 API key、零原生依赖。

> 🔴 **诚实声明（请先读）**：这是 v0.2 早期项目，单人开发、201 个测试（CI 实时验证）、**尚无真实用户验证**。
> 下方「[已知局限](#已知局限别踩坑)」把我们所有短板逐条写明了，建议先看完再决定用不用。
> 我们不做"benchmark 刷到第一"的宣传——更看重数字能被你自己复现。


---

## 已知局限（别踩坑）

**这一节比上面所有功能介绍都重要。** 逐条列清楚我们的短板，你按需判断。

### 功能上还没有的

| 缺什么 | 影响 | 说明 |
|---|---|---|
| **图检索只靠规则抽取，覆盖面窄** | 只认 6 类中文句式（住在/位于、在X工作读书、A是B的X、A的X是B、喜欢、讨厌） | 复杂句子抽不出关系。要准就手动标注 `relations`，规则只当"能抽就抽"的兜底 |
| **向量检索要你自己提供 embedding 端点** | 不配就退回纯全文（中文靠 bigram，同义词搜不到） | 支持 OpenAI 兼容的 `/embeddings`（`MEMBRANE_LLM_BASE_URL` + `MEMBRANE_EMBED_MODEL`）；也可以用 `vec` / `queryVec` 自己算好传进来 |
| **实体识别是猜的，不是模型抽的** | "北京"能靠"市/省/区"后缀认成地点，但"苹果"是公司还是水果分不出来 | 类型只是提示字段，判断错了不影响召回，只影响你读 `why` |
| **没有多语言分词质量保证** | 中文（bigram）+ 英文（整词）能用；日文/韩文/小语种效果未验证 | 只测过中英文 |
| **没有托管云** | 只能自己跑、自己备份 | 这是主动取舍（本地优先），但确实意味着换电脑要手动搬库 |

### 工程上的实话

| 项目 | 现状 | 风险 |
|---|---|---|
| **没有真实用户验证** | 201 个测试全是我们自己写的，测的是"我们以为的场景" | 真实用法可能踩到我们没想到的坑 |
| **跨进程并发只有 WAL 兜底** | SQLite 单写者模型，多进程同时写会排队 | 个人用没问题；高并发场景会成瓶颈 |
| **性能只测到 1000 条** | 1000 条写入/查询在秒级 | 10 万条以上未压测，可能变慢 |
| **doctor 样本很小** | 召回 5 条 / 更新 8 组 | **是回归自检，不是 benchmark**，不能作为跨项目横向比较的依据 |
| **单人维护** | 没有团队、没有 SLA | 提 issue 可能几天才回 |
| **半衰期/权重等参数是拍脑袋定的** | 0.4/0.3/0.2/0.1/0.1 和 90/14/365/60 天，没有调优依据 | 你的使用场景可能需要自己调 |

### 明确不打算做的

- ❌ 不做云服务 / 多租户 SaaS（本地优先是定位，不是缺陷）
- ❌ 不内置 LLM（抽取/embedding 都要你自己配，我们不烧你的钱）
- ❌ 不追求 benchmark 排名（我们只保证 doctor 数字可复现）

> 如果你需要"开箱即用的高质量图检索、成熟的向量索引（HNSW/faiss）、已经过大规模压测的方案"——
> 市面上已有成熟方案能满足这些需求，选它们就好。我们不装能。

---

## 为什么做它

Agent 记忆领域已有不少成熟项目。Membrane 选择了一个不同的切入点：

| 常见痛点 | 我们的做法 |
|---|---|
| 默认依赖云端 embedding / LLM 才能工作 | **零遥测、零原生依赖**：Node 内置 `node:sqlite`，数据全在本机一个文件 |
| 记忆过时——问"现在住哪"却返回旧地址（StaleBench 论文专题研究） | **时间感知一等公民**：每条记忆有 `valid_from`/`valid_to`/`superseded_by` 取代链，支持 `asOf(t)` 历史时点查询 |
| 召回是黑盒，"为什么给我这条？" | **可解释召回**：每条结果返回 `why` + 五项分数明细（全文 RRF / 向量 / 图路径 / 新鲜度 / 置信度） |
| 接入要改代码适配各家 SDK | **MCP 内置**：一个 server 接入 WorkBuddy / zcode / Claude / Cursor / 反重力 / AstrBot 等主流工具 |
| 性能数字难以自行复现 | **doctor 自检随包发布**：README 每个数字都来自 `doctor` 命令，克隆仓库即可自己跑 |

---

## 快速开始（三步）

### 1. 安装

需要 **Node ≥ 24**。原因：内置 `node:sqlite` 在 22.x / 23.x 是实验特性，必须加 `--experimental-sqlite` 才能用；**从 Node 24 起默认启用**。为了"装完就能用、不用记 flag"，本项目的下限设为 24。

> ⚠️ **尚未发布到 npm**。`npm install -g membrane-memory` 现在会返回 404。
> 请用下面两种方式之一安装；npm 发布后会第一时间更新本节。

**方式 A：从源码构建（推荐，能顺带跑通测试确认可用）**

```bash
git clone https://github.com/yuannuo233/membrane-memory.git
cd membrane-memory
npm install        # 只装开发依赖（typescript/vitest/tsx），运行时依赖只有 ulid
npm test           # 全部通过（当前 201 个用例）
npm run build
node dist/cli.js doctor    # 应该全部通过
```

之后用 `node dist/cli.js <命令>`，或 `npm link` 后直接用 `membrane-memory <命令>`。

**方式 B：下载 Release 里的 tgz 直接装**

到 [Releases](https://github.com/yuannuo233/membrane-memory/releases) 下载
`membrane-memory-x.y.z.tgz`，然后：

```bash
npm install -g ./membrane-memory-0.2.1.tgz
membrane-memory doctor
```

Windows 用户也可以在本仓库双击 `一键安装.bat`（自动编译 + 建库 + 自检）。

> 下面的命令示例假设你已经通过上述方式装好，`membrane-memory` 在 PATH 里。
> 如果用的是方式 A 且没 `npm link`，把 `membrane-memory` 换成 `node dist/cli.js`。

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

### 图检索：能回答"张三和李四什么关系"

```js
// 手动标注（最准）：写记忆时顺手把关系标出来
m.add({
  content: "张三是李四的同学",
  subject: "张三",
  relations: [{ to: "李四", predicate: "同学", toType: "person" }],
});

// 规则抽取（不写也行）：认得出 6 类中文句式，抽不到就不硬抽
m.add({ content: "用户住在北京", subject: "用户" });      // → 用户 --住在--> 北京

m.relations("张三和李四");                  // → 张三 与 李四：同学
m.relations("张三和李四是什么关系");         // 传整句也能自己认实体
m.relations("张三", "腾讯", { maxHops: 2 }); // 两跳：张三→李四→腾讯
```

关系也是**时间感知**的：记忆被取代/遗忘时，它派生的关系一起失效，
`asOf(t)` 仍能查到当时的关系。图路还会作为**第五路候选**进入统一打分，
所以"词面完全对不上、但关系对得上"的记忆也能被召回——`why` 里会写清是哪条路径。

### 向量检索：配一个 embedding 端点就能用

```bash
# OpenAI 兼容的 /embeddings 端点（不配就纯全文，行为与 v0.1 完全一样）
set MEMBRANE_LLM_BASE_URL=https://api.openai.com/v1
set MEMBRANE_LLM_API_KEY=sk-...
set MEMBRANE_EMBED_MODEL=text-embedding-3-small

membrane-memory add "用户住在北京" --subject 用户   # 自动算向量
membrane-memory search "他老家在哪"                # 查询向量 + 全文 一起融合
membrane-memory embed-backfill                     # 老库一次性回填（分批，内存可控）
membrane-memory export --out backup.json           # 备份全部记忆/证据/关系/向量
membrane-memory import backup.json                 # 换机器/换库后恢复
```

也可以完全绕过网络：`add({ vec })` 传预算好的向量，`recall({ queryVec })` 传查询向量。
**算向量失败绝不阻断写入**——记照样记，只是这条没有向量、退回纯全文。

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

检索用 FTS5（中文 bigram 分词）+ 可选向量 + 可选图路径，RRF 融合后每条结果返回：

- `why`：人类可读的入选理由（含"关系第 k 名（甲 --谓词--> 乙）"这类图路解释）
- `breakdown`：`rrfText` / `rrfVec` / `vecSim` / `rrfGraph` / `graphPaths` / `freshness` / `confidence` / `ageDays` / `halfLifeDays` / `weights`

五项权重是**相对权重**，缺哪一路就把它归零、其余按比例摊到和=1，所以分数上界恒为 1.0。

### 接入面（三开门）

| 门 | 命令 | 说明 |
|---|---|---|
| SDK | `import { Membrane }` | ESM + 完整 TypeScript 类型 |
| CLI | `add / search / relations / link / entities / embed-backfill / list / stats / export / import / mcp-config / mcp / serve / doctor` | 命令行全覆盖 |
| MCP | `membrane-memory mcp` | stdio，10 工具，接入所有 Agent 工具 |
| REST | `membrane-memory serve` | mem0 兼容子集（`/v1/memories`）+ Web 控制台，默认 127.0.0.1 |

> 不想手写接入配置？`membrane-memory mcp-config <客户端>` 直接生成（21 个客户端，node/数据库路径自动填好）。
> 每个场景怎么配、怎么调、别怎么用，见 **[使用场景.md](使用场景.md)**。
> 非 MCP 生态（OpenAI Function Calling / LangChain / Dify HTTP / 自写 Agent）见
> **[适配配置/REST与SDK接入.md](适配配置/REST与SDK接入.md)**，含四份 function schema 与 Node/Python 零依赖客户端。

### Web 控制台：能看、能改、能忘

`membrane-memory serve` 后打开 `http://127.0.0.1:8317`（或双击 `启动控制台.bat`）：

- **三档 Token 模式**（顶栏切换，刷新后记得）：省 Token（`ultra` + 3 条）/ 平衡（`brief` + 8 条）/ 完整（`full` + 8 条）
- **记忆详情**：正文、状态、时间区间、标签、实体、关系、证据、完整审计链
- **编辑**：改正文/类型/主语/置信度/标签/pin，保存为**新版本**，旧版本进历史（不会原地覆盖）
- **遗忘**：软删除，墓碑仍可查；台账可筛选 namespace / kind / 是否含历史版本
- **导出备份**：一键下载完整 JSON（含向量，可 `import` 恢复）

对应的 REST 编辑接口：`PATCH|PUT /api/memories/:id`、`DELETE /api/memories/:id`。
控制台只监听本机；要远程访问必须设 `MEMBRANE_TOKEN`。

### 备份与恢复：一个 JSON 文件就是全部

```bash
membrane-memory export                        # 默认导出到当前目录 membrane-backup-<时间>.json
membrane-memory export --out 我的备份.json --no-embeddings
membrane-memory import 我的备份.json          # 按 id 去重，不覆盖目标库现有数据
```

导的是**库的全部真相**：含被取代、已遗忘的底稿、证据、实体关系与向量，
所以恢复之后 `asOf` 历史查询照样能查。SDK 里是 `exportAll()` / `importAll(bundle)`。
导入是幂等的——同一份备份导两次，第二次全部跳过；实体按 `(namespace, name)` 复用，
不会因为两边 id 不同就插出一堆断边。

### Docker（可选）

```bash
docker build -t membrane-memory .
docker run -d --name membrane -p 8317:8317 \
  -v membrane_data:/data \
  -e MEMBRANE_TOKEN=change-me \
  membrane-memory
```

数据落在 `/data/membrane.db` 这个 volume 里；镜像基于 Node 24，多阶段构建，运行时不带编译器。
不设 `MEMBRANE_TOKEN` 时服务只监听容器内网，端口映射到宿主机前请先设 token。

---

## 可复现自检（doctor）

README 里的数字全部来自 `membrane-memory doctor`——**换台机器跑，结果一样**（固定时钟 + 内存库）。

```
╔══════════════════════════════════════════════╗
║   Membrane Doctor · 可复现自检报告 v0.2.1      ║
╚══════════════════════════════════════════════╝

【剧本 1 · 写入召回】      命中率 100%  (5/5)
【剧本 2 · 陈旧更新】      current@1 88%  (7/8)
                          contamination@5 0%
【剧本 3 · 跨会话持久性】  重启召回 成功 ✓
【剧本 4 · 向量检索】      纯向量命中 ✓  余弦 1.00  vec 分量已参与
【剧本 5 · 图检索】        直接答"张三 与 李四：同学" ✓
                          两跳可达 2 条边  图路已参与打分

总体：全部通过 ✓
```

剧本 4/5 **完全离线**：向量是手工构造的单位向量，关系是手动标注的，
所以任何机器跑出来的数字都一样，也不会因为断网让 CI 变红。

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
- [适配配置/](适配配置/) — 各 AI 工具接入模板

技术栈：TypeScript / Node `node:sqlite` / 零第三方运行时依赖（仅 `ulid`）。

## License

MIT © 2026 Membrane Contributors
