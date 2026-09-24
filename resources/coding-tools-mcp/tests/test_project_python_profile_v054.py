from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.build_verify import detect_project, profile_project_execution


class ProjectPythonProfileTests(unittest.TestCase):
    def test_incompatible_runtime_python_does_not_claim_project_tests_are_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "pyproject.toml").write_text('[project]\nname="demo"\nrequires-python=">=3.13"\n', encoding="utf-8")
            (root / "test").mkdir()
            (root / "test" / "test_demo.py").write_text("import pytest\n", encoding="utf-8")
            self.assertEqual(detect_project(root)["test_command"], "python -m pytest")
            with patch("coding_tools_mcp.build_verify._project_python", return_value=("python312", (3, 12), True, True)):
                profile = profile_project_execution(root)
            self.assertEqual(profile["test"]["status"], "unavailable")
            self.assertEqual(profile["build"]["status"], "unavailable")
            self.assertIn("3.13", profile["test"]["reason"])

    def test_project_venv_is_selected_when_its_python_has_pytest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "pyproject.toml").write_text('[project]\nname="demo"\nrequires-python=">=3.13"\n', encoding="utf-8")
            (root / "test").mkdir()
            venv_python = root / ".venv" / "Scripts" / "python.exe"
            venv_python.parent.mkdir(parents=True)
            venv_python.write_bytes(b"fixture")
            probe = SimpleNamespace(returncode=0, stdout=json.dumps([3, 13, True, False]))
            with patch("coding_tools_mcp.build_verify.subprocess.run", return_value=probe):
                profile = profile_project_execution(root)
            self.assertEqual(profile["test"]["status"], "verified")
            self.assertIn(str(venv_python), profile["test"]["command"])
            self.assertEqual(profile["build"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
