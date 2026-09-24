from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class RecipeRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {
            "CODING_TOOLS_MCP_AGENT_MODE": "code",
            "CODING_TOOLS_MCP_TOOL_PERMISSIONS": json.dumps({"read": "allow", "write": "ask", "command": "deny"}),
        })
        self.env.start()
        self.runtime = Runtime(self.root, auth_token="recipe-token", transport="http", permission_mode="dangerous")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.runtime.close(); self.env.stop(); self.temp.cleanup()

    def post(self, payload: dict, *, token: str | None = "recipe-token") -> tuple[int, dict]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/__control/recipes",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_private_recipe_control_requires_bearer_and_lists_builtins(self) -> None:
        status, _ = self.post({"action": "list"}, token=None)
        self.assertEqual(status, 401)
        status, payload = self.post({"action": "list"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 4)
        self.assertIsNone(payload["recipe_context"]["active"])

    def test_activate_recipe_updates_context_without_changing_runtime_policy(self) -> None:
        before_mode = self.runtime.agent_mode
        before_policies = dict(self.runtime.approvals.policies)
        status, payload = self.post({"action": "activate", "recipe_id": "fix-bug"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["recipe_context"]["active"]["id"], "fix-bug")
        self.assertEqual(self.runtime.agent_mode, before_mode)
        self.assertEqual(self.runtime.approvals.policies, before_policies)
        self.assertFalse(payload["recipe_context"]["security"]["permission_escalation"])
        self.assertIn("command", payload["recipe_context"]["security"]["denied_categories"])
        self.assertIn("write", payload["recipe_context"]["security"]["approval_categories"])

        workspace = self.runtime.workspace_context({"detail": "compact"})
        self.assertEqual(workspace["recipe_context"]["active"]["id"], "fix-bug")
        self.assertNotIn("steps", workspace["recipe_context"]["active"])
        prepared = self.runtime.prepare_coding_context({"objective": "repair failure"})
        self.assertEqual(prepared["recipe"]["active"]["id"], "fix-bug")
        self.assertEqual(len(prepared["recipe"]["active"]["steps"]), 3)

    def test_deactivate_recipe_clears_cached_context_without_restart(self) -> None:
        self.post({"action": "activate", "recipe_id": "frontend-regression"})
        first = self.runtime.workspace_context({})
        self.assertEqual(first["recipe_context"]["active"]["id"], "frontend-regression")
        instance_id = self.runtime.server_instance_id
        status, payload = self.post({"action": "deactivate"})
        self.assertEqual(status, 200)
        self.assertIsNone(payload["recipe_context"]["active"])
        second = self.runtime.workspace_context({})
        self.assertIsNone(second["recipe_context"]["active"])
        self.assertEqual(self.runtime.server_instance_id, instance_id)


if __name__ == "__main__":
    unittest.main()
