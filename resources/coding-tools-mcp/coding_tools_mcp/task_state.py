from __future__ import annotations

import copy
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


STATE_VERSION = 2
MAX_EVENTS = 100
MAX_DURABLE_EVENTS = 2000
MAX_OPERATION_RECORDS = 128
EVENT_COMPACT_EVERY = 100
MAX_RESULTS = 20
MAX_FILES = 500
MAX_TEXT = 16_000
STALE_ACTIVE_SECONDS = 90
STALE_WAITING_SECONDS = 30 * 60

RUN_STATES = frozenset({
    "created", "planning", "ready", "running", "recovering", "waiting_model",
    "waiting_approval", "waiting_user", "verifying", "completed", "failed", "cancelled",
})
LIFECYCLE_STATES = frozenset({
    "idle", *RUN_STATES,
    # Legacy lifecycle values remain readable while 0.4.0 migrates callers to
    # the canonical Run states above.
    "preparing", "needs_user", "paused",
})
TERMINAL_LIFECYCLE_STATES = frozenset({"completed", "failed", "cancelled"})
ACTIVE_LIFECYCLE_STATES = frozenset({
    "created", "planning", "ready", "preparing", "running", "recovering", "verifying",
})
WAITING_LIFECYCLE_STATES = frozenset({
    "waiting_model", "waiting_approval", "waiting_user", "needs_user", "paused",
})
RUN_STATE_ALIASES = {
    "preparing": "planning",
    "needs_user": "waiting_user",
    "paused": "waiting_user",
}
LIFECYCLE_TO_STATUS = {
    "idle": "idle",
    "created": "active",
    "planning": "active",
    "ready": "active",
    "preparing": "active",
    "running": "active",
    "recovering": "active",
    "waiting_model": "waiting",
    "waiting_approval": "waiting",
    "waiting_user": "waiting",
    "needs_user": "waiting",
    "paused": "paused",
    "verifying": "active",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "stopped",
}
STATUS_TO_LIFECYCLE = {
    "idle": "idle",
    "active": "running",
    "waiting": "waiting_model",
    "paused": "paused",
    "completed": "completed",
    "failed": "failed",
    "stopped": "cancelled",
}

TEST_COMMAND_RE = re.compile(
    r"(?:^|\s)(?:pytest|python\s+-m\s+pytest|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|"
    r"yarn\s+test|jest|vitest|cargo\s+test|go\s+test|mvn(?:w)?\s+test|gradle(?:w)?\s+test|"
    r"dotnet\s+test|ctest)(?:\s|$)",
    re.IGNORECASE,
)
BUILD_COMMAND_RE = re.compile(
    r"(?:^|\s)(?:npm\s+run\s+(?:build|dist|package)|pnpm\s+(?:run\s+)?(?:build|dist)|"
    r"yarn\s+(?:build|dist)|electron-builder|cargo\s+build|go\s+build|mvn(?:w)?\s+package|"
    r"gradle(?:w)?\s+build|dotnet\s+(?:build|publish)|python\s+-m\s+build|pyinstaller)(?:\s|$)",
    re.IGNORECASE,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def classify_command(command: str) -> str:
    if TEST_COMMAND_RE.search(command):
        return "test"
    if BUILD_COMMAND_RE.search(command):
        return "build"
    return "command"


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _canonical_run_state(lifecycle_state: str) -> str:
    lifecycle = str(lifecycle_state or "")
    if lifecycle == "idle":
        return ""
    canonical = RUN_STATE_ALIASES.get(lifecycle, lifecycle)
    return canonical if canonical in RUN_STATES else "running"


MAX_TOOL_EVENT_STRING = 8_000
MAX_TOOL_EVENT_ITEMS = 50
MAX_TOOL_EVENT_DEPTH = 5


def _tool_event_value(value: Any, depth: int = 0) -> Any:
    """Bound durable tool-event payloads so patches/diffs cannot grow events.jsonl without limit."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= MAX_TOOL_EVENT_STRING:
            return value
        omitted = len(value) - MAX_TOOL_EVENT_STRING
        return value[:MAX_TOOL_EVENT_STRING] + f"…<truncated {omitted} chars>"
    if isinstance(value, Path):
        return _tool_event_value(str(value), depth)
    if depth >= MAX_TOOL_EVENT_DEPTH:
        return _tool_event_value(str(value), depth + 1)
    if isinstance(value, dict):
        items = list(value.items())
        result = {
            _text(key, 200): _tool_event_value(item, depth + 1)
            for key, item in items[:MAX_TOOL_EVENT_ITEMS]
        }
        if len(items) > MAX_TOOL_EVENT_ITEMS:
            result["__truncated_items__"] = len(items) - MAX_TOOL_EVENT_ITEMS
        return result
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        result = [_tool_event_value(item, depth + 1) for item in items[:MAX_TOOL_EVENT_ITEMS]]
        if len(items) > MAX_TOOL_EVENT_ITEMS:
            result.append({"__truncated_items__": len(items) - MAX_TOOL_EVENT_ITEMS})
        return result
    return _tool_event_value(str(value), depth + 1)


def _tool_event_details(name: str, args: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    background = payload.get("background_operation") if isinstance(payload.get("background_operation"), dict) else {}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    operation_id = str(payload.get("operation_id") or background.get("operation_id") or "") or None
    return {
        "tool": name,
        "status": str(payload.get("status") or ("failed" if payload.get("ok") is False else "completed")),
        "code": error.get("code"),
        "operation_id": operation_id,
        "arguments": _tool_event_value(args),
        "result": _tool_event_value(payload),
        "affected_files": _tool_event_value(payload.get("affected_files", [])),
    }


def _set_lifecycle(state: dict[str, Any], lifecycle_state: str, *, wait_reason: str = "") -> None:
    previous_lifecycle = str(state.get("lifecycle_state") or "idle")
    lifecycle = lifecycle_state if lifecycle_state in LIFECYCLE_STATES else "running"
    state["lifecycle_state"] = lifecycle
    state["run_state"] = _canonical_run_state(lifecycle)
    state["status"] = LIFECYCLE_TO_STATUS[lifecycle]
    reason = _text(wait_reason, 200)
    state["wait_reason"] = reason if lifecycle in WAITING_LIFECYCLE_STATES else ""
    if lifecycle in {"waiting_approval", "waiting_user", "needs_user", "paused"}:
        state["pause_reason"] = reason or _text(state.get("pause_reason"), 2000)
    elif lifecycle in ACTIVE_LIFECYCLE_STATES or lifecycle in TERMINAL_LIFECYCLE_STATES:
        state["pause_reason"] = ""
    if (
        lifecycle != "idle"
        and lifecycle not in TERMINAL_LIFECYCLE_STATES
        and (lifecycle != previous_lifecycle or not state.get("last_heartbeat_at"))
    ):
        state["last_heartbeat_at"] = utc_now()
    if lifecycle in {"completed", "failed", "cancelled"}:
        current = state.get("current_command")
        if isinstance(current, dict):
            finalized = copy.deepcopy(current)
            finished_at = utc_now()
            if str(finalized.get("status") or "") == "running":
                finalized["status"] = {
                    "completed": "completed",
                    "failed": "failed",
                    "cancelled": "cancelled",
                }[lifecycle]
            execution_state = str(finalized.get("execution_lifecycle_state") or "")
            if execution_state in {"", "queued", "running"}:
                finalized["execution_lifecycle_state"] = {
                    "completed": "completed",
                    "failed": "failed",
                    "cancelled": "cancelled",
                }[lifecycle]
            finalized.setdefault("finished_at", finished_at)
            if not str(finalized.get("execution_finished_at") or ""):
                finalized["execution_finished_at"] = str(finalized.get("finished_at") or finished_at)
            if lifecycle == "completed" and finalized.get("exit_code") is None:
                finalized["exit_code"] = 0
            state["last_command"] = finalized
            state["current_command"] = None


def _default_state() -> dict[str, Any]:
    now = utc_now()
    return {
        "version": STATE_VERSION,
        "task_id": "",
        "run_id": "",
        "project_id": "",
        "local_session_id": "",
        "plan_revision": 1,
        "current_step_id": "",
        "resume_cursor": 0,
        "last_heartbeat_at": "",
        "run_state": "",
        "pause_reason": "",
        "safe_resume_point": "",
        "recommended_next_action": "",
        "recovery_attempt": 0,
        "last_recovery": None,
        "objective": "",
        "status": "idle",
        "lifecycle_state": "idle",
        "wait_reason": "",
        "steps": [],
        "current_step": "",
        "current_command": None,
        "last_command": None,
        "test_results": [],
        "build_results": [],
        "last_build_report": None,
        "modified_files": [],
        "failure": None,
        "warnings": [],
        "next_step": "",
        "created_at": now,
        "updated_at": now,
        "events": [],
    }


class TaskStateStore:
    """Workspace-local, atomic task state used across browser chats and MCP restarts."""

    def __init__(self, workspace: Path, terminal_callback: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.workspace = workspace.resolve()
        self.state_dir = self.workspace / ".coding-tools"
        self.path = self.state_dir / "task-state.json"
        self.history_path = self.state_dir / "task-history.json"
        self.events_path = self.state_dir / "events.jsonl"
        self.operations_path = self.state_dir / "operations.json"
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._revision = 0
        self._event_id = self._load_last_event_id()
        self._terminal_callback = terminal_callback
        self.last_terminal_callback_error = ""

    def set_terminal_callback(self, callback: Callable[[dict[str, Any]], None] | None) -> None:
        with self._lock:
            self._terminal_callback = callback

    def get(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._read())

    def event_snapshot(self) -> tuple[int, dict[str, Any]]:
        """Return the in-process revision and current state for local desktop subscribers."""
        with self._lock:
            return self._revision, copy.deepcopy(self._read())

    def wait_for_revision(self, after_revision: int, timeout: float = 15.0) -> tuple[int, dict[str, Any]] | None:
        """Wait for a task-state write without repeatedly polling task-state.json."""
        with self._condition:
            if self._revision <= after_revision:
                changed = self._condition.wait_for(
                    lambda: self._revision > after_revision,
                    timeout=max(0.0, timeout),
                )
                if not changed:
                    return None
            return self._revision, copy.deepcopy(self._read())

    def latest_event_id(self) -> int:
        with self._lock:
            return self._event_id

    def events_since(self, after_event_id: int, limit: int = 200) -> list[dict[str, Any]]:
        """Return durable events after an id so reconnecting clients can replay missed boundaries."""
        with self._lock:
            return self._read_durable_events(after_event_id, limit)

    def recent_events(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return the newest durable boundaries without forcing callers to know an event id."""
        with self._lock:
            maximum = max(1, min(int(limit or 50), 500))
            return self._read_durable_events(max(0, self._event_id - maximum), maximum)

    def wait_for_events(self, after_event_id: int, timeout: float = 15.0, limit: int = 200) -> list[dict[str, Any]]:
        """Wait for durable events instead of reading only the newest task-state snapshot."""
        with self._condition:
            if self._event_id <= after_event_id:
                changed = self._condition.wait_for(
                    lambda: self._event_id > after_event_id,
                    timeout=max(0.0, timeout),
                )
                if not changed:
                    return []
            return self._read_durable_events(after_event_id, limit)

    def record_durable_event(self, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Append a non-state boundary event and wake event-stream subscribers."""
        with self._condition:
            state = self._read()
            record = self._append_durable_event(str(event_type or "task.updated"), state, payload or {})
            self._revision += 1
            self._condition.notify_all()
            return copy.deepcopy(record)

    def ensure_started(self, objective: str, *, current_step: str = "") -> dict[str, Any]:
        """Create a visible task automatically when a client skips explicit task setup."""
        with self._lock:
            state = self._read()
            status = str(state.get("status", ""))
            if self._has_task(state) and status not in {"completed", "failed", "stopped"}:
                if status == "waiting" and self._waiting_task_should_be_superseded(state, objective):
                    self._archive(state, "stale-superseded")
                    state = _default_state()
                else:
                    return copy.deepcopy(state)
            if self._has_task(state):
                self._archive(state, "finished")
            state = _default_state()
            state["task_id"] = uuid.uuid4().hex
            state["run_id"] = uuid.uuid4().hex
            state["objective"] = _text(objective or "Workspace task")
            _set_lifecycle(state, "running")
            state["current_step"] = _text(current_step)
            self._event(state, "task_auto_started", {"objective": state["objective"], "run_id": state["run_id"]})
            return self._write(state)

    @staticmethod
    def _waiting_task_should_be_superseded(state: dict[str, Any], objective: str) -> bool:
        previous = " ".join(str(state.get("objective") or "").casefold().split())
        incoming = " ".join(str(objective or "").casefold().split())
        if not incoming or incoming == previous:
            return False
        if str(state.get("lifecycle_state") or "") == "waiting_model":
            return True
        try:
            updated = datetime.fromisoformat(str(state.get("updated_at", "")).replace("Z", "+00:00"))
        except ValueError:
            return True
        return datetime.now(timezone.utc) - updated >= timedelta(seconds=STALE_WAITING_SECONDS)

    def clear(self) -> dict[str, Any]:
        with self._condition:
            state = self._read()
            if self._has_task(state):
                self._archive(state, "cleared")
                self._append_durable_event("task.cleared", state, {"reason": "cleared"})
            if self.path.exists():
                self.path.unlink()
            state = _default_state()
            self._revision += 1
            self._condition.notify_all()
            return copy.deepcopy(state)

    def recover_completed_waiting_task(self) -> dict[str, Any]:
        """Silently archive a legacy waiting-model task whose declared steps already finished."""
        with self._condition:
            state = self._read()
            if str(state.get("lifecycle_state") or "") != "waiting_model":
                return copy.deepcopy(state)
            if state.get("current_command") is not None or state.get("failure"):
                return copy.deepcopy(state)
            steps = state.get("steps")
            if not isinstance(steps, list) or not steps or not all(isinstance(item, dict) for item in steps):
                return copy.deepcopy(state)
            if any(str(item.get("status") or "") != "completed" for item in steps):
                return copy.deepcopy(state)
            archived = copy.deepcopy(state)
            _set_lifecycle(archived, "completed")
            archived["current_step"] = "Completed"
            archived["next_step"] = _text(archived.get("next_step") or "Review the completed task in history.")
            archived["updated_at"] = utc_now()
            self._archive(archived, "recovered-completed-waiting")
            self.path.unlink(missing_ok=True)
            self._revision += 1
            self._condition.notify_all()
            return _default_state()

    def history(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            raw = self._read_json(self.history_path, [])
            return copy.deepcopy(raw[-max(1, min(limit, 100)):][::-1] if isinstance(raw, list) else [])

    def operation_records(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            raw = self._read_json(self.operations_path, [])
            records = raw if isinstance(raw, list) else []
            return copy.deepcopy(records[-max(1, min(limit, MAX_OPERATION_RECORDS)):])

    def find_operation(
        self,
        *,
        operation_key: str = "",
        execution_id: str = "",
        run_id: str = "",
    ) -> dict[str, Any] | None:
        with self._lock:
            raw = self._read_json(self.operations_path, [])
            records = raw if isinstance(raw, list) else []
            for item in reversed(records):
                if operation_key and str(item.get("operation_key") or "") != str(operation_key):
                    continue
                if execution_id and str(item.get("execution_id") or "") != str(execution_id):
                    continue
                if run_id and str(item.get("run_id") or "") != str(run_id):
                    continue
                return copy.deepcopy(item)
            return None

    def upsert_operation(self, record: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            raw = self._read_json(self.operations_path, [])
            records = raw if isinstance(raw, list) else []
            operation_id = str(record.get("operation_id") or record.get("execution_id") or "")
            if not operation_id:
                operation_id = uuid.uuid4().hex
            kept = [item for item in records if str(item.get("operation_id") or "") != operation_id]
            previous = next(
                (item for item in reversed(records) if str(item.get("operation_id") or "") == operation_id),
                {},
            )
            stored = copy.deepcopy(previous) if isinstance(previous, dict) else {}
            incoming = copy.deepcopy(record)
            previous_execution = stored.get("execution") if isinstance(stored.get("execution"), dict) else {}
            incoming_execution = incoming.get("execution") if isinstance(incoming.get("execution"), dict) else {}
            stored.update(incoming)
            if previous_execution or incoming_execution:
                merged_execution = copy.deepcopy(previous_execution)
                merged_execution.update(incoming_execution)
                stored["execution"] = merged_execution
            stored["operation_id"] = operation_id
            stored["execution_id"] = str(stored.get("execution_id") or operation_id)
            kept.append(stored)
            self._write_json_atomic(self.operations_path, kept[-MAX_OPERATION_RECORDS:])
            return copy.deepcopy(stored)

    def recover_orphaned_operations(self, runtime_instance_id: str) -> list[dict[str, Any]]:
        """Mark operations from a dead MCP process as interrupted instead of pretending they still run."""
        with self._lock:
            raw = self._read_json(self.operations_path, [])
            records = raw if isinstance(raw, list) else []
            changed: list[dict[str, Any]] = []
            now = utc_now()
            for item in records:
                status = str(item.get("status") or "").lower()
                execution = item.get("execution") if isinstance(item.get("execution"), dict) else {}
                lifecycle = str(item.get("lifecycle_state") or execution.get("lifecycle_state") or "").lower()
                if status not in {"running", "queued"} and lifecycle not in {"running", "queued"}:
                    continue
                if str(item.get("runtime_instance_id") or "") == str(runtime_instance_id or ""):
                    continue
                item["execution_id"] = str(item.get("execution_id") or item.get("operation_id") or "")
                item["finished_at"] = now
                was_queued = lifecycle == "queued" or status == "queued"
                item["status"] = "not_started" if was_queued else "interrupted"
                item["lifecycle_state"] = "not_started" if was_queued else "unknown_outcome"
                item["retry_safe"] = bool(was_queued)
                item["side_effect_possible"] = not was_queued
                item["recovery_reason"] = (
                    "MCP runtime restarted before the queued operation started."
                    if was_queued
                    else "MCP runtime restarted before the background operation finished."
                )
                preserved_execution = item.get("execution") if isinstance(item.get("execution"), dict) else {}
                item["retry_policy"] = "retry_safe_not_started" if was_queued else "manual_verification_required"
                item["final_evidence"] = {
                    "lifecycle_state": item["lifecycle_state"],
                    "finished_at": now,
                    "recovery_reason": item["recovery_reason"],
                }
                item["execution"] = {
                    **copy.deepcopy(preserved_execution),
                    "execution_id": item["execution_id"],
                    "lifecycle_state": item["lifecycle_state"],
                    "queued_at": str(item.get("queued_at") or ""),
                    "started_at": str(item.get("started_at") or ""),
                    "finished_at": now,
                    "retry_safe": item["retry_safe"],
                    "side_effect_possible": item["side_effect_possible"],
                    "retry_policy": item["retry_policy"],
                }
                changed.append(copy.deepcopy(item))
            if changed:
                self._write_json_atomic(self.operations_path, records[-MAX_OPERATION_RECORDS:])
            return changed

    def recover_run_after_restart(self, orphaned_operations: list[dict[str, Any]]) -> dict[str, Any]:
        """Reconcile the current Run after Runtime restart without replaying uncertain side effects."""
        with self._lock:
            state = self._read()
            if not self._has_task(state) or str(state.get("lifecycle_state") or "") in TERMINAL_LIFECYCLE_STATES:
                return copy.deepcopy(state)
            run_id = str(state.get("run_id") or "")
            matching = next(
                (item for item in reversed(orphaned_operations) if str(item.get("run_id") or "") == run_id),
                None,
            )
            if not isinstance(matching, dict):
                return copy.deepcopy(state)
            execution = matching.get("execution") if isinstance(matching.get("execution"), dict) else {}
            lifecycle = str(matching.get("lifecycle_state") or execution.get("lifecycle_state") or "")
            retry_safe = bool(matching.get("retry_safe", execution.get("retry_safe", False)))
            side_effect_possible = bool(matching.get("side_effect_possible", execution.get("side_effect_possible", True)))
            state["recovery_attempt"] = max(0, int(state.get("recovery_attempt") or 0)) + 1
            state["safe_resume_point"] = _text(
                state.get("current_step_id")
                or state.get("current_step")
                or state.get("next_step")
                or "run_start",
                1000,
            )
            state["last_recovery"] = {
                "time": utc_now(),
                "reason": _text(matching.get("recovery_reason") or "runtime_restart", 1000),
                "operation_id": _text(matching.get("operation_id"), 200),
                "execution_id": _text(matching.get("execution_id") or execution.get("execution_id"), 200),
                "execution_state": lifecycle,
                "retry_safe": retry_safe,
                "side_effect_possible": side_effect_possible,
            }
            if lifecycle == "not_started" and retry_safe and not side_effect_possible:
                _set_lifecycle(state, "recovering")
                state["failure"] = None
                state["pause_reason"] = ""
                state["recommended_next_action"] = _text(
                    state.get("next_step") or state.get("current_step") or "Resume the queued deterministic step.",
                    2000,
                )
                self._event(state, "runtime_restart_recovering", copy.deepcopy(state["last_recovery"]))
            else:
                _set_lifecycle(state, "waiting_model", wait_reason="unsafe_to_retry")
                state["pause_reason"] = "unsafe_to_retry"
                state["failure"] = "Runtime restarted before the previous execution outcome was known; possible side effects will not be replayed automatically."
                state["recommended_next_action"] = "Inspect the original execution evidence, then resume from the next confirmed safe step."
                self._event(state, "runtime_restart_unsafe_outcome", copy.deepcopy(state["last_recovery"]))
            return self._write(state)

    def heartbeat(self, *, run_id: str = "", step_id: str = "", progress: bool = False) -> dict[str, Any]:
        """Persist a bounded Run/Step heartbeat without adding durable heartbeat events."""
        with self._lock:
            state = self._read()
            if not self._has_task(state) or str(state.get("lifecycle_state") or "") in TERMINAL_LIFECYCLE_STATES:
                return copy.deepcopy(state)
            if run_id and str(state.get("run_id") or "") != str(run_id):
                return copy.deepcopy(state)
            now = utc_now()
            state["last_heartbeat_at"] = now
            wanted_step = str(step_id or state.get("current_step_id") or "")
            if wanted_step:
                for step in state.get("steps", []):
                    if str(step.get("id") or "") == wanted_step:
                        step["last_progress_at"] = now
                        if progress:
                            step["updated_at"] = now
                        break
            return self._write(state)

    def pause(self, reason: str = "") -> dict[str, Any]:
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                return state
            _set_lifecycle(state, "paused")
            state["pause_reason"] = _text(reason, 2000)
            self._event(state, "task_paused", {"reason": state["pause_reason"]})
            return self._write(state)

    def resume(self, next_step: str = "") -> dict[str, Any]:
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                return state
            _set_lifecycle(state, "running")
            state["pause_reason"] = ""
            state["failure"] = None
            if next_step:
                state["next_step"] = _text(next_step)
            self._event(state, "task_resumed", {"next_step": state.get("next_step", "")})
            return self._write(state)

    def prepare_history_resume(self, history_record: dict[str, Any], checkpoint: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._read()
            target_task_id = _text(history_record.get("task_id") or checkpoint.get("task_id"), 160)
            target_run_id = _text(history_record.get("run_id") or checkpoint.get("run_id") or target_task_id, 160)
            if not target_task_id or not target_run_id:
                raise ValueError("History resume target is missing task/run identity")
            current_lifecycle = str(current.get("lifecycle_state") or "idle")
            if self._has_task(current) and current_lifecycle not in TERMINAL_LIFECYCLE_STATES and current_lifecycle != "idle":
                if str(current.get("run_id") or "") != target_run_id:
                    raise ValueError("Another local task is still active; stop or finish it before preparing a history resume")
            continuation = history_record.get("continuation_brief") if isinstance(history_record.get("continuation_brief"), dict) else {}
            state = _default_state()
            state["task_id"] = target_task_id
            state["run_id"] = target_run_id
            state["objective"] = _text(history_record.get("objective") or checkpoint.get("current_goal"))
            state["created_at"] = _text(history_record.get("created_at") or checkpoint.get("created_at") or utc_now(), 100)
            state["current_step"] = "Prepared from local task history"
            state["next_step"] = _text(continuation.get("next_action") or checkpoint.get("next_action") or "Resume from the validated local checkpoint")
            state["modified_files"] = copy.deepcopy(history_record.get("modified_files", []))[:MAX_FILES] if isinstance(history_record.get("modified_files"), list) else []
            state["test_results"] = copy.deepcopy(history_record.get("test_results", []))[-MAX_RESULTS:] if isinstance(history_record.get("test_results"), list) else []
            state["build_results"] = copy.deepcopy(history_record.get("build_results", []))[-MAX_RESULTS:] if isinstance(history_record.get("build_results"), list) else []
            completed = continuation.get("completed") if isinstance(continuation.get("completed"), list) else []
            pending = continuation.get("pending") if isinstance(continuation.get("pending"), list) else []
            state["steps"] = ([
                {"id": f"history-done-{index + 1}", "text": _text(value, 1000), "status": "completed"}
                for index, value in enumerate(completed[:50])
            ] + [
                {"id": f"history-pending-{index + 1}", "text": _text(value, 1000), "status": "pending"}
                for index, value in enumerate(pending[:50])
            ])
            previous_failure = _text(history_record.get("failure"), 1000)
            if previous_failure:
                state["warnings"] = [f"Previous task failure: {previous_failure}"]
            state["failure"] = None
            state["pause_reason"] = "prepared-from-history"
            _set_lifecycle(state, "paused")
            self._event(state, "history_resume_prepared", {
                "history_id": _text(history_record.get("history_id"), 160),
                "checkpoint_id": _text(checkpoint.get("checkpoint_id"), 160),
            })
            return self._write(state)

    def update(self, changes: dict[str, Any], *, event: str = "task_updated") -> dict[str, Any]:
        with self._lock:
            state = self._read()
            if changes.get("objective") and not self._has_task(state):
                # Discard anonymous tool traces left before a model explicitly started a task.
                state = _default_state()
            elif changes.get("objective") and self._has_task(state) and changes.get("new_task"):
                self._archive(state, "superseded")
                state = _default_state()
            if changes.get("objective") and not state.get("task_id"):
                state["task_id"] = uuid.uuid4().hex
            if changes.get("objective") and not state.get("run_id"):
                state["run_id"] = uuid.uuid4().hex
            for key in ("objective", "current_step", "next_step"):
                if key in changes:
                    state[key] = _text(changes[key])
            for key, limit in (
                ("project_id", 200), ("local_session_id", 200), ("current_step_id", 200),
                ("safe_resume_point", 1000), ("recommended_next_action", 2000),
            ):
                if key in changes:
                    state[key] = _text(changes[key], limit)
            if "plan_revision" in changes:
                state["plan_revision"] = max(1, int(changes.get("plan_revision") or 1))
            if "resume_cursor" in changes:
                state["resume_cursor"] = max(0, int(changes.get("resume_cursor") or 0))
            if "recovery_attempt" in changes:
                state["recovery_attempt"] = max(0, int(changes.get("recovery_attempt") or 0))
            if "pause_reason" in changes and "lifecycle_state" not in changes and "status" not in changes:
                state["pause_reason"] = _text(changes.get("pause_reason"), 2000)
            if "lifecycle_state" in changes:
                _set_lifecycle(state, str(changes["lifecycle_state"]), wait_reason=str(changes.get("wait_reason", "")))
            elif "status" in changes:
                status = _text(changes["status"], 100)
                _set_lifecycle(state, STATUS_TO_LIFECYCLE.get(status, "running"), wait_reason=str(changes.get("wait_reason", "")))
            elif "wait_reason" in changes and state.get("lifecycle_state") in WAITING_LIFECYCLE_STATES:
                state["wait_reason"] = _text(changes["wait_reason"], 200)
            if "failure" in changes:
                failure = changes["failure"]
                state["failure"] = None if failure in (None, "") else _text(failure)
            if "steps" in changes:
                state["steps"] = self._normalize_steps(changes["steps"])
            completed = {str(item) for item in changes.get("complete_step_ids", [])}
            if completed:
                for step in state["steps"]:
                    if step["id"] in completed:
                        step["status"] = "completed"
                        step["state"] = "completed"
                        step["finished_at"] = utc_now()
                        step["last_progress_at"] = step["finished_at"]
                        step["updated_at"] = utc_now()
            self._sync_step_cursor(state)
            self._event(state, event, {"fields": sorted(changes)})
            return self._write(state)

    def record_tool_result(self, name: str, args: dict[str, Any], payload: dict[str, Any]) -> None:
        if name.startswith("task_state_") or name == "task_history_list":
            return
        if name == "agent_workflow" and str(payload.get("phase", args.get("phase", ""))).lower() == "prepare":
            return
        command_tools = {"exec_command", "write_stdin", "kill_session", "command_control"}
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                return
            ok = payload.get("ok", True) is not False
            action = str(args.get("action") or "").strip().lower()
            observation_only = (
                (name == "command_control" and action in {"poll", "read"})
                or (name == "task_control" and action in {
                    "get", "operation", "history", "events",
                    "worktree_list", "worktree_get", "worktree_diff",
                })
                or name in {"coding_tools_guide", "workspace_context"}
            )
            terminal = str(state.get("lifecycle_state") or "") in TERMINAL_LIFECYCLE_STATES

            # Long agent_workflow handlers may finish the task before this final result hook runs.
            # Preserve the final tool boundary even then, but never revive/mutate terminal task state.
            if terminal:
                if name not in command_tools:
                    details = _tool_event_details(name, args, payload)
                    event_type = "tool.failed" if not ok else "tool.completed"
                    legacy_event = "tool_failed" if not ok else "tool_completed"
                    self.record_durable_event(event_type, {"legacy_event": legacy_event, "details": details})
                return

            if name in {"apply_patch", "apply_changes_and_verify", "file_batch", "document_workflow", "document_create", "document_convert"} and ok and not args.get("dry_run"):
                for item in payload.get("affected_files", []):
                    if isinstance(item, dict) and item.get("path"):
                        self._add_file(state, str(item["path"]), str(item.get("operation", "update")))
                self._event(state, "files_modified", {"count": len(payload.get("affected_files", []))})
            elif name == "exec_command":
                self._record_command_payload(state, _text(args.get("cmd"), 4000), payload, args)
            elif name == "write_stdin":
                current = state.get("current_command")
                if isinstance(current, dict) and current.get("session_id") == payload.get("session_id"):
                    self._record_command_payload(state, _text(current.get("command"), 4000), payload, current)
            elif name == "command_control":
                current = state.get("current_command")
                if action in {"poll", "write"}:
                    if isinstance(current, dict) and current.get("session_id") == payload.get("session_id"):
                        self._record_command_payload(state, _text(current.get("command"), 4000), payload, current)
                elif action == "kill":
                    if isinstance(current, dict) and current.get("session_id") == args.get("session_id"):
                        current["status"] = _text(payload.get("status", "terminated"), 100)
                        current["finished_at"] = utc_now()
                        state["last_command"] = copy.deepcopy(current)
                        state["current_command"] = None
                        self._event(state, "command_terminated", {"session_id": args.get("session_id")})
            elif name == "kill_session":
                current = state.get("current_command")
                if isinstance(current, dict) and current.get("session_id") == args.get("session_id"):
                    current["status"] = _text(payload.get("status", "terminated"), 100)
                    current["finished_at"] = utc_now()
                    state["last_command"] = copy.deepcopy(current)
                    state["current_command"] = None
                    self._event(state, "command_terminated", {"session_id": args.get("session_id")})

            if not ok and not observation_only and name not in {"task_state_get", "task_state_update", "task_state_clear"}:
                error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
                state["failure"] = _text(error.get("message") or f"{name} failed")
                self._event(state, "tool_failed", _tool_event_details(name, args, payload))
            elif ok and not observation_only and name not in {"exec_command", "write_stdin", "command_control"}:
                state["failure"] = None
                if name == "document_workflow":
                    action = str(args.get("action", "inspect")).lower()
                    if action in {"create", "convert", "rebuild"}:
                        _set_lifecycle(state, "completed")
                        state["current_step"] = "Completed"
                        state["next_step"] = "Review or use the generated document."

            self._write(state)

            # Keep the existing state-derived durable event (files.changed/task.*) and append
            # a separate successful tool boundary so neither event replaces the other.
            if ok and name not in command_tools:
                self.record_durable_event(
                    "tool.completed",
                    {"legacy_event": "tool_completed", "details": _tool_event_details(name, args, payload)},
                )

    def record_command_started(
        self,
        command: str,
        session_id: str,
        workdir: str,
        execution: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                return
            lifecycle = str(state.get("lifecycle_state") or "")
            if lifecycle in {"completed", "cancelled"}:
                return
            started_at = utc_now()
            if lifecycle == "failed":
                state["recovery_attempt"] = max(0, int(state.get("recovery_attempt") or 0)) + 1
                state["safe_resume_point"] = _text(
                    state.get("current_step_id")
                    or state.get("next_step")
                    or state.get("current_step")
                    or "follow_up_command",
                    1000,
                )
                state["last_recovery"] = {
                    "time": started_at,
                    "reason": "follow_up_command",
                    "execution_id": _text((execution or {}).get("execution_id"), 200),
                    "execution_state": "running",
                    "retry_safe": bool((execution or {}).get("retry_safe", False)),
                    "side_effect_possible": bool((execution or {}).get("side_effect_possible", True)),
                }
                _set_lifecycle(state, "recovering")
                state["failure"] = None
                state["current_step"] = "正在从上一步失败中恢复"
                self._event(state, "task_auto_recovering", copy.deepcopy(state["last_recovery"]))
            else:
                _set_lifecycle(state, "running")
            kind = classify_command(command)
            state["current_command"] = {
                "command": _text(command, 4000),
                "kind": kind,
                "session_id": session_id,
                "workdir": _text(workdir, 2000),
                "status": "running",
                "started_at": started_at,
            }
            if isinstance(execution, dict):
                state["current_command"].update({
                    "execution_id": _text(execution.get("execution_id"), 200),
                    "execution_lifecycle_state": _text(execution.get("lifecycle_state") or "running", 100),
                    "retry_safe": bool(execution.get("retry_safe", False)),
                    "side_effect_possible": bool(execution.get("side_effect_possible", True)),
                    "execution_started_at": _text(execution.get("started_at") or started_at, 100),
                    "execution_finished_at": _text(execution.get("finished_at"), 100),
                    "pid": execution.get("pid"),
                })
            self._event(state, "command_started", {
                "command": _text(command, 500),
                "session_id": session_id,
                "kind": kind,
                "workdir": _text(workdir, 2000),
                "started_at": started_at,
                "execution_id": _text((execution or {}).get("execution_id"), 200),
                "execution_lifecycle_state": _text((execution or {}).get("lifecycle_state") or "running", 100),
                "retry_safe": bool((execution or {}).get("retry_safe", False)),
                "side_effect_possible": bool((execution or {}).get("side_effect_possible", True)),
            })
            self._write(state)

    def record_build_report(self, report: dict[str, Any]) -> None:
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                project = report.get("project") if isinstance(report.get("project"), dict) else {}
                state["objective"] = f"Build and verify {_text(project.get('name') or 'project', 500)}"
                state["task_id"] = uuid.uuid4().hex
                state["run_id"] = uuid.uuid4().hex
                _set_lifecycle(state, "running")
            test_result = report.get("test_result")
            build_result = report.get("build_result")
            if isinstance(test_result, dict):
                state["test_results"] = (state["test_results"] + [test_result])[-MAX_RESULTS:]
            if isinstance(build_result, dict):
                state["build_results"] = (state["build_results"] + [build_result])[-MAX_RESULTS:]
            state["last_build_report"] = copy.deepcopy(report)
            status = str(report.get("overall_status", "unknown"))
            _set_lifecycle(state, "completed" if status == "passed" else "failed")
            state["failure"] = None if status == "passed" else _text(report.get("failure") or "Build verification failed")
            state["next_step"] = (
                "Review or publish the verified artifacts."
                if status == "passed"
                else "Fix the failed test/build step, then run verify_build again."
            )
            self._event(state, "build_verification_finished", {"status": status})
            self._write(state)

    def _archive(self, state: dict[str, Any], reason: str) -> None:
        history = self._read_json(self.history_path, [])
        if not isinstance(history, list):
            history = []
        archived = copy.deepcopy(state)
        archived["archived_at"] = utc_now()
        archived["archive_reason"] = reason
        history = (history + [archived])[-100:]
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._write_json_atomic(self.history_path, history)

    @staticmethod
    def _read_json(path: Path, fallback: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fallback

    @staticmethod
    def _write_json_atomic(path: Path, value: Any) -> None:
        temp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _has_task(state: dict[str, Any]) -> bool:
        return bool(
            str(state.get("objective") or "").strip()
            or state.get("steps")
            or str(state.get("current_step") or "").strip()
            or str(state.get("next_step") or "").strip()
            or str(state.get("status") or "idle") != "idle"
        )

    def _record_command_payload(self, state: dict[str, Any], command: str, payload: dict[str, Any], metadata: dict[str, Any] | None = None) -> None:
        metadata = metadata or {}
        role = _text(metadata.get("role") or metadata.get("task_role") or "blocking", 100)
        blocking = bool(metadata.get("blocking", metadata.get("task_blocking", role == "blocking")))
        status = str(payload.get("status", ""))
        session_id = str(payload.get("session_id", ""))
        execution = payload.get("execution") if isinstance(payload.get("execution"), dict) else {}
        current = state.get("current_command")
        if not isinstance(current, dict) or (session_id and current.get("session_id") != session_id):
            current = {
                "command": command,
                "kind": classify_command(command),
                "session_id": session_id,
                "status": status or "running",
                "role": role,
                "blocking": blocking,
                "started_at": utc_now(),
            }
        if execution:
            current["execution_id"] = _text(execution.get("execution_id"), 200)
            current["execution_lifecycle_state"] = _text(execution.get("lifecycle_state"), 100)
            current["retry_safe"] = bool(execution.get("retry_safe", False))
            current["side_effect_possible"] = bool(execution.get("side_effect_possible", True))
            current["execution_started_at"] = _text(execution.get("started_at"), 100)
            current["execution_finished_at"] = _text(execution.get("finished_at"), 100)
            current["pid"] = execution.get("pid")
        current["status"] = status or ("failed" if payload.get("ok") is False else "exited")
        current["exit_code"] = payload.get("exit_code")
        current["elapsed_ms"] = payload.get("elapsed_ms")
        current["role"] = role
        current["blocking"] = blocking
        if current["status"] == "running":
            _set_lifecycle(state, "running")
            state["current_command"] = current
            return
        current["finished_at"] = utc_now()
        kind = str(current.get("kind", classify_command(command)))
        result = {
            "command": command,
            "status": "passed" if payload.get("exit_code") == 0 else "failed",
            "role": role,
            "blocking": blocking,
            "exit_code": payload.get("exit_code"),
            "duration_ms": payload.get("elapsed_ms"),
            "summary": _text(payload.get("summary") or payload.get("stderr") or payload.get("stdout"), 2000),
            "finished_at": current["finished_at"],
            "execution_id": _text(current.get("execution_id"), 200),
            "execution_lifecycle_state": _text(current.get("execution_lifecycle_state"), 100),
            "retry_safe": bool(current.get("retry_safe", False)),
            "side_effect_possible": bool(current.get("side_effect_possible", True)),
        }
        if kind == "test":
            state["test_results"] = (state["test_results"] + [result])[-MAX_RESULTS:]
        elif kind == "build":
            state["build_results"] = (state["build_results"] + [result])[-MAX_RESULTS:]
        state["last_command"] = copy.deepcopy(current)
        state["current_command"] = None
        nonblocking_failure = result["status"] == "failed" and not blocking
        _set_lifecycle(
            state,
            "failed" if result["status"] == "failed" and blocking else "waiting_model",
            wait_reason="" if result["status"] == "failed" and blocking else "model",
        )
        if result["status"] == "passed":
            state["failure"] = None
            last_recovery = state.get("last_recovery") if isinstance(state.get("last_recovery"), dict) else {}
            if str(last_recovery.get("reason") or "") == "follow_up_command":
                state["recovery_attempt"] = 0
                state["last_recovery"] = None
                state["safe_resume_point"] = ""
                state["recommended_next_action"] = ""
        state["current_step"] = "Command failed" if state["status"] == "failed" else "Waiting for model"
        if result["status"] == "failed" and blocking:
            state["failure"] = result["summary"] or f"Command failed with exit code {result['exit_code']}"
        elif nonblocking_failure:
            warning = {
                "command": command,
                "role": role,
                "summary": result["summary"],
                "finished_at": result["finished_at"],
            }
            state["warnings"] = (state.get("warnings", []) + [warning])[-MAX_RESULTS:]
            state["failure"] = None
        self._event(state, "command_finished", {
            "command": _text(command, 500),
            "session_id": _text(current.get("session_id"), 200),
            "kind": kind,
            "status": result["status"],
            "exit_code": result["exit_code"],
            "elapsed_ms": result["duration_ms"],
            "summary": result["summary"],
            "started_at": _text(current.get("started_at"), 100),
            "finished_at": result["finished_at"],
            "role": role,
            "blocking": blocking,
            "execution_id": result["execution_id"],
            "execution_lifecycle_state": result["execution_lifecycle_state"],
            "retry_safe": result["retry_safe"],
            "side_effect_possible": result["side_effect_possible"],
        })

    def _normalize_steps(self, raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list):
            return []
        now = utc_now()
        steps: list[dict[str, Any]] = []
        for index, item in enumerate(raw[:200], start=1):
            if isinstance(item, str):
                item = {"text": item}
            if not isinstance(item, dict):
                continue
            status = str(item.get("status", "pending"))
            if status not in {"pending", "in_progress", "completed", "failed"}:
                status = "pending"
            step_state = str(item.get("state") or "")
            if step_state not in {"created", "ready", "running", "verifying", "completed", "failed", "cancelled", "waiting_model", "waiting_approval", "waiting_user", "recovering"}:
                step_state = {
                    "pending": "ready",
                    "in_progress": "running",
                    "completed": "completed",
                    "failed": "failed",
                }[status]
            step_id = _text(item.get("step_id") or item.get("id") or f"step-{index}", 200)
            title = _text(item.get("title") or item.get("text"), 4000)
            updated_at = _text(item.get("updated_at") or now, 100)
            started_at = _text(item.get("started_at"), 100)
            finished_at = _text(item.get("finished_at"), 100)
            if status == "in_progress" and not started_at:
                started_at = updated_at
            if status in {"completed", "failed"} and not finished_at:
                finished_at = updated_at
            try:
                attempt = max(0, int(item.get("attempt") or 0))
            except (TypeError, ValueError):
                attempt = 0
            try:
                max_attempts = max(1, min(int(item.get("max_attempts") or 1), 20))
            except (TypeError, ValueError):
                max_attempts = 1
            steps.append({
                "id": step_id,
                "step_id": step_id,
                "text": title,
                "title": title,
                "kind": _text(item.get("kind"), 100),
                "status": status,
                "state": step_state,
                "execution_id": _text(item.get("execution_id"), 200),
                "attempt": attempt,
                "max_attempts": max_attempts,
                "started_at": started_at,
                "finished_at": finished_at,
                "last_progress_at": _text(item.get("last_progress_at") or updated_at, 100),
                "retry_safe": bool(item.get("retry_safe", False)),
                "side_effect_possible": bool(item.get("side_effect_possible", False)),
                "verification": copy.deepcopy(item.get("verification")) if item.get("verification") is not None else None,
                "error_class": _text(item.get("error_class"), 100),
                "updated_at": updated_at,
            })
        return steps

    @staticmethod
    def _sync_step_cursor(state: dict[str, Any]) -> None:
        steps = state.get("steps") if isinstance(state.get("steps"), list) else []
        if not steps:
            state["current_step_id"] = _text(state.get("current_step_id"), 200)
            try:
                state["resume_cursor"] = max(0, int(state.get("resume_cursor") or 0))
            except (TypeError, ValueError):
                state["resume_cursor"] = 0
            return
        cursor = len(steps)
        current_id = ""
        for index, step in enumerate(steps):
            status = str(step.get("status") or "pending")
            if status == "in_progress":
                current_id = str(step.get("id") or "")
                cursor = index
                break
            if status != "completed" and cursor == len(steps):
                current_id = str(step.get("id") or "")
                cursor = index
        state["current_step_id"] = _text(current_id, 200)
        state["resume_cursor"] = max(0, cursor)

    def _add_file(self, state: dict[str, Any], path: str, operation: str) -> None:
        existing = {item.get("path"): item for item in state["modified_files"] if isinstance(item, dict)}
        existing[path] = {"path": _text(path, 2000), "operation": _text(operation, 100), "updated_at": utc_now()}
        state["modified_files"] = list(existing.values())[-MAX_FILES:]

    def _event(self, state: dict[str, Any], event: str, details: dict[str, Any]) -> None:
        state["events"] = (state.get("events", []) + [{
            "time": utc_now(),
            "event": event,
            "task_id": state.get("task_id", ""),
            "run_id": state.get("run_id", ""),
            "lifecycle_state": state.get("lifecycle_state", "idle"),
            "details": details,
        }])[-MAX_EVENTS:]

    @staticmethod
    def _event_state_snapshot(state: dict[str, Any]) -> dict[str, Any]:
        current = state.get("current_command") if isinstance(state.get("current_command"), dict) else None
        command = None
        if current:
            command = {
                key: copy.deepcopy(current.get(key))
                for key in ("execution_id", "session_id", "process_id", "pid", "kind", "status", "started_at")
                if current.get(key) not in (None, "")
            }
        last = state.get("last_command") if isinstance(state.get("last_command"), dict) else None
        last_command = None
        if last:
            last_command = {
                key: copy.deepcopy(last.get(key))
                for key in (
                    "execution_id", "session_id", "process_id", "pid", "kind", "status",
                    "exit_code", "elapsed_ms", "execution_lifecycle_state", "retry_safe",
                    "side_effect_possible", "started_at", "finished_at",
                )
                if key in last
            }
        return {
            "version": state.get("version", STATE_VERSION),
            "task_id": state.get("task_id", ""),
            "run_id": state.get("run_id", ""),
            "project_id": state.get("project_id", ""),
            "local_session_id": state.get("local_session_id", ""),
            "status": state.get("status", "idle"),
            "lifecycle_state": state.get("lifecycle_state", "idle"),
            "current_step_id": state.get("current_step_id", ""),
            "current_step": _text(state.get("current_step"), 2000),
            "next_step": _text(state.get("next_step"), 2000),
            "wait_reason": _text(state.get("wait_reason"), 1000),
            "failure": _text(state.get("failure"), 2000),
            "recovery_attempt": int(state.get("recovery_attempt") or 0),
            "safe_resume_point": _text(state.get("safe_resume_point"), 1000),
            "current_command": command,
            "last_command": last_command,
        }

    @staticmethod
    def _canonical_event_type(legacy_event: str, state: dict[str, Any], previous: dict[str, Any]) -> str:
        lifecycle = str(state.get("lifecycle_state") or "idle")
        previous_lifecycle = str(previous.get("lifecycle_state") or "idle")
        command_boundaries = {
            "command_started": "command.started",
            "command_finished": "command.completed",
            "command_terminated": "command.cancelled",
        }
        if legacy_event in command_boundaries:
            return command_boundaries[legacy_event]
        run_changed = bool(state.get("run_id")) and state.get("run_id") != previous.get("run_id")
        if run_changed and lifecycle in ACTIVE_LIFECYCLE_STATES:
            return "task.started"
        if lifecycle != previous_lifecycle:
            transitions = {
                "created": "task.created",
                "planning": "task.planning",
                "ready": "task.ready",
                "preparing": "task.preparing",
                "running": "task.running",
                "recovering": "task.recovering",
                "waiting_model": "task.waiting_model",
                "waiting_approval": "task.waiting_approval",
                "waiting_user": "task.waiting_user",
                "needs_user": "task.needs_user",
                "paused": "task.paused",
                "verifying": "task.verifying",
                "completed": "task.completed",
                "failed": "task.failed",
                "cancelled": "task.cancelled",
            }
            if lifecycle in transitions:
                return transitions[lifecycle]
        aliases = {
            "task_auto_started": "task.started",
            "task_resumed": "task.resumed",
            "task_paused": "task.paused",
            "task_stopped": "task.cancelled",
            "tool_failed": "tool.failed",
            "files_modified": "files.changed",
            "build_verification_finished": "verification.completed",
            "continuous_workflow_started": "workflow.started",
            "continuous_workflow_completed": "task.completed",
            "background_operation_failed": "task.failed",
            "task_auto_recovering": "task.recovering",
            "background_operation_orphaned": "task.recovering",
            "runtime_restart_recovering": "task.recovering",
            "runtime_restart_unsafe_outcome": "task.waiting_model",
        }
        return aliases.get(legacy_event, "task.updated")

    def _load_last_event_id(self) -> int:
        try:
            lines = self.events_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        for line in reversed(lines):
            try:
                payload = json.loads(line)
                return max(0, int(payload.get("event_id", 0)))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
        return 0

    def _read_durable_events(self, after_event_id: int, limit: int) -> list[dict[str, Any]]:
        try:
            lines = self.events_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        result: list[dict[str, Any]] = []
        maximum = max(1, min(int(limit or 200), 1000))
        for line in lines:
            try:
                event = json.loads(line)
                event_id = int(event.get("event_id", 0))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if event_id <= after_event_id:
                continue
            result.append(event)
            if len(result) >= maximum:
                break
        return result

    def _append_durable_event(self, event_type: str, state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        self._event_id += 1
        command = state.get("current_command") if isinstance(state.get("current_command"), dict) else {}
        operation_id = str(payload.get("operation_id") or "")
        execution_id = str(payload.get("execution_id") or command.get("execution_id") or operation_id)
        record = {
            "event_id": self._event_id,
            "type": event_type,
            "timestamp": utc_now(),
            "task_id": str(state.get("task_id") or ""),
            "run_id": str(state.get("run_id") or ""),
            "correlation": {
                "task_id": str(state.get("task_id") or ""),
                "run_id": str(state.get("run_id") or ""),
                "local_session_id": str(state.get("local_session_id") or ""),
                "operation_id": operation_id,
                "execution_id": execution_id,
                "process_id": command.get("process_id") or command.get("pid"),
            },
            "state": self._event_state_snapshot(state),
            "payload": _tool_event_value(payload),
        }
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
        if self._event_id % EVENT_COMPACT_EVERY == 0:
            self._compact_durable_events()
        return record

    def _compact_durable_events(self) -> None:
        try:
            lines = self.events_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        if len(lines) <= MAX_DURABLE_EVENTS:
            return
        kept = lines[-MAX_DURABLE_EVENTS:]
        temp = self.events_path.with_name(f".{self.events_path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            temp.write_text("\n".join(kept) + "\n", encoding="utf-8")
            os.replace(temp, self.events_path)
        finally:
            temp.unlink(missing_ok=True)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return _default_state()
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = _default_state()
            state["failure"] = "The previous task-state file was unreadable and has been reset."
            return state
        state = _default_state()
        if isinstance(parsed, dict):
            state.update(parsed)
        state["version"] = STATE_VERSION
        if isinstance(parsed, dict) and str(parsed.get("lifecycle_state") or "") in LIFECYCLE_STATES:
            lifecycle = str(parsed["lifecycle_state"])
        else:
            lifecycle = STATUS_TO_LIFECYCLE.get(str(state.get("status") or "idle"), "idle")
        _set_lifecycle(state, lifecycle, wait_reason=str(state.get("wait_reason") or ""))
        if self._has_task(state) and not state.get("run_id"):
            state["run_id"] = str(state.get("task_id") or "")
        for key in ("steps", "test_results", "build_results", "modified_files", "events", "warnings"):
            if not isinstance(state.get(key), list):
                state[key] = []
        state["steps"] = self._normalize_steps(state.get("steps"))
        try:
            state["plan_revision"] = max(1, int(state.get("plan_revision") or 1))
        except (TypeError, ValueError):
            state["plan_revision"] = 1
        try:
            state["recovery_attempt"] = max(0, int(state.get("recovery_attempt") or 0))
        except (TypeError, ValueError):
            state["recovery_attempt"] = 0
        self._sync_step_cursor(state)
        if state.get("status") == "active" and not state.get("current_command"):
            try:
                updated = datetime.fromisoformat(str(state.get("updated_at", "")).replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - updated).total_seconds() >= STALE_ACTIVE_SECONDS:
                    _set_lifecycle(state, "waiting_model", wait_reason="model")
                    state["current_step"] = "Waiting for model"
            except ValueError:
                pass
        return state

    def _write(self, state: dict[str, Any]) -> dict[str, Any]:
        with self._condition:
            previous = self._read()
            entered_terminal = (
                str(state.get("lifecycle_state") or "") in TERMINAL_LIFECYCLE_STATES
                and str(previous.get("lifecycle_state") or "") not in TERMINAL_LIFECYCLE_STATES
            )
            state["updated_at"] = utc_now()
            self.state_dir.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(temp, self.path)
            finally:
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass
            latest = state.get("events", [])[-1] if state.get("events") else None
            previous_latest = previous.get("events", [])[-1] if previous.get("events") else None
            if isinstance(latest, dict) and latest != previous_latest:
                legacy_event = str(latest.get("event") or "task_updated")
                self._append_durable_event(
                    self._canonical_event_type(legacy_event, state, previous),
                    state,
                    {"legacy_event": legacy_event, "details": copy.deepcopy(latest.get("details") or {})},
                )
            elif state.get("run_id") and (
                state.get("run_id") != previous.get("run_id")
                or state.get("lifecycle_state") != previous.get("lifecycle_state")
            ):
                self._append_durable_event(
                    self._canonical_event_type("task_updated", state, previous),
                    state,
                    {"legacy_event": "task_updated", "details": {}},
                )
            self._revision += 1
            self._condition.notify_all()
            result = copy.deepcopy(state)
            if entered_terminal and self._terminal_callback is not None:
                try:
                    self._terminal_callback(copy.deepcopy(result))
                    self.last_terminal_callback_error = ""
                except Exception as exc:
                    self.last_terminal_callback_error = _text(f"{type(exc).__name__}: {exc}", 2000)
            return result
