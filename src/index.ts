/**
 * Membrane SDK 出口（ESM + 类型，DESIGN.md 第 6 节第三个门）。
 *
 * 用法：
 *   import { Membrane } from "membrane-memory";
 *
 * 导出地基件（类型 / 校验 / 存储 / 分词）与 Membrane 门面。
 */
export * from "./types.js";
export {
  MembraneError,
  ValidationError,
  validateKind,
  validateContent,
  validateConfidence,
  validateTimestamp,
  normalizeTags,
  normalizeSubject,
  normalizeAddInput,
  contentKey,
  MAX_CONTENT_LENGTH,
  MAX_SUBJECT_LENGTH,
} from "./model.js";
export { Storage } from "./storage.js";
export type { FtsHit, FtsSearchOptions, ListOptions, ListValidity } from "./storage.js";
export { Membrane, cosine, rrfNormalized, freshness } from "./engine.js";
export { extract, embed, parseCandidates, EXTRACT_SYSTEM_PROMPT } from "./extract.js";
export type { FetchLike } from "./extract.js";
export { startServer, route } from "./server.js";
export type { ServerOptions } from "./server.js";
export { handleLine } from "./mcp.js";
export { runDoctor, formatDoctorReport, writeDoctorReport } from "./doctor.js";
export type { DoctorReport } from "./doctor.js";
export { tokenize, tokenizeQuery, buildFtsQuery, tokenSet, containment } from "./tokenize.js";
export { ulid, createMonotonicUlid } from "./ulid.js";
export {
  DEFAULT_WEIGHTS,
  DEFAULT_HALF_LIVES,
  DEFAULT_CONFLICT_THRESHOLDS,
} from "./config.js";
