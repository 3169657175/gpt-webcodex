from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any

MAX_RULE_BYTES = 16 * 1024
MAX_TOTAL_RULE_BYTES = 64 * 1024
MAX_RULE_FILES_PER_SCOPE = 32
_RULE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _default_global_root() -> Path:
    base = str(os.environ.get("LOCALAPPDATA") or "").strip()
    if not base:
        base = str(Path.home() / "AppData" / "Local")
    return Path(base).expanduser() / "GPT-WebCodex" / "rules-v1" / "global"


def _safe_name(value: Any) -> str:
    name = str(value or "").strip()
    if not _RULE_NAME_RE.fullmatch(name) or name in {".", ".."}:
        raise ValueError("invalid rule name")
    return name


class RuleStore:
    """Bounded local rule files. Rule text can constrain work but never grants permissions."""

    def __init__(self, workspace: Path, project_identity: dict[str, Any], *, global_root: Path | None = None) -> None:
        self.workspace = Path(workspace).expanduser().resolve(strict=True)
        self.project_identity = dict(project_identity or {})
        self.project_id = str(self.project_identity.get("project_id") or "")[:160]
        self.global_root = Path(global_root) if global_root is not None else _default_global_root()
        self.global_root = self.global_root.expanduser().resolve(strict=False)
        self.project_root = self.workspace / ".coding-tools" / "rules"

    def _scope_root(self, scope: str) -> Path:
        key = str(scope or "").strip().lower()
        if key == "global":
            return self.global_root
        if key == "project":
            return self.project_root
        raise ValueError("scope must be global or project")

    def save(self, scope: str, name: str, content: Any) -> dict[str, Any]:
        key = str(scope or "").strip().lower()
        target_root = self._scope_root(key)
        safe_name = _safe_name(name)
        text = str(content or "")
        encoded = text.encode("utf-8")
        if len(encoded) > MAX_RULE_BYTES:
            raise ValueError(f"rule exceeds {MAX_RULE_BYTES} bytes")
        target_root.mkdir(parents=True, exist_ok=True)
        target = target_root / f"{safe_name}.md"
        fd, temp_name = tempfile.mkstemp(prefix=f".{safe_name}.", suffix=".tmp", dir=str(target_root))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, target)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
        return self._item(key, target, text if text else "", len(encoded), include_content=True)

    def delete(self, scope: str, name: str) -> bool:
        target_root = self._scope_root(scope)
        safe_name = _safe_name(name)
        target = target_root / f"{safe_name}.md"
        try:
            target.unlink()
            return True
        except FileNotFoundError:
            return False

    def _item(self, scope: str, path: Path, content: str, byte_count: int, *, include_content: bool) -> dict[str, Any]:
        item = {
            "name": path.stem,
            "file": path.name,
            "source": scope,
            "trust_label": "local_user_rule" if scope == "global" else "project_rule",
            "project_id": "" if scope == "global" else self.project_id,
            "bytes": int(byte_count),
        }
        if include_content:
            item["content"] = content
        return item

    def _read_scope(self, scope: str, *, include_content: bool, remaining: int) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
        root = self._scope_root(scope)
        if not root.is_dir() or remaining <= 0:
            return [], [], remaining
        items: list[dict[str, Any]] = []
        warnings: list[dict[str, str]] = []
        for path in sorted(root.glob("*.md"), key=lambda p: p.name.lower())[:MAX_RULE_FILES_PER_SCOPE]:
            try:
                raw = path.read_bytes()
            except OSError as exc:
                warnings.append({"file": path.name, "error": str(exc)[:300]})
                continue
            if len(raw) > MAX_RULE_BYTES:
                warnings.append({"file": path.name, "error": "rule exceeds per-file byte budget"})
                continue
            if len(raw) > remaining:
                warnings.append({"file": path.name, "error": "rule omitted by total byte budget"})
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                warnings.append({"file": path.name, "error": "rule must be UTF-8"})
                continue
            remaining -= len(raw)
            items.append(self._item(scope, path, text, len(raw), include_content=include_content))
        return items, warnings, remaining

    def list(self, *, include_content: bool = False) -> dict[str, Any]:
        remaining = MAX_TOTAL_RULE_BYTES
        global_items, global_warnings, remaining = self._read_scope("global", include_content=include_content, remaining=remaining)
        project_items, project_warnings, remaining = self._read_scope("project", include_content=include_content, remaining=remaining)
        items = global_items + project_items
        return {
            "items": items,
            "count": len(items),
            "warnings": (global_warnings + project_warnings)[:20],
            "bytes_used": MAX_TOTAL_RULE_BYTES - remaining,
            "max_total_bytes": MAX_TOTAL_RULE_BYTES,
            "rules_cannot_elevate_permissions": True,
            "precedence": ["global", "project"],
        }
