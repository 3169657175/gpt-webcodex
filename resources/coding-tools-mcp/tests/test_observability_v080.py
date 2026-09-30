from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coding_tools_mcp.server import Runtime


class ObservabilityV080Tests(unittest.TestCase):
    def test_schema_validation_failure_is_structured_instead_of_escaping_tool_call(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            try:
                result = runtime.call_tool("workspace_context", {"max_entries": 501})
                self.assertTrue(result["isError"])
                error = result["structuredContent"]["error"]
                self.assertIn(error["category"], {"validation", "internal"})
                self.assertTrue(error["message"])
            finally:
                runtime.close()

    def test_runtime_layers_distinguish_waiting_model_from_running_wrapper_operation(self) -> None:
        from coding_tools_mcp.runtime_v2 import layered_runtime_state

        state = {
            "status": "waiting",
            "lifecycle_state": "waiting_model",
            "run_id": "run-1",
            "updated_at": "2026-09-30T14:00:00Z",
        }
        operation = {"run_id": "run-1", "status": "running", "heartbeat_at": "2026-09-30T14:00:00Z"}
        layered = layered_runtime_state(state, [operation])
        self.assertEqual(layered["user"]["state"], "waiting_model")
        self.assertEqual(layered["execution"]["state"], "waiting")


if __name__ == "__main__":
    unittest.main()
