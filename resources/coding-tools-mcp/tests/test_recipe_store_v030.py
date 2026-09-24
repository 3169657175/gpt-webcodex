from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.recipe_store import BUILTIN_RECIPES, RecipeStore, normalize_recipe


class RecipeStoreTests(unittest.TestCase):
    def test_builtin_recipes_match_v030_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            result = RecipeStore(Path(temp)).list()
            self.assertEqual({item["id"] for item in result["items"]}, {
                "fix-bug", "release-version", "frontend-regression", "mcp-stability-check"
            })
            self.assertEqual(result["warnings"], [])
            self.assertTrue(all(item["source"] == "builtin" for item in result["items"]))

    def test_project_recipe_can_override_builtin_but_cannot_add_unknown_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = RecipeStore(Path(temp))
            override = dict(BUILTIN_RECIPES[0])
            override["name"] = "项目专用 Bug 修复"
            saved = store.save(override)
            self.assertEqual(saved["source"], "project")
            loaded = store.get("fix-bug")
            self.assertEqual(loaded["name"], "项目专用 Bug 修复")
            self.assertEqual(loaded["source"], "project")
            invalid = dict(override)
            invalid["permissions_override"] = {"command": "allow"}
            with self.assertRaisesRegex(ValueError, "unknown recipe fields"):
                store.save(invalid)

    def test_invalid_or_corrupt_project_files_are_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = RecipeStore(Path(temp))
            store.recipe_dir.mkdir(parents=True)
            (store.recipe_dir / "broken.json").write_text("{bad", encoding="utf-8")
            (store.recipe_dir / "unsafe.json").write_text(json.dumps({
                "id": "unsafe", "name": "unsafe", "description": "", "mode": "code",
                "default_verification": "none", "tool_categories": ["root"],
                "failure_policy": "stop", "risk_level": "high",
                "steps": [{"id": "x", "title": "x", "instruction": "x", "tool_categories": []}],
            }), encoding="utf-8")
            result = store.list()
            self.assertEqual(result["count"], 4)
            self.assertEqual(len(result["warnings"]), 2)
            self.assertEqual({item["file"] for item in result["warnings"]}, {"broken.json", "unsafe.json"})

    def test_step_categories_must_stay_within_recipe_declared_categories(self) -> None:
        raw = dict(BUILTIN_RECIPES[0])
        raw["tool_categories"] = ["read"]
        with self.assertRaisesRegex(ValueError, "subset"):
            normalize_recipe(raw)

    def test_recipe_security_view_never_escalates_runtime_permissions(self) -> None:
        recipe = normalize_recipe(dict(BUILTIN_RECIPES[1]))
        policies = {"read": "allow", "write": "ask", "command": "deny", "git_write": "deny"}
        view = RecipeStore.security_view(recipe, policies)
        self.assertFalse(view["permission_escalation"])
        self.assertFalse(view["can_auto_execute"])
        self.assertIn("command", view["denied_categories"])
        self.assertIn("git_write", view["denied_categories"])
        self.assertIn("write", view["approval_categories"])
        self.assertEqual(policies["command"], "deny")

    def test_save_is_atomic_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = RecipeStore(Path(temp))
            saved = store.save(dict(BUILTIN_RECIPES[2]))
            path = store.recipe_dir / "frontend-regression.json"
            first = path.read_text(encoding="utf-8")
            store.save(dict(BUILTIN_RECIPES[2]))
            second = path.read_text(encoding="utf-8")
            self.assertEqual(first, second)
            self.assertEqual(json.loads(second)["id"], saved["id"])
            self.assertEqual(list(store.recipe_dir.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
