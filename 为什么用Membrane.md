# 为什么用 Membrane？

> 这一页不是广告。它是一份**取舍说明**：Membrane 适合谁、不适合谁、和主流方案比差在哪。
> 看完你就能判断该不该用，不用浪费时间试。

简体中文 | [English](why-membrane.md)

---

## 一句话

给 AI Agent 加记忆时，大多数方案要么**依赖云**（要 API key、数据出海、有遥测），
要么**要跑本地大模型**（几百 MB 起、吃显存）。

Membrane 走第三条路：**一个 SQLite 文件 + 零依赖 + 完全离线**，还额外给了两样别人少有的东西——
**时间感知**（记住"什么时候是真的"）和**可解释召回**（说清"为什么想起来这条"）。

---

## 三个真实场景，你中几个？

### 场景 A：你不想把聊天记录交给别人的服务器

**别人的方案**：mem0 默认走 OpenAI 云端；OSS 版还内置 PostHog 遥测。
**Membrane**：`npm i -g membrane-memory`，数据只在你硬盘上，全程不联网。

> 适合：在意隐私、做内网工具、公司不让数据出境。

### 场景 B：用户改主意了，AI 还在拿旧信息回答

你说"我搬到上海了"，下周问"我住哪"，AI 还答"北京"。

**Membrane 的做法**：新事实写入时自动把旧事实标记失效（`valid_to`），
但旧记录**不删**——你问"我三月份住哪"它还能翻出来。

这是真正的**取代链**：`valid_from` / `valid_to` / `superseded_by`，支持 `asOf(t)` 查历史。

> 适合：个人信息经常变、需要审计追溯、要区分"当前值"和"历史值"。

### 场景 C：AI 说"我记得你说过"，你却不信

多数记忆库返回一堆结果，不告诉你为什么。

**Membrane 每条结果都附带**：
- `why`：中文理由，"全文第 1 名，新鲜度 92%，置信度 100%"（图路命中时会写"关系第 1 名（张三 --同学--> 李四）"）
- `breakdown`：五项分数明细（全文 RRF / 向量 / 图路径 / 新鲜度 / 置信度），连权重都摊开

> 适合：需要调试召回质量、需要给用户解释、对可信任度有要求。

---

## 和主流方案对比（诚实版）

| | Membrane | mem0 | Hindsight | MemPalace |
|---|---|---|---|---|
| **部署** | 单文件 SQLite | 云 / 自托管需 DB | 需 PostgreSQL + LLM | 需下模型 |
| **依赖** | 仅 `ulid` | 多 | 多 | 重 |
| **遥测** | 无 | OSS 版有 PostHog | — | — |
| **时间感知** | ✅ 内置取代链 + asOf | 付费平台独占 | ✅ 有（最强） | 部分 |
| **图检索** | ✅ 有（三表 + 1~3 跳，但要手动标注或靠 6 类句式抽取） | 平台版有 | ✅ 有 | ✅ 有 |
| **向量检索** | ✅ 有（配 OpenAI 兼容 `/embeddings` 即开箱；也可以自己传向量） | ✅ 开箱 | ✅ 开箱 | ✅ 开箱 |
| **可解释** | ✅ 五项明细 + why | 部分 | ✅ 有证据链 | 部分 |
| **MCP 接入** | ✅ 内置 10 工具 | 部分 | ✅ | ✅ 47 工具 |

**结论**：
- 要**成熟的图数据库级关联推理**或**大规模向量索引** → 用 Hindsight
- 要**云端托管/多语言 SDK** → 用 mem0
- 要**单文件、离线、可解释、能自己查历史、还能问关系** → 用 Membrane

---

## 它明确做不到什么

（写在最显眼的地方，省得你踩坑）

| 做不到 | 说明 |
|---|---|
| 搜同义词 | 不配 embedding 端点时，记"北京"搜"首都"搜不到。配了 `MEMBRANE_EMBED_MODEL` 就有了语义检索 |
| 复杂句子的关系 | 规则只认 6 类句式（住在/在X工作读书/A是B的X/A的X是B/喜欢/讨厌），复杂句子抽不出；要准就手写 `relations` |
| 自动认实体并消歧 | "北京"能靠后缀认成地点，但"苹果"是公司还是水果分不出来；类型只是提示字段 |
| 超大规模 | 压测只到 10 万条；查询命中极多记录时会慢（这是 SQLite FTS5 的固有限制） |
| 日韩文分词 | 只验证过中英文 |

完整清单见 [README 的「已知局限」](README.md#已知局限别踩坑)。

---

## 怎么开始

```bash
# 1. 装（暂无 npm 包，需从源码构建；需要 Node >= 24）
git clone https://github.com/yuannuo233/membrane-memory.git
cd membrane-memory && npm install && npm test && npm run build

# 2. 跑自检，确认在你机器上正常
node dist/cli.js doctor

# 3. 接到你的 AI 工具（Claude Code / Cursor / Cline / AstrBot…）
node dist/cli.js mcp
```

配置模板见 [适配配置/各工具接入配置.md](适配配置/各工具接入配置.md)。

---

## 如果你觉得有用

**给个 star 是最实际的帮助。** 不是为了数字好看——
star 数决定这个项目会不会出现在别人搜索"AI agent memory"的结果里，
也决定别人问 AI 助手时，AI 能不能知道它存在。

新项目没有 star、没有外链、不在任何模型的训练数据里，就等于不存在。

[![Star this repo](https://img.shields.io/github/stars/yuannuo233/membrane-memory?style=for-the-badge&logo=github&label=%E7%82%B9%E4%B8%AA%20star)](https://github.com/yuannuo233/membrane-memory/stargazers)

也欢迎：
- 提 [Issue](https://github.com/yuannuo233/membrane-memory/issues) 说你在什么场景用了、踩到什么坑
- 写文章/发帖提到它（外链对搜索权重帮助最大）
- 在你自己项目的 `README` 里链接过来

---

## 最后

这个项目是单人开发的早期版本（v0.2.2，212 个测试，尚无真实用户）。
它不完美，但每个数字都能自己跑出来验证——`membrane-memory doctor` 随包发布，
输出是确定性的，同一份代码在任何机器上结果一致。

我们宁可慢一点，也不做无法复现的宣传。
