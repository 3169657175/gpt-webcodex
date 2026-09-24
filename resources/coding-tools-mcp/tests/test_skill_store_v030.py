from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.skill_store import SkillStore


class SkillStoreTests(unittest.TestCase):
    def make_skill(self, root: Path, *, instructions: str = "检查项目并给出建议", readme: bool = True) -> Path:
        skill_dir = root / ".coding-tools" / "skills" / "project-review"
        skill_dir.mkdir(parents=True, exist_ok=True)
        manifest = {
            "id": "project-review", "name": "项目检查", "version": "1.0.0",
            "description": "检查项目", "instructions": instructions,
            "tool_schema": {"name": "project_review", "description": "检查项目", "input_schema": {"type": "object", "properties": {}}},
            "permissions": ["read", "command"], "risk_level": "medium",
            "allowed_roots": ["."], "network_required": False, "dependencies": [],
        }
        (skill_dir / "skill.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        if readme:
            (skill_dir / "README.md").write_text("# 项目检查\n", encoding="utf-8")
        return skill_dir

    def test_new_skill_defaults_disabled_and_requires_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); self.make_skill(root)
            store = SkillStore(root)
            skill = store.get("project-review")
            self.assertFalse(skill["enabled"])
            self.assertTrue(store.validate("project-review")["ok"])
            enabled = store.enable("project-review")
            self.assertTrue(enabled["enabled"])

    def test_manifest_change_invalidates_previous_enable_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); directory = self.make_skill(root)
            store = SkillStore(root); store.enable("project-review")
            self.assertTrue(store.get("project-review")["enabled"])
            raw = json.loads((directory / "skill.json").read_text(encoding="utf-8"))
            raw["instructions"] = "新的说明"
            (directory / "skill.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            changed = store.get("project-review")
            self.assertFalse(changed["enabled"])
            self.assertTrue(changed["validation_stale"])

    def test_missing_readme_cannot_be_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); self.make_skill(root, readme=False)
            store = SkillStore(root)
            self.assertFalse(store.validate("project-review")["ok"])
            with self.assertRaisesRegex(ValueError, "validation"):
                store.enable("project-review")

    def test_allowed_roots_cannot_escape_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); directory = self.make_skill(root)
            raw = json.loads((directory / "skill.json").read_text(encoding="utf-8"))
            raw["allowed_roots"] = ["../outside"]
            (directory / "skill.json").write_text(json.dumps(raw), encoding="utf-8")
            result = SkillStore(root).list()
            self.assertEqual(result["count"], 0)
            self.assertIn("within workspace", result["warnings"][0]["error"])

    def test_skill_security_never_escalates_runtime_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); self.make_skill(root)
            skill = SkillStore(root).get("project-review")
            policies = {"read": "allow", "command": "deny"}
            view = SkillStore.security_view(skill, policies)
            self.assertFalse(view["permission_escalation"])
            self.assertFalse(view["can_auto_execute"])
            self.assertIn("command", view["denied_categories"])
            self.assertEqual(policies["command"], "deny")

    def test_unknown_manifest_fields_and_executable_escape_hatches_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); directory = self.make_skill(root)
            raw = json.loads((directory / "skill.json").read_text(encoding="utf-8"))
            raw["entrypoint"] = "src/run.py"
            (directory / "skill.json").write_text(json.dumps(raw), encoding="utf-8")
            result = SkillStore(root).list()
            self.assertEqual(result["count"], 0)
            self.assertIn("unknown skill fields", result["warnings"][0]["error"])


if __name__ == "__main__":
    unittest.main()
