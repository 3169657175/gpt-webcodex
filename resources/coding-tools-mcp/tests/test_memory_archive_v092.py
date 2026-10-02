from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from coding_tools_mcp.memory_store import MemoryStore


class MemoryArchiveV092Tests(unittest.TestCase):
    def test_archive_metadata_and_unarchive_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MemoryStore(Path(temp) / "memory-v1")
            created = store.create(
                scope="global",
                memory_type="working_style",
                title="反馈偏好",
                content="长任务要持续反馈进度",
            )

            archived = store.archive(created["memory_id"], reason="用户手动归档")
            self.assertTrue(archived["archived"])
            self.assertEqual(archived["archive_reason"], "用户手动归档")
            self.assertTrue(archived["archived_at"])
            self.assertIn("archive", archived["file_path"])
            self.assertEqual(store.list(archived=False), [])
            self.assertEqual(len(store.list(archived=True)), 1)

            restored = store.unarchive(created["memory_id"])
            self.assertFalse(restored["archived"])
            self.assertEqual(restored["archive_reason"], "")
            self.assertEqual(restored["archived_at"], "")
            self.assertNotIn("archive/", restored["file_path"].replace("\\", "/"))
            self.assertEqual(len(store.list(archived=False)), 1)
            self.assertEqual(store.list(archived=True), [])


if __name__ == "__main__":
    unittest.main()
