// Membrane Console — 零依赖前端（原生 fetch + DOM），与后端 REST 通信。
const $ = (id) => document.getElementById(id);
const API = '';

// 中英双语：默认跟随浏览器语言，手动切换后写入 localStorage。
const I18N = {
  zh: {
    'page.title': 'Membrane · 记忆引擎控制台',
    'brand.sub': '记忆引擎',
    'nav.overview': '概览', 'nav.ingest': '写入记忆', 'nav.recall': '召回',
    'nav.ledger': '记忆台账', 'nav.audit': '审计链', 'nav.ops': '运维后台',
    'title.overview': '概览', 'title.ingest': '写入记忆', 'title.recall': '召回',
    'title.ledger': '记忆台账', 'title.audit': '审计链', 'title.ops': '运维后台',
    'status.online': '引擎在线', 'status.dbFallback': '本地数据库',
    'export.backup': '↓ 导出备份',
    'eyebrow': '时间感知 · 本地优先 · 可解释',
    'mode.title': '控制召回返回的详细度：越省 Token，返回字段越少',
    'mode.ultra': '省 Token', 'mode.brief': '平衡', 'mode.full': '完整',
    'mode.hint': 'FTS5 BM25 + RRF + 时间衰减 · {mode}模式：{hint}',
    'mode.hint.ultra': '只返回 id + 内容 + 分数，最省 Token',
    'mode.hint.brief': '加类型 / 主语 / 时间 / 证据数，日常推荐',
    'mode.hint.full': '完整 why + 五路分数明细，排查用（贵约 4 倍）',
    'health.ok': '● 运行正常', 'health.offline': '● 已离线',
    'overview.total': '总记录', 'overview.totalHint': '含历史版本',
    'overview.current': '现行有效', 'overview.superseded': '已取代',
    'overview.supersededHint': '被新版本取代', 'overview.deleted': '已遗忘',
    'overview.deletedHint': '软删除，保留底稿', 'overview.entities': '实体',
    'overview.entitiesHint': '图节点', 'overview.relations': '关系', 'overview.relationsHint': '图边',
    'overview.kindDist': '按类型分布', 'overview.kindSub': '记忆类型',
    'overview.features': '引擎特性', 'overview.featuresSub': '差异化能力',
    'feature.bitemporal': '双时间模型', 'feature.explain': '可解释召回',
    'feature.explainValue': 'RRF 融合 · 五分量打分 · why',
    'feature.zero': '零依赖', 'feature.zeroValue': 'node:sqlite · 无遥测 · 单文件',
    'feature.modes': 'Token 三模式', 'feature.modesValue': '省 Token / 平衡 / 完整 —— 按场景选',
    'ingest.title': '写入流程', 'ingest.sub': '去重 → 冲突检测 → 提交',
    'ingest.content': '正文', 'ingest.contentPh': '例如：用户住在上海',
    'ingest.kind': '类型（Kind）', 'ingest.subject': '主语（Subject）', 'ingest.subjectPh': '用户',
    'ingest.namespace': '命名空间（namespace）', 'ingest.namespacePh': 'default',
    'ingest.confidence': '置信度', 'ingest.tags': '标签（逗号分隔）', 'ingest.tagsPh': '住址, 城市',
    'ingest.pin': '钉选（不自动取代）', 'ingest.commit': '写入记忆',
    'ingest.id': 'ID：{id}',
    'status.added': '已写入', 'status.duplicate': '重复，未新增', 'status.keptBoth': '与旧记忆并存待裁决',
    'ingest.note.created': '新记忆已写入。',
    'ingest.note.duplicate': '内容重复，未新增。',
    'ingest.note.superseded': '新记忆已写入，取代 {n} 条旧记忆。',
    'ingest.note.keptBoth': '新记忆已写入，与 {n} 条旧记忆并存待裁决。',
    'op.add': '写入', 'op.update': '编辑', 'op.supersede': '取代', 'op.delete': '遗忘',
    'edit.onlyActive': '只能编辑现行版本', 'edit.duplicate': '内容没变化，未创建新版本',
    'edit.saved': '已保存新版本，旧版本进入历史',
    'time.sec': ' 秒', 'time.min': ' 分', 'time.hour': ' 小时',
    'kind.fact': '事实', 'kind.episode': '情景', 'kind.preference': '偏好', 'kind.procedure': '流程',
    'kind.all': '全部', 'kind.allKinds': '全部类型',
    'recall.title': '混合召回', 'recall.queryPh': '输入查询，例如：用户住在哪',
    'recall.search': '召回', 'recall.kind': '筛选类型', 'recall.namespace': '命名空间',
    'recall.namespacePh': 'default', 'recall.limit': '返回条数',
    'recall.asof': 'asOf（历史时点）', 'recall.asofPh': 'Unix 毫秒',
    'ledger.title': '记忆台账', 'ledger.namespacePh': '命名空间',
    'ledger.includeAll': '包含已取代与已遗忘', 'ledger.refresh': '刷新',
    'ledger.thId': 'ULID', 'ledger.thKind': '类型', 'ledger.thContent': '正文',
    'ledger.thSubject': '主语', 'ledger.thConfidence': '置信度',
    'ledger.thValidFrom': '生效时间', 'ledger.thStatus': '状态', 'ledger.thActions': '操作',
    'audit.title': '审计链', 'audit.sub': '不可篡改的操作日志 · 取代链',
    'audit.id': '记忆 ID', 'audit.idPh': '从台账粘贴一个 ULID', 'audit.trace': '追踪',
    'ops.runtime': '运行诊断', 'ops.runtimeSub': '服务状态 · 不读取记忆正文',
    'ops.mcpTitle': 'MCP 接入', 'ops.mcpSub': '哪个 AI Agent 正在通过 MCP 使用这个记忆库',
    'ops.thMcpStatus': '状态', 'ops.thMcpClient': 'AI Agent', 'ops.thMcpVersion': '版本',
    'ops.thMcpProtocol': '协议', 'ops.thMcpPid': 'PID', 'ops.thMcpCalls': '调用',
    'ops.thMcpLastTool': '最后工具', 'ops.thMcpLastSeen': '最后活动',
    'ops.mcpEmpty': '还没有 MCP 客户端连接',
    'ops.mcpHint': 'MCP 是 stdio，一个客户端一个进程；这里只记录握手与工具调用元数据，不记录记忆正文或查询。',
    'mcp.online': '在线', 'mcp.stale': '空闲/可能断开', 'mcp.closed': '已断开',
    'mcp.meta': '共 {total} 个会话 · {active} 个在线 · 进程退出或 5 分钟无活动标为断开/空闲',
    'ops.logTitle': '请求日志', 'ops.allLevels': '全部级别', 'ops.infoPlus': 'info 及以上',
    'ops.warnPlus': 'warn 及以上', 'ops.errorOnly': '仅 error',
    'ops.autoRefresh': '自动刷新（5 秒）', 'ops.refresh': '刷新',
    'ops.thTime': '时间', 'ops.thLevel': '级别', 'ops.thEvent': '事件', 'ops.thMethod': '方法',
    'ops.thPath': '路径', 'ops.thStatus': '状态码', 'ops.thMs': '耗时 (ms)', 'ops.thDetail': '详情',
    'ops.isolation': '多任务隔离', 'ops.isolationSub': '同一 Agent 多任务，记忆到底会不会串？',
    'ops.isoEmpty': '点击下方按钮运行检测', 'ops.runProbe': '运行隔离检测',
    'ops.isoHint': '只使用临时内存库，不读写你的数据。',
    'detail.title': '记忆详情', 'detail.copy': '复制 ID', 'detail.edit': '编辑', 'detail.forget': '遗忘', 'detail.view': '详情',
    'edit.title': '编辑记忆', 'edit.content': '正文', 'edit.kind': '类型（Kind）',
    'edit.subject': '主语（Subject）', 'edit.confidence': '置信度', 'edit.tags': '标签（逗号分隔）',
    'edit.pin': '钉选', 'edit.hint': '保存会创建新版本，旧版本保留在历史里。',
    'edit.cancel': '取消', 'edit.save': '保存新版本',
    'common.loading': '加载中…',
    'auth.required': '需要访问令牌：请用 http://<地址>/?token=<你的 MEMBRANE_TOKEN> 打开一次，之后会记住。',
    'ingest.contentRequired': '正文不能为空',
    'ingest.superseded': '↳ 已取代：{id}（{content}）',
    'recall.enterQuery': '请输入查询',
    'recall.running': '正在召回（{mode}模式）…',
    'recall.noMatch': '没有匹配的记忆',
    'recall.why': '为什么召回：{why}',
    'bd.text': '文本 RRF', 'bd.vec': '向量', 'bd.graph': '图路',
    'bd.freshness': '新鲜度', 'bd.age': '年龄', 'bd.halfLife': '半衰期',
    'bd.confidence': '置信度', 'bd.weights': '权重',
    'bd.ageValue': '{days} 天', 'bd.halfLifeValue': '{days} 天',
    'ledger.loading': '加载中…', 'ledger.none': '暂无记录',
    'status.active': '现行', 'status.superseded': '已取代', 'status.deleted': '已遗忘',
    'audit.enterId': '请输入记忆 ID', 'audit.none': '暂无审计记录',
    'audit.seq': '{time} · 序号 {seq}',
    'detail.loading': '加载中…', 'detail.notFound': '未找到这条记忆',
    'detail.kind': '类型', 'detail.subject': '主语', 'detail.namespace': '命名空间',
    'detail.confidence': '置信度', 'detail.validFrom': '生效时间', 'detail.validTo': '失效时间',
    'detail.pin': '钉选', 'detail.supersededBy': '被谁取代',
    'detail.yes': '是', 'detail.no': '否',
    'detail.tags': '标签', 'detail.entities': '实体', 'detail.relations': '关系',
    'detail.evidence': '证据', 'detail.audit': '审计链',
    'copy.ok': '已复制记忆 ID', 'copy.fail': '复制失败，请手动选中 ID',
    'edit.contentRequired': '正文不能为空', 'edit.saving': '正在保存新版本…',
    'confirm.forget': '确定遗忘这条记忆？会软删除，历史仍可 asOf 查到。',
    'toast.forgotten': '已遗忘（软删除）',
    'export.toast': '已导出 {memories} 条记忆 / {relations} 条关系',
    'ops.version': '版本', 'ops.uptime': '运行时长', 'ops.node': 'NODE 版本',
    'ops.platform': '平台', 'ops.schema': 'SCHEMA 版本', 'ops.dbSize': '数据库大小',
    'ops.memories': '记忆条数', 'ops.graph': '图结构', 'ops.llm': 'LLM 抽取',
    'ops.embedding': '向量模型', 'ops.bind': '监听地址', 'ops.auth': '认证',
    'ops.dbPath': '数据库路径', 'ops.logFile': '日志文件',
    'ops.active': '{n} 条现行', 'ops.entities': '{entities} 个实体 / {relations} 条关系',
    'ops.llmOn': '已配置', 'ops.llmOff': '未配置（纯全文检索）',
    'ops.embOn': '已配置', 'ops.embOff': '未配置',
    'ops.authOn': 'Bearer Token 已启用', 'ops.authOff': '仅本机访问', 'ops.memoryOnly': '仅内存',
    'logs.loading': '加载中…', 'logs.none': '暂无日志',
    'logs.filePrefix': '日志文件：{path}', 'logs.memoryOnly': '仅内存日志',
    'logs.meta': '显示 {shown} 条 · 缓冲 {buffered} 条 · 已写 {written} 条',
    'logs.fileError': ' · 文件错误：{err}', 'logs.path': ' · {path}', 'logs.memSuffix': ' · 仅内存',
    'iso.running': '正在运行内存隔离检测…',
    'iso.sharedHead': '同一 namespace（默认用法）',
    'iso.tasks': '命中 {hits} 条，涉及任务：{tasks}',
    'iso.mixed': '⚠️ 两个任务的记忆会互相召回 → 有串扰风险',
    'iso.noMix': '未发生串扰',
    'iso.separateHead': '每个任务独立 namespace',
    'iso.aHits': '任务A 命中 {hits} 条（{tasks}）',
    'iso.bHits': '任务B 命中 {hits} 条（{tasks}）',
    'iso.pass': '✅ 串扰 0 条（隔离成立）',
    'iso.leak': '❌ 串扰 {n} 条',
    'iso.note': '同一 namespace 下任务记忆会互相召回；给每个任务独立 namespace 后串扰为 0。需要共享知识时，单独查 shared namespace 再合并，不要让任务记忆和共享记忆混住。',
  },
  en: {
    'page.title': 'Membrane · Memory Engine Console',
    'brand.sub': 'MEMORY ENGINE',
    'nav.overview': 'Overview', 'nav.ingest': 'Ingest', 'nav.recall': 'Recall',
    'nav.ledger': 'Ledger', 'nav.audit': 'Audit Trail', 'nav.ops': 'Ops / Admin',
    'title.overview': 'Overview', 'title.ingest': 'Ingest Pipeline', 'title.recall': 'Hybrid Recall',
    'title.ledger': 'Memory Ledger', 'title.audit': 'Audit Trail', 'title.ops': 'Ops / Admin',
    'status.online': 'Engine Online', 'status.dbFallback': 'Local database',
    'export.backup': '↓ Export backup',
    'eyebrow': 'TEMPORAL · LOCAL-FIRST · EXPLAINABLE',
    'mode.title': 'Controls recall verbosity: fewer Token, fewer fields',
    'mode.ultra': 'Token saver', 'mode.brief': 'Balanced', 'mode.full': 'Full',
    'mode.hint': 'FTS5 BM25 + RRF + temporal decay · {mode} mode: {hint}',
    'mode.hint.ultra': 'id + content + score only; cheapest',
    'mode.hint.brief': 'adds kind / subject / time / evidence count; recommended',
    'mode.hint.full': 'full why + five-way score breakdown; debugging only (~4x cost)',
    'health.ok': '● Online', 'health.offline': '● Offline',
    'overview.total': 'TOTAL RECORDS', 'overview.totalHint': 'all revisions',
    'overview.current': 'ACTIVE', 'overview.superseded': 'SUPERSEDED',
    'overview.supersededHint': 'replaced versions', 'overview.deleted': 'TOMBSTONES',
    'overview.deletedHint': 'soft-deleted', 'overview.entities': 'ENTITIES',
    'overview.entitiesHint': 'graph nodes', 'overview.relations': 'RELATIONS', 'overview.relationsHint': 'graph edges',
    'overview.kindDist': 'Distribution by Kind', 'overview.kindSub': 'memory taxonomy',
    'overview.features': 'Engine Signature', 'overview.featuresSub': 'differentiators',
    'feature.bitemporal': 'Bi-temporal Model', 'feature.explain': 'Explainable Recall',
    'feature.explainValue': 'RRF fusion · 5-component score breakdown · why',
    'feature.zero': 'Zero Dependency', 'feature.zeroValue': 'node:sqlite · no telemetry · single file',
    'feature.modes': 'Token Modes', 'feature.modesValue': 'Token saver / Balanced / Full — pick per workflow',
    'ingest.title': 'Ingest Pipeline', 'ingest.sub': 'deduplicate → conflict detection → commit',
    'ingest.content': 'Content', 'ingest.contentPh': 'e.g. The user lives in Shanghai',
    'ingest.kind': 'Kind', 'ingest.subject': 'Subject', 'ingest.subjectPh': 'user',
    'ingest.namespace': 'Namespace', 'ingest.namespacePh': 'default',
    'ingest.confidence': 'Confidence', 'ingest.tags': 'Tags (comma)', 'ingest.tagsPh': 'address, city',
    'ingest.pin': 'Pin (exempt from auto-supersede)', 'ingest.commit': 'Commit Memory',
    'ingest.id': 'ID: {id}',
    'status.added': 'ADDED', 'status.duplicate': 'DUPLICATE (not stored)', 'status.keptBoth': 'KEPT BOTH (needs review)',
    'ingest.note.created': 'Memory stored.',
    'ingest.note.duplicate': 'Duplicate content; nothing new stored.',
    'ingest.note.superseded': 'Memory stored; superseded {n} old memories.',
    'ingest.note.keptBoth': 'Memory stored; kept {n} conflicting memories for review.',
    'op.add': 'ADD', 'op.update': 'UPDATE', 'op.supersede': 'SUPERSEDE', 'op.delete': 'FORGET',
    'edit.onlyActive': 'only active versions can be edited', 'edit.duplicate': 'unchanged — no new version created',
    'edit.saved': 'new version saved; the old one stays in history',
    'time.sec': 's', 'time.min': 'm', 'time.hour': 'h',
    'kind.fact': 'fact', 'kind.episode': 'episode', 'kind.preference': 'preference', 'kind.procedure': 'procedure',
    'kind.all': 'all', 'kind.allKinds': 'all kinds',
    'recall.title': 'Hybrid Recall', 'recall.queryPh': 'Query, e.g. where does the user live',
    'recall.search': 'Search', 'recall.kind': 'Filter kind', 'recall.namespace': 'Namespace',
    'recall.namespacePh': 'default', 'recall.limit': 'Limit',
    'recall.asof': 'asOf (historical snapshot)', 'recall.asofPh': 'unix ms',
    'ledger.title': 'Memory Ledger', 'ledger.namespacePh': 'namespace',
    'ledger.includeAll': 'include superseded & tombstones', 'ledger.refresh': 'Refresh',
    'ledger.thId': 'ULID', 'ledger.thKind': 'Kind', 'ledger.thContent': 'Content',
    'ledger.thSubject': 'Subject', 'ledger.thConfidence': 'Conf',
    'ledger.thValidFrom': 'Valid From', 'ledger.thStatus': 'Status', 'ledger.thActions': 'Actions',
    'audit.title': 'Audit Trail', 'audit.sub': 'immutable operation log · supersession chain',
    'audit.id': 'Memory ID', 'audit.idPh': 'paste a ULID from the ledger', 'audit.trace': 'Trace',
    'ops.runtime': 'Runtime Diagnostics', 'ops.runtimeSub': 'service status · never reads memory content',
    'ops.mcpTitle': 'MCP Connections', 'ops.mcpSub': 'Which AI agents are using this memory store over MCP',
    'ops.thMcpStatus': 'Status', 'ops.thMcpClient': 'AI Agent', 'ops.thMcpVersion': 'Version',
    'ops.thMcpProtocol': 'Protocol', 'ops.thMcpPid': 'PID', 'ops.thMcpCalls': 'Calls',
    'ops.thMcpLastTool': 'Last tool', 'ops.thMcpLastSeen': 'Last seen',
    'ops.mcpEmpty': 'No MCP clients have connected yet',
    'ops.mcpHint': 'MCP uses stdio: one client per process. Only handshake and tool-call metadata are recorded; memory content and queries are never stored here.',
    'mcp.online': 'Online', 'mcp.stale': 'Idle / possibly gone', 'mcp.closed': 'Closed',
    'mcp.meta': '{total} sessions · {active} online · closed when the process exits; idle after 5 min without activity',
    'ops.logTitle': 'Request Log', 'ops.allLevels': 'all levels', 'ops.infoPlus': 'info+',
    'ops.warnPlus': 'warn+', 'ops.errorOnly': 'error only',
    'ops.autoRefresh': 'auto refresh (5s)', 'ops.refresh': 'Refresh',
    'ops.thTime': 'Time', 'ops.thLevel': 'Level', 'ops.thEvent': 'Event', 'ops.thMethod': 'Method',
    'ops.thPath': 'Path', 'ops.thStatus': 'Status', 'ops.thMs': 'ms', 'ops.thDetail': 'Detail',
    'ops.isolation': 'Multi-task Isolation', 'ops.isolationSub': 'Will an agent running multiple tasks mix memories?',
    'ops.isoEmpty': 'Run the probe to see', 'ops.runProbe': 'Run isolation probe',
    'ops.isoHint': 'Uses a temporary in-memory database only; never touches your data.',
    'detail.title': 'Memory Detail', 'detail.copy': 'Copy ID', 'detail.edit': 'Edit', 'detail.forget': 'Forget', 'detail.view': 'Details',
    'edit.title': 'Edit Memory', 'edit.content': 'Content', 'edit.kind': 'Kind',
    'edit.subject': 'Subject', 'edit.confidence': 'Confidence', 'edit.tags': 'Tags (comma)',
    'edit.pin': 'Pin', 'edit.hint': 'Saving creates a new version; the old version stays in history.',
    'edit.cancel': 'Cancel', 'edit.save': 'Save new version',
    'common.loading': 'loading…',
    'auth.required': 'Access token required: open once with http://<host>/?token=<your MEMBRANE_TOKEN>; it will be remembered.',
    'ingest.contentRequired': 'content required',
    'ingest.superseded': '↳ superseded: {id} ({content})',
    'recall.enterQuery': 'enter a query to begin',
    'recall.running': 'running {mode} recall…',
    'recall.noMatch': 'no matching memories',
    'recall.why': 'why: {why}',
    'bd.text': 'RRF text', 'bd.vec': 'vec', 'bd.graph': 'graph',
    'bd.freshness': 'freshness', 'bd.age': 'age', 'bd.halfLife': 'half-life',
    'bd.confidence': 'confidence', 'bd.weights': 'weights',
    'bd.ageValue': '{days}d', 'bd.halfLifeValue': '{days}d',
    'ledger.loading': 'loading…', 'ledger.none': 'no records',
    'status.active': 'ACTIVE', 'status.superseded': 'SUPERSEDED', 'status.deleted': 'TOMBSTONE',
    'audit.enterId': 'enter a memory id', 'audit.none': 'no audit entries',
    'audit.seq': '{time} · seq {seq}',
    'detail.loading': 'loading…', 'detail.notFound': 'not found',
    'detail.kind': 'kind', 'detail.subject': 'subject', 'detail.namespace': 'namespace',
    'detail.confidence': 'confidence', 'detail.validFrom': 'valid from', 'detail.validTo': 'valid to',
    'detail.pin': 'pin', 'detail.supersededBy': 'superseded by',
    'detail.yes': 'yes', 'detail.no': 'no',
    'detail.tags': 'Tags', 'detail.entities': 'Entities', 'detail.relations': 'Relations',
    'detail.evidence': 'Evidence', 'detail.audit': 'Audit chain',
    'copy.ok': 'id copied', 'copy.fail': 'copy failed — select it manually',
    'edit.contentRequired': 'content required', 'edit.saving': 'saving new version…',
    'confirm.forget': 'Forget this memory? It is soft-deleted; history remains queryable via asOf.',
    'toast.forgotten': 'Forgotten (soft-deleted)',
    'export.toast': 'Exported {memories} memories / {relations} relations',
    'ops.version': 'VERSION', 'ops.uptime': 'UPTIME', 'ops.node': 'NODE',
    'ops.platform': 'PLATFORM', 'ops.schema': 'SCHEMA', 'ops.dbSize': 'DB SIZE',
    'ops.memories': 'MEMORIES', 'ops.graph': 'GRAPH', 'ops.llm': 'LLM',
    'ops.embedding': 'EMBEDDING', 'ops.bind': 'BIND', 'ops.auth': 'AUTH',
    'ops.dbPath': 'DB PATH', 'ops.logFile': 'LOG FILE',
    'ops.active': '{n} active', 'ops.entities': '{entities} entities / {relations} edges',
    'ops.llmOn': 'configured', 'ops.llmOff': 'off (pure FTS)',
    'ops.embOn': 'configured', 'ops.embOff': 'off',
    'ops.authOn': 'Bearer token on', 'ops.authOff': 'local only', 'ops.memoryOnly': 'memory only',
    'logs.loading': 'loading…', 'logs.none': 'no log entries yet',
    'logs.filePrefix': 'log file: {path}', 'logs.memoryOnly': 'memory-only logging',
    'logs.meta': 'showing {shown} · buffered {buffered} · written {written}',
    'logs.fileError': ' · file error: {err}', 'logs.path': ' · {path}', 'logs.memSuffix': ' · memory only',
    'iso.running': 'running in-memory probe…',
    'iso.sharedHead': 'Same namespace (default usage)',
    'iso.tasks': '{hits} hits, tasks: {tasks}',
    'iso.mixed': '⚠️ Task memories are recalled together → cross-talk risk',
    'iso.noMix': 'No cross-talk',
    'iso.separateHead': 'Separate namespace per task',
    'iso.aHits': 'Task A: {hits} hits ({tasks})',
    'iso.bHits': 'Task B: {hits} hits ({tasks})',
    'iso.pass': '✅ 0 cross-talk (isolation holds)',
    'iso.leak': '❌ {n} leaked hits',
    'iso.note': 'Task memories in one namespace are recalled together; separate namespaces produce zero cross-talk. For shared knowledge, use a dedicated shared namespace and merge results in the application.',
  },
};
let lang = localStorage.getItem('membrane.lang');
if (!lang || !I18N[lang]) lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
function t(key, vars = {}) {
  const table = I18N[lang] || I18N.zh;
  const text = table[key] ?? I18N.zh[key] ?? key;
  return String(text).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

const KIND_COLORS = { fact: '#7aa2ff', episode: '#b18cff', preference: '#5ee6c0', procedure: '#f5c26b' };
const KINDS = ['fact', 'episode', 'preference', 'procedure'];
const KIND_LABELS = { fact: 'fact', episode: 'episode', preference: 'preference', procedure: 'procedure' };
const STATUS_LABEL_KEYS = {
  created: 'status.added', added: 'status.added', duplicate: 'status.duplicate', superseded: 'status.superseded',
  'kept-both': 'status.keptBoth', active: 'status.active', deleted: 'status.deleted',
};
const OP_LABEL_KEYS = { add: 'op.add', update: 'op.update', supersede: 'op.supersede', delete: 'op.delete', forget: 'op.delete' };
const kindLabel = (k) => t('kind.' + (KIND_LABELS[k] || k)) === 'kind.' + (KIND_LABELS[k] || k) ? k : t('kind.' + (KIND_LABELS[k] || k));
const statusLabel = (s) => STATUS_LABEL_KEYS[String(s || '').toLowerCase()] ? t(STATUS_LABEL_KEYS[String(s || '').toLowerCase()]) : s;
const opLabel = (op) => OP_LABEL_KEYS[String(op || '').toLowerCase()] ? t(OP_LABEL_KEYS[String(op || '').toLowerCase()]) : String(op || '').toUpperCase();

// Token 三模式：召回返回的详细度 + 默认条数。存在 localStorage，刷新后保持。
const MODES = {
  ultra: { detail: 'ultra', limit: 3, key: 'ultra' },
  brief: { detail: 'brief', limit: 8, key: 'brief' },
  full:  { detail: 'full', limit: 8, key: 'full' },
};
const state = {
  mode: localStorage.getItem('membrane.mode') || 'brief',
  detailId: null,
  detailRecord: null,
  lastRecallResults: null,
  lastIsolation: null,
};

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem('membrane.token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (r.status === 401) throw new Error(t('auth.required'));
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

// ---- 视图切换 ----
const VIEWS = ['overview', 'ingest', 'recall', 'ledger', 'audit', 'ops'];
function showView(v) {
  if (!VIEWS.includes(v)) v = 'overview';
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.add('hidden'));
  $('view-' + v).classList.remove('hidden');
  $('view-title').textContent = t('title.' + v);
  if (v !== 'ops' && state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; $('log-auto').checked = false; }
  if (v === 'overview') loadStats();
  if (v === 'ledger') loadLedger();
  if (v === 'ops') loadOps();
  history.replaceState(null, '', '#' + v);
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ---- Token 模式 ----
function applyMode(mode) {
  if (!MODES[mode]) mode = 'brief';
  state.mode = mode;
  localStorage.setItem('membrane.mode', mode);
  document.querySelectorAll('#mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('rc-limit').value = MODES[mode].limit;
  $('recall-mode-hint').textContent = t('mode.hint', {
    mode: t('mode.' + MODES[mode].key),
    hint: t('mode.hint.' + MODES[mode].key),
  });
}
document.querySelectorAll('#mode-switch button').forEach(b => {
  b.addEventListener('click', () => applyMode(b.dataset.mode));
});

// ---- 中英双语 ----
function applyStaticLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('page.title');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    // 实际库路径由 loadStats 填；只有仍显示兜底文案时才允许静态翻译覆盖
    if (el.id === 'db-path' &&
        el.textContent !== I18N.zh['status.dbFallback'] &&
        el.textContent !== I18N.en['status.dbFallback']) return;
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.setAttribute('placeholder', t(el.dataset.i18nPh));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  document.querySelectorAll('#lang-switch button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
}

function refreshLocalizedViews() {
  const active = document.querySelector('.nav-item.active')?.dataset.view;
  if (active) $('view-title').textContent = t('title.' + active);
  // 顶栏不是某个视图的专属区域：切语言时也要跟着换，否则会中英混排
  const chip = $('health-chip');
  if (chip) chip.textContent = t(chip.classList.contains('err') ? 'health.offline' : 'health.ok');
  const db = $('db-path');
  if (db && (db.textContent === I18N.zh['status.dbFallback'] || db.textContent === I18N.en['status.dbFallback'])) {
    db.textContent = t('status.dbFallback');
  }
  if (active === 'overview') loadStats();
  if (active === 'ledger') loadLedger();
  if (active === 'ops') loadOps();
  if (state.lastRecallResults) renderRecallResults();
  if (state.lastIsolation) renderIsolation(state.lastIsolation);
  if (state.detailId && !$('detail-modal').classList.contains('hidden')) openDetail(state.detailId);
}

function setLanguage(next, refresh = true) {
  if (!I18N[next]) return;
  lang = next;
  localStorage.setItem('membrane.lang', lang);
  applyStaticLanguage();
  applyMode(state.mode);
  if (refresh) refreshLocalizedViews();
}
document.querySelectorAll('#lang-switch button').forEach(b => {
  b.addEventListener('click', () => setLanguage(b.dataset.lang));
});

// ---- Overview ----
async function loadStats() {
  try {
    const h = await api('/api/health');
    $('health-chip').textContent = t('health.ok');
    $('health-chip').classList.remove('err');
    $('db-path').textContent = h.db || t('status.dbFallback');
    if (h.version) $('version-chip').textContent = 'v' + h.version;
  } catch (e) {
    $('health-chip').textContent = t('health.offline');
    $('health-chip').classList.add('err');
    return;
  }
  const s = await api('/api/stats');
  $('s-total').textContent = s.total;
  $('s-current').textContent = s.current;
  $('s-superseded').textContent = s.superseded;
  $('s-deleted').textContent = s.deleted;
  $('s-entities').textContent = s.entities ?? '—';
  $('s-relations').textContent = s.relations ?? '—';
  const max = Math.max(1, ...KINDS.map(k => s.byKind[k] || 0));
  $('kind-bars').innerHTML = KINDS.map(k => {
    const n = s.byKind[k] || 0;
    const pct = (n / max) * 100;
    return `<div class="kind-row"><div class="kind-name">${kindLabel(k)}</div><div class="kind-track"><div class="kind-fill" style="width:${pct}%;background:${KIND_COLORS[k]}"></div></div><div class="kind-count">${n}</div></div>`;
  }).join('');
}

// ---- Ingest ----
$('btn-ingest').addEventListener('click', async () => {
  const body = {
    content: $('in-content').value.trim(),
    kind: $('in-kind').value,
    subject: $('in-subject').value.trim() || undefined,
    namespace: $('in-namespace').value.trim() || undefined,
    tags: $('in-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    confidence: Number($('in-conf').value),
    pin: $('in-pin').checked,
  };
  const box = $('ingest-result');
  box.classList.remove('hidden');
  if (!body.content) { box.innerHTML = `<span class="err">${esc(t('ingest.contentRequired'))}</span>`; return; }
  try {
    const r = await api('/api/memories', { method: 'POST', body });
    const sup = (r.superseded || []).map(m => `<div>${esc(t('ingest.superseded', { id: m.id, content: m.content }))}</div>`).join('');
    let noteKey = 'ingest.note.created';
    if (r.status === 'duplicate') noteKey = 'ingest.note.duplicate';
    else if (r.status === 'kept-both') noteKey = 'ingest.note.keptBoth';
    else if (r.status === 'superseded') noteKey = 'ingest.note.superseded';
    box.innerHTML = `<div class="status-tag">${esc(statusLabel(r.status))}</div><div>${esc(t(noteKey, { n: (r.superseded || []).length }))}</div><div style="margin-top:6px;color:var(--violet)">${esc(t('ingest.id', { id: r.memory.id }))}</div>${sup}`;
    loadStats();
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

// ---- Recall ----
$('rc-asof-toggle').addEventListener('change', e => $('rc-asof-wrap').classList.toggle('hidden', !e.target.checked));
async function doRecall() {
  const mode = MODES[state.mode];
  const body = {
    query: $('rc-query').value.trim(),
    limit: Number($('rc-limit').value) || mode.limit,
    detail: mode.detail,
  };
  if ($('rc-kind').value) body.kind = $('rc-kind').value;
  if ($('rc-namespace').value.trim()) body.namespace = $('rc-namespace').value.trim();
  if ($('rc-asof-toggle').checked && $('rc-asof').value) body.asOf = Number($('rc-asof').value);
  const box = $('recall-results');
  if (!body.query) { box.innerHTML = `<div class="empty">${esc(t('recall.enterQuery'))}</div>`; return; }
  box.innerHTML = `<div class="empty">${esc(t('recall.running', { mode: t('mode.' + mode.key) }))}</div>`;
  try {
    const r = await api('/api/recall', { method: 'POST', body });
    state.lastRecallResults = r.results;
    if (!r.results.length) { box.innerHTML = `<div class="empty">${esc(t('recall.noMatch'))}</div>`; return; }
    renderRecallResults();
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

function renderRecallResults() {
  const box = $('recall-results');
  if (!state.lastRecallResults) return;
  box.innerHTML = state.lastRecallResults.map((h, i) => renderHit(h, i)).join('');
}

function renderHit(h, i) {
  // ultra 只有 id/content/score；brief 是扁平的 id/kind/content/subject/score；full 才有 memory/why/breakdown
  const m = h.memory || { id: h.id, content: h.content, kind: h.kind || '—', subject: h.subject || null };
  const b = h.breakdown;
  const actions = `<div class="hit-actions"><button class="btn tiny" data-detail="${esc(m.id)}">${esc(t('detail.view'))}</button></div>`;
  const meta = h.memory || h.kind
    ? `<span class="hit-kind">${esc(kindLabel(m.kind))}</span><span class="hit-subject">${esc(m.subject || '—')}</span>`
    : `<span class="hit-kind">${esc(t('mode.ultra'))}</span>`;
  const why = h.why ? `<div class="hit-why">${esc(t('recall.why', { why: h.why }))}</div>` : '';
  const bd = b ? `<div class="breakdown">
      <span class="bd-item">${esc(t('bd.text'))} <b>${b.rrfText.toFixed(4)}</b></span>
      <span class="bd-item">${esc(t('bd.vec'))} <b>${b.rrfVec.toFixed(3)}</b></span>
      <span class="bd-item">${esc(t('bd.graph'))} <b>${b.rrfGraph.toFixed(3)}</b></span>
      <span class="bd-item">${esc(t('bd.freshness'))} <b>${b.freshness.toFixed(4)}</b></span>
      <span class="bd-item">${esc(t('bd.age'))} <b>${esc(t('bd.ageValue', { days: b.ageDays }))}</b></span>
      <span class="bd-item">${esc(t('bd.halfLife'))} <b>${esc(t('bd.halfLifeValue', { days: b.halfLifeDays }))}</b></span>
      <span class="bd-item">${esc(t('bd.confidence'))} <b>${b.confidence}</b></span>
      <span class="bd-item">${esc(t('bd.weights'))} <b>${b.weights.text}/${b.weights.vec}/${b.weights.time}/${b.weights.conf}/${b.weights.graph}</b></span>
    </div>` : '';
  return `<div class="hit">
    <div class="hit-top"><span class="hit-score">#${i + 1} · ${Number(h.score).toFixed(4)}</span>${meta}${actions}</div>
    <div class="hit-content">${esc(m.content)}</div>
    ${why}${bd}
  </div>`;
}
$('btn-recall').addEventListener('click', doRecall);
$('rc-query').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall(); });

// ---- Ledger ----
async function loadLedger() {
  const params = new URLSearchParams({ validity: $('ld-all').checked ? 'all' : 'current', limit: '200' });
  if ($('ld-kind').value) params.set('kind', $('ld-kind').value);
  if ($('ld-namespace').value.trim()) params.set('namespace', $('ld-namespace').value.trim());
  const tbody = document.querySelector('#ledger-table tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('ledger.loading'))}</td></tr>`;
  try {
    const rows = await api('/api/memories?' + params.toString());
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('ledger.none'))}</td></tr>`; return; }
    tbody.innerHTML = rows.map(m => {
      let status = `<span class="badge active">${esc(t('status.active'))}</span>`;
      if (m.deleted) status = `<span class="badge del">${esc(t('status.deleted'))}</span>`;
      else if (m.validTo) status = `<span class="badge sup">${esc(t('status.superseded'))}</span>`;
      const date = new Date(m.validFrom).toISOString().replace('T', ' ').slice(0, 16);
      return `<tr>
        <td class="mono">${esc(m.id.slice(0, 12))}…</td>
        <td>${esc(kindLabel(m.kind))}</td>
        <td class="content-cell">${esc(m.content)}</td>
        <td>${esc(m.subject || '—')}</td>
        <td>${m.confidence}</td>
        <td class="mono">${date}</td>
        <td>${status}</td>
        <td class="row-actions">
          <button class="btn tiny" data-detail="${esc(m.id)}">${esc(t('detail.view'))}</button>
          <button class="btn tiny" data-edit="${esc(m.id)}" ${m.deleted || m.validTo ? 'disabled' : ''}>${esc(t('detail.edit'))}</button>
          <button class="btn tiny danger" data-forget="${esc(m.id)}" ${m.deleted ? 'disabled' : ''}>${esc(t('detail.forget'))}</button>
        </td></tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty err">${esc(e.message)}</td></tr>`;
  }
}
$('ld-all').addEventListener('change', loadLedger);
$('btn-ld-refresh').addEventListener('click', loadLedger);
$('ld-kind').addEventListener('change', loadLedger);
$('ld-namespace').addEventListener('keydown', e => { if (e.key === 'Enter') loadLedger(); });

// ---- Audit ----
$('btn-audit').addEventListener('click', async () => {
  const id = $('au-id').value.trim();
  const box = $('audit-results');
  if (!id) { box.innerHTML = `<div class="empty">${esc(t('audit.enterId'))}</div>`; return; }
  try {
    const entries = await api(`/api/memories/${encodeURIComponent(id)}/history`);
    if (!entries.length) { box.innerHTML = `<div class="empty">${esc(t('audit.none'))}</div>`; return; }
    box.innerHTML = renderHistory(entries);
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
});

function renderHistory(entries) {
  return '<div class="timeline">' + entries.map(e => {
    const time = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    return `<div class="tl-item"><span class="tl-op">${esc(opLabel(e.op))}</span><span class="tl-time">${esc(t('audit.seq', { time, seq: e.seq }))}</span><div class="tl-detail">${esc(e.detail || '')}</div></div>`;
  }).join('') + '</div>';
}

// ---- 详情 / 编辑 / 遗忘 ----
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-detail],[data-edit],[data-forget],[data-close]');
  if (!row) return;
  if (row.dataset.close) return closeModal(row.dataset.close);
  if (row.dataset.detail) return openDetail(row.dataset.detail);
  if (row.dataset.edit) return openEdit(row.dataset.edit);
  if (row.dataset.forget) return forgetMemory(row.dataset.forget);
});
document.querySelectorAll('.modal').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
});

function closeModal(id) { $(id).classList.add('hidden'); }
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2600);
}

async function openDetail(id) {
  state.detailId = id;
  const body = $('detail-body');
  body.innerHTML = `<div class="empty">${esc(t('detail.loading'))}</div>`;
  $('detail-modal').classList.remove('hidden');
  try {
    const m = await api(`/api/memories/${encodeURIComponent(id)}`);
    if (!m) { body.innerHTML = `<div class="empty">${esc(t('detail.notFound'))}</div>`; return; }
    state.detailRecord = m;
    const [history, evidence, entities] = await Promise.all([
      api(`/api/memories/${encodeURIComponent(id)}/history`).catch(() => []),
      api(`/api/memories/${encodeURIComponent(id)}/evidence`).catch(() => []),
      api(`/api/entities?memoryId=${encodeURIComponent(id)}`).then(x => x.entities).catch(() => []),
    ]);
    let relations = [];
    if (m.subject) {
      relations = await api(`/api/relations?a=${encodeURIComponent(m.subject)}&limit=20`)
        .then(x => x.relations).catch(() => []);
    }
    const status = m.deleted ? `<span class="badge del">${esc(t('status.deleted'))}</span>`
      : m.validTo ? `<span class="badge sup">${esc(t('status.superseded'))}</span>` : `<span class="badge active">${esc(t('status.active'))}</span>`;
    const tags = (m.tags || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join(' ') || '—';
    const entChips = entities.map(x => `<span class="tag">${esc(x.name)} <em>${esc(x.type)}</em></span>`).join(' ') || '—';
    const relList = relations.map(r => `<div class="mini-row">${esc(r.sentence)} <span class="muted">${esc(r.fromType)} → ${esc(r.toType)}</span></div>`).join('') || '<div class="muted">—</div>';
    const evList = evidence.map(x => `<div class="mini-row">“${esc(x.quote)}” <span class="muted">${new Date(x.at).toISOString().slice(0, 19).replace('T', ' ')}</span></div>`).join('') || '<div class="muted">—</div>';
    body.innerHTML = `
      <div class="detail-status">${status}<span class="mono muted">${esc(m.id)}</span></div>
      <div class="detail-content">${esc(m.content)}</div>
      <div class="detail-grid">
        <div><span class="k">${esc(t('detail.kind'))}</span><b>${esc(kindLabel(m.kind))}</b></div>
        <div><span class="k">${esc(t('detail.subject'))}</span><b>${esc(m.subject || '—')}</b></div>
        <div><span class="k">${esc(t('detail.namespace'))}</span><b>${esc(m.namespace || 'default')}</b></div>
        <div><span class="k">${esc(t('detail.confidence'))}</span><b>${m.confidence}</b></div>
        <div><span class="k">${esc(t('detail.validFrom'))}</span><b>${new Date(m.validFrom).toISOString().slice(0, 19).replace('T', ' ')}</b></div>
        <div><span class="k">${esc(t('detail.validTo'))}</span><b>${m.validTo ? new Date(m.validTo).toISOString().slice(0, 19).replace('T', ' ') : '—'}</b></div>
        <div><span class="k">${esc(t('detail.pin'))}</span><b>${m.pin ? esc(t('detail.yes')) : esc(t('detail.no'))}</b></div>
        <div><span class="k">${esc(t('detail.supersededBy'))}</span><b class="mono">${esc(m.supersededBy || '—')}</b></div>
      </div>
      <div class="detail-section"><h3>${esc(t('detail.tags'))}</h3><div>${tags}</div></div>
      <div class="detail-section"><h3>${esc(t('detail.entities'))}</h3><div>${entChips}</div></div>
      <div class="detail-section"><h3>${esc(t('detail.relations'))}</h3>${relList}</div>
      <div class="detail-section"><h3>${esc(t('detail.evidence'))}</h3>${evList}</div>
      <div class="detail-section"><h3>${esc(t('detail.audit'))}</h3>${history.length ? renderHistory(history) : '<div class="muted">—</div>'}</div>`;
    $('btn-detail-edit').disabled = !!m.deleted || !!m.validTo;
    $('btn-detail-forget').disabled = !!m.deleted;
  } catch (e) {
    body.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
  }
}

$('btn-detail-copy').addEventListener('click', async () => {
  if (!state.detailId) return;
  try { await navigator.clipboard.writeText(state.detailId); toast(t('copy.ok')); }
  catch { toast(t('copy.fail'), true); }
});

async function openEdit(id) {
  try {
    const m = state.detailRecord && state.detailRecord.id === id
      ? state.detailRecord
      : await api(`/api/memories/${encodeURIComponent(id)}`);
    if (!m || m.deleted || m.validTo) { toast(t('edit.onlyActive'), true); return; }
    state.detailId = id;
    state.detailRecord = m;
    $('ed-content').value = m.content;
    $('ed-kind').value = m.kind;
    $('ed-subject').value = m.subject || '';
    $('ed-conf').value = m.confidence;
    $('ed-tags').value = (m.tags || []).join(', ');
    $('ed-pin').checked = !!m.pin;
    $('edit-result').classList.add('hidden');
    closeModal('detail-modal');
    $('edit-modal').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
}
$('btn-detail-edit').addEventListener('click', () => state.detailId && openEdit(state.detailId));

$('btn-edit-save').addEventListener('click', async () => {
  if (!state.detailId) return;
  const body = {
    content: $('ed-content').value.trim(),
    kind: $('ed-kind').value,
    subject: $('ed-subject').value.trim() || null,
    confidence: Number($('ed-conf').value),
    tags: $('ed-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    pin: $('ed-pin').checked,
  };
  const box = $('edit-result');
  box.classList.remove('hidden');
  if (!body.content) { box.innerHTML = `<span class="err">${esc(t('edit.contentRequired'))}</span>`; return; }
  box.innerHTML = `<span class="muted">${esc(t('edit.saving'))}</span>`;
  try {
    const r = await api(`/api/memories/${encodeURIComponent(state.detailId)}`, { method: 'PATCH', body });
    toast(r.status === 'duplicate' ? t('edit.duplicate') : t('edit.saved'));
    closeModal('edit-modal');
    loadLedger();
    loadStats();
    if (r.memory) openDetail(r.memory.id);
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

async function forgetMemory(id) {
  if (!confirm(t('confirm.forget'))) return;
  try {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModal('detail-modal');
    toast(t('toast.forgotten'));
    loadLedger();
    loadStats();
  } catch (e) { toast(e.message, true); }
}
$('btn-detail-forget').addEventListener('click', () => state.detailId && forgetMemory(state.detailId));

// ---- 导出备份 ----
$('btn-export').addEventListener('click', async () => {
  try {
    const bundle = await api('/api/export');
    const text = JSON.stringify(bundle, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `membrane-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('export.toast', { memories: bundle.memories.length, relations: bundle.relations.length }));
  } catch (e) { toast(e.message, true); }
});

// ---- 工具 ----
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- Ops / Admin ----
function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + t('time.sec');
  const min = Math.floor(s / 60);
  if (min < 60) return min + t('time.min') + ' ' + (s % 60) + t('time.sec');
  return Math.floor(min / 60) + t('time.hour') + ' ' + (min % 60) + t('time.min');
}

async function loadOps() {
  await Promise.all([loadDiagnostics(), loadLogs(), loadMcpClients()]);
}

/** MCP 是 stdio：一个客户端一个进程，Ops 只读登记表，不读正文/查询 */
async function loadMcpClients() {
  const tbody = document.querySelector('#mcp-table tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('common.loading'))}</td></tr>`;
  try {
    const r = await api('/api/admin/mcp-clients?limit=50');
    const list = r.clients || [];
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('ops.mcpEmpty'))}</td></tr>`;
    } else {
      tbody.innerHTML = list.map((c) => {
        const state = c.state === 'active' ? 'active' : c.state === 'closed' ? 'closed' : 'stale';
        const badge = state === 'active' ? 'active' : state === 'closed' ? 'del' : 'sup';
        const label = t(state === 'active' ? 'mcp.online' : state === 'closed' ? 'mcp.closed' : 'mcp.stale');
        const when = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : '—';
        return `<tr>
          <td><span class="badge ${badge}">${esc(label)}</span></td>
          <td class="mono" title="${esc(c.cwd || '')}">${esc(c.clientName || 'unknown')}</td>
          <td class="mono">${esc(c.clientVersion || '—')}</td>
          <td class="mono">${esc(c.protocolVersion || '—')}</td>
          <td class="mono">${esc(c.pid ?? '—')}</td>
          <td class="mono">${esc(c.calls ?? 0)}</td>
          <td class="mono">${esc(c.lastTool || '—')}</td>
          <td class="mono">${esc(when)}</td>
        </tr>`;
      }).join('');
    }
    $('mcp-meta').textContent = t('mcp.meta', { total: r.total ?? list.length, active: r.active ?? 0 }) + ' ' + t('ops.mcpHint');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty err">${esc(e.message)}</td></tr>`;
  }
}

async function loadDiagnostics() {
  const box = $('ops-diag');
  try {
    const d = await api('/api/admin/diagnostics');
    const caps = d.capabilities || {};
    box.innerHTML = `
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.version'))}</span><b>${esc(d.version)}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.uptime'))}</span><b>${fmtDuration(d.uptimeMs)}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.node'))}</span><b>${esc(d.node)}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.platform'))}</span><b>${esc(d.platform)}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.schema'))}</span><b>v${d.db?.schemaVersion ?? '—'}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.dbSize'))}</span><b>${fmtBytes(d.db?.bytes)}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.memories'))}</span><b>${d.stats?.total ?? '—'} <small>${esc(t('ops.active', { n: d.stats?.current ?? '—' }))}</small></b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.graph'))}</span><b>${esc(t('ops.entities', { entities: d.stats?.entities ?? '—', relations: d.stats?.relations ?? '—' }))}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.llm'))}</span><b>${caps.llmConfigured ? esc(caps.extractionModel || t('ops.llmOn')) : esc(t('ops.llmOff'))}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.embedding'))}</span><b>${caps.embeddingConfigured ? esc(caps.embeddingModel || t('ops.embOn')) : esc(t('ops.embOff'))}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.bind'))}</span><b>${esc(d.security?.host || '—')}:${esc(d.security?.port ?? '—')}</b></div>
      <div class="diag-cell"><span class="diag-k">${esc(t('ops.auth'))}</span><b>${d.security?.tokenConfigured ? esc(t('ops.authOn')) : esc(t('ops.authOff'))}</b></div>
      <div class="diag-cell wide"><span class="diag-k">${esc(t('ops.dbPath'))}</span><b class="mono">${esc(d.db?.path || '—')}</b></div>
      <div class="diag-cell wide"><span class="diag-k">${esc(t('ops.logFile'))}</span><b class="mono">${esc(d.logging?.path || t('ops.memoryOnly'))}</b>${d.logging?.fileError ? ` <span class="err">${esc(d.logging.fileError)}</span>` : ''}</div>`;
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

async function loadLogs() {
  const tbody = document.querySelector('#log-table tbody');
  const level = $('log-level').value;
  const limit = Math.max(1, Math.min(500, Number($('log-limit').value) || 100));
  const q = new URLSearchParams({ limit: String(limit) });
  if (level) q.set('level', level);
  tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('logs.loading'))}</td></tr>`;
  try {
    const r = await api('/api/admin/logs?' + q.toString());
    if (!r.entries.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(t('logs.none'))}</td></tr>`;
      $('log-meta').textContent = r.logging?.path ? t('logs.filePrefix', { path: r.logging.path }) : t('logs.memoryOnly');
      return;
    }
    tbody.innerHTML = r.entries.slice().reverse().map(e => {
      const time = new Date(e.ts).toLocaleTimeString();
      const detail = Object.entries(e)
        .filter(([k]) => !['ts', 'level', 'event', 'method', 'path', 'status', 'ms'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
      const levelClass = e.level === 'error' ? 'del' : e.level === 'warn' ? 'sup' : 'active';
      return `<tr>
        <td class="mono">${esc(time)}</td>
        <td><span class="badge ${levelClass}">${esc(e.level)}</span></td>
        <td class="mono">${esc(e.event)}</td>
        <td class="mono">${esc(e.method || '—')}</td>
        <td class="mono content-cell" title="${esc(e.path || '')}">${esc(e.path || '—')}</td>
        <td class="mono">${esc(e.status ?? '—')}</td>
        <td class="mono">${esc(e.ms ?? '—')}</td>
        <td class="muted" title="${esc(detail)}">${esc(detail)}</td>
      </tr>`;
    }).join('');
    const lg = r.logging || {};
    $('log-meta').textContent = t('logs.meta', { shown: r.count, buffered: lg.buffered ?? '—', written: lg.written ?? '—' }) +
      (lg.fileError ? t('logs.fileError', { err: lg.fileError }) : '') + (lg.path ? t('logs.path', { path: lg.path }) : t('logs.memSuffix'));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty err">${esc(e.message)}</td></tr>`;
  }
}

async function runIsolationProbe() {
  const box = $('ops-isolation');
  box.innerHTML = `<div class="empty">${esc(t('iso.running'))}</div>`;
  try {
    const r = await api('/api/admin/isolation-check');
    state.lastIsolation = r;
    renderIsolation(r);
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

function renderIsolation(r) {
  const box = $('ops-isolation');
  const shared = r.sharedNamespace;
  const sep = r.separatedNamespaces;
  const taskName = (s) => lang === 'en' ? String(s).replace('任务A', 'Task A').replace('任务B', 'Task B') : String(s);
  box.innerHTML = `
      <div class="iso-row ${shared.mixed ? 'iso-warn' : 'iso-ok'}">
        <div class="iso-head">${esc(t('iso.sharedHead'))}</div>
        <div>${esc(t('iso.tasks', { hits: shared.hits, tasks: shared.tasks.map(taskName).join(', ') || '—' }))}</div>
        <div class="iso-verdict">${shared.mixed ? esc(t('iso.mixed')) : esc(t('iso.noMix'))}</div>
      </div>
      <div class="iso-row ${sep.pass ? 'iso-ok' : 'iso-warn'}">
        <div class="iso-head">${esc(t('iso.separateHead'))}</div>
        <div>${esc(t('iso.aHits', { hits: sep.taskA.hits, tasks: sep.taskA.tasks.map(taskName).join(', ') || '—' }))} · ${esc(t('iso.bHits', { hits: sep.taskB.hits, tasks: sep.taskB.tasks.map(taskName).join(', ') || '—' }))}</div>
        <div class="iso-verdict">${sep.pass ? esc(t('iso.pass')) : esc(t('iso.leak', { n: sep.leakage }))}</div>
      </div>
      <div class="hint">${esc(t('iso.note'))}</div>`;
}

$('btn-log-refresh').addEventListener('click', loadLogs);
$('btn-mcp-refresh').addEventListener('click', loadMcpClients);
$('log-level').addEventListener('change', loadLogs);
$('log-limit').addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(); });
$('log-auto').addEventListener('change', e => {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  if (e.target.checked) state.logTimer = setInterval(loadLogs, 5000);
});
$('btn-isolation').addEventListener('click', runIsolationProbe);

// ---- boot ----
// 令牌只提示一次：?token=xxx 存进 localStorage，然后从地址栏抹掉，避免截图/日志泄露
(() => {
  const q = new URLSearchParams(location.search);
  const tok = q.get('token');
  if (!tok) return;
  localStorage.setItem('membrane.token', tok);
  q.delete('token');
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
})();
setLanguage(lang, false);
const initialView = location.hash.slice(1);
const initialBtn = initialView ? document.querySelector(`.nav-item[data-view="${initialView}"]`) : null;
if (initialBtn) initialBtn.click();
else showView('overview');
