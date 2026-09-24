from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.approval import LocalApprovalStore
from coding_tools_mcp.runtime_v2 import (
    context_budget_snapshot,
    layered_runtime_state,
    tool_registry_snapshot,
)


class RuntimeV050Tests(unittest.TestCase):
    def test_layered_runtime_state_separates_waiting_model_from_process(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            state = {
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "active",
                "lifecycle_state": "waiting_model",
                "current_command": {"status": "completed", "execution_id": "exec-1"},
            }
            result = layered_runtime_state(state, [], workspace=temp)
            self.assertEqual(result["execution"]["state"], "waiting")
            self.assertEqual(result["model"]["state"], "waiting")
            self.assertEqual(result["process"]["state"], "completed")
            self.assertEqual(result["workspace"]["state"], "ready")
            self.assertEqual(result["correlation"]["execution_id"], "exec-1")

    def test_context_budget_recommends_checkpoint_before_hard_limit(self) -> None:
        result = context_budget_snapshot({"response_bytes": int(1.6 * 1024 * 1024)})
        self.assertEqual(result["state"], "prepare_checkpoint")
        self.assertTrue(result["continuation_checkpoint_recommended"])
        self.assertTrue(result["prefer_output_refs"])

    def test_tool_registry_is_workspace_scoped_and_keeps_core_tools_visible(self) -> None:
        result = tool_registry_snapshot(
            ["coding_tools_guide", "workspace_context", "agent_workflow", "task_control", "exec_command"],
            tool_mode="smart",
            schema_version=8,
            workspace="C:/project",
        )
        self.assertEqual(result["scope"], "workspace")
        self.assertEqual(result["tool_count"], 5)
        self.assertIn("task_control", result["core_tools"])
        exec_meta = next(item for item in result["tools"] if item["name"] == "exec_command")
        self.assertFalse(exec_meta["retry_safe"])

    def test_command_pattern_can_override_category_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = LocalApprovalStore(
                Path(temp),
                "runtime-1",
                {"command": "ask"},
                {"commands": [{"pattern": "git status*", "decision": "allow", "category": "command"}], "paths": []},
            )
            decision = store.check(
                tool="exec_command",
                args={"cmd": "git status --short"},
                categories=["command"],
                risk_level="R3",
                summary="git status",
            )
            self.assertEqual(decision["decision"], "allow")
            self.assertEqual(decision["source"], "pattern")


if __name__ == "__main__":
    unittest.main()
