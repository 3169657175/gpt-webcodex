from __future__ import annotations

import copy
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


STATE_VERSION = 2
MAX_EVENTS = 100
MAX_DURABLE_EVENTS = 2000
MAX_OPERATION_RECORDS = 64
EVENT_COMPACT_EVERY = 100
MAX_RESULTS = 20
MAX_FILES = 500
MAX_TEXT = 16_000
STALE_ACTIVE_SECONDS = 90
STALE_WAITING_SECONDS = 30 * 60

LIFECYCLE_STATES = frozenset({
    "idle", "created", "preparing", "running", "waiting_model", "needs_user",
    "paused", "completed", "failed", "cancelled",
})
TERMINAL_LIFECYCLE_STATES = frozenset({"completed", "failed", "cancelled"})
LIFECYCLE_TO_STATUS = {
    "idle": "idle",
    "created": "active",
    "preparing": "active",
    "running": "active",
    "waiting_model": "waiting",
    "needs_user": "waiting",
    "paused": "paused",
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
    lifecycle = lifecycle_state if lifecycle_state in LIFECYCLE_STATES else "running"
    state["lifecycle_state"] = lifecycle
    state["status"] = LIFECYCLE_TO_STATUS[lifecycle]
    state["wait_reason"] = _text(wait_reason, 200) if lifecycle in {"waiting_model", "needs_user"} else ""
    if lifecycle in {"completed", "failed", "cancelled"}:
        current = state.get("current_command")
        if isinstance(current, dict):
            finalized = copy.deepcopy(current)
            if str(finalized.get("status") or "") == "running":
                finalized["status"] = {
                    "completed": "completed",
                    "failed": "failed",
                    "cancelled": "cancelled",
                }[lifecycle]
            finalized.setdefault("finished_at", utc_now())
            state["last_command"] = finalized
            state["current_command"] = None


def _default_state() -> dict[str, Any]:
    now = utc_now()
    return {
        "version": STATE_VERSION,
        "task_id": "",
        "run_id": "",
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

    def __init__(self, workspace: Path) -> None:
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

    def upsert_operation(self, record: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            raw = self._read_json(self.operations_path, [])
            records = raw if isinstance(raw, list) else []
            operation_id = str(record.get("operation_id") or "")
            kept = [item for item in records if str(item.get("operation_id") or "") != operation_id]
            stored = copy.deepcopy(record)
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
                if str(item.get("status") or "") != "running":
                    continue
                if str(item.get("runtime_instance_id") or "") == str(runtime_instance_id or ""):
                    continue
                item["status"] = "interrupted"
                item["finished_at"] = now
                item["recovery_reason"] = "MCP runtime restarted before the background operation finished."
                changed.append(copy.deepcopy(item))
            if changed:
                self._write_json_atomic(self.operations_path, records[-MAX_OPERATION_RECORDS:])
            return changed

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
            if "lifecycle_state" in changes:
                _set_lifecycle(state, str(changes["lifecycle_state"]), wait_reason=str(changes.get("wait_reason", "")))
            elif "status" in changes:
                status = _text(changes["status"], 100)
                _set_lifecycle(state, STATUS_TO_LIFECYCLE.get(status, "running"), wait_reason=str(changes.get("wait_reason", "")))
            elif "wait_reason" in changes and state.get("lifecycle_state") in {"waiting_model", "needs_user"}:
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
                        step["updated_at"] = utc_now()
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
            ok = payload.get("ok", True) is not False
            mutating_tools = {"apply_patch", "apply_changes_and_verify", "file_batch", "document_workflow", "document_create", "document_convert"}
            if not self._has_task(state):
                if name in mutating_tools and ok and not args.get("dry_run"):
                    task_id = f"task_{uuid.uuid4().hex[:8]}"
                    state["task_id"] = state.get("task_id") or task_id
                    state["run_id"] = state.get("run_id") or state["task_id"]
                    _set_lifecycle(state, "running")
                    state["objective"] = state.get("objective") or "代码修改与任务执行"
                    state["current_step"] = f"执行 {name}"
                    state["updated_at"] = utc_now()
                    self._event(state, "task_started", {"auto": True, "trigger_tool": name})
                else:
                    return
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
            elif name == "kill_session":
                current = state.get("current_command")
                if isinstance(current, dict) and current.get("session_id") == args.get("session_id"):
                    current["status"] = _text(payload.get("status", "terminated"), 100)
                    current["finished_at"] = utc_now()
                    state["last_command"] = copy.deepcopy(current)
                    state["current_command"] = None
                    self._event(state, "command_terminated", {"session_id": args.get("session_id")})

            if not ok and name not in {"task_state_get", "task_state_update", "task_state_clear"}:
                error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
                state["failure"] = _text(error.get("message") or f"{name} failed")
                self._event(state, "tool_failed", _tool_event_details(name, args, payload))
            elif ok:
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

    def record_command_started(self, command: str, session_id: str, workdir: str) -> None:
        with self._lock:
            state = self._read()
            if not self._has_task(state):
                return
            if str(state.get("lifecycle_state") or "") in TERMINAL_LIFECYCLE_STATES:
                return
            _set_lifecycle(state, "running")
            started_at = utc_now()
            kind = classify_command(command)
            state["current_command"] = {
                "command": _text(command, 4000),
                "kind": kind,
                "session_id": session_id,
                "workdir": _text(workdir, 2000),
                "status": "running",
                "started_at": started_at,
            }
            self._event(state, "command_started", {
                "command": _text(command, 500),
                "session_id": session_id,
                "kind": kind,
                "workdir": _text(workdir, 2000),
                "started_at": started_at,
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
            steps.append({
                "id": _text(item.get("id") or f"step-{index}", 200),
                "text": _text(item.get("text"), 4000),
                "status": status,
                "updated_at": _text(item.get("updated_at") or now, 100),
            })
        return steps

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
        snapshot = copy.deepcopy(state)
        snapshot.pop("events", None)
        return snapshot

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
        if run_changed and lifecycle in {"created", "preparing", "running"}:
            return "task.started"
        if lifecycle != previous_lifecycle:
            transitions = {
                "preparing": "task.preparing",
                "running": "task.running",
                "waiting_model": "task.waiting_model",
                "needs_user": "task.needs_user",
                "paused": "task.paused",
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
            "background_operation_orphaned": "task.failed",
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
        record = {
            "event_id": self._event_id,
            "type": event_type,
            "timestamp": utc_now(),
            "task_id": str(state.get("task_id") or ""),
            "run_id": str(state.get("run_id") or ""),
            "state": self._event_state_snapshot(state),
            "payload": copy.deepcopy(payload),
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
            return copy.deepcopy(state)
