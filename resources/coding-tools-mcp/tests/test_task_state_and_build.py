from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.build_verify import collect_artifacts, detect_project, infer_project_root, profile_project_execution, verify_build as verify_build_profile
from coding_tools_mcp.task_state import TaskStateStore, classify_command
from coding_tools_mcp.server import Runtime, classify_context_pressure
from coding_tools_mcp.protocol import dispatch_rpc
from coding_tools_mcp.document_tools import create_docx, extract_docx
from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.patching import apply_update_hunks, parse_patch
from coding_tools_mcp.performance_trace import PerformanceTraceStore, TRACE_VERSION


class TaskStateTests(unittest.TestCase):
    def test_operation_records_persist_and_orphaned_running_operation_is_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.upsert_operation({
                "operation_id": "op1", "run_id": "run1", "tool": "agent_workflow",
                "runtime_instance_id": "old", "status": "running", "heartbeat_at": "now",
            })
            recovered = store.recover_orphaned_operations("new")
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0]["status"], "interrupted")
            self.assertEqual(store.operation_records()[-1]["status"], "interrupted")

    def test_new_task_has_run_id_and_typed_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            state = store.ensure_started("typed lifecycle")
            self.assertTrue(state["task_id"])
            self.assertTrue(state["run_id"])
            self.assertEqual(state["status"], "active")
            self.assertEqual(state["lifecycle_state"], "running")

    def test_terminal_lifecycle_finalizes_and_clears_current_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("terminal command cleanup")
            store.record_command_started("python -c pass", "session-terminal", ".")
            state = store.update({"status": "completed", "current_step": "Completed"})
            self.assertEqual(state["lifecycle_state"], "completed")
            self.assertIsNone(state["current_command"])
            self.assertEqual(state["last_command"]["session_id"], "session-terminal")
            self.assertEqual(state["last_command"]["status"], "completed")

    def test_terminal_task_is_not_revived_by_later_plain_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("already finished")
            store.update({"status": "completed", "current_step": "Completed"})
            before_event_id = store.latest_event_id()
            store.record_command_started("git status", "late-session", ".")
            store.record_tool_result("exec_command", {"cmd": "git status"}, {"ok": True, "status": "exited", "session_id": "late-session", "exit_code": 0, "elapsed_ms": 5})
            state = store.get()
            self.assertEqual(state["lifecycle_state"], "completed")
            self.assertEqual(state["status"], "completed")
            self.assertIsNone(state["current_command"])
            self.assertEqual(store.latest_event_id(), before_event_id)

    def test_durable_command_events_keep_explicit_boundary_and_result_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.ensure_started("command event fidelity")
            store.record_command_started("echo hello", "session-command", temp)
            store.record_tool_result(
                "exec_command",
                {"cmd": "echo hello", "role": "blocking", "blocking": True},
                {
                    "ok": True,
                    "status": "exited",
                    "session_id": "session-command",
                    "exit_code": 0,
                    "elapsed_ms": 321,
                    "summary": "exit 0 | hello",
                    "stdout": "hello\n",
                    "stderr": "",
                },
            )
            events = store.events_since(0, limit=100)
            started = next(item for item in events if item["type"] == "command.started")
            completed = next(item for item in events if item["type"] == "command.completed")
            self.assertEqual(started["payload"]["details"]["session_id"], "session-command")
            self.assertEqual(started["payload"]["details"]["kind"], "command")
            self.assertEqual(started["payload"]["details"]["workdir"], temp)
            details = completed["payload"]["details"]
            self.assertEqual(details["command"], "echo hello")
            self.assertEqual(details["session_id"], "session-command")
            self.assertEqual(details["status"], "passed")
            self.assertEqual(details["exit_code"], 0)
            self.assertEqual(details["elapsed_ms"], 321)
            self.assertEqual(details["summary"], "exit 0 | hello")
            self.assertTrue(details["started_at"])
            self.assertTrue(details["finished_at"])
            self.assertEqual(completed["state"]["lifecycle_state"], "waiting_model")
            self.assertIsNone(completed["state"]["current_command"])
            self.assertEqual(completed["state"]["last_command"]["exit_code"], 0)
            self.assertEqual(completed["state"]["last_command"]["elapsed_ms"], 321)

    def test_waiting_model_task_is_superseded_immediately_by_different_objective(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            first = store.ensure_started("first")
            store.update({"lifecycle_state": "waiting_model", "wait_reason": "model"})
            second = store.ensure_started("second")
            self.assertNotEqual(first["task_id"], second["task_id"])
            self.assertNotEqual(first["run_id"], second["run_id"])

    def test_anonymous_tool_calls_do_not_create_a_task_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            store.record_tool_result(
                "apply_patch",
                {"patch": "..."},
                {"ok": False, "error": {"message": "Cannot add file that already exists."}},
            )
            self.assertFalse(store.path.exists())

    def test_state_survives_new_store_and_tracks_results(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            store.update({"objective": "Ship release", "steps": ["test", "build"], "next_step": "test"})
            store.record_command_started("npm test", "session-one", ".")
            store.record_tool_result(
                "exec_command",
                {"cmd": "npm test"},
                {"ok": True, "status": "exited", "session_id": "session-one", "exit_code": 0, "elapsed_ms": 25},
            )
            store.record_tool_result(
                "apply_patch",
                {"patch": "..."},
                {"ok": True, "affected_files": [{"path": "src/app.js", "operation": "update"}]},
            )
            restored = TaskStateStore(root).get()
            self.assertEqual(restored["objective"], "Ship release")
            self.assertEqual(restored["test_results"][-1]["status"], "passed")
            self.assertEqual(restored["modified_files"], [{"path": "src/app.js", "operation": "update", "updated_at": restored["modified_files"][0]["updated_at"]}])

    def test_command_classification(self) -> None:
        self.assertEqual(classify_command("python -m pytest -q"), "test")
        self.assertEqual(classify_command("npm run build"), "build")
        self.assertEqual(classify_command("git status"), "command")

    def test_context_pressure_uses_payload_volume_instead_of_call_count_alone(self) -> None:
        self.assertEqual(classify_context_pressure(100, 600_000, 4), "normal")
        self.assertEqual(classify_context_pressure(20, 4 * 1024 * 1024, 2), "elevated")
        self.assertEqual(classify_context_pressure(20, 8 * 1024 * 1024, 2), "high")
        self.assertEqual(classify_context_pressure(85, 2 * 1024 * 1024, 4), "elevated")
        self.assertEqual(classify_context_pressure(130, 4 * 1024 * 1024, 4), "high")

    def test_performance_trace_counts_only_context_visible_calls(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = PerformanceTraceStore(Path(temp))
            base = time.monotonic()
            store.record(
                tool="workspace_context", started_monotonic=base, finished_monotonic=base + 0.01,
                response_bytes=1200, files_read=2, origin="external",
            )
            store.record(
                tool="task_control", started_monotonic=base + 0.02, finished_monotonic=base + 0.03,
                response_bytes=9000, files_read=7, origin="desktop",
            )
            store.record(
                tool="workspace_preheat", started_monotonic=base + 0.04, finished_monotonic=base + 0.05,
                response_bytes=5000, files_read=4, origin="system",
            )
            state = store.get()
            self.assertEqual(state["version"], TRACE_VERSION)
            self.assertEqual(state["tool_calls"], 1)
            self.assertEqual(state["response_bytes"], 1200)
            self.assertEqual(state["files_read"], 2)
            self.assertEqual(state["observed_events"], 3)
            self.assertEqual(state["internal_events"], 2)
            self.assertEqual(state["desktop_calls"], 1)
            self.assertEqual(state["system_events"], 1)
            self.assertEqual([event["origin"] for event in state["recent"]], ["external", "desktop", "system"])

    def test_performance_trace_new_runtime_resets_legacy_and_previous_session_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state_dir = root / ".coding-tools"
            state_dir.mkdir(parents=True)
            (state_dir / "performance.json").write_text(json.dumps({
                "version": 1, "tool_calls": 100, "response_bytes": 999999, "files_read": 77,
                "current_session_id": "legacy", "recent": [{"session_id": "legacy", "tool": "task_control"}] * 100,
            }), encoding="utf-8")
            store = PerformanceTraceStore(root)
            state = store.get()
            self.assertEqual(state["version"], TRACE_VERSION)
            self.assertEqual(state["tool_calls"], 0)
            self.assertEqual(state["response_bytes"], 0)
            self.assertEqual(state["files_read"], 0)
            self.assertEqual(state["recent"], [])
            self.assertNotEqual(state["current_session_id"], "legacy")
            self.assertEqual(state["previous_session"]["tool_calls"], 100)

            base = time.monotonic()
            store.record(tool="workspace_context", started_monotonic=base, finished_monotonic=base + 0.01)
            first_session = store.get()["current_session_id"]
            restarted = PerformanceTraceStore(root)
            restarted_state = restarted.get()
            self.assertNotEqual(restarted_state["current_session_id"], first_session)
            self.assertEqual(restarted_state["tool_calls"], 0)
            self.assertEqual(restarted_state["previous_session"]["tool_calls"], 1)

    def test_task_id_pause_resume_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            first = store.update({"objective": "First task", "next_step": "edit"})
            self.assertTrue(first["task_id"])
            paused = store.pause("user requested")
            self.assertEqual(paused["status"], "paused")
            self.assertEqual(paused["pause_reason"], "user requested")
            resumed = store.resume("test")
            self.assertEqual(resumed["status"], "active")
            self.assertEqual(resumed["next_step"], "test")
            second = store.update({"objective": "Second task", "new_task": True})
            self.assertNotEqual(first["task_id"], second["task_id"])
            history = store.history()
            self.assertEqual(history[0]["task_id"], first["task_id"])
            self.assertEqual(history[0]["archive_reason"], "superseded")

    def test_clear_archives_current_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            state = store.update({"objective": "Archive me"})
            store.clear()
            self.assertFalse(store.path.exists())
            self.assertEqual(store.history()[0]["task_id"], state["task_id"])

    def test_task_event_revision_advances_on_write_and_clear(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            revision, initial = store.event_snapshot()
            self.assertEqual(revision, 0)
            self.assertEqual(initial["status"], "idle")
            self.assertIsNone(store.wait_for_revision(revision, timeout=0.01))

            store.update({"objective": "Push state", "status": "active"})
            changed = store.wait_for_revision(revision, timeout=0.1)
            self.assertIsNotNone(changed)
            next_revision, active = changed
            self.assertGreater(next_revision, revision)
            self.assertEqual(active["status"], "active")

            store.clear()
            cleared = store.wait_for_revision(next_revision, timeout=0.1)
            self.assertIsNotNone(cleared)
            cleared_revision, idle = cleared
            self.assertGreater(cleared_revision, next_revision)
            self.assertEqual(idle["status"], "idle")

    def test_durable_events_preserve_rapid_terminal_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            first = store.ensure_started("first")
            store.update({"lifecycle_state": "completed", "current_step": "done"}, event="continuous_workflow_completed")
            second = store.ensure_started("second")
            events = store.events_since(0, 20)
            event_types = [item["type"] for item in events]
            self.assertIn("task.completed", event_types)
            completed_index = event_types.index("task.completed")
            self.assertGreater(len(events), completed_index + 1)
            self.assertEqual(events[completed_index]["run_id"], first["run_id"])
            self.assertEqual(events[-1]["run_id"], second["run_id"])
            ids = [item["event_id"] for item in events]
            self.assertEqual(ids, sorted(set(ids)))

    def test_durable_event_ids_survive_store_restart_and_replay(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first_store = TaskStateStore(root)
            first_store.ensure_started("persist event ids")
            first_id = first_store.latest_event_id()
            second_store = TaskStateStore(root)
            self.assertEqual(second_store.latest_event_id(), first_id)
            second_store.update({"lifecycle_state": "completed"}, event="continuous_workflow_completed")
            replay = second_store.wait_for_events(first_id, timeout=0.01)
            self.assertEqual(len(replay), 1)
            self.assertGreater(replay[0]["event_id"], first_id)
            self.assertEqual(replay[0]["type"], "task.completed")

    def test_direct_exec_command_does_not_create_persistent_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.exec_command({"cmd": "echo ok", "yield_time_ms": 1000})
            self.assertEqual(result.get("exit_code"), 0)
            self.assertFalse((root / ".coding-tools" / "task-state.json").exists())
            runtime.close()

    def test_agent_workflow_prepare_does_not_create_persistent_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            runtime.call_tool("agent_workflow", {
                "workflow": "diagnose",
                "phase": "prepare",
                "objective": "inspect only",
            })
            self.assertFalse((root / ".coding-tools" / "task-state.json").exists())
            runtime.close()

    def test_high_level_workflow_still_creates_task(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.apply_changes_and_verify({
                "objective": "high level task",
                "checks": ["echo ok"],
                "verification": "none",
            })
            self.assertTrue(result["ok"])
            self.assertTrue((root / ".coding-tools" / "task-state.json").exists())
            runtime.close()

    def test_stale_waiting_task_with_different_objective_is_archived(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            first = store.update({"objective": "old objective", "status": "waiting"})
            raw = json.loads(store.path.read_text(encoding="utf-8"))
            raw["updated_at"] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
            store.path.write_text(json.dumps(raw), encoding="utf-8")
            second = store.ensure_started("new objective")
            self.assertNotEqual(first["task_id"], second["task_id"])
            self.assertEqual(second["objective"], "new objective")
            self.assertEqual(store.history()[0]["archive_reason"], "stale-superseded")

    def test_fresh_waiting_task_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            first = store.update({
                "objective": "current objective",
                "lifecycle_state": "needs_user",
                "wait_reason": "approval",
            })
            second = store.ensure_started("different incoming objective")
            self.assertEqual(first["task_id"], second["task_id"])


class BackgroundOperationTests(unittest.TestCase):
    def test_long_agent_workflow_hands_back_and_can_be_polled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def slow_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.05)
                return {"done": True}

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                runtime, "_call_tool_sync", side_effect=slow_result
            ):
                first = runtime.call_tool("agent_workflow", {"phase": "run"})
                structured = first["structuredContent"]
                self.assertEqual(structured["status"], "running")
                self.assertTrue(structured["requires_progress_report"])
                operation_id = structured["background_operation"]["operation_id"]
                self.assertTrue(structured["background_operation"]["task_id"])
                self.assertTrue(structured["background_operation"]["run_id"])
                self.assertTrue(structured["background_operation"]["heartbeat_at"])
                polled = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})
                self.assertEqual(polled["background_operation"]["status"], "completed")
                self.assertEqual(polled["background_operation"]["result"], {"done": True})
                self.assertEqual(runtime.task_state.operation_records()[-1]["status"], "completed")
            runtime.close()

    def test_duplicate_background_workflow_reuses_same_operation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            runtime.task_state.ensure_started("dedupe")

            def slow_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.08)
                return {"done": True}

            with patch.object(runtime, "_call_tool_sync", side_effect=slow_result):
                arguments = {"objective": "dedupe", "phase": "run", "workflow": "feature"}
                first, _ = runtime._start_background_tool("agent_workflow", arguments, request_id=1)
                second, _ = runtime._start_background_tool("agent_workflow", arguments, request_id=2)
                self.assertEqual(first["operation_id"], second["operation_id"])
                first["event"].wait(1)
            runtime.close()

    def test_runtime_start_marks_previous_running_operation_and_task_as_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = TaskStateStore(root)
            task = store.ensure_started("recover me")
            store.upsert_operation({
                "operation_id": "old-op", "operation_key": "old-key", "tool": "agent_workflow",
                "task_id": task["task_id"], "run_id": task["run_id"], "runtime_instance_id": "dead-runtime",
                "status": "running", "started_at": "2026-08-12T00:00:00Z", "heartbeat_at": "2026-08-12T00:00:05Z",
            })
            runtime = Runtime(root)
            recovered = runtime.task_state.get()
            self.assertEqual(recovered["lifecycle_state"], "failed")
            self.assertIn("后台任务已中断", recovered["current_step"])
            self.assertEqual(runtime.task_state.operation_records()[-1]["status"], "interrupted")
            runtime.close()


class PermissionPolicyTests(unittest.TestCase):
    def test_safe_and_trusted_modes_expose_capability_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            safe = Runtime(root, permission_mode="safe")
            trusted = Runtime(root, permission_mode="trusted")
            safe_policy = safe.permission_policy_payload()
            trusted_policy = trusted.permission_policy_payload()
            self.assertEqual(safe_policy["capabilities"]["filesystem.delete"], "ask")
            self.assertEqual(safe_policy["capabilities"]["network.access"], "ask")
            self.assertEqual(trusted_policy["capabilities"]["filesystem.delete"], "allow")
            self.assertEqual(trusted_policy["capabilities"]["network.access"], "allow")
            self.assertEqual(trusted_policy["capabilities"]["system.modify"], "ask")
            safe.close()
            trusted.close()

    def test_trusted_allows_workspace_destructive_command_but_blocks_system_modify(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="trusted")
            runtime._check_command_policy("rm -rf build", {})
            with self.assertRaises(ToolFailure) as raised:
                runtime._check_command_policy("reg add HKCU\\Software\\Demo /v X /d 1", {})
            self.assertEqual(raised.exception.details.get("capability"), "system.modify")
            runtime.close()


class BuildVerificationTests(unittest.TestCase):
    def test_detects_node_project_and_hashes_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text(
                json.dumps({"name": "demo", "version": "1.2.0", "scripts": {"test": "node --test", "build": "node build.js"}}),
                encoding="utf-8",
            )
            project = detect_project(root)
            self.assertEqual(project["type"], "node")
            self.assertEqual(project["version"], "1.2.0")
            artifact = root / "dist" / "demo.exe"
            artifact.parent.mkdir()
            artifact.write_bytes(b"artifact")
            artifacts = collect_artifacts(root, ["dist"], "sha256", 0)
            self.assertEqual(artifacts[0]["path"], "dist/demo.exe")
            self.assertEqual(len(artifacts[0]["sha256"]), 64)

    def test_infers_npm_prefix_subproject(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            child = root / "canvas-web"
            child.mkdir()
            (child / "package.json").write_text(json.dumps({"name": "canvas-web", "scripts": {"build": "vite build"}}), encoding="utf-8")
            self.assertEqual(infer_project_root(root, "npm --prefix canvas-web run build"), child.resolve())

    def test_execution_profile_selects_targeted_node_subproject(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("coding_tools_mcp.build_verify._tool_available", return_value=True):
            root = Path(temp)
            (root / "pyproject.toml").write_text('[project]\nname="backend"\nversion="1.0"\n', encoding="utf-8")
            child = root / "canvas-web"
            (child / "src").mkdir(parents=True)
            (child / "src" / "app.js").write_text("export default 1\n", encoding="utf-8")
            (child / "package.json").write_text(json.dumps({
                "name": "canvas-web",
                "scripts": {"test": "vitest run", "build": "vite build"},
            }), encoding="utf-8")
            profile = profile_project_execution(root, ["canvas-web/src/app.js"])
            self.assertEqual(profile["project_root"], "canvas-web")
            self.assertEqual(profile["project"]["type"], "node")
            self.assertEqual(profile["test"]["status"], "verified")
            self.assertEqual(profile["test"]["framework"], "vitest")
            self.assertEqual(profile["test"]["command"], "npm run test")
            self.assertEqual(profile["build"]["command"], "npm run build")

    def test_python_profile_falls_back_to_builtin_unittest_when_pytest_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("coding_tools_mcp.build_verify.importlib.util.find_spec", return_value=None):
            root = Path(temp)
            (root / "pyproject.toml").write_text('[project]\nname="demo"\nversion="1.0"\n', encoding="utf-8")
            tests = root / "tests"
            tests.mkdir()
            (tests / "test_demo.py").write_text("import unittest\n", encoding="utf-8")
            profile = profile_project_execution(root)
            self.assertEqual(profile["test"]["status"], "verified")
            self.assertEqual(profile["test"]["framework"], "unittest")
            self.assertIn("unittest discover", profile["test"]["command"])

    def test_unavailable_python_tests_do_not_guess_or_execute_runner(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("coding_tools_mcp.build_verify.importlib.util.find_spec", return_value=None):
            root = Path(temp)
            (root / "pyproject.toml").write_text('[project]\nname="demo"\nversion="1.0"\n', encoding="utf-8")
            (root / "tests").mkdir()
            calls = []
            report = verify_build_profile(
                root,
                {"run_tests": True, "run_build": False},
                lambda command, workdir, timeout: calls.append((command, workdir, timeout)) or {"status": "passed"},
            )
            self.assertEqual(report["test_result"]["status"], "unavailable")
            self.assertEqual(calls, [])
            self.assertEqual(report["overall_status"], "passed")


class ExecutionPlannerTests(unittest.TestCase):
    def test_command_role_inference_keeps_diagnostics_nonblocking(self) -> None:
        self.assertEqual(Runtime._infer_workflow_command_role("git status"), ("diagnostic", False))
        self.assertEqual(Runtime._infer_workflow_command_role("rg missing src"), ("diagnostic", False))
        self.assertEqual(Runtime._infer_workflow_command_role("npm test"), ("verification", True))
        self.assertEqual(Runtime._infer_workflow_command_role("node scripts/migrate.js"), ("blocking", True))

    def test_execution_plan_uses_target_subproject_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch("coding_tools_mcp.build_verify._tool_available", return_value=True):
            root = Path(temp)
            child = root / "frontend"
            (child / "src").mkdir(parents=True)
            (child / "src" / "app.js").write_text("x\n", encoding="utf-8")
            (child / "package.json").write_text(json.dumps({"name": "frontend", "scripts": {"test": "node --test", "build": "vite build"}}), encoding="utf-8")
            runtime = Runtime(root, permission_mode="dangerous")
            plan = runtime._build_execution_plan({"workflow": "bugfix", "path": ".", "paths": ["frontend/src/app.js"]})
            self.assertEqual(plan["project_root"], "frontend")
            self.assertEqual(plan["workdir"], "frontend")
            self.assertEqual(plan["verification"], "tests")
            self.assertEqual(plan["test"]["status"], "verified")
            runtime.close()

    def test_prepare_returns_execution_plan_and_diagnose_runs_no_guessed_tests(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            root = Path(temp)
            (root / "package.json").write_text(json.dumps({"name": "demo", "scripts": {}}), encoding="utf-8")
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({"workflow": "diagnose", "phase": "prepare", "objective": "inspect"})
            self.assertEqual(result["execution_plan"]["verification"], "none")
            self.assertEqual(result["execution_plan"]["commands"], [])
            self.assertNotIn("apply_changes_and_verify", result["recommended_next_action"])
            runtime.close()


class PatchDisambiguationTests(unittest.TestCase):
    def test_line_hint_selects_nearest_duplicate_context(self) -> None:
        content = "alpha\nvalue = 1\nomega\nalpha\nvalue = 1\nomega\n"
        operations = parse_patch(
            "*** Begin Patch\n*** Update File: demo.txt\n@@ line:5\n-value = 1\n+value = 2\n*** End Patch"
        )
        updated = apply_update_hunks(content, operations[0].hunks, "demo.txt")
        self.assertEqual(updated.count("value = 1"), 1)
        self.assertIn("alpha\nvalue = 2\nomega\n", updated)

    def test_ambiguous_patch_returns_candidate_locations(self) -> None:
        content = "same\nx\nsame\ny\n"
        operations = parse_patch(
            "*** Begin Patch\n*** Update File: demo.txt\n@@\n-same\n+changed\n*** End Patch"
        )
        with self.assertRaises(ToolFailure) as caught:
            apply_update_hunks(content, operations[0].hunks, "demo.txt")
        details = caught.exception.details
        self.assertEqual(details["match_count"], 2)
        self.assertEqual([item["line"] for item in details["candidate_locations"]], [1, 3])


class ToolModeTests(unittest.TestCase):
    def test_windows_core_environment_keeps_required_os_paths(self) -> None:
        required = {"SYSTEMDRIVE", "PROGRAMDATA", "ALLUSERSPROFILE", "SYSTEMROOT", "USERPROFILE", "PUBLIC"}
        self.assertTrue(required.issubset(server_module.WINDOWS_CORE_ENV_NAMES))

    def test_tool_modes_expose_expected_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "readonly"}):
                readonly = set(Runtime(root)._exposed_tool_names)
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "coding"}):
                coding = set(Runtime(root)._exposed_tool_names)
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "build"}):
                build = set(Runtime(root)._exposed_tool_names)
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "full"}):
                full = set(Runtime(root)._exposed_tool_names)
            self.assertIn("read_file", readonly)
            self.assertNotIn("apply_patch", readonly)
            self.assertIn("apply_patch", coding)
            self.assertIn("verify_build", coding)
            self.assertIn("verify_build", build)
            self.assertNotIn("apply_patch", build)
            self.assertGreater(len(full), len(coding))

    def test_smart_mode_is_compact_and_contains_batch_document_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(temp))
            tools = set(runtime.exposed_tool_names())
            self.assertLessEqual(len(tools), 9)
            self.assertEqual(tools, {"coding_tools_guide", "workspace_context", "agent_workflow", "task_control", "document_workflow", "exec_command", "command_control", "request_permissions", "view_image"})
            self.assertNotIn("document_extract", tools)

    def test_workspace_context_is_compact_and_cached(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            root = Path(temp)
            (root / "app.py").write_text("print('ok')\n", encoding="utf-8")
            runtime = Runtime(root)
            first = runtime.workspace_context({})
            second = runtime.workspace_context({})
            self.assertEqual(first["detail"], "compact")
            self.assertFalse(first["cache"]["hit"])
            self.assertTrue(second["cache"]["hit"])
            self.assertNotIn("events", second["task"])

    def test_finished_command_moves_task_to_waiting(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.update({"objective": "Run a command", "status": "active"})
            store.record_command_started("echo ok", "session-one", ".")
            store.record_tool_result("exec_command", {"cmd": "echo ok"}, {"ok": True, "status": "exited", "session_id": "session-one", "exit_code": 0, "elapsed_ms": 1})
            self.assertEqual(store.get()["status"], "waiting")

    def test_nonblocking_command_failure_becomes_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStateStore(Path(temp))
            store.update({"objective": "Run diagnostics", "status": "active"})
            store.record_command_started("findstr missing", "session-one", ".")
            store.record_tool_result(
                "exec_command",
                {"cmd": "findstr missing", "role": "diagnostic", "blocking": False},
                {"ok": True, "status": "exited", "session_id": "session-one", "exit_code": 1, "summary": "not found"},
            )
            state = store.get()
            self.assertEqual(state["status"], "waiting")
            self.assertIsNone(state["failure"])
            self.assertEqual(state["warnings"][-1]["role"], "diagnostic")

    def test_structured_workflow_command_can_fail_without_failing_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.apply_changes_and_verify({
                "objective": "diagnostic warning",
                "checks": [{"cmd": "python -c \"import sys; sys.exit(3)\"", "role": "diagnostic", "blocking": False}],
                "verification": "none",
            })
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "passed_with_warnings")
            self.assertEqual(result["warnings"][0]["exit_code"], 3)

    def test_prepare_coding_context_batches_search_reads_and_caches(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            root = Path(temp)
            (root / "app.py").write_text("def greet():\n    return 'hello'\n", encoding="utf-8")
            runtime = Runtime(root)
            first = runtime.prepare_coding_context({"objective": "change greeting", "queries": ["greet"], "max_files": 4})
            second = runtime.prepare_coding_context({"objective": "change greeting", "queries": ["greet"], "max_files": 4})
            self.assertFalse(first["cache_hit"])
            self.assertTrue(second["cache_hit"])
            self.assertEqual(first["files"][0]["path"], "app.py")
            self.assertIn("hello", first["files"][0]["content"])

    def test_apply_changes_and_verify_runs_continuous_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.apply_changes_and_verify({
                "objective": "create a file in one workflow",
                "patch": "*** Begin Patch\n*** Add File: done.txt\n+finished\n*** End Patch",
                "verification": "none",
                "include_diff": False,
            })
            self.assertTrue(result["ok"])
            self.assertEqual((root / "done.txt").read_text(encoding="utf-8"), "finished\n")
            self.assertEqual(runtime.task_state.get()["status"], "completed")

    def test_agent_workflow_prepares_bug_context_in_one_call(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.py").write_text("def login():\n    raise RuntimeError('broken')\n", encoding="utf-8")
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "bugfix",
                "phase": "prepare",
                "objective": "fix login crash",
                "queries": ["login", "RuntimeError"],
            })
            self.assertEqual(result["phase"], "prepare")
            self.assertEqual(result["context"]["files"][0]["path"], "app.py")
            self.assertEqual(len(result["context"]["searches"]), 2)

    def test_agent_workflow_creates_greenfield_project_and_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "greenfield",
                "phase": "execute",
                "objective": "create a tiny Python project",
                "directories": ["src"],
                "files": [{"path": "src/main.py", "content": "print('ready')\n"}],
                "commands": ["python src/main.py"],
                "verification": "none",
                "include_diff": False,
            })
            self.assertTrue(result["execution"]["ok"])
            self.assertEqual((root / "src" / "main.py").read_text(encoding="utf-8"), "print('ready')\n")
            self.assertEqual(result["task"]["status"], "completed")

    def test_agent_workflow_prefers_structured_command_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = Runtime(root, permission_mode="dangerous")
            result = runtime.agent_workflow({
                "workflow": "custom",
                "phase": "execute",
                "objective": "structured command",
                "commands": ["python -c \"raise SystemExit(7)\""],
                "command_steps": [{
                    "cmd": "python -c \"print('structured-ok')\"",
                    "role": "diagnostic",
                    "blocking": False,
                    "timeout_ms": 30000,
                }],
                "verification": "none",
            })
            checks = result["execution"]["check_results"]
            self.assertEqual(len(checks), 1)
            self.assertEqual(checks[0]["status"], "passed")
            self.assertEqual(checks[0]["role"], "diagnostic")
            self.assertFalse(checks[0]["blocking"])

    def test_agent_workflow_resume_returns_state_and_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "todo.py").write_text("VALUE = 1\n", encoding="utf-8")
            runtime = Runtime(root, permission_mode="dangerous")
            runtime.task_state.update({"objective": "continue fix", "next_step": "edit todo.py"})
            result = runtime.agent_workflow({"workflow": "resume", "phase": "resume", "paths": ["todo.py"]})
            self.assertEqual(result["task"]["objective"], "continue fix")
            self.assertEqual(result["context"]["files"][0]["path"], "todo.py")

    def test_prepare_reads_search_window_instead_of_large_file_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            root = Path(temp)
            lines = [f"line-{index}" for index in range(1, 701)]
            lines[559] = "TARGET_NEEDLE = important_value"
            (root / "large.py").write_text("\n".join(lines) + "\n", encoding="utf-8")
            runtime = Runtime(root)
            result = runtime.prepare_coding_context({"objective": "inspect target", "queries": ["TARGET_NEEDLE"]})
            self.assertEqual(result["read_strategy"], "search_windows")
            self.assertGreater(result["files"][0]["start_line"], 1)
            self.assertIn("TARGET_NEEDLE", result["files"][0]["content"])
            self.assertNotIn("line-1\n", result["files"][0]["content"])
            self.assertLessEqual(result["total_content_bytes"], result["context_budget"]["total_bytes"])

    def test_prepare_context_budget_is_internal_and_pressure_aware(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            budget = runtime._prepare_context_budget()
            self.assertEqual(budget["level"], "normal")
            self.assertLessEqual(budget["per_file_bytes"], 48 * 1024)
            self.assertLessEqual(budget["total_bytes"], 320 * 1024)

    def test_server_discover_does_not_require_initialize(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            response = dispatch_rpc(Runtime(Path(temp)), {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {}})
            self.assertIn("result", response)
            self.assertEqual(response["result"]["serverInfo"]["name"], "coding-tools-mcp")
            self.assertTrue(response["result"]["capabilities"]["tools"]["listChanged"])
            self.assertIn("runtimeInstanceId", response["result"]["serverInfo"])
            self.assertIn("processId", response["result"]["serverInfo"])

    def test_authorized_root_allows_absolute_read_write_and_blocks_other_paths(self) -> None:
        with tempfile.TemporaryDirectory() as main_temp, tempfile.TemporaryDirectory() as extra_temp, tempfile.TemporaryDirectory() as blocked_temp:
            main = Path(main_temp)
            extra = Path(extra_temp)
            blocked = Path(blocked_temp)
            source = extra / "共享资料.txt"
            source.write_text("中文内容\n", encoding="utf-8")
            blocked_file = blocked / "secret.txt"
            blocked_file.write_text("blocked\n", encoding="utf-8")
            runtime = Runtime(main)
            updated = runtime.set_authorized_roots([str(extra)])
            self.assertIn(str(extra.resolve()), updated["authorized_roots"])
            read = runtime.read_file({"path": str(source)})
            self.assertIn("中文内容", read["content"])
            target = runtime.resolve_for_write(str(extra / "nested" / "created.txt")).path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("created\n", encoding="utf-8")
            self.assertEqual(target.read_text(encoding="utf-8"), "created\n")
            with self.assertRaises(server_module.ToolFailure):
                runtime.read_file({"path": str(blocked_file)})
            runtime.close()

    def test_authorized_root_is_first_class_for_context_and_build(self) -> None:
        with tempfile.TemporaryDirectory() as main_temp, tempfile.TemporaryDirectory() as extra_temp:
            main = Path(main_temp)
            extra = Path(extra_temp)
            (extra / "package.json").write_text(
                json.dumps({"name": "authorized-project", "version": "2.0.0", "scripts": {}}),
                encoding="utf-8",
            )
            runtime = Runtime(main, permission_mode="dangerous")
            runtime.set_authorized_roots([str(extra)])
            context = runtime.workspace_context({"path": str(extra)})
            self.assertEqual(context["scope"]["kind"], "authorized")
            self.assertEqual(context["scope"]["root"], str(extra.resolve()))
            self.assertEqual(context["project"]["name"], "authorized-project")
            build_command = (
                f'"{sys.executable}" -c "from pathlib import Path; '
                "Path('dist').mkdir(exist_ok=True); Path('dist/result.txt').write_text('ok')\""
            )
            report = runtime.verify_build({
                "path": str(extra),
                "run_tests": False,
                "run_build": True,
                "build_command": build_command,
                "artifact_paths": ["dist"],
            })
            self.assertTrue(report["ok"])
            self.assertTrue((extra / "dist" / "result.txt").exists())
            runtime.close()

    def test_search_text_handles_utf8_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "中文文件.txt").write_text("工具搜索中文关键字\n", encoding="utf-8")
            runtime = Runtime(root)
            result = runtime.search_text({"query": "中文关键字", "path": "."})
            self.assertEqual(result["total_matches"], 1)
            self.assertIn("中文文件.txt", result["matches"][0]["path"])
            runtime.close()


class DocumentToolTests(unittest.TestCase):
    def test_create_and_extract_docx(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "report.docx"
            created = create_docx(target, "构建报告", "# 完成\n- 测试通过")
            self.assertGreater(created["size"], 500)
            extracted = extract_docx(target)
            self.assertIn("构建报告", extracted["content"])
            self.assertIn("测试通过", extracted["content"])

    def test_document_workflow_create_and_inspect(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            created = runtime.document_workflow({"action": "create", "target": "report.docx", "title": "Report", "content": "# Done\n- Passed"})
            self.assertGreater(created["result"]["size"], 500)
            inspected = runtime.document_workflow({"action": "inspect", "path": "report.docx"})
            self.assertEqual(inspected["count"], 1)
            self.assertIn("Passed", inspected["documents"][0]["content"])

    def test_document_workflow_creates_markdown_with_verification_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp), permission_mode="dangerous")
            created = runtime.document_workflow({
                "action": "create",
                "target": "learning-plan.md",
                "content": "# Plan\n\n- Week 1\n- Week 2\n",
            })
            result = created["result"]
            self.assertEqual((Path(temp) / "learning-plan.md").read_text(encoding="utf-8"), "# Plan\n\n- Week 1\n- Week 2\n")
            self.assertEqual(result["line_count"], 4)
            self.assertEqual(len(result["sha256"]), 64)
            self.assertEqual(result["preview"][0], "# Plan")


if __name__ == "__main__":
    unittest.main()
