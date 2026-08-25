from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


class StoppedReadonlyTests(unittest.TestCase):
    def make_runtime(self, root: Path) -> Runtime:
        with patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            return Runtime(root, permission_mode="dangerous")

    def test_stopped_task_allows_document_inspect_and_prepare(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "note.md").write_text("# hello\n", encoding="utf-8")
            runtime = self.make_runtime(root)
            runtime.task_control({"action": "start", "objective": "stop boundary"})
            runtime.task_control({"action": "stop", "reason": "test stop"})
            inspected = runtime.call_tool("document_workflow", {"action": "inspect", "path": "note.md"})
            self.assertFalse(inspected.get("isError", False))
            prepared = runtime.call_tool("agent_workflow", {"phase": "prepare", "workflow": "diagnose", "objective": "read only prepare", "paths": ["note.md"]})
            self.assertFalse(prepared.get("isError", False))
            runtime.close()

    def test_paused_task_allows_document_inspect(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "note.md").write_text("paused read\n", encoding="utf-8")
            runtime = self.make_runtime(root)
            runtime.task_control({"action": "start", "objective": "pause boundary"})
            runtime.task_control({"action": "pause", "reason": "test pause"})
            inspected = runtime.call_tool("document_workflow", {"action": "inspect", "path": "note.md"})
            self.assertFalse(inspected.get("isError", False))
            runtime.close()

    def test_stopped_task_still_blocks_document_create(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = self.make_runtime(root)
            runtime.task_control({"action": "start", "objective": "stop boundary"})
            runtime.task_control({"action": "stop", "reason": "test stop"})
            created = runtime.call_tool("document_workflow", {"action": "create", "target": "blocked.md", "content": "blocked"})
            self.assertTrue(created.get("isError", False))
            structured = created.get("structuredContent") or {}
            self.assertEqual((structured.get("error") or {}).get("code"), "TASK_STOPPED")
            self.assertFalse((root / "blocked.md").exists())
            runtime.close()


if __name__ == "__main__":
    unittest.main()




