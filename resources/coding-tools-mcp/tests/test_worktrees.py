from __future__ import annotations

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

from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.worktrees import WorktreeManager


GIT = shutil.which("git")


def run_hidden(*args, **kwargs):
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if flag and "creationflags" not in kwargs:
        kwargs["creationflags"] = flag
    return subprocess.run(*args, **kwargs)

def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run_hidden(
        [GIT or "git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


@unittest.skipUnless(GIT, "Git is required for worktree tests")
class WorktreeManagerTests(unittest.TestCase):
    def make_repo(self, parent: Path) -> Path:
        root = parent / "repo"
        root.mkdir()
        self.assertEqual(run_git(root, "init").returncode, 0)
        self.assertEqual(run_git(root, "config", "user.email", "tests@example.invalid").returncode, 0)
        self.assertEqual(run_git(root, "config", "user.name", "Coding Tools Tests").returncode, 0)
        self.assertEqual(run_git(root, "config", "core.autocrlf", "false").returncode, 0)
        (root / "app.txt").write_text("base\n", encoding="utf-8")
        self.assertEqual(run_git(root, "add", "app.txt").returncode, 0)
        committed = run_git(root, "commit", "-m", "base")
        self.assertEqual(committed.returncode, 0, committed.stderr)
        return root

    def test_create_diff_list_recover_and_discard(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp))
            manager = WorktreeManager(root)
            created = manager.create("run_1234", objective="isolated change")
            worktree = Path(created["path"])
            self.assertTrue(worktree.is_dir())
            self.assertEqual(created["run_id"], "run_1234")
            self.assertTrue(str(created["branch"]).startswith("coding-tools/run-"))
            self.assertTrue(created["clean"])

            (worktree / "app.txt").write_text("base\nchanged\n", encoding="utf-8")
            diff = manager.diff("run_1234")
            self.assertEqual(diff["changed_count"], 1)
            self.assertIn("+changed", diff["diff"])
            self.assertFalse(manager.get("run_1234")["clean"])
            self.assertEqual(len(manager.list()), 1)

            reopened = WorktreeManager(root)
            recovered = reopened.recover()
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0]["run_id"], "run_1234")

            discarded = reopened.discard("run_1234")
            self.assertTrue(discarded["discarded"])
            self.assertFalse(worktree.exists())
            self.assertEqual(reopened.list(), [])
            branch = run_git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{created['branch']}")
            self.assertNotEqual(branch.returncode, 0)

    def test_create_is_idempotent_for_same_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp))
            manager = WorktreeManager(root)
            first = manager.create("run_same")
            second = manager.create("run_same")
            self.assertEqual(first["path"], second["path"])
            self.assertEqual(first["branch"], second["branch"])
            manager.discard("run_same")

    def test_too_many_untracked_files_fail_before_creating_a_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp))
            (root / "generated-a.txt").write_text("a", encoding="utf-8")
            (root / "generated-b.txt").write_text("b", encoding="utf-8")
            manager = WorktreeManager(root)
            index_before = (root / ".git" / "index").read_bytes()
            with patch("coding_tools_mcp.worktrees.MAX_SNAPSHOT_FILES", 1):
                with self.assertRaises(ToolFailure) as raised:
                    manager.create("run_large")
            self.assertEqual(raised.exception.code, "SNAPSHOT_TOO_LARGE")
            self.assertEqual(raised.exception.details["untracked_count"], 2)
            self.assertFalse((root / ".coding-tools" / "worktrees" / "run_large").exists())
            self.assertEqual((root / ".git" / "index").read_bytes(), index_before)

    def test_dirty_primary_workspace_is_snapshotted_without_mutating_primary_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp))
            (root / "app.txt").write_text("base\nuser dirty\n", encoding="utf-8")
            (root / "new-user.txt").write_text("user untracked\n", encoding="utf-8")
            before = run_git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout

            manager = WorktreeManager(root)
            created = manager.create("run_dirty")
            worktree = Path(created["path"])
            after = run_git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout

            self.assertEqual(before, after)
            self.assertTrue(created["snapshot_dirty"])
            self.assertNotEqual(created["snapshot_commit"], created["base_commit"])
            self.assertEqual((worktree / "app.txt").read_text(encoding="utf-8"), "base\nuser dirty\n")
            self.assertEqual((worktree / "new-user.txt").read_text(encoding="utf-8"), "user untracked\n")
            initial = manager.diff("run_dirty")
            self.assertEqual(initial["changed_count"], 0)
            self.assertEqual(initial["diff"], "")

            (worktree / "app.txt").write_text("base\nuser dirty\nagent change\n", encoding="utf-8")
            (worktree / "agent-new.txt").write_text("agent new\n", encoding="utf-8")
            changed = manager.diff("run_dirty")
            self.assertEqual(changed["changed_count"], 2)
            self.assertIn("+agent change", changed["diff"])
            self.assertIn("agent-new.txt", changed["diff"])
            self.assertNotIn("+user dirty", changed["diff"])
            self.assertEqual(before, run_git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout)
            manager.discard("run_dirty")

    def test_non_git_workspace_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ToolFailure) as raised:
                WorktreeManager(root).create("run_plain")
            self.assertEqual(raised.exception.code, "NOT_GIT_REPOSITORY")

    def test_apply_back_applies_isolated_delta_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); manager = WorktreeManager(root); created = manager.create("run_apply"); worktree = Path(created["path"])
            (worktree / "app.txt").write_text("base\nagent\n", encoding="utf-8"); (worktree / "new.txt").write_text("new\n", encoding="utf-8")
            result = manager.apply_back("run_apply")
            self.assertTrue(result["applied"]); self.assertEqual(result["changed_count"], 2)
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nagent\n"); self.assertEqual((root / "new.txt").read_text(encoding="utf-8"), "new\n")
            second = manager.apply_back("run_apply"); self.assertEqual(second["changed_count"], 0); self.assertEqual(second["already_applied_count"], 2); self.assertTrue(worktree.exists()); manager.discard("run_apply")

    def test_diff_and_apply_back_support_deleted_tracked_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); manager = WorktreeManager(root); created = manager.create("run_delete"); worktree = Path(created["path"])
            (worktree / "app.txt").unlink()
            diff = manager.diff("run_delete")
            self.assertEqual(diff["changed_count"], 1)
            self.assertIn("deleted file mode", diff["diff"])
            result = manager.apply_back("run_delete")
            self.assertTrue(result["applied"]); self.assertEqual(result["changed_count"], 1); self.assertFalse((root / "app.txt").exists())
            second = manager.apply_back("run_delete")
            self.assertEqual(second["changed_count"], 0); self.assertEqual(second["already_applied_count"], 1)
            manager.discard("run_delete")

    def test_apply_back_same_path_user_change_conflicts_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); manager = WorktreeManager(root); worktree = Path(manager.create("run_conflict")["path"])
            (worktree / "app.txt").write_text("base\nagent\n", encoding="utf-8"); (root / "app.txt").write_text("base\nuser later\n", encoding="utf-8")
            with self.assertRaises(ToolFailure) as raised: manager.apply_back("run_conflict")
            self.assertEqual(raised.exception.code, "WORKTREE_APPLY_CONFLICT"); self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nuser later\n"); manager.discard("run_conflict")

    def test_apply_back_allows_unrelated_primary_change(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); manager = WorktreeManager(root); worktree = Path(manager.create("run_unrelated")["path"])
            (worktree / "app.txt").write_text("base\nagent\n", encoding="utf-8"); (root / "unrelated.txt").write_text("user unrelated\n", encoding="utf-8")
            result = manager.apply_back("run_unrelated")
            self.assertEqual(result["changed_count"], 1); self.assertEqual((root / "unrelated.txt").read_text(encoding="utf-8"), "user unrelated\n"); self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nagent\n"); manager.discard("run_unrelated")

    def test_apply_back_rejects_untracked_collision(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); manager = WorktreeManager(root); worktree = Path(manager.create("run_collision")["path"])
            (worktree / "same.txt").write_text("agent\n", encoding="utf-8"); (root / "same.txt").write_text("user\n", encoding="utf-8")
            with self.assertRaises(ToolFailure) as raised: manager.apply_back("run_collision")
            self.assertEqual(raised.exception.code, "WORKTREE_APPLY_CONFLICT"); self.assertEqual((root / "same.txt").read_text(encoding="utf-8"), "user\n"); manager.discard("run_collision")

    def test_apply_back_preserves_primary_index_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); (root / "app.txt").write_text("base\nuser staged\n", encoding="utf-8"); self.assertEqual(run_git(root, "add", "app.txt").returncode, 0)
            manager = WorktreeManager(root); worktree = Path(manager.create("run_index")["path"]); (worktree / "app.txt").write_text("base\nuser staged\nagent\n", encoding="utf-8")
            before = run_git(root, "ls-files", "--stage", "-z").stdout; result = manager.apply_back("run_index"); after = run_git(root, "ls-files", "--stage", "-z").stdout
            self.assertEqual(before, after); self.assertTrue(result["primary_index_untouched"]); self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nuser staged\nagent\n"); manager.discard("run_index")

    def test_apply_back_rolls_back_after_injected_partial_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); (root / "second.txt").write_text("second base\n", encoding="utf-8"); self.assertEqual(run_git(root, "add", "second.txt").returncode, 0); self.assertEqual(run_git(root, "commit", "-m", "second").returncode, 0)
            manager = WorktreeManager(root); worktree = Path(manager.create("run_rollback")["path"]); (worktree / "app.txt").write_text("base\nagent\n", encoding="utf-8"); (worktree / "second.txt").write_text("second base\nagent\n", encoding="utf-8")
            original_apply = manager._apply_change; calls = {"count": 0}
            def flaky(change, staging):
                calls["count"] += 1
                if calls["count"] == 2: raise OSError("injected write failure")
                return original_apply(change, staging)
            with patch.object(manager, "_apply_change", side_effect=flaky):
                with self.assertRaises(ToolFailure) as raised: manager.apply_back("run_rollback")
            self.assertEqual(raised.exception.code, "WORKTREE_APPLY_FAILED"); self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n"); self.assertEqual((root / "second.txt").read_text(encoding="utf-8"), "second base\n"); manager.discard("run_rollback")

    def test_apply_back_preserves_binary_and_crlf_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp)); (root / "binary.bin").write_bytes(b"\x00\x01base\xff"); (root / "crlf.txt").write_bytes(b"one\r\ntwo\r\n"); self.assertEqual(run_git(root, "add", "binary.bin", "crlf.txt").returncode, 0); self.assertEqual(run_git(root, "commit", "-m", "binary-crlf").returncode, 0)
            manager = WorktreeManager(root); worktree = Path(manager.create("run_bytes")["path"]); (worktree / "binary.bin").write_bytes(b"\x00\x02agent\xfe"); (worktree / "crlf.txt").write_bytes(b"one\r\ntwo\r\nagent\r\n")
            manager.apply_back("run_bytes"); self.assertEqual((root / "binary.bin").read_bytes(), b"\x00\x02agent\xfe"); self.assertEqual((root / "crlf.txt").read_bytes(), b"one\r\ntwo\r\nagent\r\n"); manager.discard("run_bytes")

    def test_cleanup_preserves_clean_committed_but_unapplied_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repo(Path(temp))
            manager = WorktreeManager(root)
            created = manager.create("run_committed")
            worktree = Path(created["path"])
            (worktree / "app.txt").write_text("base\ncommitted agent change\n", encoding="utf-8")
            self.assertEqual(run_git(worktree, "add", "app.txt").returncode, 0)
            committed = run_git(worktree, "commit", "-m", "agent change")
            self.assertEqual(committed.returncode, 0, committed.stderr)
            self.assertTrue(manager.get("run_committed")["clean"])

            metadata = manager._read_metadata()
            for item in metadata:
                if item.get("run_id") == "run_committed":
                    item["created_at"] = "2020-01-01T00:00:00.000Z"
            manager._write_metadata(metadata)

            cleanup = manager.cleanup(retention_days=1, keep=1)
            self.assertEqual(cleanup["removed_count"], 0)
            self.assertTrue(worktree.exists())
            manager.discard("run_committed")


if __name__ == "__main__":
    unittest.main()
