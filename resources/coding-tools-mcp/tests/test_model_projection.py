from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


class ModelProjectionTests(unittest.TestCase):
    def test_external_payload_is_compact_but_keeps_needed_source_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            runtime.request_context.trace_origin = "external"
            projected = runtime._project_model_payload("agent_workflow", {}, {
                "ok": True,
                "workflow": "diagnose",
                "phase": "prepare",
                "context": {
                    "files": [{"path": "server.py", "content": "needed"}],
                    "searches": [{"query": "needle"}],
                    "workspace": {"huge": "omit"},
                    "task_resume": {"events": list(range(100))},
                    "total_content_bytes": 6,
                },
            })
            self.assertEqual(projected["context"]["files"][0]["content"], "needed")
            self.assertNotIn("workspace", projected["context"])
            self.assertNotIn("task_resume", projected["context"])

    def test_task_payload_removes_history_and_large_worktree_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            runtime.request_context.trace_origin = "external"
            projected = runtime._project_model_payload("task_control", {}, {
                "state": {
                    "task_id": "t", "run_id": "r", "status": "completed", "lifecycle_state": "completed",
                    "events": [{"large": "history"}] * 100,
                    "test_results": [{"status": "passed"}],
                },
                "active_worktree": {"run_id": "r", "branch": "b", "snapshot_tracked_patch_bytes": 999999},
            })
            self.assertNotIn("events", projected["state"])
            self.assertEqual(projected["state"]["latest_test_result"]["status"], "passed")
            self.assertNotIn("snapshot_tracked_patch_bytes", projected["active_worktree"])

    def test_desktop_and_explicit_full_bypass_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            payload = {"state": {"events": [{"keep": True}]}}
            runtime.request_context.trace_origin = "desktop"
            self.assertIs(runtime._project_model_payload("task_control", {}, payload), payload)
            runtime.request_context.trace_origin = "external"
            self.assertIs(runtime._project_model_payload("task_control", {"detail": "full"}, payload), payload)


if __name__ == "__main__":
    unittest.main()
