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
from coding_tools_mcp.server import Runtime


class BackgroundProgressRegressionTests(unittest.TestCase):
    def test_is_error_result_finalizes_operation_and_task_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def failed_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.04)
                return {
                    "isError": True,
                    "structuredContent": {
                        "ok": False,
                        "error": {
                            "code": "PATCH_REJECTED",
                            "message": "atomic patch rejected",
                            "category": "validation",
                            "retryable": False,
                        },
                    },
                }

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                runtime, "_call_tool_sync", side_effect=failed_result
            ):
                first = runtime.call_tool("agent_workflow", {"phase": "run", "objective": "failure regression"})
                operation_id = first["structuredContent"]["background_operation"]["operation_id"]
                polled = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})
                operation = polled["background_operation"]
                state = runtime.task_state.get()
                self.assertEqual(operation["status"], "failed")
                self.assertEqual(operation["error"]["message"], "atomic patch rejected")
                self.assertEqual(state["lifecycle_state"], "failed")
                self.assertEqual(state["status"], "failed")
                self.assertEqual(state["failure"], "atomic patch rejected")
            runtime.close()

    def test_progress_report_is_due_only_once_per_interval_after_initial_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def slow_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.35)
                return {"done": True}

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                server_module, "PROGRESS_REPORT_SECONDS", 0.05
            ), patch.object(runtime, "_call_tool_sync", side_effect=slow_result):
                first = runtime.call_tool("agent_workflow", {"phase": "run", "objective": "progress regression"})
                structured = first["structuredContent"]
                self.assertTrue(structured["requires_progress_report"])
                operation_id = structured["background_operation"]["operation_id"]

                immediate = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertEqual(immediate["status"], "running")
                self.assertFalse(immediate["requires_progress_report"])

                time.sleep(0.07)
                due = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertTrue(due["requires_progress_report"])

                immediate_again = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertFalse(immediate_again["requires_progress_report"])

                completed = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})["background_operation"]
                self.assertEqual(completed["status"], "completed")
                self.assertFalse(completed["requires_progress_report"])
            runtime.close()


if __name__ == "__main__":
    unittest.main()
