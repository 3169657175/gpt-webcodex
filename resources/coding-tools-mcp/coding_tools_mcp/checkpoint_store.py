from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .project_identity import resolve_project_identity


CHECKPOINT_SCHEMA_VERSION = 2
MAX_CHECKPOINTS = 128
MAX_TEXT = 4_000
MAX_SUMMARY_TEXT = 2_000
MAX_FILES = 200
MAX_DICT_ITEMS = 64
MAX_LIST_ITEMS = 200
CHECKPOINT_ID_RE = re.compile(r"^cp_[a-f0-9]{24}$")
CHECKPOINT_TYPES = frozenset({
    "task_start", "plan_complete", "changes_complete", "test_complete", "build_complete", "manual", "compact", "recovery",
})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _bounded(value: Any, *, depth: int = 0, text_limit: int = MAX_SUMMARY_TEXT) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Path):
        return _text(value, text_limit)
    if isinstance(value, str):
        return _text(value, text_limit)
    if depth >= 4:
        return _text(value, text_limit)
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_DICT_ITEMS]:
            result[_text(key, 120)] = _bounded(item, depth=depth + 1, text_limit=text_limit)
        return result
    if isinstance(value, (list, tuple, set)):
        return [_bounded(item, depth=depth + 1, text_limit=text_limit) for item in list(value)[:MAX_LIST_ITEMS]]
    return _text(value, text_limit)


def _safe_files(items: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if not isinstance(items, (list, tuple)):
        return result
    for item in list(items)[:MAX_FILES]:
        if isinstance(item, dict):
            path = _text(item.get("path"), 1000)
            operation = _text(item.get("operation"), 80)
        else:
            path = _text(item, 1000)
            operation = ""
        if path:
            result.append({"path": path, "operation": operation})
    return result


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class CheckpointStore:
    def __init__(self, workspace: Path, *, project_identity: dict[str, Any] | None = None) -> None:
        self.workspace = workspace.expanduser().resolve(strict=True)
        self.state_dir = self.workspace / ".coding-tools"
        self.root = self.state_dir / "checkpoints"
        self.index_path = self.root / "index.json"
        self.project_identity = copy.deepcopy(project_identity) if project_identity else resolve_project_identity(self.workspace)
        self._lock = threading.RLock()

    def _load_index(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.index_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("items"), list):
                return payload
        except (OSError, ValueError, TypeError):
            pass
        return {"schema_version": CHECKPOINT_SCHEMA_VERSION, "items": []}

    def _write_index(self, items: list[dict[str, Any]]) -> None:
        payload = {
            "schema_version": CHECKPOINT_SCHEMA_VERSION,
            "updated_at": utc_now(),
            "items": items[:MAX_CHECKPOINTS],
        }
        _atomic_write(self.index_path, _json_bytes(payload))

    def _prune_files(self, keep_ids: set[str]) -> None:
        if not self.root.is_dir():
            return
        for path in self.root.glob("cp_*.json"):
            if path.stem not in keep_ids:
                try:
                    path.unlink()
                except OSError:
                    pass

    def _path(self, checkpoint_id: str) -> Path:
        value = str(checkpoint_id or "").strip()
        if not CHECKPOINT_ID_RE.fullmatch(value):
            raise ValueError("Invalid checkpoint_id")
        return self.root / f"{value}.json"

    def create(
        self,
        checkpoint_type: str,
        *,
        task_state: dict[str, Any] | None = None,
        execution_id: str = "",
        project_identity: dict[str, Any] | None = None,
        git: dict[str, Any] | None = None,
        worktree: dict[str, Any] | None = None,
        modified_files: Any = None,
        test_summary: Any = None,
        build_summary: Any = None,
        plan_summary: Any = None,
        current_goal: str = "",
        current_step: str = "",
        next_action: str = "",
        workspace_hint: str | None = None,
        revision: int = 1,
        content_key: str = "",
        local_session_id: str = "",
        continuation: Any = None,
        runtime_identity: Any = None,
        memory_refs: Any = None,
    ) -> dict[str, Any]:
        kind = str(checkpoint_type or "").strip()
        if kind not in CHECKPOINT_TYPES:
            raise ValueError(f"Unsupported checkpoint type: {kind}")
        task = task_state if isinstance(task_state, dict) else {}
        identity = copy.deepcopy(project_identity) if project_identity else copy.deepcopy(self.project_identity)
        checkpoint_id = f"cp_{uuid.uuid4().hex[:24]}"
        current_command = task.get("current_command") if isinstance(task.get("current_command"), dict) else {}
        last_command = task.get("last_command") if isinstance(task.get("last_command"), dict) else {}
        resolved_execution_id = execution_id or current_command.get("execution_id") or last_command.get("execution_id") or ""
        checkpoint = {
            "schema_version": CHECKPOINT_SCHEMA_VERSION,
            "revision": max(1, min(int(revision or 1), 2_147_483_647)),
            "checkpoint_id": checkpoint_id,
            "type": kind,
            "created_at": utc_now(),
            "task_id": _text(task.get("task_id"), 160),
            "run_id": _text(task.get("run_id"), 160),
            "execution_id": _text(resolved_execution_id, 160),
            "local_session_id": _text(local_session_id, 160),
            "project_identity": _bounded(identity),
            "workspace_hint": _text(workspace_hint if workspace_hint is not None else self.workspace, 1000),
            "git": _bounded(git or {}),
            "worktree": _bounded(worktree or {}),
            "modified_files": _safe_files(modified_files if modified_files is not None else task.get("modified_files", [])),
            "test_summary": _bounded(test_summary),
            "build_summary": _bounded(build_summary),
            "plan_summary": _bounded(plan_summary),
            "current_goal": _text(current_goal or task.get("objective"), MAX_TEXT),
            "current_step": _text(current_step or task.get("current_step"), MAX_TEXT),
            "next_action": _text(next_action or task.get("next_step"), MAX_TEXT),
            "content_key": _text(content_key, 128),
            "continuation": _bounded(continuation),
            "runtime_identity": _bounded(runtime_identity),
            "memory_refs": _bounded(memory_refs if isinstance(memory_refs, (list, tuple)) else []),
        }
        data = _json_bytes(checkpoint)
        digest = _sha256(data)
        path = self._path(checkpoint_id)
        with self._lock:
            _atomic_write(path, data)
            index = self._load_index()
            items = [item for item in index.get("items", []) if isinstance(item, dict) and item.get("checkpoint_id") != checkpoint_id]
            items.insert(0, {
                "checkpoint_id": checkpoint_id,
                "type": kind,
                "created_at": checkpoint["created_at"],
                "task_id": checkpoint["task_id"],
                "run_id": checkpoint["run_id"],
                "local_session_id": checkpoint["local_session_id"],
                "project_id": _text(identity.get("project_id") if isinstance(identity, dict) else "", 160),
                "revision": checkpoint["revision"],
                "content_key": checkpoint["content_key"],
                "sha256": digest,
            })
            self._write_index(items)
            self._prune_files({str(item.get("checkpoint_id") or "") for item in items[:MAX_CHECKPOINTS]})
        return copy.deepcopy(checkpoint)

    def get(self, checkpoint_id: str) -> dict[str, Any] | None:
        try:
            path = self._path(checkpoint_id)
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _index_entry(self, checkpoint_id: str) -> dict[str, Any] | None:
        for item in self._load_index().get("items", []):
            if isinstance(item, dict) and item.get("checkpoint_id") == checkpoint_id:
                return item
        return None

    def validate(self, checkpoint: str | dict[str, Any], *, current_project_identity: str | dict[str, Any] | None = None) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        payload = self.get(checkpoint) if isinstance(checkpoint, str) else copy.deepcopy(checkpoint)
        checkpoint_id = str(checkpoint if isinstance(checkpoint, str) else (payload or {}).get("checkpoint_id") or "")
        if not isinstance(payload, dict):
            return {"ok": False, "checkpoint_id": checkpoint_id, "errors": ["checkpoint_missing_or_corrupt"], "warnings": []}

        if int(payload.get("schema_version") or 0) != CHECKPOINT_SCHEMA_VERSION:
            errors.append("schema_version_mismatch")
        if not CHECKPOINT_ID_RE.fullmatch(str(payload.get("checkpoint_id") or "")):
            errors.append("invalid_checkpoint_id")
        if str(payload.get("type") or "") not in CHECKPOINT_TYPES:
            errors.append("invalid_checkpoint_type")
        identity = payload.get("project_identity") if isinstance(payload.get("project_identity"), dict) else {}
        checkpoint_project_id = str(identity.get("project_id") or "")
        if not checkpoint_project_id:
            errors.append("missing_project_id")

        expected_project_id = ""
        if isinstance(current_project_identity, dict):
            expected_project_id = str(current_project_identity.get("project_id") or "")
        elif current_project_identity is not None:
            expected_project_id = str(current_project_identity or "")
        if expected_project_id and checkpoint_project_id != expected_project_id:
            errors.append("project_identity_mismatch")

        entry = self._index_entry(str(payload.get("checkpoint_id") or ""))
        if entry:
            try:
                actual = _sha256(self._path(str(payload.get("checkpoint_id"))).read_bytes())
                if actual != str(entry.get("sha256") or ""):
                    errors.append("checkpoint_digest_mismatch")
            except OSError:
                errors.append("checkpoint_file_missing")
        elif isinstance(checkpoint, str):
            warnings.append("checkpoint_not_indexed")

        return {
            "ok": not errors,
            "checkpoint_id": str(payload.get("checkpoint_id") or checkpoint_id),
            "errors": errors,
            "warnings": warnings,
        }

    def list(
        self,
        *,
        limit: int = 20,
        task_id: str = "",
        run_id: str = "",
        checkpoint_type: str = "",
        local_session_id: str = "",
    ) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit or 20), 100))
        result: list[dict[str, Any]] = []
        with self._lock:
            items = list(self._load_index().get("items", []))
        for entry in items:
            if not isinstance(entry, dict):
                continue
            if task_id and str(entry.get("task_id") or "") != str(task_id):
                continue
            if run_id and str(entry.get("run_id") or "") != str(run_id):
                continue
            if checkpoint_type and str(entry.get("type") or "") != str(checkpoint_type):
                continue
            if local_session_id and str(entry.get("local_session_id") or "") != str(local_session_id):
                continue
            checkpoint_id = str(entry.get("checkpoint_id") or "")
            payload = self.get(checkpoint_id)
            if not payload:
                continue
            valid = self.validate(checkpoint_id)
            if not valid["ok"]:
                continue
            result.append(payload)
            if len(result) >= bounded_limit:
                break
        return result


__all__ = [
    "CHECKPOINT_SCHEMA_VERSION", "CHECKPOINT_TYPES", "CheckpointStore", "utc_now",
]
