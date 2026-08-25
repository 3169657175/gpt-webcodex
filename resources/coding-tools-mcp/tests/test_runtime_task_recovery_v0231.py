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

from coding_tools_mcp.server import Runtime
from coding_tools_mcp.task_state import TaskStateStore


def make_completed_waiting(root: Path) -> None:
    store = TaskStateStore(root)
    store.ensure_started("legacy completed task")
    store.update({
        "lifecycle_state": "waiting_model",
        "current_step": "Waiting for model",
        "steps": [
            {"id": "apply", "text": "Apply", "status": "completed"},
            {"id": "verify", "text": "Verify", "status": "completed"},
        ],
        "current_command": None,
        "failure": None,
    })


class RuntimeTaskRecoveryTests(unittest.TestCase):
    def test_runtime_start_archives_completed_waiting_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            make_completed_waiting(root)
            runtime = Runtime(root)
            self.assertEqual(runtime.task_state.get()["lifecycle_state"], "idle")
            self.assertEqual(runtime.task_state.history(1)[0]["archive_reason"], "recovered-completed-waiting")
            runtime.close()

    def test_workspace_switch_runs_same_completed_waiting_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            first = base / "first"
            second = base / "second"
            first.mkdir()
            second.mkdir()
            make_completed_waiting(second)
            with patch.dict(os.environ, {"CODING_TOOLS_MCP_AUTHORIZED_ROOTS": json.dumps([str(second)])}):
                runtime = Runtime(first)
                result = runtime.switch_workspace(second)
                self.assertTrue(result["changed"])
                self.assertEqual(runtime.task_state.get()["lifecycle_state"], "idle")
                self.assertEqual(runtime.task_state.history(1)[0]["archive_reason"], "recovered-completed-waiting")
                runtime.close()


if __name__ == "__main__":
    unittest.main()
