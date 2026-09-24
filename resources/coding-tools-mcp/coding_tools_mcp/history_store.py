from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HISTORY_SCHEMA_VERSION = 2
MAX_TEXT = 4000
MAX_SUMMARY = 2000
MAX_FILES = 200
MAX_RESULTS = 20
MAX_EXECUTIONS = 64
MAX_CONTINUATION_ITEMS = 50
MAX_EVIDENCE_STEPS = 20


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _stable_history_id(task_id: str, run_id: str, fallback: str = "") -> str:
    identity = f"{task_id}\0{run_id}" if task_id or run_id else fallback
    return "hist_" + hashlib.sha256(identity.encode("utf-8", errors="replace")).hexdigest()[:24]


def _safe_files(value: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if not isinstance(value, list):
        return result
    for item in value[:MAX_FILES]:
        if isinstance(item, dict):
            path = _text(item.get("path"), 1000)
            operation = _text(item.get("operation"), 80)
        else:
            path = _text(item, 1000)
            operation = ""
        if path:
            result.append({"path": path, "operation": operation})
    return result


def _safe_result(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {
        "status": _text(value.get("status"), 80),
        "command": _text(value.get("command"), 500),
        "summary": _text(value.get("summary"), MAX_SUMMARY),
        "duration_ms": max(0, int(value.get("duration_ms") or 0)),
        "exit_code": value.get("exit_code") if isinstance(value.get("exit_code"), int) else None,
    }


def _safe_results(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    for item in value[-MAX_RESULTS:]:
        safe = _safe_result(item)
        if safe is not None:
            result.append(safe)
    return result


def _safe_execution_ids(value: Any) -> list[str]:
    result: list[str] = []
    if not isinstance(value, list):
        return result
    for item in value[-MAX_EXECUTIONS:]:
        if isinstance(item, dict):
            execution_id = _text(item.get("execution_id") or item.get("operation_id"), 160)
        else:
            execution_id = _text(item, 160)
        if execution_id and execution_id not in result:
            result.append(execution_id)
    return result


def _safe_continuation(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    def strings(key: str) -> list[str]:
        raw = item.get(key)
        return [_text(entry, 500) for entry in raw[:MAX_CONTINUATION_ITEMS]] if isinstance(raw, list) else []
    return {
        "goal": _text(item.get("goal"), MAX_SUMMARY),
        "decisions": strings("decisions"),
        "constraints": strings("constraints"),
        "completed": strings("completed"),
        "pending": strings("pending"),
        "next_action": _text(item.get("next_action"), MAX_SUMMARY),
        "errors": strings("errors")[:10],
    }


def _safe_session_evidence(value: Any) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    tests = item.get("tests") if isinstance(item.get("tests"), dict) else {}
    builds = item.get("builds") if isinstance(item.get("builds"), dict) else {}
    git = item.get("git") if isinstance(item.get("git"), dict) else {}
    worktree = item.get("worktree") if isinstance(item.get("worktree"), dict) else {}
    unfinished = item.get("unfinished_steps") if isinstance(item.get("unfinished_steps"), list) else []
    return {
        "verdict": _text(item.get("verdict"), 80),
        "objective": _text(item.get("objective"), MAX_SUMMARY),
        "summary": _text(item.get("summary"), MAX_SUMMARY),
        "modified_files": _safe_files(item.get("modified_files"))[:50],
        "tests": {
            "count": max(0, int(tests.get("count") or 0)),
            "passed": max(0, int(tests.get("passed") or 0)),
            "failed": max(0, int(tests.get("failed") or 0)),
            "latest": _safe_result(tests.get("latest")),
        },
        "builds": {
            "count": max(0, int(builds.get("count") or 0)),
            "passed": max(0, int(builds.get("passed") or 0)),
            "failed": max(0, int(builds.get("failed") or 0)),
            "latest": _safe_result(builds.get("latest")),
        },
        "unfinished_steps": [_text(step, 500) for step in unfinished[:MAX_EVIDENCE_STEPS]],
        "local_session_id": _text(item.get("local_session_id"), 160),
        "checkpoint_id": _text(item.get("checkpoint_id"), 160),
        "git": {
            "branch": _text(git.get("branch"), 300),
            "head": _text(git.get("head"), 160),
            "base_commit": _text(git.get("base_commit"), 160),
            "snapshot_commit": _text(git.get("snapshot_commit"), 160),
            "dirty": bool(git.get("dirty", False)),
            "snapshot_dirty": bool(git.get("snapshot_dirty", False)),
            "snapshot_changed_count": max(0, int(git.get("snapshot_changed_count") or 0)),
        },
        "worktree": {
            "exists": bool(worktree.get("exists", False)),
            "clean": bool(worktree.get("clean", False)),
            "status": _text(worktree.get("status"), 100),
            "branch": _text(worktree.get("branch"), 300),
            "primary_index_untouched": bool(worktree.get("primary_index_untouched", False)),
        },
        "failure": _text(item.get("failure"), MAX_SUMMARY),
    }


def _normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    task_id = _text(record.get("task_id"), 160)
    run_id = _text(record.get("run_id") or task_id, 160)
    fallback = json.dumps({
        "objective": _text(record.get("objective"), 500),
        "created_at": _text(record.get("created_at"), 80),
        "archived_at": _text(record.get("archived_at"), 80),
    }, ensure_ascii=False, sort_keys=True)
    tests = _safe_results(record.get("test_results"))
    builds = _safe_results(record.get("build_results"))
    modified_files = _safe_files(record.get("modified_files"))
    continuation = _safe_continuation(record.get("continuation_brief") or record.get("continuation"))
    session_evidence = _safe_session_evidence(record.get("session_evidence"))
    failure = _text(record.get("failure"), MAX_SUMMARY)
    summary = _text(record.get("summary"), MAX_SUMMARY)
    if not summary:
        parts = []
        if modified_files:
            parts.append(f"modified {len(modified_files)} files")
        if tests:
            parts.append(f"tests {tests[-1].get('status') or 'recorded'}")
        if builds:
            parts.append(f"build {builds[-1].get('status') or 'recorded'}")
        if failure:
            parts.append(failure)
        summary = _text("; ".join(parts), MAX_SUMMARY)
    return {
        "history_id": _stable_history_id(task_id, run_id, fallback),
        "task_id": task_id,
        "run_id": run_id,
        "local_session_id": _text(record.get("local_session_id"), 160),
        "project_id": _text(record.get("project_id"), 160),
        "objective": _text(record.get("objective"), MAX_TEXT),
        "summary": summary,
        "status": _text(record.get("status") or record.get("lifecycle_state"), 80),
        "created_at": _text(record.get("created_at"), 80),
        "updated_at": _text(record.get("updated_at") or record.get("archived_at") or utc_now(), 80),
        "finished_at": _text(record.get("finished_at") or record.get("archived_at"), 80),
        "modified_files": modified_files,
        "execution_ids": _safe_execution_ids(record.get("executions") or record.get("operations") or []),
        "test_results": tests,
        "build_results": builds,
        "failure": failure,
        "checkpoint_id": _text(record.get("checkpoint_id") or record.get("latest_checkpoint_id"), 160),
        "branch": _text(record.get("branch"), 300),
        "version": _text(record.get("version"), 100),
        "favorite": bool(record.get("favorite", False)),
        "continuation_brief": continuation,
        "session_evidence": session_evidence,
        "archive_reason": _text(record.get("archive_reason"), 300),
    }


def _search_text(record: dict[str, Any]) -> str:
    files = " ".join(item.get("path", "") for item in record.get("modified_files", []))
    tests = " ".join(f"{item.get('command','')} {item.get('summary','')}" for item in record.get("test_results", []))
    builds = " ".join(f"{item.get('command','')} {item.get('summary','')}" for item in record.get("build_results", []))
    continuation = record.get("continuation_brief") if isinstance(record.get("continuation_brief"), dict) else {}
    evidence = record.get("session_evidence") if isinstance(record.get("session_evidence"), dict) else {}
    continuation_text = " ".join([
        _text(continuation.get("goal"), MAX_SUMMARY),
        _text(continuation.get("next_action"), MAX_SUMMARY),
        " ".join(_text(item, 500) for item in continuation.get("completed", []) if isinstance(item, str)),
        " ".join(_text(item, 500) for item in continuation.get("pending", []) if isinstance(item, str)),
        " ".join(_text(item, 500) for item in continuation.get("errors", []) if isinstance(item, str)),
    ])
    return "\n".join(filter(None, [
        record.get("objective", ""), record.get("summary", ""), files, record.get("failure", ""),
        tests, builds, record.get("branch", ""), record.get("version", ""), record.get("checkpoint_id", ""),
        record.get("local_session_id", ""), continuation_text,
        _text(evidence.get("verdict"), 80),
        " ".join(_text(item, 500) for item in evidence.get("unfinished_steps", []) if isinstance(item, str)),
    ]))[:32000]


class HistoryStore:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace.expanduser().resolve(strict=True)
        self.root = self.workspace / ".coding-tools" / "history"
        self.path = self.root / "history.db"
        self.legacy_path = self.workspace / ".coding-tools" / "task-history.json"
        self._lock = threading.RLock()
        self._ensure_ready()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history(
                history_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '',
                local_session_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
                objective TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '',
                modified_files_json TEXT NOT NULL DEFAULT '[]', execution_ids_json TEXT NOT NULL DEFAULT '[]',
                test_results_json TEXT NOT NULL DEFAULT '[]', build_results_json TEXT NOT NULL DEFAULT '[]',
                failure TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
                version TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
                continuation_json TEXT NOT NULL DEFAULT '{}', session_evidence_json TEXT NOT NULL DEFAULT '{}', archive_reason TEXT NOT NULL DEFAULT '',
                search_text TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_history_task ON history(task_id);
            CREATE INDEX IF NOT EXISTS idx_history_run ON history(run_id);
            CREATE INDEX IF NOT EXISTS idx_history_session ON history(local_session_id);
            CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id);
            CREATE INDEX IF NOT EXISTS idx_history_updated ON history(updated_at DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(history_id UNINDEXED, search_text, tokenize='unicode61');
        """)
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(history)").fetchall()}
        if "session_evidence_json" not in columns:
            connection.execute("ALTER TABLE history ADD COLUMN session_evidence_json TEXT NOT NULL DEFAULT '{}'")
        connection.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)", (str(HISTORY_SCHEMA_VERSION),))
        connection.commit()

    def _is_healthy(self) -> bool:
        if not self.path.exists():
            return True
        try:
            connection = self._connect()
            try:
                row = connection.execute("PRAGMA quick_check").fetchone()
                return bool(row and str(row[0]).lower() == "ok")
            finally:
                connection.close()
        except sqlite3.DatabaseError:
            return False

    def _quarantine(self) -> None:
        if not self.path.exists():
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = self.root / f"history.db.corrupt-{stamp}"
        counter = 1
        while target.exists():
            target = self.root / f"history.db.corrupt-{stamp}-{counter}"
            counter += 1
        shutil.move(str(self.path), str(target))
        for suffix in ("-wal", "-shm"):
            Path(str(self.path) + suffix).unlink(missing_ok=True)

    def _ensure_ready(self) -> None:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            if not self._is_healthy():
                self._quarantine()
            connection = self._connect()
            try:
                self._initialize(connection)
            except sqlite3.DatabaseError:
                connection.close()
                self._quarantine()
                connection = self._connect()
                self._initialize(connection)
            finally:
                connection.close()

    def upsert(self, record: dict[str, Any]) -> dict[str, Any]:
        normalized = _normalize_record(copy.deepcopy(record))
        with self._lock:
            self._ensure_ready()
            connection = self._connect()
            try:
                values = (
                    normalized["history_id"], normalized["task_id"], normalized["run_id"], normalized["local_session_id"], normalized["project_id"],
                    normalized["objective"], normalized["summary"], normalized["status"], normalized["created_at"], normalized["updated_at"], normalized["finished_at"],
                    json.dumps(normalized["modified_files"], ensure_ascii=False), json.dumps(normalized["execution_ids"], ensure_ascii=False),
                    json.dumps(normalized["test_results"], ensure_ascii=False), json.dumps(normalized["build_results"], ensure_ascii=False),
                    normalized["failure"], normalized["checkpoint_id"], normalized["branch"], normalized["version"], int(normalized["favorite"]),
                    json.dumps(normalized["continuation_brief"], ensure_ascii=False), json.dumps(normalized["session_evidence"], ensure_ascii=False),
                    normalized["archive_reason"], _search_text(normalized),
                )
                connection.execute("""
                    INSERT INTO history(history_id,task_id,run_id,local_session_id,project_id,objective,summary,status,created_at,updated_at,finished_at,
                        modified_files_json,execution_ids_json,test_results_json,build_results_json,failure,checkpoint_id,branch,version,favorite,continuation_json,session_evidence_json,archive_reason,search_text)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(history_id) DO UPDATE SET
                        task_id=excluded.task_id,run_id=excluded.run_id,local_session_id=excluded.local_session_id,project_id=excluded.project_id,
                        objective=excluded.objective,summary=excluded.summary,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at,
                        finished_at=excluded.finished_at,modified_files_json=excluded.modified_files_json,execution_ids_json=excluded.execution_ids_json,
                        test_results_json=excluded.test_results_json,build_results_json=excluded.build_results_json,failure=excluded.failure,
                        checkpoint_id=excluded.checkpoint_id,branch=excluded.branch,version=excluded.version,favorite=excluded.favorite,
                        continuation_json=excluded.continuation_json,session_evidence_json=excluded.session_evidence_json,
                        archive_reason=excluded.archive_reason,search_text=excluded.search_text
                """, values)
                connection.execute("DELETE FROM history_fts WHERE history_id=?", (normalized["history_id"],))
                connection.execute("INSERT INTO history_fts(history_id,search_text) VALUES(?,?)", (normalized["history_id"], _search_text(normalized)))
                connection.commit()
            finally:
                connection.close()
        return copy.deepcopy(normalized)

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        def load(name: str, fallback: Any) -> Any:
            try:
                return json.loads(row[name])
            except (ValueError, TypeError):
                return copy.deepcopy(fallback)
        return {
            "history_id": row["history_id"], "task_id": row["task_id"], "run_id": row["run_id"],
            "local_session_id": row["local_session_id"], "project_id": row["project_id"], "objective": row["objective"],
            "summary": row["summary"], "status": row["status"], "created_at": row["created_at"], "updated_at": row["updated_at"],
            "finished_at": row["finished_at"], "modified_files": load("modified_files_json", []), "execution_ids": load("execution_ids_json", []),
            "test_results": load("test_results_json", []), "build_results": load("build_results_json", []), "failure": row["failure"],
            "checkpoint_id": row["checkpoint_id"], "branch": row["branch"], "version": row["version"], "favorite": bool(row["favorite"]),
            "continuation_brief": load("continuation_json", {}), "session_evidence": load("session_evidence_json", {}),
            "archive_reason": row["archive_reason"],
        }

    def get(self, history_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_ready()
            connection = self._connect()
            try:
                row = connection.execute("SELECT * FROM history WHERE history_id=?", (_text(history_id, 160),)).fetchone()
                return self._decode(row) if row else None
            finally:
                connection.close()

    def list(self, *, limit: int = 20, project_id: str = "", local_session_id: str = "", favorite: bool | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        if project_id:
            clauses.append("project_id=?"); values.append(_text(project_id, 160))
        if local_session_id:
            clauses.append("local_session_id=?"); values.append(_text(local_session_id, 160))
        if favorite is not None:
            clauses.append("favorite=?"); values.append(1 if favorite else 0)
        sql = "SELECT * FROM history" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY updated_at DESC, history_id DESC LIMIT ?"
        values.append(max(1, min(int(limit or 20), 100)))
        with self._lock:
            self._ensure_ready()
            connection = self._connect()
            try:
                return [self._decode(row) for row in connection.execute(sql, values).fetchall()]
            finally:
                connection.close()

    def search(self, query: str, *, limit: int = 20, project_id: str = "", local_session_id: str = "") -> list[dict[str, Any]]:
        text = str(query or "").strip()
        if not text:
            return self.list(limit=limit, project_id=project_id, local_session_id=local_session_id)
        bounded_limit = max(1, min(int(limit or 20), 100))
        where = ["history_fts MATCH ?"]
        values: list[Any] = [text]
        if project_id:
            where.append("h.project_id=?"); values.append(_text(project_id, 160))
        if local_session_id:
            where.append("h.local_session_id=?"); values.append(_text(local_session_id, 160))
        values.append(bounded_limit)
        sql = """
            SELECT h.*, bm25(history_fts) AS rank
            FROM history_fts JOIN history h ON h.history_id=history_fts.history_id
            WHERE %s
            ORDER BY rank ASC, h.updated_at DESC, h.history_id DESC LIMIT ?
        """ % " AND ".join(where)
        with self._lock:
            self._ensure_ready()
            connection = self._connect()
            try:
                rows: list[sqlite3.Row] = []
                try:
                    rows = connection.execute(sql, values).fetchall()
                except sqlite3.OperationalError:
                    escaped_values = list(values)
                    escaped_values[0] = '"' + text.replace('"', '""') + '"'
                    try:
                        rows = connection.execute(sql, escaped_values).fetchall()
                    except sqlite3.OperationalError:
                        rows = []
                if rows:
                    return [self._decode(row) for row in rows]
                # unicode61 does not provide useful substring matching for many CJK queries.
                # Fall back to a bounded LIKE search over the already-redacted search_text column.
                like_where = ["search_text LIKE ?"]
                like_values: list[Any] = [f"%{text[:1000]}%"]
                if project_id:
                    like_where.append("project_id=?"); like_values.append(_text(project_id, 160))
                if local_session_id:
                    like_where.append("local_session_id=?"); like_values.append(_text(local_session_id, 160))
                like_values.append(bounded_limit)
                like_sql = "SELECT * FROM history WHERE " + " AND ".join(like_where) + " ORDER BY updated_at DESC, history_id DESC LIMIT ?"
                return [self._decode(row) for row in connection.execute(like_sql, like_values).fetchall()]
            finally:
                connection.close()

    def import_legacy_json(self, path: Path | None = None) -> dict[str, int]:
        source = path or self.legacy_path
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {"seen": 0, "imported": 0}
        items = payload if isinstance(payload, list) else []
        imported = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            self.upsert(item)
            imported += 1
        return {"seen": len(items), "imported": imported}

    def rebuild(self) -> dict[str, int]:
        with self._lock:
            if self.path.exists():
                self.path.unlink()
            Path(str(self.path) + "-wal").unlink(missing_ok=True)
            Path(str(self.path) + "-shm").unlink(missing_ok=True)
            self._ensure_ready()
        return self.import_legacy_json()


__all__ = ["HISTORY_SCHEMA_VERSION", "HistoryStore", "utc_now"]
