import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import coding_tools_mcp.server as server_module
from coding_tools_mcp.server import Runtime


class ExecHttpHandoffTests(unittest.TestCase):
    def test_exec_command_returns_before_the_http_safe_yield_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            command = subprocess.list2cmdline([
                sys.executable,
                "-c",
                "import time; time.sleep(5)",
            ])
            started = time.monotonic()
            with patch.object(server_module, "EXEC_HTTP_SAFE_YIELD_MAX_MS", 50):
                result = runtime.exec_command({
                    "cmd": command,
                    "yield_time_ms": 30000,
                    "timeout_ms": 10000,
                })
            elapsed = time.monotonic() - started
            try:
                self.assertEqual(result["status"], "running")
                self.assertTrue(result["session_id"])
                self.assertLess(elapsed, 1.0)
            finally:
                runtime.kill_session({
                    "session_id": result["session_id"],
                    "signal": "KILL",
                    "wait_ms": 2000,
                })
                runtime.close()

    def test_command_control_wait_ms_is_forwarded_when_yield_time_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            with patch.object(runtime, "write_stdin", return_value={"ok": True}) as write_stdin:
                result = runtime.command_control({
                    "action": "poll",
                    "session_id": "demo-session",
                    "wait_ms": 1234,
                })
            self.assertEqual(result, {"ok": True})
            self.assertEqual(write_stdin.call_args.args[0]["yield_time_ms"], 1234)
            runtime.close()


if __name__ == "__main__":
    unittest.main()
