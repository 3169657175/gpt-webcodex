from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


class HistoryRuntimeTests(unittest.TestCase):
    def test_first_terminal_transition_archives_once_and_restart_stays_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                task = runtime.task_state.ensure_started("history terminal", current_step="working")
                session = runtime.local_sessions.ensure(task)
                runtime.task_state.update({"status": "completed", "current_step": "Completed"})
                items = runtime.history_store.list(limit=10)
                self.assertEqual(len(items), 1)
                self.assertEqual(items[0]["task_id"], task["task_id"])
                self.assertEqual(items[0]["local_session_id"], session["local_session_id"])
                self.assertEqual(items[0]["status"], "completed")
                runtime.task_state.update({"status": "completed", "current_step": "Completed again"})
                self.assertEqual(len(runtime.history_store.list(limit=10)), 1)
            finally:
                runtime.close()
            reopened = Runtime(root, permission_mode="dangerous")
            try:
                self.assertEqual(len(reopened.history_store.list(limit=10)), 1)
            finally:
                reopened.close()

    def test_all_terminal_lifecycles_archive(self) -> None:
        for status, expected in (("completed", "completed"), ("failed", "failed"), ("stopped", "cancelled")):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                runtime = Runtime(Path(temp), permission_mode="dangerous")
                try:
                    runtime.task_state.ensure_started(f"terminal {status}")
                    runtime.task_state.update({"status": status, "failure": "boom" if status == "failed" else None})
                    item = runtime.history_store.list(limit=1)[0]
                    self.assertEqual(item["status"], expected)
                finally:
                    runtime.close()

    def test_runtime_initialization_imports_legacy_json_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_dir = root / ".coding-tools"
            state_dir.mkdir(parents=True)
            legacy = [{"task_id": "legacy-task", "run_id": "legacy-run", "objective": "legacy history", "status": "completed"}]
            (state_dir / "task-history.json").write_text(json.dumps(legacy), encoding="utf-8")
            first = Runtime(root, permission_mode="dangerous")
            try:
                self.assertEqual([item["task_id"] for item in first.history_store.list(limit=10)], ["legacy-task"])
            finally:
                first.close()
            second = Runtime(root, permission_mode="dangerous")
            try:
                self.assertEqual([item["task_id"] for item in second.history_store.list(limit=10)], ["legacy-task"])
            finally:
                second.close()

    def test_history_store_failure_never_changes_terminal_task_result(self) -> None:
        class BrokenHistory:
            def upsert(self, _record):
                raise OSError("history disk failure")

        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            try:
                runtime.history_store = BrokenHistory()
                runtime.task_state.ensure_started("failure isolation")
                state = runtime.task_state.update({"status": "completed", "current_step": "Completed"})
                self.assertEqual(state["lifecycle_state"], "completed")
                self.assertEqual(state["status"], "completed")
                self.assertIn("history disk failure", runtime.task_state.last_terminal_callback_error)
            finally:
                runtime.close()

    def test_terminal_history_contains_bounded_checkpoint_session_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                task = runtime.task_state.ensure_started("evidence task", current_step="working")
                session = runtime.local_sessions.ensure(task)
                runtime.task_state.update({
                    "steps": [
                        {"id": "done", "text": "done step", "status": "completed"},
                        {"id": "todo", "text": "release package", "status": "pending"},
                    ],
                    "modified_files": [{"path": "src/app.js", "operation": "update"}],
                })
                checkpoint = runtime.checkpoints.create(
                    "test_complete", task_state=runtime.task_state.get(), local_session_id=session["local_session_id"],
                    git={"branch": "main", "head": "abcdef", "dirty": True, "diff": "DO_NOT_STORE"},
                    worktree={"branch": "coding-tools/run-evidence", "base_commit": "base", "snapshot_commit": "snap",
                              "snapshot_dirty": True, "snapshot_changed_count": 2, "exists": True, "clean": True,
                              "status": "active", "status_summary": "DO_NOT_STORE"},
                    modified_files=[{"path": "src/app.js", "operation": "update"}],
                    test_summary={"status": "passed", "summary": "tests ok", "stdout": "DO_NOT_STORE"},
                    continuation={"goal": "evidence task", "completed": ["done step"], "pending": ["release package"], "next_action": "release"},
                )
                runtime.local_sessions.bind_checkpoint(session["local_session_id"], checkpoint)
                runtime.task_state.record_build_report({"overall_status": "passed", "build_result": {"status": "passed", "summary": "build ok"}})
                runtime.task_state.update({"status": "completed", "current_step": "Completed"})
                item = runtime.history_store.list(limit=1)[0]
                evidence = item["session_evidence"]
                self.assertEqual(evidence["verdict"], "passed")
                self.assertEqual(evidence["local_session_id"], session["local_session_id"])
                self.assertEqual(evidence["checkpoint_id"], checkpoint["checkpoint_id"])
                self.assertEqual(evidence["git"]["branch"], "main")
                self.assertTrue(evidence["worktree"]["exists"])
                self.assertIn("release package", evidence["unfinished_steps"])
                self.assertNotIn("DO_NOT_STORE", json.dumps(item))
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
