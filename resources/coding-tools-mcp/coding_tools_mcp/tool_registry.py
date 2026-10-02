from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolSpec:
    """Single source of truth for one tool's title, description, and annotation hints.

    Handler methods on Runtime are named exactly after the tool. Input schemas live in
    input_schemas(), keyed by the same names. `error_status` is stamped on failure
    payloads, and `content_builder` converts a success payload into extra MCP
    content blocks (beyond the rendered text).
    """

    title: str
    description: str
    read_only: bool = False
    destructive: bool = False
    idempotent: bool = False
    open_world: bool = False
    error_status: str | None = None
    content_builder: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None
    gated_by: str | None = None
    """Name of a Runtime attribute that must be truthy for the tool to be exposed."""


def _image_content(payload: dict[str, Any]) -> list[dict[str, Any]]:
    encoded = str(payload.pop("_mcp_image_data", ""))
    return [
        {
            "type": "image",
            "data": encoded,
            "mimeType": str(payload.get("mime_type", "application/octet-stream")),
        }
    ]


TOOL_REGISTRY: dict[str, ToolSpec] = {
    "server_info": ToolSpec(
        title="Server info",
        description="Return server, workspace, project-context, auth, policy, and fixed-tool metadata.",
        read_only=True,
        idempotent=True,
    ),
    "coding_tools_guide": ToolSpec(
        title="Coding Tools usage guide",
        description="Return a compact usage guide for this MCP. Call only when you need to confirm which high-level tool to use or when preparing ChatGPT Custom Instructions; do not call before every task.",
        read_only=True,
        idempotent=True,
    ),
    "workspace_context": ToolSpec(
        title="Inspect workspace",
        description="Preferred read-only tool when the user asks what is in the current working directory or wants a quick project overview. Returns the active workspace, default directory, project type, root entries, Git status, and task summary in one call; do not use exec_command merely to list files.",
        read_only=True,
        idempotent=True,
    ),
    "agent_workflow": ToolSpec(
        title="Run complete agent workflow",
        description="Primary tool for end-to-end work. Use one call for bug diagnosis, feature development, greenfield project creation, refactoring, test-failure repair, build/release verification, document work, or task resume. It bundles context collection, file creation or patches, commands, tests, builds, artifacts, Git diff, and persistent task state so the model must not repeat environment checks or low-level tool calls.",
        destructive=True,
    ),
    "prepare_coding_context": ToolSpec(
        title="Prepare coding context",
        description="Preferred first step for coding tasks: inspect the project, task state, instructions and Git once, batch-search multiple queries, and read the most relevant files in one cached call.",
        read_only=True,
        idempotent=True,
    ),
    "apply_changes_and_verify": ToolSpec(
        title="Apply changes and verify",
        description="Preferred execution step: apply one or more patches, run multiple checks, optionally test/build, collect Git diff and update task state in one continuous call. Original low-level tools remain available as fallbacks.",
        destructive=True,
    ),
    "task_control": ToolSpec(
        title="Control persistent task",
        description="Start, inspect, update, pause, stop, resume, clear, or list history for the current workspace task.",
        idempotent=True,
    ),
    "read_files": ToolSpec(
        title="Read multiple files",
        description="Read one or more UTF-8 workspace files in one bounded call.",
        read_only=True,
        idempotent=True,
    ),
    "file_batch": ToolSpec(
        title="Batch file operations",
        description="Create directories or copy, move, and delete multiple workspace paths in one bounded atomic-style request.",
        destructive=True,
    ),
    "command_control": ToolSpec(
        title="Control command session",
        description="Poll, write to, terminate, or page output from a running command session.",
    ),
    "git_inspect": ToolSpec(
        title="Inspect Git repository",
        description="Run status, diff, log, show, or blame through one compact Git inspection tool.",
        read_only=True,
        idempotent=True,
    ),
    "document_workflow": ToolSpec(
        title="Read or create documents in one step",
        description="Mandatory fast path for PDF, Word, Markdown, and text tasks. To create content from a PDF/DOCX, call action=inspect exactly once, reason over the returned text, then call action=create exactly once with target/content. Create supports .docx, .md, and .txt and already returns size, line count, SHA256, and preview, so never probe Python/PDF dependencies, use exec_command/apply_patch, repeat extraction, or run a separate verification command.",
        destructive=True,
    ),
    "document_extract": ToolSpec(
        title="Extract Word or PDF",
        description="Extract text and metadata from a workspace DOCX, PDF, or supported text document.",
        read_only=True,
        idempotent=True,
    ),
    "document_create": ToolSpec(
        title="Create Word document",
        description="Create a DOCX file directly in the workspace from structured plain text or Markdown-like content.",
        destructive=True,
    ),
    "document_convert": ToolSpec(
        title="Convert document to Word",
        description="Convert a workspace PDF or supported text document into a DOCX file without Base64 round-trips.",
        destructive=True,
    ),
    "check_exec_environment": ToolSpec(
        title="Check exec environment",
        description="Return lightweight exec_command sandbox and environment status known to the server.",
        read_only=True,
        idempotent=True,
    ),
    "get_default_cwd": ToolSpec(
        title="Get default cwd",
        description="Return the current default cwd inside the workspace.",
        read_only=True,
        idempotent=True,
    ),
    "set_default_cwd": ToolSpec(
        title="Set default cwd",
        description="Set the default cwd for relative tool paths inside the workspace.",
        idempotent=True,
    ),
    "task_state_get": ToolSpec(
        title="Get task state",
        description="Read the persistent coding-task objective, progress, commands, results, modified files, failure, and next step.",
        read_only=True,
        idempotent=True,
    ),
    "task_state_update": ToolSpec(
        title="Update task state",
        description="Create or update the persistent coding-task objective, plan progress, failure, and next step.",
        idempotent=True,
    ),
    "task_state_clear": ToolSpec(
        title="Clear task state",
        description="Clear the current workspace task state after a task is finished or deliberately abandoned.",
        destructive=True,
        idempotent=True,
    ),
    "task_state_pause": ToolSpec(title="Pause task", description="Pause the current persistent task without losing progress.", idempotent=True),
    "task_state_resume": ToolSpec(title="Resume task", description="Resume a paused persistent task from its recorded next step.", idempotent=True),
    "task_history_list": ToolSpec(title="List task history", description="List archived tasks for the current workspace.", read_only=True, idempotent=True),
    "read_file": ToolSpec(
        title="Read file",
        description="Read a UTF-8 text file slice inside the configured workspace.",
        read_only=True,
        idempotent=True,
    ),
    "list_dir": ToolSpec(
        title="List directory",
        description="List directory entries inside the configured workspace.",
        read_only=True,
        idempotent=True,
    ),
    "list_files": ToolSpec(
        title="List files",
        description="List workspace files using glob filters.",
        read_only=True,
        idempotent=True,
    ),
    "search_text": ToolSpec(
        title="Search text",
        description="Search UTF-8 workspace files for text or regex matches.",
        read_only=True,
        idempotent=True,
    ),
    "apply_patch": ToolSpec(
        title="Apply patch",
        description="Stage, validate, and atomically replace files from a patch envelope inside the workspace.",
        destructive=True,
    ),
    "exec_command": ToolSpec(
        title="Execute command",
        description="Fallback for a focused workspace command only when no high-level workflow can perform it. Never use this tool to list a directory, inspect or create PDF/DOCX/Markdown/text documents, probe Python or PDF dependencies, or verify a document write; workspace_context and document_workflow perform those tasks with fewer round trips.",
        destructive=True,
        open_world=True,
        error_status="failed",
    ),
    "verify_build": ToolSpec(
        title="Build and verify project",
        description="Detect the project, run its tests and build under the command policy, verify artifacts, read version metadata, hash outputs, and return a build report.",
        destructive=True,
        open_world=True,
        error_status="failed",
    ),
    "write_stdin": ToolSpec(
        title="Write stdin",
        description=(
            "Poll or interact with a running command session. Pass empty chars to wait for more output; "
            "pass non-empty chars to write to stdin."
        ),
    ),
    "kill_session": ToolSpec(
        title="Kill session",
        description="Terminate a server-managed running command session.",
        destructive=True,
    ),
    "read_output": ToolSpec(
        title="Read output",
        description="Read retained stdout or stderr by output_ref with per-stream byte offset pagination.",
        read_only=True,
        idempotent=True,
    ),
    "git_status": ToolSpec(
        title="Git status",
        description="Return git working tree status for the workspace.",
        read_only=True,
        idempotent=True,
    ),
    "git_diff": ToolSpec(
        title="Git diff",
        description="Return unified git diff for workspace changes.",
        read_only=True,
        idempotent=True,
    ),
    "git_log": ToolSpec(
        title="Git log",
        description="Return recent git commits with bounded structured metadata.",
        read_only=True,
        idempotent=True,
    ),
    "git_show": ToolSpec(
        title="Git show",
        description="Return bounded git show output for a revision.",
        read_only=True,
        idempotent=True,
    ),
    "git_blame": ToolSpec(
        title="Git blame",
        description="Return bounded git blame metadata for a workspace file.",
        read_only=True,
        idempotent=True,
    ),
    "request_permissions": ToolSpec(
        title="Request permissions",
        description="Report scoped permission-request status without silently granting operations.",
        read_only=True,
    ),
    "remember_context": ToolSpec(
        title="Remember long-term context",
        description=(
            "Save one stable, long-lived, reusable fact that will materially improve future collaboration. "
            "Call this proactively when the user clearly states non-sensitive information likely to remain useful across future turns, such as a durable preference or working style, a standing project rule, or an enduring project decision. "
            "The model is the primary writer: summarize the durable meaning rather than copying conversation text. Automatic page observation is discovery-only. "
            "Do NOT call it for one-off questions, temporary bugs, ordinary chat, transient task state, guesses, passwords, tokens, payment credentials, or sensitive personal information."
        ),
        destructive=True,
        idempotent=True,
    ),
    "view_image": ToolSpec(
        title="View image",
        description="Return a workspace image as MCP image content.",
        read_only=True,
        idempotent=True,
        content_builder=_image_content,
        gated_by="enable_view_image",
    ),
}
