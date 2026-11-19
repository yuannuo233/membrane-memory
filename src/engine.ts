/**
 * 核心引擎（DESIGN.md 第 2/4/5/7 节）。
 *
 * 三个动作：
 * - add    ：去重 → 冲突检测（取代/并存/报错）→ 入库 → 审计留痕
 * - recall ：FTS5 召回 → 现行/历史时点过滤 → RRF 融合打分 → 分数明细 + why
 * - forget ：软删除（保留历史，asOf 仍能查到删除前的样子）
 *
 * 零 LLM 也能跑：相似度用 bigram 包含系数；有 embedding 时用余弦（预留钩子）。
 * 所有"为什么"都落到返回结构里，符合可解释召回承诺。
 */
import { Storage, type FtsHit, type VectorScanOptions } from "./storage.js";
import {
  MembraneError,
  contentKey,
  normalizeAddInput,
  normalizeEntityName,
  normalizeEntityType,
  normalizeNamespace,
  normalizePredicate,
  normalizeVec,
} from "./model.js";
import { charScore, fuzzyUnits, tokenOverlap, tokenSet } from "./tokenize.js";
import { createMonotonicUlid } from "./ulid.js";
import { embedText } from "./llm.js";
import type { FetchLike } from "./llm.js";
import { extractGraph } from "./graph-extract.js";
import {
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_CONFLICT_THRESHOLDS,
  DEFAULT_HALF_LIVES,
  DEFAULT_WEIGHTS,
  RRF_K,
} from "./config.js";
import type {
  AddInput,
  AddResult,
  AddStatus,
  ConflictPolicy,
  EntityInput,
  EntityType,
  ExportBundle,
  GraphEntity,
  HistoryEntry,
  ImportResult,
  LlmConfig,
  MembraneOptions,
  MembraneStats,
  MemoryKind,
  MemoryRecord,
  RecallHit,
  BriefHit,
  RecallOptions,
  RecallWeights,
  Relation,
  RelationInput,
  RelationQueryOptions,
  RelationView,
  UpdateInput,
} from "./types.js";

/** 配置解析后的内部形态（权重/半衰期/策略都填了默认值） */
interface ResolvedConfig {
  weights: RecallWeights;
  halfLives: Record<MemoryKind, number>;
  conflictPolicy: ConflictPolicy;
  candidateFactor: number;
  now: () => number;
  /** 写入时是否用规则自动抽实体/关系（默认 true） */
  autoExtract: boolean;
}

/** 余弦相似度（向量检索用，输入已归一化或原始均可） */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 归一化 RRF 分：(K+1)/(K+rank)，rank 从 1 起；未命中=0，第1名=1.0 */
export function rrfNormalized(rank: number | null): number {
  if (rank === null || rank <= 0) return 0;
  return (RRF_K + 1) / (RRF_K + rank);
}

/** 有序 id 列表 → 名次映射（从 1 起） */
function rankMap(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, i + 1));
  return m;
}

/**
 * 计算"本次召回实际生效的权重"。
 *
 * 规则：**缺失的分量权重归零，剩下的按比例摊到和=1**。
 * 这样无论查询带了几路信号，分数上界恒为 1.0（可跨库/跨配置比较），
 * 而"这一路没参与"也不会把分数整体压低（v0.1 只在无向量时做过这件事，
 * 现在图路同样适用，且五项一起归一，逻辑只有一处）。
 *
 * @param present.vec  本次是否有向量分量（传了 queryVec 且库里有向量）
 * @param present.graph 本次是否有关系分量（查询里认出了实体且命中关系）
 */
export function normalizeWeights(
  w: RecallWeights,
  present: { vec: boolean; graph: boolean } = { vec: false, graph: false },
): RecallWeights {
  // 负权重一律按 0：负分会让"越相关排越后"，不是用户想要的任何东西
  const text = Math.max(0, w.text);
  const vec = present.vec ? Math.max(0, w.vec) : 0;
  const time = Math.max(0, w.time);
  const conf = Math.max(0, w.conf);
  const graph = present.graph ? Math.max(0, w.graph) : 0;
  const sum = text + vec + time + conf + graph;
  if (sum <= 0) return { text: 1, vec: 0, time: 0, conf: 0, graph: 0 };
  const k = 1 / sum;
  return { text: text * k, vec: vec * k, time: time * k, conf: conf * k, graph: graph * k };
}

/**
 * 完整召回结果 → 精简结果（省 token）。
 * 精简版显著小于完整版，可省约 15 倍 token。
 * 精简掉的多是每条重复的 weights/halfLifeDays 与全空的 deleted/pin/tags。
 */
export function toBrief(hit: RecallHit): BriefHit {
  return {
    id: hit.memory.id,
    kind: hit.memory.kind,
    content: hit.memory.content,
    subject: hit.memory.subject,
    score: hit.score,
    validFrom: hit.memory.validFrom,
    evidenceCount: hit.breakdown.evidenceCount,
  };
}

/**
 * 极简结果：只给 id + 内容 + 分数。
 * 用于"AI 只需要知道记了什么"的常规场景——比 brief 再省一半。
 */
export function toUltraBrief(hit: RecallHit): { id: string; content: string; score: number } {
  return { id: hit.memory.id, content: hit.memory.content, score: hit.score };
}

/**
 * 新鲜度：真·半衰期公式 exp(-ln2 · age / halfLife)。
 * age = halfLife 时恰好衰减到 0.5（名副其实）。
 * 旧版 exp(-age/halfLife) 在 age=halfLife 时是 0.368（1/e），参数实为时间常数——
 * 采用真·半衰期公式：age = halfLife 时衰减到 0.5。
 * age<0（未来生效）按 0 处理。
 */
export function freshness(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const age = Math.max(0, ageDays);
  return Math.exp((-Math.LN2 * age) / halfLifeDays);
}

/**
 * Membrane：记忆引擎门面。SDK 用户和三个接入面（CLI/REST/MCP）都通过它操作。
 */
export class Membrane {
  readonly storage: Storage;
  private readonly cfg: ResolvedConfig;
  private readonly newId: (now?: number) => string;
  /** LLM 配置（抽取 / embedding 用，调用实现见 extract.ts） */
  readonly llm?: LlmConfig;

  constructor(options: MembraneOptions = {}) {
    const dbPath = options.dbPath ?? process.env["MEMBRANE_DB"] ?? "./membrane.db";
    this.storage = new Storage(dbPath);
    this.llm = options.llm;
    this.cfg = {
      weights: { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) },
      halfLives: { ...DEFAULT_HALF_LIVES, ...(options.halfLives ?? {}) },
      conflictPolicy: options.conflictPolicy ?? DEFAULT_CONFLICT_POLICY,
      candidateFactor: Math.max(1, options.candidateFactor ?? 8),
      now: options.now ?? (() => Date.now()),
      autoExtract: options.graph?.autoExtract !== false,
    };
    this.newId = createMonotonicUlid();
  }

  /** 当前时间（可注入） */
  private now(): number {
    return this.cfg.now();
  }

  close(): void {
    this.storage.close();
  }

  // ---------- Ingest（add） ----------

  /**
   * 写入一条记忆。
   * 流程：校验 → 完全相同去重 → (subject,kind) 内冲突检测 → 按策略处理 → 入库
   * →（可选）向量落库 →（可选）实体/关系落库 → history 留痕。
   *
   * 向量与图都是"顺带"的增强：任何一步失败都不能让记忆写不进去，
   * 所以向量只接受**预先算好的**（本方法保持同步），图则用纯本地规则。
   */
  add(input: AddInput): AddResult {
    const norm = normalizeAddInput(input, { at: this.now(), source: null });
    const at = norm.at;
    const ns = normalizeNamespace(input.namespace);

    // 1) 完全相同去重：同 contentKey + 同 subject + 同 kind（同一命名空间内）
    const current = this.storage.currentBySubjectKind(norm.subject, norm.kind, ns);
    const dup = current.find((m) => contentKey(m.content) === contentKey(norm.content));
    if (dup) {
      return {
        status: "duplicate" as AddStatus,
        memory: dup,
        superseded: [],
        keptBoth: [],
        note: `与已有记忆 ${dup.id} 内容完全相同，未重复写入。`,
      };
    }

    // 2) 冲突检测：bigram 包含系数（无 LLM / 无向量依赖，确定性）
    const conflicts = this.detectConflicts(norm.content, current);
    const { high, mid, pinned: pinnedConflict } = conflicts;
    if (this.cfg.conflictPolicy === "error" && (high.length > 0 || mid.length > 0)) {
      throw new MembraneError(
        "E_CONFLICT",
        `检测到相似记忆（${[...high, ...mid].map((m) => m.id).join(", ")}），策略为 error，未写入。`,
      );
    }

    // 3) 向量预备：只校验维度一致性，真正落库在事务里
    const vec = normalizeVec(input.vec);
    const embeddingStatus = this.embeddingPlan(vec);

    // 4) 构造新记忆
    const rec = this.buildRecord(norm, ns, at);

    const supersededList: MemoryRecord[] = [];
    const keptBothList: MemoryRecord[] = [];
    let status: AddStatus = "created";
    let note = "新记忆已写入。";
    let relationViews: RelationView[] = [];

    this.storage.transaction(() => {
      this.storage.insert(rec);
      if (embeddingStatus === "stored" && vec) this.storage.upsertEmbedding(rec.id, vec);
      if (input.evidence && input.evidence.length > 0) {
        this.storage.evidenceReplace(rec.id, input.evidence, at);
      }
      relationViews = this.writeGraph(rec.id, {
        content: norm.content,
        subject: norm.subject,
        subjectType: normalizeEntityType(input.subjectType),
        entities: input.entities,
        relations: input.relations,
        namespace: ns,
        validFrom: norm.validFrom,
        at,
      });
      this.storage.historyAppend(rec.id, "add", at, {
        kind: norm.kind,
        subject: norm.subject,
        source: norm.source,
        evidenceCount: input.evidence?.length ?? 0,
        relations: relationViews.length,
        embedding: embeddingStatus,
      });
      const applied = this.applyConflictPolicy(rec.id, conflicts, at);
      supersededList.push(...applied.superseded);
      keptBothList.push(...applied.keptBoth);
      status = applied.status;
      note = applied.note;
    });

    if (embeddingStatus === "skipped") {
      note += ` ⚠️ 传入的向量维度（${vec?.length}）与库内已有向量不一致，已跳过落库（请勿混用两套 embedding 模型）。`;
    }
    if (pinnedConflict.length > 0) {
      note += ` ⚠️ 与钉选记忆冲突（${pinnedConflict.map((m) => m.id).join(", ")}），未自动取代，请人工处理。`;
    }

    return {
      status,
      memory: rec,
      superseded: supersededList,
      keptBoth: keptBothList,
      note,
      embeddingStatus,
      relations: relationViews,
    };
  }

  /**
   * 向量维度守卫：空库或同维度才落库；库里有别的维度就跳过。
   * 混用两套 embedding 模型的向量余弦恒为 0，存进去只会让问题更难排查。
   */
  private embeddingPlan(vec: Float32Array | null): "stored" | "skipped" | "none" {
    if (!vec) return "none";
    const dims = this.storage.embeddingDims();
    return dims.size === 0 || dims.has(vec.length) ? "stored" : "skipped";
  }

  /** 归一化入参 → 待入库记录（表字段与内存结构一一对应，改结构只需改这一处） */
  private buildRecord(
    norm: ReturnType<typeof normalizeAddInput>,
    namespace: string,
    at: number,
  ): MemoryRecord {
    return {
      id: this.newId(at),
      kind: norm.kind,
      content: norm.content,
      subject: norm.subject,
      tags: norm.tags,
      confidence: norm.confidence,
      source: norm.source,
      namespace,
      createdAt: at,
      updatedAt: at,
      validFrom: norm.validFrom,
      validTo: null,
      supersededBy: null,
      deleted: false,
      pin: norm.pin,
    };
  }

  /**
   * 写入记忆顺带建立的实体与关系（同一事务内）。
   *
   * 优先级：手动标注（entities / relations）> 规则抽取（默认开）。
   * 手动给了关系就不再跑规则——否则同一句话会抽出两套口径的关系，
   * "张三和李四什么关系"会拿到互相矛盾的边。
   *
   * @returns 本次建立的关系（可读视图，带实体名与句子）
   */
  private writeGraph(
    memoryId: string,
    ctx: {
      content: string;
      subject: string | null;
      subjectType: EntityType;
      entities?: (string | EntityInput)[];
      relations?: RelationInput[];
      namespace: string;
      validFrom: number;
      at: number;
    },
  ): RelationView[] {
    const manual = (ctx.entities?.length ?? 0) > 0 || (ctx.relations?.length ?? 0) > 0;
    const byName = new Map<string, GraphEntity>();

    const ensure = (name: string, type: EntityType): GraphEntity =>
      this.ensureEntity(name, type, ctx.namespace, ctx.at, byName);

    // subject 永远是实体（没抽到关系也要能"按人查记忆"）
    if (ctx.subject) {
      const ent = ensure(ctx.subject, ctx.subjectType);
      this.storage.linkMemoryEntity(memoryId, ent.id);
    }

    const pending: { from: string; fromType: EntityType; to: string; toType: EntityType; predicate: string; confidence: number }[] = [];

    if (manual) {
      for (const e of ctx.entities ?? []) {
        const name = normalizeEntityName(typeof e === "string" ? e : e.name);
        const type = typeof e === "string" ? "unknown" : normalizeEntityType(e.type);
        const ent = ensure(name, type);
        this.storage.linkMemoryEntity(memoryId, ent.id);
      }
      for (const r of ctx.relations ?? []) {
        const fromName = r.from ? normalizeEntityName(r.from, "关系起点") : ctx.subject;
        if (!fromName) {
          throw new MembraneError("E_RELATION", "关系缺少起点：请在 from 里写实体名，或给记忆一个 subject。");
        }
        // 起点没显式给类型时，若它就是本条记忆的 subject，沿用 subjectType（少一次推断错误）
        const declaredFromType = normalizeEntityType(r.fromType);
        pending.push({
          from: fromName,
          fromType:
            declaredFromType === "unknown" && fromName === ctx.subject
              ? ctx.subjectType
              : declaredFromType,
          to: normalizeEntityName(r.to, "关系终点"),
          toType: normalizeEntityType(r.toType),
          predicate: normalizePredicate(r.predicate),
          confidence: r.confidence === undefined ? 1 : Math.min(1, Math.max(0, r.confidence)),
        });
      }
    } else if (this.cfg.autoExtract) {
      const extracted = extractGraph(ctx.content, ctx.subject, ctx.subjectType);
      for (const e of extracted.entities) {
        const ent = ensure(e.name, e.type);
        this.storage.linkMemoryEntity(memoryId, ent.id);
      }
      for (const r of extracted.relations) {
        pending.push({ ...r, confidence: 0.7 }); // 规则抽的，置信度低于手动标注
      }
    }

    const views: RelationView[] = [];
    for (const p of pending) {
      const fromEnt = ensure(p.from, p.fromType);
      const toEnt = ensure(p.to, p.toType);
      if (fromEnt.id === toEnt.id) continue;
      this.storage.linkMemoryEntity(memoryId, fromEnt.id);
      this.storage.linkMemoryEntity(memoryId, toEnt.id);
      const rel: Relation = {
        id: this.newId(ctx.at),
        fromId: fromEnt.id,
        toId: toEnt.id,
        predicate: p.predicate,
        memoryId,
        confidence: p.confidence,
        validFrom: ctx.validFrom,
        validTo: null,
        namespace: ctx.namespace,
      };
      this.storage.insertRelation(rel);
      views.push(this.relationView(rel, fromEnt.name, toEnt.name, 1));
    }
    return views;
  }

  /** 关系 → 可读视图（句子用"甲 与 乙：谓词"，避免中文语序陷阱） */
  private relationView(
    rel: Relation,
    fromName: string,
    toName: string,
    hops: number,
    fromType: EntityType = "unknown",
    toType: EntityType = "unknown",
  ): RelationView {
    return {
      id: rel.id,
      from: fromName,
      to: toName,
      fromType,
      toType,
      predicate: rel.predicate,
      memoryId: rel.memoryId,
      confidence: rel.confidence,
      validFrom: rel.validFrom,
      validTo: rel.validTo,
      hops,
      sentence: `${fromName} 与 ${toName}：${rel.predicate}`,
    };
  }

  /**
   * 取或建实体（幂等、带本次调用的缓存）。
   * type 只在 unknown → 具体类型时升级：先抽到的具体类型更可信，
   * 不能因为后续一次"猜不出"就把它降级回 unknown。
   */
  private ensureEntity(
    name: string,
    type: EntityType,
    namespace: string,
    at: number,
    cache: Map<string, GraphEntity>,
  ): GraphEntity {
    const cached = cache.get(name);
    if (cached) return cached;

    const existing = this.storage.getEntityByName(name, namespace);
    let entity: GraphEntity;
    if (!existing) {
      entity = { id: this.newId(at), name, type, namespace, createdAt: at };
      this.storage.insertEntity(entity);
    } else if (existing.type === "unknown" && type !== "unknown") {
      this.storage.updateEntityType(existing.id, type);
      entity = { ...existing, type };
    } else {
      entity = existing;
    }
    cache.set(name, entity);
    return entity;
  }

  // ---------- Graph 公开接口 ----------

  /**
   * 手动建立一条关系（人工标注；不需要先有记忆）。
   * 例：engine.link({ from: "张三", to: "李四", predicate: "同学" })
   */
  link(
    input: RelationInput & { memoryId?: string | null; namespace?: string; at?: number },
  ): RelationView {
    if (!input.from) {
      throw new MembraneError("E_RELATION", "link 需要 from（起点实体名）");
    }
    const ns = normalizeNamespace(input.namespace);
    const at = input.at ?? this.now();
    const cache = new Map<string, GraphEntity>();
    const fromName = normalizeEntityName(input.from, "关系起点");
    const toName = normalizeEntityName(input.to, "关系终点");
    const fromEnt = this.ensureEntity(fromName, normalizeEntityType(input.fromType), ns, at, cache);
    const toEnt = this.ensureEntity(toName, normalizeEntityType(input.toType), ns, at, cache);
    const rel: Relation = {
      id: this.newId(at),
      fromId: fromEnt.id,
      toId: toEnt.id,
      predicate: normalizePredicate(input.predicate),
      memoryId: input.memoryId ?? null,
      confidence: input.confidence === undefined ? 1 : Math.min(1, Math.max(0, input.confidence)),
      validFrom: at,
      validTo: null,
      namespace: ns,
    };
    this.storage.transaction(() => this.storage.insertRelation(rel));
    return this.relationView(rel, fromEnt.name, toEnt.name, 1, fromEnt.type, toEnt.type);
  }

  /**
   * 关系查询——直接回答"张三和李四是什么关系"。
   *
   * - relations("张三")：张三的一跳邻居（不限方向）
   * - relations("张三", "李四")：两人之间的最短路径（默认 1 跳，最多 4 跳）
   * - 传整句也行：relations("张三和李四是什么关系") —— 会自己从里面认实体
   *
   * 关系遵守与记忆同一套时间感知：传 asOf 查"当年是什么关系"。
   */
  relations(a: string, b?: string | null, opts: RelationQueryOptions = {}): RelationView[] {
    const ns = normalizeNamespace(opts.namespace);
    const asOf = opts.asOf;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 32;
    const maxHops = Math.max(1, Math.min(4, opts.maxHops ?? 1));
    const entities = this.storage.listEntities(ns);
    if (entities.length === 0) return [];
    const byId = new Map(entities.map((e) => [e.id, e]));

    /** 把"实体名或整句"解析成实体集合：先精确，再退化为"句子里包含的名字"（长名优先） */
    const resolve = (ref: string): GraphEntity[] => {
      const t = ref.trim().toLowerCase();
      if (!t) return [];
      const exact = entities.filter((e) => e.name.toLowerCase() === t);
      if (exact.length > 0) return exact;
      return entities
        .filter((e) => e.name.length >= 2 && t.includes(e.name.toLowerCase()))
        .sort((x, y) => y.name.length - x.name.length);
    };

    /**
     * 只传了一整句（没给 B）时，先看看句子里是不是同时出现了两个已知实体：
     * "张三和李四是什么关系" → 认出 张三、李四 → 当成 (张三, 李四) 来查，
     * 而不是退化成"张三的一跳邻居"（那样会把李四的其他关系也一起倒出来）。
     */
    const trimmedA = a.trim();
    const exactA = entities.find((e) => e.name.toLowerCase() === trimmedA.toLowerCase());
    let fromRef = a;
    let toRef: string | null | undefined = b;
    if (!b && !exactA) {
      const hitNames = entities
        .filter((e) => e.name.length >= 2 && trimmedA.includes(e.name))
        .sort((x, y) => trimmedA.indexOf(x.name) - trimmedA.indexOf(y.name))
        .filter((e, i, arr) => arr.findIndex((o) => o.name === e.name) === i);
      if (hitNames.length >= 2) {
        fromRef = hitNames[0]!.name;
        toRef = hitNames[1]!.name;
      }
    }

    const starts = resolve(fromRef);
    if (starts.length === 0) return [];
    const startIds = new Set(starts.map((e) => e.id));

    // 只给 A：返回 A 的一跳邻居（两个方向都算，关系是有向的但"谁和谁有关系"无向）
    if (!toRef) {
      const rels = this.storage.relationsTouching([...startIds], { namespace: ns, asOf, limit });
      return rels
        .map((rel) => this.viewOf(rel, byId, 1))
        .filter((v): v is RelationView => v !== null)
        .slice(0, limit);
    }

    const targets = resolve(toRef);
    if (targets.length === 0) return [];
    const targetIds = new Set(targets.map((e) => e.id));

    // 两个实体的最短路径（无向 BFS；记录父边，回溯出完整链条）
    const parents = new Map<string, { prev: string | null; edge: Relation | null; hop: number }>();
    for (const id of startIds) parents.set(id, { prev: null, edge: null, hop: 0 });
    const visited = new Set(startIds);
    let frontier = [...startIds];
    let found: string | null = null;

    for (let hop = 1; hop <= maxHops && frontier.length > 0 && found === null; hop++) {
      const rels = this.storage.relationsTouching(frontier, { namespace: ns, asOf, limit: 2000 });
      const next: string[] = [];
      for (const rel of rels) {
        const pairs: [string, string][] = [
          [rel.fromId, rel.toId],
          [rel.toId, rel.fromId],
        ];
        for (const [fromId, toId] of pairs) {
          if (visited.has(toId) || !parents.has(fromId)) continue;
          visited.add(toId);
          next.push(toId);
          parents.set(toId, { prev: fromId, edge: rel, hop });
          if (targetIds.has(toId)) {
            found = toId;
            break;
          }
        }
        if (found !== null) break;
      }
      frontier = next;
    }

    if (found === null) return [];
    // 回溯：终点 → 起点，得到 hop=1..n 的边序列
    const chain: Relation[] = [];
    let cur: string | null = found;
    while (cur !== null) {
      const p = parents.get(cur);
      if (!p || p.edge === null) break;
      chain.push(p.edge);
      cur = p.prev;
    }
    chain.reverse();
    return chain
      .map((rel, i) => this.viewOf(rel, byId, i + 1))
      .filter((v): v is RelationView => v !== null)
      .slice(0, limit);
  }

  /** 关系 + 实体表 → 可读视图（找不到实体说明数据不一致，返回 null 让调用方跳过） */
  private viewOf(
    rel: Relation,
    byId: Map<string, GraphEntity>,
    hops: number,
  ): RelationView | null {
    const from = byId.get(rel.fromId);
    const to = byId.get(rel.toId);
    if (!from || !to) return null;
    return this.relationView(rel, from.name, to.name, hops, from.type, to.type);
  }

  /** 某条记忆提到过哪些实体（图路的溯源展示） */
  entitiesFor(memoryId: string): GraphEntity[] {
    return this.storage.entitiesForMemory(memoryId);
  }

  /** 命名空间内全部实体（Dashboard / REST 展示用） */
  listEntities(namespace = "default", limit = 5000): GraphEntity[] {
    // 显式归一：0/负数/超大值都不该把 SQL 的 LIMIT 变成意外行为
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    return this.storage.listEntities(normalizeNamespace(namespace), safeLimit);
  }

  // ---------- 向量：异步写入 / 查询 / 回填 ----------

  /**
   * 写入 + 自动算向量（异步版）。
   *
   * 与 add() 的区别只有一处：先调 embedding 端点把向量算出来，再走同一个 add()。
   * 所以去重、冲突检测、审计链的行为完全一致，不会出现"两套写入路径"。
   * **算向量失败绝不阻断写入**：catch 住，当成纯文本记忆写进去，note 里说明。
   */
  async addAsync(
    input: AddInput,
    opts: { injectFetch?: FetchLike; embed?: boolean } = {},
  ): Promise<AddResult> {
    if (input.vec || opts.embed === false || !this.llm?.embeddingModel) return this.add(input);
    try {
      const vec = await embedText(this.llm, input.content, { injectFetch: opts.injectFetch });
      if (!vec) return this.add(input);
      return this.add({ ...input, vec });
    } catch (err) {
      const r = this.add(input);
      return {
        ...r,
        embeddingStatus: "none",
        note: `${r.note} ⚠️ 向量计算失败（${err instanceof Error ? err.message : String(err)}），本次按纯全文写入。`,
      };
    }
  }

  /**
   * 编辑一条现存记忆（**版本化更新**，不是原地改行）。
   *
   * 新版本写入后，旧版本被标记 superseded（valid_to=now）、它派生的关系一起关闭；
   * 旧正文/证据/关系都留在库里，所以 `asOf(编辑前)` 仍能查到原样。
   * 内容没变化时直接返回 duplicate，不制造无意义的历史版本。
   */
  update(id: string, input: UpdateInput): AddResult {
    const old = this.storage.get(id);
    if (!old) throw new MembraneError("E_NOT_FOUND", `记忆 ${id} 不存在。`);
    if (old.deleted) throw new MembraneError("E_UPDATE_DELETED", `记忆 ${id} 已被遗忘，不能再编辑。`);
    if (old.validTo !== null) {
      throw new MembraneError("E_UPDATE_STALE", `记忆 ${id} 已被取代，请编辑现行版本（valid_to 非空）。`);
    }

    const at = this.now();
    const norm = normalizeAddInput(
      {
        content: input.content ?? old.content,
        kind: input.kind ?? old.kind,
        subject: input.subject !== undefined ? input.subject : old.subject,
        tags: input.tags ?? old.tags,
        confidence: input.confidence ?? old.confidence,
        source: input.source !== undefined ? input.source : old.source,
        pin: input.pin ?? old.pin,
        at,
        validFrom: at,
      },
      { at, source: old.source },
    );

    // 内容与元数据都没变（也没给新证据/图/向量）→ 不制造新版本
    const same =
      contentKey(norm.content) === contentKey(old.content) &&
      norm.kind === old.kind &&
      norm.subject === old.subject &&
      JSON.stringify(norm.tags) === JSON.stringify(old.tags) &&
      norm.confidence === old.confidence &&
      norm.pin === old.pin &&
      input.evidence === undefined &&
      input.entities === undefined &&
      input.relations === undefined &&
      !input.vec;
    if (same) {
      return {
        status: "duplicate",
        memory: old,
        superseded: [],
        keptBoth: [],
        note: "内容没有变化，未创建新版本。",
      };
    }

    // 正文没变时沿用旧向量（元数据编辑不该让向量失效）；正文变了必须重算或由调用方传入
    const sameText = contentKey(norm.content) === contentKey(old.content);
    const vec = normalizeVec(input.vec) ?? (sameText ? this.storage.getEmbedding(old.id) : null);
    const embeddingStatus = this.embeddingPlan(vec);
    const rec = this.buildRecord(norm, old.namespace, at);
    const oldEvidence = input.evidence === undefined ? this.storage.evidenceFor(old.id) : null;

    let relationViews: RelationView[] = [];
    this.storage.transaction(() => {
      this.storage.insert(rec);
      if (embeddingStatus === "stored" && vec) this.storage.upsertEmbedding(rec.id, vec);
      if (input.evidence !== undefined) {
        this.storage.evidenceReplace(rec.id, input.evidence, at);
      } else if (oldEvidence) {
        for (const ev of oldEvidence) this.storage.appendEvidence(rec.id, ev.quote, ev.at);
      }
      relationViews = this.writeGraph(rec.id, {
        content: norm.content,
        subject: norm.subject,
        subjectType: normalizeEntityType(input.subjectType),
        entities: input.entities,
        relations: input.relations,
        namespace: old.namespace,
        validFrom: norm.validFrom,
        at,
      });
      this.storage.markSuperseded(old.id, rec.id, at);
      this.storage.closeRelationsForMemory(old.id, at);
      this.storage.historyAppend(rec.id, "add", at, {
        kind: norm.kind,
        subject: norm.subject,
        source: norm.source,
        evidenceCount: input.evidence?.length ?? oldEvidence?.length ?? 0,
        relations: relationViews.length,
        embedding: embeddingStatus,
        editOf: old.id,
      });
      this.storage.historyAppend(old.id, "supersede", at, { by: rec.id, reason: "user-edit" });
    });

    return {
      status: "created",
      memory: rec,
      superseded: [old],
      keptBoth: [],
      note: `已更新：旧版本 ${old.id} 被取代，历史仍可用 asOf 查到。`,
      embeddingStatus,
      relations: relationViews,
    };
  }

  /**
   * 编辑 + 自动算向量（异步版）。没配 embedding 模型时等价于 update()。
   * 算向量失败不阻断编辑：按纯文本版本更新，note 里说明。
   */
  async updateAsync(
    id: string,
    input: UpdateInput,
    opts: { injectFetch?: FetchLike; embed?: boolean } = {},
  ): Promise<AddResult> {
    if (input.vec || opts.embed === false || !this.llm?.embeddingModel) return this.update(id, input);
    const old = this.storage.get(id);
    if (!old) throw new MembraneError("E_NOT_FOUND", `记忆 ${id} 不存在。`);
    const content = input.content ?? old.content;
    try {
      const vec = await embedText(this.llm, content, { injectFetch: opts.injectFetch });
      return this.update(id, vec ? { ...input, vec } : input);
    } catch (err) {
      const r = this.update(id, input);
      return {
        ...r,
        embeddingStatus: "none",
        note: `${r.note} ⚠️ 向量计算失败（${err instanceof Error ? err.message : String(err)}），本次按纯全文更新。`,
      };
    }
  }

  /**
   * 查询 + 自动算查询向量（异步版）。没配 embeddingModel 时等价于 recall()。
   * 算不出来（断网/超时）就降级为纯全文检索，而不是报错——"记忆能查"优先于"语义最强"。
   */
  async recallAsync(
    options: RecallOptions & { injectFetch?: FetchLike },
  ): Promise<RecallHit[]> {
    const { injectFetch, ...recallOptions } = options;
    if (recallOptions.queryVec || !this.llm?.embeddingModel) return this.recall(recallOptions);
    try {
      const vec = await embedText(this.llm, recallOptions.query, { injectFetch });
      return this.recall(vec ? { ...recallOptions, queryVec: vec } : recallOptions);
    } catch {
      return this.recall(recallOptions);
    }
  }

  /**
   * 给已有记忆手动挂向量（比如上层自己算好了向量）。
   * 维度与库内不一致时拒绝——混两套模型的向量比没有向量更糟（永远余弦为 0）。
   */
  setVector(id: string, vec: Float32Array | number[]): void {
    const rec = this.storage.get(id);
    if (!rec) throw new MembraneError("E_NOT_FOUND", `记忆 ${id} 不存在`);
    const v = normalizeVec(vec);
    if (!v) throw new MembraneError("E_VECTOR", "向量非法（空数组或含 NaN/Infinity）");
    const dims = this.storage.embeddingDims();
    if (dims.size > 0 && !dims.has(v.length)) {
      const known = [...dims.keys()].join(" / ");
      throw new MembraneError(
        "E_VECTOR_DIM",
        `向量维度不一致：传入 ${v.length} 维，库内已有 ${known} 维。混用不同 embedding 模型会让余弦恒为 0。`,
      );
    }
    this.storage.upsertEmbedding(id, v);
  }

  /**
   * 回填：给"有记忆但没有向量"的老数据批量补向量。
   *
   * 这是显式动作（CLI 的 embed-backfill），**不在启动时自动跑**——
   * 回填要调外部 API，会慢、会花钱，必须让用户知道并主动触发。
   */
  async backfillEmbeddings(
    opts: {
      namespace?: string;
      limit?: number;
      injectFetch?: FetchLike;
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<{ total: number; embedded: number; failed: number; failures: string[] }> {
    if (!this.llm?.embeddingModel) {
      throw new MembraneError(
        "E_NO_EMBED_MODEL",
        "回填向量需要先配置 embedding 模型（Membrane 构造时的 llm.embeddingModel，或环境变量 MEMBRANE_EMBED_MODEL）",
      );
    }
    const ns = normalizeNamespace(opts.namespace);
    const missing = this.storage.memoriesMissingEmbedding(ns, opts.limit ?? -1);
    const result = { total: missing.length, embedded: 0, failed: 0, failures: [] as string[] };
    const dims = this.storage.embeddingDims();
    for (const rec of missing) {
      try {
        const vec = await embedText(this.llm, rec.content, { injectFetch: opts.injectFetch });
        if (!vec) continue;
        if (dims.size > 0 && !dims.has(vec.length)) {
          throw new MembraneError(
            "E_VECTOR_DIM",
            `端点返回 ${vec.length} 维，而库内已有 ${[...dims.keys()].join(" / ")} 维——两套模型不能混用`,
          );
        }
        this.storage.upsertEmbedding(rec.id, vec);
        dims.set(vec.length, (dims.get(vec.length) ?? 0) + 1);
        result.embedded++;
      } catch (err) {
        result.failed++;
        result.failures.push(`${rec.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      opts.onProgress?.(result.embedded + result.failed, result.total);
    }
    return result;
  }

  /** 冲突检测：把现行同 (subject,kind) 记忆按相似度分三带 */
  private detectConflicts(
    content: string,
    current: MemoryRecord[],
  ): { high: MemoryRecord[]; mid: MemoryRecord[]; pinned: MemoryRecord[]; sim: (m: MemoryRecord) => number } {
    const newSet = tokenSet(content);
    const sim = (m: MemoryRecord): number => tokenOverlap(newSet, tokenSet(m.content));
    const th = DEFAULT_CONFLICT_THRESHOLDS.lexical;
    return {
      sim,
      high: current.filter((m) => sim(m) >= th.high && !m.pin),
      mid: current.filter((m) => sim(m) >= th.mid && sim(m) < th.high),
      pinned: current.filter((m) => m.pin && sim(m) >= th.high),
    };
  }

  /** 按配置策略处理冲突：取代 / 并存 / （error 已在 add 里提前抛错） */
  private applyConflictPolicy(
    id: string,
    c: { high: MemoryRecord[]; mid: MemoryRecord[]; sim: (m: MemoryRecord) => number },
    at: number,
  ): { status: AddStatus; note: string; superseded: MemoryRecord[]; keptBoth: MemoryRecord[] } {
    const superseded: MemoryRecord[] = [];
    const keptBoth: MemoryRecord[] = [];
    const sim = (m: MemoryRecord): number => Number(c.sim(m).toFixed(4));

    if (this.cfg.conflictPolicy === "supersede") {
      for (const old of c.high) {
        this.storage.markSuperseded(old.id, id, at);
        // 旧记忆失效，它派生的关系同时失效——否则"用户住在北京"被取代后，
        // 图路还会把"住在北京"当现行关系返回。不删行，asOf 仍可查。
        this.storage.closeRelationsForMemory(old.id, at);
        this.storage.historyAppend(old.id, "supersede", at, {
          by: id,
          similarity: sim(old),
          reason: "包含系数达取代阈值",
        });
        superseded.push({ ...old, validTo: at, supersededBy: id, updatedAt: at });
      }
      for (const old of c.mid) {
        this.storage.historyAppend(old.id, "keep-both", at, {
          with: id,
          similarity: sim(old),
          reason: "相似度落在中间带，两条并存待上层裁决",
        });
        keptBoth.push(old);
      }
      if (c.high.length > 0) {
        return { status: "superseded", superseded, keptBoth, note: `新记忆已写入，取代 ${c.high.length} 条旧记忆，并存 ${c.mid.length} 条。` };
      }
      if (c.mid.length > 0) {
        return { status: "kept-both", superseded, keptBoth, note: `新记忆已写入，与 ${c.mid.length} 条旧记忆并存待裁决。` };
      }
      return { status: "created", superseded, keptBoth, note: "新记忆已写入。" };
    }

    // keep-both 策略：全部并存，只记审计
    for (const old of [...c.high, ...c.mid]) {
      this.storage.historyAppend(old.id, "keep-both", at, {
        with: id,
        similarity: sim(old),
        reason: "策略 keep-both：全部并存",
      });
      keptBoth.push(old);
    }
    const n = c.high.length + c.mid.length;
    return {
      status: n > 0 ? "kept-both" : "created",
      superseded,
      keptBoth,
      note: n > 0 ? `策略 keep-both：新记忆与 ${n} 条旧记忆并存。` : "新记忆已写入。",
    };
  }

  // ---------- Recall（检索） ----------

  /**
   * read-path 模糊召回：FTS 的 bigram 没命中时，用字符覆盖率找"隔字命中"的记忆。
   *
   * 性能：不再全表扫描。先用 char_index 倒排索引捞出"至少命中一个检索单元"的
   * 记忆（O(命中数)），再对这些候选精确算覆盖率复核。索引在 insert 时同步维护。
   *
   * 尊重 asOf / kind / subject 过滤（与 searchFtsOnce 的过滤语义一致）。
   * 返回的 bm25 字段存覆盖率的负值（-coverage），供通用排序逻辑复用。
   */
  private fuzzyRecall(options: RecallOptions, poolSize: number, namespace = "default"): FtsHit[] {
    const queryUnits = fuzzyUnits(options.query);
    if (queryUnits.size === 0) return [];

    // 1) 倒排索引取候选（多取一些，因为后面还要按精确覆盖率筛掉一部分）
    const candidates = this.storage.fuzzyCandidates(
      [...queryUnits],
      poolSize * 10,
      namespace,
      options.asOf,
    );
    if (candidates.length === 0) return [];

    // 2) 批量取记录（一次查询，避免 N+1）
    const byId = this.storage.getMany(candidates.map((c) => c.id));

    // 3) 精确算覆盖率 + 应用剩余过滤条件（时间过滤已在 SQL 里做过）
    const scored: FtsHit[] = [];
    for (const { id } of candidates) {
      const rec = byId.get(id);
      if (!rec) continue;
      if (options.kind && rec.kind !== options.kind) continue;
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(rec.kind)) continue;
      if (options.subject !== undefined && rec.subject !== options.subject) continue;
      const cov = charScore(queryUnits, rec.content);
      // 阈值 0.5：查询至少一半检索单元能在记忆里找到，才认定模糊命中。
      // 防止"不存在的词"里"的/词"这类高频单字碰巧命中造成误召回。
      if (cov < 0.5) continue;
      scored.push({ record: rec, bm25: -cov }); // 覆盖率越高 bm25 越小 → 排越前
    }
    scored.sort((a, b) => a.bm25 - b.bm25);
    return scored.slice(0, poolSize);
  }

  /**
   * 混合检索 + 时间过滤 + RRF 融合 + 分数明细。
   *
   * 四路候选并联：全文 / 字符兜底 / 向量 / 关系图。每一路只贡献**自己的排名**，
   * 不冒充别路——v0.1 里向量候选曾混进全文排名里白拿一份全文分，本次一并修正。
   *
   * 权重归一化：见 normalizeWeights()。没有信号的分量权重归零，其余按比例摊到和=1，
   * 所以分数上界恒为 1.0，跨库/跨配置可比。
   */
  recall(options: RecallOptions): RecallHit[] {
    const limit = options.limit && options.limit > 0 ? options.limit : 8;
    const now = options.asOf ?? this.now();
    const poolSize = limit * this.cfg.candidateFactor;
    const ns = normalizeNamespace(options.namespace);

    // 1) 候选召回（四路并联，各自留自己的排名证据）
    const { textHits, fuzzy, vecHits, graphHits, graphPaths } = this.gatherCandidates(
      options,
      poolSize,
      ns,
    );
    if (textHits.length === 0 && vecHits.length === 0 && graphHits.length === 0) return [];

    // 2) 全文排名只认全文路（bm25 越负越相关；fuzzy 时已按覆盖率排好）
    const ordered = fuzzy ? textHits : [...textHits].sort((a, b) => a.bm25 - b.bm25);
    const textRank = rankMap(ordered.map((h) => h.record.id));

    // 3) 候选并集（同一记忆可能被多路同时发现，按 id 去重，保留先到的）
    const merged = new Map<string, FtsHit>();
    for (const h of [...textHits, ...vecHits, ...graphHits]) {
      if (!merged.has(h.record.id)) merged.set(h.record.id, h);
    }
    const candidates = [...merged.values()];

    // 4) 向量相似度与排名（只对候选算，不再全表扫）
    const { sims, vecRank } = this.gatherVectors(candidates, options.queryVec);
    const graphRank = rankMap(graphHits.map((h) => h.record.id));

    // 5) 本次实际生效的五项权重（缺失分量归零后按比例归一，和恒为 1）
    const raw: RecallWeights = { ...this.cfg.weights, ...(options.weights ?? {}) };
    const weights = normalizeWeights(raw, {
      vec: sims.size > 0,
      graph: graphHits.length > 0,
    });

    // 6) 逐条打分（证据计数一次性取，避免 N+1 查询）
    const evidenceCounts = this.storage.evidenceCountAll();
    const hits: RecallHit[] = candidates.map((h) =>
      this.scoreHit(h, {
        textRank,
        sims,
        vecRank,
        graphRank,
        graphPaths,
        evidenceCounts,
        weights,
        now,
        fuzzy,
      }),
    );

    // 7) 按总分降序，取 topK
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * 候选召回（四路并联）：
   *  1) FTS5 BM25 全文路
   *  2) 有 queryVec 时，向量路**独立产生候选**（不是只给词面候选重排）——
   *     否则"语义相近但用词不同"的记忆永远进不了候选池，混合检索名不副实。
   *  3) 查询里认出实体时，关系图路按"关系 → 溯源记忆"反向找回候选
   *  4) 全文两路都空时，才降级到字符覆盖率兜底
   */
  private gatherCandidates(
    options: RecallOptions,
    poolSize: number,
    ns: string,
  ): {
    textHits: FtsHit[];
    fuzzy: boolean;
    vecHits: FtsHit[];
    graphHits: FtsHit[];
    graphPaths: Map<string, RelationView[]>;
  } {
    const ftsHits = this.storage.searchFts(options.query, {
      limit: poolSize,
      asOf: options.asOf,
      kind: options.kind,
      kinds: options.kinds,
      subject: options.subject,
      namespace: ns,
    });

    // 向量路：按余弦取 topK（已在全文候选里的跳过，省算力，融合在 recall 里做）
    const vecHits = options.queryVec
      ? this.vectorCandidates(
          options,
          poolSize,
          ns,
          new Set(ftsHits.map((h) => h.record.id)),
        )
      : [];

    // 图路：查询里认出实体 → 找到关系 → 溯源回产生这条关系的记忆
    const graph = this.graphCandidates(options, poolSize, ns);

    if (ftsHits.length > 0) return { textHits: ftsHits, fuzzy: false, vecHits, ...graph };
    // 全文 0 命中时：有向量/图候选就不必再跑模糊兜底（那只是兜底，不该抢主路语义）
    if (vecHits.length > 0 || graph.graphHits.length > 0) {
      return { textHits: [], fuzzy: false, vecHits, ...graph };
    }
    return {
      textHits: this.fuzzyRecall(options, poolSize, ns),
      fuzzy: true,
      vecHits,
      ...graph,
    };
  }

  /**
   * 向量路候选发现：按余弦取前 poolSize 条。
   *
   * 性能（v0.2 重写）：不再 getAllEmbeddings() 把全库向量读进内存。
   * 改成边扫边比：storage.scanEmbeddings 用 keyset 分页每次只物化 batchSize 条，
   * 这里只维护一个 poolSize 大小的 top-K 数组。
   * 内存占用从"全库向量"降到"一个批次"，10 万条库不再吃掉 600MB。
   * 命名空间/时间/kind/subject 过滤全部下推到 SQL，别租户的向量根本不会读出来。
   */
  private vectorCandidates(
    options: RecallOptions,
    poolSize: number,
    namespace: string,
    exclude: Set<string>,
  ): FtsHit[] {
    const qv = options.queryVec;
    if (!qv) return [];

    const scan: VectorScanOptions = {
      namespace,
      asOf: options.asOf,
      kind: options.kind,
      kinds: options.kinds,
      subject: options.subject,
    };
    const top: { record: MemoryRecord; sim: number }[] = [];
    this.storage.scanEmbeddings(scan, (batch) => {
      for (const item of batch) {
        if (exclude.has(item.record.id)) continue;
        // 维度不一致的向量余弦恒为 0，算了也是白算，直接跳过
        if (item.vec.length !== qv.length) continue;
        top.push({ record: item.record, sim: cosine(qv, item.vec) });
      }
      // 每批扫完就剪枝，数组最多长到 2×poolSize
      if (top.length > poolSize * 2) {
        top.sort((a, b) => b.sim - a.sim);
        top.length = poolSize;
      }
    });

    top.sort((a, b) => b.sim - a.sim);
    // bm25 字段复用为 -sim（越相似越负 → 通用排序里越靠前）
    return top.slice(0, poolSize).map((s) => ({ record: s.record, bm25: -s.sim }));
  }

  /** 为**全部候选**算余弦与排名；只按 id 批量取向量，不再全表扫 */
  private gatherVectors(
    candidates: FtsHit[],
    queryVec: Float32Array | undefined,
  ): { sims: Map<string, number>; vecRank: Map<string, number> } {
    const sims = new Map<string, number>();
    if (!queryVec) return { sims, vecRank: new Map() };
    const vecs = this.storage.getEmbeddingsByIds(candidates.map((h) => h.record.id));
    for (const h of candidates) {
      const v = vecs.get(h.record.id);
      if (!v || v.length !== queryVec.length) continue;
      sims.set(h.record.id, cosine(queryVec, v));
    }
    const sorted = [...sims.entries()].sort((a, b) => b[1] - a[1]);
    return { sims, vecRank: rankMap(sorted.map(([id]) => id)) };
  }

  /**
   * 图路候选：查询里认出实体 → 沿关系走 → 找回"产生这条关系的记忆"。
   *
   * 这是图检索融进统一打分的方式（交接文档建议的"方案 A"）：
   * 关系不搞独立入口，而是作为第四路候选来源，命中后拿 rrfGraph 这一项分数。
   * 好处是"一个入口、统一打分"的设计一致性不被破坏，why 里也能看到关系证据。
   *
   * 实体识别是纯本地的"名字包含匹配"（长名优先），零 API 零模型。
   * 认错了也没关系：图路只是加分项，不会把不相关的记忆排到全文命中前面。
   */
  private graphCandidates(
    options: RecallOptions,
    poolSize: number,
    namespace: string,
  ): { graphHits: FtsHit[]; graphPaths: Map<string, RelationView[]> } {
    const empty = {
      graphHits: [] as FtsHit[],
      graphPaths: new Map<string, RelationView[]>(),
    };
    if (options.noGraph) return empty;

    const entities = this.storage.listEntities(namespace);
    if (entities.length === 0) return empty;
    const byId = new Map(entities.map((e) => [e.id, e]));

    // 1) 查询里认出实体：显式 entities 优先，否则按"名字是查询的子串"匹配
    const seeds = new Set<string>();
    if (options.entities && options.entities.length > 0) {
      for (const raw of options.entities) {
        const name = raw.trim();
        const hit = entities.find((e) => e.name === name);
        if (hit) seeds.add(hit.id);
      }
    } else {
      const q = options.query.toLowerCase();
      for (const e of entities) {
        if (e.name.length < 2) continue; // 单字实体匹配率太高，宁可不认
        if (q.includes(e.name.toLowerCase())) seeds.add(e.id);
      }
    }
    if (seeds.size === 0) return empty;

    // 2) 从种子实体出发走 BFS（默认 1 跳；多跳查询显式传 hops）
    const hops = Math.max(1, Math.min(3, options.hops ?? 1));
    const edges = this.collectEdges(seeds, hops, namespace, options.asOf, poolSize * 4);
    if (edges.size === 0) return empty;

    // 3) 按"哪条记忆产生了这些关系"分组，命中边数越多越强
    const byMemory = new Map<string, { rel: Relation; hop: number }[]>();
    for (const item of edges.values()) {
      const mid = item.rel.memoryId;
      if (!mid) continue;
      const list = byMemory.get(mid);
      if (list) list.push(item);
      else byMemory.set(mid, [item]);
    }
    if (byMemory.size === 0) return empty;

    const groups = [...byMemory.entries()]
      .map(([id, list]) => ({
        id,
        hits: list.length,
        confidence: list.reduce((s, x) => s + x.rel.confidence, 0),
      }))
      .sort((a, b) => b.hits - a.hits || b.confidence - a.confidence);

    // 4) 批量取记忆本体并应用剩余过滤（避免 N+1）
    const records = this.storage.getMany(groups.map((g) => g.id));
    const accepted: FtsHit[] = [];
    const graphPaths = new Map<string, RelationView[]>();
    for (const g of groups) {
      if (accepted.length >= poolSize) break;
      const rec = records.get(g.id);
      if (!rec || !this.matchesFilters(rec, options, namespace)) continue;
      accepted.push({ record: rec, bm25: -g.hits });

      const views: RelationView[] = [];
      for (const item of byMemory.get(g.id) ?? []) {
        const from = byId.get(item.rel.fromId);
        const to = byId.get(item.rel.toId);
        if (!from || !to) continue;
        views.push(this.relationView(item.rel, from.name, to.name, item.hop, from.type, to.type));
      }
      graphPaths.set(g.id, views);
    }
    return { graphHits: accepted, graphPaths };
  }

  /**
   * 从种子实体出发 BFS 收集关系边（visited 按实体去重，避免环形图无限扩）。
   * 返回每条边**最早**被命中的跳数，供 why 里写"第几跳"。
   */
  private collectEdges(
    seeds: Set<string>,
    maxHops: number,
    namespace: string,
    asOf: number | undefined,
    limit: number,
  ): Map<string, { rel: Relation; hop: number }> {
    const out = new Map<string, { rel: Relation; hop: number }>();
    let frontier = [...seeds];
    const visited = new Set<string>(seeds);
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const rels = this.storage.relationsTouching(frontier, { namespace, asOf, limit });
      const next: string[] = [];
      for (const rel of rels) {
        if (!out.has(rel.id)) out.set(rel.id, { rel, hop });
        for (const id of [rel.fromId, rel.toId]) {
          if (!visited.has(id)) {
            visited.add(id);
            next.push(id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** 统一的时间/属性过滤（各条候选路共用一套口径，别各写一份） */
  private matchesFilters(rec: MemoryRecord, options: RecallOptions, namespace: string): boolean {
    if (rec.namespace !== namespace) return false;
    if (options.kind && rec.kind !== options.kind) return false;
    if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(rec.kind)) return false;
    if (options.subject !== undefined && rec.subject !== options.subject) return false;
    if (options.asOf === undefined) {
      if (rec.deleted || rec.validTo !== null) return false;
    } else if (!(rec.validFrom <= options.asOf && (rec.validTo === null || rec.validTo > options.asOf))) {
      return false;
    }
    return true;
  }

  /** 单条命中打分 + 分数明细 + why */
  private scoreHit(
    h: FtsHit,
    ctx: {
      textRank: Map<string, number>;
      sims: Map<string, number>;
      vecRank: Map<string, number>;
      graphRank: Map<string, number>;
      graphPaths: Map<string, RelationView[]>;
      evidenceCounts: Map<string, number>;
      weights: RecallWeights;
      now: number;
      fuzzy: boolean;
    },
  ): RecallHit {
    const m = h.record;
    const rank = ctx.textRank.get(m.id) ?? null;
    const vRank = ctx.vecRank.get(m.id) ?? null;
    const gRank = ctx.graphRank.get(m.id) ?? null;
    const vSim = ctx.sims.get(m.id) ?? null;
    const rrfText = rrfNormalized(rank);
    const rrfVec = rrfNormalized(vRank);
    const rrfGraph = rrfNormalized(gRank);
    const views = ctx.graphPaths.get(m.id) ?? null;
    const ageDays = (ctx.now - m.validFrom) / 86_400_000;
    // 脏数据守卫：库里出现过非法 kind 时不能算出 NaN 分（NaN 会让整条排序失去意义）
    const hl = this.cfg.halfLives[m.kind] ?? DEFAULT_HALF_LIVES.fact;
    const fresh = freshness(ageDays, hl);
    const score =
      ctx.weights.text * rrfText +
      ctx.weights.vec * rrfVec +
      ctx.weights.time * fresh +
      ctx.weights.conf * m.confidence +
      ctx.weights.graph * rrfGraph;

    const hit: RecallHit = {
      memory: m,
      score: Number(score.toFixed(6)),
      why: this.explain(rank, vRank, gRank, fresh, m.confidence, hl, ageDays, ctx.fuzzy, views),
      breakdown: {
        score: Number(score.toFixed(6)),
        textRank: rank,
        rrfText: Number(rrfText.toFixed(6)),
        vecRank: vRank,
        rrfVec: Number(rrfVec.toFixed(6)),
        graphRank: gRank,
        rrfGraph: Number(rrfGraph.toFixed(6)),
        graphPaths: views ? views.map((v) => `${v.from} --${v.predicate}--> ${v.to}`) : null,
        vecSim: vSim === null ? null : Number(vSim.toFixed(6)),
        freshness: Number(fresh.toFixed(6)),
        halfLifeDays: hl,
        ageDays: Number(Math.max(0, ageDays).toFixed(2)),
        confidence: m.confidence,
        evidenceCount: ctx.evidenceCounts.get(m.id) ?? 0,
        weights: ctx.weights,
      },
    };
    if (views) hit.relations = views;
    return hit;
  }

  /** 拼装 human-readable 入选理由 */
  private explain(
    rank: number | null,
    vecRank: number | null,
    graphRank: number | null,
    fresh: number,
    conf: number,
    hl: number,
    ageDays: number,
    fuzzy = false,
    views: RelationView[] | null = null,
  ): string {
    const parts: string[] = [];
    parts.push(
      rank === null
        ? "无全文排名"
        : fuzzy
          ? `字符模糊匹配第 ${rank} 名（bigram 未连续命中，read-path 兜底）`
          : `全文第 ${rank} 名`,
    );
    parts.push(vecRank === null ? "无向量分" : `向量第 ${vecRank} 名`);
    parts.push(
      graphRank === null
        ? "无关系分"
        : `关系第 ${graphRank} 名（${views?.[0] ? `${views[0].from} --${views[0].predicate}--> ${views[0].to}` : "命中关系"}）`,
    );
    parts.push(`新鲜度 ${(fresh * 100).toFixed(0)}%（${ageDays.toFixed(0)} 天 / 半衰期 ${hl} 天）`);
    parts.push(`置信度 ${(conf * 100).toFixed(0)}%`);
    return parts.join("，");
  }

  // ---------- Forget（遗忘） ----------

  /** 软删除：deleted=1、valid_to=at；history 留痕；asOf 删除前仍能查到 */
  forget(id: string): void {
    const at = this.now();
    this.storage.transaction(() => {
      this.storage.softDelete(id, at);
      this.storage.deleteEmbedding(id);
      // 忘掉这条记忆，就从图里摘掉它派生出来的关系（否则"关系"会替它说话）
      this.storage.closeRelationsForMemory(id, at);
      // 关联行也要清：实体本身留着（可能还被别的记忆引用），但"这条记忆提到谁"必须断干净
      this.storage.deleteMemoryEntities(id);
      this.storage.historyAppend(id, "forget", at, { reason: "用户主动遗忘" });
    });
  }

  // ---------- 查询辅助 ----------

  get(id: string): MemoryRecord | null {
    return this.storage.get(id);
  }

  /** 某条记忆的完整审计链 */
  history(id: string): HistoryEntry[] {
    return this.storage.historyFor(id);
  }

  /** 某条记忆的支撑证据（原文引用 + 观察时刻） */
  evidence(id: string): { quote: string; at: number }[] {
    return this.storage.evidenceFor(id);
  }

  /** 库况速览 */
  stats(): MembraneStats {
    return this.storage.stats();
  }

  // ---------- 备份：导出 / 导入 ----------

  /**
   * 全量导出（JSON 友好）。
   *
   * 导的是"库的全部真相"：含被取代、已遗忘的底稿与已关闭的关系边——
   * 只导现行记忆会让 asOf 历史查询在恢复后失灵。向量默认也带上，
   * 断网恢复不用重新花钱 embed；嫌文件大可以 includeEmbeddings:false。
   */
  exportAll(opts: { includeEmbeddings?: boolean } = {}): ExportBundle {
    const includeEmbeddings = opts.includeEmbeddings !== false;
    return {
      format: "membrane-backup",
      version: 1,
      exportedAt: this.now(),
      memories: this.storage.allMemories(),
      evidence: this.storage.allEvidence(),
      entities: this.storage.allEntities(),
      relations: this.storage.allRelations(),
      memoryEntities: this.storage.allMemoryEntities(),
      embeddings: includeEmbeddings
        ? [...this.storage.getAllEmbeddings()].map(([id, vec]) => ({
            id,
            vec: Array.from(vec),
          }))
        : [],
    };
  }

  /**
   * 导入前校验并归一化一条记忆。
   *
   * 备份文件是外部输入，不能假设它跟 exportAll 一样干净：
   * kind 可能是乱字符串、confidence 可能是 NaN/2、时间戳可能是字符串。
   * 这些值直接 insert 会污染库，或者让后续排序/时间过滤出现幽灵行为。
   */
  private normalizeImportRecord(rec: MemoryRecord): MemoryRecord {
    const kinds: MemoryKind[] = ["fact", "episode", "preference", "procedure"];
    if (!kinds.includes(rec.kind)) {
      throw new MembraneError("E_IMPORT_FORMAT", `记忆 ${rec.id} 的 kind 非法：${String(rec.kind)}`);
    }
    const confidence = Number(rec.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new MembraneError("E_IMPORT_FORMAT", `记忆 ${rec.id} 的 confidence 非法：${String(rec.confidence)}`);
    }
    const createdAt = Number(rec.createdAt);
    const updatedAt = Number(rec.updatedAt);
    const validFrom = Number(rec.validFrom);
    if (![createdAt, updatedAt, validFrom].every(Number.isFinite)) {
      throw new MembraneError("E_IMPORT_FORMAT", `记忆 ${rec.id} 的时间戳非法`);
    }
    const validTo = rec.validTo == null ? null : Number(rec.validTo);
    if (validTo !== null && !Number.isFinite(validTo)) {
      throw new MembraneError("E_IMPORT_FORMAT", `记忆 ${rec.id} 的 validTo 非法`);
    }
    let namespace: string;
    try {
      namespace = normalizeNamespace(rec.namespace);
    } catch {
      throw new MembraneError("E_IMPORT_FORMAT", `记忆 ${rec.id} 的 namespace 非法`);
    }
    return {
      ...rec,
      kind: rec.kind,
      content: String(rec.content),
      subject: rec.subject == null ? null : String(rec.subject),
      tags: Array.isArray(rec.tags) ? rec.tags.filter((x): x is string => typeof x === "string") : [],
      confidence,
      source: rec.source == null ? null : String(rec.source),
      namespace,
      createdAt,
      updatedAt,
      validFrom,
      validTo,
      supersededBy: rec.supersededBy == null ? null : String(rec.supersededBy),
      deleted: rec.deleted === true || Number(rec.deleted) === 1,
      pin: rec.pin === true || Number(rec.pin) === 1,
    };
  }

  /**
   * 导入备份（**幂等、不覆盖**）：已存在的记忆/关系按 id 跳过，
   * 所以同一份备份导入两次结果一致，也不会冲掉目标库里更新的数据。
   *
   * 实体按 (namespace, name) 复用：备份里的实体 id 与目标库不同时，
   * 关系边会自动改指向目标库已有实体的 id（否则会插出一堆断边）。
   */
  importAll(bundle: ExportBundle): ImportResult {
    if (!bundle || bundle.format !== "membrane-backup" || bundle.version !== 1) {
      throw new MembraneError(
        "E_IMPORT_FORMAT",
        "不是 Membrane 备份文件（需要 format=membrane-backup、version=1）。",
      );
    }
    // 先校验"给了的字段必须是数组"，再补缺省值——null 不能被 ?? 悄悄当成空数组
    for (const field of ["memories", "evidence", "entities", "relations", "memoryEntities", "embeddings"] as const) {
      const value = (bundle as unknown as Record<string, unknown>)[field];
      if (value !== undefined && !Array.isArray(value)) {
        throw new MembraneError("E_IMPORT_FORMAT", `备份字段 ${field} 不是数组，文件可能已损坏。`);
      }
    }
    const memories = bundle.memories ?? [];
    const evidence = bundle.evidence ?? [];
    const entities = bundle.entities ?? [];
    const relations = bundle.relations ?? [];
    const memoryEntities = bundle.memoryEntities ?? [];
    const embeddings = bundle.embeddings ?? [];

    const result: ImportResult = {
      memories: 0,
      entities: 0,
      relations: 0,
      embeddings: 0,
      skippedMemories: 0,
      skippedRelations: 0,
      skippedEmbeddings: 0,
    };
    const importedMemoryIds = new Set<string>();
    const entityIdMap = new Map<string, string>();
    let dims = this.storage.embeddingDims();

    this.storage.transaction(() => {
      for (const rec of memories) {
        if (!rec || typeof rec.id !== "string" || typeof rec.content !== "string") {
          throw new MembraneError("E_IMPORT_FORMAT", "备份里有记忆缺少 id 或 content，拒绝半截导入。");
        }
        if (this.storage.get(rec.id)) {
          result.skippedMemories++;
          continue;
        }
        this.storage.insert(this.normalizeImportRecord(rec));
        importedMemoryIds.add(rec.id);
        result.memories++;
      }

      // 证据按原观察时刻逐条还原（不能压成一个时间戳，否则"证据先后"就丢了）
      for (const e of evidence) {
        if (!e || !importedMemoryIds.has(e.memoryId)) continue;
        if (typeof e.quote === "string") this.storage.appendEvidence(e.memoryId, e.quote, Number(e.at) || 0);
      }

      for (const ent of entities) {
        if (!ent || typeof ent.name !== "string" || typeof ent.id !== "string") continue;
        const ns = ent.namespace ?? "default";
        const existing = this.storage.getEntityByName(ent.name, ns);
        if (existing) {
          entityIdMap.set(ent.id, existing.id);
          continue;
        }
        this.storage.insertEntity({ ...ent, namespace: ns });
        entityIdMap.set(ent.id, ent.id);
        result.entities++;
      }

      for (const rel of relations) {
        if (!rel || typeof rel.id !== "string") continue;
        if (this.storage.hasRelation(rel.id)) {
          result.skippedRelations++;
          continue;
        }
        const fromId = entityIdMap.get(rel.fromId);
        const toId = entityIdMap.get(rel.toId);
        if (!fromId || !toId) continue; // 端点实体缺失：宁可不导，也不插断边
        this.storage.insertRelation({ ...rel, fromId, toId });
        result.relations++;
      }

      for (const link of memoryEntities) {
        if (!link || !importedMemoryIds.has(link.memoryId)) continue;
        const entityId = entityIdMap.get(link.entityId);
        if (entityId) this.storage.linkMemoryEntity(link.memoryId, entityId);
      }

      for (const emb of embeddings) {
        if (!emb || !importedMemoryIds.has(emb.id) || !Array.isArray(emb.vec)) continue;
        // 任何非有限数（NaN/Infinity/字符串）都整条拒绝，绝不静默 filter 成低维后入库
        if (!emb.vec.every((x) => typeof x === "number" && Number.isFinite(x))) {
          result.skippedEmbeddings++;
          continue;
        }
        const vec = new Float32Array(emb.vec);
        if (vec.length === 0) continue;
        if (dims.size > 0 && !dims.has(vec.length)) {
          result.skippedEmbeddings++;
          continue;
        }
        this.storage.upsertEmbedding(emb.id, vec);
        dims = new Map([...dims, [vec.length, (dims.get(vec.length) ?? 0) + 1]]);
        result.embeddings++;
      }
    });
    return result;
  }

  /** 列出记忆（转发 Storage） */
  list(options: Parameters<Storage["list"]>[0] = {}): MemoryRecord[] {
    return this.storage.list(options);
  }
}
