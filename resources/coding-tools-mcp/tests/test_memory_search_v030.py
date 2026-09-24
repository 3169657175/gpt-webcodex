from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.server import Runtime


class MemorySearchV030Tests(unittest.TestCase):
    def test_fts_scope_ranking_and_chinese_substring_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"
            store = MemoryStore(root)
            store.create(scope="global", memory_type="working_style", title="全局习惯", content="调试时保留具体证据", pinned=False)
            wanted = store.create(scope="project", memory_type="decision", title="登录修复", content="修复登录超时后必须验证 MCP 连续调用", project_id="project-a", pinned=True)
            store.create(scope="project", memory_type="decision", title="别的项目", content="登录模块使用完全不同方案", project_id="project-b", pinned=True)
            store.create(scope="task", memory_type="task_summary", title="旧任务", content="登录任务总结", task_id="task-a")

            results = store.search("登录", project_id="project-a", task_id="task-a", limit=8)
            ids = [item["memory_id"] for item in results]
            self.assertIn(wanted["memory_id"], ids)
            self.assertNotIn(next(item["memory_id"] for item in store.list(scope="project", project_id="project-b")), ids)
            self.assertEqual(results[0]["memory_id"], wanted["memory_id"])
            self.assertTrue(all("file_path" not in item for item in results))

    def test_fts_survives_reopen_and_rebuild_from_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"
            store = MemoryStore(root)
            item = store.create(scope="project", memory_type="architecture", title="Runtime 架构", content="Tunnel 与 Runtime 生命周期分离", project_id="p")
            reopened = MemoryStore(root)
            self.assertEqual(reopened.search("Runtime", project_id="p")[0]["memory_id"], item["memory_id"])
            with closing(sqlite3.connect(root / "memory.db")) as connection:
                connection.execute("DELETE FROM memory_fts")
                connection.commit()
            repaired = MemoryStore(root)
            self.assertEqual(repaired.search("生命周期", project_id="p")[0]["memory_id"], item["memory_id"])
            rebuilt = repaired.rebuild_index()
            self.assertEqual(rebuilt["imported"], 1)
            self.assertEqual(repaired.search("Tunnel", project_id="p")[0]["memory_id"], item["memory_id"])

    def test_archive_delete_and_update_keep_fts_consistent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory")
            item = store.create(scope="project", memory_type="pitfall", title="旧关键词", content="alpha-old", project_id="p")
            self.assertTrue(store.search("alpha", project_id="p"))
            store.update(item["memory_id"], title="新关键词", content="beta-new")
            self.assertEqual(store.search("alpha", project_id="p"), [])
            self.assertTrue(store.search("beta", project_id="p"))
            store.archive(item["memory_id"])
            self.assertEqual(store.search("beta", project_id="p"), [])
            second = store.create(scope="global", memory_type="note", title="delete-me", content="gamma")
            self.assertTrue(store.search("gamma"))
            store.delete(second["memory_id"])
            self.assertEqual(store.search("gamma"), [])

    def test_prepare_context_auto_retrieves_objective_memory_and_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); project = base / "project"; project.mkdir(); memory_root = base / "memory"
            env = {"CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_MEMORY_ROOT": str(memory_root)}
            with patch.dict(os.environ, env, clear=False):
                runtime = Runtime(project)
                try:
                    project_id = str(runtime.project_identity.get("project_id") or "")
                    store = MemoryStore(memory_root)
                    store.create(scope="project", memory_type="pitfall", title="Tunnel 重连坑", content="修复 Tunnel 重连时不要重启健康 Runtime", project_id=project_id, pinned=True)
                    prepared = runtime.prepare_coding_context({"objective": "修复 Tunnel 重连失败"})
                    search = prepared["memory_search"]
                    self.assertEqual(search["status"], "ready")
                    self.assertIn("不要重启健康 Runtime", str(search["items"]))
                    self.assertLessEqual(search["count"], 8)
                    self.assertLessEqual(search["content_bytes"], 16 * 1024)
                finally:
                    runtime.close()

    def test_search_failure_does_not_break_prepare(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); project = base / "project"; project.mkdir(); memory_root = base / "memory"
            with patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_MEMORY_ROOT": str(memory_root)}, clear=False):
                runtime = Runtime(project)
                try:
                    with patch.object(server_module.MemoryStore, "search", side_effect=RuntimeError("search broken")):
                        prepared = runtime.prepare_coding_context({"objective": "inspect failure"})
                    self.assertIn("workspace", prepared)
                    self.assertEqual(prepared["memory_search"]["status"], "unavailable")
                    self.assertIn("search broken", prepared["memory_search"]["warning"])
                finally:
                    runtime.close()


if __name__ == "__main__":
    unittest.main()
