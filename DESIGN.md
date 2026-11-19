# Membrane 设计大纲（活文档）

> **membrane = mem + brain，记忆脑**。时间感知、本地优先、可解释的 Agent 记忆引擎。
> TypeScript / Node 实现，MIT 协议，`npx membrane-memory serve` 一条命令跑起来。
>
> 📌 **本文件是活文档**：每完成一项里程碑，必须在「进度清单」打勾并更新"当前状态"段。
> 任何 agent 接手：先读本文 → 跑测试 → 认领未勾选项。改架构必须先改本文并说明理由。

---

## 0. 为什么做（设计目标）

Agent 记忆领域的常见痛点，以及本项目的技术对策：

| 常见痛点 | 本项目的对策 |
|---|---|
| 性能宣称难以复现 | **一切数字可复现**：自带 doctor 评测套件，固定时钟，跑分脚本随包发布 |
| 依赖云端 embedding / LLM 才能工作 | **零依赖降级**：没有 API 也能跑（SQLite FTS5 全文检索兜底），有 API 则向量+全文混合 |
| 典型的"陈旧检索"问题（参见 StaleBench 论文） | **时间感知是一等公民**：每条记忆带生效时间与取代链，支持历史时点查询 |
| 召回是黑盒（为什么给我这条？） | **可解释召回**：每条结果返回 why 与分数明细（全文 RRF / 向量 / 图路径 / 时间 / 置信度） |
| 接入需按各家 SDK 改代码 | **MCP 内置** + mem0 兼容 REST 子集（drop-in 替换） |

## 1. 非目标（明确不做，防止跑偏）

- 不做云服务、不做多租户 SaaS（本地优先）
- 不做向量数据库通用引擎（只服务记忆场景）
- 不内置 LLM 推理（抽取/反射需要 LLM 时走用户配置的 OpenAI 兼容端点）
- **不做图数据库**（v0.2 的图检索只是三张关系表 + BFS，不引 Neo4j 之类；也**不引** sqlite-vec / hnswlib / faiss 等向量索引扩展，向量现扫现算，靠分批控内存）

## 2. 架构（文字图）

```
┌─ 接入层 ──────────────────────────────────────────────┐
│  MCP Server (stdio)  │  REST API (serve 模式)  │  CLI  │
│  mem0 兼容子集        │  /v1/memories/*         │       │
└──────────────┬───────────────────────────────────────┘
               ▼
┌─ 核心引擎 CoreEngine ─────────────────────────────────┐
│ 1 Ingest：抽取→去重→冲突检测→时间标记→入库→（可选）向量/关系│
│ 2 Recall：全文 + 向量 + 图路径 + 时间过滤 + RRF 融合 + 明细 │
│ 3 Forget：软删除/取代/遗忘曲线衰减（连带关闭派生关系）    │
│ 4 Reflect(v0.3)：周期性巩固（片段→事实摘要）              │
└──────────────┬───────────────────────────────────────┘
               ▼
┌─ 存储层 Storage ──────────────────────────────────────┐
│ SQLite 单文件：memories + entities + relations         │
│ + memory_entities + history + settings                 │
│ FTS5 全文索引（BM25 内建）│ 向量缓存表（可选）          │
└───────────────────────────────────────────────────────┘
```

## 3. 数据模型（SQLite）

```sql
-- 记忆主表
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,        -- ulid
  kind        TEXT NOT NULL,           -- fact | episode | preference | procedure
  content     TEXT NOT NULL,           -- 记忆正文
  subject     TEXT,                    -- 主语（如 "用户" / 实体名），冲突检测键的一部分
  tags        TEXT,                    -- JSON 数组
  confidence  REAL NOT NULL DEFAULT 1, -- 置信度 0~1
  source      TEXT,                    -- 来源（mcp/rest/cli/agent 名）
  created_at  INTEGER NOT NULL,        -- unix ms UTC
  updated_at  INTEGER NOT NULL,
  valid_from  INTEGER NOT NULL,        -- 生效起始（时间感知核心）
  valid_to    INTEGER,                 -- 被取代/失效时间（NULL=现行有效）
  superseded_by TEXT,                  -- 取代它的记忆 id（取代链）
  deleted     INTEGER NOT NULL DEFAULT 0,  -- 软删除
  pin         INTEGER NOT NULL DEFAULT 0   -- 用户钉选，永不衰减/不被自动清理
);
CREATE TABLE memory_fts ( ... );        -- FTS5 虚拟表（content=正文），bm25 排序
CREATE TABLE embeddings ( id TEXT PRIMARY KEY, dim INTEGER, vec BLOB );  -- 向量缓存（可选）
CREATE TABLE history (                  -- 审计：每条记忆的增改史（可解释/可回滚）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT, op TEXT, at INTEGER, detail TEXT
);
CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT );

-- v0.2 新增：图检索三表（SCHEMA_VERSION 1 → 2，加法式迁移：新表 IF NOT EXISTS，不重建老表）
CREATE TABLE entities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,      -- person|place|org|thing|event|topic|unknown
  namespace  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entities_ns_name ON entities(namespace, name);  -- 同名同库里只留一个节点
CREATE TABLE relations (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL, to_id TEXT NOT NULL,
  predicate  TEXT NOT NULL,       -- 自由的谓词字符串（同学/住在/工作于…）
  memory_id  TEXT,                -- 这条关系是从哪条记忆读出来的（可溯源、可失效）
  confidence REAL NOT NULL DEFAULT 1,
  valid_from INTEGER NOT NULL, valid_to INTEGER,   -- 关系也遵守时间感知
  namespace  TEXT NOT NULL
);
CREATE TABLE memory_entities ( memory_id TEXT NOT NULL, entity_id TEXT NOT NULL );
```

> **为什么 entity 的唯一键是 (namespace, name) 而不是 (namespace, name, type)**：
> "苹果"是公司还是水果，靠字符串本身分不出来；若按 type 唯一，同一个名字会分裂成两个节点，
> 一跳关系就断了。所以 type 只当**属性**，允许从 unknown 升级到具体类型。

> **向量为什么不用 sqlite-vec**：那会破坏"零原生依赖"这个卖点（得装扩展二进制）。
> 现在 `embeddings` 表存 BLOB，检索时按 `rowid` keyset 分批扫（默认 512 条一批），
> 调用方只维护 `2×poolSize` 的 top-K 数组逐批剪枝——内存 O(K)，不随库大小增长。
> 10 万条级别的延迟未压测，这是 v0.2 已知的性能天花板。

> **实现注记（2026-11-19）**：`memory_fts` 采用 FTS5 + 自建 bigram 分词索引——SQLite 内置 `unicode61`
> 不切中文（整句变成一个 token，等于搜不了中文），`trigram` 又要求查询 ≥3 字。故 FTS 的索引列
> 存的是"正文分词后的 token 串"：CJK 相邻两字滑窗（bigram）+ 拉丁/数字整词小写；查询侧同法分词，
> 先 AND 后 OR 降级。FTS rowid 与 memories.rowid 对齐，增删改由 Storage 统一维护。只改 FTS 列内容，
> 不改上表结构。

> **实现注记（2026-11-19）**：history 的 op 取值 `add | supersede | forget | keep-both`，
> detail 为 JSON（相似度/策略/原因），保证取代链全程可审计、可回放。

## 4. 检索算法（v0.1 就要可解释）

1. **候选召回**（四路并集）：
   - 全文：FTS5 BM25 取 topK₁
   - 向量：余弦 topK₂（有 query 向量时；分批扫描现算）
   - 图：实体名出现在 query 里 → 认种子实体 → BFS（1~3 跳）→ 命中边反查记忆
   - 模糊兜底：`char_index` 倒排（全文没结果时才启用）
2. **过滤**：只取现行有效（valid_to IS NULL）且未软删除；支持 `asOf(t)` 历史时点查询
3. **融合打分**（RRF，倒数排名融合）+ 显式加权：
   `score = w_text·rrfText + w_vec·rrfVec + w_graph·rrfGraph + w_time·freshness + w_conf·confidence`
   五个权重是**相对权重**，默认 (0.4, 0.3, 0.1, 0.2, 0.1)；
   运行时把"这一路没有候选"的分量归零、其余按比例重标到和=1（`normalizeWeights`），
   保证分数上界恒为 1.0，也保证"没配向量时行为与 v0.1 一致"。**每条结果返回各项分值明细**
4. **新鲜度**：`freshness = exp(-age_days / half_life)`，半衰期可按 kind 配置
5. 结果附 `why` 字段：人类可读的入选理由（图路会写"关系第 k 名（甲 --谓词--> 乙）"）

> **v0.2 修掉的一个隐性 bug**：v0.1 里向量候选/图候选是混进 `textRank` 的（按 bm25=-sim 排序），
> 等于白送一份全文分。现在 `gatherCandidates` 返回分离的 `textHits / vecHits / graphHits`，
> `textRank` 只由全文路（或模糊兜底路）产生。

> **公式细化（2026-11-19，M4 校准 freshness）**：RRF 用**归一化**倒数排名 `rrf_i = (K+1)/(K+rank_i)`（K=60，rank 从 1 起，
> 未命中=0，第 1 名=1.0），总分 `score = w_text·rrf_text + w_vec·rrf_vec + w_time·freshness + w_conf·confidence`。
> 归一化是刻意的：朴素 `1/(60+rank)` 量级仅 ~0.016，会被 freshness/confidence（量级 0~1）淹没导致权重失效。
> **freshness（M4 修正）**：`freshness = exp(-ln2 · age_days / half_life)`——age=halfLife 时恰好 0.5，名副其实。
> 旧版 `exp(-age/halfLife)` 在 age=halfLife 时是 1/e≈0.368（参数实为时间常数），已废弃。
>
> **相似度量（2026-11-19）**：无 embedding 时用 token 包含系数 `sim = |A∩B| / min(|A|,|B|)`（A/B 为
> bigram 分词集）；有 embedding 时用余弦。取代带阈值：包含系数 ≥0.55 / 余弦 ≥0.85；并存带阈值：
> 包含系数 ≥0.35 / 余弦 ≥0.60。选包含系数而非 Jaccard，是因为"用户住在北京"→"用户住在上海"这类
> 换地名的改写 Jaccard 仅 ~0.43 会漏判冲突，包含系数 0.6 正确落入取代带（数据见 ingest 测试）。
>
> **新鲜度默认半衰期**（按 kind，天数，可在构造 Membrane 时覆盖）：fact=90、episode=14、
> preference=365、procedure=60。年龄从 `valid_from` 起算；`asOf` 查询时以 asOf 为"现在"。

## 5. 冲突与过期策略（时间感知核心）

写入新记忆时，按 (subject + kind) 找现行有效且语义相似的旧记忆：
- 相似度 ≥ 高阈值 → **取代**（旧的 valid_to=now、superseded_by=新 id），历史留痕
- 相似度 ∈ 中间带 → **并存**（两条都保留，召回时都返回，由上层 LLM 裁决）
- 策略可配：`supersede | keep-both | error`，默认 supersede
- pin 的记忆永不自动取代（只提醒冲突）

## 6. 接入面（三个门全开）

| 门 | 形态 | 说明 |
|---|---|---|
| MCP | stdio，`npx membrane-memory mcp` | 10 工具：add / recall / forget / get / history / list / evidence / stats / link / relations |
| REST | `npx membrane-memory serve --port 8317` | **mem0 兼容子集**：POST /v1/memories（add）、POST /v1/memories/search、GET /v1/memories/{id}、GET /v1/memories/{id}/history——drop-in 替换 |
| SDK/CLI | `import { Membrane } from "membrane-memory"`；CLI：add/search/list/export/doctor | Node ≥24，ESM |

## 7. 抽取管线（Ingest）

- **直写模式**：调用方已提炼好的记忆直接 add（零 LLM 依赖）
- **抽取模式**：`membrane add --text "一大段对话"` → 调用用户配置的 OpenAI 兼容端点（提示词内置）抽取候选记忆 → 逐条走冲突检测 → 返回"存了什么/跳过什么/取代了谁"的清单
- 无 LLM 时抽取模式不可用，但直写/检索/全 API 正常——**这是零依赖降级的底线**
- **图抽取（v0.2）**：`src/graph-extract.ts` 只用正则认 6 类高置信度中文句式（住在/位于、在X工作·任职·读书、
  A是B的X、A的X是B、喜欢/爱、讨厌），每条规则显式声明 `aSlot/bSlot` 防语序抽反；槽位限 1~10 个汉字/字母/数字/·
  并拒单字与纯虚词。**手动标注 `relations` 时完全跳过规则抽取**——错的关系比没有关系更糟。

## 8. Doctor 自检（可复现承诺）

`npx membrane-memory doctor` 内置五套剧本，全部确定性（种子固定、固定时钟 `T0`），且**后两套完全离线**：
1. **写入召回**：N 条事实写入 + 干扰项 → 命中率
2. **更新陈旧**：写入→更新→按旧问法查询→应返回新值（对抗陈旧检索）
3. **跨会话**：进程重启后再召回（持久性）
4. **向量检索**：4 条手工单位向量 → 用"全文搜不到"的假词逼向量路独立发现候选 → 验余弦=1.00 且 vec 分量参与打分
5. **图检索**：手动标注两条关系 → 验"张三和李四什么关系"能直接答、张三→腾讯两跳可达、图路进入综合打分

> 剧本 4/5 刻意不调真 embedding 端点：CI 里断网、没 key 也必须能跑，且数字必须人人可复现。
输出 JSON + 人类可读报告（延迟、命中率、失效正确率）。**README 里的任何数字必须来自 doctor 输出**。

## 9. 安全与隐私

- 全部本地单文件（membrane.db），无遥测、无上传；embedding 端点是唯一可选外发（用户显式配置）
- REST 默认绑定 127.0.0.1；开 0.0.0.0 必须设 token（Bearer）
- 单元测试必须覆盖：FTS 注入无害化、路径/配置边界、并发写

## 10. 依赖白名单（新增依赖需在此登记）

- **存储（2026-11-19 决策）**：**采用 Node 内置 `node:sqlite`（DatabaseSync），弃用原计划的
  `better-sqlite3`**。理由：① 零原生依赖——npm install 不再下载预编译二进制，安装失败率归零，
  契合"本地优先、`npx` 一条命令跑起来"；② API 同步调用，与 better-sqlite3 体验一致；
  ③ 供应链面更小。代价：**要求 Node ≥24**。`node:sqlite` 在 22.x/23.x 属实验特性，必须加 `--experimental-sqlite` flag；Node 24 起默认启用。
  `package.json` 的 `engines` 已如实写 `>=24.0.0`。若未来要接 sqlite-vec 向量扩展，再回来重新评估。
- `ulid`（ID 生成）——**当前唯一的运行时依赖**
- 开发依赖：`typescript`、`vitest`、`tsx`、`@types/node`。其余一律先讨论。
- **v0.2 未新增任何依赖**（向量检索、图检索全部手写）：没有 `sqlite-vec`、没有 `hnswlib`、没有 `faiss`、
  没有图数据库客户端。要加 ANN 索引属于破坏"零原生依赖"的决定，必须先在本节登记并说明理由。

> **已移除的依赖（2026-11-19）**：原计划用 `@modelcontextprotocol/sdk` 实现 MCP，
> 后改为**零依赖手写 JSON-RPC**（只需 `initialize` / `tools/list` / `tools/call` / `ping`
> 四个方法，手写更可控，也不必引 SDK 的整棵依赖树）。该包已从 `package.json` 删除，
> `src/mcp.ts` 中确认无任何引用。

## 11. 进度清单（活文档核心——完成一项勾一项）

### M1 地基
- [x] 仓库脚手架（package.json/tsconfig/vitest；bin 字段已声明，实际 cli.ts 属 M3）
- [x] Storage：建表 + FTS5 + CRUD + history 审计
- [x] 模型与校验（kind 枚举、content 非空、时间戳）

### M2 引擎 ✅ 完成（2026-11-19）
- [x] Ingest 直写 + 去重 + 冲突取代链（src/engine.ts：4 状态 + pin 保护 + 3 策略）
- [x] Recall 混合检索 + RRF + 分数明细 + asOf 历史查询（归一化 RRF K=60，why 字段）
- [x] Forget/软删除/衰减（软删保留审计，asOf 可查删除前）
- [x] 抽取模式（src/extract.ts：OpenAI 兼容端点 + embedding 预留 + 零依赖降级 + 脏候选跳过）
- 测试：engine 18 + extract 9，累计 **60/60 全绿**。

### M3 接入面（基本完成）
- [x] REST（src/server.ts，零依赖 node:http）：mem0 兼容子集（/v1/memories + /search）+ 原生 /api/* + Bearer token（绑非本机地址时强制）+ 默认 127.0.0.1
- [x] **Web 控制台**（web/index.html + app.css + app.js，深色仪表盘）：Overview/Ingest/Recall/Ledger/Audit 五视图，专业术语（RRF/Bi-temporal/Contamination 等）。`启动控制台.bat` 一键打开 http://127.0.0.1:8317
- [x] MCP stdio server（**10 工具**：add/recall/forget/get/history/list/evidence/stats + v0.2 新增 link/relations，零依赖手写 JSON-RPC）
- [x] CLI：add/search/list/stats/mcp（doctor 占位到 M4；export/serve 未做）
- [x] Node SDK 出口（ESM + 类型，index.ts 已导出 Membrane/引擎函数/抽取）
- 📦 配套：`一键安装.bat`（GBK+CRLF，实测通过）+ `适配配置/各工具接入配置.md` + `安装说明.md`
- 📌 MCP server 端到端验证抓到并修复一个真 bug：handleLine 返回值未写 stdout（单元测试测不到，真进程测试抓到）。

### M4 Doctor 与文档 ✅ 基本完成（2026-11-19）
- [x] doctor 三剧本 + JSON/文本报告（src/doctor.ts）：写入召回 100%(5/5)、current@1 88%(7/8)、contamination@5 0%、跨会话成功。`membrane-memory doctor` 可复现，运行后在本地生成报告文件
- [x] README.md（中文主文件）+ README.en.md + llms.txt（数字来自 doctor，明确标注"检索命中率非端到端QA"口径）
- [x] 测试 **85/85 全绿**（model/storage/engine/extract/mcp/server，含 P1/P2 新用例）
- [x] freshness 校准为真·半衰期公式 exp(-ln2·age/halfLife)
- [x] publish 验证：npm pack --dry-run 通过（35 文件 / 65.8KB / dist+web 齐全）

### M5 v0.2 向量检索 + 图检索 ✅ 完成（2026-11-19）
- [x] 向量真正可用：`add({vec})` 同事务落库、`addAsync` 自动算向量、`embed-backfill` 老库回填、`scanEmbeddings` keyset 分批控内存
- [x] 维度守卫：库内已有向量且维度不同 → 本次跳过落库（`embeddingStatus="skipped"`）并给提示，**绝不阻断写入**
- [x] 图检索从零：`entities`/`relations`/`memory_entities` 三表（schema 1→2 加法式迁移）、手动标注 + 6 条规则抽取、一跳/多跳、作为**第五路候选**进入统一打分
- [x] 关系时间感知：记忆被取代/遗忘 → 派生关系 `valid_to` 关闭，不删行，`asOf` 仍可查
- [x] 断言面扩展：CLI（relations/link/entities/embed-backfill）、MCP（10 工具）、REST（/api/relations、/api/entities）
- [x] doctor 扩到 5 剧本 7 项检查，原三项数字保持不变（100% / 88% / 0%）
- 测试：新增 vector 16 + graph 26，累计 **175/175 全绿**（10 个测试文件；v0.2.1 质量版增至 **201/201**，13 个文件；v0.2.2 运维版增至 **210/210**，15 个文件）

### 当前状态（2026-11-18——M1~M5 + 质量版 + 可观测版全部完成，210/210 全绿）
- ✅ **M1 + M2 + M3(MCP/CLI/REST/UI) + M4 + M5 全部验收**：`npm test` = 构建(tsc)通过 + vitest **210/210 全绿**
  （model 15 + storage 18 + engine 37 + extract 9 + mcp 9 + server 21 + tenant 10 + robustness 24 + vector 16 + graph 26 + portability 6 + mcp-config 7 + update 6 + logger 4 + isolation 2）。
  - MCP server 经**真实子进程端到端验证**（initialize/tools-list/add/recall 全通，退出码 0）——抓到并修复"handleLine 未写 stdout"的真 bug。
  - REST+UI 经**真实 HTTP 端到端验证**（add/recall/stats 全通）——抓到并修复"webDir 用 cwd 导致换目录启动 UI 404"的真 bug。
- 📋 适配矩阵已核实：zcode（智谱 GLM）、WorkBuddy、DeepSeek Harness、Claude、Cursor/Cline/Windsurf/反重力/AstrBot 等均可用同一 MCP server 接入，见 `适配配置/`。
- ✅ **多租户隔离**：`memories.namespace`（默认 "default"）+ 建表/去重/取代/召回/列表/实体/关系全链路过滤 + `ensureColumn` 幂等迁移 + REST/MCP/CLI 全接入。
  - ⚠️ 迁移注意：索引 `idx_memories_ns` 必须在**建列之后**创建，否则老库升级报 `no such column: namespace`（已修 + 回归测试覆盖）。
- 📊 doctor 数字（6 剧本 9 项）：召回 100%(5/5)、current@1 88%(7/8)、contam@5 0%、跨会话 ✓、向量余弦 1.00、图关系答出 + 两跳 2 边、隔离串扰 0 + 同 namespace 混召回复现——README 数字全部来自它。
- ✅ **v0.2.1 质量版**：删除 5 处死代码；抽出 `src/input.ts` 统一 CLI/MCP/REST 三套入参解析（消除口径漂移）；修 `GET /api/memories` 的 `limit` 失效、脏 kind 导致 NaN 分、`forget` 残留 `memory_entities` 三个真 bug；新增 `exportAll`/`importAll` 全量 JSON 备份（含历史底稿/证据/图/向量，幂等导入）；新增 `mcp-config` 接入配置生成器（21 个客户端，路径自动填）。
- ✅ **v0.2.1 编辑 + 控制台 v2**：`engine.update/updateAsync` 版本化编辑（新版本取代旧版本，旧正文/证据/关系保留，`asOf` 仍可查）；REST `PATCH|PUT|DELETE /api/memories/:id`；控制台支持 ultra/brief/full 三 Token 模式、详情、编辑、遗忘、台账筛选、备份导出；补真实 HTTP PATCH 防回归测试。
- ✅ **v0.2.1 生态**：OpenAI Function Calling 四件套、REST/SDK 接入手册、Node/Python 零依赖客户端、Dockerfile（Node 24 多阶段 + `/data` volume）。
- ✅ **v0.2.2 可观测版**：`MemoryLogger` JSONL + ring + 字段脱敏（正文/查询/证据/token 拒写）；`/api/admin/diagnostics`、`/api/admin/logs`、`/api/admin/isolation-check`；控制台 Ops/Admin 页；`probeTaskIsolation()` 证明同 namespace 会混、跨 namespace 零泄漏；doctor 增至 6 剧本 9 项检查。
- ✅ 源码结构：`src/`（types / model / tokenize[中文bigram] / ulid / storage / config / input[入参解析] / logger / isolation / index
  / engine[门面] / extract[抽取] / llm[端点封装] / graph-extract[规则抽取] / mcp-config[接入配置生成] / mcp / server / doctor / cli）；`test/` 15 套测试。
- 复跑命令：`npm test`（等价于 `tsc -p tsconfig.json && vitest run`）；文档一致性 `npm run check`。
- ✅ **freshness 已校准**：采用真·半衰期公式 `exp(-ln2·age/halfLife)`，age=halfLife 时=0.5；文档第 4 节与测试同步更新。
- 仍未做（明确留给 v0.3）：Reflect 周期性巩固、真正的语义级实体消歧（"苹果"公司/水果）、
  10 万条以上的向量检索压测、sqlite-vec 之类的 ANN 索引（如要引，必须先改第 10 节依赖白名单）。
- 环境备忘：Node v24.22.3 已在 `..\tools\nodejs\`（勿重装，node:sqlite 内置可用）；
  存储决策=弃 better-sqlite3 用 node:sqlite（零原生依赖）；npm 缓存必须指向 `tools\npm-cache`。
  npm 新策略会跳过 esbuild 的 postinstall（安全警告），实测不影响 vitest 运行。

## 12. 交接规范（随时可交接的保证）

1. 本文勾选框 = 唯一进度事实源；代码与文档不同步视为 bug
2. 提交纪律：一个里程碑至少一个中文 commit；禁止 `git commit` 大杂烩
3. 分支：main 单干（小团队），破坏性实验开 feature/ 分支
4. 接手五步：读本文 → `npm test` 全绿 → 跑 doctor 确认 → 看未勾选项 → 认领
5. 所有"为什么这么设计"写进代码注释就近处；跨模块的决策写回本文
