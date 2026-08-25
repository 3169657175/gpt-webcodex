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


class BackgroundExecutionFailureTests(unittest.TestCase):
    def test_execution_failure_marks_operation_and_task_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def failed_execution(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.05)
                return {
                    "isError": False,
                    "structuredContent": {
                        "ok": True,
                        "execution": {
                            "ok": False,
                            "status": "failed",
                            "build_report": {"failure": "Tests failed."},
                        },
                    },
                }

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                runtime, "_call_tool_sync", side_effect=failed_execution
            ):
                first = runtime.call_tool("agent_workflow", {"phase": "run", "objective": "execution failure regression"})
                operation_id = first["structuredContent"]["background_operation"]["operation_id"]
                polled = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})
                operation = polled["background_operation"]
                state = runtime.task_state.get()
                self.assertEqual(operation["status"], "failed")
                self.assertEqual(operation["error"]["message"], "Tests failed.")
                self.assertEqual(state["lifecycle_state"], "failed")
                self.assertEqual(state["status"], "failed")
                self.assertEqual(state["failure"], "Tests failed.")
            runtime.close()


if __name__ == "__main__":
    unittest.main()
