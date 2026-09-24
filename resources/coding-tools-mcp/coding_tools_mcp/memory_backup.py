from __future__ import annotations

import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .memory_store import MemoryStore, _atomic_write
from .memory_write import inspect_memory_safety, MemoryWriteError


BACKUP_SCHEMA_VERSION = 1
MAX_BACKUP_FILES = 4096
MAX_BACKUP_FILE_BYTES = 512 * 1024
MAX_BACKUP_TOTAL_BYTES = 128 * 1024 * 1024
_ALLOWED_TOP_LEVEL = {"config.json", "manifest.json", "system", "projects", "tasks", "archive", "snapshots"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_member(name: str) -> PurePosixPath:
    raw = str(name or "").replace("\\", "/")
    path = PurePosixPath(raw)
    if not raw or raw.startswith("/") or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise MemoryWriteError("INVALID_BACKUP_ENTRY", f"Unsafe backup path: {raw}")
    if path.parts[0] not in _ALLOWED_TOP_LEVEL:
        raise MemoryWriteError("INVALID_BACKUP_ENTRY", f"Unsupported backup path: {raw}")
    return path


class MemoryBackupService:
    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self.exports_dir = store.root / "exports"
        self.exports_dir.mkdir(parents=True, exist_ok=True)

    def _memory_files(self) -> list[Path]:
        files: list[Path] = []
        for base in (self.store.system_dir, self.store.projects_dir, self.store.tasks_dir, self.store.archive_dir, self.store.snapshots_dir):
            if base.is_dir():
                files.extend(path for path in base.rglob("*.md") if path.is_file())
        return sorted(files)

    def export_zip(self, target: str | Path | None = None) -> dict[str, Any]:
        if target is None or not str(target).strip():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            destination = self.exports_dir / f"gpt-webcodex-memory-{stamp}.zip"
        else:
            destination = Path(target).expanduser().resolve(strict=False)
            if destination.suffix.lower() != ".zip":
                destination = destination.with_suffix(".zip")
        destination.parent.mkdir(parents=True, exist_ok=True)
        warnings: list[str] = []
        included: list[tuple[Path, str]] = []
        total = 0
        for path in self._memory_files():
            try:
                if path.stat().st_size > MAX_BACKUP_FILE_BYTES:
                    warnings.append(f"skipped oversized memory file: {path.name}")
                    continue
                record = self.store._parse(path)
                safety = inspect_memory_safety(record.get("title"), record.get("content"), allow_sensitive_personal=True)
                if not safety["allowed"]:
                    warnings.append(f"skipped secret-bearing memory: {record.get('memory_id')}")
                    continue
                relative = path.relative_to(self.store.root).as_posix()
                total += path.stat().st_size
                if total > MAX_BACKUP_TOTAL_BYTES or len(included) >= MAX_BACKUP_FILES:
                    raise MemoryWriteError("BACKUP_TOO_LARGE", "Memory backup exceeds file or byte budget.")
                included.append((path, relative))
            except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                warnings.append(f"skipped unreadable memory file: {path.name}")
        config = self.store.config()
        manifest = {
            "schema_version": BACKUP_SCHEMA_VERSION,
            "exported_at": utc_now(),
            "profile": self.store.profile,
            "file_count": len(included),
            "source_of_truth": "local_markdown",
            "excluded": ["memory.db", "candidates", "runtime_token", "mcp_token", "chatgpt_cookie"],
        }
        fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent))
        os.close(fd)
        try:
            with zipfile.ZipFile(temp_name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
                archive.writestr("config.json", json.dumps(config, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
                for path, relative in included:
                    archive.write(path, relative)
            os.replace(temp_name, destination)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
        return {"ok": True, "path": str(destination), "file_count": len(included), "warnings": warnings[:100]}

    def import_zip(self, source: str | Path, *, apply_config: bool = False) -> dict[str, Any]:
        archive_path = Path(source).expanduser().resolve(strict=True)
        if archive_path.suffix.lower() != ".zip":
            raise MemoryWriteError("INVALID_BACKUP", "Memory import requires a .zip backup.")
        if archive_path.stat().st_size > MAX_BACKUP_TOTAL_BYTES:
            raise MemoryWriteError("BACKUP_TOO_LARGE", "Backup archive exceeds byte budget.")
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_BACKUP_FILES + 2:
                raise MemoryWriteError("BACKUP_TOO_LARGE", "Backup contains too many files.")
            total = 0
            for info in infos:
                _safe_member(info.filename)
                if info.is_dir():
                    continue
                if info.file_size > MAX_BACKUP_FILE_BYTES:
                    raise MemoryWriteError("BACKUP_TOO_LARGE", f"Backup entry is too large: {info.filename}")
                total += int(info.file_size)
                if total > MAX_BACKUP_TOTAL_BYTES:
                    raise MemoryWriteError("BACKUP_TOO_LARGE", "Backup uncompressed size exceeds byte budget.")
            manifest = json.loads(archive.read("manifest.json").decode("utf-8")) if "manifest.json" in archive.namelist() else {}
            if int(manifest.get("schema_version") or 0) != BACKUP_SCHEMA_VERSION:
                raise MemoryWriteError("UNSUPPORTED_BACKUP", "Unsupported memory backup schema version.")
            with tempfile.TemporaryDirectory(prefix="gpt-webcodex-memory-import-") as temp:
                stage = Path(temp) / "memory"
                stage.mkdir(parents=True, exist_ok=True)
                for info in infos:
                    member = _safe_member(info.filename)
                    if info.is_dir() or member.name == "manifest.json":
                        continue
                    target = stage.joinpath(*member.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write(target, archive.read(info))
                staged = MemoryStore(stage, profile=self.store.profile)
                imported = 0
                skipped = 0
                warnings: list[str] = []
                imported_ids: set[str] = set()
                for base in (staged.system_dir, staged.projects_dir, staged.tasks_dir, staged.archive_dir):
                    if not base.is_dir():
                        continue
                    for path in sorted(base.rglob("mem_*.md")):
                        try:
                            record = staged._parse(path)
                            safety = inspect_memory_safety(record.get("title"), record.get("content"), allow_sensitive_personal=True)
                            if not safety["allowed"]:
                                warnings.append(f"skipped secret-bearing memory: {record.get('memory_id')}")
                                skipped += 1
                                continue
                            existing = self.store.get(str(record.get("memory_id") or ""))
                            if existing is not None:
                                if existing.get("content") == record.get("content") and existing.get("title") == record.get("title"):
                                    imported_ids.add(str(existing["memory_id"])); skipped += 1; continue
                                created = self.store.create(
                                    scope=str(record.get("scope") or "global"), memory_type=str(record.get("memory_type") or "note"),
                                    title=str(record.get("title") or "Imported memory"), content=str(record.get("content") or ""),
                                    project_id=str(record.get("project_id") or ""), task_id=str(record.get("task_id") or ""),
                                    source="import", confidence=float(record.get("confidence", 1.0) or 0.0), pinned=bool(record.get("pinned")),
                                )
                                imported_ids.add(str(created["memory_id"])); imported += 1; continue
                            target_dir = self.store._directory_for(
                                str(record.get("scope") or "global"), str(record.get("project_id") or ""), str(record.get("task_id") or ""),
                                archived=bool(record.get("archived")),
                            )
                            target = target_dir / f"{record['memory_id']}.md"
                            _atomic_write(target, path.read_bytes())
                            imported_ids.add(str(record["memory_id"])); imported += 1
                        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                            skipped += 1
                for memory_id in imported_ids:
                    source_dir = staged.snapshots_dir / memory_id
                    if not source_dir.is_dir():
                        continue
                    target_dir = self.store.snapshots_dir / memory_id
                    target_dir.mkdir(parents=True, exist_ok=True)
                    for snapshot in source_dir.glob("rev-*.md"):
                        try:
                            snapshot_record = staged._parse(snapshot)
                            snapshot_safety = inspect_memory_safety(
                                snapshot_record.get("title"), snapshot_record.get("content"), allow_sensitive_personal=True
                            )
                            if not snapshot_safety["allowed"]:
                                warnings.append(f"skipped secret-bearing revision: {memory_id}/{snapshot.name}")
                                continue
                        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                            warnings.append(f"skipped unreadable revision: {memory_id}/{snapshot.name}")
                            continue
                        target = target_dir / snapshot.name
                        if not target.exists():
                            _atomic_write(target, snapshot.read_bytes())
                self.store.rebuild_index()
                if apply_config and (stage / "config.json").is_file():
                    try:
                        config = json.loads((stage / "config.json").read_text(encoding="utf-8"))
                        self.store.set_auto_memory(str(config.get("auto_memory") or "off"))
                    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                        warnings.append("backup config was not applied")
                return {"ok": True, "imported": imported, "skipped": skipped, "warnings": warnings[:100]}
