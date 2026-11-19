/**
 * Membrane REST 客户端（零依赖，Node 18+ 自带 fetch）。
 *
 * 用法：
 *   node 适配配置/examples/node-client.mjs
 *   MEMBRANE_URL=http://127.0.0.1:8317 MEMBRANE_TOKEN=xxx node ...
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEMBRANE_URL || "http://127.0.0.1:8317";
const TOKEN = process.env.MEMBRANE_TOKEN || "";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const membrane = {
  health: () => call("/api/health"),
  stats: () => call("/api/stats"),
  remember: (input) => call("/api/memories", { method: "POST", body: input }),
  recall: (input) => call("/api/recall", { method: "POST", body: input }),
  update: (id, patch) => call(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  forget: (id) => call(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  history: (id) => call(`/api/memories/${encodeURIComponent(id)}/history`),
  evidence: (id) => call(`/api/memories/${encodeURIComponent(id)}/evidence`),
  relations: (a, b) => {
    const q = new URLSearchParams({ a });
    if (b) q.set("b", b);
    return call(`/api/relations?${q}`);
  },
  exportAll: () => call("/api/export"),
};

// 直接运行时的最小示例
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const h = await membrane.health();
  console.log("health:", h);
  const added = await membrane.remember({
    content: "用户偏好喝不加糖的绿茶",
    subject: "用户",
    kind: "preference",
    tags: ["饮食"],
  });
  console.log("remember:", added.status, added.memory.id);
  const hits = await membrane.recall({ query: "用户喝什么茶", limit: 3, detail: "brief" });
  for (const hit of hits.results) console.log("recall:", hit.score.toFixed(3), hit.memory?.content ?? hit.content);
}
