from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


PROJECT_IDENTITY_VERSION = 1
_REMOTE_SCP_RE = re.compile(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$")


def _hidden_process_kwargs() -> dict[str, int]:
    if os.name != "nt":
        return {}
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": flag} if flag else {}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:32]


def normalize_git_remote(value: str) -> str:
    """Return a credential-free canonical host/path identity for common Git remotes."""
    text = str(value or "").strip()
    if not text:
        return ""

    host = ""
    repo_path = ""
    scp_match = _REMOTE_SCP_RE.match(text) if "://" not in text and not re.match(r"^[A-Za-z]:[\\/]", text) else None
    if scp_match:
        host, repo_path = scp_match.group(1), scp_match.group(2)
    elif "://" in text:
        try:
            parsed = urlsplit(text)
            host = (parsed.hostname or "").strip().lower()
            repo_path = parsed.path or ""
        except ValueError:
            return ""
    else:
        return ""

    host = host.strip().lower().rstrip(".")
    repo_path = repo_path.replace("\\", "/").strip().lstrip("/").rstrip("/")
    if repo_path.lower().endswith(".git"):
        repo_path = repo_path[:-4]
    repo_path = re.sub(r"/{2,}", "/", repo_path)
    if not host or not repo_path:
        return ""
    return f"{host}/{repo_path}"


def _run_git(workspace: Path, git: str, *args: str) -> str:
    try:
        completed = subprocess.run(
            [git, "-C", str(workspace), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
            **_hidden_process_kwargs(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _project_name(workspace: Path) -> str:
    package = workspace / "package.json"
    try:
        payload = json.loads(package.read_text(encoding="utf-8"))
        name = str(payload.get("name") or "").strip()
        if name:
            return name[:160]
    except (OSError, ValueError, TypeError):
        pass

    pyproject = workspace / "pyproject.toml"
    try:
        text = pyproject.read_text(encoding="utf-8", errors="replace")[:65536]
        match = re.search(r"(?m)^name\s*=\s*['\"]([^'\"]+)['\"]\s*$", text)
        if match:
            return match.group(1).strip()[:160]
    except OSError:
        pass
    return workspace.name[:160] or "project"


def resolve_project_identity(workspace: Path, git_path: str | None = None) -> dict[str, Any]:
    root = workspace.expanduser().resolve(strict=True)
    name = _project_name(root)
    git = git_path or shutil.which("git")

    if git:
        remotes = _run_git(root, git, "remote").splitlines()
        ordered = ["origin", *[item.strip() for item in remotes if item.strip() and item.strip() != "origin"]]
        seen: set[str] = set()
        for remote_name in ordered:
            if remote_name in seen:
                continue
            seen.add(remote_name)
            raw = _run_git(root, git, "remote", "get-url", remote_name)
            canonical = normalize_git_remote(raw)
            if canonical:
                host, _, repo = canonical.partition("/")
                return {
                    "version": PROJECT_IDENTITY_VERSION,
                    "project_id": f"project_{_hash('remote:' + canonical)}",
                    "source": "git_remote",
                    "name": name,
                    "evidence": f"remote:{host}/{repo.split('/')[-1]}",
                }

        roots = _run_git(root, git, "rev-list", "--max-parents=0", "HEAD").splitlines()
        first_root = roots[0].strip() if roots else ""
        if first_root:
            return {
                "version": PROJECT_IDENTITY_VERSION,
                "project_id": f"project_{_hash('root:' + first_root + ':name:' + name)}",
                "source": "git_root",
                "name": name,
                "evidence": f"root:{first_root[:12]} · {name}",
            }

    basename = root.name or name
    fallback_key = f"name:{name}:folder:{basename}"
    return {
        "version": PROJECT_IDENTITY_VERSION,
        "project_id": f"project_{_hash(fallback_key)}",
        "source": "project_name",
        "name": name,
        "evidence": f"name:{name} · folder:{basename}",
    }


__all__ = ["PROJECT_IDENTITY_VERSION", "normalize_git_remote", "resolve_project_identity"]
