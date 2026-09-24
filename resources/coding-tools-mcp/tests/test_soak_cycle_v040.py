from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


def run_hidden(*args, **kwargs):
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if flag and "creationflags" not in kwargs:
        kwargs["creationflags"] = flag
    return subprocess.run(*args, **kwargs)


class StableExecutionSoakCycleTests(unittest.TestCase):
    def _git(self, root: Path, *args: str) -> str:
        git = shutil.which("git")
        self.assertTrue(git)
        completed = run_hidden(
            [git, "-C", str(root), *args],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout

    def _init_repo(self, root: Path) -> None:
        self._git(root, "init")
        self._git(root, "config", "user.email", "soak@example.invalid")
        self._git(root, "config", "user.name", "Stable Execution Soak")
        self._git(root, "add", "app.txt", "pyproject.toml")
        self._git(root, "commit", "-m", "soak base")

    def test_full_stable_execution_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("value=0\n", encoding="utf-8")
            (root / "pyproject.toml").write_text(
                '[project]\nname = "stable-soak-fixture"\nversion = "0.0.0"\n',
                encoding="utf-8",
            )
            self._init_repo(root)
            index_before = self._git(root, "diff", "--cached", "--binary")

            runtime = Runtime(root, permission_mode="dangerous")
            try:
                context = runtime.workspace_context({"path": ".", "detail": "compact"})
                self.assertEqual(Path(context["workspace"]).resolve(), root.resolve())

                first_args = {
                    "workflow": "feature",
                    "phase": "execute",
                    "objective": "soak first deterministic patch",
                    "isolation": "off",
                    "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n-value=0\n+value=1\n*** End Patch",
                    "verification": "none",
                }
                first = runtime.agent_workflow(first_args)
                self.assertTrue(first["execution"]["ok"])
                self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "value=1\n")

                duplicate = runtime.agent_workflow(first_args)
                self.assertTrue(duplicate["execution"]["ok"])
                self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "value=1\n")

                sleep_command = subprocess.list2cmdline([
                    sys.executable,
                    "-c",
                    "import time; time.sleep(0.12); print('soak-background-ok')",
                ])
                background = runtime.exec_command({
                    "cmd": sleep_command,
                    "yield_time_ms": 1,
                    "timeout_ms": 5000,
                })
                session_id = str(background.get("session_id") or "")
                self.assertTrue(session_id)
                deadline = time.monotonic() + 5
                while background.get("status") == "running" and time.monotonic() < deadline:
                    background = runtime.command_control({
                        "action": "poll",
                        "session_id": session_id,
                        "wait_ms": 100,
                    })
                self.assertEqual(background.get("exit_code"), 0)
                self.assertEqual(background.get("execution", {}).get("lifecycle_state"), "completed")
            finally:
                runtime.close()

            runtime = Runtime(root, permission_mode="dangerous")
            try:
                test_command = subprocess.list2cmdline([
                    sys.executable,
                    "-c",
                    "from pathlib import Path; assert Path('app.txt').read_text(encoding='utf-8') == 'value=2\\n'",
                ])
                build_code = (
                    "from pathlib import Path; "
                    "Path('dist').mkdir(exist_ok=True); "
                    "Path('dist/artifact.txt').write_text('soak-ok', encoding='utf-8')"
                )
                build_command = subprocess.list2cmdline([sys.executable, "-c", build_code])
                second = runtime.agent_workflow({
                    "workflow": "build_release",
                    "phase": "execute",
                    "objective": "soak second patch and verify",
                    "isolation": "off",
                    "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n-value=1\n+value=2\n*** End Patch",
                    "verification": "all",
                    "test_command": test_command,
                    "build_command": build_command,
                    "artifact_paths": ["dist"],
                })
                self.assertTrue(second["execution"]["ok"])
                report = second["execution"].get("build_report") or {}
                self.assertEqual(report.get("overall_status"), "passed")
                self.assertEqual((root / "dist" / "artifact.txt").read_text(encoding="utf-8"), "soak-ok")
                state = runtime.task_state.get()
                self.assertEqual(state.get("lifecycle_state"), "completed")
                self.assertIsNone(state.get("current_command"))
            finally:
                runtime.close()

            self.assertEqual(self._git(root, "diff", "--cached", "--binary"), index_before)


if __name__ == "__main__":
    unittest.main()
