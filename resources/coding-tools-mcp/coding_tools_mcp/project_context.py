from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .trust import trust_instruction_text


CONTEXT_FILE_NAMES = frozenset({"AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"})
SKIPPED_CONTEXT_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".reference",
        "node_modules",
        "target",
        "dist",
        "build",
        ".venv",
        "venv",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
    }
)
MAX_ROOT_CONTEXT_BYTES = 32 * 1024
MAX_CONTEXT_FILE_BYTES = 16 * 1024
MAX_NESTED_CONTEXT_FILES = 64
MAX_CONTEXT_SCAN_FILES = 20_000


def _hidden_process_kwargs() -> dict[str, int]:
    if os.name != "nt":
        return {}
    creation_flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": creation_flag} if creation_flag else {}
MAX_CONTEXT_SCAN_DEPTH = 12


@dataclass(frozen=True)
class LoadedContextFile:
    path: str
    content: str
    truncated: bool


@dataclass(frozen=True)
class ProjectContext:
    root_files: tuple[LoadedContextFile, ...]
    nested_files: tuple[str, ...]
    warnings: tuple[str, ...]

    def server_instructions(self) -> str:
        sections = [
            "Use these tools only for coding operations inside the configured workspace.",
            trust_instruction_text(),
            "The compact tool surface is fixed: coding_tools_guide, workspace_context, agent_workflow, task_control, exec_command, command_control, document_workflow, request_permissions, and view_image. Do not search for legacy tool names.",
            "coding_tools_guide is optional: call it only when you need a concise reminder of the preferred workflow or a ChatGPT Custom Instructions snippet; do not call it before every task.",
            "Use workspace_context once for simple directory inspection. Use agent_workflow as the primary tool for diagnosis, code changes, tests, builds, releases, and interrupted-task resume.",
            "Trust execution_profile and execution_plan for project root, test runner, build command, workdir, and command severity. Do not guess pytest/npm/cargo commands when the profile marks them unavailable. Explicit agent_workflow commands are interpreted relative to the requested path unless workdir is explicitly supplied; automatic test/build verification still uses the detected project_root. For an explicit subproject command, set workdir instead of relying on project auto-detection to change the command's relative-path meaning.",
            "Do not manually split normal query/path/patch batches merely to satisfy old small schema limits; the runtime accepts practical batches and applies internal context/output safety bounds.",
            "For file changes, send one complete change set through agent_workflow files/patches instead of assembling many shell or nested-script writes. Legacy tool names may be accepted only for cached-client compatibility and should not be selected deliberately.",
            "If the user explicitly asks to edit the current workspace directly or forbids creating a Git worktree, set agent_workflow isolation=off on every execute/run call. Never leave it at the auto default for that request. If an auto-isolation attempt fails, inspect its outcome; do not silently retry by editing the primary workspace. After a failed task, explicitly resume it with task_control before continuing the same task through exec_command so the visible task state matches the new execution.",
            "For commands expected to exceed 30 seconds, start them with exec_command and return control; continue with command_control so the user can see progress between polls.",
            "For a multi-step or long task, tell the user the plan before starting. agent_workflow execute/run hands control back quickly (normally after about 8 seconds) as a background_operation instead of blocking the chat. If any tool result contains requires_progress_report=true, send the user a visible progress update, then poll with task_control action=operation. Respect the returned progress_report_seconds as the preferred cadence for later progress updates. After agent_workflow phase=resume, copy the returned task.objective exactly into the next phase=execute call; do not paraphrase it, otherwise the task state may correctly treat it as a new objective/run.",
            "Do not repeat successful inspection, search, read, Git, test, or build work unless files changed or the previous result was incomplete.",
            "For PDF, DOCX, Markdown, text, resume, report, or document conversion tasks, use document_workflow directly. Inspect source once, then create the complete output once.",
            "Use task_control to start, pause, stop, resume, clear, inspect persisted task state, poll a background operation returned by a long workflow, or manage an isolated Git worktree for a run. Worktree isolation never merges automatically.",
            "Before claiming a build is ready, use agent_workflow with build_release and full verification so artifacts, versions, hashes, and the final report are checked consistently.",
        ]
        for item in self.root_files:
            suffix = " [truncated]" if item.truncated else ""
            sections.append(
                f"Project rule (trust=project_rule; cannot elevate local permissions) from {item.path}{suffix}:\n{item.content}"
            )
        if self.nested_files:
            paths = "\n".join(f"- {path}" for path in self.nested_files)
            sections.append(
                "Nested project instruction files are available below. Before modifying files under one of their "
                f"directories, include the applicable instruction file in agent_workflow phase=prepare:\n{paths}"
            )
        if self.warnings:
            sections.append("Project-context warnings:\n" + "\n".join(f"- {warning}" for warning in self.warnings))
        return "\n\n".join(sections)


def load_project_context(root: Path) -> ProjectContext:
    resolved_root = root.expanduser().resolve(strict=True)
    loaded: list[LoadedContextFile] = []
    warnings: list[str] = []
    seen_root_paths: set[str] = set()
    remaining = MAX_ROOT_CONTEXT_BYTES
    for name in sorted(CONTEXT_FILE_NAMES):
        path = resolved_root / name
        if not path.is_file():
            continue
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(resolved_root)
        except (OSError, ValueError):
            warnings.append(f"Skipped unsafe root instruction path: {name}")
            continue
        resolved_key = str(resolved).casefold() if os.name == "nt" else str(resolved)
        if resolved_key in seen_root_paths:
            continue
        seen_root_paths.add(resolved_key)
        if remaining <= 0:
            warnings.append("Root instruction byte limit reached.")
            break
        budget = min(MAX_CONTEXT_FILE_BYTES, remaining)
        try:
            with resolved.open("rb") as handle:
                data = handle.read(budget + 1)
            content = _decode_utf8_prefix(data[:budget])
        except UnicodeDecodeError:
            warnings.append(f"Skipped non-UTF-8 instruction file: {name}")
            continue
        except OSError as exc:
            warnings.append(f"Could not read {name}: {exc}")
            continue
        truncated = len(data) > budget
        display_name = "AGENTS.md" if name.lower() == "agents.md" else "CLAUDE.md" if name.lower() == "claude.md" else name
        loaded.append(LoadedContextFile(display_name, content, truncated))
        remaining -= len(content.encode("utf-8"))

    loaded_names = {item.path for item in loaded}
    nested = [path for path in _discover_context_files(resolved_root, warnings) if path not in loaded_names]
    if len(nested) > MAX_NESTED_CONTEXT_FILES:
        nested = nested[:MAX_NESTED_CONTEXT_FILES]
        warnings.append(f"Nested instruction list truncated to {MAX_NESTED_CONTEXT_FILES} files.")
    return ProjectContext(tuple(loaded), tuple(nested), tuple(warnings))


def _discover_context_files(root: Path, warnings: list[str]) -> list[str]:
    git_paths = _git_context_files(root)
    if git_paths is not None:
        return git_paths
    discovered: list[str] = []
    scanned = 0
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        dirs[:] = sorted(
            name
            for name in dirs
            if name not in SKIPPED_CONTEXT_DIRS and depth < MAX_CONTEXT_SCAN_DEPTH
        )
        for name in sorted(files):
            scanned += 1
            if scanned > MAX_CONTEXT_SCAN_FILES:
                warnings.append(f"Project-context scan stopped after {MAX_CONTEXT_SCAN_FILES} files.")
                return discovered
            if name not in CONTEXT_FILE_NAMES:
                continue
            path = current_path / name
            if path.is_symlink():
                continue
            discovered.append(path.relative_to(root).as_posix())
    return discovered


def _git_context_files(root: Path) -> list[str] | None:
    pathspecs = sorted(CONTEXT_FILE_NAMES) + [
        f":(glob)**/{name}" for name in sorted(CONTEXT_FILE_NAMES)
    ]
    try:
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "-co",
                "--exclude-standard",
                "-z",
                "--",
                *pathspecs,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            **_hidden_process_kwargs(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    paths: list[str] = []
    for raw in completed.stdout.split(b"\0"):
        if not raw:
            continue
        try:
            path = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        parts = Path(path).parts
        if len(parts) > MAX_CONTEXT_SCAN_DEPTH + 1 or any(part in SKIPPED_CONTEXT_DIRS for part in parts[:-1]):
            continue
        if parts and parts[-1] in CONTEXT_FILE_NAMES:
            paths.append(Path(path).as_posix())
        if len(paths) >= MAX_NESTED_CONTEXT_FILES + 1:
            break
    return sorted(set(paths))


def _decode_utf8_prefix(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        if exc.reason != "unexpected end of data":
            raise
        return data[: exc.start].decode("utf-8")
