from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.approval import LocalApprovalStore, normalize_permission_policies


class LocalApprovalStoreTests(unittest.TestCase):
    def test_policy_normalization_is_closed_over_known_categories(self) -> None:
        policies = normalize_permission_policies({"command": "allow", "network": "bad", "unknown": "deny"})
        self.assertEqual(policies["command"], "allow")
        self.assertEqual(policies["network"], "allow")
        self.assertNotIn("unknown", policies)
        self.assertEqual(len(policies), 8)

    def test_ask_creates_pending_without_persisting_raw_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(root, "runtime-a", {"command": "ask"})
            result = store.check(
                tool="exec_command",
                args={"cmd": "echo TOP-SECRET-TEXT"},
                categories=["command"],
                risk_level="R3",
                summary="执行命令: echo",
            )
            self.assertEqual(result["decision"], "ask")
            state_text = store.state_path.read_text(encoding="utf-8")
            self.assertNotIn("TOP-SECRET-TEXT", state_text)
            state = json.loads(state_text)
            self.assertEqual(state["requests"][-1]["status"], "pending")
            self.assertEqual(state["requests"][-1]["categories"], ["command"])

    def test_once_approval_is_consumed_on_exact_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(root, "runtime-a", {"command": "ask"})
            args = {"cmd": "npm test"}
            first = store.check(tool="exec_command", args=args, categories=["command"], risk_level="R3", summary="执行命令: npm")
            state = json.loads(store.state_path.read_text(encoding="utf-8"))
            state["requests"][-1]["status"] = "approved_once"
            state["requests"][-1]["decision_at"] = "now"
            store.state_path.write_text(json.dumps(state), encoding="utf-8")
            second = store.check(tool="exec_command", args=args, categories=["command"], risk_level="R3", summary="执行命令: npm")
            self.assertEqual(second["decision"], "allow")
            self.assertEqual(second["source"], "approval_once")
            final_state = json.loads(store.state_path.read_text(encoding="utf-8"))
            self.assertEqual(final_state["requests"][-1]["status"], "consumed")
            self.assertEqual(first["request_id"], second["request_id"])

    def test_session_grant_is_bound_to_runtime_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(root, "runtime-a", {"command": "ask"})
            store.state_path.parent.mkdir(parents=True, exist_ok=True)
            state = {
                "version": 1,
                "requests": [],
                "grants": [{"grant_id": "g1", "status": "active", "scope": "session", "categories": ["command"], "runtime_instance_id": "runtime-a"}],
            }
            store.state_path.write_text(json.dumps(state), encoding="utf-8")
            allowed = store.check(tool="exec_command", args={"cmd": "npm test"}, categories=["command"], risk_level="R3", summary="执行命令: npm")
            self.assertEqual(allowed["decision"], "allow")
            other = LocalApprovalStore(root, "runtime-b", {"command": "ask"})
            blocked = other.check(tool="exec_command", args={"cmd": "npm test"}, categories=["command"], risk_level="R3", summary="执行命令: npm")
            self.assertEqual(blocked["decision"], "ask")

    def test_project_grant_and_never_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(root, "runtime-a", {"command": "ask", "system_modify": "deny"})
            store.state_path.parent.mkdir(parents=True, exist_ok=True)
            store.state_path.write_text(json.dumps({
                "version": 1,
                "requests": [],
                "grants": [{"grant_id": "g1", "status": "active", "scope": "project", "categories": ["command"]}],
            }), encoding="utf-8")
            allowed = store.check(tool="exec_command", args={"cmd": "npm test"}, categories=["command"], risk_level="R3", summary="执行命令: npm")
            denied = store.check(tool="exec_command", args={"cmd": "reg add ..."}, categories=["command", "system_modify"], risk_level="R4", summary="系统修改")
            self.assertEqual(allowed["decision"], "allow")
            self.assertEqual(denied["decision"], "deny")
            self.assertIn("system_modify", denied["denied_categories"])

    def test_audit_redacts_secrets_and_keeps_only_summary_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = LocalApprovalStore(root, "runtime-a")
            store.audit({"event": "test", "summary": "Authorization: Bearer secret-value token=abc123"})
            text = store.audit_path.read_text(encoding="utf-8")
            self.assertNotIn("secret-value", text)
            self.assertNotIn("abc123", text)
            self.assertIn("redacted", text)


if __name__ == "__main__":
    unittest.main()
