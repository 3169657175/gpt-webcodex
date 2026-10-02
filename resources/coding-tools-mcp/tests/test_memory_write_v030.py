from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.memory_write import MemoryCandidateStore, MemoryWriteError
from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class MemoryWriteStoreTests(unittest.TestCase):
    def test_secrets_are_never_stored_and_sensitive_personal_requires_explicit_local_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory")
            candidates = MemoryCandidateStore(store)
            with self.assertRaises(MemoryWriteError) as secret:
                candidates.propose(scope="global", title="凭据", content="api_key = sk-abcdefghijklmnopqrstuvwxyz")
            self.assertEqual(secret.exception.code, "SECRET_REJECTED")
            with self.assertRaises(MemoryWriteError) as sensitive:
                candidates.propose(scope="global", title="个人情况", content="我的病史包括一次骨折")
            self.assertEqual(sensitive.exception.code, "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED")
            allowed = candidates.propose(
                scope="global", title="个人情况", content="我的病史包括一次骨折", allow_sensitive_personal=True,
            )
            self.assertEqual(allowed["status"], "pending")

    def test_duplicate_conflict_confirmation_and_revision_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"; store = MemoryStore(root); candidates = MemoryCandidateStore(store)
            existing = store.create(scope="project", memory_type="decision", title="连接原则", content="健康 Runtime 不因页面异常重启", project_id="p")
            duplicate = candidates.propose(scope="project", memory_type="decision", title="同义标题", content="健康 Runtime 不因页面异常重启", project_id="p")
            self.assertEqual(duplicate["status"], "duplicate")
            conflict = candidates.propose(scope="project", memory_type="decision", title="连接原则", content="页面异常时重启 Runtime", project_id="p")
            self.assertEqual(conflict["status"], "conflict")
            unresolved = candidates.confirm(conflict["candidate_id"])
            self.assertEqual(unresolved["status"], "conflict")
            self.assertEqual(store.get(existing["memory_id"])["revision"], 1)
            resolved = candidates.confirm(conflict["candidate_id"], resolution="update")
            self.assertEqual(resolved["status"], "updated")
            updated = store.get(existing["memory_id"])
            self.assertEqual(updated["revision"], 2)
            self.assertEqual(updated["supersedes"], f"{existing['memory_id']}@1")
            snapshots = store.revision_history(existing["memory_id"])
            self.assertEqual(len(snapshots), 1)
            self.assertEqual(snapshots[0]["revision"], 1)
            self.assertIn("健康 Runtime 不因页面异常重启", snapshots[0]["content"])

    def test_pending_same_topic_conflict_preserves_both_facts_for_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"; store = MemoryStore(root); candidates = MemoryCandidateStore(store)
            old = candidates.propose(scope="project", memory_type="decision", title="前端技术方案", content="当前项目默认使用 React", project_id="p")
            new = candidates.propose(scope="project", memory_type="decision", title="前端技术方案", content="当前项目改用原生 HTML，不使用 React", project_id="p")
            self.assertEqual(old["status"], "pending")
            self.assertEqual(new["status"], "conflict")
            self.assertNotEqual(old["candidate_id"], new["candidate_id"])
            self.assertEqual(new["conflicting_candidate_id"], old["candidate_id"])
            self.assertEqual(new["conflicting_candidate"]["content"], "当前项目默认使用 React")
            self.assertEqual(candidates.get(new["candidate_id"])["content"], "当前项目改用原生 HTML，不使用 React")
            unresolved = candidates.confirm(new["candidate_id"])
            self.assertEqual(unresolved["status"], "conflict")
            self.assertEqual(unresolved["existing_candidate"]["content"], "当前项目默认使用 React")
            resolved = candidates.confirm(new["candidate_id"], resolution="update")
            self.assertEqual(resolved["status"], "created")
            self.assertEqual(store.list(limit=20)[0]["content"], "当前项目改用原生 HTML，不使用 React")
            self.assertEqual(candidates.list(), [])

    def test_candidates_survive_restart_and_expired_candidates_are_pruned(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"; store = MemoryStore(root)
            first = MemoryCandidateStore(store)
            candidate = first.propose(scope="global", memory_type="working_style", title="工作方式", content="连续执行")
            reopened = MemoryCandidateStore(MemoryStore(root))
            self.assertEqual(reopened.get(candidate["candidate_id"])["content"], "连续执行")
            path = root / "candidates" / f"{candidate['candidate_id']}.json"
            raw = json.loads(path.read_text(encoding="utf-8")); raw["expires_at_epoch"] = 1
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            self.assertIsNone(reopened.get(candidate["candidate_id"]))
            self.assertFalse(path.exists())


class MemoryWriteRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(); base = Path(self.temp.name)
        self.root = base / "project"; self.root.mkdir(); self.memory_root = base / "memory"
        self.env = patch.dict(os.environ, {
            "CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_MEMORY_ROOT": str(self.memory_root),
        }, clear=False); self.env.start()
        self.runtime = Runtime(self.root, auth_token="memory-token", transport="http", permission_mode="safe")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start(); self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2); self.runtime.close(); self.env.stop(); self.temp.cleanup()

    def post(self, payload: dict, token: str | None = "memory-token") -> tuple[int, dict]:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/__control/memory",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_private_memory_control_requires_bearer_and_confirmed_write_invalidates_context_cache(self) -> None:
        self.assertEqual(self.post({"action": "list"}, None)[0], 401)
        before = self.runtime.workspace_context({"detail": "compact"})
        self.assertEqual(before["memory_bootstrap"]["count"], 0)
        status, proposed = self.post({
            "action": "propose", "scope": "project", "memory_type": "decision",
            "title": "连接原则", "content": "健康 Tunnel 不因页面异常重启", "pinned": True,
        })
        self.assertEqual(status, 200); self.assertEqual(proposed["result"]["status"], "pending")
        candidate_id = proposed["result"]["candidate_id"]
        status, confirmed = self.post({"action": "confirm", "candidate_id": candidate_id})
        self.assertEqual(status, 200); self.assertEqual(confirmed["result"]["status"], "created")
        after = self.runtime.workspace_context({"detail": "compact"})
        self.assertIn("健康 Tunnel 不因页面异常重启", str(after["memory_bootstrap"]["items"]))
        prepared = self.runtime.prepare_coding_context({"objective": "页面异常重连"})
        self.assertIn("健康 Tunnel", str(prepared["memory_search"]["items"]))
        self.assertEqual(len(self.runtime.list_tools()["tools"]), 10)

    def test_private_memory_ingest_auto_and_suggest_modes_use_existing_store(self) -> None:
        status, _ = self.post({"action": "set_config", "auto_memory": "auto"})
        self.assertEqual(status, 200)
        status, remembered = self.post({
            "action": "ingest",
            "user_text": "我希望所有面向我的界面都尽量使用中文。",
            "assistant_text": "后续界面会优先使用中文。",
        })
        self.assertEqual(status, 200)
        self.assertEqual(remembered["result"]["status"], "candidate")
        self.assertEqual(len(self.runtime.memory_store.list(scope="global", limit=20)), 0)
        self.assertEqual(len(self.runtime.memory_candidates.list()), 1)
        status, duplicate = self.post({"action": "ingest", "user_text": "我希望所有面向我的界面都尽量使用中文。", "assistant_text": "后续界面会优先使用中文。"})
        self.assertEqual(status, 200)
        self.assertEqual(duplicate["result"]["status"], "duplicate")
        status, _ = self.post({"action": "set_config", "auto_memory": "suggest"})
        self.assertEqual(status, 200)
        status, candidate = self.post({"action": "ingest", "user_text": "我习惯长任务从头到尾连续执行，不要每一步都停下来问我，这是我长期的工作方式。"})
        self.assertEqual(status, 200)
        self.assertEqual(candidate["result"]["status"], "candidate")
        self.assertGreaterEqual(len(self.runtime.memory_candidates.list()), 1)
        self.assertEqual(len(self.runtime.list_tools()["tools"]), 10)

    def test_model_remember_context_creates_updates_deduplicates_and_rejects_unsafe_data(self) -> None:
        tools = {item["name"]: item for item in self.runtime.list_tools()["tools"]}
        self.assertIn("remember_context", tools)
        self.assertIn("primary writer", tools["remember_context"]["description"].lower())

        discovered = self.runtime.memory_candidates.propose(
            scope="global", memory_type="working_style", title="长期协作方式",
            content="长任务应连续执行到完成，不要每一步都停下来确认。", source="auto_discovery_v3",
        )
        self.assertEqual(discovered["status"], "pending")

        created = self.runtime.remember_context({
            "scope": "global", "memory_type": "working_style",
            "title": "长期协作方式", "content": "长任务应连续执行到完成，不要每一步都停下来确认。",
            "confidence": 0.96,
        })
        self.assertEqual(created["status"], "remembered")
        self.assertGreaterEqual(created.get("cleared_candidates", 0), 1)
        self.assertEqual(len(self.runtime.memory_candidates.list()), 0)
        self.assertEqual(len(self.runtime.memory_store.list(scope="global", limit=20)), 1)

        updated = self.runtime.remember_context({
            "scope": "global", "memory_type": "working_style",
            "title": "长期协作方式", "content": "长任务应持续执行并主动汇报关键进度，不要频繁停下来确认。",
            "confidence": 0.98,
        })
        self.assertEqual(updated["status"], "updated")
        records = self.runtime.memory_store.list(scope="global", limit=20)
        self.assertEqual(len(records), 1)
        self.assertIn("主动汇报关键进度", records[0]["content"])

        duplicate = self.runtime.remember_context({
            "scope": "global", "memory_type": "working_style",
            "title": "长期协作方式", "content": "长任务应持续执行并主动汇报关键进度，不要频繁停下来确认。",
        })
        self.assertEqual(duplicate["status"], "duplicate")
        self.assertEqual(len(self.runtime.memory_store.list(scope="global", limit=20)), 1)

        secret = self.runtime.remember_context({
            "scope": "global", "title": "登录凭据", "content": "password=supersecret123",
        })
        self.assertEqual(secret["status"], "rejected")
        self.assertEqual(secret["code"], "SECRET_REJECTED")

        sensitive = self.runtime.remember_context({
            "scope": "global", "title": "个人病史", "content": "我的病史包括一次骨折。",
        })
        self.assertEqual(sensitive["status"], "rejected")
        self.assertEqual(sensitive["code"], "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED")
        self.assertEqual(len(self.runtime.memory_store.list(scope="global", limit=20)), 1)

    def test_private_memory_control_blocks_secret_and_requires_confirmation_for_delete(self) -> None:
        status, body = self.post({"action": "propose", "scope": "global", "title": "secret", "content": "password=supersecret123"})
        self.assertEqual(status, 400); self.assertEqual(body["code"], "SECRET_REJECTED")
        created = self.runtime.memory_store.create(scope="global", memory_type="working_style", title="临时", content="内容")
        status, body = self.post({"action": "delete", "memory_id": created["memory_id"]})
        self.assertEqual(status, 400); self.assertEqual(body["code"], "CONFIRMATION_REQUIRED")
        status, body = self.post({"action": "delete", "memory_id": created["memory_id"], "confirm": True})
        self.assertEqual(status, 200); self.assertTrue(body["result"]["deleted"])


if __name__ == "__main__":
    unittest.main()
