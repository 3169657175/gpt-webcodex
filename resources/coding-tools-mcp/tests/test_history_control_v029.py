from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class HistoryControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = Runtime(self.root, auth_token="history-token", transport="http", permission_mode="dangerous")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.runtime.close(); self.temp.cleanup()

    def post(self, payload: dict, *, token: str | None = "history-token") -> tuple[int, dict]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/__control/history",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_history_search_requires_bearer_and_returns_bounded_sqlite_records(self) -> None:
        self.runtime.history_store.upsert({"task_id": "t1", "run_id": "r1", "objective": "修复登录超时", "status": "completed", "summary": "retry fixed"})
        status, _ = self.post({"action": "search", "query": "登录"}, token=None)
        self.assertEqual(status, 401)
        status, payload = self.post({"action": "search", "query": "登录", "limit": 20})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["items"][0]["task_id"], "t1")
        self.assertLessEqual(len(payload["items"]), 20)

    def make_resumable_history(self) -> dict:
        task = self.runtime.task_state.ensure_started("历史续接任务", current_step="working")
        session = self.runtime.local_sessions.ensure(task)
        checkpoint = self.runtime.checkpoints.create(
            "compact", task_state=task, local_session_id=session["local_session_id"],
            continuation={"goal": "历史续接任务", "completed": ["done"], "pending": ["todo"], "next_action": "todo"},
        )
        self.runtime.local_sessions.bind_checkpoint(session["local_session_id"], checkpoint)
        self.runtime.task_state.update({"status": "completed", "current_step": "Completed"})
        item = self.runtime.history_store.list(limit=1)[0]
        return item

    def test_prepare_resume_activates_history_session_and_restores_paused_task_without_executing(self) -> None:
        item = self.make_resumable_history()
        status, payload = self.post({"action": "prepare_resume", "history_id": item["history_id"]})
        self.assertEqual(status, 200)
        self.assertTrue(payload["prepared"])
        self.assertEqual(payload["local_session_id"], item["local_session_id"])
        self.assertEqual(payload["checkpoint_id"], item["checkpoint_id"])
        state = self.runtime.task_state.get()
        self.assertEqual(state["task_id"], item["task_id"])
        self.assertEqual(state["run_id"], item["run_id"])
        self.assertEqual(state["lifecycle_state"], "paused")
        self.assertEqual(self.runtime.local_sessions.current()["local_session_id"], item["local_session_id"])

    def test_prepare_resume_then_agent_workflow_resume_uses_same_task_session_and_checkpoint(self) -> None:
        item = self.make_resumable_history()
        status, payload = self.post({"action": "prepare_resume", "history_id": item["history_id"]})
        self.assertEqual(status, 200)
        result = self.runtime.agent_workflow({"workflow": "resume", "phase": "resume"})
        self.assertTrue(result["resume_safe"])
        self.assertEqual(result["task"]["task_id"], item["task_id"])
        self.assertEqual(result["task"]["run_id"], item["run_id"])
        self.assertEqual(result["task"]["lifecycle_state"], "running")
        self.assertEqual(result["local_session"]["local_session_id"], item["local_session_id"])
        self.assertEqual(result["checkpoint"]["checkpoint_id"], item["checkpoint_id"])
        self.assertEqual(result["continuation_brief"]["goal"], "历史续接任务")

    def test_prepare_resume_refuses_to_replace_another_active_task(self) -> None:
        item = self.make_resumable_history()
        self.runtime.task_state.update({"objective": "另一个任务", "new_task": True, "status": "active"})
        before = self.runtime.task_state.get()
        status, payload = self.post({"action": "prepare_resume", "history_id": item["history_id"]})
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "ACTIVE_TASK_CONFLICT")
        after = self.runtime.task_state.get()
        self.assertEqual(after["run_id"], before["run_id"])


if __name__ == "__main__":
    unittest.main()
