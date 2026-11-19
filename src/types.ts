/**
 * Membrane 全局类型定义：记忆模型 / 输入输出 / 配置 / 检索结果。
 *
 * 数据模型与语义见 DESIGN.md 第 3 节（SQLite 建表）与第 4 节（检索算法）。
 * 本文件是 SDK 用户可见的公开类型（随 .d.ts 发布）。
 *
 * 时间约定：所有时间戳一律 unix 毫秒（UTC），与 SQLite 存储一致。
 */

/** 记忆种类（DESIGN.md 第 3 节 kind 枚举） */
export type MemoryKind = "fact" | "episode" | "preference" | "procedure";

/** kind 的合法取值清单（校验用，顺序即展示顺序） */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "episode",
  "preference",
  "procedure",
] as const;

/** 冲突策略（DESIGN.md 第 5 节）：supersede=取代 / keep-both=并存 / error=报错 */
export type ConflictPolicy = "supersede" | "keep-both" | "error";

/**
 * 记忆主表的领域对象（与 memories 表一一对应，做了人话化转换：
 * tags 由 JSON 串还原为数组、deleted/pin 转布尔、驼峰命名）。
 */
export interface MemoryRecord {
  /** ULID（时间有序，见 src/ulid.ts） */
  id: string;
  kind: MemoryKind;
  /** 记忆正文 */
  content: string;
  /** 主语（如 "用户" / 实体名），冲突检测键的一部分；null=全局记忆 */
  subject: string | null;
  /** 标签数组（存储为 JSON） */
  tags: string[];
  /** 置信度 0~1 */
  confidence: number;
  /** 来源（mcp/rest/cli/agent 名） */
  source: string | null;
  /** 命名空间（多租户隔离）。默认 "default" */
  namespace: string;
  createdAt: number;
  updatedAt: number;
  /** 生效起始（时间感知核心） */
  validFrom: number;
  /** 被取代/失效/遗忘时间；null=现行有效 */
  validTo: number | null;
  /** 取代它的记忆 id（取代链指针） */
  supersededBy: string | null;
  /** 软删除标记（Forget 不物理删行，保证 asOf 历史查询与审计） */
  deleted: boolean;
  /** 用户钉选：永不衰减、不被自动取代（冲突时只提醒） */
  pin: boolean;
}

/** 新增记忆输入（除 content 外全部可省，校验规则见 src/model.ts） */
export interface AddInput {
  content: string;
  kind?: MemoryKind;
  subject?: string | null;
  tags?: string[];
  confidence?: number;
  source?: string | null;
  pin?: boolean;
  /** 支撑证据（原文引用）。溯源用，如 ["用户原话：我上周搬到上海了"] */
  evidence?: string[];
  /** 命名空间（多租户隔离）。默认 "default" */
  namespace?: string;
  /** 生效起始时间（默认写入时刻） */
  validFrom?: number;
  /**
   * 时钟覆盖：写入时间以它为准（doctor 确定性剧本与单测用；
   * 默认取 Membrane 构造时的 now()——真实时间或注入时钟）。
   */
  at?: number;
}

/** add 的结果状态 */
export type AddStatus =
  | "created" // 新建
  | "duplicate" // 与旧记忆完全相同，未新建
  | "superseded" // 新值取代了旧值（取代链留痕）
  | "kept-both"; // 冲突落在中间带，两条并存

/**
 * add 返回：发生了什么一目了然（可解释原则同样适用于写入）。
 */
export interface AddResult {
  status: AddStatus;
  /** 新写入或命中的那条记忆 */
  memory: MemoryRecord;
  /** 被本条取代的旧记忆（valid_to=now、superseded_by=新 id，历史留痕） */
  superseded: MemoryRecord[];
  /** 中间带并存的旧记忆（召回时两条都返回，由上层 LLM 裁决） */
  keptBoth: MemoryRecord[];
  /** 人类可读的处理说明（中文） */
  note: string;
}

/** 每条召回结果的分数明细（DESIGN.md 第 4 节：可解释召回） */
export interface ScoreBreakdown {
  /** 综合分（各加权项之和，越大越相关） */
  score: number;
  /** 全文（BM25）排名 → 归一化 RRF 分（1/(60+rank) 归一化，首位=1.0；未参与全文召回=0） */
  textRank: number | null;
  rrfText: number;
  /** 向量余弦排名 → RRF 分（无 embedding 管线时=0） */
  vecRank: number | null;
  rrfVec: number;
  /** 与查询的余弦相似度（无 embedding 时=null） */
  vecSim: number | null;
  /** 新鲜度 exp(-age_days / half_life)，age 从 valid_from 起算 */
  freshness: number;
  /** 该 kind 的半衰期（天） */
  halfLifeDays: number;
  /** 记忆年龄（天） */
  ageDays: number;
  /** 置信度 */
  confidence: number;
  /** 支撑证据条数（0 表示无溯源） */
  evidenceCount: number;
  /** 本次召回实际使用的四项权重 */
  weights: RecallWeights;
}

/** 召回结果条目 = 记忆 + 分数明细 + 入选理由 */
export interface RecallHit {
  memory: MemoryRecord;
  /** 综合分 */
  score: number;
  /** 人类可读的入选理由（中文，逐项拼装） */
  why: string;
  breakdown: ScoreBreakdown;
}

/** 四项权重（DESIGN.md 第 4 节，默认 0.4/0.3/0.2/0.1） */
export interface RecallWeights {
  /** 全文排名权重 */
  text: number;
  /** 向量排名权重 */
  vec: number;
  /** 新鲜度权重 */
  time: number;
  /** 置信度权重 */
  conf: number;
}

/** recall 的输入（query 必填，其余可省） */
export interface RecallOptions {
  query: string;
  /** 返回条数上限（默认 8） */
  limit?: number;
  /** 历史时点查询：只返回该时刻有效的记忆（unix ms） */
  asOf?: number;
  /** 按 kind 过滤（单个或多个） */
  kind?: MemoryKind;
  kinds?: MemoryKind[];
  /** 按主语过滤 */
  subject?: string | null;
  /** 按命名空间过滤（多租户隔离）；不传=只用 "default" */
  namespace?: string;
  /** 覆盖默认权重 */
  weights?: Partial<RecallWeights>;
  /**
   * 查询向量（可选，向量增强）。调用方先用 embed() 算好传入。
   * 不传则 vec 分量为 0，退化为纯全文检索（零依赖底线不变）。
   */
  queryVec?: Float32Array;
  /**
   * 返回详细程度。默认 "brief"（省 token）；"full" 才带完整 breakdown 与 why。
   * brief: {id, kind, content, subject, score, validFrom, evidenceCount}
   * full : 完整 memory + breakdown + why（排查/演示用）
   */
  detail?: "brief" | "full";
}

/** 精简召回结果（默认返回形态，为省 token 设计） */
export interface BriefHit {
  id: string;
  kind: MemoryKind;
  content: string;
  subject: string | null;
  /** 综合分 */
  score: number;
  /** 生效起始时间（unix ms） */
  validFrom: number;
  /** 支撑证据条数 */
  evidenceCount: number;
}

/** 历史审计条目（history 表，DESIGN.md 第 3 节） */
export interface HistoryEntry {
  /** 自增主键 */
  seq: number;
  memoryId: string;
  /** add | supersede | forget | keep-both */
  op: string;
  /** 发生时间（unix ms） */
  at: number;
  /** JSON 明细（相似度/策略/原因等） */
  detail: string | null;
}

/** stats 返回的库况速览 */
export interface MembraneStats {
  /** 全部记忆条数（含被取代/软删除） */
  total: number;
  /** 现行有效条数（valid_to IS NULL 且未软删除） */
  current: number;
  /** 被取代条数（含未被软删除的） */
  superseded: number;
  /** 软删除条数 */
  deleted: number;
  /** 钉选条数 */
  pinned: number;
  byKind: Record<MemoryKind, number>;
  /** 数据库文件字节数（:memory: 时为 0） */
  dbBytes: number;
}

/** Membrane 构造参数（全部可省） */
export interface MembraneOptions {
  /**
   * SQLite 数据库文件路径；":memory:" 为内存库（测试/doctor 用）。
   * 默认：环境变量 MEMBRANE_DB，否则 ./membrane.db（当前工作目录，本地优先）。
   */
  dbPath?: string;
  /** OpenAI 兼容端点配置（抽取/embedding 用；不配则降级为纯全文检索） */
  llm?: LlmConfig;
  /** 四项检索权重，默认 (0.4, 0.3, 0.2, 0.1) */
  weights?: Partial<RecallWeights>;
  /** 按 kind 的新鲜度半衰期（天），覆盖内置默认 */
  halfLives?: Partial<Record<MemoryKind, number>>;
  /** 冲突策略，默认 supersede（DESIGN.md 第 5 节） */
  conflictPolicy?: ConflictPolicy;
  /** 时钟注入（doctor 确定性/单测用），默认 Date.now */
  now?: () => number;
  /** 召回候选池大小（每路 topK 基数倍数），默认 8 */
  candidateFactor?: number;
}

/** OpenAI 兼容端点配置（唯一可外发的组件，用户显式配置才启用） */
export interface LlmConfig {
  /** 形如 https://api.example.com/v1（内部自动拼 /chat/completions、/embeddings） */
  baseUrl: string;
  apiKey: string;
  /** 模型名（抽取用） */
  model: string;
  /** embedding 模型名；不配则不启用向量检索 */
  embeddingModel?: string;
  /** 单次请求超时毫秒，默认 30000 */
  timeoutMs?: number;
}

/** 抽取结果清单（DESIGN.md 第 7 节：返回"存了什么/跳过什么/取代了谁"） */
export interface ExtractResult {
  /** 抽取并成功入库的条目 */
  added: AddResult[];
  /** LLM 返回但校验不过/空内容被跳过的原文 */
  skipped: { item: unknown; reason: string }[];
  /** LLM 调用与解析的原始候选（供调试/展示） */
  candidates: ExtractCandidate[];
}

/** LLM 抽取出的候选记忆（未入库前的形态） */
export interface ExtractCandidate {
  kind?: string;
  subject?: string | null;
  content?: string;
  tags?: string[];
  confidence?: number;
}
