# 更新日志（CHANGELOG）

本文件记录 Membrane 每一版的改动。**每条都写清楚：修了什么、为什么是问题、怎么修的、影响哪些文件。**

版本号规则：`主版本.次版本.修订号`（语义化版本）。
- 主版本：有破坏性变更
- 次版本：加了新功能
- 修订号：只有修 bug / 优化

---

## v0.2.7 — 2026-11-20

### 关系抽取可评测 + 可选 LLM 抽取 + 真实向量压测入口 + 可选 ANN 适配层

> 对应外部评审的三条弱项：规则抽取弱、规模未验证、索引不够成熟。
> 默认路径不变：零依赖 LSH、零网络、单 SQLite 文件。

**P0：关系抽取评测与可选 LLM 抽取**
- 新增 `bench/extraction-cases.json`（27 条人工用例）与 `npm run eval:extract`
  （`scripts/eval-extract.mjs`，支持 `--min-f1` / `--json`）。
- 首轮只有 22/27，暴露出三个真问题并修复：
  1. `张三和李四不是同学` 被抽成 `张三|同学|李四不`（`SLOT` 贪心吃掉“不”）；
  2. “讨厌下雨天和堵车”被抽成一个超长宾语；
  3. 实体与谓词之间的中文逗号/空格导致漏抽。
- `src/graph-extract.ts`：
  - 新增 `GAP = "[，,、；;\\s]*"`，允许实体和谓词之间有标点/空格；
  - 新增对称关系规则（`A和B是同学/同事/朋友/合伙人/邻居/室友`）；
  - “喜欢/讨厌”的宾语按 `和/与/、` 拆分，生成多条关系；
  - 对称规则加 `(?<!不)`，避免把否定句抽成正关系。
- 修复后：**27/27，TP=26、FP=0、FN=0，precision=recall=F1=1.0**。
  这是自建回归集，不是开放世界盲测；边界写在 `bench/EXTRACTION.md`。
- 新增可选 LLM 抽取器 `src/graph-extract-llm.ts`：
  `extractGraphWithLlm()` / `parseGraphResponse()` / `GRAPH_EXTRACT_SYSTEM_PROMPT`；
  走 OpenAI 兼容 `/chat/completions`，容忍 ```json 围栏，逐条校验实体/关系，
  代词与省略主语映射到 subject，脏数据跳过不拖垮整批。
- `GraphOptions.llmExtract`（默认 false）、`GraphOptions.llmConfidence`（默认 0.8）；
  `addAsync(input, { relationExtraction: "llm" | "rules" })`。
  手动 `entities/relations` 永远优先；LLM 失败/空结果/未配置 model 自动回退规则，
  `AddResult.note` 会写明“已回退规则”。
- 新增 `test/graph-llm.test.ts` 10 个测试（注入 fetch，不打真网络）。

**P1：百万级压测 + recall@k + 真实向量入口**
- `scripts/bench-scale.mjs` 新增：
  - `--recall`、`--recall-queries`、`--recall-k`：同一查询向量分别走 LSH 与精确全扫，
    输出 `recall@10`、`recall@k`、两侧耗时；
  - `perturb()`：给查询向量加 15% 确定性噪声；
  - `--vectors <jsonl>`：真实向量入口，一行 `{"id","vec","content","subject","namespace"}`，
    绕过 embedding API 直接入库；
  - `--query-vectors <jsonl>`：真实查询向量；
  - `--db <path>`：指定库路径。
- 10k × 1536 实测：`recall@10=100.0%`、`recall@100=99.0%`；
  LSH avg 152.7ms，精确全扫 avg 4,175.7ms（该数字与 100k 口径不一致，见 `bench/README.md` 待复核注记）。
- 100k × 1536 冷缓存复测：`recall@10=100.0%`、`recall@100=99.3%`；
  LSH avg 4.96s、精确全扫 avg 119.0s（与历史 298ms/10.9s 差一个数量级，是冷页缓存/磁盘压力导致，不是代码回归；见 bench 说明）。
- **1M × 768 压测完成**（100 万条、768 维；测量时库 5.7GB，测完已删除临时库，结果见 `bench/results-1000000-768.json`）：
  写入 694.8s（约 1,439 条/s）；FTS-only avg 2.61s；vector-only avg 8.00s / **p50 3.56s** / p95 25.9s；
  hybrid avg 13.41s / p50 6.26s；top-1 命中。
- **1M 下暴露并修复两个真实性能问题**：
  1. `vector_lsh` 精确桶命中 `LSH_PROBE_LIMIT=50k` 时，旧逻辑回退百万级精确全扫，
     单次查询 2 分钟以上；改为直接对截断后的 5 万候选做精确重排（召回边界写进 README）。
  2. `searchFtsOnce` 的 `memory_fts JOIN memories` 在 1M 下被 SQLite 选成
     "先扫 100 万行 memories 再回查 FTS"，0 命中查询也要 24.7s；改为
     `WITH f AS MATERIALIZED` 先算 FTS 命中集，0 命中降到 ~2ms，宽查询 ~2.4s。
- 1M × 768 稳态查询从 **156s（修复前首查）→ 3.5s p50（修复后）**。

**P2：可选向量索引适配层**
- 新增 `VectorIndex` 接口（`src/vector-index.ts`）：
  `search()` 返回 `null` = 不可用，回退 LSH；返回 `[]` = 可用但无候选，不退化成全扫。
- 新增 `HnswVectorIndex`（`src/vector-index-hnsw.ts`，可选 `hnswlib-node`）。
- 新增 `SqliteVecVectorIndex`（`src/vector-index-sqlite-vec.ts`，可选 `sqlite-vec` 或
  用户提供 `extensionPath`；索引放独立内存库，不碰主库）。
- `MembraneOptions.vectorIndex` 注入；`Storage` 在写入/删除时同步维护，
  首次查询从 `embeddings` 全量重建；适配器抛错只影响本进程查询，写入不受影响。
- 两者都**不进 `dependencies` / 不做 peerDependency 硬约束**；
  缺包抛 `E_VECTOR_INDEX_UNAVAILABLE`，默认 LSH 完全不受影响。
- 新增 `test/vector-index.test.ts` 8 个测试（假索引注入、空结果、回退、命名空间过滤、重启重建、删除同步、缺包报错）。
- 文档：`适配配置/可选向量索引.md`；`DESIGN.md` 第 10 节已登记该可选依赖决策。

### 找 bug 轮修复（2026-11-20 晚，全量源码审查 + 实测复现）

> 主智能体通读全部源码（src 24 文件 + web + bat + 打包配置），逐条实测复现后修复。
> 另有两点文档级修复（相似度公式口径、health 免鉴权承诺落地）。

- **mem0 兼容端点尾斜杠**：`POST /v1/memories`（不带斜杠）与 `POST /v1/memories/search/`（带斜杠）
  此前都 404——mem0 官方习惯带尾斜杠，drop-in 兼容面缺了一半。现在两种写法都接受（src/server.ts）。
- **/api/health 免鉴权落地**：DESIGN.md 第 9 节与多处注释承诺"health 免鉴权仅探活"，
  但实现把所有 /api/* 都拦在令牌后（实测 401，与文档矛盾）。现在 GET /api/health 豁免鉴权
  （只返回版本号，无数据），探活/监控可用；其余数据接口仍然一律要令牌（src/server.ts）。
- **Bearer scheme 大小写不敏感**（RFC 7235）：`bearer xxx` 此前被拒（401），现在放行（src/server.ts）。
- **Storage.getMany 真分批**：注释称"按 400 一批切分"但实现没切，4 万个 id 直接
  `too many SQL variables` 抛错。触发链 = REST recall 的 limit 无上限 × 大库 × 模糊兜底路。
  现在真正按 400 分批，且 `recall` 的 limit 钳制 ≤1000 双保险（src/storage.ts、src/engine.ts）。
- **add() 去重/冲突检测挪进写锁**：此前在事务外读、事务内写——MCP 是"每个客户端一个进程"，
  两进程并发 add 相同内容会"都读到没有重复 → 双写"。现在整体在一个 BEGIN IMMEDIATE 里，竞态消失（src/engine.ts）。
- **link() 幂等**：同一对实体同一谓词的现行关系重复建立不再产生重复边（方向敏感：
  张三→李四 ≠ 李四→张三）；新增 `Storage.findRelation`（src/engine.ts、src/storage.ts）。
- **web/app.js**：location.hash 直接拼进 querySelector 会被当 CSS 语法抛异常，套 `CSS.escape()`。
- **启动控制台.bat**：服务启动后把带 token 的控制台地址写到 `<db>.url`，
  脚本等文件出现后直接用完整地址开浏览器——新用户双击即可进控制台，不用手工复制 ?token=
  （`*.db.url` 已加入 .gitignore；文件与数据库同目录，同一信任边界）。
- **命令行.bat**：输入含未配对引号时 `if "%cmd%"` 比较会语法报错，改用延迟展开 `!cmd!` 比较。
- **文档口径校准**：DESIGN.md 第 4 节 / llms.txt / config.ts 注释把相似度从
  `|A∩B|/min`（包含系数）更正为现行实现 `|A∩B|/max`（归一化重叠 tokenOverlap），
  并写明弃用理由；文档数字 245 → 249 全部同步（npm run check 通过）。

**验证**：`npm test` = **19 文件 249/249 全绿**（新增回归测试 4 项：getMany 大批量、
recall 超大 limit 钳制、link 幂等、mem0 双斜杠/health 免鉴权/Bearer 大小写扩展断言）；
`npm run build` 0 错误；`npm run check` 通过；`npm run eval:extract` 27/27。

### 应用窗口启动器 + 吉祥物机制（2026-11-21 凌晨）

- **`启动控制台.bat` 升级为"应用窗口版"**：服务已在跑 → 直接开窗（curl 探活 `/api/health`，
  免鉴权修复正好用上）；没在跑 → 后台最小化窗口启动服务 → 等 `<db>.url` 写出 →
  用 **Edge `--app` 模式**打开（无地址栏、独立窗口，像桌面软件；Edge 不在时回退默认浏览器）。
  停止服务 = 关闭任务栏"Membrane 服务"最小化窗口。`timeout` 改 `ping` 延时（重定向 stdin 兼容），
  全文 CRLF（LF-only 会炸 cmd 解析器，实测踩坑后修复）。
- **吉祥物机制**：右下角半透明立绘，`pointer-events:none` 不挡点击，z-index 低于弹窗/提示条。
  本地自定义优先：`web/assets/mascot-local.png`（**.gitignore 忽略 + package.json files 白名单
  收窄为 web 的四个具体文件**——双保险确保用户自备图不进 git/npm 包，无版权风险）；
  缺失时回退随仓库发布的**原创吉祥物** `web/assets/mascot.svg`（记忆小水母，MIT）。
- 桌面快捷方式（`E:\Desktop\Membrane 记忆脑.lnk`，membrane.ico 图标）由脚本生成，指向仓库内启动器。

**验证**：启动器端到端实测——冷启动/服务复用两分支均通过，`/api/health` 免鉴权探活、
`/assets/mascot-local.png` 正常伺服；`npm pack --dry-run` 确认包内只有原创 mascot.svg；
`npm test` 仍为 249/249 全绿（本节无代码逻辑改动，仅 web 静态资源与启动脚本）。

---

## v0.2.6 — 2026-11-20

### 安全修复（内部代码审查）+ 一批低危改进

> 对全部 20 个源文件做内部安全审查，按严重度修复。

**🔴 M-1（高危）数据接口默认无鉴权 + CORS 全开 → 已修复**
- 问题：默认绑定 127.0.0.1 且**不要求令牌**，同时每个响应都带 `Access-Control-Allow-Origin: *`
  ——用户浏览器里打开的任意网页都能跨源读取/写入/遗忘全部记忆（drive-by 攻击面）。
- 修复：
  1. 数据接口（/api/* 与 /v1/*）**一律要求令牌**，没有"本机绑定免鉴权"的豁免；
  2. 未配置令牌时**自动生成** 24 字节随机令牌并存 settings（重启复用），控制台打印带 token 的完整 URL；
  3. **CORS 默认零放行**（同源 Dashboard 不需要 CORS 头），需要跨源用 MEMBRANE_CORS_ORIGIN 显式指定，绝不反射任意来源；
  4. /api/health 免鉴权仅用于探活，但不再暴露数据库路径（移到受令牌保护的 diagnostics）。
- 新增测试 3 个（自动令牌 401/200 与静态页免鉴权、CORS 默认零放行/显式放行、health 不含 db 路径）。

**🟠 M-3（中）绑定 IPv6/特殊地址时全部请求 500 → 已修复**
- `new URL(req.url, \`http://${host}\`)` 在 host="::" 时 base 非法 → 每请求抛异常。
- base 改为固定 `http://localhost`（与实际绑定地址无关，仅作解析基准）。

**🟠 M-4（中）切换 embedding 模型被旧维度卡死 → 已修复**
- 已被取代记忆的向量留在 embeddings 表，`embeddingDims` 把旧维度算进去，
  新模型写入全部被"维度不一致"拒绝，且没有清理出口。
- 新增 `embed-purge` CLI 子命令（--yes 二次确认）+ `Storage.purgeEmbeddings()`；新增测试 2 个。

**🟠 M-5（中）端口占用直接崩栈 → 已修复**
- `server.listen` 增加 `'error'` 事件处理：EADDRINUSE 给中文提示（含换端口方法）。

**🟡 低危批量**
- M-6：`npm test` 嵌套调 npm，PATH 受限环境必挂 → 改为 `tsc && vitest run` 不嵌套。
- M-7：MCP stdio 响应可能乱序 → 串行化 Promise 链，按请求顺序写回。
- M-11：recall 每次 `evidenceCountAll()` 全表 GROUP BY → 改为按候选 ids 分批查询。
- M-12：SQLite 变量上限注释过时（999→32766）+ fuzzyCandidates 检索单元超 500 截断。
- M-13：graph-extract 动词交替顺序导致"去了趟北京"抽出"了趟北京"→ 长分支放最前。
- M-13b：tokenSet 注释仍写"包含系数/min"，与实现（max 重叠度）矛盾 → 同步。

**更正**：内部自查初版的 M-2（短碎片取代长事实）为误报——`tokenOverlap` 分母已是 max 并有回归测试覆盖，撤销该项。

**记录在案（本轮不改，v0.3 候选）**：M-8（URL token 文档化）、M-9（"未来生效记忆"语义固化）、M-10（不可信来源抽取的投毒面声明）、M-16（engines >=24 取舍）。

**验证**：`npm test` = **17 文件 245/245 全绿**（新增 purge 2 项 + server 安全回归 3 项）；`tsc` 0 错误。
**影响文件**：src/server.ts、src/storage.ts、src/engine.ts、src/mcp.ts、src/cli.ts、src/graph-extract.ts、src/tokenize.ts、src/version.ts、package.json、test/server.test.ts、test/purge.test.ts（新增）、DESIGN.md

---

## v0.2.5 — 2026-11-19

### 10 万级向量检索压测 + 零依赖 LSH 桶索引

> 这版只做性能与规模，不改默认召回口径。**没有引入 sqlite-vec / faiss / HNSW 等原生依赖**，仍是单文件 SQLite + `ulid`。

**问题**：v0.2.4 的向量路是逐条 `rowToRecord` + 精确全扫。10 万条 × 1536 维实测 **约 10.9 秒/次**，所谓"支持 10 万"只是不崩，不可用。

**改了什么**：

1. **新增 `vector_lsh` 桶索引（零依赖）**
   - 8 张哈希表 × 8 bit = 每张 256 桶；每个 bit 用 32 个稀疏随机投影，投影下标由 `(table, bit)` 确定性生成，不占存储。
   - `upsertEmbedding` 同步维护 8 个桶；`deleteEmbedding` 同步删除；老库首次向量查询自动补建（一次性）。
   - 查询默认只探**精确桶**（10 万条约 3 千候选），候选 `<64` 才扩到汉明距离 1 的邻桶；桶分布极端、候选撞到 50k 上限时回退精确全扫，绝不拿截断候选糊弄。
2. **向量扫描瘦身**
   - 新增 `scanEmbeddingVectors`：只读 `id / vec / norm`，不再把 10 万条完整记忆行（含 tags JSON）反序列化。
   - `embeddings.norm` 预计算 L2 范数，查询只算点积；老库 `norm=0` 自动回退现算。
   - Blob 读取改为零拷贝 Float32Array 视图；top-K 只存 `id + 分数`，最后 `getMany` 补 32 条完整记录。
3. **精确对账开关**
   - `RecallOptions.exactVectorSearch`（REST 对应 `exactVector: true`）：强制 O(N) 精确全扫，用于评测/对账，不参与默认路径。
4. **新增可复现压测**
   - `scripts/bench-scale.mjs` + `npm run bench:scale`：固定种子的 50 簇 × 1536 维合成数据，支持 `--count/--dim/--queries/--reuse/--exact/--keep-db`。
   - `bench/README.md` 记录环境、口径、结果、复现命令、已知边界。

**实测（Windows / Node 24.22 / 100,000 条 × 1536 维 / 50 簇 + 12% 噪声）**：

| 路径 | 优化前 | 优化后 |
|---|---:|---:|
| Vector-only | ~10,912 ms（精确全扫） | **~298 ms**（LSH） |
| Hybrid（FTS + 向量 + 图） | ~10,942 ms | **~463 ms** |
| FTS-only（宽查询命中全库） | ~126 ms | ~126 ms |
| 写入 100k | — | 48.5s（约 2,061 条/s） |
| 库大小 | — | 955 MiB |
| 进程 RSS | — | ~88 MiB |

- 加速比：**约 36.7 倍**。
- 召回：簇数据 + 15% 噪声查询，LSH top-10 与精确全扫 **10/10 重合**，top-1 一致。
- 10k × 1536：vector-only **37 ms**、hybrid **54 ms**。

**已知边界**：

- LSH 是近似索引；真实 embedding 分布、极端桶倾斜、百万级未验证。需要完全一致时用 `exactVectorSearch`（约 11s/次）。
- 100k × 1536 的 955MiB 磁盘占用是 float32 的硬成本；量化/PQ 未实现。
- FTS5 宽查询命中全库仍约 129ms，这是 SQLite FTS5 的固有限制。

**验证**：`npm run build` 通过；`npm test` **222/222 通过，16 个测试文件**；`npm run check` 通过；真实 10 万库 LSH/精确 A/B、top-10 召回对比均已跑。

**影响文件**：`src/storage.ts`、`src/engine.ts`、`src/types.ts`、`src/server.ts`、`src/version.ts`、`package.json`、`package-lock.json`、`test/vector.test.ts`、`scripts/bench-scale.mjs`（新增）、`bench/README.md`（新增）、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、`why-membrane.md`、`为什么用Membrane.md`、`使用场景.md`

---

## v0.2.4 — 2026-11-19

### 外部 review 七条修复

> 这些修复改变了若干对外行为，因此单独发一个版本，而不是塞进已发布的 v0.2.3。

**⚠️ 有三处破坏性变更**：

| 变更 | 影响 |
|---|---|
| 公开 API `containment` → `tokenOverlap` | 直接 import 该函数的代码需要改名 |
| 冲突判定公式 `\|A∩B\|/min` → `\|A∩B\|/max` | 短记忆不再以 1.0 相似度取代完整事实；取代行为会变 |
| REST `/api/recall` 的 `detail` 默认 `full` → `brief` | 不传 detail 的调用方拿到的字段变少（省 token） |


外部 review 对 `main` 做了全量静态审查，7 条经逐条复现全部属实。本节记录修复内容；逐文件明细见 `_internal/小本子-改动记录.md`。

1. **配 token 后 Web 控制台打不开（P0）**
   - 静态页面与 `/api/*`、`/v1/*` 分离鉴权：控制台首屏不再被 Bearer 拦成 401。
   - 支持 `Authorization: Bearer` 与 `?token=` 两种来源；浏览器首次用 `?token=` 打开后存入 `localStorage`，并从地址栏抹掉。
   - 补 `OPTIONS` 204 预检与 `Access-Control-Allow-Headers/Methods`；前端 `api()` 自动带 Bearer。
2. **中文标点把分词口径劈成两半（P0）**
   - 分词前统一剥离中英文标点（`CJK_PUNCT`），`。`、`，`、`《》` 不再进入 bigram，也不再切断跨标点的连续片段。
   - `fuzzyUnits` 不再把 `。` 当检索单元；`RUN_SPLIT`/`CJK_CHAR` 移除标点区段。
3. **短记忆误杀长记忆（P0）**
   - 冲突相似度从 `|A∩B| / min(|A|,|B|)` 改为 `|A∩B| / max(|A|,|B|)` 的归一化重叠 `tokenOverlap`。
   - "北京市" 对 "用户住在北京市海淀区" 从 1.0 降到约 0.22，不再自动取代完整事实；同长度换地名仍保持 0.6，可正常取代。
4. **CLI 布尔 flag 吞位置参数（P1）**
   - 新增 `BOOLEAN_FLAGS` 白名单（`pin`/`no-embed`/`no-graph`/`no-embeddings`），布尔 flag 不消费下一个参数。
   - 位置参数改为"下标消费集合"，`add "fact" --kind fact` 中同名正文不再被一起剔除。
5. **版本漂移（P1）**
   - 新增 `src/version.ts` 作为唯一事实源；`server.ts`、`mcp.ts`、`mcp-config.ts`、`doctor.ts` 全部改为 `import VERSION`。
   - `package-lock.json` 顶层与包版本同步（本次发布时统一升到 0.2.4）。
   - `scripts/check-consistency.mjs` 新增：`src/version.ts` vs `package.json`、lock 版本、源码硬编码版本扫描，以及"用例/cases"测试数正则。
6. **REST 默认返回 full，与省 token 卖点打架（P2）**
   - `/api/recall` 的 `detail` 默认从 `full` 改为 `brief`，与 MCP/README 口径一致。
   - `noGraph` 改用 `asBoolean`，字符串 `"true"` 也能生效。
7. **导入把备份当可信数据（P2）**
   - 新增 `normalizeImportRecord`：校验 `kind` 白名单、`confidence` 0~1、`createdAt/updatedAt/validFrom/validTo` 有限、`namespace` 合法、`tags` 只保留字符串。
   - embedding 向量要求每个元素都是有限 number；出现 `NaN`/`Infinity`/字符串时整条跳过并计入 `skippedEmbeddings`，不再 `filter` 成低维后入库。

**验证**：`npm run build` 通过；`npm test` **221/221 通过，16 个测试文件**；`node --check web/app.js` 通过；`npm run check` 全部文档与源码一致；真实 CLI 实测 `add --pin` 与 `add "fact" --kind fact` 均正确写入。

**影响文件**：`src/tokenize.ts`、`src/engine.ts`、`src/cli.ts`、`src/server.ts`、`src/mcp.ts`、`src/mcp-config.ts`、`src/doctor.ts`、`src/index.ts`、`src/version.ts`（新增）、`web/app.js`、`package-lock.json`、`scripts/check-consistency.mjs`、`test/tokenize.test.ts`（新增）、`test/engine.test.ts`、`test/server.test.ts`、`test/portability.test.ts`、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、`why-membrane.md`、`为什么用Membrane.md`

---

## v0.2.3 — 2026-11-19

中英双语控制台版：Web 控制台从“只有中文”改为**中文 / English 可切换**，静态页面与动态数据都跟着切；语言选择本地记住，刷新后保持。
**破坏性变更：无**；默认仍按浏览器语言选择，后端 API 与 CLI 不变。

### 1. 双语静态页面（`web/index.html`）

- 导航、标题、表单标签、表头、按钮、弹窗、Ops 页面全部改用 `data-i18n` 键，中文作为默认文本保留。
- 新增顶部语言切换 `#lang-switch`：`中文` / `EN`。
- 支持三类本地化属性：
  - `data-i18n`：文本内容；
  - `data-i18n-ph`：输入框 placeholder；
  - `data-i18n-title`：title 提示。
- `<option>` 也带 `data-i18n`，下拉选项会随语言切换。

### 2. 双语逻辑（`web/app.js`）

- 新增完整 `I18N.zh` / `I18N.en` 字典与 `t(key, vars)`，支持 `{name}` 插值；缺 key 先回退中文，再回退 key。
- 语言检测：`localStorage.membrane.lang` 优先；无值时按 `navigator.language`（`zh` 开头 → 中文，否则英文）。
- 新增 `applyStaticLanguage()`：同步 `document.lang`、页面标题、三类 `data-i18n` 属性与语言按钮 active。
- 新增 `refreshLocalizedViews()`：切语言后刷新概览 / 台账 / Ops / 召回结果 / 隔离结果 / 详情弹窗，并更新页面标题。
- 新增 `setLanguage(next, refresh)`：写入 `localStorage` 后立即应用语言与 Token 模式。
- `MODES` 改为 key 结构，`applyMode()` 不再引用旧 `.label` / `.hint`；避免出现 `undefined模式`。
- 召回结果、台账、审计链、详情、编辑、遗忘、导出 toast、Ops 诊断、请求日志、隔离检测结果全部改用 `t()`。
- 语言切换不再覆盖真实数据库路径：`#db-path` 由 `loadStats()` 填；只有仍显示“本地数据库 / Local database”兜底文案时，才跟随语言切换。
- 顶栏 `#health-chip` 也纳入语言切换，避免英文界面残留“● 运行正常”。

### 3. 样式（`web/app.css`）

- 新增 `.lang-switch` 样式，和 `.mode-switch` 保持同一视觉语言；窄屏下两个切换器一起缩。
- 语言按钮 active 使用蓝色高亮，和 Token 模式的绿色高亮区分。

### 4. 澄清"零依赖"的真实含义 + 增加不依赖浏览器的用法

有人指出"这记忆引擎还要依赖浏览器，就这还敢说零依赖"。这个批评成立：原来的说法只讲了安装时的依赖数，没讲清哪些用法需要浏览器。

**改了什么**：

- 中英 README 都加了明确说明：零依赖 = 安装时不下载第三方 npm 包（除 `ulid`）、无需编译原生模块；**不等于所有用法都不需要浏览器**。
- 澄清三种用法：CLI / MCP / SDK **纯命令行与纯代码，完全不碰浏览器**；只有可选的 `serve`（Web 控制台）需要浏览器打开界面，不用它功能一个不少。
- 新增 `命令行.bat`：交互式命令行入口，打开就是提示符，可直接输入 `add` / `search` / `stats` / `relations` 等命令，全程不启动浏览器。
- 重写 `启动控制台.bat`：原来写死 `E:\开源盛世\...` 路径，换机器就废；改用 `%~dp0` 自定位，并按 环境变量 → 同级 tools → Program Files 的顺序查找 node。
- 新增 `assets/membrane.ico`：七种尺寸（16–256）的应用图标，双脑半球 + 中缝 + 脑回 + 记忆节点网，配套 `icon-preview.png`。
- 两个 `.bat` 均按 Windows 编码规则存为 GBK + CRLF。

**验证**：纯命令行实测通过——`add` 写入、`search` 召回（输出含"关系第 1 名（用户 --住在--> 上海）"，说明图检索在工作）、`stats` 显示"实体 2 个 | 关系 1 条"。全程未打开浏览器。

**影响文件**：`README.md`、`README.en.md`、`启动控制台.bat`、`命令行.bat`（新增）、`assets/membrane.ico`（新增）、`assets/icon-preview.png`（新增）

---
### 5. 验证

- `node --check web/app.js` 通过。
- `npm run build` 通过。
- `npm test`：**212/212 通过，15 个测试文件**。
- `npm run check`：全部文档与源码一致。
- 真实浏览器验证：中文 / EN 切换、刷新保持、概览 / 写入 / Ops / 隔离结果动态切换。
- 真实浏览器验证 MCP 面板：模拟 `Claude Desktop` 通过 stdio 连接后，Ops 显示客户端名、版本、协议、PID、调用次数、最后工具与最后活动；中英文状态文案均正确。
- **待补**：召回结果 / 详情弹窗 / 编辑弹窗的完整双语浏览器走查。

### 6. 文档

- `_internal/竞品对比与弱项.md` 重排大纲，新增合规 / 加密 / 保留策略、多模态、规模 / ANN 三个专题。
- 新增 `_internal/交接-当前工作记录.md`，记录本轮全部工作与接手清单。
- 两份内部文档均在 `.gitignore` 的 `_internal/` 下，**不提交 GitHub**。

### 7. MCP 接入可视化（Ops）

**问题**：控制台看不到“谁通过 MCP 接入了这个记忆库”。MCP 是手写 stdio server，一个客户端一个进程；`initialize` 里的 `clientInfo` 被直接忽略，`startMcpServer()` 只在 stderr 打一行启动日志，REST 与 MCP 是两个独立进程，Ops 自然看不到另一个进程。

**修法**（纯加法，不改 MCP 协议行为）：

- `src/storage.ts`：新增辅助表 `mcp_clients`（会话 id、客户端名/版本、协议、传输、PID、cwd、首次/最后活动、调用次数、最后工具、状态）；新增 `recordMcpClient()` / `touchMcpClient()` / `closeMcpClient()` / `listMcpClients()`。`SCHEMA_VERSION` 保持 2：这是可忽略的辅助表，老库自动建表，不升级、不迁移。
- `src/mcp.ts`：`startMcpServer()` 为每个进程生成 `randomUUID()` 会话 id；`initialize` 读取 `params.clientInfo.name/version` 并登记；每次 `tools/call` 更新最后活动/调用次数/最后工具；SIGINT/SIGTERM/stdin 关闭/exit 标记 `closed`。
- `src/server.ts`：新增 `GET /api/admin/mcp-clients`，返回 `clients / total / active / generatedAt / staleAfterMs`；`PID` 探活（`process.kill(pid, 0)`，不发送信号）：进程已退出 → `closed`；5 分钟无活动 → `stale`（可能只是空闲，也可能是父进程强杀后没来得及写 `closed`）。
- `web/index.html` + `web/app.js`：Ops 新增“MCP 接入”面板，显示状态、AI Agent、版本、协议、PID、调用次数、最后工具、最后活动；只读元数据，**不显示记忆正文或查询**。
- 隐私边界：只记录握手/调用元数据，不记录 prompt、查询词、记忆正文；`cwd` 用于区分同名客户端的不同项目。
- 测试：`test/mcp.test.ts` 覆盖 `initialize` 登记与 `tools/call` 计数、关闭；`test/server.test.ts` 覆盖 `/api/admin/mcp-clients` 且断言不泄露正文。

**影响文件**：`src/storage.ts`、`src/mcp.ts`、`src/server.ts`、`web/index.html`、`web/app.js`、`test/mcp.test.ts`、`test/server.test.ts`、`README.md`、`README.en.md`、`DESIGN.md`、`.gitignore`、`CHANGELOG.md`。

### 8. 自查修复（本轮代码审查发现）

- **高危 · 登记写库失败会杀死整个 MCP server**：`recordMcpClient` / `touchMcpClient` 原先没有 try/catch 保护，`startMcpServer()` 的 promise 链也没有 `.catch()`。磁盘满或 SQLite 锁超时（> busy_timeout 5 秒）时，unhandled rejection 在 Node 24 默认**直接崩溃进程**——客户端 initialize 挂死。修复：两处登记改为 best-effort（失败只写 stderr，不影响协议响应），`startMcpServer()` 补 `.catch()` 兜底。
- **中危 · `listMcpClients(NaN)` 会抛 SQL 错**：`Math.max(1, Math.min(200, NaN))` 结果是 NaN，绑定到 `LIMIT ?` 直接报错。修复：`Number.isFinite` 兜底为默认值 50。
- 审查确认无问题的点：`t()` 遮蔽（`openDetail` 等处已修，无残留）、`esc()` 对数字安全、badge 样式类齐全、admin 路由在配 token 时同样受 Bearer 保护、MCP 工具级错误用 `isError: true`（符合规范，协议级错误才用 `error` 字段）、未知方法返回 `-32601`。

**影响文件**：`src/mcp.ts`、`src/storage.ts`、`CHANGELOG.md`。


---

## v0.2.2 — 2026-11-18

运维可观测版：给懂行的人一个能看日志/诊断的后台，并把“一个 Agent 多任务会不会串记忆”做成可复现实验。
**破坏性变更：无**；新增只读接口与可选日志文件，默认不影响旧用法。

### 1. 结构化运行日志（`src/logger.ts`）

- 新增 `MemoryLogger`：JSONL 追加文件 + 内存 ring（默认 500 条，可配 `maxEntries`），级别 `info/warn/error`。
- 默认日志路径为数据库文件旁 `<db>.log`；可用 `MEMBRANE_LOG_FILE` 或 `ServerOptions.logFile` 覆盖；`:memory:` 库默认只留内存。
- **脱敏底线**：`content/query/body/evidence/quote/memory/prompt/authorization/apiKey/token` 等字段直接拒写；嵌套对象不展开；字符串截断 500 字符。
- 写盘失败不阻断服务：错误记录在 `stats().fileError`，后台可见。

### 2. 运维后台（Ops / Admin）

新增三个只读接口：

| 接口 | 返回 |
|---|---|
| `GET /api/admin/logs?limit=&level=` | 最近 ring 日志 + 日志统计（路径/已写/丢弃/文件错误） |
| `GET /api/admin/diagnostics` | 版本、uptime、pid、Node/平台、RSS、DB 路径/schemaVersion/字节数、统计、LLM/embedding 是否配置（**不暴露 apiKey**）、监听地址/是否启用 token、日志统计 |
| `GET /api/admin/isolation-check` | 现场跑 `probeTaskIsolation()`，返回同 namespace 混召回 + 跨 namespace 零泄漏 |

- 真实 HTTP 请求日志：只记 `/api/*` 的 method/path/status/耗时，**不记 query/body**；401 记 `http.auth_failed`，异常记 `http.error`。
- `startServer` 启动时打印 Dashboard 与 `/#ops` 地址；监听 `0` 端口时回填真实端口到诊断上下文。
- 控制台新增 **Ops / Admin** 页：诊断卡、请求日志表（级别过滤、条数、5 秒自动刷新）、隔离自检按钮；日志级别色与空状态样式。

### 3. 多任务隔离：结论与实验

数据模型仍只有 `namespace`，没有 `task_id`/`session` 字段。新增 `src/isolation.ts` 的 `probeTaskIsolation()`（`:memory:` 临时库、固定时钟、不碰用户数据）：

- **同 namespace**：任务 A“数据库用 PostgreSQL”和任务 B“数据库用 MySQL”都会被“数据库”召回 → `mixed=true`。不是数据库串行，是语义候选混在一起。
- **不同 namespace**：A 只命中 A，B 只命中 B，`leakage=0`，`pass=true`。
- 使用约定：每个任务 `task-<id>`；共享知识单独 `shared`，查询时分别查任务 namespace + `shared` 再合并。当前不做自动 task 隔离（需要 schema v3 全链路改造）。
- doctor 新增剧本 6（多任务隔离），验收检查从 7 项增至 **9 项**；README/README.en 写明“同 namespace 会串”的使用边界。

### 4. 测试与验证

- 新增 `test/logger.test.ts`（4：ring 上限、脱敏、JSONL 落盘/截断、级别过滤）。
- 新增 `test/isolation.test.ts`（2：探针、真实引擎跨 namespace）。
- `test/server.test.ts` 新增 3 条（诊断不泄露 apiKey、日志不返回正文、隔离接口），共 21 条。
- 合计 **210/210 全绿，15 个测试文件**；doctor 九项全过（100% / 88% / 0% / ✓ / 1.00 / 图关系✓ / 隔离 0 泄漏 + 同 namespace 混召回复现）。
- 真实浏览器验收 Ops：诊断正常、请求日志 6 条、隔离按钮输出“同 namespace 混合 / 分 namespace 串扰 0”。

### 5. 涉及文件

`src/logger.ts`（新）、`src/isolation.ts`（新）、`src/storage.ts`（schemaVersion getter）、`src/server.ts`（日志/三端点/请求日志/真实端口）、`src/doctor.ts`（剧本 6）、`src/mcp.ts` / `src/mcp-config.ts` / `src/server.ts` / `web/index.html`（版本 0.2.2）、`web/app.js` / `web/app.css`（Ops 页）、`web/index.html`（Ops 导航）、`test/logger.test.ts`（新）、`test/isolation.test.ts`（新）、`test/server.test.ts`、`README.md` / `README.en.md` / `DESIGN.md` / `llms.txt` / `CHANGELOG.md`。

---

## v0.2.1 — 2026-11-19

质量版：不加花活，先把"会咬人的地方"处理掉，再补一个本地优先刚需的备份能力。
**破坏性变更：无**（删掉的符号都没从 `index.ts` 导出，SDK 用户无感）。

### 1. 死代码清理（逐个 Grep 确认零引用后删除）

| 位置 | 符号 | 为什么是死代码 |
|---|---|---|
| `src/engine.ts` | `renormalizeWithoutVec` | v0.1 遗留，已被 `normalizeWeights(w,{vec,graph})` 取代，且从未进 SDK 出口 |
| `src/tokenize.ts` | `CJK_RUN` | 定义了正则但从未被读取 |
| `src/tokenize.ts` | `charCoverage` | 只有测试调用的便捷包装；统一走 `fuzzyUnits + charScore`，少一个重复口径 |
| `src/storage.ts` | `relationsForMemoryIds` | v0.1 图查询草案；v0.2 实际走 `relationsTouching` + `collectEdges` |
| `src/storage.ts` | `memoryIdsForRelations` | 同上，零调用 |
| `src/engine.ts` | `ScoreBreakdown` 导入 | 只在类型文件里用，engine 从未引用 |

`searchFts` 末尾的 `return []` 保留：TypeScript 控制流需要它，且已注释"理论不可达"。

### 2. 三套入参解析合并为 `src/input.ts`

**问题**：CLI / MCP / REST 各写一份 `parseKind` / `parseEntityType` / `parseRelations` / `num`，
口径已经开始漂移——REST 的 GET query 全是字符串，代码却按 `typeof === "number"` 判断，
于是 `GET /api/memories?limit=5` **永远不生效**（`/v1/memories` 复用同一路径，一起失效）。

**修法**：新增 `src/input.ts`，提供 `asString / asFiniteNumber / asBoolean / asStringArray /
asNumberArray / asKind / asKinds / asEntityType / asEntityInputs / asRelationInputs`，
三个接入面共用一套"宽进严出"的解析：这里只负责收形状，合法性仍由 `model.ts` 校验。

### 3. 修掉的 bug

| bug | 后果 | 修法 |
|---|---|---|
| `GET /api/memories` 的 `limit` 用 `typeof === "number"` | query 参数是字符串 → `?limit=` 永远失效 | 改 `asFiniteNumber`，兼容 `"5"` |
| `scoreHit` 的 `halfLives[m.kind]` 无兜底 | 库里有非法 kind（手改库/旧数据）→ `freshness` 返回 NaN → 总分 NaN，排序失去意义 | `?? DEFAULT_HALF_LIVES.fact` |
| `forget()` 不清 `memory_entities` | 长期使用后"这条记忆提到谁"的孤儿行越积越多，`entitiesFor(已删id)` 还能查到 | 遗忘事务里同步 `deleteMemoryEntities` |
| `stats()` 对未知 kind 直接写键 | 脏数据会往固定形状的 `byKind` 对象上乱加属性 | `hasOwnProperty` 守卫，只统计四种合法 kind |
| `POST /api/memories` 的 `entities` 只收字符串 | MCP/SDK 都支持 `{name,type}` 对象，REST 静默丢掉类型 | 改 `asEntityInputs`（两种写法都收） |
| `listEntities(ns, 0 \| 负数)` 未归一 | SQL `LIMIT` 行为依赖底层，可能返回空/异常 | 夹到 `[1, 5000]` |
| 真实 HTTP 只对 `POST` 读 body | `PATCH /api/memories/:id` 在控制台/curl 里收到的是空对象，编辑永远返回 `duplicate`、只改了个寂寞 | `hasBody` 扩到 `POST/PATCH/PUT`；补一条真正起端口、走 `fetch` 的防回归测试 |

### 4. 新增：全量 JSON 备份（`exportAll` / `importAll`）

本地优先的底线是"数据永远拿得回来"，而 SQLite 文件不能跨版本/跨机器随便搬。

- `membrane-memory export [--out 文件] [--no-embeddings]`
- `membrane-memory import 备份.json`
- SDK：`m.exportAll(opts)` / `m.importAll(bundle)`

导的是**库的全部真相**：含被取代、已遗忘的底稿、证据、实体关系与向量——只导现行记忆会让
恢复后的 `asOf` 历史查询失灵。导入**幂等且不覆盖**：已存在的记忆/关系按 id 跳过；
实体按 `(namespace, name)` 复用，关系边自动改指向目标库已有实体，不会插出断边；
向量维度与目标库不符时跳过并计数（`skippedEmbeddings`），绝不把库搞成"永远余弦 0"。
坏文件（字段不是数组 / 缺 id）直接 `E_IMPORT_FORMAT`，拒绝半截导入。

### 5. 新增：`mcp-config` 接入配置生成器（21 个客户端）

适配文档原来全是 `<你的node路径>` 占位符，新手要改三处路径、还容易写错 JSON 逗号。
新增 `src/mcp-config.ts` + CLI 命令：

```bash
membrane-memory mcp-config                  # 列出 21 个客户端
membrane-memory mcp-config cursor           # 输出可直接粘贴的 JSON
membrane-memory mcp-config codex --out config.toml
```

- 路径自动填：node = 当前进程，cli.js = 本包 `dist/cli.js`，db = `MEMBRANE_DB` 或当前目录
- 格式各自适配：JSON / VS Code `servers`+`type` / Codex TOML / Continue YAML / Zed `context_servers` / Claude Code 命令行
- `--out` 目标已存在时**拒绝覆盖**（不冲掉用户已有的其他 MCP server）
- 覆盖：Claude Desktop/Code、Cursor、Cline、Roo、Windsurf、VS Code、Gemini CLI、Codex、Antigravity、
  Continue、Zed、WorkBuddy、zcode、AstrBot、Cherry Studio、LobeChat、NextChat、n8n、Dify、通用

同时新增 `使用场景.md`：10 个真实场景（编程助手规矩、个人偏好、QQ 群隔离、多项目 namespace、
决策复盘、离线隐私、换机备份、多 Agent 并发真相、省 token、记忆卫生）+ 一张"什么场景不适合"的诚实清单。

### 6. 内部结构（不改行为的部分）

- **时间过滤单点化**：`memoryTemporalSql` / `relationTemporalSql` 取代 FTS、模糊、向量、关系四处各抄一份；
  顺手修正历史时点语义——`asOf` 只看有效区间，不再把 `deleted` 标志带进来（软删除会把 `valid_to` 设为删除时刻，
  `asOf` 早于它时这条记忆"当时确实存在"，storage 既有测试正是这么要求的）。
- **engine.add 拆分**：`buildRecord`（入参→记录）+ `embeddingPlan`（维度守卫），主流程少 40 行；
  `writeGraph` 去掉对 `normalizeEntityType(r.fromType)` 的重复调用。
- `stats()` 增加 `entities` / `relations` 两个字段；`list()` 支持 `kinds` 多选；
  CLI `stats` 不再用 `listEntities().length` 近似实体数。
- CLI：新增 `export` / `import`；`add --entities`；`search` / `list` 支持 `--kind` / `--kinds`。
- REST：`/api/recall` 支持 `kinds` 与 `detail`（ultra/brief/full，与 MCP 对齐）。
- **package-lock 重新生成**：旧锁文件根节点还写着 `version: 0.1.0`，并且依赖里挂着早已移除的
  `@modelcontextprotocol/sdk`——`npm ci` 会把它装回来，直接打脸"零运行时依赖"。现在锁文件与 `package.json` 一致。

### 7. 测试

新增 `test/update.test.ts`（6 个）：改正文后新版本生效/旧版本 superseded、历史 `asOf` 仍见旧值、
证据默认沿用、只改标签/pin 时保留旧向量、内容不变返回 `duplicate`、已遗忘/已取代拒绝编辑、
改关系标注时旧关系关闭但历史仍可查。

新增 `test/portability.test.ts`（6 个）：全量导出恢复、历史时点仍可查、导入幂等、
实体同名复用、向量维度冲突跳过、坏文件拒绝导入。
新增 `test/mcp-config.test.ts`（7 个）：清单完整性、JSON 转义、VS Code 特例、TOML 正斜杠、
Claude Code 命令、Zed 结构、未知客户端报错。
`test/server.test.ts` 扩到 18 个：PATCH 编辑、DELETE 遗忘、`GET /api/export`、health 带版本，
以及一条**真正监听端口**的 HTTP PATCH 测试（专抓"只读 POST body"这类 route() 单测抓不到的坑）。

合计 **201/201 全绿**（13 个测试文件）；doctor 五项剧本七项检查数字保持不变（100% / 88% / 0% / ✓ / 1.00 / 图关系✓）。

### 8. 新增：记忆编辑（版本化更新，不是原地改行）

控制台里点"编辑"如果直接 `UPDATE` 数据库，会同时毁掉三样东西：旧正文、旧证据、旧关系，
`asOf` 也再查不到"编辑前它长什么样"。所以做成了**新版本取代旧版本**：

- SDK：`m.update(id, patch)` / `m.updateAsync(id, patch, {embed})`，`UpdateInput` 所有字段可选，没给就沿用旧值。
- 语义：事务内插入新记录 → 写证据/图 → `markSuperseded(旧, 新)` → 关闭旧记忆派生的关系 →
  新旧两边各写一条审计（`add` 带 `editOf`、`supersede` 带 `reason:"user-edit"`）。
- 内容没变且没给新证据/图/向量 → 返回 `duplicate`，不制造无意义版本。
- 正文没变、只改元数据（tags/pin/confidence）→ **沿用旧向量**，避免"改个标签把语义检索废掉"。
- 正文变了 → 必须重算或由调用方传 `vec`；`updateAsync` 配了 embedding 模型就自动重算，失败按纯文本更新并在 note 标注。
- 已遗忘抛 `E_UPDATE_DELETED`，已被取代抛 `E_UPDATE_STALE`（提示去编辑现行版本），绝不悄悄改历史。
- REST：`PATCH|PUT /api/memories/:id`、`DELETE /api/memories/:id`。

### 9. 新增：Web 控制台 v2（可看、可改、可删、可选省 Token）

`web/index.html` / `app.js` / `app.css` 全部重写，仍然是零依赖原生 JS：

- **三种 Token 模式**（顶栏切换，`localStorage` 持久化）：
  `省 Token` = `detail:"ultra"` + limit 3；`平衡` = `brief` + 8；`完整` = `full` + 8。
  召回卡片会随模式变化：ultra 只显示 id/内容/分数，full 才渲染 why 与五路分数明细。
- **记忆详情**：正文、kind/subject/namespace/confidence/valid_from/valid_to/pin/superseded_by、
  标签、实体、关系句子、证据原文、完整审计链。
- **编辑**：弹窗改正文/类型/主语/置信度/标签/pin；保存走 PATCH，成功后自动打开新版本详情。
- **遗忘**：DELETE 软删除，二次确认；墓碑仍在 `include superseded & tombstones` 下可见。
- **台账筛选**：namespace、kind、是否包含被取代/墓碑；操作列固定在右侧，窄屏隐藏次要列，不再把按钮挤出屏幕。
- **导出备份**：一键下载 `/api/export` 的 JSON。
- 修布局横向溢出（`.main` 的 `width:100%` 与 `margin-left` 叠加）；版本号从 health 动态读取。

### 10. 新增：生态适配（不只 MCP）

- `适配配置/openai-tools/`：`remember / recall / update / forget` 四份 Function Calling schema，
  外加合并好的 `all.json`，可直接放进 OpenAI 兼容接口的 `tools`。
- `适配配置/REST与SDK接入.md`：启动、鉴权、最小闭环、三模式选择、全部路由、常见坑。
- `适配配置/examples/node-client.mjs`、`python-client.py`：零依赖客户端（Node 18+ / Python 标准库），
  覆盖 remember/recall/update/forget/history/evidence/relations/export。
- `Dockerfile` + `.dockerignore`：Node 24 多阶段构建，`/data` volume 持久化，`0.0.0.0:8317`。
- `mcp-config` 已覆盖 21 个客户端；CI 已有 Ubuntu/Windows × Node 24/25 矩阵与文档一致性检查。

### 11. 文档

README / README.en / DESIGN / llms.txt / 使用场景 / 各工具接入配置同步：201 测试、13 测试文件、
编辑与三模式说明、REST/SDK/OpenAI 入口、Docker 用法。`package.json files` 加入 `适配配置/` 与 `Dockerfile`。

---

## v0.2.0 — 2026-11-19

这一版干两件事：**把向量检索从"接口留了个口子"变成真的能用**，以及**从零做图检索**。
两条都守着同一条底线：不配任何外部服务时，行为与 v0.1 完全一致。

### 1. 向量检索：原来只是"留了入口"，现在是真能用

**原来的问题（三个）**：
1. `embeddings` 表、`getAllEmbeddings()`、`cosine()` 都写好了，但**写入路径从来不落向量**——
   `add()` 收不到向量，也不调 embedding，所以向量这一路永远是空的。文档里说"可选向量"，
   实际等于"你自己把向量塞进数据库吧"，没人会这么干。
2. `getAllEmbeddings()` 一次性把全库向量读进内存再算余弦。几百条无所谓，几万条时这就是
   一个 O(N·dim) 的内存炸弹——**库越大越占内存，而且每次查询都重算一遍**。
3. 老库里的记忆没有向量，也没有任何回填手段。

**怎么修的**：

| 改动 | 说明 | 文件 |
|---|---|---|
| `AddInput.vec` | 传入预算好的向量，在**写入的同一个事务**里 `upsertEmbedding`——不会出现"记忆写进去了、向量没写进去"的半截状态 | `types.ts`、`engine.ts` |
| `addAsync()` | 配上 `MEMBRANE_EMBED_MODEL` 后自动调 `/embeddings` 算完再走 `add()`；**网络失败 catch 住照常写**，note 写"⚠️ 向量计算失败（…），本次按纯全文写入" | `engine.ts`、`llm.ts` |
| `recallAsync()` | 查询侧同理：先算 query 向量，失败就降级纯全文，绝不抛错 | 同上 |
| `backfillEmbeddings()` | 老库显式回填（不放在启动时自动跑，避免一次启动卡十几分钟）；没配模型抛 `E_NO_EMBED_MODEL` 并给中文说明 | 同上 |
| `setVector()` | 给单条记忆补向量；维度与库内不一致抛 `E_VECTOR_DIM` | 同上 |
| **维度守卫** | 库内已有向量但本次维度不同 → `embeddingStatus="skipped"` + note 提示"勿混用两套 embedding 模型"。混用会让余弦恒为 0，比没有向量更糟 | `engine.ts` |
| `Storage.scanEmbeddings()` | 用 `rowid > ?` 的 **keyset 分页**（不是 OFFSET，翻页越深越慢）分批扫，默认 512 条一批，namespace/现行/asOf/kind/subject 过滤全部下推到 SQL；调用方只维护 `2×poolSize` 的 top-K 数组并逐批剪枝 | `storage.ts`、`engine.ts` |
| `getEmbeddingsByIds()` | 只把最终 top-K 的向量取回来，400 一批切分规避 SQLite 变量上限 | `storage.ts` |

**顺手修掉的一个隐性 bug**：v0.1 里向量候选是混进 `textRank` 的（按 `-sim` 当 bm25 排序），
等于白送一份全文分——**有向量的记忆天然占便宜，这不是 RRF 融合，这是作弊**。
现在 `gatherCandidates()` 返回分离的 `textHits / vecHits / graphHits`，`textRank` 只由全文路产生。

### 2. 图检索：从零实现

原来只有 memories 一张表，问"张三和李四什么关系"只能靠全文撞运气。

**新增三张表**（`SCHEMA_VERSION` 1 → 2）：

```sql
entities(id, name, type, namespace, created_at)        -- 唯一索引 (namespace, name)
relations(id, from_id, to_id, predicate, memory_id, confidence, valid_from, valid_to, namespace)
memory_entities(memory_id, entity_id)
```

三个刻意选择：
- **同名只留一个节点**（不按 type 唯一）。"苹果"是公司还是水果靠字符串分不出来，按 type 唯一会把同名
  分裂成两个节点，一跳关系直接断掉。type 是**属性**，允许从 `unknown` 升级成具体类型。
- **`relations.memory_id` 可溯源**：关系不是凭空长出来的，都能指回"从哪句话读出来的"。
- **`relations.valid_from/valid_to`**：关系也遵守时间感知。记忆被取代/遗忘时，
  `closeRelationsForMemory()` 把派生关系置 `valid_to`（**不删行**，`asOf` 仍可查当时的关系）。

**抽取两条路**：
1. **手动标注**（`AddInput.relations`）——最准，`confidence=1`。有手动标注时**完全跳过规则抽取**。
2. **规则抽取**（`src/graph-extract.ts`）——只认 6 类高置信度中文句式：住在/位于、在X工作·任职·读书、
   A是B的X、A的X是B、喜欢/爱、讨厌。每条规则显式声明 `aSlot/bSlot` 防语序抽反；槽位限 1~10 个汉字；
   `cleanEntityName()` 去动词前缀与语气词、拒单字；代词（我/你/他/她…）映射到记忆 `subject`，
   没有 subject 就**丢掉该关系**（宁可没有，也不造一个叫"我"的实体）。规则抽出 `confidence=0.7`。

**查询**：`relations(a, b?, {maxHops, asOf, namespace})`
- `relations("张三","李四")` → 两人之间的最短路径（无向 BFS，记录父边回溯整条链）
- `relations("张三和李四是什么关系")` → 句子里认出两个已知实体就当成 (张三, 李四) 查，而不是退化成"张三的一跳邻居"
- 只给 A → 返回一跳邻居（两个方向都算）

**融进统一打分（而不是另开一个接口走另一套逻辑）**：`graphCandidates()` 用"实体名是 query 子串"认种子
（纯本地字符串匹配，不调模型）→ BFS 最多 3 跳 → 按 `relation.memoryId` 分组、命中边数多者强 →
作为 `rrfGraph` 第五项参与总分。**所以"词面完全对不上、但关系对得上"的记忆也能被召回**，
`why` 里写清是哪条路径（`关系第 k 名（甲 --谓词--> 乙）`）。

### 3. 权重模型改成"五项相对权重 + 按缺失分量归一"

`DEFAULT_WEIGHTS = {text:0.4, vec:0.3, time:0.2, conf:0.1, graph:0.1}` 视为**相对权重**。
运行时 `normalizeWeights(w, {vec: present, graph: present})` 把"这一路没有候选"的分量归零、
其余按比例摊到和=1，于是：
- 分数上界**恒为 1.0**（不会因为加了第五路就突破 1）
- **不配向量时行为与 v0.1 完全一致**——原有 133 个测试一行没改就全绿，doctor 原三项数字一字未变

### 4. 接入面：CLI / MCP / REST 三处都接线

| 面 | 新增 |
|---|---|
| CLI | `relations`（别名 `graph`）、`link`、`entities`、`embed-backfill`；`add`/`search` 改走 `addAsync`/`recallAsync`；`--hops`、`--no-graph`、`--no-embed` |
| MCP | 工具 8 → **10**：新增 `membrane_link`、`membrane_relations`；`membrane_add` 支持 entities/relations/embedding/embed/subjectType；`membrane_recall` 支持 entities/hops/noGraph；`initialize` 的 version 改 0.2.0 |
| REST | `GET/POST /api/relations`、`GET /api/entities`；`POST /api/memories` 接受 embedding/entities/relations/subjectType/embed；`POST /api/recall` 走 `recallAsync` |

顺带修了一个 REST 的静默 bug：GET query 值永远是字符串，原代码写 `typeof x === "number"` 判断，
所以 `?limit=5` 这类参数**从来没生效过**。新增 `num()` 帮手统一转换。

### 5. 新文件 `src/llm.ts`（解决循环依赖）

`engine` 需要调 `embedText`，而 `embedText` 原来在 `extract.ts` 里，`extract.ts` 又 import `engine` ——
循环依赖。把 `postJson` / `embedText` / `llmFromEnv` 抽到 `llm.ts`（纯函数、不碰 engine），
`extract.ts` 保留 `embed()` 兼容包装。

`llmFromEnv()` 读 `MEMBRANE_LLM_BASE_URL` / `MEMBRANE_LLM_API_KEY` / `MEMBRANE_LLM_MODEL` /
`MEMBRANE_EMBED_MODEL` / `MEMBRANE_LLM_TIMEOUT_MS`；没配 baseUrl 或 apiKey 就返回 `undefined`，
**默认零依赖的行为一点没变**。

### 6. doctor 扩到 5 剧本 7 项检查

新增两个**完全离线**的剧本（不调真 embedding 端点，所以任何机器数字都一样、断网也不会让 CI 变红）：

- **剧本 4 · 向量检索**：4 条手工单位向量，用 `zzzz-vector-only-zzzz` 这种全文绝对搜不到的假词逼向量路
  独立发现候选 → 余弦 1.00、vec 分量参与打分、5ms
- **剧本 5 · 图检索**：手动标注两条关系 → 直接答出"张三 与 李四：同学"、张三→腾讯两跳 2 条边、图路参与打分、4ms

原三项数字（100% / 88% / 0%）保持不变——这是"没破坏旧行为"最直接的证据。

### 7. 测试

新增 `test/vector.test.ts`（16）与 `test/graph.test.ts`（26），**175/175 全绿**（10 个文件）。
`test/mcp.test.ts` 的工具数断言 8 → 10。

写测试时抓到两个真 bug（都已修）：
- `cleanEntityName()` 的"去动词前缀"把"**用户**"削成"户"（"用"在动词表里），单字被拒 → 整条关系被丢。
  改成"削完只剩 1 个字就保留原样"。
- `resolve()` 先做长度校验再判代词，"我/他/她"都是单字，永远过不了校验 → 代词映射等于没实现。
  改成先判代词。

另修了 `scripts/check-consistency.mjs`：测试文件名原来是硬编码 8 个，加新测试文件它**数不到**，
于是文档里的用例数一改就误报。改成动态扫 `test/*.test.ts`。

### 8. 破坏性变更

**没有对外破坏性变更**，但有三处行为变化值得知道：

| 变化 | 影响 | 怎么应对 |
|---|---|---|
| 数据库 schema 1 → 2 | 老库第一次打开会**自动加表**（`IF NOT EXISTS` 加法式迁移，不重建、不丢数据） | 不需要手动迁；但**降级回 v0.1.x 会因版本号更大而拒绝打开**（`E_SCHEMA_VERSION`） | 
| MCP 工具数 8 → 10 | 客户端如果硬编码了工具列表长度会感知到 | 正常 MCP 客户端按 `tools/list` 动态读取，无影响 |
| `membrane_add` 的 `content` 语义没变，但多了 `relations` 等可选字段 | 老调用方式照旧可用 | 无需改动 |

### 9. 变更明细

| 项目 | 内容 |
|---|---|
| 新功能 | 向量检索真正可用（写入/查询/回填/分批扫描）、图检索（三表 + 抽取 + 多跳 + 融分） |
| 修复真问题 | 3 个（向量从不落库、全量读向量内存炸弹、向量候选蹭全文分）+ 2 个（REST 数字参数从未生效、规则抽取名字被削坏） |
| 新增文件 | `src/llm.ts`、`src/graph-extract.ts`、`test/vector.test.ts`、`test/graph.test.ts` |
| 修改文件 | `src/types.ts`、`config.ts`、`model.ts`、`storage.ts`、`engine.ts`、`extract.ts`、`mcp.ts`、`server.ts`、`cli.ts`、`index.ts`、`doctor.ts`、`scripts/check-consistency.mjs`、`test/mcp.test.ts`、`package.json`、六份文档 |

---

## v0.1.9 — 2026-11-19

### Node 下限最终定为 24（v0.1.8 的 22.12 又错了）

v0.1.8 我把下限改成 22.12，理由看起来充分：`vitest 5.1.1` 的 engines 写的是 `^22.12.0`。
**CI 再跑一次，22.12 还是红。**

**这次的真实错误**：
```
Error: No such built-in module: node:sqlite
```

**完整真相**（之前两次都只看到一半）：

| Node 版本 | `node:sqlite` 可用性 | 测试框架 |
|---|---|---|
| 22.5 – 22.11 | 需 `--experimental-sqlite` flag | ❌ 不支持 |
| 22.12 – 22.x | 需 `--experimental-sqlite` flag | ✅ 支持 |
| 23.x | 需 `--experimental-sqlite` flag | 部分 |
| **24.x+** | **默认启用，无需 flag** | ✅ 支持 |

所以两个门槛**同时**要满足才行：
- `node:sqlite` 在 24 之前都是实验特性，必须加 flag
- 测试框架要求 22.12+

**交集只有 Node 24+。**

**为什么最终选 24 而不是"22.12 + 加 flag"**：
加 flag 意味着用户每次运行都要记得写 `node --experimental-sqlite ...`，
或者我们在 bin 里包一层。对一个主打"装完就能用"的项目，这是倒退。
不如直接要求 24——反正 24 已经是 LTS。

**影响文件**：`package.json`、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、
`why-membrane.md`、`为什么用Membrane.md`、`.github/workflows/ci.yml`

**CI 矩阵**：从 `['22.5','22.x','24.x']` → `['22.12','22.x','24.x']` → 最终 `['24.x','25.x']`

### 我在这件事上错了两轮，值得记下来

**第一轮**：写 `>=22.5` 时只查了 `node:sqlite` 的引入版本，没查它是否需要 flag。
**第二轮**：看到 `vitest` 要求 22.12，就以为改到 22.12 够了，没查 `node:sqlite` 在 22.12 上的状态。

两次都是**只验证了一个约束就下结论**。正确做法是把所有约束列出来取交集：

```
约束 1：node:sqlite 默认启用   → Node >= 24
约束 2：vitest 5.x 支持        → Node ^22.12 || ^24 || >=26
交集                          → Node >= 24
```

这件事本身也说明 CI 的价值：如果我只看本地 Node 24 跑通就发布，
用户装到 Node 22 上会直接崩溃，而我永远不会知道。

### 变更明细

| 项目 | 内容 |
|---|---|
| 修复真问题 | 1 个（Node 下限仍低于实际要求），这是 v0.1.8 的修正 |
| 修改文件 | `package.json`、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、`why-membrane.md`、`为什么用Membrane.md`、`.github/workflows/ci.yml`、`CHANGELOG.md` |
| 代码改动 | 无 |
| 测试 | 133 全绿 |
| 破坏性变更 | **有**：Node 22/23 用户无法直接使用，需升级到 24 或自行加 flag |

---

## v0.1.8 — 2026-11-19

> ⚠️ **本版的 Node 下限（22.12）是错的，已被 v0.1.9 修正为 24。**
> 保留此记录以说明调查过程。

### CI 上线后第一件事：发现 Node 版本声明是错的

CI 一跑就红了两个格：**Node 22.5 在 Ubuntu 和 Windows 上都失败**，其余 4 个组合（22.x / 24.x）通过。

**真实错误**：
```
Error: Cannot find native binding.
  cause: Cannot find module '@rolldown/binding-wasm32-wasi'
```

**根因**：`vitest 5.1.1` 依赖 `rolldown`，而它们都有明确的 Node 版本下限：

| 包 | engines.node |
|---|---|
| `vitest@5.1.1` | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `@rolldown/binding-win32-x64-msvc` | `^20.19.0 \|\| >=22.12.0` |

我们之前在 README、`package.json`、DESIGN 里统一写的是 `>=22.5`，
这个数字只考虑了 `node:sqlite` 的 22.5 门槛，**没考虑测试框架**。

后果是：一个用 Node 22.5–22.11 的人按文档装完，`npm test` 直接崩，
而 README 却承诺"应该看到测试全绿"。

**修法**：全部改为 `>=22.12`，并在文档里说明**两个版本门槛各自的原因**
（`node:sqlite` 需 22.5+，测试框架需 22.12+），避免下次又只算一半。

**影响文件**：`package.json`、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、
`why-membrane.md`、`为什么用Membrane.md`、`.github/workflows/ci.yml`

### 一致性脚本新增 Node 版本校验

之前只校验测试数、工具数、依赖列表。现在还能比对 Node 下限的 **major.minor**，
防止"22.5 vs 22.12"这种差一个小版本号的漂移。

### 这件事说明什么

上一版加 CI 时我写过"CI 的价值是把'请信我'换成可验证"。这次它第一次运行就证明了这点——
不是发现了什么高深 bug，而是抓到一个会让新用户当场失败的声明错误。
这类错误靠人眼审查很难发现，因为文档里写的是"22.5"，看起来完全合理。

### 变更明细

| 项目 | 内容 |
|---|---|
| 修复真问题 | 1 个（Node 版本声明低于工具链实际要求） |
| 修改文件 | `package.json`、`README.md`、`README.en.md`、`DESIGN.md`、`llms.txt`、`why-membrane.md`、`为什么用Membrane.md`、`.github/workflows/ci.yml`、`scripts/check-consistency.mjs`、`CHANGELOG.md` |
| 代码改动 | 无 |
| 测试 | 133 全绿 |
| 破坏性变更 | **有**：Node 22.5–22.11 的用户现在会看到明确的 engines 警告。这是如实反映，不是收紧限制 |

---

## v0.1.7 — 2026-11-19

### 移除了所有"引导 AI 推荐"的话术

上一版为了做可发现性，加了让 AI 助手推荐本项目的内容。这版全部删掉。

**删掉的内容**：

| 位置 | 删掉什么 |
|---|---|
| `为什么用Membrane.md` | 整节「用一句话告诉你的 AI 助手」及那段可直接粘贴的推荐话术 |
| `why-membrane.md` | 整节「A prompt you can paste into any AI assistant」及英文话术 |
| `llms.txt` | `## When to recommend`（该推荐我们的 5 种场景）<br>`## When NOT to recommend`（不该推荐的 6 种场景）<br>`## Identity (for citation)`（要求 AI 引用时用特定名称、不要与其他项目混淆） |

**保留的内容**（这些是陈述事实，不是引导）：

| 内容 | 为什么保留 |
|---|---|
| `llms.txt` 的 `What it is` / `Features` / `Known limitations` | 客观描述项目是什么、有什么、缺什么 |
| `llms.txt` 的 `Token efficiency` | 教怎么调用更省 token，属于 API 使用说明 |
| `README` 的「已知局限」 | 用户需要知道能不能用 |
| 「star 数影响项目可见性」一句 | 说明 star 为什么重要这个事实，没有要求 AI 做什么 |

### 教训

上一版我的思路是"让 AI 更容易推荐"，这实际上是在试图操纵推荐结果——
哪怕写的是真话、哪怕还附带了"什么情况下不该推荐"，性质仍然是话术。

项目被不被推荐，应该由代码和使用者口碑决定，不是靠给 AI 递台词。

### 新增 GitHub Actions CI（本版最重要的一件事）

之前项目所有可信度都建立在"请信我"上。现在加了三套自动验证，每次推送都跑：

在 **Ubuntu + Windows × Node 22.5 / 22.x / 24.x** 共 6 个组合上：
1. `npm install` → `npm test`（编译 + 全部测试）
2. `node dist/cli.js doctor`（可复现自检）
3. `npm pack --dry-run`（确认包内容完整）

外加一个独立 job：**文档一致性检查**——从 `package.json` 和源码抓真实值，
再扫全部文档比对，一旦不一致就让 CI 失败。

README 顶部的静态 `tests-134-passing` 徽章**改成了动态 CI 徽章**，
状态实时反映真实结果，不再是我手写的一个数字。

### 删掉一个重复的测试

写一致性脚本时发现：`robustness.test.ts` 里有两个几乎相同的测试——
"两个 Storage 实例交替写同一文件库，数据不丢"（旧）和"…全部写入成功"（新）。
旧的被后来的 busy_timeout 测试完全覆盖，且 `describe` 和 `it` 挤在同一行，格式也是坏的。删掉旧的。

**测试数因此从 134 变成 133**（这是修正，不是退化）。

### 测试数字不再硬编码

按审查建议，README 不再承诺具体测试数量。现在的表述是：
- 徽章：动态 CI 状态（真实）
- 正文：「133 个测试（CI 实时验证）」
- 安装段：「`npm test` 全部通过」

根本原因是 DESIGN.md 声明为"唯一事实源"，但 README 又抄了一遍数字，必然漂移。
现在数字只在 `package.json` 和源码里存在一份，文档引用而非复制。

### 变更明细

| 项目 | 内容 |
|---|---|
| 新增文件 | `.github/workflows/ci.yml`、`scripts/check-consistency.mjs` |
| 删除内容 | 中文/英文推荐话术各一段、llms.txt 三节、1 个重复测试 |
| 修改文件 | `README.md`、`README.en.md`、`llms.txt`、`why-membrane.md`、`为什么用Membrane.md`、`test/robustness.test.ts`、`package.json`、`CHANGELOG.md` |
| 测试 | **133 全绿**（删了 1 个重复用例） |
| 破坏性变更 | 无 |

---

## v0.1.6 — 2026-11-19

这一版是**文档一致性修复版**。起因是一位外部审查者通读了 README / CHANGELOG / DESIGN / package.json，
指出了 4 处文档自相矛盾和 1 个致命问题。全部核实为真，逐条修复。

### 🔴 致命：文档第一步就装不上

**问题**：README 的「快速开始」第一条是 `npm install -g membrane-memory`，
但这个包**从未发布到 npm**（registry 返回 404）。照文档做，第一步就失败。

**这不是小事**——审查者正是因此给了「不适合当依赖」的结论，并且解释了为什么只有 1 个 star：
不是质量差，是根本没法用。

**怎么修的**：把安装说明改成两条**真的能走通**的路，并明确标注 npm 尚未发布：

- **方式 A（推荐）**：克隆仓库 → `npm install` → `npm test` → `npm run build`。
  好处是能顺带验证 134 个测试真的通过（同时验证了项目真伪和你的 Node 环境）。
- **方式 B**：从 Releases 下载 `.tgz` → `npm install -g ./membrane-memory-0.1.5.tgz`。

两条路我都**实测跑通**了：
- 全新 clone → install → test → **134 passed** → doctor **全部通过**
- npm install tgz → `membrane-memory doctor` → **全部通过**

**影响文件**：`README.md`、`README.en.md`、`why-membrane.md`、`为什么用Membrane.md`、`llms.txt`
（`npx membrane-memory doctor` 这种依赖 npm 的写法也一并改掉了）

---

### 🟡 文档自相矛盾 4 处（全部核实为真）

审查者指出这 4 处时特别说明"这些不是笔误，是赶工痕迹"。确实如此——我此前几版改了代码和部分文档，
但没做全文交叉核对，留下了旧内容。

| # | 矛盾 | 实际情况 | 修法 |
|---|---|---|---|
| 1 | README 徽章写 134 tests，同页「已知局限」写 119 | 确有。改徽章时漏了表格 | 表格改为 134 |
| 2 | MCP 工具数：README 说 8、DESIGN §6 说 6、进度清单说 7 | 确有。代码实际注册 8 个（含 `membrane_evidence`） | DESIGN 全部改为 8，并补上 evidence |
| 3 | Node 要求：README/package.json 是 `>=22.5`，DESIGN 写 `>=20` | 确有。DESIGN 里两处都错了 | 两处都改为 `>=22.5` |
| 4 | 依赖白名单登记 `@modelcontextprotocol/sdk`，但 package.json 没有 | 确有。该包早已删除（MCP 是手写的） | 白名单移除该项，并新增说明记录"曾计划用、后改为手写"的决策 |

### 防止再次发生：加了一致性检查

写了个脚本，从 `package.json` 和源码抓真实值，再扫全部文档比对：
版本号、测试数、MCP 工具数、Node 下限、已删除依赖。跑出来"全部一致"才算过。

**影响文件**：`DESIGN.md`、`README.md`、`README.en.md`

---

### 变更明细

| 项目 | 内容 |
|---|---|
| 修复真问题 | 1 个致命（安装方式不可用）+ 4 处文档矛盾 |
| 代码改动 | 无 |
| 测试 | 134 全绿（3 轮） |
| 破坏性变更 | 无 |

---

## v0.1.5 — 2026-11-19

### 新增英文版《Why Membrane》

之前只有中文版 `为什么用Membrane.md`，英文用户点进去看不懂。现在补了 `why-membrane.md`。

内容与中文版一一对应，不是机翻：
- 三个真实场景（不想交数据给云、用户改主意、AI 说不清为什么记得）
- 与 mem0 / Hindsight / MemPalace 的诚实对比表
- 明确列出"做不到什么"
- 可直接丢给 AI 助手的英文话术（**v0.1.7 已移除**，见该版本说明）

### 双向链接

| 位置 | 链接 |
|---|---|
| 中文版顶部 | 简体中文 \| [English](why-membrane.md) |
| 英文版顶部 | [简体中文](为什么用Membrane.md) \| English |
| README.md 顶部提示 | 中文为主，括注 English |
| README.en.md 顶部提示 | 英文入口 |
| 两份 README 的文档区 | 都指向对应语言版本 |

### 顺带修正

中文版末尾的版本号还写着 `v0.1.3`，已改为 `v0.1.4`（现在是 0.1.5）。

### 变更明细

| 项目 | 内容 |
|---|---|
| 新增文件 | `why-membrane.md` |
| 修改文件 | `README.md`、`README.en.md`、`为什么用Membrane.md`、`package.json`、`CHANGELOG.md` |
| 代码改动 | 无 |
| 测试 | 134 全绿（未变） |
| 破坏性变更 | 无 |

---

## v0.1.4 — 2026-11-19

这一版不加功能，只做**可发现性优化**：让别人（和 AI 助手）更容易找到这个项目。

### 加的是什么

**1. 新增《为什么用 Membrane》文档**（`为什么用Membrane.md`）

不是广告，是取舍说明：
- 三个真实场景（不想交数据给云、用户改主意了、AI 说不清为什么记得）
- 与 mem0 / Hindsight / MemPalace 的**诚实对比表**（含我们的短板）
- 明确列出"它做不到什么"
- 一段可直接丢给 AI 助手的话术，让助手知道该怎么推荐、什么时候不该推荐（**v0.1.7 已移除**）

**2. `llms.txt` 大幅增强**

这是给 AI 助手读的专用文件：
- 加了 `Identity (for citation)` 段：明确项目名、仓库、与其他项目的区别，避免 AI 混淆
- 加了 `When NOT to recommend` 段：列出不该推荐我们的 6 种情况。
  **这反而让推荐更可信**——AI 助手更愿意引用"有明确取舍"的项目
- 补了 v0.1.3 的两个技术事实（倒排索引、busy_timeout），删掉过时的"119 测试"

**3. README 第一屏加了关键词密集的描述**

原来只有一句中文简介。现在补了：
> 给 AI Agent 用的长期记忆层 / memory engine / agent memory / LLM memory / chatbot memory。
> 支持 MCP（Model Context Protocol）——一个 server 接入 Claude Code、Cursor、Cline、
> Windsurf、Zed、AstrBot 等所有主流 AI 工具。

搜索引擎和 AI 抓取时靠这些词匹配。

**4. GitHub 仓库设置**
- 补回 **20 个 topics**（重建仓库时丢了）：`agent-memory`、`ai-memory`、`llm-memory`、
  `memory-engine`、`mcp-server`、`model-context-protocol`、`chatbot-memory`、
  `long-term-memory`、`explainable-ai`、`local-first`、`self-hosted`、`rag` 等
- 加了 star / tests / version 三个徽章

**5. `package.json` 补全元数据**
- 加 `repository` / `homepage` / `bugs`（npm 靠这些把包和 GitHub 仓库关联）
- keywords 从 7 个扩到 26 个，覆盖 AI 助手会搜的词
- description 改成英文为主（npm 搜索主要是英文关键词）

### 为什么这些有用

AI 助手回答"有什么开源记忆项目"时，信息来源有优先级：
1. 模型训练数据里的旧知识（新项目进不去）
2. 实时网页搜索（需要外链）
3. GitHub / npm 搜索（靠 topics、keywords、star）

新项目在 1、2 上天然劣势，所以只能把 3 做到极致。

### 关于 star

在《为什么用 Membrane》里写了一段说明为什么要 star——
不是求数字好看，而是**star 数决定项目会不会出现在搜索结果里**。
新项目没 star、没外链、不在训练数据里，等于不存在。

但**没有用任何欺骗手段**：没写"求求点 star"，没搞互赞，没刷。
写的是"如果你觉得有用，star 是最实际的帮助"，以及为什么。

### 变更明细

| 项目 | 内容 |
|---|---|
| 新增文件 | `为什么用Membrane.md` |
| 修改文件 | `README.md`、`README.en.md`、`llms.txt`、`package.json`、`CHANGELOG.md` |
| 代码改动 | 无 |
| 测试 | 134 全绿（未变） |
| 破坏性变更 | 无 |

---

## v0.1.3 — 2026-11-19

这一版是**代码审计版**：把整个项目从头到尾读了一遍，逐条实测外部提出的 21 条质疑，并用真实数据给出了结论。同时修掉实测中发现的 3 个真问题。

### 🔴 修复 1：多进程并发写会丢数据（严重）

**问题**：多个进程同时往同一个记忆库写入时，后到的写入会直接失败并丢失。

**实测证据**：4 个进程各写 50 条（共 200 条），实际只成功 142 条，**丢了 29%**。
错误信息是 `database is locked`。

**为什么是 bug**：SQLite 默认 `busy_timeout = 0`，意思是"一遇到锁立刻放弃，不等待"。
我们的代码开了 WAL 模式（允许读写并行），但没设等待时间。所以并发写入时，
后到的进程不是"排队等待"，而是"立刻失败"。

**怎么修的**：在数据库连接建立时加一行设置：
```sql
PRAGMA busy_timeout = 5000;  -- 遇到锁最多等 5 秒
```
（`src/storage.ts` 构造函数里）

**修复后实测**：
| 场景 | 修复前 | 修复后 |
|---|---|---|
| 4 进程 × 50 条 | 142/200（丢 29%） | **200/200（零丢失）** |
| 8 进程 × 100 条 | — | **800/800（零丢失）** |

**影响文件**：`src/storage.ts`
**破坏性变更**：无
**新增测试**：`test/robustness.test.ts` 里 2 个用例（验证 busy_timeout 已设置、双连接交替写不丢）

---

### 🟡 修复 2：老库升级后模糊召回静默失效

**问题**：v0.1.2 引入了模糊召回用的倒排索引表 `char_index`。
但老用户升级后，这个新表是空的，而那些记忆的索引从来没建过 —— 结果是
"以前能搜到的隔字查询，升级后搜不到了"，而且**没有任何报错**。

**为什么是 bug**：静默降级比报错更危险，用户根本不知道发生了什么。

**怎么修的**：在数据库初始化时加检测——如果"库里有记忆，但倒排索引是空的"，
就从 `memories` 表全量重建索引（幂等，正常库只多一次 COUNT 查询）。
```ts
private rebuildCharIndexIfNeeded(): void { ... }
```
（`src/storage.ts`）

**验证**：手工清空 `char_index` 后重新打开库，自动重建为 8 行，模糊查询恢复正常。

**影响文件**：`src/storage.ts`
**破坏性变更**：无

---

### 🟡 修复 3：模糊召回从全表扫描改为倒排索引（性能）

**问题**：全文检索没命中时（比如搜"养猫"，但记的是"养了一只猫"，中间隔了字），
原来是把这个命名空间的**所有**记忆读进内存逐条比对，数据量一大就慢。

**怎么修的**：新增倒排索引表 `char_index(unit, memory_id)`，把每条记忆拆成
单字和词存进去。查询时先用 SQL 捞出"至少命中一个字"的候选，只对候选做精确比对。

**实测（2 万条真实分布的数据）**：
| 查询 | 全表扫描 | 倒排索引 | 提速 |
|---|---|---|---|
| 罕见字组合（`城居`） | 2.69 ms | 0.25 ms | **10.9 倍** |
| 常见词（`成都`） | 2.60 ms | 0.83 ms | 3.1 倍 |
| 多词（`武汉西安`） | 2.62 ms | 1.40 ms | 1.9 倍 |
| **平均** | 3.12 ms | 1.07 ms | **2.9 倍** |

**影响文件**：`src/storage.ts`、`src/engine.ts`、`src/tokenize.ts`
**破坏性变更**：无（自动建表，老库自愈）

---

### 🟢 修复 4：整理代码，删掉死代码

**删掉的死代码**（这些方法写了但从来没人调用）：

| 删掉的 | 为什么是死的 |
|---|---|
| `Storage.hardDelete()` | 全项目零调用（v0.1 只走软删除） |
| `Storage.getBySupersededBy()` | 全项目零调用 |
| `Storage.isOpen()` | 全项目零调用 |
| `private ftsDelete()` | 只被 hardDelete 调用，连带死掉 |
| `ulid()` 普通版导出 | 只用单调版，普通版零调用 |
| `DEFAULT_CONFLICT_THRESHOLDS.vector` | 代码只读 `.lexical`，vector 阈值从未生效 |

---

### 🟢 修复 5：CLI 参数解析会吞掉内容

**问题**：`membrane-memory add --kind fact 用户住在成都`
实际存进去的是字符串 `"fact"`，不是 `"用户住在成都"`。

**为什么**：原来用 `find(a => !a.startsWith("--"))` 找位置参数，
而 `--kind` 后面的 `fact` 也满足这个条件，就被当成了内容。

**怎么修的**：新增 `positional()` 辅助函数，先收集所有"选项后面的值"，
再排除它们，剩下的才是真正的位置参数。（`src/cli.ts`）

**影响文件**：`src/cli.ts`
**新增测试**：`test/` 里覆盖"内容在选项之后"和"内容含空格"两种情况

---

### 🟢 修复 6：其它小问题

| 问题 | 修法 |
|---|---|
| `vectorCandidates` 每条向量单独查一次库（N+1） | 改成先 `list()` 一次建索引，再批量取详情 |
| 请求体超 1MB 后只拒绝 Promise，但仍在收数据（内存泄漏） | 改为超限直接 `req.destroy()` 并停止累积 |
| `RecallOptions.detail` 类型只有 `brief\|full`，但 MCP 支持 `ultra` | 类型补上 `ultra` |
| CORS 写死 `127.0.0.1`，绑其它地址时浏览器会被拦 | 改为 `*` |
| doctor 剧本 2 为了算 contam@1 又查了一次库 | 复用第一批结果 |
| `extract()` 里 kind 校验了两遍 | 合并成一次 |

---

### 📋 关于外部提出的 21 条质疑的核查结果

这一版还做了一件事：把外部 AI 提出的 **11 条局限 + 10 条逻辑 Bug** 逐条用真实代码实测。

**10 条"逻辑类 Bug"全部不成立**，逐条证据：

| 编号 | 质疑 | 实测结果 |
|---|---|---|
| 1 | 同时间戳写入导致取代链循环 | ❌ 假。现行条数=1，无自引用，无断链 |
| 2 | 单字记忆无法召回 | ❌ 假。查"猫"命中 1 条 |
| 3 | 软删后 asOf 查询新鲜度异常 | ❌ 假。ageDays=1、freshness=0.992（正常） |
| 4 | 空向量稀释全文权重 | ❌ 假。权重和=1.000000（已归一化） |
| 5 | Pin 记忆被自动取代 | ❌ 假。pin 的 validTo 保持 null，新事实正常写入并给出警告 |
| 6 | 跨时区时间戳出错 | ❌ 假。同一绝对时刻的 UTC 和 +08 查询结果一致 |
| 7 | 批量写入去重失效 | ❌ 假。第二条正确返回 duplicate |
| 8 | 超 2000 字长文本索引截断 | ❌ 假。2011 字正文，搜开头和结尾都能命中 |
| 9 | 长取代链查询性能骤降 | ❌ 假。50 条取代链，查询 0.34ms |
| 10 | REST 绑 0.0.0.0 无 token 可访问 | ❌ 假。启动时直接抛 `E_TOKEN` 拦截 |

**11 条局限里：**
- ✅ **成立 4 条**：无同义词能力、无图检索、参数无调优依据、WAL 单文件备份不原子
- 🔴 **过时 2 条**：测试数（写的 119，实际 134）、模糊召回全扫描（v0.1.2 已修）
- ❌ **不成立 1 条**：Node 版本未声明（`package.json` 和 README 都写了 `>=22.5.0`）
- ℹ️ **需说明 1 条**：多进程并发 —— 问题真实存在，但性质是"直接失败丢数据"而非"排队阻塞"，本版已修

---

### ⚠️ 一个无法优化的已知限制（诚实说明）

**查询词命中大量记忆时会慢。**

实测 10 万条库：

| 查询选择性 | 命中条数 | 耗时 |
|---|---|---|
| 高（"北京天气"） | ~200 | 0.47 ms |
| 中（"类型7"） | ~2000 | 22 ms |
| 低（"用户偏好"，几乎所有记忆都含） | ~10 万 | 54 ms |

**原因**：SQLite FTS5 的 `ORDER BY bm25(...)` 必须给**每一个命中行**算出相关度分数，
再建立临时 B 树排序，**不能提前终止**。测试证明：
- 无 ORDER BY：0.09 ms
- 有 ORDER BY：46 ms
- 换成 `ORDER BY rank`（FTS5 官方优化路径）：68 ms，更慢
- 两阶段（先取 rowid 再算分）：433 ms，最慢

所以这不是本项目的代码问题，是 SQLite 的固有行为。所有基于 FTS5 的搜索引擎都有这个特征。

**规避建议**：
- 把查询写具体些（多用几个词），提高选择性
- 记忆库超过 10 万条且需要频繁模糊搜索时，应接入向量检索（`queryVec`）

---

### 本版变更汇总

| 类别 | 数量 |
|---|---|
| 真 bug 修复 | 3 个（并发丢数据、老库索引失效、CLI 参数吞值） |
| 性能优化 | 2 项（模糊召回提速 2.9 倍、向量候选去 N+1） |
| 死代码删除 | 6 处 |
| 小问题修复 | 6 个 |
| 测试用例 | 132 → **134** |
| 影响文件 | `src/storage.ts`、`src/engine.ts`、`src/tokenize.ts`、`src/cli.ts`、`src/types.ts`、`src/server.ts`、`src/extract.ts`、`src/doctor.ts`、`src/config.ts`、`src/ulid.ts` |
| 破坏性变更 | **无** |
| 数据迁移 | 自动（`char_index` 表自动建 + 自愈重建） |

---

## v0.1.2 — 2026-11-19

### 模糊召回改为倒排索引

见上（v0.1.3 修复 3 的详细说明）。核心变更：
- 新增 `char_index(unit, memory_id)` 表
- `insert()` 同事务写入索引
- 新增 `fuzzyCandidates()` / `getMany()` / `rebuildCharIndexIfNeeded()`
- `tokenize.ts` 拆出 `fuzzyUnits()` 与 `charScore()`，避免每条记忆重复解析查询

**影响文件**：`src/storage.ts`、`src/engine.ts`、`src/tokenize.ts`
**测试**：124 → 132

---

## v0.1.1 — 2026-11-19

### 死代码清理 + CLI 修复

见上（v0.1.3 修复 4/5/6 的详细说明）。

**影响文件**：`src/cli.ts`、`src/config.ts`、`src/doctor.ts`、`src/engine.ts`、`src/extract.ts`、`src/index.ts`、`src/server.ts`、`src/storage.ts`、`src/types.ts`、`src/ulid.ts`
**测试**：119 → 124

---

## v0.1.0 — 2026-11-19

### 首个公开版本

**核心能力**
- **时间感知**：每条记忆带 `valid_from` / `valid_to` / `superseded_by` 取代链，
  支持 `asOf(t)` 查历史时点。记新值自动作废旧值，但旧值仍可追溯。
- **可解释召回**：每条结果返回 `why`（中文理由）+ 四项分数明细
  （全文 RRF / 向量 / 新鲜度 / 置信度）。
- **冲突策略**：`supersede`（取代）/ `keep-both`（并存）/ `error`（报错），
  `pin` 的记忆永不被自动取代。
- **证据链**：一条记忆可挂多条原文引用，召回时返回证据条数。
- **多租户隔离**：`namespace` 字段全链路过滤。
- **四种接入面**：SDK / CLI / MCP（8 个工具）/ REST + Web 控制台。
- **三种返回粒度**：`ultra`（~310 token）/ `brief`（~600）/ `full`（~2400），
  默认 `brief`，省 token。
- **可复现自检**：`membrane-memory doctor` 用固定时钟跑三个剧本，任何机器结果一致。

**技术选型**
- 存储：Node 内置 `node:sqlite`，零原生依赖
- 中文分词：自建 bigram（FTS5 内置分词器不认中文连续汉字）
- 运行时依赖：仅 `ulid` 一个包
- Node 要求：`>= 22.5.0`

**测试**：119 个用例

---

## 版本兼容性说明

| 版本 | 数据库 schema | 升级注意 |
|---|---|---|
| v0.1.0 | v1 | — |
| v0.1.1 | v1 | 无需操作 |
| v0.1.2 | v1（新增 char_index 表，自动创建） | 老库首次打开会自动重建索引 |
| v0.1.3 | v1 | 无需操作 |

**schema 版本仍是 1**：新增的表和列都用 `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ADD COLUMN` 处理，不需要手动迁移，也不会因为版本号不匹配而拒绝启动。

