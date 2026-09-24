from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .approval import PERMISSION_CATEGORIES, normalize_permission_policies


SKILL_SCHEMA_VERSION = 1
SKILL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9._-]+)?$")
ALLOWED_RISK_LEVELS = frozenset({"low", "medium", "high"})
MAX_TEXT = 8000
MAX_DEPENDENCIES = 32
MAX_SKILLS = 100


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _manifest_hash(raw: dict[str, Any]) -> str:
    encoded = json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _permissions(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("permissions must be a list")
    result: list[str] = []
    for item in value:
        category = _text(item, 100).lower()
        if category not in PERMISSION_CATEGORIES:
            raise ValueError(f"unknown permission category: {category}")
        if category not in result:
            result.append(category)
    return result


def _relative_root(value: Any) -> str:
    text = _text(value, 300).replace("\\", "/") or "."
    pure = PurePosixPath(text)
    if pure.is_absolute() or any(part == ".." for part in pure.parts):
        raise ValueError(f"allowed_roots must stay within workspace: {text}")
    normalized = pure.as_posix()
    return "." if normalized in {"", "."} else normalized


def normalize_skill(raw: Any, *, source: str = "project") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("skill manifest must be an object")
    allowed = {
        "schema_version", "id", "name", "version", "description", "instructions",
        "tool_schema", "permissions", "risk_level", "allowed_roots", "network_required", "dependencies",
    }
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ValueError(f"unknown skill fields: {', '.join(unknown)}")
    skill_id = _text(raw.get("id"), 64).lower()
    if not SKILL_ID_RE.fullmatch(skill_id):
        raise ValueError("invalid skill id")
    name = _text(raw.get("name"), 200)
    version = _text(raw.get("version"), 80)
    if not name or not VERSION_RE.fullmatch(version):
        raise ValueError("skill name and valid version are required")
    description = _text(raw.get("description"), 1000)
    instructions = _text(raw.get("instructions"), MAX_TEXT)
    if not instructions:
        raise ValueError("skill instructions are required")
    risk_level = _text(raw.get("risk_level", "medium"), 32).lower()
    if risk_level not in ALLOWED_RISK_LEVELS:
        raise ValueError(f"unsupported skill risk level: {risk_level}")
    permissions = _permissions(raw.get("permissions", []))
    roots_raw = raw.get("allowed_roots", ["."])
    if not isinstance(roots_raw, list) or not roots_raw:
        raise ValueError("allowed_roots must be a non-empty list")
    allowed_roots: list[str] = []
    for item in roots_raw[:32]:
        root = _relative_root(item)
        if root not in allowed_roots:
            allowed_roots.append(root)
    dependencies_raw = raw.get("dependencies", [])
    if not isinstance(dependencies_raw, list) or len(dependencies_raw) > MAX_DEPENDENCIES:
        raise ValueError("dependencies must be a bounded list")
    dependencies = [_text(item, 200) for item in dependencies_raw if _text(item, 200)]
    tool_schema = raw.get("tool_schema", {})
    if not isinstance(tool_schema, dict):
        raise ValueError("tool_schema must be an object")
    unknown_tool = sorted(set(tool_schema) - {"name", "description", "input_schema"})
    if unknown_tool:
        raise ValueError(f"unknown tool_schema fields: {', '.join(unknown_tool)}")
    tool_name = _text(tool_schema.get("name") or skill_id, 100)
    tool_description = _text(tool_schema.get("description") or description, 1000)
    input_schema = tool_schema.get("input_schema", {"type": "object", "properties": {}})
    if not isinstance(input_schema, dict) or str(input_schema.get("type") or "object") != "object":
        raise ValueError("tool_schema.input_schema must be an object schema")
    normalized_manifest = {
        "schema_version": SKILL_SCHEMA_VERSION,
        "id": skill_id,
        "name": name,
        "version": version,
        "description": description,
        "instructions": instructions,
        "tool_schema": {"name": tool_name, "description": tool_description, "input_schema": copy.deepcopy(input_schema)},
        "permissions": permissions,
        "risk_level": risk_level,
        "allowed_roots": allowed_roots,
        "network_required": bool(raw.get("network_required", False)),
        "dependencies": dependencies,
    }
    return {**normalized_manifest, "source": source, "manifest_hash": _manifest_hash(normalized_manifest)}


class SkillStore:
    """Static, declarative workspace skills backed by a trusted local enable state."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace).resolve()
        self.skill_dir = self.workspace / ".coding-tools" / "skills"
        self.state_path = self.workspace / ".coding-tools" / "skills-state.json"

    def _read_state(self) -> dict[str, Any]:
        if not self.state_path.is_file():
            return {"schema_version": 1, "skills": {}}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"schema_version": 1, "skills": {}}
        skills = raw.get("skills") if isinstance(raw, dict) and isinstance(raw.get("skills"), dict) else {}
        return {"schema_version": 1, "skills": skills}

    def _write_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=".skills-state.", suffix=".tmp", dir=str(self.state_path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
            os.replace(temp_name, self.state_path)
        finally:
            Path(temp_name).unlink(missing_ok=True)

    def _load_dir(self, path: Path) -> dict[str, Any]:
        manifest_path = path / "skill.json"
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        skill = normalize_skill(raw)
        if skill["id"] != path.name.lower():
            raise ValueError("skill id must match its directory name")
        readme = path / "README.md"
        validation = {
            "manifest": True,
            "readme": readme.is_file(),
            "src": (path / "src").is_dir(),
            "tests": (path / "tests").is_dir(),
        }
        skill["validation"] = validation
        skill["validated"] = validation["manifest"] and validation["readme"]
        return skill

    def list(self) -> dict[str, Any]:
        state = self._read_state()["skills"]
        items: list[dict[str, Any]] = []
        warnings: list[dict[str, str]] = []
        if self.skill_dir.is_dir():
            for path in sorted((item for item in self.skill_dir.iterdir() if item.is_dir()), key=lambda item: item.name.lower())[:MAX_SKILLS]:
                try:
                    if not SKILL_ID_RE.fullmatch(path.name.lower()):
                        raise ValueError("invalid skill directory name")
                    skill = self._load_dir(path)
                    saved = state.get(skill["id"], {}) if isinstance(state.get(skill["id"]), dict) else {}
                    enabled = bool(saved.get("enabled")) and saved.get("manifest_hash") == skill["manifest_hash"] and skill["validated"]
                    skill["enabled"] = enabled
                    skill["validation_stale"] = bool(saved.get("enabled")) and saved.get("manifest_hash") != skill["manifest_hash"]
                    items.append(skill)
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    warnings.append({"skill": path.name, "error": _text(exc, 300)})
        return {"items": items, "count": len(items), "warnings": warnings, "skill_dir": str(self.skill_dir)}

    def get(self, skill_id: str) -> dict[str, Any] | None:
        key = _text(skill_id, 64).lower()
        return next((copy.deepcopy(item) for item in self.list()["items"] if item["id"] == key), None)

    def validate(self, skill_id: str) -> dict[str, Any]:
        skill = self.get(skill_id)
        if skill is None:
            raise ValueError(f"skill not found: {_text(skill_id, 64)}")
        return {
            "ok": bool(skill["validated"]),
            "skill_id": skill["id"],
            "manifest_hash": skill["manifest_hash"],
            "checks": copy.deepcopy(skill["validation"]),
        }

    def enable(self, skill_id: str) -> dict[str, Any]:
        validation = self.validate(skill_id)
        if not validation["ok"]:
            raise ValueError("skill must pass validation before enable")
        state = self._read_state()
        state["skills"][validation["skill_id"]] = {
            "enabled": True,
            "manifest_hash": validation["manifest_hash"],
            "validated_at": utc_now(),
        }
        self._write_state(state)
        skill = self.get(skill_id)
        assert skill is not None
        return skill

    def disable(self, skill_id: str) -> dict[str, Any] | None:
        state = self._read_state()
        key = _text(skill_id, 64).lower()
        current = state["skills"].get(key, {}) if isinstance(state["skills"].get(key), dict) else {}
        state["skills"][key] = {**current, "enabled": False, "disabled_at": utc_now()}
        self._write_state(state)
        return self.get(key)

    @staticmethod
    def security_view(skill: dict[str, Any], policies: Any) -> dict[str, Any]:
        normalized = normalize_permission_policies(policies)
        required = {category: normalized[category] for category in skill.get("permissions", []) if category in PERMISSION_CATEGORIES}
        denied = [category for category, policy in required.items() if policy == "deny"]
        asks = [category for category, policy in required.items() if policy == "ask"]
        if skill.get("network_required") and "network" not in required:
            required["network"] = normalized["network"]
            if normalized["network"] == "deny": denied.append("network")
            elif normalized["network"] == "ask": asks.append("network")
        return {
            "required_policies": required,
            "denied_categories": sorted(set(denied)),
            "approval_categories": sorted(set(asks)),
            "can_auto_execute": not denied and not asks,
            "permission_escalation": False,
            "allowed_roots": list(skill.get("allowed_roots", [])),
            "note": "Enabled skills remain declarative and cannot expand Runtime permissions or workspace roots.",
        }
