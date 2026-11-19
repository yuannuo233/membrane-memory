/**
 * 接入面共用的入参解析（CLI / MCP / REST 三家同一套口径）。
 *
 * 为什么要这一层：三个接入面的原始入参形态完全不同——
 *   - CLI 全是字符串（`--limit 5` 给的是 "5"）
 *   - MCP 是 JSON（数字就是数字）
 *   - REST 的 POST 是 JSON，GET 的 query 又全是字符串
 * 之前每个文件各写一套 `parseKind / parseEntityType / parseRelations`，
 * 改一处忘一处就会"REST 生效、MCP 不生效"这种口径漂移（v0.2 的 `?limit=` 失效就是这么来的）。
 *
 * 原则：**宽进严出**——这里负责把"看起来像"的值收进来，
 * 真正的合法性仍由 engine/model.ts 校验（脏值该报错还是报错）。
 */
import {
  ENTITY_TYPES,
  MEMORY_KINDS,
  type EntityInput,
  type EntityType,
  type MemoryKind,
  type RelationInput,
} from "./types.js";

/** 取字符串；非字符串或空串 → undefined */
export function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/**
 * 取有限数字：兼容 number 与数字字符串（GET query 全是字符串）。
 * 非数字 / 空 / NaN / Infinity → undefined。
 */
export function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 取布尔；只认真正的 boolean（字符串 "false" 不当 false，避免歧义） */
export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** 取字符串数组（非字符串项丢弃；全被丢掉时返回 undefined） */
export function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/** 取数字数组（向量用；非数字项丢弃） */
export function asNumberArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return out.length > 0 ? out : undefined;
}

/** 取 kind（非法值当未指定，交给引擎用默认 fact） */
export function asKind(v: unknown): MemoryKind | undefined {
  return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v)
    ? (v as MemoryKind)
    : undefined;
}

/** 取 kind 数组（多选过滤） */
export function asKinds(v: unknown): MemoryKind[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is MemoryKind => asKind(x) !== undefined);
  return out.length > 0 ? out : undefined;
}

/** 取实体类型（非法值当未指定，交给 normalizeEntityType 处理） */
export function asEntityType(v: unknown): EntityType | undefined {
  return typeof v === "string" && (ENTITY_TYPES as readonly string[]).includes(v)
    ? (v as EntityType)
    : undefined;
}

/**
 * 解析实体标注数组：支持两种写法
 *   ["李四", { name: "腾讯", type: "org" }]
 * 脏项丢弃（不因为一条写错拒掉整条记忆），全空返回 undefined。
 */
export function asEntityInputs(v: unknown): EntityInput[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: EntityInput[] = [];
  for (const raw of v) {
    if (typeof raw === "string") {
      const name = asString(raw);
      if (name) out.push({ name });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const name = asString(o["name"]);
    if (!name) continue;
    out.push({ name, type: asEntityType(o["type"]) });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 解析手动标注的关系数组。
 * 缺少 to / predicate 的项直接丢弃——一条关系写错不该让整条记忆写不进去。
 */
export function asRelationInputs(v: unknown): RelationInput[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RelationInput[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const to = asString(o["to"]);
    const predicate = asString(o["predicate"]);
    if (!to || !predicate) continue;
    out.push({
      from: asString(o["from"]),
      fromType: asEntityType(o["fromType"]),
      to,
      toType: asEntityType(o["toType"]),
      predicate,
      confidence: asFiniteNumber(o["confidence"]),
    });
  }
  return out.length > 0 ? out : undefined;
}
