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
import { Storage, type FtsHit } from "./storage.js";
import {
  MembraneError,
  contentKey,
  normalizeAddInput,
  normalizeNamespace,
} from "./model.js";
import { charCoverage, containment, tokenSet } from "./tokenize.js";
import { createMonotonicUlid } from "./ulid.js";
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
  HistoryEntry,
  LlmConfig,
  MembraneOptions,
  MembraneStats,
  MemoryKind,
  MemoryRecord,
  RecallHit,
  BriefHit,
  RecallOptions,
  RecallWeights,
  ScoreBreakdown,
} from "./types.js";

/** 配置解析后的内部形态（权重/半衰期/策略都填了默认值） */
interface ResolvedConfig {
  weights: RecallWeights;
  halfLives: Record<MemoryKind, number>;
  conflictPolicy: ConflictPolicy;
  candidateFactor: number;
  now: () => number;
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
 * 无向量分量时重新归一化权重：把 vec 的权重按比例摊给其余三项，三者和=1。
 * 保证分数上界恒为 1.0（可跨库比较），而不是被 vec 的 0 分拉低。
 */
export function renormalizeWithoutVec(w: RecallWeights): RecallWeights {
  const rest = w.text + w.time + w.conf;
  if (rest <= 0) return { text: 1 / 3, vec: 0, time: 1 / 3, conf: 1 / 3 };
  const k = 1 / rest;
  return { text: w.text * k, vec: 0, time: w.time * k, conf: w.conf * k };
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
   * 流程：校验 → 完全相同去重 → (subject,kind) 内冲突检测 → 按策略处理 → 入库 → history 留痕。
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

    // 3) 构造新记忆
    const id = this.newId(at);
    const rec: MemoryRecord = {
      id,
      kind: norm.kind,
      content: norm.content,
      subject: norm.subject,
      tags: norm.tags,
      confidence: norm.confidence,
      source: norm.source,
      namespace: ns,
      createdAt: at,
      updatedAt: at,
      validFrom: norm.validFrom,
      validTo: null,
      supersededBy: null,
      deleted: false,
      pin: norm.pin,
    };

    const supersededList: MemoryRecord[] = [];
    const keptBothList: MemoryRecord[] = [];
    let status: AddStatus = "created";
    let note = "新记忆已写入。";

    this.storage.transaction(() => {
      this.storage.insert(rec);
      if (input.evidence && input.evidence.length > 0) {
        this.storage.evidenceReplace(id, input.evidence, at);
      }
      this.storage.historyAppend(id, "add", at, {
        kind: norm.kind,
        subject: norm.subject,
        source: norm.source,
        evidenceCount: input.evidence?.length ?? 0,
      });
      const applied = this.applyConflictPolicy(id, conflicts, at);
      supersededList.push(...applied.superseded);
      keptBothList.push(...applied.keptBoth);
      status = applied.status;
      note = applied.note;
    });

    if (pinnedConflict.length > 0) {
      note += ` ⚠️ 与钉选记忆冲突（${pinnedConflict.map((m) => m.id).join(", ")}），未自动取代，请人工处理。`;
    }

    return { status, memory: rec, superseded: supersededList, keptBoth: keptBothList, note };
  }

  /** 冲突检测：把现行同 (subject,kind) 记忆按相似度分三带 */
  private detectConflicts(
    content: string,
    current: MemoryRecord[],
  ): { high: MemoryRecord[]; mid: MemoryRecord[]; pinned: MemoryRecord[]; sim: (m: MemoryRecord) => number } {
    const newSet = tokenSet(content);
    const sim = (m: MemoryRecord): number => containment(newSet, tokenSet(m.content));
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
   * read-path 模糊召回：FTS 的 bigram 没命中时，用字符覆盖率扫现行记忆。
   * 尊重 asOf / kind / subject 过滤（与 searchFtsOnce 的过滤语义一致）。
   * 返回的 bm25 字段存覆盖率的负值（-coverage），供通用排序逻辑复用。
   */
  private fuzzyRecall(options: RecallOptions, poolSize: number, namespace = "default"): FtsHit[] {
    const all = this.storage.list({ validity: "current", namespace }); // 现行有效（未删、valid_to NULL）
    const scored: FtsHit[] = [];
    for (const rec of all) {
      if (options.kind && rec.kind !== options.kind) continue;
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(rec.kind)) continue;
      if (options.subject !== undefined && rec.subject !== options.subject) continue;
      if (options.asOf !== undefined && rec.validFrom > options.asOf) continue;
      const cov = charCoverage(options.query, rec.content);
      // 阈值 0.5：查询至少一半字符/词能在记忆里找到，才认定模糊命中。
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
   * 权重归一化：未传 queryVec 时（无向量分量），把 vec 的权重按比例摊到其余三项，
   * 使三项权重和为 1。这样分数上界仍是 1.0，跨库/跨配置可比；
   * 若直接让 vec×0 丢掉，满分只能拿到 weights.text+time+conf，分数会被绝对压低。
   */
  recall(options: RecallOptions): RecallHit[] {
    const limit = options.limit && options.limit > 0 ? options.limit : 8;
    const raw: RecallWeights = { ...this.cfg.weights, ...(options.weights ?? {}) };
    const weights = options.queryVec ? raw : renormalizeWithoutVec(raw);
    const now = options.asOf ?? this.now();
    const poolSize = limit * this.cfg.candidateFactor;

    // 1) 候选召回（FTS5 优先，未命中降级 read-path 模糊匹配）
    const { hits: ftsHits, fuzzy } = this.gatherCandidates(options, poolSize);
    if (ftsHits.length === 0) return [];

    // 2) 排名映射（bm25 越负越相关；fuzzy 时已按覆盖率排好）
    const ordered = fuzzy ? ftsHits : [...ftsHits].sort((a, b) => a.bm25 - b.bm25);
    const textRank = rankMap(ordered.map((h) => h.record.id));

    // 3) 可选向量增强（无 queryVec 时整块跳过，保持零依赖）
    const { sims, vecRank } = this.gatherVectors(ftsHits, options.queryVec);

    // 4) 逐条打分（证据计数一次性取，避免 N+1 查询）
    const evidenceCounts = this.storage.evidenceCountAll();
    const hits: RecallHit[] = ftsHits.map((h) => this.scoreHit(h, { textRank, sims, vecRank, evidenceCounts, weights, now, fuzzy }));

    // 5) 按总分降序，取 topK
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * 候选召回（多路并联）：
   *  1) FTS5 BM25 全文路
   *  2) 有 queryVec 时，向量路也**独立产生候选**（不是只给词面候选重排）——
   *     否则"语义相近但用词不同"的记忆永远进不了候选池，混合检索名不副实。
   *  3) 全文两路都空时，才降级到字符覆盖率兜底
   */
  private gatherCandidates(options: RecallOptions, poolSize: number): { hits: FtsHit[]; fuzzy: boolean } {
    const ns = normalizeNamespace(options.namespace);
    const ftsHits = this.storage.searchFts(options.query, {
      limit: poolSize,
      asOf: options.asOf,
      kind: options.kind,
      kinds: options.kinds,
      subject: options.subject,
      namespace: ns,
    });

    // 向量路：按余弦取 topK，与全文候选取并集
    const vecHits = options.queryVec
      ? this.vectorCandidates(options, poolSize, ns, new Set(ftsHits.map((h) => h.record.id)))
      : [];

    if (ftsHits.length > 0 || vecHits.length > 0) {
      return { hits: [...ftsHits, ...vecHits], fuzzy: false };
    }
    return { hits: this.fuzzyRecall(options, poolSize, ns), fuzzy: true };
  }

  /**
   * 向量路候选发现：扫当前命名空间下的向量，按余弦取前 poolSize 条。
   * 已在全文候选中出现的记忆跳过（避免重复，排名由 RRF 融合决定）。
   *
   * 性能：一次性取该命名空间的现行记忆建索引，避免每条向量单独 get（N+1）。
   */
  private vectorCandidates(
    options: RecallOptions,
    poolSize: number,
    namespace: string,
    exclude: Set<string>,
  ): FtsHit[] {
    const qv = options.queryVec;
    if (!qv) return [];
    const vecMap = this.storage.getAllEmbeddings();
    if (vecMap.size === 0) return [];

    // 一次查询拿到候选范围内的全部现行记忆，供后续过滤（避免 N+1）
    const pool = this.storage.list({
      validity: "current",
      namespace,
      kind: options.kind,
      subject: options.subject,
    });
    const byId = new Map(pool.map((r) => [r.id, r]));

    const scored: { record: MemoryRecord; sim: number }[] = [];
    for (const [id, vec] of vecMap) {
      if (exclude.has(id)) continue;
      const rec = byId.get(id);
      if (!rec) continue; // 不在候选范围（已删/被取代/跨命名空间/kind 不符）
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(rec.kind)) continue;
      if (options.asOf !== undefined && rec.validFrom > options.asOf) continue;
      scored.push({ record: rec, sim: cosine(qv, vec) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    // bm25 字段复用为 -sim（越相似越负 → 通用排序里越靠前）
    return scored.slice(0, poolSize).map((s) => ({ record: s.record, bm25: -s.sim }));
  }

  /** 可选向量增强：为**全部候选**（含向量路发现的）算余弦与排名；无 queryVec 时返回空表 */
  private gatherVectors(
    ftsHits: FtsHit[],
    queryVec: Float32Array | undefined,
  ): { sims: Map<string, number>; vecRank: Map<string, number> } {
    const sims = new Map<string, number>();
    if (!queryVec) return { sims, vecRank: new Map() };
    const vecMap = this.storage.getAllEmbeddings();
    for (const h of ftsHits) {
      const v = vecMap.get(h.record.id);
      if (v) sims.set(h.record.id, cosine(queryVec, v));
    }
    const sorted = [...sims.entries()].sort((a, b) => b[1] - a[1]);
    return { sims, vecRank: rankMap(sorted.map(([id]) => id)) };
  }

  /** 单条命中打分 + 分数明细 + why */
  private scoreHit(
    h: FtsHit,
    ctx: {
      textRank: Map<string, number>;
      sims: Map<string, number>;
      vecRank: Map<string, number>;
      evidenceCounts: Map<string, number>;
      weights: RecallWeights;
      now: number;
      fuzzy: boolean;
    },
  ): RecallHit {
    const m = h.record;
    const rank = ctx.textRank.get(m.id) ?? null;
    const vRank = ctx.vecRank.get(m.id) ?? null;
    const vSim = ctx.sims.get(m.id) ?? null;
    const rrfText = rrfNormalized(rank);
    const rrfVec = rrfNormalized(vRank);
    const ageDays = (ctx.now - m.validFrom) / 86_400_000;
    const hl = this.cfg.halfLives[m.kind];
    const fresh = freshness(ageDays, hl);
    const score =
      ctx.weights.text * rrfText +
      ctx.weights.vec * rrfVec +
      ctx.weights.time * fresh +
      ctx.weights.conf * m.confidence;

    return {
      memory: m,
      score: Number(score.toFixed(6)),
      why: this.explain(rank, vRank, fresh, m.confidence, hl, ageDays, ctx.fuzzy),
      breakdown: {
        score: Number(score.toFixed(6)),
        textRank: rank,
        rrfText: Number(rrfText.toFixed(6)),
        vecRank: vRank,
        rrfVec: Number(rrfVec.toFixed(6)),
        vecSim: vSim === null ? null : Number(vSim.toFixed(6)),
        freshness: Number(fresh.toFixed(6)),
        halfLifeDays: hl,
        ageDays: Number(Math.max(0, ageDays).toFixed(2)),
        confidence: m.confidence,
        evidenceCount: ctx.evidenceCounts.get(m.id) ?? 0,
        weights: ctx.weights,
      },
    };
  }

  /** 拼装 human-readable 入选理由 */
  private explain(
    rank: number | null,
    vecRank: number | null,
    fresh: number,
    conf: number,
    hl: number,
    ageDays: number,
    fuzzy = false,
  ): string {
    const parts: string[] = [];
    parts.push(
      rank === null
        ? "无排名"
        : fuzzy
          ? `字符模糊匹配第 ${rank} 名（bigram 未连续命中，read-path 兜底）`
          : `全文第 ${rank} 名`,
    );
    parts.push(vecRank === null ? "无向量分" : `向量第 ${vecRank} 名`);
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

  /** 列出记忆（转发 Storage） */
  list(options: Parameters<Storage["list"]>[0] = {}): MemoryRecord[] {
    return this.storage.list(options);
  }
}
