from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.memory_store import DEFAULT_MEMORY_PROFILE, MemoryStore, default_memory_root


class MemoryStoreM0Tests(unittest.TestCase):
    def test_default_root_is_localappdata_and_not_workspace_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            local = Path(temp) / "LocalAppData"
            with patch.dict(os.environ, {"LOCALAPPDATA": str(local)}, clear=False):
                store = MemoryStore()
                self.assertEqual(store.root, (local / "GPT-WebCodex" / "memory-v1").resolve())
                self.assertEqual(store.profile, DEFAULT_MEMORY_PROFILE)
                self.assertTrue(store.db_path.is_file())
                for name in ("system", "projects", "tasks", "archive", "events", "snapshots"):
                    self.assertTrue((store.root / name).is_dir())
                config = json.loads(store.config_path.read_text(encoding="utf-8"))
                self.assertEqual(config["auto_memory"], "off")

    def test_crud_scopes_markdown_truth_and_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory-v1")
            global_item = store.create(scope="global", memory_type="working_style", title="工作方式", content="连续执行，不重复确认", pinned=True)
            project_item = store.create(scope="project", memory_type="decision", title="架构决定", content="本地是记忆真源", project_id="project-stable")
            task_item = store.create(scope="task", memory_type="task_summary", title="任务总结", content="M0 完成", task_id="task-1")
            self.assertTrue((store.root / global_item["file_path"]).is_file())
            self.assertIn("GPT-WEBCODEX-MEMORY-META", (store.root / project_item["file_path"]).read_text(encoding="utf-8"))
            self.assertEqual(store.list(scope="project", project_id="project-stable")[0]["content"], "本地是记忆真源")
            updated = store.update(project_item["memory_id"], content="本地 MemoryStore 是唯一真源", pinned=True)
            self.assertEqual(updated["revision"], 2)
            self.assertTrue(updated["pinned"])
            archived = store.archive(task_item["memory_id"])
            self.assertTrue(archived["archived"])
            self.assertIn("archive/tasks/task-1", archived["file_path"])
            self.assertEqual(store.list(task_id="task-1"), [])
            self.assertEqual(len(store.list(task_id="task-1", archived=True)), 1)
            self.assertTrue(store.delete(global_item["memory_id"]))
            self.assertIsNone(store.get(global_item["memory_id"]))

    def test_scope_identity_is_required_and_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory-v1")
            with self.assertRaises(ValueError):
                store.create(scope="project", title="bad", content="x")
            with self.assertRaises(ValueError):
                store.create(scope="task", title="bad", content="x")
            with self.assertRaises(ValueError):
                store.create(scope="project", title="bad", content="x", project_id="../outside")

    def test_sqlite_can_be_rebuilt_from_markdown_after_database_loss(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory-v1"
            store = MemoryStore(root)
            one = store.create(scope="project", memory_type="project_summary", title="项目摘要", content="项目 A", project_id="project-A")
            two = store.create(scope="global", memory_type="core_preference", title="偏好", content="中文界面")
            store.db_path.unlink()
            rebuilt = store.rebuild_index()
            self.assertEqual(rebuilt["imported"], 2)
            self.assertEqual(store.get(one["memory_id"])["content"], "项目 A")
            self.assertEqual(store.get(two["memory_id"])["content"], "中文界面")
            with closing(sqlite3.connect(store.db_path)) as connection:
                self.assertEqual(connection.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_corrupt_database_is_quarantined_without_destroying_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory-v1"
            store = MemoryStore(root)
            item = store.create(scope="global", title="保留", content="Markdown 仍在")
            markdown = root / item["file_path"]
            store.db_path.write_bytes(b"not sqlite")
            reopened = MemoryStore(root)
            self.assertTrue(list(root.glob("memory.db.corrupt-*")))
            self.assertTrue(markdown.is_file())
            result = reopened.rebuild_index()
            self.assertEqual(result["imported"], 1)
            self.assertEqual(reopened.get(item["memory_id"])["content"], "Markdown 仍在")

    def test_m0_has_no_automatic_chat_capture(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory-v1")
            self.assertFalse(hasattr(store, "capture_chat"))
            self.assertFalse(hasattr(store, "auto_extract"))
            self.assertEqual(store.list(), [])


if __name__ == "__main__":
    unittest.main()
