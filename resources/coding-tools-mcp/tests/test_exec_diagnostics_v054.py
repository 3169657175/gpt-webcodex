from __future__ import annotations

import sys
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import exec_output_diagnostics


class ExecDiagnosticsTests(unittest.TestCase):
    def test_successful_command_mentioning_missing_executable_is_not_misclassified(self) -> None:
        diagnostics = exec_output_diagnostics({"exit_code": 0, "stdout": "Previous step: executable not found; fallback succeeded"})
        self.assertNotIn("EXECUTABLE_NOT_FOUND", [item["code"] for item in diagnostics])

    def test_actual_command_not_found_is_classified(self) -> None:
        diagnostics = exec_output_diagnostics({"exit_code": 127, "stderr": "command not found"})
        self.assertIn("EXECUTABLE_NOT_FOUND", [item["code"] for item in diagnostics])


if __name__ == "__main__":
    unittest.main()
