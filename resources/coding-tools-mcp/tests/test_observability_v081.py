from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coding_tools_mcp.server import Runtime
from coding_tools_mcp.task_state import TaskStateStore


class ObservabilityV081Tests(unittest.TestCase):
    def test_direct_command_supersedes_terminal_task_with_fresh_running_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("previous task")
            store.update({"status": "completed", "current_step": "Completed"})
            store.record_command_started(
                "python -c pass",
                "session-new",
                ".",
                execution={"execution_id": "exec-new", "lifecycle_state": "running", "pid": 1234},
                allow_new_task_after_terminal=True,
            )
            state = store.get()
            self.assertEqual(state["lifecycle_state"], "running")
            self.assertEqual(state["task_origin"], "implicit_command")
            self.assertEqual(state["current_command"]["session_id"], "session-new")
            self.assertNotEqual(state["objective"], "previous task")

    def test_short_failed_agent_workflow_returns_structured_tool_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            command = subprocess.list2cmdline([sys.executable, "-c", "import sys; sys.exit(9)"])
            try:
                result = runtime.call_tool("agent_workflow", {
                    "workflow": "diagnose",
                    "phase": "run",
                    "objective": "structured failure probe",
                    "commands": [command],
                    "verification": "none",
                })
                self.assertTrue(result["isError"])
                error = result["structuredContent"]["error"]
                self.assertTrue(error["code"])
                self.assertTrue(error["message"])
                self.assertIn("retry_safe", error["details"])
                self.assertIn("side_effect_possible", error["details"])
            finally:
                runtime.close()

    def test_commands_only_run_skips_full_prepare_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            command = subprocess.list2cmdline([sys.executable, "-c", "print('fast-path-ok')"])
            try:
                with patch.object(runtime, "prepare_coding_context", side_effect=AssertionError("full prepare must be skipped")):
                    result = runtime.agent_workflow({
                        "workflow": "diagnose",
                        "phase": "run",
                        "objective": "commands-only fast path probe",
                        "commands": [command],
                        "verification": "none",
                    })
                self.assertTrue(result["execution"]["ok"])
                self.assertEqual(result["prepared"]["fast_path"], "commands_only")
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
