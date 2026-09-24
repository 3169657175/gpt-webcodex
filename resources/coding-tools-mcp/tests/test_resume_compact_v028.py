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
    return subprocess.run([GIT or "git", "-C", str(root), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding="utf-8", errors="replace", check=False, **kwargs)


def make_repo(parent: Path) -> Path:
    root = parent / "repo"
    root.mkdir()
    assert run_git(root, "init").returncode == 0
    assert run_git(root, "config", "user.email", "resume@example.invalid").returncode == 0
    assert run_git(root, "config", "user.name", "Resume Tests").returncode == 0
    (root / "package.json").write_text(json.dumps({"name": "resume-demo"}), encoding="utf-8")
    (root / "app.txt").write_text("base\n", encoding="utf-8")
    assert run_git(root, "add", ".").returncode == 0
    assert run_git(root, "commit", "-m", "base").returncode == 0
    return root


class DurableSessionRuntimeTests(unittest.TestCase):
    def test_execution_binds_checkpoints_to_durable_local_session_across_runtime_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text(json.dumps({"name": "session-demo"}), encoding="utf-8")
            first = Runtime(root, permission_mode="dangerous")
            try:
                result = first.agent_workflow({
                    "workflow": "diagnose", "phase": "run", "objective": "durable session",
                    "commands": ["echo ok"], "verification": "none", "isolation": "off",
                })
                self.assertTrue(result["execution"]["ok"])
                local_session_id = result["local_session"]["local_session_id"]
                self.assertTrue(local_session_id.startswith("ls_"))
                checkpoints = first.checkpoints.list(local_session_id=local_session_id, limit=10)
                self.assertGreaterEqual(len(checkpoints), 2)
                self.assertTrue(all(item["local_session_id"] == local_session_id for item in checkpoints))
            finally:
                first.close()
            second = Runtime(root, permission_mode="dangerous")
            try:
                self.assertEqual(second.local_sessions.current()["local_session_id"], local_session_id)
            finally:
                second.close()

    def test_compact_checkpoint_returns_bounded_continuation_brief(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                runtime.task_state.ensure_started("compact goal", current_step="working")
                runtime.task_state.update({
                    "steps": [{"id": "a", "text": "done", "status": "completed"}, {"id": "b", "text": "todo", "status": "pending"}],
                    "next_step": "do todo", "modified_files": [{"path": "app.py", "operation": "update"}],
                })
                compact = runtime._compact_current_session("test")
                self.assertTrue(compact["checkpoint_id"].startswith("cp_"))
                brief = compact["continuation_brief"]
                self.assertEqual(brief["pending"], ["todo"])
                self.assertEqual(brief["next_action"], "do todo")
                self.assertNotIn("diff", json.dumps(brief).lower())
            finally:
                runtime.close()


@unittest.skipUnless(GIT, "Git is required for resume conflict tests")
class SafeResumeTests(unittest.TestCase):
    def test_resume_returns_validated_continuation_and_keeps_same_local_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp))
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                run = runtime.agent_workflow({
                    "workflow": "feature", "phase": "run", "objective": "resume me", "path": ".",
                    "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n-base\n+base\n+agent\n*** End Patch",
                    "verification": "none",
                })
                local_session_id = run["local_session"]["local_session_id"]
                runtime._compact_current_session("manual")
                resumed = runtime.agent_workflow({"workflow": "resume", "phase": "resume", "objective": "resume me", "path": "."})
                self.assertTrue(resumed["resume_safe"])
                self.assertTrue(resumed["resume_validation"]["project_identity"]["ok"])
                self.assertEqual(resumed["continuation_brief"]["local_session_id"], local_session_id)
                self.assertEqual(resumed["local_session"]["local_session_id"], local_session_id)
            finally:
                runtime.close()

    def test_same_file_primary_change_blocks_resume_before_state_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp))
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                run = runtime.agent_workflow({
                    "workflow": "feature", "phase": "run", "objective": "conflict", "path": ".",
                    "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n-base\n+base\n+agent\n*** End Patch",
                    "verification": "none",
                })
                runtime._compact_current_session("manual")
                before = runtime.task_state.get()["lifecycle_state"]
                (root / "app.txt").write_text("base\nuser-change\n", encoding="utf-8")
                resumed = runtime.agent_workflow({"workflow": "resume", "phase": "resume", "objective": "conflict", "path": "."})
                self.assertFalse(resumed["resume_safe"])
                self.assertIn("app.txt", resumed["resume_validation"]["git"]["conflicting_paths"])
                self.assertEqual(runtime.task_state.get()["lifecycle_state"], before)
                self.assertNotEqual(run["isolation"]["mode"], "off")
            finally:
                runtime.close()

    def test_unknown_outcome_with_possible_side_effect_blocks_resume(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp))
            runtime = Runtime(root, permission_mode="dangerous")
            try:
                task = runtime.task_state.ensure_started("unknown", current_step="interrupted")
                runtime.local_sessions.ensure(task)
                runtime._write_checkpoint("task_start", task_state=task)
                runtime.task_state.upsert_operation({
                    "operation_id": "op-unknown", "run_id": task["run_id"], "status": "interrupted",
                    "lifecycle_state": "unknown_outcome", "side_effect_possible": True, "retry_safe": False,
                })
                runtime._compact_current_session("interrupted")
                resumed = runtime.agent_workflow({"workflow": "resume", "phase": "resume", "objective": "unknown", "path": "."})
                self.assertFalse(resumed["resume_safe"])
                self.assertFalse(resumed["resume_validation"]["execution"]["ok"])
                self.assertIn("unknown_outcome", resumed["resume_validation"]["execution"]["reason"])
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
