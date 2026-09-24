from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Iterable


INDEX_VERSION = 1
MAX_INDEX_FILE_BYTES = 1_048_576
SKIPPED_DIRS = frozenset({
    ".git", ".hg", ".svn", ".coding-tools", "node_modules", "target", "dist", "build",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "__pycache__",
})
TEXT_SUFFIXES = frozenset({
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt", ".kts",
    ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".php", ".rb", ".swift",
    ".vue", ".svelte", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".sql", ".sh", ".bash",
    ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".xml", ".md", ".mdx", ".txt", ".rst", ".gradle", ".properties",
})
TEXT_NAMES = frozenset({
    "dockerfile", "makefile", "cmakelists.txt", "procfile", "license", "readme", "gemfile", "rakefile",
})
LANGUAGE_BY_SUFFIX = {
    ".py": "python", ".pyi": "python", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".go": "go", ".rs": "rust",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".php": "php", ".rb": "ruby", ".swift": "swift", ".vue": "vue",
    ".svelte": "svelte", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss",
    ".sass": "sass", ".less": "less", ".sql": "sql", ".sh": "shell", ".bash": "shell",
    ".zsh": "shell", ".ps1": "powershell", ".psm1": "powershell", ".bat": "batch", ".cmd": "batch",
    ".json": "json", ".jsonc": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".xml": "xml", ".md": "markdown", ".mdx": "markdown", ".rst": "rst",
}


def _hidden_process_kwargs() -> dict[str, int]:
    if os.name != "nt":
        return {}
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": flag} if flag else {}


def _utc_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _language_for(path: Path) -> str:
    return LANGUAGE_BY_SUFFIX.get(path.suffix.lower(), path.suffix.lower().lstrip(".") or "text")


def _is_text_candidate(path: Path) -> bool:
    name = path.name.lower()
    return path.suffix.lower() in TEXT_SUFFIXES or name in TEXT_NAMES or name.startswith("readme.")


def _safe_decode(data: bytes) -> str | None:
    if b"\x00" in data[:8192]:
        return None
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeError:
            continue
    return None


def _fts_query(text: str) -> str:
    terms = [term.strip() for term in text.replace("\x00", " ").split() if term.strip()]
    return " AND ".join('"' + term.replace('"', '""') + '"' for term in terms[:12])


_CLASS_RE = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)", re.MULTILINE)
_FUNCTION_RE = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^\n)]*)\)",
    re.MULTILINE,
)
_INTERFACE_RE = re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)", re.MULTILINE)
_TYPE_RE = re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=", re.MULTILINE)
_ENUM_RE = re.compile(r"^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)", re.MULTILINE)
_ARROW_RE = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^\n)]*)\)\s*=>",
    re.MULTILINE,
)
_JS_IMPORT_RE = re.compile(r"^\s*import(?:[\s\S]*?\sfrom\s*)?[\"']([^\"']+)[\"']", re.MULTILINE)
_JS_REQUIRE_RE = re.compile(r"\brequire\(\s*[\"']([^\"']+)[\"']\s*\)")
_GO_FUNCTION_RE = re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^\n)]*)\)", re.MULTILINE)
_RUST_ITEM_RE = re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait)\s+([A-Za-z_]\w*)", re.MULTILINE)
_JAVA_TYPE_RE = re.compile(r"^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?(class|interface|enum|record)\s+([A-Za-z_]\w*)", re.MULTILINE)
_INCLUDE_RE = re.compile(r"^\s*#\s*include\s*[<\"]([^>\"]+)[>\"]", re.MULTILINE)


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, max(0, offset)) + 1


def _bounded_signature(value: str, max_chars: int = 240) -> str:
    normalized = " ".join(str(value or "").split())
    return normalized[:max_chars]


def _extract_python_structure(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return [], []
    symbols: list[dict[str, Any]] = []
    imports: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "kind": "class", "line": int(node.lineno), "signature": node.name})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            try:
                args = ast.unparse(node.args)
            except Exception:
                args = ""
            symbols.append({
                "name": node.name,
                "kind": "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function",
                "line": int(node.lineno),
                "signature": _bounded_signature(f"{node.name}({args})"),
            })
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({"target": alias.name, "kind": "import", "line": int(node.lineno)})
        elif isinstance(node, ast.ImportFrom):
            target = ("." * int(node.level)) + str(node.module or "")
            imports.append({"target": target or ".", "kind": "from", "line": int(node.lineno)})
    return symbols, imports


def _extract_regex_structure(text: str, language: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    symbols: list[dict[str, Any]] = []
    imports: list[dict[str, Any]] = []

    def add(pattern: re.Pattern[str], kind: str, *, signature_group: int | None = None) -> None:
        for match in pattern.finditer(text):
            name = match.group(1)
            signature = name
            if signature_group is not None:
                signature = f"{name}({match.group(signature_group)})"
            symbols.append({"name": name, "kind": kind, "line": _line_number(text, match.start()), "signature": _bounded_signature(signature)})

    if language in {"javascript", "typescript", "vue", "svelte"}:
        add(_CLASS_RE, "class")
        add(_FUNCTION_RE, "function", signature_group=2)
        add(_INTERFACE_RE, "interface")
        add(_TYPE_RE, "type")
        add(_ENUM_RE, "enum")
        add(_ARROW_RE, "function", signature_group=2)
        for pattern, kind in ((_JS_IMPORT_RE, "import"), (_JS_REQUIRE_RE, "require")):
            for match in pattern.finditer(text):
                imports.append({"target": match.group(1), "kind": kind, "line": _line_number(text, match.start())})
    elif language == "go":
        add(_GO_FUNCTION_RE, "function", signature_group=2)
    elif language == "rust":
        for match in _RUST_ITEM_RE.finditer(text):
            symbols.append({"name": match.group(2), "kind": match.group(1), "line": _line_number(text, match.start()), "signature": match.group(2)})
    elif language in {"java", "kotlin", "csharp"}:
        for match in _JAVA_TYPE_RE.finditer(text):
            symbols.append({"name": match.group(2), "kind": match.group(1), "line": _line_number(text, match.start()), "signature": match.group(2)})
    elif language in {"c", "cpp"}:
        for match in _INCLUDE_RE.finditer(text):
            imports.append({"target": match.group(1), "kind": "include", "line": _line_number(text, match.start())})
    return symbols, imports


def extract_structure(text: str, language: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if language == "python":
        symbols, imports = _extract_python_structure(text)
    else:
        symbols, imports = _extract_regex_structure(text, language)
    symbols.sort(key=lambda item: (int(item.get("line", 0)), str(item.get("name", ""))))
    imports.sort(key=lambda item: (int(item.get("line", 0)), str(item.get("target", ""))))
    return symbols[:2000], imports[:2000]


class RepoIndex:
    """Rebuildable, workspace-local content index used by Repo Map features.

    The index is cache only. Failure must never prevent normal Runtime startup or
    normal filesystem tools from working.
    """

    def __init__(self, workspace: Path, *, max_file_bytes: int = MAX_INDEX_FILE_BYTES) -> None:
        self.workspace = Path(workspace).expanduser().resolve(strict=True)
        if not self.workspace.is_dir():
            raise ValueError("workspace must be a directory")
        self.max_file_bytes = max(1024, int(max_file_bytes))
        self.index_dir = self.workspace / ".coding-tools" / "index"
        self.db_path = self.index_dir / "index.db"
        self.manifest_path = self.index_dir / "manifest.json"
        self.version_path = self.index_dir / "index-version.json"

    def _connect(self) -> sqlite3.Connection:
        self.index_dir.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path, timeout=10.0)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS files ("
                "path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, size INTEGER NOT NULL, "
                "mtime_ns INTEGER NOT NULL, language TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5("
                "path UNINDEXED, content, tokenize='unicode61')"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS symbols ("
                "path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, signature TEXT NOT NULL)"
            )
            connection.execute("CREATE INDEX IF NOT EXISTS symbols_path_idx ON symbols(path)")
            connection.execute("CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name)")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS imports ("
                "path TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL)"
            )
            connection.execute("CREATE INDEX IF NOT EXISTS imports_path_idx ON imports(path)")
            return connection
        except Exception:
            connection.close()
            raise

    def _load_manifest(self) -> dict[str, dict[str, Any]]:
        try:
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        files = payload.get("files") if isinstance(payload, dict) else None
        return files if isinstance(files, dict) else {}

    def _git_candidates(self) -> list[str] | None:
        git = shutil.which("git")
        if not git or not (self.workspace / ".git").exists():
            return None
        completed = subprocess.run(
            [git, "-C", str(self.workspace), "ls-files", "-co", "--exclude-standard", "-z"],
            capture_output=True,
            text=False,
            timeout=20,
            check=False,
            **_hidden_process_kwargs(),
        )
        if completed.returncode != 0:
            return None
        return [item.decode("utf-8", errors="surrogateescape") for item in completed.stdout.split(b"\x00") if item]

    def _walk_candidates(self) -> Iterable[str]:
        for root, dirs, files in os.walk(self.workspace):
            root_path = Path(root)
            dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
            for name in files:
                path = root_path / name
                try:
                    yield path.relative_to(self.workspace).as_posix()
                except ValueError:
                    continue

    def candidate_paths(self) -> list[str]:
        raw = self._git_candidates()
        if raw is None:
            raw = list(self._walk_candidates())
        result: list[str] = []
        seen: set[str] = set()
        for relative in raw:
            normalized = Path(relative)
            if normalized.is_absolute() or ".." in normalized.parts:
                continue
            if any(part in SKIPPED_DIRS for part in normalized.parts[:-1]):
                continue
            absolute = (self.workspace / normalized).resolve(strict=False)
            try:
                absolute.relative_to(self.workspace)
            except ValueError:
                continue
            if not absolute.is_file() or absolute.is_symlink() or not _is_text_candidate(absolute):
                continue
            try:
                if absolute.stat().st_size > self.max_file_bytes:
                    continue
            except OSError:
                continue
            key = normalized.as_posix()
            if key not in seen:
                seen.add(key)
                result.append(key)
        result.sort(key=str.casefold)
        return result

    def sync(self) -> dict[str, Any]:
        started = time.monotonic()
        try:
            return self._sync_once(started)
        except sqlite3.DatabaseError:
            self._quarantine_corrupt_db()
            return self._sync_once(started, rebuilt=True)

    def sync_safely(self) -> dict[str, Any]:
        try:
            return self.sync()
        except Exception as exc:  # cache failure must not break Runtime
            return {
                "ok": False,
                "status": "unavailable",
                "error": f"{type(exc).__name__}: {exc}",
                "index_dir": str(self.index_dir),
            }

    def _sync_once(self, started: float, rebuilt: bool = False) -> dict[str, Any]:
        previous = {} if rebuilt else self._load_manifest()
        current: dict[str, dict[str, Any]] = {}
        scanned = indexed = updated = skipped = failed = 0
        candidates = self.candidate_paths()
        with closing(self._connect()) as connection:
            for relative in candidates:
                scanned += 1
                absolute = self.workspace / Path(relative)
                try:
                    stat_result = absolute.stat()
                except OSError:
                    failed += 1
                    continue
                old = previous.get(relative) if isinstance(previous.get(relative), dict) else None
                if old and int(old.get("size", -1)) == stat_result.st_size and int(old.get("mtime_ns", -1)) == stat_result.st_mtime_ns:
                    current[relative] = old
                    skipped += 1
                    continue
                try:
                    data = absolute.read_bytes()
                except OSError:
                    failed += 1
                    continue
                text = _safe_decode(data)
                if text is None:
                    failed += 1
                    continue
                digest = hashlib.sha256(data).hexdigest()
                language = _language_for(absolute)
                record = {
                    "hash": digest,
                    "size": stat_result.st_size,
                    "mtime_ns": stat_result.st_mtime_ns,
                    "language": language,
                }
                current[relative] = record
                if old and str(old.get("hash") or "") == digest:
                    skipped += 1
                    continue
                connection.execute(
                    "INSERT INTO files(path, content_hash, size, mtime_ns, language) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, size=excluded.size, "
                    "mtime_ns=excluded.mtime_ns, language=excluded.language",
                    (relative, digest, stat_result.st_size, stat_result.st_mtime_ns, language),
                )
                connection.execute("DELETE FROM files_fts WHERE path = ?", (relative,))
                connection.execute("INSERT INTO files_fts(path, content) VALUES(?,?)", (relative, text))
                connection.execute("DELETE FROM symbols WHERE path = ?", (relative,))
                connection.execute("DELETE FROM imports WHERE path = ?", (relative,))
                symbols, imports = extract_structure(text, language)
                connection.executemany(
                    "INSERT INTO symbols(path, name, kind, line, signature) VALUES(?,?,?,?,?)",
                    [(relative, item["name"], item["kind"], item["line"], item["signature"]) for item in symbols],
                )
                connection.executemany(
                    "INSERT INTO imports(path, target, kind, line) VALUES(?,?,?,?)",
                    [(relative, item["target"], item["kind"], item["line"]) for item in imports],
                )
                if old:
                    updated += 1
                else:
                    indexed += 1
            removed_paths = sorted(set(previous) - set(current))
            for relative in removed_paths:
                connection.execute("DELETE FROM files WHERE path = ?", (relative,))
                connection.execute("DELETE FROM files_fts WHERE path = ?", (relative,))
                connection.execute("DELETE FROM symbols WHERE path = ?", (relative,))
                connection.execute("DELETE FROM imports WHERE path = ?", (relative,))
            connection.commit()

        now = _utc_timestamp()
        manifest = {
            "version": INDEX_VERSION,
            "workspace": str(self.workspace),
            "generated_at": now,
            "files": current,
        }
        _atomic_json(self.manifest_path, manifest)
        _atomic_json(self.version_path, {"version": INDEX_VERSION, "updated_at": now})
        return {
            "ok": True,
            "status": "ready",
            "version": INDEX_VERSION,
            "scanned": scanned,
            "indexed": indexed,
            "updated": updated,
            "skipped": skipped,
            "removed": len(removed_paths),
            "failed": failed,
            "file_count": len(current),
            "rebuilt": rebuilt,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "index_dir": str(self.index_dir),
        }

    def _quarantine_corrupt_db(self) -> None:
        if not self.db_path.exists():
            return
        stamp = int(time.time() * 1000)
        corrupt = self.index_dir / f"index.corrupt-{stamp}.db"
        try:
            os.replace(self.db_path, corrupt)
        except OSError:
            try:
                self.db_path.unlink(missing_ok=True)
            except OSError:
                pass
        for suffix in ("-wal", "-shm"):
            try:
                Path(str(self.db_path) + suffix).unlink(missing_ok=True)
            except OSError:
                pass

    def search(self, query: str, *, limit: int = 12) -> list[dict[str, Any]]:
        expression = _fts_query(str(query or ""))
        if not expression:
            return []
        limit = max(1, min(int(limit), 100))
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT f.path, f.language, f.size, bm25(files_fts) AS score "
                    "FROM files_fts JOIN files f ON f.path = files_fts.path "
                    "WHERE files_fts MATCH ? ORDER BY score LIMIT ?",
                    (expression, limit),
                ).fetchall()
        except sqlite3.DatabaseError:
            return []
        return [
            {
                "path": str(row["path"]),
                "language": str(row["language"]),
                "size": int(row["size"]),
                "score": float(row["score"]),
            }
            for row in rows
        ]

    def important_symbols(self, *, limit: int = 24) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 100))
        kind_weight = "CASE kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'trait' THEN 1 WHEN 'struct' THEN 2 WHEN 'enum' THEN 3 WHEN 'function' THEN 4 WHEN 'async_function' THEN 4 ELSE 9 END"
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    f"SELECT path, name, kind, line, signature FROM symbols ORDER BY {kind_weight}, path, line LIMIT ?",
                    (limit,),
                ).fetchall()
        except sqlite3.DatabaseError:
            return []
        return [dict(row) for row in rows]

    def dependency_hints(self, *, limit: int = 24) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 100))
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT path, target, kind, MIN(line) AS line FROM imports "
                    "GROUP BY path, target, kind ORDER BY path, line LIMIT ?",
                    (limit,),
                ).fetchall()
        except sqlite3.DatabaseError:
            return []
        return [dict(row) for row in rows]

    def relevant_files(self, query: str, *, limit: int = 12) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 50))
        hits = self.search(query, limit=limit)
        if len(hits) >= limit or not str(query or "").strip():
            return hits[:limit]
        needle = f"%{str(query).strip()}%"
        seen = {str(item.get("path")) for item in hits}
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT DISTINCT f.path, f.language, f.size FROM symbols s JOIN files f ON f.path=s.path "
                    "WHERE s.name LIKE ? COLLATE NOCASE ORDER BY f.path LIMIT ?",
                    (needle, limit),
                ).fetchall()
        except sqlite3.DatabaseError:
            return hits[:limit]
        for row in rows:
            path = str(row["path"])
            if path in seen:
                continue
            seen.add(path)
            hits.append({"path": path, "language": str(row["language"]), "size": int(row["size"]), "score": None})
            if len(hits) >= limit:
                break
        return hits[:limit]

    def architecture_map(self, *, limit_files: int = 16) -> dict[str, Any]:
        limit_files = max(1, min(int(limit_files), 50))
        try:
            with closing(self._connect()) as connection:
                language_rows = connection.execute(
                    "SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC, language LIMIT 12"
                ).fetchall()
                totals = connection.execute(
                    "SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM symbols) AS symbols, "
                    "(SELECT COUNT(*) FROM imports) AS imports"
                ).fetchone()
                key_rows = connection.execute(
                    "SELECT f.path, f.language, COUNT(DISTINCT s.rowid) AS symbol_count, COUNT(DISTINCT i.rowid) AS import_count "
                    "FROM files f LEFT JOIN symbols s ON s.path=f.path LEFT JOIN imports i ON i.path=f.path "
                    "GROUP BY f.path, f.language ORDER BY symbol_count DESC, import_count DESC, f.path LIMIT ?",
                    (limit_files,),
                ).fetchall()
        except sqlite3.DatabaseError:
            return {"files": 0, "symbols": 0, "imports": 0, "languages": [], "key_files": []}
        directories: dict[str, int] = {}
        manifest = self._load_manifest()
        for relative in manifest:
            parts = Path(relative).parts
            key = parts[0] if len(parts) > 1 else "."
            directories[key] = directories.get(key, 0) + 1
        return {
            "files": int(totals["files"] if totals else 0),
            "symbols": int(totals["symbols"] if totals else 0),
            "imports": int(totals["imports"] if totals else 0),
            "languages": [{"language": str(row["language"]), "count": int(row["count"])} for row in language_rows],
            "top_directories": [
                {"path": name, "count": count}
                for name, count in sorted(directories.items(), key=lambda item: (-item[1], item[0].casefold()))[:12]
            ],
            "key_files": [
                {
                    "path": str(row["path"]), "language": str(row["language"]),
                    "symbol_count": int(row["symbol_count"]), "import_count": int(row["import_count"]),
                }
                for row in key_rows
            ],
        }

    def status(self) -> dict[str, Any]:
        manifest = self._load_manifest()
        return {
            "version": INDEX_VERSION,
            "ready": self.db_path.is_file() and self.manifest_path.is_file(),
            "file_count": len(manifest),
            "index_dir": str(self.index_dir),
        }
