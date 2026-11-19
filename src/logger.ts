/**
 * 结构化运行日志（运维后台用）。
 *
 * 设计底线：
 * 1. 默认落盘为 JSONL，一行一个事件，方便 `tail` / `jq` / 日志采集；
 * 2. 内存里保留最近 N 条，后台页面不必读整个文件；
 * 3. **绝不记录记忆正文、查询词、证据原文、请求体**——只记请求元数据与错误码；
 * 4. 写盘失败不阻断服务：把错误记在 `fileError` 上，后台可见。
 *
 * 这不是业务审计链（那是每个 memory 的 history 表）；这里是"服务最近发生了什么"。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { info: 1, warn: 2, error: 3 };

/** 日志事件（扁平结构，避免把整个对象图写进日志） */
export interface LogEntry {
  ts: number;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

/** 这些字段名一律拒绝写入，防止调用方手滑把正文/查询/证据带进日志 */
const FORBIDDEN_KEYS = new Set([
  "content",
  "query",
  "body",
  "evidence",
  "quote",
  "memory",
  "memories",
  "prompt",
  "authorization",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
]);

/** 单字段最大长度，防止异常堆栈/路径把一行日志撑爆 */
const MAX_FIELD_CHARS = 500;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      out[key] = value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) + "…" : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else {
      // 对象/数组不展开，避免嵌套里混入正文
      out[key] = "[object]";
    }
  }
  return out;
}

export interface MemoryLoggerOptions {
  /** JSONL 文件路径；undefined=只留内存（测试/临时服务） */
  path?: string;
  /** 内存里最多保留多少条，默认 500 */
  maxEntries?: number;
  /** 低于该级别不记录，默认 info */
  minLevel?: LogLevel;
}

export class MemoryLogger {
  /** 日志文件路径；null=只写内存 */
  readonly path: string | null;
  private readonly maxEntries: number;
  private readonly minLevel: LogLevel;
  private ring: LogEntry[] = [];
  private written = 0;
  private dropped = 0;
  private fileError: string | null = null;

  constructor(opts: MemoryLoggerOptions = {}) {
    this.path = opts.path ?? null;
    this.maxEntries = Math.max(10, opts.maxEntries ?? 500);
    this.minLevel = opts.minLevel ?? "info";
    if (this.path) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch (err) {
        this.fileError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /** 写一条日志；字段会经过脱敏与截断 */
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      ...sanitize(fields),
      ts: Date.now(),
      level,
      event,
    };
    this.ring.push(entry);
    if (this.ring.length > this.maxEntries) {
      this.ring.shift();
      this.dropped++;
    }
    if (!this.path) return;
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
      this.written++;
    } catch (err) {
      // 只在第一次记错误，避免每个请求都产生一条失败日志
      if (!this.fileError) this.fileError = err instanceof Error ? err.message : String(err);
    }
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.log("error", event, fields);
  }

  /** 最近 N 条（按时间升序）；level=只返回该级别及以上 */
  tail(limit = 100, level?: LogLevel): LogEntry[] {
    const min = level ? LEVEL_ORDER[level] : 0;
    const filtered = this.ring.filter((e) => LEVEL_ORDER[e.level] >= min);
    return filtered.slice(-Math.max(0, limit)).map((e) => ({ ...e }));
  }

  /** 后台诊断用计数 */
  stats(): {
    path: string | null;
    buffered: number;
    written: number;
    dropped: number;
    fileError: string | null;
    maxEntries: number;
  } {
    return {
      path: this.path,
      buffered: this.ring.length,
      written: this.written,
      dropped: this.dropped,
      fileError: this.fileError,
      maxEntries: this.maxEntries,
    };
  }
}
