from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.task_state import TaskStateStore


class ToolEventBoundaryTests(unittest.TestCase):
    def test_apply_patch_success_keeps_files_changed_and_adds_bounded_tool_completed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("tool event boundaries")
            huge = "x" * 20_000
            store.record_tool_result(
                "apply_patch",
                {"patch": huge},
                {
                    "ok": True,
                    "affected_files": [{"path": "electron/main.js", "operation": "update"}],
                    "summary": huge,
                },
            )
            events = store.events_since(0, limit=100)
            self.assertIn("files.changed", [item["type"] for item in events])
            completed = next(item for item in events if item["type"] == "tool.completed")
            details = completed["payload"]["details"]
            self.assertEqual(details["tool"], "apply_patch")
            self.assertEqual(details["status"], "completed")
            self.assertEqual(details["affected_files"][0]["path"], "electron/main.js")
            self.assertLess(len(details["arguments"]["patch"]), len(huge))
            self.assertIn("<truncated", details["arguments"]["patch"])
            self.assertLess(len(details["result"]["summary"]), len(huge))

    def test_terminal_agent_workflow_final_result_still_gets_tool_completed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("background workflow final boundary")
            store.update({"status": "completed", "current_step": "Completed"})
            before = store.latest_event_id()
            store.record_tool_result(
                "agent_workflow",
                {"phase": "execute", "objective": "ship"},
                {"ok": True, "phase": "execute", "status": "passed", "affected_files": []},
            )
            events = store.events_since(before, limit=20)
            self.assertEqual([item["type"] for item in events], ["tool.completed"])
            self.assertEqual(events[0]["payload"]["details"]["tool"], "agent_workflow")
            self.assertEqual(events[0]["payload"]["details"]["status"], "passed")
            state = store.get()
            self.assertEqual(state["lifecycle_state"], "completed")
            self.assertIsNone(state["current_command"])

    def test_prepare_and_command_tools_do_not_duplicate_generic_tool_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("tool filtering")
            before_prepare = store.latest_event_id()
            store.record_tool_result(
                "agent_workflow",
                {"phase": "prepare", "objective": "inspect"},
                {"ok": True, "phase": "prepare", "status": "prepared"},
            )
            self.assertEqual(store.latest_event_id(), before_prepare)
            store.record_command_started("echo ok", "session-tool-filter", temp)
            store.record_tool_result(
                "exec_command",
                {"cmd": "echo ok"},
                {"ok": True, "status": "exited", "session_id": "session-tool-filter", "exit_code": 0, "elapsed_ms": 1},
            )
            events = store.events_since(0, limit=100)
            self.assertEqual(len([item for item in events if item["type"] == "command.completed"]), 1)
            self.assertEqual(len([item for item in events if item["type"] == "tool.completed"]), 0)

    def test_failed_tool_emits_tool_failed_with_bounded_error_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("tool failure")
            store.record_tool_result(
                "apply_patch",
                {"patch": "bad patch"},
                {"ok": False, "status": "failed", "error": {"code": "PATCH_FAILED", "message": "bad patch"}},
            )
            event = next(item for item in store.events_since(0, limit=100) if item["type"] == "tool.failed")
            details = event["payload"]["details"]
            self.assertEqual(details["tool"], "apply_patch")
            self.assertEqual(details["code"], "PATCH_FAILED")
            self.assertEqual(details["status"], "failed")
            self.assertEqual(details["result"]["error"]["message"], "bad patch")


if __name__ == "__main__":
    unittest.main()
