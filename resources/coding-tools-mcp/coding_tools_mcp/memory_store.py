from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MEMORY_SCHEMA_VERSION = 1
DEFAULT_MEMORY_PROFILE = "local-default"
MEMORY_SCOPES = frozenset({"global", "project", "task"})
MEMORY_TYPES = frozenset({
    "core_preference", "working_style", "project_summary", "architecture",
    "decision", "open_loop", "pitfall", "task_summary", "note",
})
AUTO_MEMORY_MODES = frozenset({"off", "suggest", "auto"})
MAX_TITLE = 300
MAX_CONTENT_BYTES = 128 * 1024
MAX_RESULTS = 200
BOOTSTRAP_MAX_ITEMS = 8
BOOTSTRAP_MAX_CONTENT_BYTES = 12 * 1024
BOOTSTRAP_MAX_ITEM_BYTES = 2400
BOOTSTRAP_GLOBAL_TYPES = frozenset({"core_preference", "working_style"})
BOOTSTRAP_PROJECT_TYPES = frozenset({"project_summary", "architecture", "decision", "open_loop", "pitfall"})
SEARCH_MAX_ITEMS = 8
SEARCH_MAX_CONTENT_BYTES = 16 * 1024
SEARCH_MAX_ITEM_BYTES = 4 * 1024
SEARCH_TYPE_WEIGHT = {
    "project_summary": 24, "architecture": 22, "core_preference": 20, "working_style": 18,
    "decision": 18, "pitfall": 16, "open_loop": 15, "task_summary": 10, "note": 4,
}
_META_PREFIX = "<!-- GPT-WEBCODEX-MEMORY-META "
_META_SUFFIX = " -->"
_ID_RE = re.compile(r"^mem_[a-f0-9]{24}$")
_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def default_memory_root() -> Path:
    base = str(os.environ.get("LOCALAPPDATA") or "").strip()
    if not base:
        base = str(Path.home() / "AppData" / "Local")
    return Path(base).expanduser() / "GPT-WebCodex" / "memory-v1"


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_id(value: Any, *, field: str, required: bool = False) -> str:
    text = str(value or "").strip()[:200]
    if required and not text:
        raise ValueError(f"{field} is required")
    if any(ch in text for ch in ("/", "\\", "\0")) or text in {".", ".."}:
        raise ValueError(f"invalid {field}")
    return text


class MemoryStore:
    """Machine-independent local memory whose Markdown files are the source of truth.

    M0 is explicit CRUD only. It does not observe or auto-extract ChatGPT messages.
    """

    def __init__(self, memory_root: Path | None = None, *, profile: str = DEFAULT_MEMORY_PROFILE) -> None:
        self.root = (Path(memory_root) if memory_root is not None else default_memory_root()).expanduser().resolve(strict=False)
        self.profile = str(profile or DEFAULT_MEMORY_PROFILE).strip()
        if not _PROFILE_RE.fullmatch(self.profile):
            raise ValueError("invalid memory profile")
        self.db_path = self.root / "memory.db"
        self.config_path = self.root / "config.json"
        self.system_dir = self.root / "system"
        self.projects_dir = self.root / "projects"
        self.tasks_dir = self.root / "tasks"
        self.archive_dir = self.root / "archive"
        self.events_dir = self.root / "events"
        self.snapshots_dir = self.root / "snapshots"
        self.candidates_dir = self.root / "candidates"
        self._lock = threading.RLock()
        self._ensure_layout()
        self._ensure_database()

    def _ensure_layout(self) -> None:
        for directory in (self.root, self.system_dir, self.projects_dir, self.tasks_dir, self.archive_dir, self.events_dir, self.snapshots_dir, self.candidates_dir):
            directory.mkdir(parents=True, exist_ok=True)
        if not self.config_path.exists():
            _atomic_write(self.config_path, (json.dumps({
                "schema_version": MEMORY_SCHEMA_VERSION,
                "profile": self.profile,
                "auto_memory": "off",
            }, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"))

    def config(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            payload = {}
        mode = str(payload.get("auto_memory") or "off").strip().lower()
        if mode not in AUTO_MEMORY_MODES:
            mode = "off"
        return {"schema_version": MEMORY_SCHEMA_VERSION, "profile": self.profile, "auto_memory": mode}

    def set_auto_memory(self, mode: str) -> dict[str, Any]:
        normalized = str(mode or "").strip().lower()
        if normalized not in AUTO_MEMORY_MODES:
            raise ValueError("auto_memory must be one of: off, suggest, auto")
        payload = {"schema_version": MEMORY_SCHEMA_VERSION, "profile": self.profile, "auto_memory": normalized}
        _atomic_write(self.config_path, (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"))
        return payload

    def _create_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS memory_meta(
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memories(
                memory_id TEXT PRIMARY KEY,
                profile TEXT NOT NULL,
                scope TEXT NOT NULL,
                memory_type TEXT NOT NULL,
                title TEXT NOT NULL,
                source TEXT NOT NULL,
                project_id TEXT NOT NULL DEFAULT '',
                task_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_verified_at TEXT NOT NULL DEFAULT '',
                confidence REAL NOT NULL DEFAULT 1.0,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 1,
                file_path TEXT NOT NULL,
                content_sha256 TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(profile,scope,archived,updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(profile,project_id,archived,updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(profile,task_id,archived,updated_at DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                memory_id UNINDEXED, profile UNINDEXED, title, content, tokenize='unicode61'
            );
        """)
        connection.execute(
            "INSERT OR REPLACE INTO memory_meta(key,value) VALUES('schema_version',?)",
            (str(MEMORY_SCHEMA_VERSION),),
        )
        connection.commit()

    def _ensure_fts_index(self) -> None:
        with closing(sqlite3.connect(self.db_path)) as connection:
            expected = int(connection.execute("SELECT COUNT(*) FROM memories WHERE profile=? AND archived=0", (self.profile,)).fetchone()[0])
            actual = int(connection.execute("SELECT COUNT(*) FROM memory_fts WHERE profile=?", (self.profile,)).fetchone()[0])
            if expected == actual:
                return
            connection.execute("DELETE FROM memory_fts WHERE profile=?", (self.profile,))
            rows = connection.execute("SELECT memory_id,file_path FROM memories WHERE profile=? AND archived=0", (self.profile,)).fetchall()
            for memory_id, file_path in rows:
                try:
                    record = self._parse(self.root / str(file_path))
                except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                    continue
                connection.execute(
                    "INSERT INTO memory_fts(memory_id,profile,title,content) VALUES(?,?,?,?)",
                    (memory_id, self.profile, str(record.get("title") or ""), str(record.get("content") or "")),
                )
            connection.commit()

    def _ensure_database(self) -> None:
        with self._lock:
            if self.db_path.exists():
                try:
                    with closing(sqlite3.connect(self.db_path)) as connection:
                        row = connection.execute("PRAGMA quick_check").fetchone()
                        if not row or row[0] != "ok":
                            raise sqlite3.DatabaseError("memory.db quick_check failed")
                        self._create_schema(connection)
                    self._ensure_fts_index()
                    return
                except sqlite3.DatabaseError:
                    quarantine = self.root / f"memory.db.corrupt-{utc_now().replace(':', '').replace('-', '')}"
                    try:
                        shutil.move(str(self.db_path), str(quarantine))
                    except OSError:
                        self.db_path.unlink(missing_ok=True)
            with closing(sqlite3.connect(self.db_path)) as connection:
                self._create_schema(connection)
            self._ensure_fts_index()

    def _directory_for(self, scope: str, project_id: str, task_id: str, *, archived: bool = False) -> Path:
        if archived:
            if scope == "global":
                return self.archive_dir / "global"
            if scope == "project":
                return self.archive_dir / "projects" / project_id
            return self.archive_dir / "tasks" / task_id
        if scope == "global":
            return self.system_dir
        if scope == "project":
            return self.projects_dir / project_id
        return self.tasks_dir / task_id

    def _normalize(self, *, scope: Any, memory_type: Any, title: Any, content: Any,
                   project_id: Any = "", task_id: Any = "", source: Any = "explicit_user",
                   confidence: Any = 1.0, pinned: Any = False) -> dict[str, Any]:
        normalized_scope = str(scope or "").strip().lower()
        if normalized_scope not in MEMORY_SCOPES:
            raise ValueError("invalid memory scope")
        normalized_type = str(memory_type or "note").strip().lower()
        if normalized_type not in MEMORY_TYPES:
            raise ValueError("invalid memory type")
        normalized_project = _safe_id(project_id, field="project_id", required=normalized_scope == "project")
        normalized_task = _safe_id(task_id, field="task_id", required=normalized_scope == "task")
        text_title = str(title or "").strip()[:MAX_TITLE]
        if not text_title:
            raise ValueError("title is required")
        text_content = str(content or "")
        if len(text_content.encode("utf-8")) > MAX_CONTENT_BYTES:
            raise ValueError("memory content exceeds byte budget")
        try:
            score = max(0.0, min(float(confidence), 1.0))
        except (TypeError, ValueError):
            score = 1.0
        return {
            "scope": normalized_scope,
            "memory_type": normalized_type,
            "title": text_title,
            "content": text_content,
            "project_id": normalized_project,
            "task_id": normalized_task,
            "source": str(source or "explicit_user").strip()[:120],
            "confidence": score,
            "pinned": bool(pinned),
        }

    def _render(self, record: dict[str, Any]) -> bytes:
        meta = {key: record.get(key, "") for key in (
            "memory_id", "profile", "scope", "memory_type", "title", "source", "project_id", "task_id",
            "created_at", "updated_at", "last_verified_at", "confidence", "pinned", "archived", "revision", "supersedes",
        )}
        header = _META_PREFIX + json.dumps(meta, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + _META_SUFFIX
        return (header + "\n\n# " + record["title"] + "\n\n" + record["content"] + "\n").encode("utf-8")

    def _parse(self, path: Path) -> dict[str, Any]:
        raw = path.read_bytes()
        if len(raw) > MAX_CONTENT_BYTES + 32 * 1024:
            raise ValueError("memory file exceeds byte budget")
        text = raw.decode("utf-8")
        first, _, rest = text.partition("\n")
        if not first.startswith(_META_PREFIX) or not first.endswith(_META_SUFFIX):
            raise ValueError("missing memory metadata")
        meta = json.loads(first[len(_META_PREFIX):-len(_META_SUFFIX)])
        if not isinstance(meta, dict) or not _ID_RE.fullmatch(str(meta.get("memory_id") or "")):
            raise ValueError("invalid memory metadata")
        meta.setdefault("supersedes", "")
        body = rest
        title_prefix = f"\n# {meta.get('title','')}\n\n"
        if body.startswith(title_prefix):
            content = body[len(title_prefix):]
        else:
            marker = "\n\n"
            content = body.split(marker, 1)[1] if marker in body else body
        if content.endswith("\n"):
            content = content[:-1]
        return {**meta, "content": content, "file_path": str(path.relative_to(self.root)).replace("\\", "/"), "content_sha256": _sha256(raw)}

    def _index_record(self, record: dict[str, Any]) -> None:
        with closing(sqlite3.connect(self.db_path)) as connection:
            connection.execute("""
                INSERT INTO memories(memory_id,profile,scope,memory_type,title,source,project_id,task_id,created_at,updated_at,last_verified_at,confidence,pinned,archived,revision,file_path,content_sha256)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(memory_id) DO UPDATE SET
                    profile=excluded.profile,scope=excluded.scope,memory_type=excluded.memory_type,title=excluded.title,
                    source=excluded.source,project_id=excluded.project_id,task_id=excluded.task_id,updated_at=excluded.updated_at,
                    last_verified_at=excluded.last_verified_at,confidence=excluded.confidence,pinned=excluded.pinned,
                    archived=excluded.archived,revision=excluded.revision,file_path=excluded.file_path,content_sha256=excluded.content_sha256
            """, (
                record["memory_id"], record["profile"], record["scope"], record["memory_type"], record["title"],
                record["source"], record.get("project_id", ""), record.get("task_id", ""), record["created_at"], record["updated_at"],
                record.get("last_verified_at", ""), float(record.get("confidence", 1.0)), int(bool(record.get("pinned"))),
                int(bool(record.get("archived"))), int(record.get("revision", 1)), record["file_path"], record["content_sha256"],
            ))
            connection.execute("DELETE FROM memory_fts WHERE memory_id=?", (record["memory_id"],))
            if not bool(record.get("archived")):
                connection.execute(
                    "INSERT INTO memory_fts(memory_id,profile,title,content) VALUES(?,?,?,?)",
                    (record["memory_id"], record["profile"], record["title"], str(record.get("content") or "")),
                )
            connection.commit()

    def create(self, *, scope: str, memory_type: str = "note", title: str, content: str,
               project_id: str = "", task_id: str = "", source: str = "explicit_user",
               confidence: float = 1.0, pinned: bool = False) -> dict[str, Any]:
        values = self._normalize(scope=scope, memory_type=memory_type, title=title, content=content,
                                 project_id=project_id, task_id=task_id, source=source, confidence=confidence, pinned=pinned)
        now = utc_now()
        record = {
            "memory_id": f"mem_{uuid.uuid4().hex[:24]}", "profile": self.profile, **values,
            "created_at": now, "updated_at": now, "last_verified_at": "", "archived": False, "revision": 1, "supersedes": "",
        }
        directory = self._directory_for(record["scope"], record["project_id"], record["task_id"])
        path = directory / f"{record['memory_id']}.md"
        data = self._render(record)
        _atomic_write(path, data)
        record["file_path"] = str(path.relative_to(self.root)).replace("\\", "/")
        record["content_sha256"] = _sha256(data)
        self._index_record(record)
        return dict(record)

    def get(self, memory_id: str) -> dict[str, Any] | None:
        if not _ID_RE.fullmatch(str(memory_id or "")):
            return None
        with closing(sqlite3.connect(self.db_path)) as connection:
            row = connection.execute("SELECT file_path FROM memories WHERE memory_id=? AND profile=?", (memory_id, self.profile)).fetchone()
        if not row:
            return None
        path = self.root / str(row[0])
        try:
            record = self._parse(path)
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
            return None
        return record if record.get("profile") == self.profile else None

    def list(self, *, scope: str = "", project_id: str = "", task_id: str = "", archived: bool | None = False, limit: int = 50) -> list[dict[str, Any]]:
        clauses = ["profile=?"]
        params: list[Any] = [self.profile]
        if scope:
            if scope not in MEMORY_SCOPES:
                raise ValueError("invalid memory scope")
            clauses.append("scope=?"); params.append(scope)
        if project_id:
            clauses.append("project_id=?"); params.append(str(project_id)[:200])
        if task_id:
            clauses.append("task_id=?"); params.append(str(task_id)[:200])
        if archived is not None:
            clauses.append("archived=?"); params.append(int(bool(archived)))
        bounded = max(1, min(int(limit), MAX_RESULTS))
        sql = "SELECT memory_id FROM memories WHERE " + " AND ".join(clauses) + " ORDER BY pinned DESC, updated_at DESC LIMIT ?"
        params.append(bounded)
        with closing(sqlite3.connect(self.db_path)) as connection:
            ids = [row[0] for row in connection.execute(sql, params).fetchall()]
        return [item for item in (self.get(memory_id) for memory_id in ids) if item is not None]

    @staticmethod
    def _bounded_utf8(value: Any, limit: int) -> str:
        data = str(value or "").encode("utf-8", errors="replace")
        if len(data) <= limit:
            return data.decode("utf-8", errors="replace")
        return data[:max(0, int(limit))].decode("utf-8", errors="ignore")

    def build_bootstrap(self, project_id: str = "", *, max_items: int = BOOTSTRAP_MAX_ITEMS, max_content_bytes: int = BOOTSTRAP_MAX_CONTENT_BYTES) -> dict[str, Any]:
        """Return a compact read-only memory view for the model's first workspace call."""
        project_key = str(project_id or "")[:200]
        bounded_items = max(1, min(int(max_items), BOOTSTRAP_MAX_ITEMS))
        bounded_bytes = max(512, min(int(max_content_bytes), BOOTSTRAP_MAX_CONTENT_BYTES))
        candidates: list[dict[str, Any]] = []
        candidates.extend(item for item in self.list(scope="global", limit=32) if item.get("memory_type") in BOOTSTRAP_GLOBAL_TYPES)
        if project_key:
            candidates.extend(item for item in self.list(scope="project", project_id=project_key, limit=64) if item.get("memory_type") in BOOTSTRAP_PROJECT_TYPES)

        result: list[dict[str, Any]] = []
        used = 0
        for item in candidates:
            if len(result) >= bounded_items or used >= bounded_bytes:
                break
            remaining = min(BOOTSTRAP_MAX_ITEM_BYTES, bounded_bytes - used)
            if remaining <= 0:
                break
            content = self._bounded_utf8(item.get("content"), remaining)
            content_bytes = len(content.encode("utf-8"))
            if not content and item.get("content"):
                continue
            used += content_bytes
            result.append({
                "memory_id": str(item.get("memory_id") or ""),
                "scope": str(item.get("scope") or ""),
                "memory_type": str(item.get("memory_type") or ""),
                "title": self._bounded_utf8(item.get("title"), 300),
                "content": content,
                "pinned": bool(item.get("pinned")),
                "confidence": float(item.get("confidence", 1.0) or 0.0),
                "revision": int(item.get("revision", 1) or 1),
                "updated_at": str(item.get("updated_at") or ""),
            })
        return {
            "status": "ready",
            "profile": self.profile,
            "project_id": project_key,
            "items": result,
            "count": len(result),
            "content_bytes": used,
            "truncated": len(result) < len(candidates),
            "source_of_truth": "local_markdown",
            "auto_memory": "off",
        }

    @staticmethod
    def _fts_query(value: str) -> str:
        terms = [part for part in re.findall(r"[\w\u3400-\u9fff]+", str(value or ""), flags=re.UNICODE) if part]
        return " OR ".join('"' + term.replace('"', '""') + '"' for term in terms[:16])

    @staticmethod
    def _fallback_terms(value: str) -> list[str]:
        """Return bounded LIKE fragments for CJK queries that unicode61 does not segment well."""
        result: list[str] = []
        for token in re.findall(r"[\u3400-\u9fff]+|[A-Za-z0-9_]+", str(value or ""), flags=re.UNICODE):
            if re.search(r"[\u3400-\u9fff]", token):
                if len(token) <= 4:
                    candidates = [token]
                else:
                    candidates = []
                    for size in (4, 3, 2):
                        candidates.extend(token[index:index + size] for index in range(0, len(token) - size + 1))
            else:
                candidates = [token] if len(token) >= 3 else []
            for candidate in candidates:
                if candidate and candidate not in result:
                    result.append(candidate)
                if len(result) >= 12:
                    return result
        return result

    def search(self, query: str, *, project_id: str = "", task_id: str = "", include_global: bool = True, limit: int = SEARCH_MAX_ITEMS) -> list[dict[str, Any]]:
        text = str(query or "").strip()[:1000]
        if not text:
            return []
        project_key = str(project_id or "")[:200]
        task_key = str(task_id or "")[:200]
        scope_parts: list[str] = []
        scope_params: list[Any] = []
        if include_global:
            scope_parts.append("m.scope='global'")
        if project_key:
            scope_parts.append("(m.scope='project' AND m.project_id=?)")
            scope_params.append(project_key)
        if task_key:
            scope_parts.append("(m.scope='task' AND m.task_id=?)")
            scope_params.append(task_key)
        if not scope_parts:
            return []
        scope_sql = "(" + " OR ".join(scope_parts) + ")"
        fetch_limit = min(64, max(12, int(limit) * 8))
        ids: list[str] = []
        fts_query = self._fts_query(text)
        with closing(sqlite3.connect(self.db_path)) as connection:
            if fts_query:
                try:
                    rows = connection.execute(
                        "SELECT m.memory_id FROM memory_fts JOIN memories m ON m.memory_id=memory_fts.memory_id "
                        "WHERE memory_fts MATCH ? AND m.profile=? AND m.archived=0 AND " + scope_sql +
                        " ORDER BY bm25(memory_fts) LIMIT ?",
                        [fts_query, self.profile, *scope_params, fetch_limit],
                    ).fetchall()
                    ids = [str(row[0]) for row in rows]
                except sqlite3.OperationalError:
                    ids = []
            if not ids:
                fallback_terms = self._fallback_terms(text) or [text]
                like_clauses = ["(memory_fts.title LIKE ? OR memory_fts.content LIKE ?)"] * len(fallback_terms)
                like_params: list[Any] = []
                for term in fallback_terms:
                    like = f"%{term}%"
                    like_params.extend([like, like])
                rows = connection.execute(
                    "SELECT DISTINCT m.memory_id FROM memory_fts JOIN memories m ON m.memory_id=memory_fts.memory_id "
                    "WHERE m.profile=? AND m.archived=0 AND " + scope_sql +
                    " AND (" + " OR ".join(like_clauses) + ") "
                    "ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?",
                    [self.profile, *scope_params, *like_params, fetch_limit],
                ).fetchall()
                ids = [str(row[0]) for row in rows]

        ranked: list[tuple[float, str, dict[str, Any]]] = []
        for position, memory_id in enumerate(ids):
            item = self.get(memory_id)
            if item is None:
                continue
            scope = str(item.get("scope") or "")
            scope_weight = 32 if scope == "project" else 26 if scope == "task" else 14
            score = float(100 - min(position, 99)) + scope_weight + SEARCH_TYPE_WEIGHT.get(str(item.get("memory_type") or ""), 0)
            score += 50 if item.get("pinned") else 0
            score += float(item.get("confidence", 1.0) or 0.0) * 10
            ranked.append((score, str(item.get("updated_at") or ""), item))
        ranked.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)

        result: list[dict[str, Any]] = []
        used = 0
        bounded_limit = max(1, min(int(limit), SEARCH_MAX_ITEMS))
        for score, _updated, item in ranked:
            if len(result) >= bounded_limit or used >= SEARCH_MAX_CONTENT_BYTES:
                break
            remaining = min(SEARCH_MAX_ITEM_BYTES, SEARCH_MAX_CONTENT_BYTES - used)
            content = self._bounded_utf8(item.get("content"), remaining)
            content_bytes = len(content.encode("utf-8"))
            used += content_bytes
            result.append({
                "memory_id": str(item.get("memory_id") or ""), "scope": str(item.get("scope") or ""),
                "memory_type": str(item.get("memory_type") or ""), "title": self._bounded_utf8(item.get("title"), 300),
                "content": content, "pinned": bool(item.get("pinned")), "confidence": float(item.get("confidence", 1.0) or 0.0),
                "updated_at": str(item.get("updated_at") or ""), "score": round(score, 3),
            })
        return result

    def _snapshot_revision(self, current: dict[str, Any]) -> Path | None:
        memory_id = str(current.get("memory_id") or "")
        if not _ID_RE.fullmatch(memory_id):
            return None
        source = self.root / str(current.get("file_path") or "")
        if not source.is_file():
            return None
        revision = max(1, int(current.get("revision", 1) or 1))
        target = self.snapshots_dir / memory_id / f"rev-{revision:06d}.md"
        if not target.exists():
            _atomic_write(target, source.read_bytes())
        return target

    def revision_history(self, memory_id: str) -> list[dict[str, Any]]:
        if not _ID_RE.fullmatch(str(memory_id or "")):
            return []
        result: list[dict[str, Any]] = []
        for path in sorted((self.snapshots_dir / memory_id).glob("rev-*.md")):
            try:
                result.append(self._parse(path))
            except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                continue
        return result

    def restore_revision(self, memory_id: str, revision: int) -> dict[str, Any]:
        current = self.get(memory_id)
        if current is None:
            raise KeyError(memory_id)
        wanted = max(1, int(revision))
        path = self.snapshots_dir / memory_id / f"rev-{wanted:06d}.md"
        if not path.is_file():
            raise KeyError(f"{memory_id}@{wanted}")
        previous = self._parse(path)
        return self.update(
            memory_id,
            memory_type=str(previous.get("memory_type") or current.get("memory_type") or "note"),
            title=str(previous.get("title") or current.get("title") or "Restored memory"),
            content=str(previous.get("content") or ""),
            source="revision_restore",
            confidence=float(previous.get("confidence", current.get("confidence", 1.0)) or 0.0),
            pinned=bool(previous.get("pinned", current.get("pinned", False))),
        )

    def update(self, memory_id: str, **changes: Any) -> dict[str, Any]:
        current = self.get(memory_id)
        if current is None:
            raise KeyError(memory_id)
        values = self._normalize(
            scope=current["scope"], memory_type=changes.get("memory_type", current["memory_type"]),
            title=changes.get("title", current["title"]), content=changes.get("content", current["content"]),
            project_id=current.get("project_id", ""), task_id=current.get("task_id", ""),
            source=changes.get("source", current.get("source", "explicit_user")),
            confidence=changes.get("confidence", current.get("confidence", 1.0)),
            pinned=changes.get("pinned", current.get("pinned", False)),
        )
        self._snapshot_revision(current)
        previous_revision = int(current.get("revision", 1) or 1)
        record = {
            **current, **values, "updated_at": utc_now(), "revision": previous_revision + 1,
            "supersedes": f"{memory_id}@{previous_revision}",
        }
        path = self.root / current["file_path"]
        data = self._render(record)
        _atomic_write(path, data)
        record["content_sha256"] = _sha256(data)
        self._index_record(record)
        return dict(record)

    def archive(self, memory_id: str) -> dict[str, Any]:
        current = self.get(memory_id)
        if current is None:
            raise KeyError(memory_id)
        if current.get("archived"):
            return current
        self._snapshot_revision(current)
        old_path = self.root / current["file_path"]
        previous_revision = int(current.get("revision", 1) or 1)
        record = {
            **current, "archived": True, "updated_at": utc_now(), "revision": previous_revision + 1,
            "supersedes": f"{memory_id}@{previous_revision}",
        }
        new_dir = self._directory_for(record["scope"], record.get("project_id", ""), record.get("task_id", ""), archived=True)
        new_path = new_dir / f"{memory_id}.md"
        data = self._render(record)
        _atomic_write(new_path, data)
        if old_path != new_path:
            old_path.unlink(missing_ok=True)
        record["file_path"] = str(new_path.relative_to(self.root)).replace("\\", "/")
        record["content_sha256"] = _sha256(data)
        self._index_record(record)
        return dict(record)

    def delete(self, memory_id: str) -> bool:
        current = self.get(memory_id)
        if current is None:
            return False
        try:
            (self.root / current["file_path"]).unlink(missing_ok=True)
        finally:
            with closing(sqlite3.connect(self.db_path)) as connection:
                connection.execute("DELETE FROM memories WHERE memory_id=? AND profile=?", (memory_id, self.profile))
                connection.execute("DELETE FROM memory_fts WHERE memory_id=?", (memory_id,))
                connection.commit()
        return True

    def rebuild_index(self) -> dict[str, int]:
        with self._lock:
            if self.db_path.exists():
                self.db_path.unlink()
            with closing(sqlite3.connect(self.db_path)) as connection:
                self._create_schema(connection)
            imported = 0
            skipped = 0
            roots = (self.system_dir, self.projects_dir, self.tasks_dir, self.archive_dir)
            for base in roots:
                if not base.is_dir():
                    continue
                for path in sorted(base.rglob("mem_*.md")):
                    try:
                        record = self._parse(path)
                        if record.get("profile") != self.profile:
                            skipped += 1
                            continue
                        self._index_record(record)
                        imported += 1
                    except (OSError, ValueError, UnicodeError, json.JSONDecodeError, sqlite3.Error):
                        skipped += 1
            return {"imported": imported, "skipped": skipped}
