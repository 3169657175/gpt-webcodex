from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coding_tools_mcp.approval import LocalApprovalStore
from coding_tools_mcp.runtime_v2 import context_budget_snapshot, layered_runtime_state, tool_registry_snapshot


class RuntimeV2Tests(unittest.TestCase):
    def test_layered_runtime_state_separates_execution_process_and_connection(self) -> None:
        state = {
            "task_id": "task-1",
            "run_id": "run-1",
            "local_session_id": "session-1",
            "status": "active",
            "lifecycle_state": "waiting_model",
            "current_command": {
                "status": "running",
                "execution_id": "exec-1",
                "process_id": 42,
                "session_id": "cmd-1",
            },
        }
        payload = layered_runtime_state(state, [{"status": "running", "operation_id": "op-1"}], workspace=str(Path.cwd()))
        self.assertEqual(payload["execution"]["state"], "waiting")
        self.assertEqual(payload["model"]["state"], "waiting")
        self.assertEqual(payload["process"]["state"], "running")
        self.assertEqual(payload["connection"]["state"], "connected")
        self.assertEqual(payload["correlation"]["operation_id"], "op-1")
        self.assertEqual(payload["correlation"]["process_id"], 42)

    def test_context_budget_recommends_checkpoint_before_hard_limit(self) -> None:
        normal = context_budget_snapshot({"response_bytes": 100_000}, hard_bytes=1_000_000)
        checkpoint = context_budget_snapshot({"response_bytes": 750_000}, hard_bytes=1_000_000)
        compact = context_budget_snapshot({"response_bytes": 950_000}, hard_bytes=1_000_000)
        self.assertEqual(normal["state"], "normal")
        self.assertEqual(checkpoint["state"], "prepare_checkpoint")
        self.assertTrue(checkpoint["continuation_checkpoint_recommended"])
        self.assertEqual(compact["state"], "compact_now")
        self.assertTrue(compact["prefer_output_refs"])

    def test_tool_registry_is_workspace_scoped_and_marks_core_tools(self) -> None:
        names = ["coding_tools_guide", "workspace_context", "agent_workflow", "task_control", "exec_command"]
        first = tool_registry_snapshot(names, tool_mode="smart", schema_version=8, workspace="D:/a")
        second = tool_registry_snapshot(names, tool_mode="smart", schema_version=8, workspace="D:/b")
        self.assertNotEqual(first["generation"], second["generation"])
        self.assertEqual(first["scope"], "workspace")
        core = {item["name"] for item in first["tools"] if item["core"]}
        self.assertEqual(core, {"coding_tools_guide", "workspace_context", "agent_workflow", "task_control"})

    def test_permission_patterns_override_category_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(
                root,
                "runtime-1",
                policies={"command": "ask", "read": "allow"},
                patterns={
                    "paths": [],
                    "commands": [
                        {"pattern": "npm test*", "decision": "allow", "category": "command"},
                        {"pattern": "git push*", "decision": "deny", "category": "command"},
                    ],
                },
            )
            allowed = store.check(
                tool="exec_command",
                action="run",
                categories=["command"],
                risk_level="R1",
                summary="test",
                args={"cmd": "npm test -- --runInBand"},
            )
            denied = store.check(
                tool="exec_command",
                action="run",
                categories=["command"],
                risk_level="R2",
                summary="push",
                args={"cmd": "git push origin main"},
            )
            self.assertEqual(allowed["decision"], "allow")
            self.assertEqual(allowed["source"], "pattern")
            self.assertEqual(denied["decision"], "deny")
            self.assertEqual(denied["source"], "pattern")


if __name__ == "__main__":
    unittest.main()
