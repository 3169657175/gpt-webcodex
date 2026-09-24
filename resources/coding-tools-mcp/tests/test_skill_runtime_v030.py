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


class SkillRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        skill_dir = self.root / ".coding-tools" / "skills" / "project-review"; skill_dir.mkdir(parents=True)
        self.manifest_path = skill_dir / "skill.json"
        self.manifest_path.write_text(json.dumps({
            "id": "project-review", "name": "项目检查", "version": "1.0.0", "description": "检查项目状态",
            "instructions": "只读取必要文件，检查项目状态并给出下一步。",
            "tool_schema": {"name": "project_review", "description": "检查项目", "input_schema": {"type": "object", "properties": {}}},
            "permissions": ["read", "command"], "risk_level": "medium", "allowed_roots": ["."],
            "network_required": False, "dependencies": []
        }, ensure_ascii=False), encoding="utf-8")
        (skill_dir / "README.md").write_text("# 项目检查\n", encoding="utf-8")
        self.env = patch.dict(os.environ, {
            "CODING_TOOLS_MCP_AGENT_MODE": "code",
            "CODING_TOOLS_MCP_TOOL_MODE": "smart",
            "CODING_TOOLS_MCP_TOOL_PERMISSIONS": json.dumps({"read": "allow", "command": "deny"}),
        }); self.env.start()
        self.runtime = Runtime(self.root, auth_token="skill-token", transport="http", permission_mode="dangerous")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start(); self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2); self.runtime.close(); self.env.stop(); self.temp.cleanup()

    def post(self, payload: dict, token: str | None = "skill-token") -> tuple[int, dict]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/__control/skills", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as response: return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error: return error.code, json.loads(error.read().decode())

    def test_control_requires_bearer_and_enable_keeps_runtime_policy(self) -> None:
        self.assertEqual(self.post({"action": "list"}, None)[0], 401)
        before_mode = self.runtime.agent_mode; before_policies = dict(self.runtime.approvals.policies)
        status, validated = self.post({"action": "validate", "skill_id": "project-review"}); self.assertEqual(status, 200); self.assertTrue(validated["validation"]["ok"])
        status, enabled = self.post({"action": "enable", "skill_id": "project-review"}); self.assertEqual(status, 200); self.assertEqual(enabled["skill_context"]["enabled_count"], 1)
        self.assertEqual(self.runtime.agent_mode, before_mode); self.assertEqual(self.runtime.approvals.policies, before_policies)
        self.assertIn("command", enabled["skill_context"]["enabled"][0]["security"]["denied_categories"])

    def test_enabled_skill_is_compact_in_workspace_and_bounded_in_prepare(self) -> None:
        self.post({"action": "enable", "skill_id": "project-review"})
        skill = self.runtime.workspace_context({})["skill_context"]["enabled"][0]
        self.assertEqual(skill["trust_label"], "local_project_skill"); self.assertNotIn("instructions", skill)
        full = self.runtime.prepare_coding_context({"objective": "检查项目"})["skills"]["enabled"][0]
        self.assertIn("只读取必要文件", full["instructions"]); self.assertEqual(full["trust_label"], "local_project_skill")
        self.assertEqual(len(self.runtime._exposed_tool_names), 9)

    def test_manifest_change_removes_enabled_skill_from_context(self) -> None:
        self.post({"action": "enable", "skill_id": "project-review"})
        raw = json.loads(self.manifest_path.read_text(encoding="utf-8")); raw["instructions"] = "修改后的说明"
        self.manifest_path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        self.runtime._invalidate_fast_cache(); self.runtime._clear_context_bundle_cache()
        listing = self.post({"action": "list"})[1]; item = listing["items"][0]
        self.assertFalse(item["enabled"]); self.assertTrue(item["validation_stale"]); self.assertEqual(listing["skill_context"]["enabled_count"], 0)
        self.assertEqual(self.runtime.prepare_coding_context({"objective": "检查"})["skills"]["enabled"], [])


if __name__ == "__main__": unittest.main()
