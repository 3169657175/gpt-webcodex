from __future__ import annotations

import hashlib
import fnmatch
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PERMISSION_CATEGORIES = (
    "read",
    "write",
    "delete",
    "command",
    "network",
    "git_write",
    "system_modify",
    "extra_access",
)
POLICY_VALUES = ("allow", "ask", "deny")
DEFAULT_PERMISSION_POLICIES: dict[str, str] = {
    "read": "allow",
    "write": "allow",
    "delete": "ask",
    "command": "allow",
    "network": "allow",
    "git_write": "ask",
    "system_modify": "ask",
    "extra_access": "allow",
}
LEGACY_PERMISSION_CATEGORY = {
    "network": "network",
    "destructive_command": "delete",
    "long_timeout": "command",
    "sensitive_env": "command",
    "shell_expansion": "command",
    "inline_script": "command",
    "privileged_executable": "command",
    "write_generated_or_ignored": "write",
    "system_modify": "system_modify",
}
MAX_REQUESTS = 100
MAX_GRANTS = 64
MAX_AUDIT_STRING = 500
PENDING_TTL_SECONDS = 6 * 60 * 60

_SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"), r"\1<redacted>"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"), "<redacted-key>"),
    (re.compile(r"(?i)\b(api[_-]?key|token|password|passwd|cookie|secret)\b\s*[:=]\s*([^\s,;]+)"), r"\1=<redacted>"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_permission_policies(raw: Any) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    result: dict[str, str] = {}
    for category in PERMISSION_CATEGORIES:
        value = str(source.get(category, DEFAULT_PERMISSION_POLICIES[category])).strip().lower()
        result[category] = value if value in POLICY_VALUES else DEFAULT_PERMISSION_POLICIES[category]
    return result


def policies_from_env(name: str = "CODING_TOOLS_MCP_TOOL_PERMISSIONS") -> dict[str, str]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return normalize_permission_policies({})
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = {}
    return normalize_permission_policies(value)


def permission_patterns_from_env(name: str = "CODING_TOOLS_MCP_PERMISSION_PATTERNS") -> dict[str, list[dict[str, str]]]:
    raw = os.environ.get(name, "").strip()
    try:
        source = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        source = {}
    result: dict[str, list[dict[str, str]]] = {"paths": [], "commands": []}
    for kind in ("paths", "commands"):
        values = source.get(kind) if isinstance(source, dict) else []
        for item in values if isinstance(values, list) else []:
            if not isinstance(item, dict):
                continue
            pattern = str(item.get("pattern") or "").strip()
            decision = str(item.get("decision") or item.get("policy") or "").strip().lower()
            category = str(item.get("category") or "*").strip().lower()
            if pattern and decision in POLICY_VALUES:
                result[kind].append({"pattern": pattern, "decision": decision, "category": category})
    return result


def permission_category(permission: str) -> str:
    key = str(permission or "").strip().lower()
    return LEGACY_PERMISSION_CATEGORY.get(key, "command")


def redact_text(value: Any) -> str:
    text = str(value or "")[:MAX_AUDIT_STRING]
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _safe_audit_value(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_text(value)
    if depth >= 3:
        return redact_text(value)
    if isinstance(value, dict):
        return {redact_text(key): _safe_audit_value(item, depth + 1) for key, item in list(value.items())[:30]}
    if isinstance(value, (list, tuple, set)):
        return [_safe_audit_value(item, depth + 1) for item in list(value)[:30]]
    return redact_text(value)


class LocalApprovalStore:
    """Cross-process local approval state shared by Runtime and Electron.

    The Runtime only creates/consumes requests. A local Electron IPC action is
    responsible for changing a pending request to approved/denied or creating
    session/project grants.
    """

    def __init__(
        self,
        workspace: Path,
        runtime_instance_id: str,
        policies: dict[str, str] | None = None,
        patterns: dict[str, list[dict[str, str]]] | None = None,
    ) -> None:
        self.workspace = Path(workspace).resolve()
        self.runtime_instance_id = str(runtime_instance_id or "")
        self.policies = normalize_permission_policies(policies or {})
        self.patterns = patterns if isinstance(patterns, dict) else {"paths": [], "commands": []}
        self.state_path = self.workspace / ".coding-tools" / "approval-state.json"
        self.audit_path = self.workspace / ".coding-tools" / "audit.jsonl"
        self._lock = threading.RLock()

    @staticmethod
    def _path_candidates(args: dict[str, Any]) -> list[str]:
        result: list[str] = []
        path_keys = {"path", "paths", "cwd", "workdir", "target", "source", "destination", "destination_path"}

        def walk(value: Any, key: str = "") -> None:
            if key.lower() in path_keys and isinstance(value, str):
                result.append(os.path.normcase(os.path.normpath(os.path.expanduser(value))))
                return
            if isinstance(value, dict):
                for child_key, child in value.items():
                    walk(child, str(child_key))
            elif isinstance(value, (list, tuple)):
                for child in value:
                    walk(child, key)

        walk(args)
        return result[:100]

    def _pattern_policy(self, category: str, args: dict[str, Any]) -> tuple[str | None, dict[str, str] | None]:
        candidates: list[tuple[str, str]] = []
        command = str(args.get("cmd") or "").strip()
        if command:
            candidates.append(("commands", command))
        candidates.extend(("paths", value) for value in self._path_candidates(args))
        for kind, candidate in candidates:
            for rule in self.patterns.get(kind, []):
                rule_category = str(rule.get("category") or "*")
                if rule_category not in {"*", category}:
                    continue
                pattern = str(rule.get("pattern") or "")
                left = os.path.normcase(candidate) if kind == "paths" else candidate
                right = os.path.normcase(os.path.normpath(pattern)) if kind == "paths" else pattern
                if fnmatch.fnmatchcase(left, right):
                    return str(rule.get("decision") or ""), dict(rule)
        return None, None

    def _default_state(self) -> dict[str, Any]:
        return {"version": 1, "requests": [], "grants": []}

    @staticmethod
    def _created_at(value: Any) -> datetime | None:
        text = str(value or "").strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    def _prune_state(self, state: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        now = datetime.now(timezone.utc)
        requests: list[dict[str, Any]] = []
        changed = False
        for item in state.get("requests") or []:
            if not isinstance(item, dict):
                changed = True
                continue
            if str(item.get("status") or "") == "pending":
                created = self._created_at(item.get("created_at"))
                stale_age = created is not None and (now - created).total_seconds() > PENDING_TTL_SECONDS
                request_runtime = str(item.get("runtime_instance_id") or "")
                stale_runtime = bool(request_runtime and self.runtime_instance_id and request_runtime != self.runtime_instance_id)
                if stale_age or stale_runtime:
                    changed = True
                    continue
            requests.append(item)

        grants: list[dict[str, Any]] = []
        for item in state.get("grants") or []:
            if not isinstance(item, dict):
                changed = True
                continue
            if str(item.get("scope") or "") == "session" and str(item.get("runtime_instance_id") or "") != self.runtime_instance_id:
                changed = True
                continue
            grants.append(item)

        return {
            "version": 1,
            "requests": requests[-MAX_REQUESTS:],
            "grants": grants[-MAX_GRANTS:],
        }, changed

    def _read_state(self) -> dict[str, Any]:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = self._default_state()
        if not isinstance(data, dict):
            data = self._default_state()
        requests = data.get("requests") if isinstance(data.get("requests"), list) else []
        grants = data.get("grants") if isinstance(data.get("grants"), list) else []
        state, changed = self._prune_state({"version": 1, "requests": requests, "grants": grants})
        if changed:
            self._write_state(state)
        return state

    def _write_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "requests": list(state.get("requests") or [])[-MAX_REQUESTS:],
            "grants": list(state.get("grants") or [])[-MAX_GRANTS:],
        }
        fd, temp_name = tempfile.mkstemp(prefix="approval-", suffix=".json", dir=str(self.state_path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.state_path)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def audit(self, event: dict[str, Any]) -> None:
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        record = {"time": utc_now(), **_safe_audit_value(event)}
        with self.audit_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def fingerprint(self, tool: str, args: dict[str, Any], categories: list[str]) -> str:
        canonical = json.dumps(
            {"tool": tool, "args": args, "categories": sorted(set(categories))},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _grant_covers(self, grant: dict[str, Any], category: str) -> bool:
        if str(grant.get("status") or "active") != "active":
            return False
        categories = grant.get("categories") if isinstance(grant.get("categories"), list) else []
        if category not in {str(item) for item in categories}:
            return False
        scope = str(grant.get("scope") or "")
        if scope == "project":
            return True
        if scope == "session":
            return str(grant.get("runtime_instance_id") or "") == self.runtime_instance_id
        return False

    def check(
        self,
        *,
        tool: str,
        args: dict[str, Any],
        categories: list[str],
        risk_level: str,
        summary: str,
        action: str = "",
        consume_once: bool = True,
    ) -> dict[str, Any]:
        unique = [category for category in PERMISSION_CATEGORIES if category in set(categories)]
        if not unique:
            unique = ["read"]
        effective: dict[str, str] = {}
        matched_rules: list[dict[str, str]] = []
        for category in unique:
            override, rule = self._pattern_policy(category, args)
            effective[category] = override or self.policies.get(category, DEFAULT_PERMISSION_POLICIES[category])
            if rule:
                matched_rules.append(rule)
        denied = [category for category in unique if effective.get(category) == "deny"]
        if denied:
            decision = {
                "decision": "deny",
                "source": "pattern" if matched_rules else "policy",
                "categories": unique,
                "denied_categories": denied,
                "risk_level": risk_level,
                "matched_rules": matched_rules,
            }
            self.audit({"event": "permission_decision", "tool": tool, "action": action, "summary": summary, **decision})
            return decision

        ask_categories = [category for category in unique if effective.get(category) == "ask"]
        if not ask_categories:
            decision = {
                "decision": "allow",
                "source": "pattern" if matched_rules else "policy",
                "categories": unique,
                "risk_level": risk_level,
                "matched_rules": matched_rules,
            }
            self.audit({"event": "permission_decision", "tool": tool, "action": action, "summary": summary, **decision})
            return decision

        with self._lock:
            state = self._read_state()
            grants = [item for item in state["grants"] if isinstance(item, dict)]
            granted_categories = {
                category
                for category in ask_categories
                if any(self._grant_covers(grant, category) for grant in grants)
            }
            missing = [category for category in ask_categories if category not in granted_categories]
            if not missing:
                decision = {"decision": "allow", "source": "grant", "categories": unique, "risk_level": risk_level}
                self.audit({"event": "permission_decision", "tool": tool, "action": action, "summary": summary, **decision})
                return decision

            fingerprint = self.fingerprint(tool, args, ask_categories)
            matching = next(
                (
                    item
                    for item in reversed(state["requests"])
                    if isinstance(item, dict) and str(item.get("fingerprint") or "") == fingerprint
                ),
                None,
            )
            if matching is not None:
                status = str(matching.get("status") or "pending")
                if status == "approved_once":
                    if consume_once:
                        matching["status"] = "consumed"
                        matching["consumed_at"] = utc_now()
                        self._write_state(state)
                    decision = {
                        "decision": "allow",
                        "source": "approval_once" if consume_once else "approval_once_preview",
                        "categories": unique,
                        "risk_level": risk_level,
                        "request_id": str(matching.get("request_id") or ""),
                    }
                    self.audit({"event": "permission_decision", "tool": tool, "action": action, "summary": summary, **decision})
                    return decision
                if status == "denied":
                    decision = {
                        "decision": "deny",
                        "source": "local_denial",
                        "categories": unique,
                        "risk_level": risk_level,
                        "request_id": str(matching.get("request_id") or ""),
                    }
                    self.audit({"event": "permission_decision", "tool": tool, "action": action, "summary": summary, **decision})
                    return decision
                if status == "pending":
                    return {
                        "decision": "ask",
                        "source": "pending",
                        "categories": unique,
                        "risk_level": risk_level,
                        "request_id": str(matching.get("request_id") or ""),
                    }

            request_id = uuid.uuid4().hex
            request = {
                "request_id": request_id,
                "fingerprint": fingerprint,
                "status": "pending",
                "tool": str(tool),
                "action": str(action or ""),
                "categories": ask_categories,
                "all_categories": unique,
                "risk_level": str(risk_level),
                "summary": redact_text(summary),
                "workspace": str(self.workspace),
                "runtime_instance_id": self.runtime_instance_id,
                "created_at": utc_now(),
            }
            state["requests"].append(request)
            self._write_state(state)
            self.audit({
                "event": "approval_required",
                "tool": tool,
                "action": action,
                "summary": summary,
                "categories": ask_categories,
                "risk_level": risk_level,
                "request_id": request_id,
            })
            return {
                "decision": "ask",
                "source": "new_request",
                "categories": unique,
                "risk_level": risk_level,
                "request_id": request_id,
            }

    def record_outcome(
        self,
        *,
        tool: str,
        action: str,
        summary: str,
        risk_level: str,
        categories: list[str],
        outcome: str,
        duration_ms: int,
        execution_id: str = "",
        affected_files: list[str] | None = None,
    ) -> None:
        self.audit({
            "event": "tool_outcome",
            "tool": tool,
            "action": action,
            "summary": summary,
            "risk_level": risk_level,
            "categories": categories,
            "outcome": outcome,
            "duration_ms": max(0, int(duration_ms)),
            "execution_id": execution_id,
            "affected_files": list(affected_files or [])[:20],
        })
