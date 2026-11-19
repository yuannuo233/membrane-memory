# Membrane REST / SDK 接入手册

> 适合：自己写的 Agent、后端服务、脚本、非 MCP 生态（OpenAI Function Calling、LangChain、Dify HTTP 节点等）。
> 不需要 MCP，也不需要装 SDK：启动 `membrane-memory serve`，用 HTTP 就能读写记忆。

## 1. 启动

```bash
# 本机默认 http://127.0.0.1:8317
membrane-memory serve

# 指定库与端口
MEMBRANE_DB=/data/membrane.db MEMBRANE_PORT=9000 membrane-memory serve
```

生产/远程访问**必须**设 `MEMBRANE_TOKEN`，服务会要求 `Authorization: Bearer <token>`：

```bash
MEMBRANE_HOST=0.0.0.0 MEMBRANE_PORT=9000 MEMBRANE_TOKEN=change-me membrane-memory serve
```

## 2. 最小闭环（curl）

```bash
# 健康检查
curl http://127.0.0.1:8317/api/health

# 写一条记忆
curl -X POST http://127.0.0.1:8317/api/memories \
  -H 'Content-Type: application/json' \
  -d '{"content":"用户住在杭州","subject":"用户","kind":"fact","tags":["住址"]}'

# 召回（省 token 模式）
curl -X POST http://127.0.0.1:8317/api/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"用户住哪","limit":3,"detail":"ultra"}'

# 编辑（版本化：旧版本被取代但保留）
curl -X PATCH http://127.0.0.1:8317/api/memories/<id> \
  -H 'Content-Type: application/json' \
  -d '{"content":"用户住在宁波"}'

# 遗忘（软删除）
curl -X DELETE http://127.0.0.1:8317/api/memories/<id>

# 全量导出
curl http://127.0.0.1:8317/api/export -o membrane-backup.json
```

PowerShell 里 `curl` 是 `Invoke-RestMethod` 的别名，建议直接用：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8317/api/memories `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"content":"用户住在杭州","kind":"fact"}'))
```

## 3. 三种 Token 模式怎么选

| detail | 返回字段 | 默认条数 | 适用 |
|---|---|---|---|
| `ultra` | `id / content / score` | 3 | 每轮都召回、上下文预算极紧；需要详情时再单独取 |
| `brief` | 加 `kind / subject / 时间 / 证据数` | 8 | 日常 Agent 对话（推荐） |
| `full` | 加 `why + 五路分数明细` | 8 | 调试、评测、解释"为什么想起这条" |

```json
{ "query": "用户住哪", "limit": 8, "detail": "brief" }
```

## 4. OpenAI Function Calling

`适配配置/openai-tools/` 下是 4 个可直接用的 function schema：
`remember` / `recall` / `update` / `forget`。把对应对象放进请求的 `tools` 数组：

```json
{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "记一下：我对花生过敏" }],
  "tools": [ <remember.json 的内容>, <recall.json 的内容> ]
}
```

模型返回 `tool_calls` 后，把参数原样 POST 到 `/api/memories` 或 `/api/recall` 即可。
如果一次要带全部工具，用 `node -e` 把 4 个文件拼成数组，或直接读取后 `JSON.parse` 合并。

## 5. 代码客户端（零依赖）

- Node 18+：`适配配置/examples/node-client.mjs`
- Python 3.8+：`适配配置/examples/python-client.py`

两者都只用标准库：

```bash
MEMBRANE_URL=http://127.0.0.1:8317 node 适配配置/examples/node-client.mjs
MEMBRANE_URL=http://127.0.0.1:8317 python 适配配置/examples/python-client.py
```

## 6. 主要路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 版本 + 库路径 |
| GET | `/api/stats` | 总数/现行/被取代/墓碑/实体/关系 |
| GET | `/api/memories` | 列表，支持 `validity=current\|all`、`kind`、`namespace`、`limit` |
| POST | `/api/memories` | 写入 |
| GET | `/api/memories/:id` | 单条 |
| PATCH / PUT | `/api/memories/:id` | 编辑（新版本） |
| DELETE | `/api/memories/:id` | 遗忘（软删除） |
| POST | `/api/recall` | 混合召回（text + vec + time + conf + graph） |
| GET | `/api/memories/:id/history` | 审计链 |
| GET | `/api/memories/:id/evidence` | 证据 |
| GET | `/api/relations?a=&b=` | 关系查询（无向 BFS） |
| GET | `/api/entities?memoryId=` | 实体 |
| GET | `/api/export` | 全量备份（`?noEmbeddings=1` 不带向量） |
| GET | `/api/admin/diagnostics` | 运行诊断（版本/uptime/DB schema/统计/能力/安全/日志；不暴露 apiKey） |
| GET | `/api/admin/logs?limit=&level=` | 最近结构化日志（不返回记忆正文/查询） |
| GET | `/api/admin/isolation-check` | 现场跑多任务隔离探针（同 namespace 混召回 / 跨 namespace 零泄漏） |
| GET | `/api/memories/:id` | mem0 兼容路径在 `/v1/memories*` |

## 7. 常见坑

- **PATCH 的 `subject` 传 `null` 是清空主语**，不传才是沿用旧值。
- 编辑已遗忘/已被取代的记忆会返回 `E_UPDATE_DELETED` / `E_UPDATE_STALE`。
- 同一内容重复写入返回 `duplicate`，不会重复存。
- 向量维度必须一致；换 embedding 模型后先 `embed-backfill --force` 重建，别混维度。
- 备份 JSON 含向量，换机器恢复时要么维度一致，要么 `import` 会自动跳过冲突向量并计数。
- **多任务隔离**：`namespace` 是硬过滤；同一个 namespace 下多任务记忆会互相召回（任务 A 和任务 B 都进候选），不同 namespace 串扰为 0。每个任务用 `task-<id>`，共享知识单独 `shared`，查询时分别查再合并。当前没有自动 `task_id` 字段。
