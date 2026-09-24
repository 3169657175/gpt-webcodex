from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from coding_tools_mcp.history_store import HistoryStore


class HistoryStoreTests(unittest.TestCase):
    def sample(self) -> dict:
        return {
            "task_id": "task-1", "run_id": "run-1", "local_session_id": "ls_" + "a" * 24,
            "project_id": "project-1", "objective": "Fix login timeout", "summary": "Changed retry boundary",
            "status": "completed", "created_at": "2026-08-28T01:00:00Z", "updated_at": "2026-08-28T02:00:00Z",
            "modified_files": [{"path": "src/login.js", "operation": "update"}],
            "test_results": [{"status": "passed", "command": "npm test", "summary": "login tests passed", "stdout": "DO_NOT_STORE"}],
            "build_results": [{"status": "passed", "command": "npm run build", "summary": "build ok", "output": "DO_NOT_STORE"}],
            "failure": "", "checkpoint_id": "cp_" + "b" * 24, "branch": "main", "version": "0.2.9",
            "continuation_brief": {"goal": "Fix login timeout", "completed": ["retry fixed"], "pending": ["release"], "next_action": "release"},
            "session_evidence": {
                "verdict": "passed", "objective": "Fix login timeout", "summary": "evidence summary",
                "modified_files": [{"path": "src/login.js", "operation": "update"}],
                "tests": {"count": 1, "passed": 1, "failed": 0, "latest": {"status": "passed", "summary": "ok", "stdout": "EVIDENCE_SECRET"}},
                "builds": {"count": 1, "passed": 1, "failed": 0, "latest": {"status": "passed", "summary": "ok", "output": "EVIDENCE_SECRET"}},
                "unfinished_steps": ["release"], "local_session_id": "ls_" + "a" * 24, "checkpoint_id": "cp_" + "b" * 24,
                "git": {"branch": "main", "head": "abc", "raw_diff": "EVIDENCE_SECRET"},
                "worktree": {"exists": True, "clean": True, "status": "completed", "status_summary": "EVIDENCE_SECRET"},
                "failure": "", "source": "EVIDENCE_SECRET",
            },
            "raw_diff": "SECRET_SOURCE_DIFF", "stdout": "SECRET_STDOUT",
        }

    def test_upsert_is_idempotent_and_payload_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = HistoryStore(Path(temp))
            one = store.upsert(self.sample())
            two = store.upsert({**self.sample(), "summary": "updated summary"})
            self.assertEqual(one["history_id"], two["history_id"])
            items = store.list(limit=10)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["summary"], "updated summary")
            encoded = json.dumps(items[0])
            self.assertNotIn("SECRET_STDOUT", encoded)
            self.assertNotIn("SECRET_SOURCE_DIFF", encoded)
            self.assertNotIn("DO_NOT_STORE", encoded)
            self.assertNotIn("EVIDENCE_SECRET", encoded)
            self.assertEqual(items[0]["session_evidence"]["verdict"], "passed")
            self.assertEqual(items[0]["session_evidence"]["unfinished_steps"], ["release"])

    def test_fts_search_filters_project_and_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = HistoryStore(Path(temp))
            store.upsert(self.sample())
            store.upsert({**self.sample(), "task_id": "task-2", "run_id": "run-2", "project_id": "project-2", "local_session_id": "ls_" + "c" * 24, "objective": "Render dashboard"})
            result = store.search("login", project_id="project-1", limit=10)
            self.assertEqual([item["task_id"] for item in result], ["task-1"])
            self.assertEqual(store.search("dashboard", local_session_id="ls_" + "a" * 24), [])
            self.assertEqual(store.search("src/login.js", project_id="project-1")[0]["task_id"], "task-1")
            store.upsert({**self.sample(), "task_id": "task-cn", "run_id": "run-cn", "objective": "修复登录超时"})
            self.assertEqual(store.search("登录", limit=10)[0]["task_id"], "task-cn")

    def test_legacy_import_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".coding-tools"
            state.mkdir()
            (state / "task-history.json").write_text(json.dumps([self.sample(), {**self.sample(), "summary": "newer copy"}]), encoding="utf-8")
            store = HistoryStore(root)
            first = store.import_legacy_json()
            second = store.import_legacy_json()
            self.assertEqual(first["seen"], 2)
            self.assertEqual(second["seen"], 2)
            self.assertEqual(len(store.list(limit=10)), 1)
            self.assertEqual(store.list(limit=1)[0]["summary"], "newer copy")

    def test_corrupt_database_is_quarantined_and_rebuilt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            history = root / ".coding-tools" / "history"
            history.mkdir(parents=True)
            (history / "history.db").write_bytes(b"not-a-sqlite-db")
            store = HistoryStore(root)
            store.upsert(self.sample())
            self.assertEqual(len(store.search("login")), 1)
            quarantined = list(history.glob("history.db.corrupt-*"))
            self.assertTrue(quarantined)
            connection = sqlite3.connect(history / "history.db")
            try:
                self.assertEqual(connection.execute("PRAGMA quick_check").fetchone()[0], "ok")
            finally:
                connection.close()

    def test_rebuild_from_legacy_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".coding-tools"
            state.mkdir()
            (state / "task-history.json").write_text(json.dumps([self.sample()]), encoding="utf-8")
            store = HistoryStore(root)
            store.upsert({**self.sample(), "task_id": "extra", "run_id": "extra", "objective": "temporary"})
            result = store.rebuild()
            self.assertEqual(result["imported"], 1)
            self.assertEqual([item["task_id"] for item in store.list(limit=10)], ["task-1"])

    def test_v1_database_migrates_in_place_to_session_evidence_v2(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            history = root / ".coding-tools" / "history"
            history.mkdir(parents=True)
            connection = sqlite3.connect(history / "history.db")
            try:
                connection.executescript("""
                    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    INSERT INTO meta(key,value) VALUES('schema_version','1');
                    CREATE TABLE history(
                        history_id TEXT PRIMARY KEY, task_id TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '',
                        local_session_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
                        objective TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '',
                        modified_files_json TEXT NOT NULL DEFAULT '[]', execution_ids_json TEXT NOT NULL DEFAULT '[]',
                        test_results_json TEXT NOT NULL DEFAULT '[]', build_results_json TEXT NOT NULL DEFAULT '[]',
                        failure TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
                        version TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
                        continuation_json TEXT NOT NULL DEFAULT '{}', archive_reason TEXT NOT NULL DEFAULT '', search_text TEXT NOT NULL DEFAULT ''
                    );
                    CREATE VIRTUAL TABLE history_fts USING fts5(history_id UNINDEXED, search_text, tokenize='unicode61');
                    INSERT INTO history(history_id,task_id,run_id,objective) VALUES('hist_old','task-old','run-old','old task');
                """)
                connection.commit()
            finally:
                connection.close()
            store = HistoryStore(root)
            migrated = store.get("hist_old")
            self.assertIsNotNone(migrated)
            self.assertEqual(migrated["session_evidence"], {})
            connection = sqlite3.connect(history / "history.db")
            try:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(history)").fetchall()}
                version = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            finally:
                connection.close()
            self.assertIn("session_evidence_json", columns)
            self.assertEqual(version, "2")


if __name__ == "__main__":
    unittest.main()
