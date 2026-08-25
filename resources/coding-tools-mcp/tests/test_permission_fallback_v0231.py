from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime
from coding_tools_mcp.tool_results import render_tool_text


class PermissionFallbackTests(unittest.TestCase):
    def test_unsupported_elicitation_returns_chinese_desktop_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="safe")
            result = runtime.request_permissions({
                "tool_name": "exec_command",
                "permission": "network",
                "scope": "once",
            })
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "unsupported")
            self.assertEqual(result["error"]["code"], "ELICITATION_UNSUPPORTED")
            self.assertIn("工作区与权限", result["error"]["message"])
            self.assertEqual(result["desktop_fallback"]["page"], "workspace")
            self.assertEqual(result["error"]["details"]["requested"]["permission"], "network")
            text = render_tool_text("request_permissions", result, is_error=False)
            self.assertIn("工作区与权限", text)
            runtime.close()


if __name__ == "__main__":
    unittest.main()
