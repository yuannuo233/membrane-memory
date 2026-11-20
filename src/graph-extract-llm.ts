/**
 * 可选 LLM 关系抽取器（OpenAI 兼容 /chat/completions）。
 *
 * 定位：默认仍然用 graph-extract.ts 的规则；只有用户在 addAsync() 显式要求
 * `relationExtraction: "llm"`（或 MembraneOptions.graph.llmExtract=true）时才调用。
 *
 * 为什么单独一个文件：规则抽取是同步、零依赖的；LLM 抽取是异步、可失败的。
 * 把两者分开，`add()` 的零依赖语义不会被污染，LLM 失败也能干净地回退规则。
 */
import { postJson, type FetchLike } from "./llm.js";
import { MembraneError, normalizeEntityName, normalizeEntityType, normalizePredicate } from "./model.js";
import type { EntityType, LlmConfig, RelationInput } from "./types.js";

/** LLM 返回的图抽取结果（已规范化） */
export interface LlmGraphResult {
  entities: { name: string; type: EntityType }[];
  relations: RelationInput[];
  /** 原始解析结果，供调试/审计；不含 prompt */
  raw: unknown;
}

/** 系统提示词：只抽明确关系，宁可漏，不要编 */
export const GRAPH_EXTRACT_SYSTEM_PROMPT = `你是一个知识图谱抽取器。只抽取文本中明确陈述的实体和关系，不要推测，不要补充文本里没有的事实。
只输出一个 JSON 对象，不要输出解释文字。格式：
{
  "entities": [{"name": "实体名", "type": "person|place|org|concept|unknown"}],
  "relations": [{"from": "起点实体", "fromType": "person|place|org|concept|unknown", "to": "终点实体", "toType": "person|place|org|concept|unknown", "predicate": "短谓词"}]
}
要求：
- from / to 必须是 entities 里出现过的名字；
- 代词（我/他/她/它/我们/他们）要映射到用户给的 subject；没有 subject 就丢弃这条关系；
- predicate 用短名词或动宾短语，例如“同学”“住在”“工作于”“喜欢”；
- 没有明确关系就返回 {"entities": [], "relations": []}。`;

/**
 * 从 LLM 返回里稳健提取 JSON 对象（容忍 ```json 围栏、前后废话）。
 * 解析失败抛 E_GRAPH_PARSE，调用方应回退规则抽取。
 */
export function parseGraphResponse(raw: string): { entities?: unknown; relations?: unknown } {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MembraneError("E_GRAPH_PARSE", `LLM 图抽取返回无法解析为 JSON：${raw.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MembraneError("E_GRAPH_PARSE", "LLM 图抽取返回不是 JSON 对象");
  }
  return parsed as { entities?: unknown; relations?: unknown };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 调 LLM 抽实体/关系。
 *
 * @param text 记忆正文
 * @param subject 记忆 subject（代词映射用）
 * @param subjectType subject 的实体类型
 * @param llm OpenAI 兼容配置；没有 model 时直接抛 E_NO_LLM
 * @param opts.injectFetch 测试注入；默认全局 fetch
 * @param opts.confidence 关系置信度，默认 0.8（低于手动标注，高于规则 0.7）
 */
export async function extractGraphWithLlm(
  text: string,
  subject: string | null,
  subjectType: EntityType,
  llm: LlmConfig | undefined,
  opts: { injectFetch?: FetchLike; confidence?: number; timeoutMs?: number } = {},
): Promise<LlmGraphResult> {
  if (!llm?.model) {
    throw new MembraneError(
      "E_NO_LLM",
      "LLM 关系抽取需要配置 llm.model（CLI 用 MEMBRANE_LLM_MODEL 环境变量）",
    );
  }
  const doFetch = opts.injectFetch ?? (globalThis.fetch as unknown as FetchLike);
  const payload = (await postJson(
    llm,
    "/chat/completions",
    {
      model: llm.model,
      messages: [
        { role: "system", content: GRAPH_EXTRACT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `subject=${subject ?? ""}\nsubjectType=${subjectType}\n文本：${text}`,
        },
      ],
      temperature: 0,
    },
    "E_GRAPH_HTTP",
    doFetch,
    opts.timeoutMs ?? llm.timeoutMs ?? 30_000,
  )) as { choices?: { message?: { content?: string } }[] };

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new MembraneError("E_GRAPH_PARSE", "LLM 图抽取返回为空");
  }
  const parsed = parseGraphResponse(content);
  const confidence = Math.min(1, Math.max(0, opts.confidence ?? 0.8));

  const entities: { name: string; type: EntityType }[] = [];
  const seenEntities = new Set<string>();
  const entityList = Array.isArray(parsed.entities) ? parsed.entities : [];
  for (const rawEntity of entityList) {
    const rec = asRecord(rawEntity);
    if (!rec || typeof rec.name !== "string") continue;
    let name: string;
    try {
      name = normalizeEntityName(rec.name);
    } catch {
      continue; // 单条脏实体不拖垮整批
    }
    if (seenEntities.has(name)) continue;
    let type: EntityType = "unknown";
    try {
      type = normalizeEntityType(rec.type);
    } catch {
      type = "unknown";
    }
    seenEntities.add(name);
    entities.push({ name, type });
  }

  const relations: RelationInput[] = [];
  const seenRelations = new Set<string>();
  const relationList = Array.isArray(parsed.relations) ? parsed.relations : [];
  for (const rawRelation of relationList) {
    const rec = asRecord(rawRelation);
    if (!rec || typeof rec.to !== "string" || typeof rec.predicate !== "string") continue;
    let from: string | null = null;
    let to: string;
    let predicate: string;
    try {
      from = typeof rec.from === "string" && rec.from.trim() ? normalizeEntityName(rec.from) : null;
      to = normalizeEntityName(rec.to);
      predicate = normalizePredicate(rec.predicate);
    } catch {
      continue;
    }
    // 代词/省略起点：映射到 subject；没有 subject 就丢弃（和规则抽取口径一致）
    if (!from) {
      if (!subject) continue;
      from = subject;
    }
    if (from === to) continue;
    const key = `${from}|${predicate}|${to}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);

    let fromType: EntityType = subject && from === subject ? subjectType : "unknown";
    let toType: EntityType = "unknown";
    try {
      fromType = normalizeEntityType(rec.fromType) === "unknown"
        ? (subject && from === subject ? subjectType : fromType)
        : normalizeEntityType(rec.fromType);
      toType = normalizeEntityType(rec.toType);
    } catch {
      // 类型非法就用 unknown，不丢关系本身
    }
    entities.push({ name: from, type: fromType });
    entities.push({ name: to, type: toType });
    relations.push({ from, fromType, to, toType, predicate, confidence });
  }

  // 去重实体（relations 里补进来的可能和 entities 重复）
  const deduped: { name: string; type: EntityType }[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    deduped.push(e);
  }

  return { entities: deduped, relations, raw: parsed };
}
