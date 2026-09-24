from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.repo_index import RepoIndex
from coding_tools_mcp.server import Runtime


class WorkspaceRepoMapTests(unittest.TestCase):
    def test_workspace_context_returns_bounded_repo_map_from_ready_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.py").write_text(
                "import helpers\nclass AppService:\n    def run(self):\n        return helpers.work()\n",
                encoding="utf-8",
            )
            (root / "helpers.py").write_text("def work():\n    return 1\n", encoding="utf-8")
            RepoIndex(root).sync()
            runtime = Runtime(root)
            payload = runtime.workspace_context({"detail": "compact", "max_entries": 10})
            self.assertTrue(payload["index_status"]["ready"])
            self.assertLessEqual(len(payload["relevant_files"]), 12)
            self.assertLessEqual(len(payload["important_symbols"]), 16)
            self.assertLessEqual(len(payload["dependency_hints"]), 16)
            self.assertTrue(any(item["name"] == "AppService" for item in payload["important_symbols"]))
            self.assertTrue(any(item["target"] == "helpers" for item in payload["dependency_hints"]))
            self.assertGreaterEqual(payload["architecture_map"]["files"], 2)

    def test_workspace_context_survives_repo_index_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "main.py").write_text("value = 1\n", encoding="utf-8")
            runtime = Runtime(root)
            with patch.object(server_module.RepoIndex, "status", side_effect=RuntimeError("index unavailable")):
                payload = runtime.workspace_context({"detail": "compact", "max_entries": 10})
            self.assertIn("project", payload)
            self.assertIn("entries", payload)
            self.assertEqual(payload["index_status"]["status"], "unavailable")
            self.assertEqual(payload["relevant_files"], [])
            self.assertIn("git", payload)

    def test_subdirectory_context_reuses_workspace_root_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "src"
            source.mkdir()
            (source / "service.py").write_text("class SharedService:\n    pass\n", encoding="utf-8")
            RepoIndex(root).sync()
            runtime = Runtime(root)
            payload = runtime.workspace_context({"path": "src", "detail": "compact", "max_entries": 10})
            self.assertTrue(payload["index_status"]["ready"])
            self.assertTrue(any(item["name"] == "SharedService" for item in payload["important_symbols"]))
            self.assertTrue((root / ".coding-tools" / "index" / "index.db").is_file())
            self.assertFalse((source / ".coding-tools" / "index").exists())
            runtime.close()

    def test_first_workspace_context_does_not_wait_for_index_build(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "main.py").write_text("def first_boot():\n    return True\n", encoding="utf-8")
            runtime = Runtime(root)
            gate = __import__("threading").Event()

            def slow_sync(_self):
                gate.wait(1.0)
                return {"ok": True, "status": "ready", "file_count": 1}

            with patch.object(server_module.RepoIndex, "sync_safely", slow_sync):
                payload = runtime.workspace_context({"detail": "compact", "max_entries": 10})
                self.assertEqual(payload["index_status"]["status"], "building")
                self.assertFalse(payload["index_status"]["ready"])
                second = runtime.workspace_context({"detail": "compact", "max_entries": 10})
                self.assertTrue(second["cache"]["hit"])
                gate.set()
                with server_module._REPO_INDEX_SYNC_LOCK:
                    thread = server_module._REPO_INDEX_SYNC_THREADS.get(str(root.resolve()))
                if thread is not None:
                    thread.join(timeout=2.0)
                self.assertFalse(thread is not None and thread.is_alive())


if __name__ == "__main__":
    unittest.main()
