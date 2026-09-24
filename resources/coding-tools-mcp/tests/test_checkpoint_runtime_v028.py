from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


GIT = shutil.which("git")


def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    kwargs = {}
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if flag:
        kwargs["creationflags"] = flag
    return subprocess.run(
        [GIT or "git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        **kwargs,
    )


def make_repo(parent: Path) -> Path:
    root = parent / "repo"
    root.mkdir()
    assert run_git(root, "init").returncode == 0
    assert run_git(root, "config", "user.email", "checkpoint-runtime@example.invalid").returncode == 0
    assert run_git(root, "config", "user.name", "Checkpoint Runtime Tests").returncode == 0
    (root / "package.json").write_text(json.dumps({"name": "checkpoint-runtime"}), encoding="utf-8")
    (root / "app.txt").write_text("base\n", encoding="utf-8")
    assert run_git(root, "add", ".").returncode == 0
    committed = run_git(root, "commit", "-m", "base")
    assert committed.returncode == 0, committed.stderr
    return root


class PrepareCheckpointTests(unittest.TestCase):
    def test_prepare_remains_read_only_and_creates_no_task_or_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text(json.dumps({"name": "prepare-demo"}), encoding="utf-8")
            runtime = Runtime(root)
            try:
                result = runtime.agent_workflow({"workflow": "feature", "phase": "prepare", "objective": "prepare checkpoint", "path": "."})
                self.assertEqual(result["phase"], "prepare")
                self.assertFalse((root / ".coding-tools" / "task-state.json").exists())
                self.assertEqual(runtime.checkpoints.list(limit=10), [])
            finally:
                runtime.close()

    def test_checkpoint_write_failure_does_not_fail_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                with patch.object(runtime.checkpoints, "create", side_effect=OSError("disk unavailable")):
                    result = runtime.agent_workflow({
                        "workflow": "feature",
                        "phase": "run",
                        "objective": "failure isolation",
                        "path": ".",
                        "files": [{"path": "created.txt", "content": "ok\n"}],
                        "verification": "none",
                        "isolation": "off",
                    })
                self.assertTrue(result["execution"]["ok"])
                self.assertEqual((root / "created.txt").read_text(encoding="utf-8"), "ok\n")
            finally:
                runtime.close()


@unittest.skipUnless(GIT, "Git is required for isolated checkpoint tests")
class AutomaticCheckpointTests(unittest.TestCase):
    def test_run_creates_change_checkpoint_without_touching_primary_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp))
            before_index = run_git(root, "diff", "--cached", "--binary").stdout
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                result = runtime.agent_workflow({
                    "workflow": "feature",
                    "phase": "run",
                    "objective": "change checkpoint",
                    "path": ".",
                    "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n-base\n+base\n+changed\n*** End Patch",
                    "verification": "none",
                })
                self.assertTrue(result["execution"]["ok"])
                run_id = result["task"]["run_id"]
                items = runtime.checkpoints.list(run_id=run_id, limit=10)
                types = [item["type"] for item in reversed(items)]
                self.assertEqual(types, ["task_start", "plan_complete", "changes_complete"])
                change = next(item for item in items if item["type"] == "changes_complete")
                self.assertEqual(change["modified_files"][0]["path"], "app.txt")
                self.assertTrue(change["worktree"].get("snapshot_commit"))
                self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n")
                self.assertEqual(run_git(root, "diff", "--cached", "--binary").stdout, before_index)
            finally:
                runtime.close()

    def test_verify_build_report_creates_test_and_build_checkpoints(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                runtime.task_state.ensure_started("verification checkpoint", current_step="verify")
                fake_report = {
                    "ok": True,
                    "overall_status": "passed",
                    "test_result": {"status": "passed", "command": "demo-test", "exit_code": 0, "summary": "tests ok"},
                    "build_result": {"status": "passed", "command": "demo-build", "exit_code": 0, "summary": "build ok"},
                }
                with patch.object(runtime, "verify_build", return_value=fake_report):
                    result = runtime.apply_changes_and_verify({"objective": "verification checkpoint", "verification": "all", "path": "."})
                self.assertTrue(result["ok"])
                run_id = runtime.task_state.get()["run_id"]
                types = [item["type"] for item in reversed(runtime.checkpoints.list(run_id=run_id, limit=10))]
                self.assertIn("test_complete", types)
                self.assertIn("build_complete", types)
                test_checkpoint = next(item for item in runtime.checkpoints.list(run_id=run_id, limit=10) if item["type"] == "test_complete")
                build_checkpoint = next(item for item in runtime.checkpoints.list(run_id=run_id, limit=10) if item["type"] == "build_complete")
                self.assertEqual(test_checkpoint["test_summary"]["status"], "passed")
                self.assertEqual(build_checkpoint["build_summary"]["status"], "passed")
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
