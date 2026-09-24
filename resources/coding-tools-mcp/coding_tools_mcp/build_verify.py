from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


CommandRunner = Callable[[str, Path, int], dict[str, Any]]
PROJECT_MARKERS = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def detect_project(root: Path) -> dict[str, Any]:
    package = _read_json(root / "package.json") if (root / "package.json").is_file() else {}
    if package:
        scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
        manager = "pnpm" if (root / "pnpm-lock.yaml").exists() else "yarn" if (root / "yarn.lock").exists() else "npm"
        dependencies = package.get("dependencies") if isinstance(package.get("dependencies"), dict) else {}
        dev_dependencies = package.get("devDependencies") if isinstance(package.get("devDependencies"), dict) else {}
        kind = "electron" if package.get("main") or "electron" in {**dependencies, **dev_dependencies} else "node"
        run = "run " if manager in {"npm", "pnpm"} else ""
        test = f"{manager} {run}test" if scripts.get("test") and "no test specified" not in str(scripts.get("test")).lower() else ""
        build_name = next((name for name in ("build", "dist", "package") if scripts.get(name)), "")
        build = f"{manager} {run}{build_name}" if build_name else ""
        output_dirs = []
        builder = package.get("build") if isinstance(package.get("build"), dict) else {}
        directories = builder.get("directories") if isinstance(builder.get("directories"), dict) else {}
        if directories.get("output"):
            output_dirs.append(str(directories["output"]))
        output_dirs.extend(["dist", "build"])
        return {"type": kind, "name": package.get("name", root.name), "version": package.get("version", ""), "package_manager": manager, "test_command": test, "build_command": build, "artifact_paths": list(dict.fromkeys(output_dirs))}
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            parsed = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            parsed = {}
        project = parsed.get("project") if isinstance(parsed.get("project"), dict) else {}
        return {"type": "python", "name": project.get("name", root.name), "version": project.get("version", ""), "requires_python": str(project.get("requires-python") or ""), "package_manager": "pip", "test_command": "python -m pytest" if any((root / name).exists() for name in ("tests", "test", "pytest.ini")) else "", "build_command": "python -m build", "artifact_paths": ["dist"]}
    cargo = root / "Cargo.toml"
    if cargo.is_file():
        try:
            parsed = tomllib.loads(cargo.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            parsed = {}
        package = parsed.get("package") if isinstance(parsed.get("package"), dict) else {}
        return {"type": "rust", "name": package.get("name", root.name), "version": package.get("version", ""), "package_manager": "cargo", "test_command": "cargo test", "build_command": "cargo build --release", "artifact_paths": ["target/release"]}
    if (root / "go.mod").is_file():
        first = (root / "go.mod").read_text(encoding="utf-8", errors="replace").splitlines()[:1]
        name = first[0].removeprefix("module ").strip() if first else root.name
        return {"type": "go", "name": name, "version": "", "package_manager": "go", "test_command": "go test ./...", "build_command": "go build ./...", "artifact_paths": ["bin", "."]}
    if (root / "pom.xml").is_file():
        return {"type": "maven", "name": root.name, "version": "", "package_manager": "maven", "test_command": "mvn test", "build_command": "mvn package", "artifact_paths": ["target"]}
    if any(root.glob("*.sln")) or any(root.glob("*.csproj")):
        return {"type": "dotnet", "name": root.name, "version": "", "package_manager": "dotnet", "test_command": "dotnet test", "build_command": "dotnet build --configuration Release", "artifact_paths": ["bin/Release"]}
    return {"type": "unknown", "name": root.name, "version": "", "package_manager": "", "test_command": "", "build_command": "", "artifact_paths": []}


def infer_project_root(root: Path, *commands: str) -> Path:
    root = root.resolve()
    patterns = (
        r"(?:npm|pnpm)\s+(?:--prefix|-C)\s+[\"']?([^\"'\s;&]+)",
        r"yarn\s+--cwd\s+[\"']?([^\"'\s;&]+)",
        r"(?:^|&&|;)\s*cd\s+[\"']?([^\"';&]+?)[\"']?\s*(?:&&|;)",
    )
    for command in commands:
        for pattern in patterns:
            match = re.search(pattern, str(command or ""), re.I)
            if not match:
                continue
            candidate = (root / match.group(1).strip()).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            if candidate.is_dir() and any((candidate / name).exists() for name in ("package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml")):
                return candidate
    return root


def select_project_root(root: Path, target_paths: list[str] | None = None) -> Path:
    """Choose the nearest project containing the files being changed instead of guessing from the workspace root."""
    root = root.resolve()
    selected: list[Path] = []
    for raw in target_paths or []:
        candidate = (root / str(raw)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        cursor = candidate if candidate.is_dir() else candidate.parent
        while True:
            if any((cursor / marker).is_file() for marker in PROJECT_MARKERS) or any(cursor.glob("*.sln")) or any(cursor.glob("*.csproj")):
                selected.append(cursor)
                break
            if cursor == root:
                break
            cursor = cursor.parent
    if selected and all(item == selected[0] for item in selected):
        return selected[0]
    return root


def _tool_available(name: str) -> bool:
    return bool(shutil.which(name) or (os.name == "nt" and shutil.which(f"{name}.cmd")))


def _profile_command(command: str = "", *, status: str = "unavailable", framework: str = "", confidence: str = "low", reason: str = "") -> dict[str, Any]:
    return {
        "status": status,
        "command": command,
        "framework": framework,
        "confidence": confidence,
        "reason": reason,
    }


def _node_framework(script: str) -> str:
    lowered = script.lower()
    for name in ("vitest", "jest", "playwright", "mocha", "ava", "node --test"):
        if name in lowered:
            return "node:test" if name == "node --test" else name
    return "package-script"


def _python_requirement_met(requirement: str, version: tuple[int, int]) -> bool:
    """Check the lower bound needed for choosing an interpreter, not full PEP 440 resolution."""
    for major, minor in re.findall(r">=\s*(\d+)\.(\d+)", requirement):
        if version < (int(major), int(minor)):
            return False
    return True


def _project_python(root: Path) -> tuple[str, tuple[int, int], bool, bool]:
    candidates = (
        root / ".venv" / "Scripts" / "python.exe",
        root / "venv" / "Scripts" / "python.exe",
        root / ".venv" / "bin" / "python",
        root / "venv" / "bin" / "python",
    )
    for executable in candidates:
        if not executable.is_file():
            continue
        try:
            probe = subprocess.run(
                [str(executable), "-I", "-c", "import importlib.util,json,sys;print(json.dumps([sys.version_info.major,sys.version_info.minor,bool(importlib.util.find_spec('pytest')),bool(importlib.util.find_spec('build'))]))"],
                cwd=str(root), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5, check=False,
            )
            if probe.returncode == 0:
                major, minor, pytest_ok, build_ok = json.loads(probe.stdout.strip())
                return str(executable), (int(major), int(minor)), bool(pytest_ok), bool(build_ok)
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            continue
    return sys.executable, sys.version_info[:2], importlib.util.find_spec("pytest") is not None, importlib.util.find_spec("build") is not None


def profile_project_execution(root: Path, target_paths: list[str] | None = None) -> dict[str, Any]:
    """Describe executable tests/builds without running them; unavailable means do not guess-and-run."""
    workspace_root = root.resolve()
    project_root = select_project_root(workspace_root, target_paths)
    project = detect_project(project_root)
    test = _profile_command(reason="当前项目没有可验证的测试入口。")
    build = _profile_command(reason="当前项目没有可验证的构建入口。")
    kind = str(project.get("type") or "unknown")

    if kind in {"node", "electron"}:
        package = _read_json(project_root / "package.json")
        scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
        manager = str(project.get("package_manager") or "npm")
        available = _tool_available(manager)
        run = "run " if manager in {"npm", "pnpm"} else ""
        test_script = str(scripts.get("test") or "")
        if test_script and "no test specified" not in test_script.lower():
            command = f"{manager} {run}test".strip()
            test = _profile_command(
                command,
                status="verified" if available else "unavailable",
                framework=_node_framework(test_script),
                confidence="high",
                reason="package.json 已声明 test 脚本，且包管理器可用。" if available else f"package.json 有 test 脚本，但当前环境找不到 {manager}。",
            )
        build_name = next((name for name in ("build", "dist", "package") if scripts.get(name)), "")
        if build_name:
            command = f"{manager} {run}{build_name}".strip()
            build = _profile_command(
                command,
                status="verified" if available else "unavailable",
                framework=str(scripts.get(build_name) or "package-script").split()[0],
                confidence="high",
                reason=f"package.json 已声明 {build_name} 脚本，且包管理器可用。" if available else f"package.json 有 {build_name} 脚本，但当前环境找不到 {manager}。",
            )
    elif kind == "python":
        python, version, pytest_available, build_available = _project_python(project_root)
        requires = str(project.get("requires_python") or "")
        if not _python_requirement_met(requires, version):
            reason = f"项目要求 Python {requires}，当前可用环境为 {version[0]}.{version[1]}；请先配置项目自己的兼容虚拟环境。内置 MCP Python 不负责安装业务依赖。"
            test = _profile_command(status="unavailable", framework="pytest", confidence="high", reason=reason)
            build = _profile_command(status="unavailable", framework="python-build", confidence="high", reason=reason)
        else:
            tests_dir = next((project_root / name for name in ("tests", "test") if (project_root / name).is_dir()), project_root / "tests")
            pytest_configured = any((project_root / name).exists() for name in ("pytest.ini", "conftest.py")) or tests_dir.exists()
            if pytest_configured and pytest_available:
                command = f'"{python}" -m pytest'
                test = _profile_command(command, status="verified", framework="pytest", confidence="high", reason="检测到测试目录/配置，并确认选用的项目 Python 可导入 pytest。需要 localhost 服务的集成测试仍须按项目配置显式启动。")
            elif tests_dir.is_dir() and any(tests_dir.rglob("test*.py")) and tests_dir.name == "tests":
                command = f'"{python}" -m unittest discover -s tests'
                test = _profile_command(command, status="verified", framework="unittest", confidence="medium", reason="pytest 不可用，但检测到 unittest 风格 test*.py，可使用 Python 内置 unittest。")
            elif pytest_configured:
                test = _profile_command(status="unavailable", framework="pytest", confidence="high", reason="检测到测试目录/配置，但所选项目 Python 环境没有 pytest，且没有可确认的 unittest 测试入口。")
            if build_available:
                build = _profile_command(f'"{python}" -m build', status="verified", framework="python-build", confidence="high", reason="所选项目 Python 可导入 build 模块。")
            else:
                build = _profile_command(status="unavailable", framework="python-build", confidence="high", reason="所选项目 Python 环境没有 build 模块，不会盲目运行 python -m build。")
    else:
        specs = {
            "rust": ("cargo", "cargo test", "cargo build --release", "cargo"),
            "go": ("go", "go test ./...", "go build ./...", "go"),
            "maven": ("mvn", "mvn test", "mvn package", "maven"),
            "dotnet": ("dotnet", "dotnet test", "dotnet build --configuration Release", "dotnet"),
        }
        spec = specs.get(kind)
        if spec:
            executable, test_command, build_command, framework = spec
            available = _tool_available(executable)
            reason = f"已检测到 {executable} 可执行程序。" if available else f"当前环境找不到 {executable}，不会盲目执行相关命令。"
            status = "verified" if available else "unavailable"
            test = _profile_command(test_command if available else "", status=status, framework=framework, confidence="high", reason=reason)
            build = _profile_command(build_command if available else "", status=status, framework=framework, confidence="high", reason=reason)

    relative_root = project_root.relative_to(workspace_root).as_posix() if project_root != workspace_root else "."
    return {
        "project_root": relative_root,
        "project": project,
        "test": test,
        "build": build,
        "artifact_paths": list(project.get("artifact_paths") or []),
        "target_paths": [str(item) for item in (target_paths or [])[:50]],
    }


def _hash_file(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def collect_artifacts(root: Path, patterns: list[str], algorithm: str, started_ns: int) -> list[dict[str, Any]]:
    found: dict[Path, None] = {}
    for raw in patterns:
        candidate = (root / raw).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            continue
        matches = list(root.glob(raw)) if any(ch in raw for ch in "*?[") else [candidate]
        for match in matches:
            if match.is_file():
                found[match] = None
            elif match.is_dir():
                for file in match.rglob("*"):
                    if file.is_file():
                        found[file] = None
    artifacts = []
    for path in sorted(found, key=lambda item: item.as_posix())[:500]:
        stat = path.stat()
        artifacts.append({"path": path.relative_to(root).as_posix(), "size": stat.st_size, "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"), "fresh": started_ns <= 0 or stat.st_mtime_ns >= started_ns, algorithm: _hash_file(path, algorithm)})
    return artifacts


def verify_build(root: Path, args: dict[str, Any], runner: CommandRunner) -> dict[str, Any]:
    root = root.resolve()
    target_paths = [str(item) for item in args.get("target_paths", []) if str(item).strip()]
    profile = profile_project_execution(root, target_paths)
    project_root = (root / profile["project_root"]).resolve()
    requested_test = str(args.get("test_command") or "")
    requested_build = str(args.get("build_command") or "")
    if requested_test or requested_build:
        inferred = infer_project_root(root, requested_build, requested_test)
        if inferred != root or profile["project_root"] == ".":
            project_root = inferred
            profile = profile_project_execution(root, [project_root.relative_to(root).as_posix()] if project_root != root else [])
    project = detect_project(project_root)
    test_command = requested_test or (str(profile["test"].get("command") or "") if profile["test"].get("status") == "verified" else "")
    build_command = requested_build or (str(profile["build"].get("command") or "") if profile["build"].get("status") == "verified" else "")
    run_tests = bool(args.get("run_tests", True))
    run_build = bool(args.get("run_build", True))
    timeout = int(args.get("timeout_seconds", 900))
    algorithm = str(args.get("hash_algorithm", "sha256")).lower()
    if algorithm not in hashlib.algorithms_available or algorithm not in {"sha256", "sha384", "sha512"}:
        algorithm = "sha256"
    started_ns = int(datetime.now().timestamp() * 1_000_000_000)
    test_result = None
    build_result = None
    failure = ""
    failure_kind = ""
    if run_tests:
        if not test_command:
            test_result = {"status": "unavailable", "command": "", "summary": str(profile["test"].get("reason") or "未检测到可用测试命令。")}
        else:
            test_result = runner(test_command, root if project_root != root and args.get("test_command") else project_root, timeout)
            if test_result.get("status") != "passed":
                if test_result.get("status") == "environment_failed":
                    failure = "测试命令未能启动；请检查运行环境或命令路径。"
                    failure_kind = "environment"
                else:
                    failure = "Tests failed."
                    failure_kind = "test"
    if run_build and not failure:
        if not build_command:
            build_result = {"status": "unavailable", "command": "", "summary": str(profile["build"].get("reason") or "未检测到可用构建命令。")}
            failure = "未检测到经过验证的构建命令。"
            failure_kind = "environment"
        else:
            build_result = runner(build_command, root if project_root != root and args.get("build_command") else project_root, timeout)
            if build_result.get("status") != "passed":
                if build_result.get("status") == "environment_failed":
                    failure = "构建命令未能启动；请检查运行环境或命令路径。"
                    failure_kind = "environment"
                else:
                    failure = "Build failed."
                    failure_kind = "build"
    patterns = [str(item) for item in args.get("artifact_paths", [])] or list(project["artifact_paths"])
    artifacts = collect_artifacts(project_root, patterns, algorithm, started_ns) if not failure else []
    if run_build and build_result and build_result.get("status") == "passed" and not artifacts:
        failure = "Build command passed, but no newly generated artifact was found."
        failure_kind = "artifact"
    overall = "passed" if not failure else "failed"
    return {"project": project, "project_root": project_root.relative_to(root).as_posix() if project_root != root else ".", "execution_profile": profile, "commands": {"test": test_command, "build": build_command}, "test_result": test_result, "build_result": build_result, "artifacts": artifacts, "hash_algorithm": algorithm, "overall_status": overall, "failure": failure or None, "failure_kind": failure_kind or None, "report_generated_at": _now()}
