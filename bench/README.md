# 压测记录（10 万级）

本目录放 Membrane 的规模压测结果与复现方法。数据是**合成的、固定种子的**，目的是比较优化前后和回归，不是拿真实用户 embedding 跑出来的 benchmark。

## 环境与口径

| 项 | 值 |
|---|---|
| 机器 | Windows / Node `v24.22.3` / 本地 `E:\开源盛世\tools\nodejs\node.exe` |
| 规模 | 100,000 条记忆，每条 1536 维 float32 向量 |
| 数据分布 | 50 个语义簇，簇心 + 12% 噪声（保证"真实近邻"存在，不是高维随机正交向量） |
| 文本 | `压测记忆 {i} 关于主题 {i%50}，用户编号 {i%1000}` |
| 写入 | 直接 `Storage.insert + upsertEmbedding`，绕开 `add()` 的冲突检测/图抽取 |
| 查询 | `Membrane.recall()`，`limit=10`；纯向量用 `query="zzzz-no-text"` 保证 FTS 不命中 |
| 索引 | `vector_lsh`：8 张表 × 8 bit，查询默认只探精确桶，候选 `<64` 才扩邻桶 |

## 结果（100k × 1536）

| 路径 | avg | p50 | p95 |
|---|---:|---:|---:|
| FTS-only（宽查询，命中全库） | 126 ms | 125 ms | 131 ms |
| **Vector-only（LSH）** | **298 ms** | **295 ms** | **315 ms** |
| **Hybrid（FTS + LSH + 图）** | **463 ms** | **453 ms** | **506 ms** |
| Vector-only（`exactVectorSearch` 精确全扫） | **10,912 ms** | 10,930 ms | 11,000 ms |

- 加速比：**10.9s → 0.30s，约 36.7 倍**。
- 写入：100,000 条 **48.5s**（约 2,061 条/s），含 FTS、char_index、8 张 LSH 表。
- 库大小：**955 MiB**（100k × 1536 float32，未算压缩）。
- 进程 RSS：约 **88 MiB**（向量按批读，不把 600MB 全塞内存）。
- top-1：LSH 与精确全扫都命中目标。

### 10k × 1536（同一套代码）

| 路径 | avg | p50 | p95 |
|---|---:|---:|---:|
| FTS-only | 11.4 ms | 11.3 ms | 13.0 ms |
| Vector-only（LSH） | 37.3 ms | 36.5 ms | 47.8 ms |
| Hybrid | 54.1 ms | 53.7 ms | 56.0 ms |

## 召回质量

在簇数据上，查询向量 = 某条记忆向量 + 15% 噪声：

| 查询目标 | LSH top-10 vs 精确 top-10 | top-1 |
|---|---|---|
| `bench-50000` | **10/10 重合** | 一致 |
| `bench-12345` | **10/10 重合** | 一致 |

注意：这只证明"簇状分布 + 这个桶参数"下没有明显漏召回，**不代表任意真实 embedding 分布都 10/10**。LSH 是近似索引，桶严重倾斜时可能漏近邻；需要和暴力搜索完全一致时用 `exactVectorSearch`。

## recall@k（10k × 1536，LSH vs 精确全扫）

查询向量 = 某条记忆向量 + 15% 确定性噪声；同一查询分别走默认 LSH 和 `exactVectorSearch`，比较 top-10 / top-100 重合率。

| 指标 | 结果 |
|---|---:|
| recall@10 | **100.0%** |
| recall@100（k=100） | **99.0%** |
| LSH avg | 152.7 ms |
| 精确全扫 avg | 4,175.7 ms |

> ⚠️ 精确全扫 4.1s 与 100k 的 10.9s 口径不一致：10k 应该更快，而不是更慢。该数字疑似受 `limit=100` 的 top-K 排序/冷页缓存影响，尚未定论，**不要把它当线性外推依据**。1M 的精确全扫成本过高，本轮没有跑 recall 对账。

### 100k × 1536 冷缓存复测

| 指标 | 结果 |
|---|---:|
| recall@10 | **100.0%** |
| recall@100（k=100） | **99.3%** |
| LSH avg | 4,959.6 ms |
| 精确全扫 avg | 119,041.2 ms |

> 这次复测紧跟在 1M 压测之后，页缓存被 5.7GB 库挤掉，LSH/精确全扫都比历史值（298ms / 10.9s）慢一个数量级。
> **只看重合率，不看耗时**；耗时要和前面的 10 万级表（热缓存）对比。

## 百万级（1M × 768）

数据：100 万条记忆、768 维向量，50 个语义簇 + 12% 噪声；单库 5.7GB。

| 路径 | avg | p50 | p95 |
|---|---:|---:|---:|
| FTS-only（宽查询） | 2,610 ms | 2,427 ms | 3,533 ms |
| **Vector-only（LSH）** | **8,001 ms** | **3,557 ms** | **25,898 ms** |
| **Hybrid（FTS + LSH + 图）** | **13,414 ms** | **6,258 ms** | **25,072 ms** |

- 冷启动第一次查询 26.6s（LSH 索引页 + 向量页从磁盘读），之后稳定在 **3.5s 左右**；
  avg 被冷启动拉高，看 p50 更接近稳态。
- top-1：LSH 命中目标 ✓。
- 写入：**694.8s**（约 **1,439 条/s**），含 FTS、char_index、8 张 LSH 表；WAL 峰值约 6GB。
- **1M 下 LSH 桶会截断到 5 万候选**：哈希桶倾斜时，精确桶超过 `LSH_PROBE_LIMIT`，
  旧实现会回退"百万级精确全扫"，单次查询拖到 2 分钟以上；v0.2.7 改为直接对截断后的
  5 万候选做精确重排（见 `src/storage.ts` 注释）。这保证 top-K 可用，但**不保证**在
  极端桶倾斜下仍等于暴力搜索——要严格对账用 `exactVectorSearch` 或可选 ANN 适配器。
- **FTS 的 JOIN 计划也被修了**：旧 SQL 在 1M 下会让 SQLite 先扫 100 万行 `memories`
  再回查 FTS，0 命中的查询也要 24 秒；改为 `MATERIALIZED` CTE 先算 FTS 命中集后，
  0 命中约 **2ms**，宽查询约 2.4s。

## 真实向量入口

`--vectors` 允许绕过 embedding API，直接把真实向量灌进压测库：

```powershell
# vectors.jsonl 每行：{"id":"...","vec":[0.1,...],"content":"...","subject":"...","namespace":"bench"}
node scripts/bench-scale.mjs --vectors .bench/vectors.jsonl --query-vectors .bench/queries.jsonl --queries 5 --log-every 100000
```

- 同一文件里所有向量必须同维度、同一 namespace；`--query-vectors` 每行 `{"vec":[...]}` 或纯数组。
- 这条路径只用于"你已有 embedding"的离线对账，不会调用任何网络接口。
- 真实数据没有"标准答案 top-1"，所以 `vector top-1 命中目标` 只对合成簇数据有意义。

## 复现

```powershell
cd E:\开源盛世\membrane
& 'E:\开源盛世\tools\nodejs\npm.cmd' run build

# 全新播种 + LSH 查询（默认删除临时库）
node scripts/bench-scale.mjs --count 100000 --dim 1536 --queries 10

# 保留库，之后只测查询
node scripts/bench-scale.mjs --count 100000 --dim 1536 --queries 10 --keep-db
node scripts/bench-scale.mjs --count 100000 --dim 1536 --queries 3 --reuse --keep-db

# 同一库精确全扫对账
node scripts/bench-scale.mjs --count 100000 --dim 1536 --queries 3 --reuse --keep-db --exact
```

压测库写在仓库内 `.bench/`（已 gitignore），不会进 git；测完可整目录删除，临时库不随仓库发布。结果 JSON 写在该目录，例如 `.bench/result-100000-1536-lsh.json`；本目录保留可直接查看的副本：`results-100000-lsh.json`、`results-100000-exact.json`、`results-10000-lsh.json`、`results-1000000-768.json`。本轮 1M 临时库（5.7GB）和诊断脚本已按用户要求清理。

## 优化前后

| 版本 | 100k × 1536 vector-only |
|---|---:|
| v0.2.4（逐行 `rowToRecord` + 精确全扫） | ~10.9s |
| v0.2.5（只扫 `id/vec/norm` + 预计算范数 + LSH 桶） | **~0.30s** |

## 已知边界

- 百万级已压测（1M × 768，见上）；千万级未压测。LSH 桶固定 8×256，数据再大、桶倾斜时召回会下降。
- 1M × 1536、真实 embedding 分布、极端桶倾斜的 recall 对账未跑；需要严格全扫时成本过高，建议用可选 HNSW/sqlite-vec 适配器 + 小规模抽样对账。
- 真实 embedding 的分布通常比合成簇更复杂，建议在自己的库上抽样对账 `exactVectorSearch`。
- FTS5 对"命中全库"的宽查询仍是线性的（100k 约 129ms），这是 SQLite FTS5 的固有限制。
- 100k×1536 的库约 955MiB，磁盘占用是向量检索的硬成本；需要更小体积应做量化/PQ，当前未实现。
