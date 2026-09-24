from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.checkpoint_store import CheckpointStore
from coding_tools_mcp.local_session_store import LocalSessionStore, build_continuation_brief


IDENTITY = {"version": 1, "project_id": "project-demo", "source": "remote", "evidence": "example/repo"}


class LocalSessionStoreTests(unittest.TestCase):
    def test_session_survives_store_restart_and_reuses_project_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = LocalSessionStore(root, IDENTITY)
            session = first.ensure({"task_id": "task-1", "run_id": "run-1", "objective": "ship", "next_step": "test"})
            reopened = LocalSessionStore(root, IDENTITY)
            current = reopened.current()
            self.assertIsNotNone(current)
            self.assertEqual(current["local_session_id"], session["local_session_id"])
            self.assertEqual(current["current_run_id"], "run-1")
            self.assertNotIn("conversation", json.dumps(current).lower())

    def test_different_project_identity_does_not_reuse_current_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            one = LocalSessionStore(root, IDENTITY).ensure({"task_id": "t1", "run_id": "r1"})
            two_store = LocalSessionStore(root, {**IDENTITY, "project_id": "project-two"})
            self.assertIsNone(two_store.current())
            two = two_store.ensure({"task_id": "t2", "run_id": "r2"})
            self.assertNotEqual(one["local_session_id"], two["local_session_id"])

    def test_checkpoint_binding_is_bounded_and_persistent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sessions = LocalSessionStore(root, IDENTITY)
            session = sessions.ensure({"task_id": "t", "run_id": "r", "objective": "goal"})
            store = CheckpointStore(root, project_identity=IDENTITY)
            checkpoint = store.create(
                "compact",
                task_state={"task_id": "t", "run_id": "r", "objective": "goal", "next_step": "continue"},
                local_session_id=session["local_session_id"],
                continuation={"goal": "goal", "completed": ["one"], "pending": ["two"], "next_action": "continue"},
                runtime_identity={"runtime_version": "0.4.12", "schema_version": 7, "schema_hash": "abc"},
                memory_refs=["mem-1"],
            )
            sessions.bind_checkpoint(session["local_session_id"], checkpoint)
            reopened = LocalSessionStore(root, IDENTITY).current()
            self.assertEqual(reopened["latest_checkpoint_id"], checkpoint["checkpoint_id"])
            self.assertEqual(checkpoint["local_session_id"], session["local_session_id"])
            self.assertEqual(checkpoint["continuation"]["pending"], ["two"])
            self.assertEqual(checkpoint["memory_refs"], ["mem-1"])

    def test_continuation_brief_is_compact_and_does_not_include_raw_diff(self) -> None:
        brief = build_continuation_brief(
            {"local_session_id": "ls_" + "a" * 24},
            {
                "checkpoint_id": "cp_" + "b" * 24,
                "current_goal": "goal",
                "next_action": "next",
                "modified_files": [{"path": "app.py", "operation": "update"}],
                "continuation": {"completed": ["done"], "pending": ["todo"], "errors": ["bounded"]},
                "git": {"diff": "SHOULD_NOT_APPEAR"},
            },
            validation={"ok": True},
        )
        encoded = json.dumps(brief)
        self.assertNotIn("SHOULD_NOT_APPEAR", encoded)
        self.assertNotIn("git", brief)
        self.assertEqual(brief["pending"], ["todo"])


if __name__ == "__main__":
    unittest.main()
