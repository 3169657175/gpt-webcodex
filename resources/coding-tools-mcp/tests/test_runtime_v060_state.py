from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.task_state import TaskStateStore


class RuntimeV060StateTests(unittest.TestCase):
    def test_command_without_existing_task_creates_visible_implicit_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.record_command_started("echo visible", "session-visible", ".")
            state = store.get()
            self.assertTrue(state["task_id"])
            self.assertEqual(state["task_origin"], "implicit_command")
            self.assertEqual(state["lifecycle_state"], "running")
            self.assertEqual(state["current_command"]["session_id"], "session-visible")

    def test_incremental_event_wait_returns_only_activity_after_cursor(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("wait for event")
            cursor = store.latest_event_id()

            def publish() -> None:
                time.sleep(0.03)
                store.update({"current_step": "new durable activity"})

            worker = threading.Thread(target=publish)
            worker.start()
            events = store.wait_for_events(cursor, timeout=1.0, limit=10)
            worker.join(timeout=1.0)
            self.assertEqual(len(events), 1)
            self.assertGreater(events[0]["event_id"], cursor)
            self.assertEqual(events[0]["state"]["current_step"], "new durable activity")

    def test_terminal_run_is_immutable_to_follow_up_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            started = store.ensure_started("old run")
            store.update({"lifecycle_state": "failed", "failure": "boom"})
            store.record_command_started("echo unrelated", "later-session", ".")
            state = store.get()
            self.assertEqual(state["run_id"], started["run_id"])
            self.assertEqual(state["lifecycle_state"], "failed")
            self.assertIsNone(state["current_command"])
            self.assertEqual(state["failure"], "boom")

    def test_terminal_transition_settles_running_and_pending_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("settle steps")
            store.update({"steps": [
                {"id": "done", "text": "Done", "status": "completed"},
                {"id": "run", "text": "Run", "status": "in_progress"},
                {"id": "later", "text": "Later", "status": "pending"},
            ]})
            state = store.update({"lifecycle_state": "failed", "failure": "failed"})
            by_id = {item["id"]: item for item in state["steps"]}
            self.assertEqual(by_id["run"]["status"], "failed")
            self.assertEqual(by_id["run"]["state"], "failed")
            self.assertEqual(by_id["later"]["state"], "cancelled")
            self.assertTrue(state["completion_receipt"])

    def test_old_terminal_run_retires_from_current_view_but_stays_in_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            store.ensure_started("retire")
            terminal = store.update({"lifecycle_state": "completed"})
            path = root / ".coding-tools" / "task-state.json"
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["terminal_at"] = (
                datetime.now(timezone.utc) - timedelta(minutes=2)
            ).isoformat().replace("+00:00", "Z")
            path.write_text(json.dumps(raw), encoding="utf-8")
            current = store.get()
            self.assertEqual(current["status"], "idle")
            self.assertFalse(current["task_id"])
            history = store.history(10)
            self.assertTrue(any(item.get("run_id") == terminal["run_id"] for item in history))


if __name__ == "__main__":
    unittest.main()
