/**
 * 可选的 LLM / embedding 客户端（OpenAI 兼容端点）。
 *
 * 为什么单独一个文件：extract.ts（抽取）和 engine.ts（写入时算向量）都要调外部 API，
 * 如果放在 extract.ts 里就会让 engine → extract → engine 形成循环依赖。
 * 这里只依赖 types.ts，谁都可以安全引用。
 *
 * 零依赖底线：不配 llm 时本文件的所有函数都返回 null / 抛明确中文错误，
 * add / recall / 全文检索完全不受影响。
 */
import { MembraneError } from "./model.js";
import type { LlmConfig } from "./types.js";

/** 可注入的 fetch 签名（与全局 fetch 兼容；单测不打真网络） */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** 统一的 OpenAI 兼容 POST 调用（拼路径、Bearer 鉴权、错误码、超时） */
export async function postJson(
  llm: LlmConfig,
  path: string,
  body: unknown,
  errCode: string,
  doFetch: FetchLike,
  timeoutMs?: number,
): Promise<unknown> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new MembraneError(errCode, `LLM 端点返回 HTTP ${resp.status}`);
    return JSON.parse(await resp.text());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 算一段文本的向量。
 * - 没配 embeddingModel → 返回 null（调用方据此降级为纯全文，不算错误）
 * - 端点失败 → 抛 MembraneError（调用方必须 catch：向量算不出来不能影响写记忆）
 */
export async function embedText(
  llm: LlmConfig | undefined,
  text: string,
  opts: { injectFetch?: FetchLike; timeoutMs?: number } = {},
): Promise<Float32Array | null> {
  if (!llm?.embeddingModel) return null;
  const doFetch = opts.injectFetch ?? (globalThis.fetch as unknown as FetchLike);
  const payload = (await postJson(
    llm,
    "/embeddings",
    { model: llm.embeddingModel, input: text },
    "E_EMBED_HTTP",
    doFetch,
    opts.timeoutMs ?? llm.timeoutMs ?? 30_000,
  )) as { data?: { embedding?: number[] }[] };
  const vec = payload.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) return null;
  return new Float32Array(vec);
}

/**
 * 从环境变量读 LLM 配置（CLI / MCP / REST 三个接入面共用）。
 *
 *   MEMBRANE_LLM_BASE_URL    形如 https://api.openai.com/v1
 *   MEMBRANE_LLM_API_KEY     Bearer key
 *   MEMBRANE_LLM_MODEL       抽取用模型（如 gpt-4o-mini）；不配则 extract 不可用
 *   MEMBRANE_EMBED_MODEL     embedding 模型（如 text-embedding-3-small）；不配则向量检索关闭
 *   MEMBRANE_LLM_TIMEOUT_MS  单次请求超时毫秒，默认 30000
 *
 * 返回 undefined = 没配（保持"装完就能用"的默认体验）。
 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | undefined {
  const baseUrl = env["MEMBRANE_LLM_BASE_URL"]?.trim();
  const apiKey = env["MEMBRANE_LLM_API_KEY"]?.trim();
  if (!baseUrl || !apiKey) return undefined;
  const timeoutRaw = Number(env["MEMBRANE_LLM_TIMEOUT_MS"]);
  return {
    baseUrl,
    apiKey,
    model: env["MEMBRANE_LLM_MODEL"]?.trim() ?? "",
    embeddingModel: env["MEMBRANE_EMBED_MODEL"]?.trim() || undefined,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30_000,
  };
}
