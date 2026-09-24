from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .approval import PERMISSION_CATEGORIES, normalize_permission_policies


RECIPE_SCHEMA_VERSION = 1
ALLOWED_AGENT_MODES = frozenset({"ask", "plan", "code", "debug", "release", "full"})
ALLOWED_VERIFICATION = frozenset({"none", "tests", "build", "all"})
ALLOWED_FAILURE_POLICIES = frozenset({"stop", "continue"})
ALLOWED_RISK_LEVELS = frozenset({"low", "medium", "high"})
RECIPE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MAX_STEPS = 32
MAX_TEXT = 4000
MAX_FILES = 100


BUILTIN_RECIPES: tuple[dict[str, Any], ...] = (
    {
        "id": "fix-bug",
        "name": "修复 Bug",
        "description": "先定位根因，再做最小修改并运行针对性测试。",
        "mode": "debug",
        "default_verification": "tests",
        "tool_categories": ["read", "write", "command"],
        "failure_policy": "stop",
        "risk_level": "medium",
        "steps": [
            {"id": "diagnose", "title": "定位根因", "instruction": "收集失败证据并定位最小根因。", "tool_categories": ["read"]},
            {"id": "change", "title": "实施修改", "instruction": "只修改解决根因所需的文件。", "tool_categories": ["read", "write"]},
            {"id": "verify", "title": "验证修复", "instruction": "运行针对性回归并确认没有新失败。", "tool_categories": ["read", "command"]},
        ],
    },
    {
        "id": "release-version",
        "name": "发布版本",
        "description": "完成版本元数据、测试、Schema/构建和产物核对。",
        "mode": "release",
        "default_verification": "all",
        "tool_categories": ["read", "write", "command", "git_write"],
        "failure_policy": "stop",
        "risk_level": "high",
        "steps": [
            {"id": "metadata", "title": "更新版本元数据", "instruction": "仅更新当前发布身份与发布说明。", "tool_categories": ["read", "write"]},
            {"id": "tests", "title": "运行全量测试", "instruction": "测试不通过时停止发布。", "tool_categories": ["read", "command"]},
            {"id": "build", "title": "构建并核对产物", "instruction": "构建安装包并核对版本、大小和摘要。", "tool_categories": ["read", "command"]},
        ],
    },
    {
        "id": "frontend-regression",
        "name": "前端回归",
        "description": "围绕现有界面契约做聚焦回归，避免无关重构。",
        "mode": "debug",
        "default_verification": "tests",
        "tool_categories": ["read", "write", "command"],
        "failure_policy": "stop",
        "risk_level": "medium",
        "steps": [
            {"id": "inspect", "title": "恢复界面契约", "instruction": "读取相关 UI 与已有回归测试。", "tool_categories": ["read"]},
            {"id": "change", "title": "最小修改", "instruction": "保持现有交互与安全边界。", "tool_categories": ["read", "write"]},
            {"id": "verify", "title": "前端回归", "instruction": "执行对应 Node/Electron 回归。", "tool_categories": ["read", "command"]},
        ],
    },
    {
        "id": "mcp-stability-check",
        "name": "MCP 稳定性检查",
        "description": "只读优先检查 Runtime、Tunnel、Schema 和当前消息 Attachment。",
        "mode": "debug",
        "default_verification": "tests",
        "tool_categories": ["read", "command", "network"],
        "failure_policy": "stop",
        "risk_level": "medium",
        "steps": [
            {"id": "identity", "title": "核对 Runtime/Schema", "instruction": "确认进程、源码指纹、Schema 和工作区一致。", "tool_categories": ["read"]},
            {"id": "chain", "title": "检查连接链路", "instruction": "区分 Runtime、Tunnel、本地 main channel 与上游状态。", "tool_categories": ["read", "network"]},
            {"id": "regression", "title": "运行稳定性回归", "instruction": "只运行与当前故障相关的稳定性测试。", "tool_categories": ["read", "command"]},
        ],
    },
)


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _categories(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("tool_categories must be a list")
    result: list[str] = []
    for item in value:
        category = _text(item, 100).lower()
        if category not in PERMISSION_CATEGORIES:
            raise ValueError(f"unknown tool category: {category}")
        if category not in result:
            result.append(category)
    return result


def normalize_recipe(raw: Any, *, source: str = "project") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("recipe must be an object")
    allowed = {
        "schema_version", "id", "name", "description", "mode", "steps",
        "default_verification", "tool_categories", "failure_policy", "risk_level",
    }
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ValueError(f"unknown recipe fields: {', '.join(unknown)}")
    recipe_id = _text(raw.get("id"), 64).lower()
    if not RECIPE_ID_RE.fullmatch(recipe_id):
        raise ValueError("invalid recipe id")
    name = _text(raw.get("name"), 200)
    if not name:
        raise ValueError("recipe name is required")
    description = _text(raw.get("description"), 1000)
    mode = _text(raw.get("mode"), 32).lower()
    if mode not in ALLOWED_AGENT_MODES:
        raise ValueError(f"unsupported recipe mode: {mode}")
    verification = _text(raw.get("default_verification", "tests"), 32).lower()
    if verification not in ALLOWED_VERIFICATION:
        raise ValueError(f"unsupported verification: {verification}")
    failure_policy = _text(raw.get("failure_policy", "stop"), 32).lower()
    if failure_policy not in ALLOWED_FAILURE_POLICIES:
        raise ValueError(f"unsupported failure policy: {failure_policy}")
    risk_level = _text(raw.get("risk_level", "medium"), 32).lower()
    if risk_level not in ALLOWED_RISK_LEVELS:
        raise ValueError(f"unsupported risk level: {risk_level}")
    categories = _categories(raw.get("tool_categories", []))
    raw_steps = raw.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps or len(raw_steps) > MAX_STEPS:
        raise ValueError(f"recipe steps must contain 1..{MAX_STEPS} items")
    steps: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_steps, 1):
        if not isinstance(item, dict):
            raise ValueError("recipe step must be an object")
        unknown_step = sorted(set(item) - {"id", "title", "instruction", "tool_categories"})
        if unknown_step:
            raise ValueError(f"unknown step fields: {', '.join(unknown_step)}")
        step_id = _text(item.get("id") or f"step-{index}", 64).lower()
        if not RECIPE_ID_RE.fullmatch(step_id) or step_id in seen:
            raise ValueError(f"invalid or duplicate step id: {step_id}")
        seen.add(step_id)
        title = _text(item.get("title"), 200)
        instruction = _text(item.get("instruction"), MAX_TEXT)
        if not title or not instruction:
            raise ValueError("recipe step title and instruction are required")
        step_categories = _categories(item.get("tool_categories", []))
        if any(category not in categories for category in step_categories):
            raise ValueError("step tool_categories must be a subset of recipe tool_categories")
        steps.append({"id": step_id, "title": title, "instruction": instruction, "tool_categories": step_categories})
    return {
        "schema_version": RECIPE_SCHEMA_VERSION,
        "id": recipe_id,
        "name": name,
        "description": description,
        "mode": mode,
        "steps": steps,
        "default_verification": verification,
        "tool_categories": categories,
        "failure_policy": failure_policy,
        "risk_level": risk_level,
        "source": source,
    }


class RecipeStore:
    """Workspace-local declarative recipes.

    Recipes describe a workflow but never grant permissions or execute tools.  A
    consumer must still pass every operation through the Runtime's existing
    Agent mode and Local Approval policy.
    """

    def __init__(self, workspace: Path, *, builtin_recipes: Iterable[dict[str, Any]] = BUILTIN_RECIPES) -> None:
        self.workspace = Path(workspace).resolve()
        self.recipe_dir = self.workspace / ".coding-tools" / "recipes"
        self.active_path = self.workspace / ".coding-tools" / "active-recipe.json"
        self._builtin: dict[str, dict[str, Any]] = {}
        for raw in builtin_recipes:
            recipe = normalize_recipe(raw, source="builtin")
            self._builtin[recipe["id"]] = recipe

    def list(self) -> dict[str, Any]:
        recipes = {key: copy.deepcopy(value) for key, value in self._builtin.items()}
        warnings: list[dict[str, str]] = []
        if self.recipe_dir.is_dir():
            for path in sorted(self.recipe_dir.glob("*.json"), key=lambda item: item.name.lower())[:MAX_FILES]:
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                    recipe = normalize_recipe(raw, source="project")
                    recipes[recipe["id"]] = recipe
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    warnings.append({"file": path.name, "error": _text(exc, 300)})
        items = sorted(recipes.values(), key=lambda item: (item["source"] != "project", item["name"].lower(), item["id"]))
        return {"items": items, "count": len(items), "warnings": warnings, "recipe_dir": str(self.recipe_dir)}

    def get(self, recipe_id: str) -> dict[str, Any] | None:
        key = _text(recipe_id, 64).lower()
        for item in self.list()["items"]:
            if item["id"] == key:
                return copy.deepcopy(item)
        return None

    def active(self) -> dict[str, Any] | None:
        if not self.active_path.is_file():
            return None
        try:
            raw = json.loads(self.active_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(raw, dict):
            return None
        return self.get(_text(raw.get("recipe_id"), 64))

    def activate(self, recipe_id: str) -> dict[str, Any]:
        recipe = self.get(recipe_id)
        if recipe is None:
            raise ValueError(f"recipe not found: {_text(recipe_id, 64)}")
        self.active_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"schema_version": RECIPE_SCHEMA_VERSION, "recipe_id": recipe["id"]}
        fd, temp_name = tempfile.mkstemp(prefix=".active-recipe.", suffix=".tmp", dir=str(self.active_path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.active_path)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
        return copy.deepcopy(recipe)

    def deactivate(self) -> None:
        try:
            self.active_path.unlink(missing_ok=True)
        except OSError:
            pass

    def save(self, raw: Any) -> dict[str, Any]:
        recipe = normalize_recipe(raw, source="project")
        self.recipe_dir.mkdir(parents=True, exist_ok=True)
        target = self.recipe_dir / f"{recipe['id']}.json"
        payload = {key: value for key, value in recipe.items() if key != "source"}
        fd, temp_name = tempfile.mkstemp(prefix=f".{recipe['id']}.", suffix=".tmp", dir=str(self.recipe_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, target)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
        return copy.deepcopy(recipe)

    @staticmethod
    def security_view(recipe: dict[str, Any], policies: Any) -> dict[str, Any]:
        normalized = normalize_permission_policies(policies)
        categories = [category for category in recipe.get("tool_categories", []) if category in PERMISSION_CATEGORIES]
        required = {category: normalized[category] for category in categories}
        denied = [category for category, policy in required.items() if policy == "deny"]
        asks = [category for category, policy in required.items() if policy == "ask"]
        return {
            "required_policies": required,
            "denied_categories": denied,
            "approval_categories": asks,
            "can_auto_execute": not denied and not asks,
            "permission_escalation": False,
            "note": "Recipe declarations never change Runtime permission policies.",
        }
