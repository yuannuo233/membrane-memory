/**
 * 抽取模式（DESIGN.md 第 7 节）。
 *
 * 直写模式（add）零依赖；本文件是可选的"从大段文本提炼记忆"——
 * 调用用户配置的 OpenAI 兼容 /chat/completions，让 LLM 返回 JSON 候选数组，
 * 逐条走 Membrane 的去重/冲突检测，最后返回"存了什么/跳过什么/取代了谁"。
 *
 * 零依赖底线：没配 llm 时 extract() 抛明确中文错误，但 add/recall 全部照常工作。
 * fetch 可注入（便于单测不打真网络）。
 *
 * v0.2 起：入库走 addAsync()——配了 embeddingModel 时顺带把向量算好存进去，
 * 于是"抽取的记忆"也能被试向量检索命中，不需要调用方自己补向量。
 */
import { Membrane } from "./engine.js";
import { MembraneError, validateKind } from "./model.js";
import { embedText, postJson, type FetchLike } from "./llm.js";
import type { ExtractCandidate, ExtractResult, MemoryKind } from "./types.js";

export type { FetchLike };

/** 内置的抽取系统提示词（要求严格 JSON，便于稳定解析） */
export const EXTRACT_SYSTEM_PROMPT = `你是一个记忆抽取助手。从用户给的文本中，抽取值得长期记住的明确事实、偏好、经历或流程。每条记忆输出为一个 JSON 对象，字段：
- kind: "fact" | "episode" | "preference" | "procedure" 之一
- subject: 主语（人或实体名），没有则 null
- content: 记忆正文（一句话，自包含，不依赖上下文）
- tags: 字符串数组
- confidence: 0~1 的数字
只输出一个 JSON 数组，不要输出任何解释文字。没有可记住的内容就输出 []。`;

/** 从各种 LLM 返回形态里稳健提取 JSON 数组（容忍 ```json 围栏、前后废话） */
export function parseCandidates(raw: string): ExtractCandidate[] {
  let text = raw.trim();
  // 去掉 markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  // 截取第一个 [ 到最后一个 ]（LLM 常在数组外裹说明）
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MembraneError("E_EXTRACT_PARSE", `LLM 返回无法解析为 JSON：${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new MembraneError("E_EXTRACT_PARSE", "LLM 返回不是 JSON 数组");
  }
  return parsed as ExtractCandidate[];
}

/**
 * 从文本抽取并入库。
 * @param membrane 目标引擎（须配置 llm，否则抛 E_NO_LLM）
 * @param text 待抽取的大段文本（如一段对话）
 * @param opts.injectFetch 注入 fetch（测试用）
 */
export async function extract(
  membrane: Membrane,
  text: string,
  opts: { injectFetch?: FetchLike } = {},
): Promise<ExtractResult> {
  const llm = membrane.llm;
  if (!llm || !llm.model) {
    throw new MembraneError(
      "E_NO_LLM",
      "抽取模式需要先在 Membrane 构造时配置 llm（含 model；CLI 用 MEMBRANE_LLM_MODEL 环境变量）",
    );
  }
  const doFetch = opts.injectFetch ?? (globalThis.fetch as unknown as FetchLike);
  const payload = (await postJson(
    llm,
    "/chat/completions",
    {
      model: llm.model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0,
    },
    "E_EXTRACT_HTTP",
    doFetch,
    llm.timeoutMs ?? 30_000,
  )) as { choices?: { message?: { content?: string } }[] };

  const candidates = parseCandidates(payload.choices?.[0]?.message?.content ?? "");
  const result: ExtractResult = { added: [], skipped: [], candidates };

  for (const c of candidates) {
    // content 缺失/空白 → 跳过
    if (typeof c.content !== "string" || c.content.trim().length === 0) {
      result.skipped.push({ item: c, reason: "content 缺失或为空" });
      continue;
    }
    // kind 非法 → 跳过（不因一条脏数据中断整批）；合法则直接沿用
    let kind: MemoryKind = "fact";
    if (c.kind !== undefined) {
      try {
        validateKind(String(c.kind));
        kind = c.kind as MemoryKind;
      } catch {
        result.skipped.push({ item: c, reason: `kind 非法：${String(c.kind)}` });
        continue;
      }
    }
    try {
      // addAsync：配了 embeddingModel 就顺手算向量；没配等价于 add
      const addResult = await membrane.addAsync(
        {
          content: c.content,
          kind,
          subject: c.subject,
          tags: c.tags,
          confidence: c.confidence,
          source: "extract",
        },
        { injectFetch: opts.injectFetch },
      );
      result.added.push(addResult);
    } catch (err) {
      result.skipped.push({
        item: c,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * 计算某条文本的 embedding（可选，供向量检索接入）。
 * 无 embeddingModel 配置返回 null；调用方据此降级到纯全文检索。
 * 实现已搬到 llm.ts（避免 engine ↔ extract 循环依赖），这里保留同名入口。
 */
export async function embed(
  membrane: Membrane,
  text: string,
  opts: { injectFetch?: FetchLike } = {},
): Promise<Float32Array | null> {
  return embedText(membrane.llm, text, { injectFetch: opts.injectFetch });
}
