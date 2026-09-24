from __future__ import annotations

import codecs
import hashlib
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, BinaryIO

from .errors import ToolFailure
from .textutils import DEFAULT_MAX_LINES, TextTruncation, truncate_text_tail


SESSION_BUFFER_BYTES = 524_288
HARD_KILL_SIGNAL = getattr(signal, "SIGKILL", signal.SIGTERM)


@dataclass(frozen=True)
class DecodedCommandOutput:
    text: str
    encoding: str
    consumed_bytes: int
    pending_bytes: int
    had_replacement: bool
    newline_normalized: bool


def _normalize_output_newlines(text: str) -> tuple[str, bool]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return normalized, normalized != text


def _utf16_encoding_hint(data: bytes) -> str | None:
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    sample = data[:256]
    if len(sample) < 4:
        return None
    pairs = len(sample) // 2
    even_nuls = sum(1 for index in range(0, pairs * 2, 2) if sample[index] == 0)
    odd_nuls = sum(1 for index in range(1, pairs * 2, 2) if sample[index] == 0)
    if odd_nuls >= max(2, pairs // 3) and even_nuls <= max(1, pairs // 8):
        return "utf-16-le"
    if even_nuls >= max(2, pairs // 3) and odd_nuls <= max(1, pairs // 8):
        return "utf-16-be"
    return None


def _decode_strict_incremental(data: bytes, encoding: str, *, final: bool) -> DecodedCommandOutput | None:
    try:
        decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
        text = decoder.decode(data, final=final)
        pending = b"" if final else bytes(decoder.getstate()[0])
    except (LookupError, UnicodeDecodeError):
        return None
    normalized, changed = _normalize_output_newlines(text)
    return DecodedCommandOutput(
        normalized,
        encoding,
        len(data) - len(pending),
        len(pending),
        False,
        changed,
    )


def decode_command_output(data: bytes, *, final: bool = True) -> DecodedCommandOutput:
    """Decode command output without corrupting Windows encodings or split characters.

    Offsets remain raw-byte based.  While a process is running, an incomplete
    trailing code unit is intentionally left unconsumed so the next poll can
    decode it together with the next chunk.
    """
    if not data:
        return DecodedCommandOutput("", "utf-8", 0, 0, False, False)

    if not final and data in {b"\xef", b"\xef\xbb", b"\xff", b"\xfe"}:
        return DecodedCommandOutput("", "pending", 0, len(data), False, False)

    if data.startswith(codecs.BOM_UTF8):
        candidate = _decode_strict_incremental(data, "utf-8-sig", final=final)
        if candidate is not None:
            return candidate

    utf16_hint = _utf16_encoding_hint(data)
    if utf16_hint:
        candidate = _decode_strict_incremental(data, utf16_hint, final=final)
        if candidate is not None:
            return candidate

    candidate = _decode_strict_incremental(data, "utf-8", final=final)
    if candidate is not None:
        return candidate

    candidate = _decode_strict_incremental(data, "cp936", final=final)
    if candidate is not None:
        return candidate

    # Malformed terminal output must still be observable. Prefer UTF-8's
    # replacement behavior as the final deterministic fallback.
    text = data.decode("utf-8", errors="replace")
    normalized, changed = _normalize_output_newlines(text)
    return DecodedCommandOutput(normalized, "utf-8-replace", len(data), 0, True, changed)


def _iso_timestamp(value: float | None) -> str:
    if value is None:
        return ""
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _windows_taskkill_tree(process: subprocess.Popen[bytes], *, force: bool) -> None:
    """Terminate a Windows process tree so command sessions cannot leave orphan children."""
    if process.poll() is not None:
        return

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    def run_taskkill(hard: bool) -> None:
        command = ["taskkill.exe", "/PID", str(process.pid), "/T"]
        if hard:
            command.append("/F")
        subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
            creationflags=creationflags,
        )

    try:
        run_taskkill(force)
        try:
            process.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            if not force:
                run_taskkill(True)
                try:
                    process.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    process.kill()
            else:
                process.kill()
    except Exception:
        try:
            process.kill() if force else process.terminate()
            process.wait(timeout=1)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass


def terminate_process_group(
    process: subprocess.Popen[bytes],
    signum: signal.Signals,
    *,
    force: bool = False,
) -> None:
    if not hasattr(os, "killpg"):
        if os.name == "nt":
            _windows_taskkill_tree(process, force=force)
            return
        try:
            if force:
                process.kill()
            else:
                process.terminate()
            process.wait(timeout=1)
        except Exception:
            process.kill()
        return
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        return
    except Exception:
        process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, HARD_KILL_SIGNAL)
        except Exception:
            process.kill()


def spawn_process(
    command: Any,
    *,
    cwd: str,
    shell: bool,
    env: dict[str, str],
    tty: bool,
    popen_kwargs: dict[str, Any],
) -> tuple[subprocess.Popen[bytes], int | None]:
    """Spawn a pipe-backed or true POSIX PTY-backed process."""

    if not tty:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            shell=shell,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            **popen_kwargs,
        )
        return process, None
    if os.name == "nt":
        raise ToolFailure(
            "TTY_UNSUPPORTED",
            "tty=true requires ConPTY support, which is not available in this build.",
            category="runtime",
            details={"platform": os.name, "retry_hint": "Run the command without tty=true."},
        )
    try:
        import pty

        master_fd, slave_fd = pty.openpty()
    except (ImportError, OSError) as exc:
        raise ToolFailure(
            "TTY_UNSUPPORTED",
            "A POSIX pseudo-terminal could not be created.",
            category="runtime",
        ) from exc
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            shell=shell,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            **popen_kwargs,
        )
    except Exception:
        os.close(master_fd)
        raise
    finally:
        os.close(slave_fd)
    return process, master_fd


@dataclass
class ExecSession:
    session_id: str
    process: subprocess.Popen[bytes]
    execution_id: str = ""
    task_id: str = ""
    run_id: str = ""
    command: str = ""
    workdir: str = ""
    worktree: str = ""
    action_fingerprint: str = ""
    input_fingerprint: str = ""
    command_hash: str = ""
    side_effect_class: str = "process"
    retry_policy: str = "never_after_start"
    attempt: int = 1
    retry_safe: bool = False
    side_effect_possible: bool = True
    timeout_at: float | None = None
    warnings: list[str] = field(default_factory=list)
    stdout: bytearray = field(default_factory=bytearray)
    stderr: bytearray = field(default_factory=bytearray)
    stdout_start_offset: int = 0
    stderr_start_offset: int = 0
    stdout_cursor: int = 0
    stderr_cursor: int = 0
    stdout_total_bytes: int = 0
    stderr_total_bytes: int = 0
    stdout_dropped_bytes: int = 0
    stderr_dropped_bytes: int = 0
    stdout_hasher: Any = field(default_factory=hashlib.sha256, repr=False)
    stderr_hasher: Any = field(default_factory=hashlib.sha256, repr=False)
    buffer_limit: int = SESSION_BUFFER_BYTES
    lock: threading.Lock = field(default_factory=threading.Lock)
    reader_threads: list[threading.Thread] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    closed: bool = False
    exit_code: int | None = None
    signal_name: str | None = None
    timed_out: bool = False
    terminating: bool = False
    pty_master_fd: int | None = None
    _stdin_closed: bool = False

    @property
    def retained_bytes(self) -> int:
        with self.lock:
            return len(self.stdout) + len(self.stderr)

    def append_stdout(self, chunk: bytes) -> None:
        with self.lock:
            self.stdout_hasher.update(chunk)
            self.stdout.extend(chunk)
            self.stdout_total_bytes += len(chunk)
            self.stdout_dropped_bytes += _trim_buffer(
                self.stdout,
                total_bytes=self.stdout_total_bytes,
                start_offset_attr="stdout_start_offset",
                session=self,
            )

    def append_stderr(self, chunk: bytes) -> None:
        with self.lock:
            self.stderr_hasher.update(chunk)
            self.stderr.extend(chunk)
            self.stderr_total_bytes += len(chunk)
            self.stderr_dropped_bytes += _trim_buffer(
                self.stderr,
                total_bytes=self.stderr_total_bytes,
                start_offset_attr="stderr_start_offset",
                session=self,
            )

    def write_input(self, data: bytes) -> None:
        if self._stdin_closed:
            raise ToolFailure("SESSION_CLOSED", "Session stdin is closed.", category="runtime")
        try:
            if self.pty_master_fd is not None:
                os.write(self.pty_master_fd, data)
                return
            if self.process.stdin is None or self.process.stdin.closed:
                raise ToolFailure("SESSION_CLOSED", "Session stdin is closed.", category="runtime")
            self.process.stdin.write(data)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise ToolFailure("SESSION_CLOSED", "Session stdin is closed.", category="runtime") from exc

    def close_stdin(self) -> None:
        if self.pty_master_fd is not None or self._stdin_closed:
            return
        self._stdin_closed = True
        if self.process.stdin is not None:
            try:
                self.process.stdin.close()
            except OSError:
                pass

    def snapshot_since_cursor(self, max_output_bytes: int) -> dict[str, Any]:
        self.refresh_status()
        final_output = self.process.poll() is not None
        with self.lock:
            stdout_omitted = max(0, self.stdout_start_offset - self.stdout_cursor)
            stderr_omitted = max(0, self.stderr_start_offset - self.stderr_cursor)
            stdout_absolute_start = max(self.stdout_cursor, self.stdout_start_offset)
            stderr_absolute_start = max(self.stderr_cursor, self.stderr_start_offset)
            stdout_start = max(0, stdout_absolute_start - self.stdout_start_offset)
            stderr_start = max(0, stderr_absolute_start - self.stderr_start_offset)
            stdout_bytes = bytes(self.stdout[stdout_start:])
            stderr_bytes = bytes(self.stderr[stderr_start:])
        stdout_decoded = decode_command_output(stdout_bytes, final=final_output)
        stderr_decoded = decode_command_output(stderr_bytes, final=final_output)
        with self.lock:
            self.stdout_cursor = stdout_absolute_start + stdout_decoded.consumed_bytes
            self.stderr_cursor = stderr_absolute_start + stderr_decoded.consumed_bytes
        stdout_truncation = truncate_text_tail(
            stdout_decoded.text, max_lines=DEFAULT_MAX_LINES, max_bytes=max_output_bytes
        )
        stderr_truncation = truncate_text_tail(
            stderr_decoded.text, max_lines=DEFAULT_MAX_LINES, max_bytes=max_output_bytes
        )
        if self.timed_out:
            status = "timeout"
        elif self.terminating and self.process.poll() is None:
            status = "running"
        elif self.signal_name is not None:
            status = "terminated"
        else:
            status = "running" if self.process.poll() is None else "exited"
        if self.timed_out:
            execution_lifecycle = "timed_out"
        elif self.process.poll() is None:
            execution_lifecycle = "running"
        elif self.signal_name is not None:
            execution_lifecycle = "cancelled"
        elif self.exit_code == 0:
            execution_lifecycle = "completed"
        else:
            execution_lifecycle = "failed"
        payload: dict[str, Any] = {
            "session_id": self.session_id,
            "status": status,
            "exit_code": self.exit_code,
            "signal": self.signal_name,
            "timed_out": self.timed_out,
            "stdout": stdout_truncation.content,
            "stderr": stderr_truncation.content,
            "stdout_encoding": stdout_decoded.encoding,
            "stderr_encoding": stderr_decoded.encoding,
            "stdout_pending_decode_bytes": stdout_decoded.pending_bytes,
            "stderr_pending_decode_bytes": stderr_decoded.pending_bytes,
            "newline_normalized": stdout_decoded.newline_normalized or stderr_decoded.newline_normalized,
            "stdout_truncated": stdout_truncation.truncated,
            "stderr_truncated": stderr_truncation.truncated,
            "stdout_truncated_by": stdout_truncation.truncated_by,
            "stderr_truncated_by": stderr_truncation.truncated_by,
            "stdout_output_lines": stdout_truncation.output_lines,
            "stderr_output_lines": stderr_truncation.output_lines,
            "stdout_output_bytes": stdout_truncation.output_bytes,
            "stderr_output_bytes": stderr_truncation.output_bytes,
            "stdout_dropped_bytes": self.stdout_dropped_bytes,
            "stderr_dropped_bytes": self.stderr_dropped_bytes,
            "stdout_omitted_bytes": stdout_omitted,
            "stderr_omitted_bytes": stderr_omitted,
            "truncated": (
                stdout_truncation.truncated
                or stderr_truncation.truncated
                or stdout_omitted > 0
                or stderr_omitted > 0
            ),
            "execution": {
                "execution_id": self.execution_id,
                "lifecycle_state": execution_lifecycle,
                "started_at": _iso_timestamp(self.started_at),
                "finished_at": _iso_timestamp(self.completed_at),
                "pid": self.process.pid,
                "process_id": self.process.pid,
                "child_process_ids": [],
                "action_fingerprint": self.action_fingerprint,
                "input_fingerprint": self.input_fingerprint,
                "command_hash": self.command_hash,
                "attempt": self.attempt,
                "retry_policy": self.retry_policy,
                "side_effect_class": self.side_effect_class,
                "stdout_digest": self.stdout_hasher.hexdigest(),
                "stderr_digest": self.stderr_hasher.hexdigest(),
                "retry_safe": self.retry_safe,
                "side_effect_possible": self.side_effect_possible,
            },
            "ok": True,
        }
        warnings: list[str] = list(self.warnings)
        if stdout_truncation.truncated:
            warnings.append(f"stdout truncated from tail by {stdout_truncation.truncated_by}")
        if stderr_truncation.truncated:
            warnings.append(f"stderr truncated from tail by {stderr_truncation.truncated_by}")
        if stdout_omitted > 0:
            warnings.append("stdout cursor skipped dropped bytes")
        if stderr_omitted > 0:
            warnings.append("stderr cursor skipped dropped bytes")
        if warnings:
            payload["warnings"] = warnings
        return payload

    def refresh_status(self) -> None:
        if self.timeout_at is not None and not self.timed_out and self.process.poll() is None and time.time() >= self.timeout_at:
            self.timed_out = True
            terminate_process_group(self.process, signal.SIGTERM)
            self.drain_readers()
        code = self.process.poll()
        if code is None:
            return
        self.drain_readers()
        self.exit_code = code
        self.terminating = False
        if code < 0:
            values = {item.value for item in signal.Signals}
            self.signal_name = signal.Signals(-code).name if -code in values else str(-code)
        self.closed = True
        if self.completed_at is None:
            self.completed_at = time.time()

    def drain_readers(self, timeout: float = 0.2) -> None:
        deadline = time.time() + timeout
        for thread in list(self.reader_threads):
            remaining = max(0.0, deadline - time.time())
            if remaining <= 0:
                break
            thread.join(timeout=remaining)

    def retained_output_bytes(self) -> bytes:
        with self.lock:
            stdout = bytes(self.stdout)
            stderr = bytes(self.stderr)
        sections: list[bytes] = []
        if stdout:
            sections.extend([b"--- stdout ---\n", stdout])
        if stderr:
            if sections:
                sections.append(b"\n")
            sections.extend([b"--- stderr ---\n", stderr])
        return b"".join(sections)

    def retained_output_text(self) -> str:
        final_output = self.process.poll() is not None
        with self.lock:
            stdout = bytes(self.stdout)
            stderr = bytes(self.stderr)
        sections: list[str] = []
        if stdout:
            sections.extend(["--- stdout ---\n", decode_command_output(stdout, final=final_output).text])
        if stderr:
            if sections:
                sections.append("\n")
            sections.extend(["--- stderr ---\n", decode_command_output(stderr, final=final_output).text])
        return "".join(sections)

    def retained_stream_bytes(self, stream: str) -> tuple[bytes, int, int, int]:
        with self.lock:
            if stream == "stdout":
                return bytes(self.stdout), self.stdout_start_offset, self.stdout_total_bytes, self.stdout_dropped_bytes
            if stream == "stderr":
                return bytes(self.stderr), self.stderr_start_offset, self.stderr_total_bytes, self.stderr_dropped_bytes
        raise ValueError(f"Unknown output stream: {stream}")


def start_reader_threads(session: ExecSession) -> None:
    def reader(stream: BinaryIO, append: Any) -> None:
        try:
            while True:
                chunk = os.read(stream.fileno(), 4096)
                if not chunk:
                    break
                append(chunk)
        except (OSError, ValueError):
            return
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def pty_reader(fd: int) -> None:
        try:
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                session.append_stdout(chunk)
        except OSError:
            return
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
            if session.pty_master_fd == fd:
                session.pty_master_fd = None

    if session.pty_master_fd is not None:
        thread = threading.Thread(target=pty_reader, args=(session.pty_master_fd,), daemon=True)
        session.reader_threads.append(thread)
        thread.start()
        return
    if session.process.stdout is not None:
        thread = threading.Thread(target=reader, args=(session.process.stdout, session.append_stdout), daemon=True)
        session.reader_threads.append(thread)
        thread.start()
    if session.process.stderr is not None:
        thread = threading.Thread(target=reader, args=(session.process.stderr, session.append_stderr), daemon=True)
        session.reader_threads.append(thread)
        thread.start()


def start_session_watchdog(session: ExecSession) -> None:
    if session.timeout_at is None:
        return

    def watchdog() -> None:
        delay = max(0.0, session.timeout_at - time.time()) if session.timeout_at is not None else 0.0
        try:
            session.process.wait(timeout=delay)
        except subprocess.TimeoutExpired:
            pass
        else:
            session.refresh_status()
            return
        if session.process.poll() is not None or session.timed_out:
            return
        session.timed_out = True
        terminate_process_group(session.process, signal.SIGTERM)
        session.refresh_status()

    threading.Thread(
        target=watchdog,
        name=f"coding-tools-watchdog-{session.session_id}",
        daemon=True,
    ).start()


def _trim_buffer(
    buffer: bytearray,
    *,
    total_bytes: int,
    start_offset_attr: str,
    session: ExecSession,
) -> int:
    overflow = len(buffer) - session.buffer_limit
    if overflow <= 0:
        return 0
    del buffer[:overflow]
    setattr(session, start_offset_attr, total_bytes - len(buffer))
    return overflow


def truncate_output_bytes_tail(data: bytes, max_bytes: int, max_lines: int = DEFAULT_MAX_LINES) -> TextTruncation:
    decoded = decode_command_output(data, final=True)
    return truncate_text_tail(
        decoded.text,
        max_lines=max_lines,
        max_bytes=max_bytes,
    )
