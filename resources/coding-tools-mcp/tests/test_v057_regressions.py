from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.server import Runtime


class RuntimeV057RegressionTests(unittest.TestCase):
    def test_read_only_git_queries_do_not_request_git_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            read_only = [
                "git status --short",
                "git log -1 --oneline",
                "git tag --list v0.5.7",
                "git branch --list",
                "git worktree list --porcelain",
                'powershell -NoProfile -Command "git status; git tag --list v0.5.7; git worktree list --porcelain"',
            ]
            for command in read_only:
                risk = runtime._tool_risk_requirements("exec_command", {"cmd": command})
                self.assertNotIn("git_write", risk["categories"], command)
            for command in ["git add -A", "git commit -m release", "git tag v0.5.7", "git branch release-test", "git worktree add ../tmp HEAD"]:
                risk = runtime._tool_risk_requirements("exec_command", {"cmd": command})
                self.assertIn("git_write", risk["categories"], command)
            runtime.close()

    def test_completed_command_output_survives_old_five_minute_window(self) -> None:
        self.assertGreaterEqual(server_module.COMPLETED_SESSION_TTL_SECONDS, 24 * 60 * 60)
        self.assertGreaterEqual(server_module.MAX_RETAINED_OUTPUT_SESSIONS, 128)
        self.assertGreaterEqual(server_module.MAX_RUNTIME_OUTPUT_BYTES, 64 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            result = runtime.exec_command({"cmd": f'"{sys.executable}" -c "print(12345)"', "yield_time_ms": 10000, "verbosity": "full"})
            session_id = result["session_id"]
            session = runtime.output_sessions.get(session_id)
            self.assertIsNotNone(session)
            session.completed_at = time.time() - 600
            runtime._prune_sessions()
            self.assertIn(session_id, runtime.output_sessions)
            output = runtime.read_output({"output_ref": f"session:{session_id}:stdout", "limit": 65536})
            self.assertIn("12345", output["content"])
            runtime.close()


if __name__ == "__main__":
    unittest.main()
