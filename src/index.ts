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
  normalizeVec,
  normalizeEntityType,
  normalizeEntityName,
  normalizePredicate,
  contentKey,
  MAX_CONTENT_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_ENTITY_NAME_LENGTH,
  MAX_PREDICATE_LENGTH,
} from "./model.js";
export { Storage } from "./storage.js";
export type { FtsHit, FtsSearchOptions, ListOptions, ListValidity, VectorScanOptions } from "./storage.js";
export { Membrane, cosine, rrfNormalized, freshness, normalizeWeights } from "./engine.js";
export { extract, embed, parseCandidates, EXTRACT_SYSTEM_PROMPT } from "./extract.js";
export type { FetchLike } from "./extract.js";
export { embedText, llmFromEnv, postJson } from "./llm.js";
export { extractGraph, cleanEntityName, inferEntityType } from "./graph-extract.js";
export type { RuleEntity, RuleRelation } from "./graph-extract.js";
export { startServer, route } from "./server.js";
export type { ServerOptions, RouteContext } from "./server.js";
export { MemoryLogger } from "./logger.js";
export type { MemoryLoggerOptions, LogEntry, LogLevel } from "./logger.js";
export { probeTaskIsolation } from "./isolation.js";
export type { IsolationProbeResult } from "./isolation.js";
export { buildMcpConfig, MCP_CLIENTS } from "./mcp-config.js";
export type { McpClientId, McpClientSpec, McpConfigFormat, McpConfigOptions, McpConfigResult } from "./mcp-config.js";
export { handleLine } from "./mcp.js";
export { runDoctor, formatDoctorReport, writeDoctorReport } from "./doctor.js";
export type { DoctorReport } from "./doctor.js";
export { tokenize, tokenizeQuery, buildFtsQuery, tokenSet, tokenOverlap } from "./tokenize.js";
export { createMonotonicUlid } from "./ulid.js";
export {
  DEFAULT_WEIGHTS,
  DEFAULT_HALF_LIVES,
  DEFAULT_CONFLICT_THRESHOLDS,
} from "./config.js";
