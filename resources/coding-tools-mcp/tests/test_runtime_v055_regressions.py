from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.build_verify import verify_build
from coding_tools_mcp.server import Runtime
from coding_tools_mcp.task_state import TaskStateStore


class RuntimeV055RegressionTests(unittest.TestCase):
    def test_successful_follow_up_command_resets_consecutive_recovery_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("recover once")
            store.update({"lifecycle_state": "failed", "failure": "old failure"})
            store.record_command_started(
                "python -V",
                "session-recover-v056",
                ".",
                execution={
                    "execution_id": "exec-recover-v056",
                    "lifecycle_state": "running",
                    "retry_safe": False,
                    "side_effect_possible": True,
                },
            )
            recovering = store.get()
            self.assertEqual(recovering["recovery_attempt"], 1)
            self.assertEqual(recovering["last_recovery"]["reason"], "follow_up_command")
            store.record_tool_result("exec_command", {"cmd": "python -V"}, {
                "ok": True,
                "status": "exited",
                "exit_code": 0,
                "elapsed_ms": 10,
                "session_id": "session-recover-v056",
                "execution": {"execution_id": "exec-recover-v056", "lifecycle_state": "completed"},
            })
            recovered = store.get()
            self.assertEqual(recovered["recovery_attempt"], 0)
            self.assertIsNone(recovered["last_recovery"])
            self.assertEqual(recovered["safe_resume_point"], "")

    def test_terminal_lifecycle_finalizes_stale_command_execution_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("terminal synchronization")
            store.record_command_started(
                "npm run test",
                "session-terminal-v056",
                ".",
                execution={
                    "execution_id": "exec-terminal-v056",
                    "lifecycle_state": "running",
                    "started_at": "2026-09-24T00:00:00.000Z",
                    "retry_safe": False,
                    "side_effect_possible": True,
                },
            )
            store.update({"lifecycle_state": "completed", "current_step": "Completed"})
            state = store.get()
            self.assertIsNone(state["current_command"])
            self.assertEqual(state["lifecycle_state"], "completed")
            self.assertEqual(state["last_command"]["status"], "completed")
            self.assertEqual(state["last_command"]["execution_lifecycle_state"], "completed")
            self.assertEqual(state["last_command"]["exit_code"], 0)
            self.assertTrue(state["last_command"]["execution_finished_at"])

    def test_auto_isolation_skips_read_only_diagnose_and_artifact_only_release(self) -> None:
        self.assertFalse(Runtime._workflow_needs_auto_isolation("diagnose", {"commands": ["npm run test"]}))
        self.assertFalse(Runtime._workflow_needs_auto_isolation("build_release", {"commands": ["npm run dist"]}))
        self.assertFalse(Runtime._workflow_needs_auto_isolation("diagnose", {}))

    def test_auto_isolation_keeps_source_mutations_and_unknown_command_workflows_isolated(self) -> None:
        self.assertTrue(Runtime._workflow_needs_auto_isolation(
            "diagnose", {"patch": "*** Begin Patch\\n*** End Patch"}
        ))
        self.assertTrue(Runtime._workflow_needs_auto_isolation("bugfix", {"commands": ["npm run test"]}))
        self.assertTrue(Runtime._workflow_needs_auto_isolation(
            "feature", {"files": [{"path": "x.txt", "content": "x"}]}
        ))
        self.assertFalse(Runtime._worktree_diff_has_changes({"diff": "", "truncated": False}))
        self.assertTrue(Runtime._worktree_diff_has_changes({"diff": "diff --git a/x b/x", "truncated": False}))
        self.assertTrue(Runtime._worktree_diff_has_changes({"diff": "", "truncated": True}))
        self.assertTrue(Runtime._worktree_diff_has_changes(None))

    def test_command_result_distinguishes_environment_launch_failure(self) -> None:
        self.assertEqual(Runtime._command_result_status({"exit_code": 0, "status": "exited"}), "passed")
        self.assertEqual(Runtime._command_result_status({
            "exit_code": 1,
            "status": "exited",
            "summary": "'npm.CMD' 不是内部或外部命令，也不是可运行的程序或批处理文件。",
        }), "environment_failed")
        self.assertEqual(Runtime._command_result_status({"exit_code": 1, "status": "exited", "summary": "assertion failed"}), "failed")
        self.assertEqual(Runtime._command_result_status({
            "exit_code": None,
            "status": "failed",
            "execution": {"lifecycle_state": "not_started"},
        }), "environment_failed")

    @unittest.skipUnless(os.name == "nt", "Windows cmd quoting regression")
    def test_windows_structured_batch_command_preserves_nested_cmd_quotes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            env = runtime._command_env({})
            original_which = shutil.which

            def fake_which(name: str, path: str | None = None) -> str | None:
                if str(name).lower() == "npm":
                    return r"C:\Program Files\nodejs\npm.CMD"
                if str(name).lower() == "cmd.exe":
                    return os.environ.get("COMSPEC") or r"C:\Windows\System32\cmd.exe"
                return original_which(name, path=path)

            with patch.object(server_module.shutil, "which", side_effect=fake_which):
                command = runtime._structured_process_argv("npm run test", env)
            self.assertIsInstance(command, str)
            self.assertIn('/d /s /c ""C:\\Program Files\\nodejs\\npm.CMD" run test"', str(command))
            self.assertNotIn(r'\"C:\Program Files\nodejs\npm.CMD\"', str(command))
            runtime.close()

    def test_failed_task_auto_recovers_on_follow_up_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("recover failed workflow")
            store.update({
                "lifecycle_state": "failed",
                "failure": "first check failed",
                "current_step": "检查失败",
                "next_step": "重新验证",
            })
            store.record_command_started(
                "echo ok",
                "session-recover",
                ".",
                execution={
                    "execution_id": "exec-recover",
                    "lifecycle_state": "running",
                    "retry_safe": False,
                    "side_effect_possible": True,
                },
            )
            recovering = store.get()
            self.assertEqual(recovering["lifecycle_state"], "recovering")
            self.assertIsNone(recovering["failure"])
            self.assertEqual(recovering["recovery_attempt"], 1)
            self.assertEqual(recovering["last_recovery"]["reason"], "follow_up_command")

            store.record_tool_result(
                "exec_command",
                {"cmd": "echo ok", "blocking": True},
                {
                    "ok": True,
                    "status": "exited",
                    "session_id": "session-recover",
                    "exit_code": 0,
                    "elapsed_ms": 1,
                    "summary": "exit 0",
                },
            )
            recovered = store.get()
            self.assertEqual(recovered["lifecycle_state"], "waiting_model")
            self.assertIsNone(recovered["failure"])

    def test_blocking_command_failure_keeps_its_real_failure_message(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("failed command")
            store.record_command_started("exit 2", "session-fail", ".")
            store.record_tool_result(
                "exec_command",
                {"cmd": "exit 2", "blocking": True},
                {
                    "ok": True,
                    "status": "exited",
                    "session_id": "session-fail",
                    "exit_code": 2,
                    "elapsed_ms": 1,
                    "summary": "real command failure",
                },
            )
            failed = store.get()
            self.assertEqual(failed["lifecycle_state"], "failed")
            self.assertEqual(failed["failure"], "real command failure")

    def test_stale_command_poll_does_not_poison_active_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("long build")
            store.record_command_started("npm run dist", "session-live", ".")
            before = store.get()
            self.assertEqual(before["current_command"]["session_id"], "session-live")

            store.record_tool_result(
                "command_control",
                {"action": "poll", "session_id": "session-old"},
                {
                    "ok": False,
                    "error": {
                        "code": "SESSION_NOT_FOUND",
                        "message": "Session not found; stdin access denied.",
                    },
                },
            )
            after = store.get()
            self.assertEqual(after["lifecycle_state"], "running")
            self.assertEqual(after["current_command"]["session_id"], "session-live")
            self.assertIsNone(after["failure"])

    def test_command_control_poll_finishes_current_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("long build")
            store.record_command_started("npm run dist", "session-live", ".")
            store.record_tool_result(
                "command_control",
                {"action": "poll", "session_id": "session-live"},
                {
                    "ok": True,
                    "status": "exited",
                    "session_id": "session-live",
                    "exit_code": 0,
                    "elapsed_ms": 1234,
                    "summary": "exit 0",
                    "execution": {"lifecycle_state": "completed"},
                },
            )
            after = store.get()
            self.assertIsNone(after["current_command"])
            self.assertEqual(after["last_command"]["session_id"], "session-live")
            self.assertEqual(after["last_command"]["exit_code"], 0)
            self.assertEqual(after["lifecycle_state"], "waiting_model")
            self.assertIsNone(after["failure"])

    def test_read_only_task_query_does_not_clear_real_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("failed workflow")
            store.update({
                "lifecycle_state": "failed",
                "failure": "real failure",
                "current_step": "verify",
            })
            store.record_tool_result("task_control", {"action": "get"}, {"ok": True})
            after = store.get()
            self.assertEqual(after["lifecycle_state"], "failed")
            self.assertEqual(after["failure"], "real failure")

    def test_build_verification_labels_launch_failure_as_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text(json.dumps({
                "name": "demo",
                "version": "1.0.0",
                "scripts": {"test": "node --test"},
            }), encoding="utf-8")

            def runner(command: str, workdir: Path, timeout: int) -> dict[str, object]:
                return {
                    "command": command,
                    "status": "environment_failed",
                    "exit_code": 1,
                    "duration_ms": 1,
                    "summary": "npm.CMD 不是内部或外部命令",
                }

            report = verify_build(root, {
                "run_tests": True,
                "run_build": False,
                "test_command": "npm run test",
            }, runner)
            self.assertEqual(report["overall_status"], "failed")
            self.assertEqual(report["failure_kind"], "environment")
            self.assertIn("测试命令未能启动", str(report["failure"]))


if __name__ == "__main__":
    unittest.main()
