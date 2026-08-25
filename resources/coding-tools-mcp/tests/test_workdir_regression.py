from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.server import Runtime


class WorkdirRegressionTests(unittest.TestCase):
    def test_apply_changes_verification_uses_explicit_subproject_workdir(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "subproject").mkdir()
            runtime = Runtime(root)
            captured: dict[str, object] = {}

            def fake_verify(args: dict[str, object]) -> dict[str, object]:
                captured.update(args)
                return {"ok": True, "overall_status": "passed", "status": "passed"}

            runtime.verify_build = fake_verify  # type: ignore[method-assign]
            result = runtime.apply_changes_and_verify({
                "objective": "verify subproject",
                "path": ".",
                "workdir": "subproject",
                "verification": "tests",
                "include_diff": False,
            })
            self.assertTrue(result["ok"])
            self.assertEqual(captured["path"], "subproject")


if __name__ == "__main__":
    unittest.main()
