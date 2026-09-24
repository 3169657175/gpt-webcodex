from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import coding_tools_mcp.server as server_module
from coding_tools_mcp.server import Runtime


class BackgroundProgressRegressionTests(unittest.TestCase):
    def test_background_queue_is_fifo_and_limits_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            runtime.background_max_workers = 1
            first_gate = threading.Event()
            second_started = threading.Event()
            starts: list[str] = []
            active = {"value": 0, "max": 0}
            lock = threading.Lock()

            def queued_result(name, arguments, request_id=None):
                del name, request_id
                objective = str(arguments.get("objective") or "")
                with lock:
                    active["value"] += 1
                    active["max"] = max(active["max"], active["value"])
                    starts.append(objective)
                try:
                    if objective == "first":
                        first_gate.wait(1)
                    else:
                        second_started.set()
                    time.sleep(0.03)
                    return {"done": objective}
                finally:
                    with lock:
                        active["value"] -= 1

            with patch.object(runtime, "_call_tool_sync", side_effect=queued_result):
                first, _ = runtime._start_background_tool("agent_workflow", {"phase": "run", "objective": "first", "timeout_seconds": 1}, request_id=1)
                second, _ = runtime._start_background_tool("agent_workflow", {"phase": "run", "objective": "second", "timeout_seconds": 1}, request_id=2)
                duplicate, _ = runtime._start_background_tool("agent_workflow", {"phase": "run", "objective": "second", "timeout_seconds": 1}, request_id=3)
                self.assertEqual(second["operation_id"], duplicate["operation_id"])
                time.sleep(0.05)
                second_snapshot = runtime._background_operation_snapshot(second)
                self.assertEqual(second_snapshot["status"], "queued")
                self.assertEqual(second_snapshot["execution"]["lifecycle_state"], "queued")
                self.assertEqual(second_snapshot["execution"]["started_at"], "")
                self.assertTrue(second_snapshot["execution"]["retry_safe"])
                self.assertFalse(second_snapshot["execution"]["side_effect_possible"])
                self.assertFalse(second_started.is_set())
                first_gate.set()
                self.assertTrue(first["event"].wait(1))
                self.assertTrue(second["event"].wait(1))
                self.assertEqual(starts, ["first", "second"])
                self.assertEqual(active["max"], 1)
                self.assertTrue(second_started.is_set())
                second_done = runtime._background_operation_snapshot(second)
                self.assertEqual(second_done["execution"]["lifecycle_state"], "completed")
                self.assertTrue(second_done["execution"]["started_at"])
                self.assertTrue(second_done["deadline_at"])
            runtime.close()

    def test_queued_wait_does_not_consume_execution_timeout_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            runtime.background_max_workers = 1
            first_gate = threading.Event()
            second_remaining: list[float] = []

            def queued_result(name, arguments, request_id=None):
                del name, request_id
                if arguments.get("objective") == "first":
                    first_gate.wait(1)
                else:
                    deadline = float(getattr(runtime.execution_context, "deadline_epoch", 0.0) or 0.0)
                    second_remaining.append(deadline - time.time())
                return {"done": True}

            with patch.object(runtime, "_call_tool_sync", side_effect=queued_result):
                first, _ = runtime._start_background_tool("agent_workflow", {"phase": "run", "objective": "first", "timeout_seconds": 1}, request_id=1)
                second, _ = runtime._start_background_tool("agent_workflow", {"phase": "run", "objective": "second", "timeout_seconds": 1}, request_id=2)
                time.sleep(0.2)
                self.assertEqual(runtime._background_operation_snapshot(second)["status"], "queued")
                first_gate.set()
                self.assertTrue(first["event"].wait(1))
                self.assertTrue(second["event"].wait(1))
                self.assertEqual(len(second_remaining), 1)
                self.assertGreater(second_remaining[0], 0.7)
            runtime.close()
    def test_is_error_result_finalizes_operation_and_task_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def failed_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.04)
                return {
                    "isError": True,
                    "structuredContent": {
                        "ok": False,
                        "error": {
                            "code": "PATCH_REJECTED",
                            "message": "atomic patch rejected",
                            "category": "validation",
                            "retryable": False,
                        },
                    },
                }

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                runtime, "_call_tool_sync", side_effect=failed_result
            ):
                first = runtime.call_tool("agent_workflow", {"phase": "run", "objective": "failure regression"})
                operation_id = first["structuredContent"]["background_operation"]["operation_id"]
                polled = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})
                operation = polled["background_operation"]
                state = runtime.task_state.get()
                self.assertEqual(operation["status"], "failed")
                self.assertTrue(operation["execution"]["execution_id"])
                self.assertEqual(operation["execution"]["lifecycle_state"], "failed")
                self.assertFalse(operation["execution"]["retry_safe"])
                self.assertEqual(operation["error"]["message"], "atomic patch rejected")
                self.assertEqual(state["lifecycle_state"], "failed")
                self.assertEqual(state["status"], "failed")
                self.assertEqual(state["failure"], "atomic patch rejected")
            runtime.close()

    def test_progress_report_is_due_only_once_per_interval_after_initial_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))
            calls = []
            deadlines = []

            def slow_result(name, arguments, request_id=None):
                del name, arguments, request_id
                calls.append(1)
                deadlines.append(float(getattr(runtime.execution_context, "deadline_epoch", 0.0) or 0.0))
                time.sleep(0.35)
                return {"done": True}

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                server_module, "PROGRESS_REPORT_SECONDS", 0.05
            ), patch.object(runtime, "_call_tool_sync", side_effect=slow_result):
                workflow_args = {"phase": "run", "objective": "progress regression", "timeout_seconds": 2}
                first = runtime.call_tool("agent_workflow", workflow_args)
                structured = first["structuredContent"]
                self.assertTrue(structured["requires_progress_report"])
                operation_id = structured["background_operation"]["operation_id"]
                execution_id = structured["background_operation"]["execution"]["execution_id"]
                deadline_at = structured["background_operation"]["deadline_at"]
                self.assertEqual(structured["background_operation"]["timeout_budget_seconds"], 2)
                self.assertGreaterEqual(structured["background_operation"]["remaining_timeout_seconds"], 1)
                self.assertEqual(structured["background_operation"]["execution"]["lifecycle_state"], "running")

                duplicate = runtime.call_tool("agent_workflow", workflow_args)
                duplicate_operation = duplicate["structuredContent"].get("background_operation")
                if isinstance(duplicate_operation, dict):
                    self.assertEqual(duplicate_operation["operation_id"], operation_id)
                    self.assertEqual(duplicate_operation["execution"]["execution_id"], execution_id)
                    self.assertEqual(duplicate_operation["deadline_at"], deadline_at)

                immediate = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertEqual(immediate["status"], "running")
                self.assertEqual(immediate["execution"]["execution_id"], execution_id)
                self.assertFalse(immediate["requires_progress_report"])

                time.sleep(0.07)
                due = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertTrue(due["requires_progress_report"])

                immediate_again = runtime.task_control({"action": "operation", "operation_id": operation_id})["background_operation"]
                self.assertFalse(immediate_again["requires_progress_report"])

                completed = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})["background_operation"]
                self.assertEqual(completed["status"], "completed")
                self.assertEqual(completed["execution"]["execution_id"], execution_id)
                self.assertEqual(completed["execution"]["lifecycle_state"], "completed")
                self.assertEqual(completed["deadline_at"], deadline_at)
                self.assertEqual(len(calls), 1)
                self.assertEqual(len(deadlines), 1)
                self.assertGreater(deadlines[0], 0)
                self.assertFalse(completed["requires_progress_report"])
            runtime.close()

    def test_execution_timeout_error_maps_background_lifecycle_to_timed_out(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Runtime(Path(temp))

            def timed_out_result(name, arguments, request_id=None):
                del name, arguments, request_id
                time.sleep(0.04)
                return {
                    "isError": True,
                    "structuredContent": {
                        "ok": False,
                        "error": {
                            "code": "EXECUTION_TIMEOUT",
                            "message": "budget exhausted",
                            "category": "runtime",
                            "retryable": False,
                        },
                    },
                }

            with patch.object(server_module, "LONG_TOOL_HANDOFF_SECONDS", 0.01), patch.object(
                runtime, "_call_tool_sync", side_effect=timed_out_result
            ):
                first = runtime.call_tool("agent_workflow", {"phase": "run", "objective": "timeout regression"})
                operation_id = first["structuredContent"]["background_operation"]["operation_id"]
                completed = runtime.task_control({"action": "operation", "operation_id": operation_id, "wait_ms": 1000})["background_operation"]
                self.assertEqual(completed["status"], "failed")
                self.assertEqual(completed["execution"]["lifecycle_state"], "timed_out")
                self.assertFalse(completed["execution"]["retry_safe"])
            runtime.close()


if __name__ == "__main__":
    unittest.main()
