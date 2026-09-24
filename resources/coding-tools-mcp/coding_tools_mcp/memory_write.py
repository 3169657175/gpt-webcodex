from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import unicodedata
import uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .memory_store import MemoryStore


CANDIDATE_SCHEMA_VERSION = 1
CANDIDATE_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_PENDING_CANDIDATES = 128
_CANDIDATE_ID_RE = re.compile(r"^cand_[a-f0-9]{24}$")

_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private_key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.I)),
    ("openai_like_key", re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", re.I)),
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b", re.I)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b")),
    ("credential_assignment", re.compile(r"(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|cookie|密码|密钥)\s*[:：=]\s*['\"]?[^\s'\"]{6,}", re.I)),
    ("verification_code", re.compile(r"(?:验证码|verification\s*code|otp|2fa)\s*[:：=]?\s*\d{4,8}\b", re.I)),
    ("payment_card", re.compile(r"(?:银行卡|信用卡|card(?:\s+number)?)\s*[:：=]?\s*(?:\d[\s-]?){13,19}", re.I)),
)

_PERSONAL_MARKER = re.compile(r"(?:我|我的|本人|用户(?:的)?|\bmy\b|\bi am\b|\buser(?:'s)?\b)", re.I)
_SENSITIVE_PERSONAL: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("health", re.compile(r"(?:病史|诊断|疾病|用药|手术|住院|骨折|癌症|抑郁|怀孕|medical\s+condition|diagnosed|medication)", re.I)),
    ("politics", re.compile(r"(?:政治立场|党派|党员|投票给|政治观点|political\s+affiliation)", re.I)),
    ("religion", re.compile(r"(?:宗教信仰|信仰.{0,8}(?:佛教|基督教|伊斯兰教)|佛教徒|基督徒|穆斯林|religious\s+belief|religion)", re.I)),
    ("sexuality", re.compile(r"(?:性取向|性生活|同性恋|异性恋|双性恋|sexual\s+orientation|sex\s+life)", re.I)),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass


def _normalized_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def inspect_memory_safety(title: Any, content: Any, *, allow_sensitive_personal: bool = False) -> dict[str, Any]:
    text = f"{title or ''}\n{content or ''}"
    for code, pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            return {
                "allowed": False,
                "code": "SECRET_REJECTED",
                "category": code,
                "reason": "Secrets and authentication/payment credentials are never stored in long-term memory.",
            }
    if not allow_sensitive_personal and _PERSONAL_MARKER.search(text):
        for category, pattern in _SENSITIVE_PERSONAL:
            if pattern.search(text):
                return {
                    "allowed": False,
                    "code": "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED",
                    "category": category,
                    "reason": "Sensitive personal information requires an explicit local allow_sensitive_personal confirmation.",
                }
    return {"allowed": True, "code": "OK", "category": "", "reason": ""}


class MemoryWriteError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = str(code)
        self.details = dict(details or {})


class MemoryCandidateStore:
    """Persistent, bounded staging area for explicit long-term-memory writes."""

    def __init__(self, memory_store: MemoryStore, *, ttl_seconds: int = CANDIDATE_TTL_SECONDS) -> None:
        self.memory_store = memory_store
        self.root = memory_store.root / "candidates"
        self.root.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = max(60, min(int(ttl_seconds), 30 * 24 * 60 * 60))
        self._lock = threading.RLock()
        self.prune()

    def _path(self, candidate_id: str) -> Path:
        candidate_id = str(candidate_id or "")
        if not _CANDIDATE_ID_RE.fullmatch(candidate_id):
            raise MemoryWriteError("INVALID_CANDIDATE_ID", "Invalid memory candidate id.")
        return self.root / f"{candidate_id}.json"

    @staticmethod
    def _summary(item: dict[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        return {key: item.get(key) for key in (
            "memory_id", "scope", "memory_type", "title", "project_id", "task_id", "pinned", "confidence", "revision", "updated_at",
        )}

    def _read(self, path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def prune(self) -> dict[str, int]:
        now = datetime.now(timezone.utc).timestamp()
        expired = 0
        invalid = 0
        with self._lock:
            for path in list(self.root.glob("cand_*.json")):
                payload = self._read(path)
                if payload is None:
                    invalid += 1
                    path.unlink(missing_ok=True)
                    continue
                try:
                    expires = float(payload.get("expires_at_epoch") or 0)
                except (TypeError, ValueError):
                    expires = 0
                if expires <= now:
                    expired += 1
                    path.unlink(missing_ok=True)
        return {"expired": expired, "invalid": invalid}

    def list(self) -> list[dict[str, Any]]:
        self.prune()
        items: list[dict[str, Any]] = []
        with self._lock:
            for path in self.root.glob("cand_*.json"):
                payload = self._read(path)
                if payload is not None and payload.get("status") in {"pending", "conflict"}:
                    items.append(payload)
        items.sort(key=lambda item: str(item.get("proposed_at") or ""), reverse=True)
        return items[:MAX_PENDING_CANDIDATES]

    def get(self, candidate_id: str) -> dict[str, Any] | None:
        self.prune()
        path = self._path(candidate_id)
        payload = self._read(path) if path.is_file() else None
        return payload if payload and payload.get("status") in {"pending", "conflict"} else None

    def _scope_records(self, values: dict[str, Any]) -> list[dict[str, Any]]:
        scope = str(values.get("scope") or "")
        kwargs: dict[str, Any] = {"scope": scope, "limit": 200}
        if scope == "project":
            kwargs["project_id"] = str(values.get("project_id") or "")
        elif scope == "task":
            kwargs["task_id"] = str(values.get("task_id") or "")
        return self.memory_store.list(**kwargs)

    def _relation(self, values: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        wanted_type = str(values.get("memory_type") or "")
        wanted_title = _normalized_text(values.get("title"))
        wanted_content = _normalized_text(values.get("content"))
        conflict: dict[str, Any] | None = None
        best_ratio = 0.0
        for existing in self._scope_records(values):
            if str(existing.get("memory_type") or "") != wanted_type:
                continue
            existing_content = _normalized_text(existing.get("content"))
            if wanted_content and existing_content == wanted_content:
                return "duplicate", existing
            existing_title = _normalized_text(existing.get("title"))
            ratio = SequenceMatcher(None, wanted_title, existing_title).ratio() if wanted_title and existing_title else 0.0
            if wanted_title and (wanted_title == existing_title or ratio >= 0.92) and ratio >= best_ratio:
                conflict = existing
                best_ratio = ratio
        return ("conflict", conflict) if conflict is not None else ("new", None)

    def _validate(self, *, allow_sensitive_personal: bool, **values: Any) -> dict[str, Any]:
        normalized = self.memory_store._normalize(**values)
        safety = inspect_memory_safety(normalized["title"], normalized["content"], allow_sensitive_personal=allow_sensitive_personal)
        if not safety["allowed"]:
            raise MemoryWriteError(str(safety["code"]), str(safety["reason"]), details=safety)
        return normalized

    def propose(self, *, scope: str, memory_type: str = "note", title: str, content: str,
                project_id: str = "", task_id: str = "", source: str = "explicit_user",
                confidence: float = 1.0, pinned: bool = False, allow_sensitive_personal: bool = False) -> dict[str, Any]:
        values = self._validate(
            scope=scope, memory_type=memory_type, title=title, content=content, project_id=project_id, task_id=task_id,
            source=source, confidence=confidence, pinned=pinned, allow_sensitive_personal=allow_sensitive_personal,
        )
        relation, existing = self._relation(values)
        if relation == "duplicate":
            return {"status": "duplicate", "existing": self._summary(existing), "candidate": None}
        self.prune()
        pending = self.list()
        if len(pending) >= MAX_PENDING_CANDIDATES:
            raise MemoryWriteError("CANDIDATE_LIMIT", "Too many pending memory candidates.")
        now = datetime.now(timezone.utc)
        candidate_id = f"cand_{uuid.uuid4().hex[:24]}"
        payload = {
            "schema_version": CANDIDATE_SCHEMA_VERSION,
            "candidate_id": candidate_id,
            "status": "conflict" if relation == "conflict" else "pending",
            "proposed_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "expires_at_epoch": now.timestamp() + self.ttl_seconds,
            **values,
            "allow_sensitive_personal": bool(allow_sensitive_personal),
            "existing_memory_id": str(existing.get("memory_id") or "") if existing else "",
        }
        _atomic_json(self._path(candidate_id), payload)
        return dict(payload)

    def confirm(self, candidate_id: str, *, resolution: str = "") -> dict[str, Any]:
        candidate = self.get(candidate_id)
        if candidate is None:
            raise MemoryWriteError("CANDIDATE_NOT_FOUND", "Memory candidate not found or expired.")
        values = {key: candidate.get(key) for key in (
            "scope", "memory_type", "title", "content", "project_id", "task_id", "source", "confidence", "pinned",
        )}
        normalized = self._validate(allow_sensitive_personal=bool(candidate.get("allow_sensitive_personal")), **values)
        relation, existing = self._relation(normalized)
        if relation == "duplicate":
            self._path(candidate_id).unlink(missing_ok=True)
            return {"status": "duplicate", "candidate_id": candidate_id, "existing": self._summary(existing)}
        resolution = str(resolution or "").strip().lower()
        if relation == "conflict" and resolution not in {"update", "create_new"}:
            return {
                "status": "conflict", "candidate_id": candidate_id,
                "existing": self._summary(existing), "requires_resolution": ["update", "create_new"],
            }
        if relation == "conflict" and resolution == "update" and existing is not None:
            memory = self.memory_store.update(
                str(existing["memory_id"]), title=normalized["title"], content=normalized["content"],
                source=normalized["source"], confidence=normalized["confidence"], pinned=normalized["pinned"],
            )
            status = "updated"
        else:
            memory = self.memory_store.create(**normalized)
            status = "created"
        self._path(candidate_id).unlink(missing_ok=True)
        return {"status": status, "candidate_id": candidate_id, "memory": memory}

    def reject(self, candidate_id: str) -> dict[str, Any]:
        path = self._path(candidate_id)
        existed = path.is_file()
        path.unlink(missing_ok=True)
        return {"status": "rejected" if existed else "not_found", "candidate_id": candidate_id}

    def update_existing(self, memory_id: str, *, allow_sensitive_personal: bool = False, **changes: Any) -> dict[str, Any]:
        current = self.memory_store.get(memory_id)
        if current is None:
            raise KeyError(memory_id)
        merged = {
            "scope": current["scope"], "memory_type": changes.get("memory_type", current["memory_type"]),
            "title": changes.get("title", current["title"]), "content": changes.get("content", current["content"]),
            "project_id": current.get("project_id", ""), "task_id": current.get("task_id", ""),
            "source": changes.get("source", current.get("source", "explicit_user")),
            "confidence": changes.get("confidence", current.get("confidence", 1.0)),
            "pinned": changes.get("pinned", current.get("pinned", False)),
        }
        normalized = self._validate(allow_sensitive_personal=allow_sensitive_personal, **merged)
        return self.memory_store.update(
            memory_id, memory_type=normalized["memory_type"], title=normalized["title"], content=normalized["content"],
            source=normalized["source"], confidence=normalized["confidence"], pinned=normalized["pinned"],
        )
