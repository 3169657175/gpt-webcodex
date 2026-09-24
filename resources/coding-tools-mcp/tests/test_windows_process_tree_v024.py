from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.processes import terminate_process_group


def pid_is_running(pid: int) -> bool:
    completed = subprocess.run(
        ["tasklist.exe", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return f'"{pid}"' in completed.stdout


@unittest.skipUnless(os.name == "nt", "Windows process-tree regression")
class WindowsProcessTreeTests(unittest.TestCase):
    def test_terminate_process_group_kills_spawned_child_tree(self) -> None:
        child_code = "import time; time.sleep(60)"
        parent_code = (
            "import subprocess,sys,time; "
            "p=subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "]); "
            "print(p.pid, flush=True); time.sleep(60)"
        )
        flags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        parent = subprocess.Popen(
            [sys.executable, "-c", parent_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=flags,
        )
        child_pid = 0
        try:
            assert parent.stdout is not None
            raw = parent.stdout.readline().decode("utf-8", errors="replace").strip()
            child_pid = int(raw)
            self.assertTrue(pid_is_running(parent.pid))
            self.assertTrue(pid_is_running(child_pid))

            terminate_process_group(parent, signal.SIGTERM)
            parent.wait(timeout=5)
            deadline = time.time() + 5
            while time.time() < deadline and pid_is_running(child_pid):
                time.sleep(0.1)

            self.assertFalse(pid_is_running(parent.pid))
            self.assertFalse(pid_is_running(child_pid), "child process survived session termination")
        finally:
            if parent.poll() is None:
                subprocess.run(
                    ["taskkill.exe", "/PID", str(parent.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            if child_pid and pid_is_running(child_pid):
                subprocess.run(
                    ["taskkill.exe", "/PID", str(child_pid), "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            if parent.stdout is not None:
                parent.stdout.close()
            if parent.stderr is not None:
                parent.stderr.close()


if __name__ == "__main__":
    unittest.main()
