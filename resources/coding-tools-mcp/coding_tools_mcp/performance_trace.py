from __future__ import annotations

import copy
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_RECENT = 100
MAX_IDLE_GAP_MS = 30 * 60 * 1000
TRACE_VERSION = 2
TRACE_ORIGINS = frozenset({"external", "desktop", "system", "internal"})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class PerformanceTraceStore:
    """Small workspace-local performance ledger for MCP calls.

    The gap between the previous tool completion and the next tool start is an
    estimate of model/network wait time, not local execution time.
    """

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace.resolve()
        self.state_dir = self.workspace / ".coding-tools"
        self.path = self.state_dir / "performance.json"
        self.session_id = secrets.token_urlsafe(8)
        self.session_started_at = utc_now()
        self._lock = threading.RLock()
        self._last_finished_monotonic: float | None = None
        self._begin_session()

    def record(
        self,
        *,
        tool: str,
        started_monotonic: float,
        finished_monotonic: float,
        request_bytes: int = 0,
        response_bytes: int = 0,
        files_read: int = 0,
        ok: bool = True,
        cache_hit: bool = False,
        deduplicated: bool = False,
        origin: str = "external",
        context_visible: bool | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            normalized_origin = str(origin or "external").strip().lower()
            if normalized_origin not in TRACE_ORIGINS:
                normalized_origin = "external"
            visible = normalized_origin == "external" if context_visible is None else bool(context_visible)
            wait_before_ms = 0
            if visible and self._last_finished_monotonic is not None:
                gap = max(0, int((started_monotonic - self._last_finished_monotonic) * 1000))
                if gap <= MAX_IDLE_GAP_MS:
                    wait_before_ms = gap
            if visible:
                self._last_finished_monotonic = finished_monotonic
            duration_ms = max(0, int((finished_monotonic - started_monotonic) * 1000))
            state = self._read()
            event = {
                "session_id": self.session_id,
                "origin": normalized_origin,
                "context_visible": visible,
                "tool": tool,
                "started_at": utc_now(),
                "finished_at": utc_now(),
                "duration_ms": duration_ms,
                "wait_before_ms": wait_before_ms,
                "request_bytes": max(0, int(request_bytes)),
                "response_bytes": max(0, int(response_bytes)),
                "files_read": max(0, int(files_read)),
                "cache_hit": bool(cache_hit),
                "deduplicated": bool(deduplicated),
                "ok": bool(ok),
            }
            state["observed_events"] += 1
            if visible:
                state["tool_calls"] += 1
                state["errors"] += 0 if ok else 1
                state["cache_hits"] += 1 if cache_hit else 0
                state["deduplicated_calls"] += 1 if deduplicated else 0
                state["local_execution_ms"] += duration_ms
                state["estimated_wait_ms"] += wait_before_ms
                state["request_bytes"] += event["request_bytes"]
                state["response_bytes"] += event["response_bytes"]
                state["files_read"] += event["files_read"]
            else:
                state["internal_events"] += 1
                if normalized_origin == "desktop":
                    state["desktop_calls"] += 1
                elif normalized_origin == "system":
                    state["system_events"] += 1
            state["current_session_id"] = self.session_id
            state["session_started_at"] = self.session_started_at
            state["last_finished_at"] = event["finished_at"]
            state["recent"] = (state.get("recent", []) + [event])[-MAX_RECENT:]
            self._write(state)
            return copy.deepcopy(state)

    def get(self) -> dict[str, Any]:
        with self._lock:
            state = self._read()
            state["current_session_id"] = self.session_id
            state["session_started_at"] = self.session_started_at
            return copy.deepcopy(state)

    def clear(self) -> dict[str, Any]:
        with self._lock:
            self._last_finished_monotonic = None
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                pass
            return self._default()

    def _default(self) -> dict[str, Any]:
        return {
            "version": TRACE_VERSION,
            "tool_calls": 0,
            "observed_events": 0,
            "internal_events": 0,
            "desktop_calls": 0,
            "system_events": 0,
            "errors": 0,
            "cache_hits": 0,
            "deduplicated_calls": 0,
            "local_execution_ms": 0,
            "estimated_wait_ms": 0,
            "request_bytes": 0,
            "response_bytes": 0,
            "files_read": 0,
            "current_session_id": self.session_id,
            "session_started_at": self.session_started_at,
            "last_finished_at": None,
            "recent": [],
            "previous_session": None,
        }

    def _read_raw(self) -> dict[str, Any] | None:
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _begin_session(self) -> None:
        with self._lock:
            previous = self._read_raw()
            state = self._default()
            if previous:
                state["previous_session"] = {
                    "version": int(previous.get("version", 1) or 1),
                    "session_id": previous.get("current_session_id"),
                    "tool_calls": max(0, int(previous.get("tool_calls", 0) or 0)),
                    "response_bytes": max(0, int(previous.get("response_bytes", 0) or 0)),
                    "files_read": max(0, int(previous.get("files_read", 0) or 0)),
                }
            self._write(state)

    def _read(self) -> dict[str, Any]:
        state = self._default()
        parsed = self._read_raw()
        if not parsed:
            return state
        if int(parsed.get("version", 0) or 0) != TRACE_VERSION:
            return state
        if str(parsed.get("current_session_id") or "") != self.session_id:
            return state
        state.update(parsed)
        if not isinstance(state.get("recent"), list):
            state["recent"] = []
        return state

    def _write(self, state: dict[str, Any]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, self.path)
        finally:
            temp.unlink(missing_ok=True)
