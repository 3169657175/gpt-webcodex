from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.server import Runtime


class MemoryBootstrapV030Tests(unittest.TestCase):
    def make_runtime(self, root: Path, memory_root: Path) -> Runtime:
        env = {
            "CODING_TOOLS_MCP_TOOL_MODE": "smart",
            "CODING_TOOLS_MCP_MEMORY_ROOT": str(memory_root),
        }
        patcher = patch.dict(os.environ, env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        runtime = Runtime(root)
        self.addCleanup(runtime.close)
        return runtime

    def test_workspace_context_returns_only_core_and_current_project_memories(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            project = base / "project"; project.mkdir()
            memory_root = base / "memory"
            runtime = self.make_runtime(project, memory_root)
            project_id = str(runtime.project_identity.get("project_id") or "")
            store = MemoryStore(memory_root)
            store.create(scope="global", memory_type="core_preference", title="界面语言", content="所有用户界面尽量使用中文", pinned=True)
            store.create(scope="global", memory_type="working_style", title="工作方式", content="连续按计划执行，不重复确认")
            store.create(scope="global", memory_type="note", title="普通笔记", content="这条不应进入 bootstrap")
            store.create(scope="project", memory_type="project_summary", title="项目摘要", content="这是当前项目", project_id=project_id)
            store.create(scope="project", memory_type="decision", title="连接原则", content="健康 Tunnel 不因页面异常重启", project_id=project_id)
            store.create(scope="project", memory_type="project_summary", title="别的项目", content="绝不能出现", project_id="another-project")
            store.create(scope="task", memory_type="task_summary", title="旧任务", content="也不应进入 bootstrap", task_id="task-old")

            payload = runtime.workspace_context({"detail": "compact", "max_entries": 10})
            bootstrap = payload["memory_bootstrap"]
            self.assertEqual(bootstrap["status"], "ready")
            self.assertEqual(bootstrap["project_id"], project_id)
            self.assertLessEqual(bootstrap["count"], 8)
            joined = json.dumps(bootstrap, ensure_ascii=False)
            self.assertIn("所有用户界面尽量使用中文", joined)
            self.assertIn("连续按计划执行", joined)
            self.assertIn("这是当前项目", joined)
            self.assertIn("健康 Tunnel", joined)
            self.assertNotIn("普通笔记", joined)
            self.assertNotIn("绝不能出现", joined)
            self.assertNotIn("旧任务", joined)
            runtime.close()

    def test_bootstrap_is_bounded_and_compact(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); project = base / "project"; project.mkdir(); memory_root = base / "memory"
            runtime = self.make_runtime(project, memory_root)
            store = MemoryStore(memory_root)
            project_id = str(runtime.project_identity.get("project_id") or "")
            for index in range(20):
                store.create(scope="project", memory_type="decision", title=f"decision-{index}", content=("中" * 5000), project_id=project_id, pinned=index < 2)
            bootstrap = runtime.workspace_context({"detail": "compact"})["memory_bootstrap"]
            self.assertLessEqual(bootstrap["count"], 8)
            self.assertLessEqual(bootstrap["content_bytes"], 12 * 1024)
            self.assertTrue(bootstrap["truncated"])
            for item in bootstrap["items"]:
                self.assertNotIn("file_path", item)
                self.assertNotIn("content_sha256", item)
            runtime.close()

    def test_memory_failure_does_not_break_workspace_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); project = base / "project"; project.mkdir(); memory_root = base / "memory"
            runtime = self.make_runtime(project, memory_root)
            with patch.object(server_module.MemoryStore, "build_bootstrap", side_effect=RuntimeError("memory unavailable")):
                payload = runtime.workspace_context({"detail": "compact"})
            self.assertIn("project", payload)
            self.assertEqual(payload["memory_bootstrap"]["status"], "unavailable")
            self.assertIn("memory unavailable", payload["memory_bootstrap"]["warning"])
            runtime.close()

    def test_memory_store_init_failure_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}, clear=False), patch.object(server_module, "MemoryStore", side_effect=OSError("denied")):
                runtime = Runtime(root)
                try:
                    payload = runtime.workspace_context({"detail": "compact"})
                    self.assertEqual(payload["memory_bootstrap"]["status"], "unavailable")
                    self.assertIn("denied", payload["memory_bootstrap"]["warning"])
                finally:
                    runtime.close()


if __name__ == "__main__":
    unittest.main()
