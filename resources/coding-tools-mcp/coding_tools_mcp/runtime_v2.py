from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


CORE_TOOLS = ("coding_tools_guide", "workspace_context", "agent_workflow", "task_control")
TOOL_GROUPS = {
    "coding_tools_guide": "core",
    "workspace_context": "core",
    "agent_workflow": "core",
    "task_control": "core",
    "document_workflow": "document",
    "exec_command": "process",
    "command_control": "process",
    "request_permissions": "permission",
    "view_image": "media",
}


def _text(value: Any, limit: int = 240) -> str:
    return str(value or "")[:limit]


def layered_runtime_state(
    state: dict[str, Any] | None,
    operations: list[dict[str, Any]] | None = None,
    *,
    workspace: str = "",
    mcp_connected: bool = True,
) -> dict[str, Any]:
    task = state if isinstance(state, dict) else {}
    items = [item for item in (operations or []) if isinstance(item, dict)]
    running = [item for item in items if str(item.get("status") or "") in {"running", "queued"}]
    operation = (running[-1] if running else items[-1]) if items else {}
    lifecycle = str(task.get("lifecycle_state") or "idle")
    status = str(task.get("status") or "idle")
    command = task.get("current_command") if isinstance(task.get("current_command"), dict) else {}

    if status in {"completed", "failed", "stopped"}:
        execution = status
    elif lifecycle in {"waiting_model", "waiting_user", "waiting_approval", "needs_user", "paused"}:
        execution = "waiting"
    elif status == "idle":
        execution = "idle"
    else:
        execution = "running"

    model = (
        "waiting" if lifecycle == "waiting_model"
        else "blocked" if lifecycle in {"waiting_user", "waiting_approval", "needs_user", "paused"}
        else "active" if execution == "running"
        else "idle"
    )
    command_running = str(command.get("status") or "") == "running"
    operation_running = str(operation.get("status") or "") in {"running", "queued"}
    process = "running" if command_running else "background" if operation_running else str(command.get("status") or "idle")
    recovery = (
        "recovering" if lifecycle == "recovering"
        else "attention" if task.get("last_recovery") and execution in {"waiting", "failed"}
        else "healthy"
    )
    workspace_ready = bool(workspace and Path(workspace).is_dir())
    last_command = task.get("last_command") if isinstance(task.get("last_command"), dict) else {}
    execution_id = str(operation.get("execution_id") or command.get("execution_id") or last_command.get("execution_id") or "")
    process_id = command.get("process_id") or command.get("pid") or operation.get("process_id")

    return {
        "execution": {"state": execution, "lifecycle": lifecycle, "status": status},
        "model": {"state": model, "wait_reason": _text(task.get("wait_reason"), 500)},
        "process": {"state": process, "process_id": process_id, "session_id": _text(command.get("session_id"), 200)},
        "connection": {"state": "connected" if mcp_connected else "disconnected", "transport": "mcp"},
        "recovery": {
            "state": recovery,
            "attempt": int(task.get("recovery_attempt") or 0),
            "safe_resume_point": _text(task.get("safe_resume_point"), 1000),
        },
        "workspace": {"state": "ready" if workspace_ready else "missing", "path": str(workspace or "")},
        "correlation": {
            "task_id": _text(task.get("task_id"), 200),
            "run_id": _text(task.get("run_id"), 200),
            "local_session_id": _text(task.get("local_session_id"), 200),
            "operation_id": _text(operation.get("operation_id"), 200),
            "execution_id": _text(execution_id, 200),
            "process_id": process_id,
        },
    }


def context_budget_snapshot(
    pressure: dict[str, Any] | None,
    *,
    hard_bytes: int = 2 * 1024 * 1024,
) -> dict[str, Any]:
    source = pressure if isinstance(pressure, dict) else {}
    used = max(0, int(source.get("response_bytes") or 0))
    ratio = min(1.0, used / max(1, hard_bytes))
    state = (
        "compact_now" if ratio >= 0.9
        else "prepare_checkpoint" if ratio >= 0.7
        else "trim" if ratio >= 0.5
        else "normal"
    )
    return {
        "state": state,
        "response_bytes": used,
        "budget_bytes": hard_bytes,
        "percent": round(ratio * 100, 1),
        "continuation_checkpoint_recommended": state in {"prepare_checkpoint", "compact_now"},
        "prefer_output_refs": state != "normal",
    }


def tool_effect(tool: str) -> dict[str, Any]:
    name = str(tool or "")
    if name in {"coding_tools_guide", "workspace_context", "view_image"}:
        return {"side_effect": "none", "retry_safe": True}
    if name in {"task_control", "command_control", "request_permissions"}:
        return {"side_effect": "stateful", "retry_safe": False}
    if name in {"agent_workflow", "exec_command", "document_workflow"}:
        return {"side_effect": "possible", "retry_safe": False}
    return {"side_effect": "unknown", "retry_safe": False}


def tool_registry_snapshot(
    tool_names: list[str] | tuple[str, ...],
    *,
    tool_mode: str,
    schema_version: int,
    workspace: str,
) -> dict[str, Any]:
    names = [str(item) for item in tool_names]
    rows = [
        {
            "name": name,
            "group": TOOL_GROUPS.get(name, "optional"),
            "core": name in CORE_TOOLS,
            **tool_effect(name),
        }
        for name in names
    ]
    generation = hashlib.sha256(
        json.dumps(
            {
                "workspace": str(workspace),
                "tool_mode": str(tool_mode),
                "schema_version": int(schema_version),
                "tools": names,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:16]
    return {
        "generation": generation,
        "scope": "workspace",
        "mode": str(tool_mode),
        "core_tools": [name for name in CORE_TOOLS if name in names],
        "tools": rows,
        "tool_count": len(rows),
    }
