"""Membrane REST 客户端（零依赖，只用 Python 标准库）。

用法：
    python 适配配置/examples/python-client.py
    MEMBRANE_URL=http://127.0.0.1:8317 MEMBRANE_TOKEN=xxx python ...
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = os.environ.get("MEMBRANE_URL", "http://127.0.0.1:8317")
TOKEN = os.environ.get("MEMBRANE_TOKEN", "")


class MembraneError(RuntimeError):
    pass


class Membrane:
    def __init__(self, base: str = BASE, token: str = TOKEN, timeout: float = 30.0):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _call(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            try:
                message = json.loads(detail).get("error", detail)
            except json.JSONDecodeError:
                message = detail
            raise MembraneError(message) from exc

    def health(self) -> dict[str, Any]:
        return self._call("/api/health")

    def stats(self) -> dict[str, Any]:
        return self._call("/api/stats")

    def remember(self, content: str, **fields: Any) -> dict[str, Any]:
        return self._call("/api/memories", "POST", {"content": content, **fields})

    def recall(self, query: str, **options: Any) -> dict[str, Any]:
        return self._call("/api/recall", "POST", {"query": query, **options})

    def update(self, memory_id: str, **patch: Any) -> dict[str, Any]:
        return self._call(f"/api/memories/{urllib.parse.quote(memory_id)}", "PATCH", patch)

    def forget(self, memory_id: str) -> dict[str, Any]:
        return self._call(f"/api/memories/{urllib.parse.quote(memory_id)}", "DELETE")

    def history(self, memory_id: str) -> list[dict[str, Any]]:
        return self._call(f"/api/memories/{urllib.parse.quote(memory_id)}/history")

    def evidence(self, memory_id: str) -> list[dict[str, Any]]:
        return self._call(f"/api/memories/{urllib.parse.quote(memory_id)}/evidence")

    def relations(self, a: str, b: str | None = None) -> dict[str, Any]:
        query = {"a": a}
        if b:
            query["b"] = b
        return self._call("/api/relations?" + urllib.parse.urlencode(query))

    def export_all(self) -> dict[str, Any]:
        return self._call("/api/export")


if __name__ == "__main__":
    client = Membrane()
    print("health:", client.health())
    added = client.remember("用户偏好喝不加糖的绿茶", subject="用户", kind="preference", tags=["饮食"])
    print("remember:", added["status"], added["memory"]["id"])
    hits = client.recall("用户喝什么茶", limit=3, detail="brief")
    for hit in hits["results"]:
        print("recall:", round(hit["score"], 3), hit.get("memory", {}).get("content") or hit.get("content"))
