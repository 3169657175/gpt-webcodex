from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.task_state import TaskStateStore


class WaitingRecoveryTests(unittest.TestCase):
    def test_completed_waiting_task_is_archived_without_new_terminal_event(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            store.ensure_started("legacy completed task")
            store.update({
                "lifecycle_state": "waiting_model",
                "current_step": "Waiting for model",
                "steps": [
                    {"id": "apply", "text": "Apply", "status": "completed"},
                    {"id": "verify", "text": "Verify", "status": "completed"},
                ],
                "current_command": None,
                "failure": None,
            })
            event_id = store.latest_event_id()
            recovered = store.recover_completed_waiting_task()
            self.assertEqual(recovered["lifecycle_state"], "idle")
            self.assertFalse(store.path.exists())
            self.assertEqual(store.latest_event_id(), event_id)
            history = store.history(5)
            self.assertEqual(history[0]["lifecycle_state"], "completed")
            self.assertEqual(history[0]["archive_reason"], "recovered-completed-waiting")

    def test_incomplete_waiting_task_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            store.ensure_started("still pending")
            store.update({
                "lifecycle_state": "waiting_model",
                "steps": [
                    {"id": "apply", "text": "Apply", "status": "completed"},
                    {"id": "verify", "text": "Verify", "status": "pending"},
                ],
                "current_command": None,
            })
            recovered = store.recover_completed_waiting_task()
            self.assertEqual(recovered["lifecycle_state"], "waiting_model")
            self.assertTrue(store.path.exists())


if __name__ == "__main__":
    unittest.main()
