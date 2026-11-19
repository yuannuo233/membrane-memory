/**
 * 模型与校验（DESIGN.md 第 3 节）。
 *
 * 原则：非法输入一律在写入前拦下并给出中文错误信息——宁可报错，不写脏数据。
 * 错误码以 `E_` 前缀，CLI/REST/MCP 层可直接把它映射为退出码/HTTP 状态码。
 */
import { ENTITY_TYPES, MEMORY_KINDS, type AddInput, type EntityType, type MemoryKind, type MemoryRecord } from "./types.js";

/** 正文长度上限（防呆：SQLite 存 TEXT 没问题，但几十 MB 的"记忆"显然是调用错了） */
export const MAX_CONTENT_LENGTH = 100_000;
/** 主语长度上限 */
export const MAX_SUBJECT_LENGTH = 512;

/** Membrane 统一错误基类：code 用于程序判断，message 面向人类（中文） */
export class MembraneError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MembraneError";
    this.code = code;
  }
}

/** 参数校验失败 */
export class ValidationError extends MembraneError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ValidationError";
  }
}

/**
 * 校验 kind 枚举。
 * @throws ValidationError E_KIND
 */
export function validateKind(kind: string): asserts kind is MemoryKind {
  if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
    throw new ValidationError(
      "E_KIND",
      `kind 必须是 ${MEMORY_KINDS.join(" / ")} 之一，收到：${JSON.stringify(kind)}`,
    );
  }
}

/**
 * 校验 content：非空字符串（trim 后非空）、不超长。
 * @throws ValidationError E_CONTENT
 */
export function validateContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new ValidationError("E_CONTENT", `content 必须是字符串，收到：${typeof content}`);
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("E_CONTENT", "content 不能为空（空白字符也不算）");
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new ValidationError(
      "E_CONTENT",
      `content 超长：${trimmed.length} 字符，上限 ${MAX_CONTENT_LENGTH}`,
    );
  }
  return trimmed;
}

/**
 * 校验 confidence：0~1 之间的有限数字。
 * @throws ValidationError E_CONFIDENCE
 */
export function validateConfidence(confidence: unknown): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new ValidationError("E_CONFIDENCE", `confidence 必须是 0~1 的数字，收到：${String(confidence)}`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new ValidationError("E_CONFIDENCE", `confidence 必须在 0~1 之间，收到：${confidence}`);
  }
  return confidence;
}

/**
 * 校验时间戳：正的有限整数（unix ms）。
 * @throws ValidationError E_TIME
 */
export function validateTimestamp(ts: unknown, label: string): number {
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
    throw new ValidationError(
      "E_TIME",
      `${label} 必须是正整数 unix 毫秒时间戳，收到：${String(ts)}`,
    );
  }
  return ts;
}

/**
 * 归一化 tags：字符串数组 → 去首尾空白 → 去空 → 去重（保序）。
 * @throws ValidationError E_TAGS
 */
export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    throw new ValidationError("E_TAGS", `tags 必须是字符串数组，收到：${typeof tags}`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") {
      throw new ValidationError("E_TAGS", `tags 里的每一项都必须是字符串，收到：${typeof t}`);
    }
    const v = t.trim();
    if (v.length === 0) continue;
    if (v.length > MAX_SUBJECT_LENGTH) {
      throw new ValidationError("E_TAGS", `单个 tag 超长（>${MAX_SUBJECT_LENGTH} 字符）`);
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * 归一化 subject：空 → null；超长报错。
 * @throws ValidationError E_SUBJECT
 */
export function normalizeSubject(subject: unknown): string | null {
  if (subject === undefined || subject === null) return null;
  if (typeof subject !== "string") {
    throw new ValidationError("E_SUBJECT", `subject 必须是字符串或 null，收到：${typeof subject}`);
  }
  const v = subject.trim();
  if (v.length === 0) return null;
  if (v.length > MAX_SUBJECT_LENGTH) {
    throw new ValidationError("E_SUBJECT", `subject 超长：${v.length} 字符，上限 ${MAX_SUBJECT_LENGTH}`);
  }
  return v;
}

/**
 * 把 AddInput 校验并归一化成可直接入库的字段（不含 id/created_at 等存储字段）。
 * 这是 Ingest 的第一道门：所有接入面（CLI/REST/MCP）都经由它校验，行为一致。
 */
export function normalizeAddInput(input: AddInput, defaults: { at: number; source?: string | null }): {
  content: string;
  kind: MemoryKind;
  subject: string | null;
  tags: string[];
  confidence: number;
  source: string | null;
  pin: boolean;
  validFrom: number;
  at: number;
} {
  const at = validateTimestamp(input.at ?? defaults.at, "at");
  const validFrom = validateTimestamp(input.validFrom ?? at, "validFrom");
  const content = validateContent(input.content);
  const kind = input.kind === undefined || input.kind === null ? "fact" : input.kind;
  validateKind(kind);
  return {
    content,
    kind,
    subject: normalizeSubject(input.subject),
    tags: normalizeTags(input.tags),
    confidence: validateConfidence(input.confidence ?? 1),
    source:
      input.source === undefined
        ? (defaults.source ?? null)
        : normalizeSubject(input.source), // source 与 subject 同样的字符串规则，复用校验
    pin: input.pin === true,
    validFrom,
    at,
  };
}

/** 命名空间长度上限 */
export const MAX_NAMESPACE_LENGTH = 128;
/** 默认命名空间 */
export const DEFAULT_NAMESPACE = "default";

/**
 * 归一化命名空间：空 → "default"；只允许字母数字下划线连字符（防止注入/混乱）。
 * @throws ValidationError E_NAMESPACE
 */
export function normalizeNamespace(ns: unknown): string {
  if (ns === undefined || ns === null) return DEFAULT_NAMESPACE;
  if (typeof ns !== "string") {
    throw new ValidationError("E_NAMESPACE", `namespace 必须是字符串，收到：${typeof ns}`);
  }
  const v = ns.trim();
  if (v.length === 0) return DEFAULT_NAMESPACE;
  if (v.length > MAX_NAMESPACE_LENGTH) {
    throw new ValidationError("E_NAMESPACE", `namespace 超长（>${MAX_NAMESPACE_LENGTH} 字符）`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new ValidationError("E_NAMESPACE", `namespace 只能含字母/数字/下划线/连字符，收到：${v}`);
  }
  return v;
}

/**
 * 归一化用于"完全相同"判断的内容键：小写、压缩空白。
 * 去重是"同一句话说两遍"不重复入库，不是语义判断（语义归冲突检测管）。
 */
export function contentKey(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 实体名长度上限（再长基本不是实体，是整句话了） */
export const MAX_ENTITY_NAME_LENGTH = 64;
/** 关系谓词长度上限 */
export const MAX_PREDICATE_LENGTH = 64;

/**
 * 校验实体类型：非法值一律按 unknown 处理（图检索是"尽量别丢信息"，
 * 一个类型写错不该让整条关系写不进去）。
 */
export function normalizeEntityType(v: unknown): EntityType {
  if (typeof v !== "string") return "unknown";
  const t = v.trim().toLowerCase();
  return (ENTITY_TYPES as readonly string[]).includes(t) ? (t as EntityType) : "unknown";
}

/**
 * 归一化实体名：去首尾空白、压空白；空或超长报错。
 * 这里**不**做大小写归一——拉丁实体名保留原样显示，比较时统一 lowercase。
 * @throws ValidationError E_ENTITY
 */
export function normalizeEntityName(v: unknown, label = "实体名"): string {
  if (typeof v !== "string") {
    throw new ValidationError("E_ENTITY", `${label}必须是字符串，收到：${typeof v}`);
  }
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length === 0) throw new ValidationError("E_ENTITY", `${label}不能为空`);
  if (s.length > MAX_ENTITY_NAME_LENGTH) {
    throw new ValidationError("E_ENTITY", `${label}超长（>${MAX_ENTITY_NAME_LENGTH} 字符）：${s.slice(0, 20)}…`);
  }
  return s;
}

/** 归一化关系谓词（如"同学"/"住在"） */
export function normalizePredicate(v: unknown): string {
  if (typeof v !== "string") {
    throw new ValidationError("E_PREDICATE", `关系谓词必须是字符串，收到：${typeof v}`);
  }
  const s = v.trim();
  if (s.length === 0) throw new ValidationError("E_PREDICATE", "关系谓词不能为空");
  if (s.length > MAX_PREDICATE_LENGTH) {
    throw new ValidationError("E_PREDICATE", `关系谓词超长（>${MAX_PREDICATE_LENGTH} 字符）`);
  }
  return s;
}

/**
 * 归一化向量：Float32Array 或 number[]（REST/MCP 传 JSON 数组）→ Float32Array。
 * 非法（含 NaN/Infinity、空数组）返回 null，由调用方决定是跳过还是报错——
 * **向量算失败/传错绝不能阻断写入**，这是零依赖底线的延伸。
 */
export function normalizeVec(v: unknown): Float32Array | null {
  if (v instanceof Float32Array) {
    if (v.length === 0) return null;
    for (const x of v) if (!Number.isFinite(x)) return null;
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    for (const x of v) if (typeof x !== "number" || !Number.isFinite(x)) return null;
    return new Float32Array(v as number[]);
  }
  return null;
}

/** 数据库原始行（node:sqlite 返回 unknown 键值） */
export type Row = Record<string, unknown>;/** 由数据库行还原领域对象（tags JSON 解析失败时降级为空数组，不让一条脏行炸掉整个库） */
export function rowToRecord(row: Row): MemoryRecord {
  let tags: string[] = [];
  const rawTags = row["tags"];
  if (typeof rawTags === "string" && rawTags.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawTags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      tags = [];
    }
  }
  return {
    id: String(row["id"]),
    kind: row["kind"] as MemoryKind,
    content: String(row["content"]),
    subject: row["subject"] == null ? null : String(row["subject"]),
    tags,
    confidence: Number(row["confidence"]),
    source: row["source"] == null ? null : String(row["source"]),
    namespace: row["namespace"] == null ? "default" : String(row["namespace"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    validFrom: Number(row["valid_from"]),
    validTo: row["valid_to"] == null ? null : Number(row["valid_to"]),
    supersededBy: row["superseded_by"] == null ? null : String(row["superseded_by"]),
    deleted: Number(row["deleted"]) !== 0,
    pin: Number(row["pin"]) !== 0,
  };
}

/** 批量行 → 领域对象（消除各处的 `as Record<string, unknown>[]).map(rowToRecord)` 样板） */
export function toRecords(rows: unknown[]): MemoryRecord[] {
  return (rows as Row[]).map(rowToRecord);
}
