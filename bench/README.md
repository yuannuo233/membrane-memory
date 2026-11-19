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

压测库写在仓库内 `.bench/`（已 gitignore），不会进 git。结果 JSON 也写在该目录，例如 `.bench/result-100000-1536-lsh.json`；本目录保留一份可直接查看的副本：`results-100000-lsh.json`、`results-100000-exact.json`、`results-10000-lsh.json`。

## 优化前后

| 版本 | 100k × 1536 vector-only |
|---|---:|
| v0.2.4（逐行 `rowToRecord` + 精确全扫） | ~10.9s |
| v0.2.5（只扫 `id/vec/norm` + 预计算范数 + LSH 桶） | **~0.30s** |

## 已知边界

- 百万级、千万级未压测；LSH 的桶数量固定为 8×256，数据再大需要分层/更多表。
- 真实 embedding 的分布通常比合成簇更复杂，建议在自己的库上抽样对账 `exactVectorSearch`。
- FTS5 对"命中全库"的宽查询仍是线性的（100k 约 129ms），这是 SQLite FTS5 的固有限制。
- 100k×1536 的库约 955MiB，磁盘占用是向量检索的硬成本；需要更小体积应做量化/PQ，当前未实现。
