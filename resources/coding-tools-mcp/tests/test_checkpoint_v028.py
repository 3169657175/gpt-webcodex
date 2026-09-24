from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.checkpoint_store import CheckpointStore
from coding_tools_mcp.project_identity import normalize_git_remote, resolve_project_identity


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


@unittest.skipUnless(GIT, "Git is required for project identity tests")
class ProjectIdentityTests(unittest.TestCase):
    def make_repo(self, parent: Path, name: str = "repo") -> Path:
        root = parent / name
        root.mkdir(parents=True)
        self.assertEqual(run_git(root, "init").returncode, 0)
        self.assertEqual(run_git(root, "config", "user.email", "checkpoint@example.invalid").returncode, 0)
        self.assertEqual(run_git(root, "config", "user.name", "Checkpoint Tests").returncode, 0)
        (root / "package.json").write_text(json.dumps({"name": "stable-project"}), encoding="utf-8")
        (root / "app.txt").write_text("base\n", encoding="utf-8")
        self.assertEqual(run_git(root, "add", ".").returncode, 0)
        committed = run_git(root, "commit", "-m", "base")
        self.assertEqual(committed.returncode, 0, committed.stderr)
        return root

    def test_https_and_ssh_remote_normalize_to_same_identity(self) -> None:
        https = normalize_git_remote("https://token@example.com/Owner/Repo.git/")
        ssh = normalize_git_remote("git@example.com:Owner/Repo.git")
        ssh_url = normalize_git_remote("ssh://git@example.com/Owner/Repo.git")
        self.assertEqual(https, "example.com/Owner/Repo")
        self.assertEqual(https, ssh)
        self.assertEqual(https, ssh_url)
        self.assertNotIn("token", https)

    def test_remote_project_id_survives_workspace_move(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            root = self.make_repo(parent, "first")
            self.assertEqual(run_git(root, "remote", "add", "origin", "git@example.com:Owner/Repo.git").returncode, 0)
            first = resolve_project_identity(root)
            moved_parent = parent / "moved"
            moved_parent.mkdir()
            moved = moved_parent / root.name
            root.rename(moved)
            second = resolve_project_identity(moved)
            self.assertEqual(first["source"], "git_remote")
            self.assertEqual(first["project_id"], second["project_id"])

    def test_root_commit_project_id_survives_workspace_move_without_remote(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            root = self.make_repo(parent, "repo")
            first = resolve_project_identity(root)
            moved_parent = parent / "elsewhere"
            moved_parent.mkdir()
            moved = moved_parent / "repo"
            root.rename(moved)
            second = resolve_project_identity(moved)
            self.assertEqual(first["source"], "git_root")
            self.assertEqual(first["project_id"], second["project_id"])


class ProjectIdentityFallbackTests(unittest.TestCase):
    def test_non_git_project_uses_name_and_folder_without_full_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            root = parent / "project-folder"
            root.mkdir()
            (root / "package.json").write_text(json.dumps({"name": "fallback-project"}), encoding="utf-8")
            first = resolve_project_identity(root, git_path="__missing_git__")
            target_parent = parent / "moved"
            target_parent.mkdir()
            moved = target_parent / "project-folder"
            root.rename(moved)
            second = resolve_project_identity(moved, git_path="__missing_git__")
            self.assertEqual(first["source"], "project_name")
            self.assertEqual(first["project_id"], second["project_id"])
            self.assertNotIn(str(parent), first["evidence"])


class CheckpointStoreTests(unittest.TestCase):
    def identity(self, value: str = "project_same") -> dict[str, str | int]:
        return {"version": 1, "project_id": value, "source": "test", "name": "demo", "evidence": "test"}

    def test_checkpoint_persists_lists_filters_and_bounds_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = CheckpointStore(root, project_identity=self.identity())
            task = {
                "task_id": "task-a", "run_id": "run-a", "objective": "goal", "current_step": "step",
                "next_step": "next", "modified_files": [{"path": "a.py", "operation": "modify"}],
                "last_command": {"execution_id": "exec-a"},
            }
            created = store.create(
                "test_complete",
                task_state=task,
                git={"branch": "main", "base": "abc", "status": "dirty"},
                worktree={"run_id": "run-a", "branch": "coding-tools/run-a"},
                test_summary={"status": "passed", "summary": "x" * 10000},
            )
            self.assertTrue(created["checkpoint_id"].startswith("cp_"))
            self.assertEqual(created["execution_id"], "exec-a")
            self.assertLessEqual(len(created["test_summary"]["summary"]), 2000)

            reopened = CheckpointStore(root, project_identity=self.identity())
            loaded = reopened.get(created["checkpoint_id"])
            self.assertEqual(loaded["task_id"], "task-a")
            self.assertEqual(reopened.list(task_id="task-a")[0]["checkpoint_id"], created["checkpoint_id"])
            self.assertEqual(reopened.list(run_id="run-a")[0]["checkpoint_id"], created["checkpoint_id"])
            self.assertEqual(reopened.list(checkpoint_type="test_complete")[0]["checkpoint_id"], created["checkpoint_id"])
            self.assertEqual(reopened.list(checkpoint_type="build_complete"), [])
            self.assertTrue(reopened.validate(created["checkpoint_id"], current_project_identity=self.identity())["ok"])

    def test_corrupt_checkpoint_is_isolated_from_list_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = CheckpointStore(root, project_identity=self.identity())
            created = store.create("manual", task_state={"task_id": "task", "run_id": "run"})
            path = root / ".coding-tools" / "checkpoints" / f"{created['checkpoint_id']}.json"
            path.write_text("{broken", encoding="utf-8")
            self.assertEqual(store.list(), [])
            validation = store.validate(created["checkpoint_id"])
            self.assertFalse(validation["ok"])
            self.assertIn("checkpoint_missing_or_corrupt", validation["errors"])

    def test_project_mismatch_blocks_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = CheckpointStore(root, project_identity=self.identity("project_a"))
            created = store.create("task_start", task_state={"task_id": "task", "run_id": "run"})
            validation = store.validate(created["checkpoint_id"], current_project_identity=self.identity("project_b"))
            self.assertFalse(validation["ok"])
            self.assertIn("project_identity_mismatch", validation["errors"])

    def test_digest_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = CheckpointStore(root, project_identity=self.identity())
            created = store.create("manual", task_state={"task_id": "task", "run_id": "run"})
            path = root / ".coding-tools" / "checkpoints" / f"{created['checkpoint_id']}.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["current_step"] = "tampered"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            validation = store.validate(created["checkpoint_id"])
            self.assertFalse(validation["ok"])
            self.assertIn("checkpoint_digest_mismatch", validation["errors"])
            self.assertEqual(store.list(), [])


if __name__ == "__main__":
    unittest.main()
