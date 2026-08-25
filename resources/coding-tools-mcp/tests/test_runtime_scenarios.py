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

from coding_tools_mcp.build_verify import profile_project_execution
from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.server import Runtime
from coding_tools_mcp.task_state import TaskStateStore


class RuntimeScenarioTests(unittest.TestCase):
    def _git_repo(self, root: Path) -> None:
        git = shutil.which("git")
        self.assertTrue(git)
        for args in [
            ["init"], ["config", "user.email", "tests@example.invalid"], ["config", "user.name", "Runtime Tests"],
        ]:
            completed = subprocess.run([git, "-C", str(root), *args], capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
        subprocess.run([git, "-C", str(root), "add", "-A"], check=True)
        subprocess.run([git, "-C", str(root), "commit", "-m", "base"], check=True, capture_output=True)

    def test_execute_auto_isolation_keeps_dirty_primary_workspace_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("base\n", encoding="utf-8")
            self._git_repo(root)
            (root / "app.txt").write_text("base\nuser dirty\n", encoding="utf-8")
            git = shutil.which("git")
            before_status = subprocess.run([git, "-C", str(root), "status", "--porcelain=v1"], capture_output=True, text=True, check=True).stdout
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "feature", "phase": "execute", "objective": "isolated edit",
                "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n base\n user dirty\n+agent change\n*** End Patch",
                "commands": [f'"{sys.executable}" -c "from pathlib import Path; assert Path(\'app.txt\').read_text().endswith(\'agent change\\n\')"'],
                "verification": "none",
            })
            self.assertTrue(result["execution"]["ok"])
            self.assertEqual(result["isolation"]["mode"], "worktree")
            worktree = Path(result["isolation"]["worktree"]["path"])
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nuser dirty\n")
            self.assertEqual((worktree / "app.txt").read_text(encoding="utf-8"), "base\nuser dirty\nagent change\n")
            self.assertIn("+agent change", result["execution"]["git_diff"]["diff"])
            self.assertNotIn("+user dirty", result["execution"]["git_diff"]["diff"])
            after_status = subprocess.run([git, "-C", str(root), "status", "--porcelain=v1"], capture_output=True, text=True, check=True).stdout
            self.assertEqual(before_status, after_status)
            runtime.worktrees.discard(result["task"]["run_id"])
            runtime.close()

    def test_execute_isolation_off_edits_primary_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("base\n", encoding="utf-8")
            self._git_repo(root)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "feature", "phase": "execute", "objective": "direct edit", "isolation": "off",
                "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n base\n+direct\n*** End Patch", "verification": "none",
            })
            self.assertTrue(result["execution"]["ok"])
            self.assertEqual(result["isolation"]["mode"], "off")
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\ndirect\n")
            runtime.close()

    def test_failed_isolated_run_resumes_same_run_and_same_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("base\n", encoding="utf-8")
            self._git_repo(root)
            git = shutil.which("git")
            before_status = subprocess.run([git, "-C", str(root), "status", "--porcelain=v1"], capture_output=True, text=True, check=True).stdout
            runtime = Runtime(root, permission_mode="dangerous")
            first = runtime.agent_workflow({
                "workflow": "bugfix", "phase": "execute", "objective": "resume isolated edit",
                "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n base\n+first isolated change\n*** End Patch",
                "commands": [f'"{sys.executable}" -c "raise SystemExit(1)"'],
                "verification": "none",
            })
            self.assertFalse(first["execution"]["ok"])
            first_task = first["task"]
            self.assertEqual(first_task["status"], "failed")
            run_id = first_task["run_id"]
            worktree_path = first["isolation"]["worktree"]["path"]
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n")

            resumed = runtime.agent_workflow({"workflow": "resume", "phase": "resume"})
            self.assertEqual(resumed["task"]["status"], "active")
            self.assertEqual(resumed["task"]["run_id"], run_id)
            self.assertEqual(resumed["isolation"]["mode"], "worktree")
            self.assertEqual(resumed["isolation"]["worktree"]["path"], worktree_path)
            self.assertIn("+first isolated change", resumed["worktree_diff"]["diff"])

            second = runtime.agent_workflow({
                "workflow": "bugfix", "phase": "execute", "objective": "resume isolated edit",
                "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n base\n first isolated change\n+second isolated change\n*** End Patch",
                "verification": "none",
            })
            self.assertTrue(second["execution"]["ok"])
            self.assertEqual(second["task"]["run_id"], run_id)
            self.assertEqual(second["isolation"]["worktree"]["path"], worktree_path)
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n")
            self.assertEqual(
                Path(worktree_path).joinpath("app.txt").read_text(encoding="utf-8"),
                "base\nfirst isolated change\nsecond isolated change\n",
            )
            after_status = subprocess.run([git, "-C", str(root), "status", "--porcelain=v1"], capture_output=True, text=True, check=True).stdout
            self.assertEqual(before_status, after_status)
            runtime.worktrees.discard(run_id)
            runtime.close()

    def test_completed_isolated_run_can_apply_back_through_task_control(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("base\n", encoding="utf-8")
            self._git_repo(root)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "feature", "phase": "execute", "objective": "safe apply",
                "patch": "*** Begin Patch\n*** Update File: app.txt\n@@\n base\n+isolated result\n*** End Patch",
                "verification": "none",
            })
            self.assertTrue(result["execution"]["ok"])
            self.assertEqual(result["task"]["status"], "completed")
            run_id = result["task"]["run_id"]
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n")
            applied = runtime.task_control({"action": "worktree_apply", "run_id": run_id})
            self.assertTrue(applied["apply_result"]["applied"])
            self.assertEqual(applied["worktree"]["status"], "applied")
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\nisolated result\n")
            self.assertTrue(any(event.get("type") == "worktree.applied" for event in runtime.task_state.events_since(0, 1000)))
            runtime.worktrees.discard(run_id)
            runtime.close()

    def test_active_isolated_run_cannot_apply_back(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.txt").write_text("base\n", encoding="utf-8")
            self._git_repo(root)
            runtime = Runtime(root, permission_mode="dangerous")
            task = runtime.task_state.ensure_started("not finished")
            worktree = runtime.worktrees.create(task["run_id"], objective="not finished")
            Path(worktree["path"]).joinpath("app.txt").write_text("base\npartial\n", encoding="utf-8")
            with self.assertRaises(ToolFailure) as raised:
                runtime.task_control({"action": "worktree_apply", "run_id": task["run_id"]})
            self.assertEqual(raised.exception.code, "WORKTREE_NOT_READY")
            self.assertEqual((root / "app.txt").read_text(encoding="utf-8"), "base\n")
            runtime.worktrees.discard(task["run_id"])
            runtime.close()

    def test_prepare_builds_plan_without_creating_persistent_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text(json.dumps({
                "name": "demo",
                "scripts": {"test": "node --test", "build": "node build.js"},
            }), encoding="utf-8")
            (root / "src").mkdir()
            (root / "src" / "app.js").write_text("module.exports = 1;\n", encoding="utf-8")
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
                runtime = Runtime(root)
                result = runtime.agent_workflow({
                    "workflow": "feature",
                    "phase": "prepare",
                    "objective": "prepare only",
                    "paths": ["src/app.js"],
                })
                self.assertEqual(result["phase"], "prepare")
                self.assertIn("execution_plan", result)
                self.assertFalse(runtime.task_state.path.exists())
                runtime.close()

    def test_one_hundred_fast_completed_boundaries_are_all_durable_and_replayable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            for index in range(100):
                state = store.ensure_started(f"task-{index}")
                store.update({
                    "lifecycle_state": "completed",
                    "current_step": "Completed",
                    "next_step": "",
                }, event="continuous_workflow_completed")
                self.assertEqual(store.get()["run_id"], state["run_id"])
            events = store.events_since(0, limit=1000)
            completed = [event for event in events if event.get("type") == "task.completed"]
            self.assertEqual(len(completed), 100)
            ids = [int(event["event_id"]) for event in completed]
            self.assertEqual(ids, sorted(ids))
            self.assertEqual(len(ids), len(set(ids)))
            reopened = TaskStateStore(root)
            replay = reopened.events_since(ids[-11], limit=1000)
            self.assertEqual(sum(1 for event in replay if event.get("type") == "task.completed"), 10)

    def test_monorepo_profiler_and_planner_choose_changed_frontend_subproject(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "pyproject.toml").write_text("[project]\nname='backend'\nversion='1.0.0'\n", encoding="utf-8")
            frontend = root / "frontend"
            (frontend / "src").mkdir(parents=True)
            (frontend / "src" / "app.js").write_text("export const ok = true;\n", encoding="utf-8")
            (frontend / "package.json").write_text(json.dumps({
                "name": "frontend",
                "version": "1.0.0",
                "scripts": {"test": "vitest run", "build": "vite build"},
            }), encoding="utf-8")
            with patch("coding_tools_mcp.build_verify._tool_available", return_value=True), patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
                profile = profile_project_execution(root, ["frontend/src/app.js"])
                runtime = Runtime(root)
                plan = runtime._build_execution_plan({
                    "workflow": "feature",
                    "path": ".",
                    "paths": ["frontend/src/app.js"],
                })
                runtime.close()
            self.assertEqual(profile["project_root"], "frontend")
            self.assertEqual(profile["project"]["type"], "node")
            self.assertEqual(plan["project_root"], "frontend")
            self.assertEqual(plan["workdir"], "frontend")
            self.assertEqual(plan["test"]["status"], "verified")
            self.assertEqual(plan["test"]["framework"], "vitest")
            self.assertEqual(plan["build"]["status"], "verified")

    def test_python_profile_does_not_guess_pytest_when_module_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "pyproject.toml").write_text("[project]\nname='demo'\nversion='1.0.0'\n", encoding="utf-8")
            tests = root / "tests"
            tests.mkdir()
            (tests / "test_sample.py").write_text(
                "import unittest\nclass Demo(unittest.TestCase):\n    def test_ok(self): self.assertTrue(True)\n",
                encoding="utf-8",
            )
            with patch("coding_tools_mcp.build_verify.importlib.util.find_spec", return_value=None):
                profile = profile_project_execution(root)
            self.assertNotIn("pytest", profile["test"]["command"])
            self.assertEqual(profile["test"]["framework"], "unittest")
            self.assertEqual(profile["test"]["status"], "verified")


if __name__ == "__main__":
    unittest.main()
