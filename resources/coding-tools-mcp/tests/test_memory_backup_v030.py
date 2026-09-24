from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.memory_backup import MemoryBackupService
from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.memory_write import MemoryCandidateStore, MemoryWriteError
from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class MemoryBackupStoreTests(unittest.TestCase):
    def test_auto_memory_config_and_revision_restore_are_persistent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memory"
            store = MemoryStore(root)
            self.assertEqual(store.config()["auto_memory"], "off")
            self.assertEqual(store.set_auto_memory("suggest")["auto_memory"], "suggest")
            self.assertEqual(MemoryStore(root).config()["auto_memory"], "suggest")
            item = store.create(scope="global", memory_type="working_style", title="工作方式", content="版本一")
            store.update(item["memory_id"], content="版本二")
            restored = store.restore_revision(item["memory_id"], 1)
            self.assertEqual(restored["content"], "版本一")
            self.assertEqual(restored["revision"], 3)
            revisions = store.revision_history(item["memory_id"])
            self.assertEqual([entry["revision"] for entry in revisions], [1, 2])
            self.assertEqual(revisions[1]["content"], "版本二")
            with self.assertRaises(ValueError):
                store.set_auto_memory("unsafe")

    def test_export_excludes_index_candidates_and_secret_bearing_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); root = base / "memory"; target = base / "backup.zip"
            store = MemoryStore(root)
            safe = store.create(scope="global", memory_type="working_style", title="安全记忆", content="连续执行，不重复确认")
            secret = store.create(scope="global", memory_type="note", title="凭据", content="password=supersecret123")
            candidate_store = MemoryCandidateStore(store)
            candidate = candidate_store.propose(scope="global", memory_type="note", title="候选", content="尚未确认")
            result = MemoryBackupService(store).export_zip(target)
            self.assertTrue(result["ok"]); self.assertTrue(target.is_file())
            with zipfile.ZipFile(target, "r") as archive:
                names = set(archive.namelist())
                self.assertIn("manifest.json", names)
                self.assertIn("config.json", names)
                self.assertTrue(any(safe["memory_id"] in name for name in names))
                self.assertFalse(any(secret["memory_id"] in name for name in names))
                self.assertFalse(any(name == "memory.db" or name.startswith("candidates/") for name in names))
                self.assertFalse(any(candidate["candidate_id"] in name for name in names))
                manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                self.assertIn("memory.db", manifest["excluded"])
                self.assertIn("mcp_token", manifest["excluded"])
            self.assertTrue(any("secret-bearing" in warning for warning in result["warnings"]))

    def test_export_import_round_trip_merge_and_apply_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = MemoryStore(base / "source")
            source.set_auto_memory("suggest")
            item = source.create(scope="project", memory_type="decision", title="架构原则", content="本地记忆是唯一真源", project_id="project-a", pinned=True)
            source.update(item["memory_id"], content="本地 Markdown 是唯一真源")
            archive_path = base / "memory-backup.zip"
            MemoryBackupService(source).export_zip(archive_path)

            target = MemoryStore(base / "target")
            existing = target.create(scope="global", memory_type="working_style", title="现有", content="保留我")
            result = MemoryBackupService(target).import_zip(archive_path, apply_config=True)
            self.assertTrue(result["ok"]); self.assertGreaterEqual(result["imported"], 1)
            self.assertEqual(target.config()["auto_memory"], "suggest")
            found = target.search("Markdown", project_id="project-a")
            self.assertTrue(found)
            self.assertIn("唯一真源", found[0]["content"])
            self.assertIsNotNone(target.get(existing["memory_id"]))
            imported = next(entry for entry in target.list(scope="project", project_id="project-a") if "唯一真源" in entry["content"])
            self.assertTrue(target.revision_history(imported["memory_id"]))

    def test_import_rejects_zip_slip_and_secret_bearing_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); malicious = base / "bad.zip"
            with zipfile.ZipFile(malicious, "w") as archive:
                archive.writestr("manifest.json", json.dumps({"schema_version": 1}))
                archive.writestr("../outside.md", "bad")
            with self.assertRaises(MemoryWriteError) as raised:
                MemoryBackupService(MemoryStore(base / "target")).import_zip(malicious)
            self.assertEqual(raised.exception.code, "INVALID_BACKUP_ENTRY")

            source = MemoryStore(base / "source-secret")
            source.create(scope="global", memory_type="note", title="secret", content="api_key=sk-abcdefghijklmnopqrstuvwxyz")
            safe_export = base / "filtered.zip"
            MemoryBackupService(source).export_zip(safe_export)
            with zipfile.ZipFile(safe_export, "r") as archive:
                self.assertFalse(any(name.startswith("system/mem_") for name in archive.namelist()))


class MemoryBackupRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(); base = Path(self.temp.name)
        self.root = base / "project"; self.root.mkdir(); self.memory_root = base / "memory"
        self.env = patch.dict(os.environ, {
            "CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_MEMORY_ROOT": str(self.memory_root),
        }, clear=False); self.env.start()
        self.runtime = Runtime(self.root, auth_token="memory-m4-token", transport="http", permission_mode="safe")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, self.runtime, lambda: self.runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start(); self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2); self.runtime.close(); self.env.stop(); self.temp.cleanup()

    def post(self, payload: dict, token: str | None = "memory-m4-token") -> tuple[int, dict]:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/__control/memory",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_private_m4_status_config_restore_export_import_and_tool_surface(self) -> None:
        self.assertEqual(self.post({"action": "status"}, None)[0], 401)
        status, body = self.post({"action": "status"})
        self.assertEqual(status, 200); self.assertEqual(body["result"]["profile"], "local-default")
        self.assertEqual(body["result"]["config"]["auto_memory"], "off")
        self.assertEqual(self.post({"action": "set_config", "auto_memory": "auto"})[1]["result"]["auto_memory"], "auto")

        item = self.runtime.memory_store.create(scope="global", memory_type="working_style", title="恢复测试", content="版本一")
        self.runtime.memory_store.update(item["memory_id"], content="版本二")
        self.assertEqual(self.post({"action": "restore", "memory_id": item["memory_id"], "revision": 1})[1]["code"], "CONFIRMATION_REQUIRED")
        status, restored = self.post({"action": "restore", "memory_id": item["memory_id"], "revision": 1, "confirm": True})
        self.assertEqual(status, 200); self.assertEqual(restored["result"]["content"], "版本一")

        backup = Path(self.temp.name) / "exported.zip"
        status, exported = self.post({"action": "export", "target": str(backup)})
        self.assertEqual(status, 200); self.assertTrue(Path(exported["result"]["path"]).is_file())
        self.assertEqual(self.post({"action": "import", "source": str(backup)})[1]["code"], "CONFIRMATION_REQUIRED")
        status, imported = self.post({"action": "import", "source": str(backup), "confirm": True})
        self.assertEqual(status, 200); self.assertTrue(imported["result"]["ok"])
        self.assertEqual(len(self.runtime.list_tools()["tools"]), 9)


if __name__ == "__main__":
    unittest.main()
