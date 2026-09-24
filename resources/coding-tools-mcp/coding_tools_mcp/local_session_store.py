from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOCAL_SESSION_SCHEMA_VERSION = 1
MAX_SESSIONS = 128
MAX_IDS = 64
MAX_TEXT = 4000
LOCAL_SESSION_ID_RE = re.compile(r"^ls_[a-f0-9]{24}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass


class LocalSessionStore:
    """Workspace-local durable development-session identity.

    A local session belongs to a project identity, not to a ChatGPT account or
    conversation. It only stores bounded references/summaries and never raw
    command output, diffs, cookies, tokens, or conversation text.
    """

    def __init__(self, workspace: Path, project_identity: dict[str, Any]) -> None:
        self.workspace = workspace.expanduser().resolve(strict=True)
        self.project_identity = copy.deepcopy(project_identity)
        self.project_id = _text(self.project_identity.get("project_id"), 160)
        self.root = self.workspace / ".coding-tools" / "local-sessions"
        self.index_path = self.root / "index.json"
        self.current_path = self.root / "current.json"
        self._lock = threading.RLock()

    def _session_path(self, local_session_id: str) -> Path:
        value = str(local_session_id or "").strip()
        if not LOCAL_SESSION_ID_RE.fullmatch(value):
            raise ValueError("Invalid local_session_id")
        return self.root / f"{value}.json"

    def _read_json(self, path: Path, fallback: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return copy.deepcopy(fallback)

    def _index(self) -> list[dict[str, Any]]:
        payload = self._read_json(self.index_path, {"items": []})
        items = payload.get("items") if isinstance(payload, dict) else []
        return [copy.deepcopy(item) for item in items if isinstance(item, dict)]

    def _write_index(self, items: list[dict[str, Any]]) -> None:
        _atomic_write(self.index_path, {
            "schema_version": LOCAL_SESSION_SCHEMA_VERSION,
            "updated_at": utc_now(),
            "items": items[:MAX_SESSIONS],
        })

    def get(self, local_session_id: str) -> dict[str, Any] | None:
        try:
            payload = self._read_json(self._session_path(local_session_id), None)
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        if int(payload.get("schema_version") or 0) != LOCAL_SESSION_SCHEMA_VERSION:
            return None
        if not LOCAL_SESSION_ID_RE.fullmatch(str(payload.get("local_session_id") or "")):
            return None
        return copy.deepcopy(payload)

    def list(self, *, limit: int = 20, project_id: str = "", status: str = "") -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for entry in self._index():
            if project_id and str(entry.get("project_id") or "") != str(project_id):
                continue
            if status and str(entry.get("status") or "") != str(status):
                continue
            payload = self.get(str(entry.get("local_session_id") or ""))
            if payload is not None:
                result.append(payload)
            if len(result) >= max(1, min(int(limit or 20), 100)):
                break
        return result

    def current(self) -> dict[str, Any] | None:
        pointer = self._read_json(self.current_path, {})
        if not isinstance(pointer, dict):
            return None
        if str(pointer.get("project_id") or "") != self.project_id:
            return None
        return self.get(str(pointer.get("local_session_id") or ""))

    def latest(self, project_id: str | None = None) -> dict[str, Any] | None:
        items = self.list(limit=1, project_id=project_id or self.project_id)
        return items[0] if items else None

    def ensure(self, task_state: dict[str, Any] | None = None, *, objective: str = "") -> dict[str, Any]:
        task = task_state if isinstance(task_state, dict) else {}
        with self._lock:
            session = self.current()
            if session is None or str(session.get("status") or "active") == "closed":
                session = self.latest(self.project_id)
                if session is not None and str(session.get("status") or "active") == "closed":
                    session = None
            if session is None:
                now = utc_now()
                session = {
                    "schema_version": LOCAL_SESSION_SCHEMA_VERSION,
                    "local_session_id": f"ls_{uuid.uuid4().hex[:24]}",
                    "project_id": self.project_id,
                    "project_identity": copy.deepcopy(self.project_identity),
                    "created_at": now,
                    "updated_at": now,
                    "status": "active",
                    "task_ids": [],
                    "run_ids": [],
                    "checkpoint_ids": [],
                    "current_task_id": "",
                    "current_run_id": "",
                    "current_goal": "",
                    "next_action": "",
                    "latest_checkpoint_id": "",
                }
            task_id = _text(task.get("task_id"), 160)
            run_id = _text(task.get("run_id"), 160)
            if task_id and task_id not in session["task_ids"]:
                session["task_ids"] = (session["task_ids"] + [task_id])[-MAX_IDS:]
            if run_id and run_id not in session["run_ids"]:
                session["run_ids"] = (session["run_ids"] + [run_id])[-MAX_IDS:]
            session["current_task_id"] = task_id or _text(session.get("current_task_id"), 160)
            session["current_run_id"] = run_id or _text(session.get("current_run_id"), 160)
            session["current_goal"] = _text(objective or task.get("objective") or session.get("current_goal"))
            session["next_action"] = _text(task.get("next_step") or session.get("next_action"))
            session["updated_at"] = utc_now()
            self._persist(session)
            return copy.deepcopy(session)

    def _persist(self, session: dict[str, Any]) -> None:
        local_session_id = str(session.get("local_session_id") or "")
        _atomic_write(self._session_path(local_session_id), session)
        items = [item for item in self._index() if str(item.get("local_session_id") or "") != local_session_id]
        items.insert(0, {
            "local_session_id": local_session_id,
            "project_id": _text(session.get("project_id"), 160),
            "created_at": _text(session.get("created_at"), 100),
            "updated_at": _text(session.get("updated_at"), 100),
            "status": _text(session.get("status") or "active", 40),
            "current_task_id": _text(session.get("current_task_id"), 160),
            "current_run_id": _text(session.get("current_run_id"), 160),
            "latest_checkpoint_id": _text(session.get("latest_checkpoint_id"), 160),
        })
        self._write_index(items)
        _atomic_write(self.current_path, {
            "schema_version": LOCAL_SESSION_SCHEMA_VERSION,
            "project_id": self.project_id,
            "local_session_id": local_session_id,
            "updated_at": utc_now(),
        })

    def bind_checkpoint(self, local_session_id: str, checkpoint: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            session = self.get(local_session_id)
            if session is None:
                return None
            checkpoint_id = _text(checkpoint.get("checkpoint_id"), 160)
            if checkpoint_id and checkpoint_id not in session["checkpoint_ids"]:
                session["checkpoint_ids"] = (session["checkpoint_ids"] + [checkpoint_id])[-MAX_IDS:]
            session["latest_checkpoint_id"] = checkpoint_id or session.get("latest_checkpoint_id", "")
            session["current_task_id"] = _text(checkpoint.get("task_id") or session.get("current_task_id"), 160)
            session["current_run_id"] = _text(checkpoint.get("run_id") or session.get("current_run_id"), 160)
            session["current_goal"] = _text(checkpoint.get("current_goal") or session.get("current_goal"))
            session["next_action"] = _text(checkpoint.get("next_action") or session.get("next_action"))
            session["updated_at"] = utc_now()
            self._persist(session)
            return copy.deepcopy(session)

    def activate(self, local_session_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self.get(local_session_id)
            if session is None or str(session.get("project_id") or "") != self.project_id:
                return None
            session["status"] = "active"
            session["updated_at"] = utc_now()
            self._persist(session)
            return copy.deepcopy(session)

    def close(self, local_session_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self.get(local_session_id)
            if session is None:
                return None
            session["status"] = "closed"
            session["updated_at"] = utc_now()
            self._persist(session)
            return copy.deepcopy(session)


def build_continuation_brief(
    session: dict[str, Any] | None,
    checkpoint: dict[str, Any] | None,
    *,
    validation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    session = session if isinstance(session, dict) else {}
    checkpoint = checkpoint if isinstance(checkpoint, dict) else {}
    continuation = checkpoint.get("continuation") if isinstance(checkpoint.get("continuation"), dict) else {}
    return {
        "local_session_id": _text(session.get("local_session_id") or checkpoint.get("local_session_id"), 160),
        "checkpoint_id": _text(checkpoint.get("checkpoint_id"), 160),
        "goal": _text(continuation.get("goal") or checkpoint.get("current_goal")),
        "decisions": list(continuation.get("decisions", []))[:20] if isinstance(continuation.get("decisions"), list) else [],
        "constraints": list(continuation.get("constraints", []))[:20] if isinstance(continuation.get("constraints"), list) else [],
        "completed": list(continuation.get("completed", []))[:30] if isinstance(continuation.get("completed"), list) else [],
        "pending": list(continuation.get("pending", []))[:30] if isinstance(continuation.get("pending"), list) else [],
        "next_action": _text(continuation.get("next_action") or checkpoint.get("next_action")),
        "modified_files": list(checkpoint.get("modified_files", []))[:50] if isinstance(checkpoint.get("modified_files"), list) else [],
        "test_summary": copy.deepcopy(checkpoint.get("test_summary")),
        "build_summary": copy.deepcopy(checkpoint.get("build_summary")),
        "errors": list(continuation.get("errors", []))[:10] if isinstance(continuation.get("errors"), list) else [],
        "memory_refs": list(checkpoint.get("memory_refs", []))[:20] if isinstance(checkpoint.get("memory_refs"), list) else [],
        "validation": copy.deepcopy(validation or {}),
    }


__all__ = [
    "LOCAL_SESSION_SCHEMA_VERSION", "LOCAL_SESSION_ID_RE", "LocalSessionStore", "build_continuation_brief", "utc_now",
]
