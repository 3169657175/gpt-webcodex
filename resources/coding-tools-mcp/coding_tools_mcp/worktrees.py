from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .errors import ToolFailure


RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")
MAX_WORKTREES = 32
MAX_DIFF_BYTES = 262_144
MAX_SNAPSHOT_FILES = 500
MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024
MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024
MAX_APPLY_FILES = 500
MAX_APPLY_TOTAL_BYTES = 128 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _hidden_process_kwargs() -> dict[str, int]:
    if os.name != "nt":
        return {}
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": flag} if flag else {}


class WorktreeManager:
    """Workspace-local Git worktree isolation keyed by durable task run_id.

    This layer intentionally does not merge results back. It creates a private
    snapshot baseline inside the isolated branch, including bounded uncommitted
    primary-worktree changes, without modifying the user's primary index/files.
    """

    def __init__(self, workspace: Path, git_path: str | None = None) -> None:
        self.workspace = workspace.expanduser().resolve(strict=True)
        self.git = git_path or shutil.which("git")
        self.state_dir = self.workspace / ".coding-tools"
        self.root = self.state_dir / "worktrees"
        self.metadata_path = self.state_dir / "worktrees.json"
        self._lock = threading.RLock()

    def _require_git(self) -> str:
        if not self.git:
            raise ToolFailure("GIT_NOT_FOUND", "Git is required for isolated worktrees.", category="runtime")
        return self.git

    def _run(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        timeout: int = 20,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        git = self._require_git()
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        try:
            return subprocess.run(
                [git, *args],
                cwd=str(cwd or self.workspace),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                env=process_env,
                **_hidden_process_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            raise ToolFailure("GIT_TIMEOUT", "Git worktree operation timed out.", category="runtime", retryable=True) from exc
        except OSError as exc:
            raise ToolFailure("GIT_ERROR", str(exc), category="runtime", retryable=True) from exc

    @staticmethod
    def _safe_run_id(run_id: str) -> str:
        value = str(run_id or "").strip()
        if not RUN_ID_RE.fullmatch(value):
            raise ToolFailure("INVALID_ARGUMENT", "run_id must contain only letters, numbers, '_' or '-' (4-128 chars).", category="validation")
        return value

    def _repo_root(self) -> Path:
        completed = self._run(["-C", str(self.workspace), "rev-parse", "--show-toplevel"])
        if completed.returncode != 0:
            raise ToolFailure("NOT_GIT_REPOSITORY", "Current workspace is not a Git repository.", category="validation")
        root = Path(completed.stdout.strip()).resolve(strict=True)
        if os.path.normcase(str(root)) != os.path.normcase(str(self.workspace)):
            raise ToolFailure(
                "WORKSPACE_NOT_GIT_ROOT",
                "Git worktree isolation currently requires the configured workspace itself to be the Git repository root.",
                category="validation",
                details={"workspace": str(self.workspace), "git_root": str(root)},
            )
        return root

    def _primary_status_entries(self) -> list[str]:
        completed = self._run(["-C", str(self.workspace), "status", "--porcelain=v1", "--untracked-files=all"])
        if completed.returncode != 0:
            raise ToolFailure("GIT_ERROR", completed.stderr.strip() or "git status failed", category="runtime")
        return [
            line for line in completed.stdout.splitlines()
            if line and ".coding-tools/" not in line.replace("\\", "/")
        ]

    @staticmethod
    def _is_within(root: Path, target: Path) -> bool:
        try:
            target.relative_to(root)
            return True
        except ValueError:
            return False

    def _untracked_paths(self) -> list[str]:
        completed = self._run([
            "-C", str(self.workspace), "ls-files", "--others", "--exclude-standard", "-z",
        ])
        if completed.returncode != 0:
            raise ToolFailure("GIT_ERROR", completed.stderr.strip() or "git ls-files failed", category="runtime")
        paths = [item for item in completed.stdout.split("\0") if item]
        return [item for item in paths if not item.replace("\\", "/").startswith(".coding-tools/")]

    def _stage_directory_state(
        self,
        directory: Path,
        *,
        env: dict[str, str] | None = None,
        error_code: str,
    ) -> None:
        """Stage the visible working-tree state without ever pathspec'ing ignored directories."""
        updated = self._run(["-C", str(directory), "add", "-u", "--", "."], env=env)
        if updated.returncode != 0:
            raise ToolFailure(error_code, updated.stderr.strip() or "git add -u failed", category="runtime")
        # Tracked modifications/deletions are already fully handled by git add -u.
        # The second pass only needs genuinely new, non-ignored files. Including
        # --cached here re-feeds historically tracked paths that may now be
        # ignored (for example old __pycache__ entries) and can make Git reject
        # an otherwise valid snapshot.
        candidates = self._run([
            "-C", str(directory), "ls-files", "--others", "--exclude-standard", "-z",
        ])
        if candidates.returncode != 0:
            raise ToolFailure(error_code, candidates.stderr.strip() or "git ls-files failed", category="runtime")
        paths = [
            item for item in candidates.stdout.split("\0")
            if item and item.replace("\\", "/") != ".coding-tools" and not item.replace("\\", "/").startswith(".coding-tools/")
        ]
        # `git add -u` above already stages deletions. Do not feed those now-missing
        # paths back into a second `git add`, otherwise Git raises
        # `fatal: pathspec '<deleted file>' did not match any files`.
        paths = [
            item for item in paths
            if directory.joinpath(*self._safe_relative_parts(item)).exists()
        ]
        if not paths:
            return
        index_path = Path((env or {}).get("GIT_INDEX_FILE") or self.state_dir / "index")
        pathspec_file = index_path.with_name(f".{index_path.name}.paths-{os.getpid()}-{threading.get_ident()}")
        try:
            pathspec_file.parent.mkdir(parents=True, exist_ok=True)
            pathspec_file.write_bytes(b"\0".join(item.encode("utf-8") for item in paths) + b"\0")
            added = self._run([
                "--literal-pathspecs", "-C", str(directory), "add",
                f"--pathspec-from-file={pathspec_file}", "--pathspec-file-nul",
            ], env=env)
            if added.returncode != 0:
                raise ToolFailure(error_code, added.stderr.strip() or "git add path list failed", category="runtime")
        finally:
            pathspec_file.unlink(missing_ok=True)

    def _copy_untracked_snapshot(self, worktree: Path) -> tuple[int, int]:
        paths = self._untracked_paths()
        if len(paths) > MAX_SNAPSHOT_FILES:
            raise ToolFailure(
                "SNAPSHOT_TOO_LARGE",
                f"Primary workspace has more than {MAX_SNAPSHOT_FILES} untracked files; refusing to copy them into an isolated snapshot.",
                category="validation",
                details={"untracked_count": len(paths), "max_files": MAX_SNAPSHOT_FILES},
            )
        total = 0
        copied = 0
        for relative in paths:
            source = self.workspace / relative
            if source.is_symlink():
                raise ToolFailure(
                    "UNSAFE_SNAPSHOT_PATH",
                    "Untracked symbolic links are not copied into isolated snapshots.",
                    category="validation",
                    details={"path": relative},
                )
            try:
                resolved = source.resolve(strict=True)
            except OSError as exc:
                raise ToolFailure("SNAPSHOT_READ_FAILED", str(exc), category="runtime", details={"path": relative}) from exc
            if not self._is_within(self.workspace, resolved) or not resolved.is_file():
                raise ToolFailure(
                    "UNSAFE_SNAPSHOT_PATH",
                    "Only ordinary untracked files contained by the primary workspace can be snapshotted.",
                    category="validation",
                    details={"path": relative},
                )
            size = resolved.stat().st_size
            if size > MAX_SNAPSHOT_FILE_BYTES:
                raise ToolFailure(
                    "SNAPSHOT_TOO_LARGE",
                    "An untracked file is too large for the isolated snapshot.",
                    category="validation",
                    details={"path": relative, "size": size, "max_file_bytes": MAX_SNAPSHOT_FILE_BYTES},
                )
            total += size
            if total > MAX_SNAPSHOT_TOTAL_BYTES:
                raise ToolFailure(
                    "SNAPSHOT_TOO_LARGE",
                    "Untracked files exceed the isolated snapshot size limit.",
                    category="validation",
                    details={"total_bytes": total, "max_total_bytes": MAX_SNAPSHOT_TOTAL_BYTES},
                )
            target = worktree / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(resolved, target)
            copied += 1
        return copied, total

    def _snapshot_primary_into_worktree(self, worktree: Path, base_commit: str, run_id: str) -> dict[str, Any]:
        primary_entries = self._primary_status_entries()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        untracked_count = 0
        untracked_bytes = 0
        patch_bytes = 0
        with tempfile.TemporaryDirectory(prefix="coding-tools-snapshot-index-", dir=self.state_dir) as temp:
            index_env = {"GIT_INDEX_FILE": str(Path(temp) / "index")}
            loaded = self._run(["-C", str(self.workspace), "read-tree", base_commit], env=index_env)
            if loaded.returncode != 0:
                raise ToolFailure("SNAPSHOT_STAGE_FAILED", loaded.stderr.strip() or "git read-tree failed", category="runtime")
            self._stage_directory_state(self.workspace, env=index_env, error_code="SNAPSHOT_STAGE_FAILED")
            names = self._run([
                "-C", str(self.workspace), "diff", "--cached", "--name-only", "-z", "--no-renames", base_commit,
                "--", ".", ":(exclude).coding-tools", ":(exclude).coding-tools/**",
            ], env=index_env)
            if names.returncode != 0:
                raise ToolFailure("SNAPSHOT_STAGE_FAILED", names.stderr.strip() or "git diff failed", category="runtime")
            tracked_diff = self._run([
                "-C", str(self.workspace), "diff", "--cached", "--binary", base_commit,
                "--", ".", ":(exclude).coding-tools", ":(exclude).coding-tools/**",
            ], timeout=30, env=index_env)
            if tracked_diff.returncode == 0:
                patch_bytes = len(tracked_diff.stdout.encode("utf-8", errors="replace"))
            paths = [item for item in names.stdout.split("\0") if item]
            prefix = str(worktree.resolve()) + os.sep
            for relative in paths:
                self._safe_relative_parts(relative)
                baseline_entry = self._tree_entry(base_commit, relative)
                desired_entry = self._index_entry(self.workspace, index_env, relative)
                target = worktree.joinpath(*self._safe_relative_parts(relative))
                if desired_entry is None:
                    if target.exists():
                        if target.is_symlink() or not target.is_file():
                            raise ToolFailure("SNAPSHOT_STAGE_FAILED", "Snapshot deletion target is not a normal file.", category="runtime", details={"path": relative})
                        target.unlink()
                    continue
                if baseline_entry is None:
                    source = self.workspace.joinpath(*self._safe_relative_parts(relative))
                    if source.is_symlink() or not source.is_file():
                        raise ToolFailure("UNSAFE_SNAPSHOT_PATH", "New snapshot entries must be ordinary files.", category="validation", details={"path": relative})
                    size = source.stat().st_size
                    if size > MAX_SNAPSHOT_FILE_BYTES:
                        raise ToolFailure("SNAPSHOT_TOO_LARGE", "A new snapshot file is too large.", category="validation", details={"path": relative, "size": size, "max_file_bytes": MAX_SNAPSHOT_FILE_BYTES})
                    untracked_count += 1
                    untracked_bytes += size
                    if untracked_count > MAX_SNAPSHOT_FILES or untracked_bytes > MAX_SNAPSHOT_TOTAL_BYTES:
                        raise ToolFailure("SNAPSHOT_TOO_LARGE", "New snapshot files exceed safe limits.", category="validation", details={"untracked_count": untracked_count, "untracked_bytes": untracked_bytes})
                checked_out = self._run([
                    "-C", str(self.workspace), "checkout-index", "--force", f"--prefix={prefix}", "--", relative,
                ], env=index_env)
                if checked_out.returncode != 0:
                    raise ToolFailure("SNAPSHOT_STAGE_FAILED", checked_out.stderr.strip() or "git checkout-index failed", category="runtime", details={"path": relative})
        self._stage_directory_state(worktree, error_code="SNAPSHOT_STAGE_FAILED")
        changed = self._run(["-C", str(worktree), "diff", "--cached", "--quiet", base_commit])
        snapshot_commit = base_commit
        if changed.returncode == 1:
            committed = self._run([
                "-C", str(worktree),
                "-c", "user.name=Coding Tools Snapshot",
                "-c", "user.email=snapshot@local.invalid",
                "commit", "--no-gpg-sign", "--no-verify", "-m", f"Coding Tools snapshot {run_id}",
            ], timeout=60)
            if committed.returncode != 0:
                raise ToolFailure("SNAPSHOT_COMMIT_FAILED", committed.stderr.strip() or "git commit failed", category="runtime")
            head = self._run(["-C", str(worktree), "rev-parse", "HEAD"])
            if head.returncode != 0:
                raise ToolFailure("SNAPSHOT_COMMIT_FAILED", head.stderr.strip() or "cannot read snapshot commit", category="runtime")
            snapshot_commit = head.stdout.strip()
        elif changed.returncode != 0:
            raise ToolFailure("SNAPSHOT_STAGE_FAILED", changed.stderr.strip() or "git diff --cached failed", category="runtime")
        return {
            "snapshot_commit": snapshot_commit,
            "snapshot_dirty": bool(primary_entries),
            "snapshot_changed_count": len(primary_entries),
            "snapshot_tracked_patch_bytes": patch_bytes,
            "snapshot_untracked_count": untracked_count,
            "snapshot_untracked_bytes": untracked_bytes,
        }

    def _ensure_excluded(self) -> None:
        git_dir = self._run(["-C", str(self.workspace), "rev-parse", "--git-dir"])
        if git_dir.returncode != 0:
            return
        raw = git_dir.stdout.strip()
        directory = Path(raw) if Path(raw).is_absolute() else self.workspace / raw
        exclude = directory.resolve(strict=False) / "info" / "exclude"
        try:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            current = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
            rules = (".coding-tools/", ".coding-tools/worktrees/", ".coding-tools/worktrees.json")
            existing = set(current.splitlines())
            missing = [rule for rule in rules if rule not in existing]
            if missing:
                with exclude.open("a", encoding="utf-8", newline="\n") as handle:
                    if current and not current.endswith("\n"):
                        handle.write("\n")
                    for rule in missing:
                        handle.write(rule + "\n")
        except OSError:
            pass

    def _read_metadata(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        # Never forget still-existing worktrees merely because the metadata
        # list crossed a display limit. Orphaned Git worktrees can otherwise
        # accumulate gigabytes while becoming invisible to the cleanup UI.
        return [item for item in raw if isinstance(item, dict)]

    def _write_metadata(self, records: list[dict[str, Any]]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temp = self.metadata_path.with_name(f".{self.metadata_path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        temp.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.metadata_path)

    def _refresh_record(self, record: dict[str, Any]) -> dict[str, Any]:
        result = dict(record)
        path = Path(str(result.get("path") or ""))
        result["exists"] = path.exists() and path.is_dir()
        if result["exists"]:
            status = self._run(["-C", str(path), "status", "--porcelain=v1", "-b"])
            result["clean"] = status.returncode == 0 and not any(
                line and not line.startswith("## ") for line in status.stdout.splitlines()
            )
            result["status_summary"] = status.stdout.strip()[:8000]
        else:
            result["clean"] = False
            result["status_summary"] = "worktree directory is missing"
        return result

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._refresh_record(item) for item in self._read_metadata()]

    def get(self, run_id: str) -> dict[str, Any]:
        run_id = self._safe_run_id(run_id)
        with self._lock:
            record = next((item for item in reversed(self._read_metadata()) if str(item.get("run_id") or "") == run_id), None)
            if record is None:
                raise ToolFailure("NOT_FOUND", "No isolated worktree exists for this run_id.", category="not_found")
            return self._refresh_record(record)

    def create(self, run_id: str, *, objective: str = "", base_ref: str = "HEAD") -> dict[str, Any]:
        run_id = self._safe_run_id(run_id)
        base_ref = str(base_ref or "HEAD").strip() or "HEAD"
        if len(base_ref) > 200 or any(char in base_ref for char in "\r\n\0"):
            raise ToolFailure("INVALID_ARGUMENT", "Invalid base_ref.", category="validation")
        with self._lock:
            self._repo_root()
            existing = next((item for item in reversed(self._read_metadata()) if str(item.get("run_id") or "") == run_id), None)
            if existing and Path(str(existing.get("path") or "")).is_dir():
                return self._refresh_record(existing)
            # A large untracked tree cannot be snapshotted safely. Check before
            # creating a branch/worktree or staging the temporary snapshot index.
            untracked_count = len(self._untracked_paths())
            if untracked_count > MAX_SNAPSHOT_FILES:
                raise ToolFailure(
                    "SNAPSHOT_TOO_LARGE",
                    f"当前工作区有 {untracked_count} 个未跟踪文件，隔离快照上限为 {MAX_SNAPSHOT_FILES} 个。"
                    "请先忽略生成文件，或明确选择 isolation=off 直接工作区流程；尚未创建 Worktree。",
                    category="validation",
                    details={"untracked_count": untracked_count, "max_files": MAX_SNAPSHOT_FILES, "worktree_created": False},
                )
            self.cleanup(retention_days=7, keep=5)
            live_records = [item for item in self._read_metadata() if Path(str(item.get("path") or "")).is_dir()]
            if len(live_records) >= MAX_WORKTREES:
                raise ToolFailure(
                    "WORKTREE_LIMIT",
                    "Too many isolated worktrees are retained. Apply or discard old tasks before starting another isolated run.",
                    category="validation",
                    details={"count": len(live_records), "limit": MAX_WORKTREES},
                )
            self._ensure_excluded()
            base = self._run(["-C", str(self.workspace), "rev-parse", "--verify", f"{base_ref}^{{commit}}"])
            if base.returncode != 0:
                raise ToolFailure("GIT_REF_NOT_FOUND", base.stderr.strip() or f"Git ref not found: {base_ref}", category="validation")
            base_commit = base.stdout.strip()
            short = re.sub(r"[^A-Za-z0-9_-]", "-", run_id)[:24]
            branch = f"coding-tools/run-{short}"
            path = self.root / short
            if path.exists():
                raise ToolFailure("WORKTREE_PATH_EXISTS", "The isolated worktree path already exists; inspect or discard it before retrying.", category="validation", details={"path": str(path)})
            branch_check = self._run(["-C", str(self.workspace), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
            command = ["-C", str(self.workspace), "worktree", "add"]
            if branch_check.returncode == 0:
                command.extend([str(path), branch])
            else:
                command.extend(["-b", branch, str(path), base_commit])
            added = self._run(command, timeout=60)
            if added.returncode != 0:
                raise ToolFailure("WORKTREE_CREATE_FAILED", added.stderr.strip() or added.stdout.strip() or "git worktree add failed", category="runtime")
            try:
                snapshot = self._snapshot_primary_into_worktree(path, base_commit, run_id)
            except Exception:
                self._run(["-C", str(self.workspace), "worktree", "remove", "--force", str(path)], timeout=60)
                if branch_check.returncode != 0:
                    self._run(["-C", str(self.workspace), "branch", "-D", branch])
                raise
            record = {
                "run_id": run_id,
                "objective": str(objective or "")[:2000],
                "path": str(path),
                "branch": branch,
                "base_ref": base_ref,
                "base_commit": base_commit,
                **snapshot,
                "created_at": utc_now(),
                "status": "active",
            }
            records = [item for item in self._read_metadata() if str(item.get("run_id") or "") != run_id]
            records.append(record)
            self._write_metadata(records)
            return self._refresh_record(record)

    def diff(self, run_id: str, *, max_bytes: int = MAX_DIFF_BYTES) -> dict[str, Any]:
        record = self.get(run_id)
        path = Path(record["path"])
        limit = max(1024, min(int(max_bytes or MAX_DIFF_BYTES), 1_048_576))
        baseline = str(record.get("snapshot_commit") or record["base_commit"])
        with tempfile.TemporaryDirectory(prefix="coding-tools-index-") as temp:
            index_path = Path(temp) / "index"
            index_env = {"GIT_INDEX_FILE": str(index_path)}
            loaded = self._run(["-C", str(path), "read-tree", baseline], env=index_env)
            if loaded.returncode != 0:
                raise ToolFailure("GIT_DIFF_FAILED", loaded.stderr.strip() or "git read-tree failed", category="runtime")
            self._stage_directory_state(path, env=index_env, error_code="GIT_DIFF_FAILED")
            completed = self._run([
                "-C", str(path), "diff", "--cached", "--binary", baseline, "--", ".", ":(exclude).coding-tools", ":(exclude).coding-tools/**",
            ], timeout=30, env=index_env)
            if completed.returncode != 0:
                raise ToolFailure("GIT_DIFF_FAILED", completed.stderr.strip() or "git diff failed", category="runtime")
        raw = completed.stdout.encode("utf-8", errors="replace")
        truncated = len(raw) > limit
        text = raw[:limit].decode("utf-8", errors="replace")
        status = self._run(["-C", str(path), "status", "--porcelain=v1"])
        entries = [line for line in status.stdout.splitlines() if line]
        return {
            "run_id": run_id,
            "path": str(path),
            "branch": record["branch"],
            "base_commit": record["base_commit"],
            "snapshot_commit": baseline,
            "changed_count": len(entries),
            "status": entries[:200],
            "diff": text,
            "truncated": truncated,
        }

    @staticmethod
    def _safe_relative_parts(relative: str) -> tuple[str, ...]:
        raw = str(relative or "").replace("\\", "/")
        pure = PurePosixPath(raw)
        parts = tuple(part for part in pure.parts if part not in {"", "."})
        if not parts or pure.is_absolute() or ".." in parts or parts[0] == ".coding-tools":
            raise ToolFailure(
                "UNSAFE_APPLY_PATH",
                "Isolated changes contain a path that cannot be safely applied to the primary workspace.",
                category="security",
                details={"path": raw},
            )
        return parts

    def _safe_primary_target(self, relative: str) -> Path:
        parts = self._safe_relative_parts(relative)
        current = self.workspace
        for part in parts[:-1]:
            current = current / part
            if current.exists() and (current.is_symlink() or not current.is_dir()):
                raise ToolFailure(
                    "WORKTREE_APPLY_CONFLICT",
                    "A primary-workspace parent path is not a normal directory.",
                    category="validation",
                    details={"path": relative, "parent": str(current)},
                )
        target = self.workspace.joinpath(*parts)
        if target.is_symlink():
            raise ToolFailure(
                "WORKTREE_APPLY_CONFLICT",
                "Symbolic-link targets are not modified by safe apply-back.",
                category="validation",
                details={"path": relative},
            )
        resolved = target.resolve(strict=False)
        if not self._is_within(self.workspace, resolved):
            raise ToolFailure("UNSAFE_APPLY_PATH", "Apply-back target escaped the primary workspace.", category="security", details={"path": relative})
        return target

    def _tree_entry(self, commit: str, relative: str) -> dict[str, str] | None:
        completed = self._run(["-C", str(self.workspace), "ls-tree", "-z", commit, "--", relative])
        if completed.returncode != 0:
            raise ToolFailure("GIT_ERROR", completed.stderr.strip() or "git ls-tree failed", category="runtime")
        if not completed.stdout:
            return None
        prefix = completed.stdout.split("\0", 1)[0].split("\t", 1)[0]
        fields = prefix.split()
        if len(fields) < 3:
            return None
        mode, kind, blob = fields[:3]
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise ToolFailure("UNSUPPORTED_WORKTREE_CHANGE", "Safe apply-back supports ordinary Git files only.", category="validation", details={"path": relative, "mode": mode, "kind": kind})
        return {"mode": mode, "hash": blob}

    def _index_entry(self, worktree: Path, index_env: dict[str, str], relative: str) -> dict[str, str] | None:
        completed = self._run(["-C", str(worktree), "ls-files", "--stage", "-z", "--", relative], env=index_env)
        if completed.returncode != 0:
            raise ToolFailure("GIT_ERROR", completed.stderr.strip() or "git ls-files failed", category="runtime")
        if not completed.stdout:
            return None
        prefix = completed.stdout.split("\0", 1)[0].split("\t", 1)[0]
        fields = prefix.split()
        if len(fields) < 3:
            return None
        mode, blob, stage = fields[:3]
        if stage != "0" or mode not in {"100644", "100755"}:
            raise ToolFailure("UNSUPPORTED_WORKTREE_CHANGE", "Safe apply-back supports ordinary Git files only.", category="validation", details={"path": relative, "mode": mode, "stage": stage})
        return {"mode": mode, "hash": blob}

    def _primary_entry(self, relative: str) -> dict[str, str] | None:
        target = self._safe_primary_target(relative)
        if not target.exists():
            return None
        if not target.is_file():
            raise ToolFailure("WORKTREE_APPLY_CONFLICT", "A primary-workspace target is not a normal file.", category="validation", details={"path": relative})
        completed = self._run(["-C", str(self.workspace), "hash-object", f"--path={relative}", "--", relative])
        if completed.returncode != 0:
            raise ToolFailure("GIT_ERROR", completed.stderr.strip() or "git hash-object failed", category="runtime")
        mode = "100644"
        if os.name != "nt":
            try:
                mode = "100755" if target.stat().st_mode & 0o111 else "100644"
            except OSError:
                pass
        return {"mode": mode, "hash": completed.stdout.strip()}

    @staticmethod
    def _entry_equal(left: dict[str, str] | None, right: dict[str, str] | None) -> bool:
        if left is None or right is None:
            return left is right
        if left.get("hash") != right.get("hash"):
            return False
        return os.name == "nt" or left.get("mode") == right.get("mode")

    def _checkout_desired_file(self, worktree: Path, index_env: dict[str, str], staging: Path, relative: str) -> Path:
        prefix = str(staging.resolve()) + os.sep
        completed = self._run(["-C", str(worktree), "checkout-index", "--force", f"--prefix={prefix}", "--", relative], env=index_env)
        if completed.returncode != 0:
            raise ToolFailure("WORKTREE_APPLY_PREPARE_FAILED", completed.stderr.strip() or "git checkout-index failed", category="runtime")
        target = staging.joinpath(*self._safe_relative_parts(relative))
        if not target.is_file() or target.is_symlink():
            raise ToolFailure("WORKTREE_APPLY_PREPARE_FAILED", "Git did not materialize a normal staged file.", category="runtime", details={"path": relative})
        return target

    def _apply_change(self, change: dict[str, Any], staging: Path) -> None:
        relative = str(change["path"])
        target = self._safe_primary_target(relative)
        desired = change.get("desired")
        if desired is None:
            if target.exists():
                target.unlink()
            return
        source = staging.joinpath(*self._safe_relative_parts(relative))
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(f".{target.name}.coding-tools-{os.getpid()}-{threading.get_ident()}.tmp")
        try:
            shutil.copy2(source, temp)
            os.replace(temp, target)
            if os.name != "nt":
                mode = target.stat().st_mode
                target.chmod((mode | 0o111) if desired.get("mode") == "100755" else (mode & ~0o111))
        finally:
            temp.unlink(missing_ok=True)

    def _rollback_changes(self, applied: list[dict[str, Any]], backup: Path) -> None:
        for change in reversed(applied):
            relative = str(change["path"])
            target = self._safe_primary_target(relative)
            original = change.get("current")
            if original is None:
                if target.exists() and target.is_file() and not target.is_symlink():
                    target.unlink()
                parent = target.parent
                while parent != self.workspace:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
                continue
            source = backup.joinpath(*self._safe_relative_parts(relative))
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(f".{target.name}.coding-tools-rollback-{os.getpid()}-{threading.get_ident()}.tmp")
            try:
                shutil.copy2(source, temp)
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)

    def apply_back(self, run_id: str) -> dict[str, Any]:
        """Apply only the isolated assistant delta while preserving the primary Git index."""
        run_id = self._safe_run_id(run_id)
        with self._lock:
            record = self.get(run_id)
            worktree = Path(str(record["path"])).resolve(strict=True)
            baseline = str(record.get("snapshot_commit") or record["base_commit"])
            self.state_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="coding-tools-apply-", dir=self.state_dir) as temp:
                temp_root = Path(temp)
                index_env = {"GIT_INDEX_FILE": str(temp_root / "index")}
                staging = temp_root / "staging"
                backup = temp_root / "backup"
                staging.mkdir()
                backup.mkdir()
                loaded = self._run(["-C", str(worktree), "read-tree", baseline], env=index_env)
                if loaded.returncode != 0:
                    raise ToolFailure("WORKTREE_APPLY_PREPARE_FAILED", loaded.stderr.strip() or "git read-tree failed", category="runtime")
                self._stage_directory_state(worktree, env=index_env, error_code="WORKTREE_APPLY_PREPARE_FAILED")
                names = self._run(["-C", str(worktree), "diff", "--cached", "--name-only", "-z", "--no-renames", baseline, "--", ".", ":(exclude).coding-tools", ":(exclude).coding-tools/**"], env=index_env)
                if names.returncode != 0:
                    raise ToolFailure("WORKTREE_APPLY_PREPARE_FAILED", names.stderr.strip() or "git diff failed", category="runtime")
                paths = [item for item in names.stdout.split("\0") if item]
                if len(paths) > MAX_APPLY_FILES:
                    raise ToolFailure("WORKTREE_APPLY_TOO_LARGE", "Too many isolated files changed for safe apply-back.", category="validation", details={"changed_count": len(paths), "max_files": MAX_APPLY_FILES})

                plan: list[dict[str, Any]] = []
                conflicts: list[dict[str, Any]] = []
                total_bytes = 0
                for relative in paths:
                    self._safe_relative_parts(relative)
                    baseline_entry = self._tree_entry(baseline, relative)
                    desired_entry = self._index_entry(worktree, index_env, relative)
                    current_entry = self._primary_entry(relative)
                    if self._entry_equal(current_entry, desired_entry):
                        plan.append({"path": relative, "baseline": baseline_entry, "desired": desired_entry, "current": current_entry, "action": "already_applied"})
                        continue
                    if not self._entry_equal(current_entry, baseline_entry):
                        conflicts.append({"path": relative, "reason": "primary_path_changed_since_snapshot", "baseline_hash": baseline_entry.get("hash") if baseline_entry else None, "current_hash": current_entry.get("hash") if current_entry else None, "desired_hash": desired_entry.get("hash") if desired_entry else None})
                        continue
                    action = "delete" if desired_entry is None else "write"
                    item = {"path": relative, "baseline": baseline_entry, "desired": desired_entry, "current": current_entry, "action": action}
                    if desired_entry is not None:
                        staged_file = self._checkout_desired_file(worktree, index_env, staging, relative)
                        total_bytes += staged_file.stat().st_size
                        if total_bytes > MAX_APPLY_TOTAL_BYTES:
                            raise ToolFailure("WORKTREE_APPLY_TOO_LARGE", "Isolated result exceeds safe apply-back size limit.", category="validation", details={"total_bytes": total_bytes, "max_total_bytes": MAX_APPLY_TOTAL_BYTES})
                    plan.append(item)
                if conflicts:
                    raise ToolFailure("WORKTREE_APPLY_CONFLICT", "Primary workspace changed on one or more paths touched by the isolated task. No files were applied.", category="validation", details={"conflicts": conflicts, "conflict_count": len(conflicts)})

                pending = [item for item in plan if item["action"] != "already_applied"]
                for item in pending:
                    target = self._safe_primary_target(str(item["path"]))
                    if item.get("current") is not None:
                        backup_path = backup.joinpath(*self._safe_relative_parts(str(item["path"])))
                        backup_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(target, backup_path)

                applied: list[dict[str, Any]] = []
                try:
                    for item in pending:
                        if not self._entry_equal(self._primary_entry(str(item["path"])), item.get("current")):
                            raise ToolFailure("WORKTREE_APPLY_CONFLICT", "Primary workspace changed while apply-back was in progress.", category="validation", details={"path": item["path"]})
                        self._apply_change(item, staging)
                        applied.append(item)
                    for item in pending:
                        if not self._entry_equal(self._primary_entry(str(item["path"])), item.get("desired")):
                            raise ToolFailure("WORKTREE_APPLY_VERIFY_FAILED", "Applied file did not match the isolated result.", category="runtime", details={"path": item["path"]})
                except Exception as exc:
                    try:
                        self._rollback_changes(applied, backup)
                    except Exception as rollback_exc:
                        raise ToolFailure("WORKTREE_APPLY_ROLLBACK_FAILED", f"Apply failed and rollback also failed: {rollback_exc}", category="runtime", retryable=False) from rollback_exc
                    if isinstance(exc, ToolFailure):
                        raise
                    raise ToolFailure("WORKTREE_APPLY_FAILED", str(exc), category="runtime", retryable=True) from exc

                applied_at = utc_now()
                records = self._read_metadata()
                for item in records:
                    if str(item.get("run_id") or "") == run_id:
                        item["status"] = "applied"
                        item["applied_at"] = applied_at
                        item["applied_changed_count"] = len(pending)
                        item["applied_paths"] = [str(entry["path"]) for entry in pending][:MAX_APPLY_FILES]
                        break
                self._write_metadata(records)
                return {"run_id": run_id, "applied": True, "applied_at": applied_at, "changed_count": len(pending), "already_applied_count": len(plan) - len(pending), "paths": [str(item["path"]) for item in pending], "worktree_retained": True, "primary_index_untouched": True}

    def discard(self, run_id: str) -> dict[str, Any]:
        run_id = self._safe_run_id(run_id)
        with self._lock:
            record = self.get(run_id)
            path = Path(record["path"])
            if path.exists():
                removed = self._run(["-C", str(self.workspace), "worktree", "remove", "--force", str(path)], timeout=60)
                if removed.returncode != 0:
                    raise ToolFailure("WORKTREE_REMOVE_FAILED", removed.stderr.strip() or "git worktree remove failed", category="runtime")
            branch = str(record.get("branch") or "")
            if branch:
                self._run(["-C", str(self.workspace), "branch", "-D", branch])
            records = [item for item in self._read_metadata() if str(item.get("run_id") or "") != run_id]
            self._write_metadata(records)
            self._run(["-C", str(self.workspace), "worktree", "prune"])
            return {"run_id": run_id, "discarded": True, "path": str(path), "branch": branch}

    def cleanup(self, *, retention_days: int = 7, keep: int = 5) -> dict[str, Any]:
        """Remove only worktrees that are provably disposable.

        Dirty unapplied worktrees are always retained. Applied worktrees are
        safe to remove because their delta has already been copied back.
        """
        with self._lock:
            try:
                self._repo_root()
            except ToolFailure:
                return {"removed": [], "retained": [], "reason": "not_git_repository"}
            records = self._read_metadata()
            now = datetime.now(timezone.utc)
            keep_count = max(1, min(int(keep or 5), MAX_WORKTREES))
            days = max(1, min(int(retention_days or 7), 365))
            refreshed = [self._refresh_record(item) for item in records]
            refreshed.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
            removed: list[dict[str, Any]] = []
            retained: list[dict[str, Any]] = []
            for index, record in enumerate(refreshed):
                path = Path(str(record.get("path") or ""))
                if not record.get("exists"):
                    removed.append({"run_id": record.get("run_id"), "path": str(path), "reason": "missing"})
                    continue
                created = None
                try:
                    created = datetime.fromisoformat(str(record.get("created_at") or "").replace("Z", "+00:00"))
                except ValueError:
                    pass
                old = bool(created and (now - created).total_seconds() >= days * 86400)
                applied = str(record.get("status") or "").lower() == "applied"
                snapshot_commit = str(record.get("snapshot_commit") or "")
                head_result = self._run(["-C", str(path), "rev-parse", "HEAD"])
                head_commit = head_result.stdout.strip() if head_result.returncode == 0 else ""
                baseline_unchanged = bool(snapshot_commit and head_commit == snapshot_commit)
                # A clean worktree can still contain committed-but-unapplied work.
                # Only an unchanged snapshot baseline is eligible for age/count GC.
                disposable_clean = bool(record.get("clean")) and baseline_unchanged and (old or index >= keep_count)
                if not (applied or disposable_clean):
                    retained.append(record)
                    continue
                branch = str(record.get("branch") or "")
                result = self._run(["-C", str(self.workspace), "worktree", "remove", "--force", str(path)], timeout=60)
                if result.returncode != 0:
                    retained.append(record)
                    continue
                if branch:
                    self._run(["-C", str(self.workspace), "branch", "-D", branch])
                removed.append({
                    "run_id": str(record.get("run_id") or ""),
                    "path": str(path),
                    "reason": "applied" if applied else "clean_expired",
                })
            retained_ids = {str(item.get("run_id") or "") for item in retained}
            self._write_metadata([item for item in records if str(item.get("run_id") or "") in retained_ids])
            self._run(["-C", str(self.workspace), "worktree", "prune"])
            return {
                "removed": removed,
                "retained": retained,
                "removed_count": len(removed),
                "retained_count": len(retained),
            }

    def recover(self) -> list[dict[str, Any]]:
        """Reconcile persisted metadata with Git after a runtime restart."""
        with self._lock:
            try:
                self._repo_root()
            except ToolFailure:
                return []
            self._run(["-C", str(self.workspace), "worktree", "prune"])
            records = self._read_metadata()
            recovered: list[dict[str, Any]] = []
            kept: list[dict[str, Any]] = []
            for record in records:
                refreshed = self._refresh_record(record)
                if refreshed.get("exists"):
                    kept.append(record)
                    recovered.append(refreshed)
            if len(kept) != len(records):
                self._write_metadata(kept)
            return recovered
