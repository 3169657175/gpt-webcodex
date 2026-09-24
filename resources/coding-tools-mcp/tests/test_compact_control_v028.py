from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class CompactControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(Path(self.temp.name), auth_token="compact-test-token", transport="http")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.runtime.close()
        self.temp.cleanup()

    def post(self, *, token: str = "") -> tuple[int, dict]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/__control/compact",
            data=b"{}",
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return int(exc.code), json.loads(exc.read().decode("utf-8"))

    def test_compact_control_requires_bearer(self) -> None:
        status, _payload = self.post()
        self.assertEqual(status, 401)

    def test_compact_control_creates_local_session_checkpoint(self) -> None:
        state = self.runtime.task_state.update({
            "objective": "HTTP compact test",
            "status": "active",
            "current_step": "验证 Compact",
            "next_step": "在新对话 Resume",
        }, event="test_seed")
        self.assertTrue(state.get("task_id"))
        self.assertTrue(state.get("run_id"))
        status, payload = self.post(token="compact-test-token")
        self.assertEqual(status, 200)
        self.assertTrue(payload.get("ok"))
        self.assertRegex(str(payload.get("local_session_id") or ""), r"^ls_[a-f0-9]{24}$")
        self.assertRegex(str(payload.get("checkpoint_id") or ""), r"^cp_[a-f0-9]{24}$")
        brief = payload.get("continuation_brief") or {}
        self.assertEqual(brief.get("goal"), "HTTP compact test")
        self.assertEqual(brief.get("next_action"), "在新对话 Resume")


if __name__ == "__main__":
    unittest.main()
