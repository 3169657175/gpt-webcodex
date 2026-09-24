from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.repo_index import INDEX_VERSION, RepoIndex


class RepoIndexTests(unittest.TestCase):
    def test_first_sync_creates_fts_manifest_and_search(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app.py").write_text("def greet_user():\n    return 'hello index'\n", encoding="utf-8")
            (root / "README.md").write_text("project documentation", encoding="utf-8")
            index = RepoIndex(root)
            result = index.sync()
            self.assertTrue(result["ok"])
            self.assertEqual(result["indexed"], 2)
            self.assertTrue(index.db_path.is_file())
            self.assertTrue(index.manifest_path.is_file())
            self.assertEqual(json.loads(index.version_path.read_text(encoding="utf-8"))["version"], INDEX_VERSION)
            hits = index.search("greet_user")
            self.assertEqual(hits[0]["path"], "app.py")
            self.assertEqual(hits[0]["language"], "python")

    def test_unchanged_files_skip_and_one_change_updates_only_that_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "first.py"
            second = root / "second.py"
            first.write_text("alpha_value = 1\n", encoding="utf-8")
            second.write_text("beta_value = 2\n", encoding="utf-8")
            index = RepoIndex(root)
            initial = index.sync()
            again = index.sync()
            self.assertEqual(initial["indexed"], 2)
            self.assertEqual(again["indexed"], 0)
            self.assertEqual(again["updated"], 0)
            self.assertEqual(again["skipped"], 2)
            time.sleep(0.002)
            first.write_text("alpha_value = 3\nchanged_marker = True\n", encoding="utf-8")
            changed = index.sync()
            self.assertEqual(changed["updated"], 1)
            self.assertEqual(changed["skipped"], 1)
            self.assertEqual(index.search("changed_marker")[0]["path"], "first.py")

    def test_deleted_file_is_removed_from_fts_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "gone.ts"
            target.write_text("export const unique_deleted_symbol = 1;\n", encoding="utf-8")
            index = RepoIndex(root)
            index.sync()
            target.unlink()
            result = index.sync()
            self.assertEqual(result["removed"], 1)
            self.assertEqual(index.search("unique_deleted_symbol"), [])
            manifest = json.loads(index.manifest_path.read_text(encoding="utf-8"))
            self.assertNotIn("gone.ts", manifest["files"])

    def test_index_directory_is_never_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "main.js").write_text("const visible_marker = true;\n", encoding="utf-8")
            hidden = root / ".coding-tools" / "index"
            hidden.mkdir(parents=True)
            (hidden / "should-not-index.txt").write_text("private_index_marker", encoding="utf-8")
            index = RepoIndex(root)
            index.sync()
            self.assertEqual(index.search("private_index_marker"), [])
            self.assertEqual(index.search("visible_marker")[0]["path"], "main.js")

    def test_corrupt_database_is_quarantined_and_rebuilt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "main.py").write_text("rebuild_marker = 1\n", encoding="utf-8")
            index = RepoIndex(root)
            index.sync()
            index.db_path.write_bytes(b"not-a-sqlite-database")
            rebuilt = RepoIndex(root).sync()
            self.assertTrue(rebuilt["ok"])
            self.assertTrue(rebuilt["rebuilt"])
            self.assertTrue(list(index.index_dir.glob("index.corrupt-*.db")))
            self.assertEqual(RepoIndex(root).search("rebuild_marker")[0]["path"], "main.py")

    def test_sync_safely_contains_unexpected_index_failures(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            index = RepoIndex(root)
            with patch.object(index, "sync", side_effect=RuntimeError("index unavailable")):
                result = index.sync_safely()
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "unavailable")
            self.assertIn("RuntimeError", result["error"])

    def test_python_ast_extracts_symbols_and_imports(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "service.py").write_text(
                "import json\nfrom pathlib import Path\n\nclass Worker:\n    def run(self, value: int):\n        return value\n\nasync def fetch_data(url):\n    return url\n",
                encoding="utf-8",
            )
            index = RepoIndex(root)
            index.sync()
            symbols = index.important_symbols(limit=20)
            names = {item["name"]: item["kind"] for item in symbols}
            self.assertEqual(names["Worker"], "class")
            self.assertEqual(names["run"], "function")
            self.assertEqual(names["fetch_data"], "async_function")
            targets = {item["target"] for item in index.dependency_hints(limit=20)}
            self.assertIn("json", targets)
            self.assertIn("pathlib", targets)

    def test_typescript_extracts_high_confidence_symbols_and_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "api.ts").write_text(
                "import { client } from './client';\nexport interface ApiResult { ok: boolean }\nexport class ApiService {}\nexport async function loadUser(id: string) { return client(id); }\nexport const mapUser = (value: string) => value;\n",
                encoding="utf-8",
            )
            index = RepoIndex(root)
            index.sync()
            names = {item["name"]: item["kind"] for item in index.important_symbols(limit=20)}
            self.assertEqual(names["ApiService"], "class")
            self.assertEqual(names["ApiResult"], "interface")
            self.assertEqual(names["loadUser"], "function")
            self.assertEqual(names["mapUser"], "function")
            self.assertEqual(index.dependency_hints(limit=20)[0]["target"], "./client")

    def test_incremental_change_replaces_old_symbols_and_imports(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "module.py"
            target.write_text("import old_dep\ndef old_name():\n    return 1\n", encoding="utf-8")
            index = RepoIndex(root)
            index.sync()
            time.sleep(0.002)
            target.write_text("import new_dep\ndef new_name():\n    return 2\n", encoding="utf-8")
            result = index.sync()
            self.assertEqual(result["updated"], 1)
            symbol_names = {item["name"] for item in index.important_symbols(limit=20)}
            import_targets = {item["target"] for item in index.dependency_hints(limit=20)}
            self.assertNotIn("old_name", symbol_names)
            self.assertIn("new_name", symbol_names)
            self.assertNotIn("old_dep", import_targets)
            self.assertIn("new_dep", import_targets)

    def test_architecture_map_and_relevant_files_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "src").mkdir()
            for number in range(8):
                (root / "src" / f"feature_{number}.py").write_text(
                    f"import json\ndef feature_{number}():\n    return 'shared_marker {number}'\n",
                    encoding="utf-8",
                )
            index = RepoIndex(root)
            index.sync()
            architecture = index.architecture_map(limit_files=3)
            self.assertEqual(architecture["files"], 8)
            self.assertEqual(architecture["symbols"], 8)
            self.assertLessEqual(len(architecture["key_files"]), 3)
            self.assertLessEqual(len(architecture["languages"]), 12)
            self.assertLessEqual(len(architecture["top_directories"]), 12)
            self.assertEqual(architecture["top_directories"][0]["path"], "src")
            self.assertLessEqual(len(index.relevant_files("shared_marker", limit=4)), 4)


if __name__ == "__main__":
    unittest.main()
