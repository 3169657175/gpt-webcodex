from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coding_tools_mcp.auto_memory import extract_auto_memory, ingest_auto_memory, migrate_legacy_auto_memories
from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.memory_write import MemoryCandidateStore


class AutoMemoryV042Tests(unittest.TestCase):
    def make(self):
        temp = tempfile.TemporaryDirectory()
        store = MemoryStore(Path(temp.name) / "memory")
        return temp, store, MemoryCandidateStore(store)

    def test_default_auto_mode_and_chitchat_is_skipped(self):
        temp, store, candidates = self.make()
        try:
            self.assertEqual(store.config()["auto_memory"], "auto")
            result = ingest_auto_memory(store, candidates, user_text="你好", assistant_text="你好呀")
            self.assertEqual(result["status"], "skipped_chitchat")
            self.assertEqual(store.list(limit=20), [])
        finally:
            temp.cleanup()

    def test_suggest_creates_profile_candidate(self):
        temp, store, candidates = self.make()
        try:
            store.set_auto_memory("suggest")
            result = ingest_auto_memory(
                store,
                candidates,
                user_text="我希望面向我的界面和说明尽量使用中文，而且 UI 要干净专业。",
                assistant_text="明白。",
            )
            self.assertEqual(result["status"], "candidate")
            self.assertEqual(len(candidates.list()), 1)
            self.assertEqual(store.list(limit=20), [])
        finally:
            temp.cleanup()

    def test_auto_updates_bounded_profile_slots_and_skips_one_off_goal(self):
        temp, store, candidates = self.make()
        try:
            first = ingest_auto_memory(
                store,
                candidates,
                user_text="我习惯长任务从头到尾连续执行，不要每一步都停下来问我，还要持续给我反馈进度。",
            )
            second = ingest_auto_memory(store, candidates, user_text="我的计划是今年把日语学到 N2 水平。")
            self.assertEqual(first["status"], "remembered")
            self.assertEqual(second["status"], "skipped_low_value")
            items = store.list(limit=20)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["title"], "用户画像 · 工作与协作方式")
            self.assertTrue(items[0]["pinned"])
        finally:
            temp.cleanup()

    def test_identity_interest_and_project_types_are_summary_profiles(self):
        temp, store, candidates = self.make()
        try:
            result = ingest_auto_memory(
                store,
                candidates,
                user_text="我是研究生，经常同时有多个项目在做，平时比较感兴趣前端、后端、网页和应用开发。",
            )
            self.assertEqual(result["status"], "remembered")
            titles = {item["title"] for item in store.list(limit=20)}
            self.assertIn("用户画像 · 身份与长期背景", titles)
            self.assertIn("用户画像 · 技术兴趣", titles)
        finally:
            temp.cleanup()

    def test_project_long_term_rule_is_kept_but_one_off_bug_is_not(self):
        long_term = extract_auto_memory("这个项目以后发布前必须完整跑测试，不能只跑专项测试。", project_id="p")
        one_off = extract_auto_memory("这个项目现在设置页面打不开，帮我修一下。", "已经修好。", project_id="p")
        self.assertEqual((long_term["scope"], long_term["memory_type"]), ("project", "decision"))
        self.assertEqual(one_off["status"], "skipped_low_value")

    def test_secret_and_sensitive_not_stored(self):
        temp, store, candidates = self.make()
        try:
            self.assertEqual(ingest_auto_memory(store, candidates, user_text="我的 API Key: sk-abcdefghijklmnop")["status"], "rejected_secret")
            self.assertEqual(ingest_auto_memory(store, candidates, user_text="我刚做完骨折手术，需要长期恢复。")["status"], "skipped_sensitive")
            self.assertEqual(store.list(limit=20), [])
            self.assertEqual(candidates.list(), [])
        finally:
            temp.cleanup()

    def test_duplicate_profile_does_not_grow_library(self):
        temp, store, candidates = self.make()
        try:
            text = "我希望软件里所有面向我的界面和说明都尽量使用中文。"
            self.assertEqual(ingest_auto_memory(store, candidates, user_text=text)["status"], "remembered")
            self.assertEqual(ingest_auto_memory(store, candidates, user_text=text)["status"], "duplicate")
            self.assertEqual(len(store.list(limit=20)), 1)
        finally:
            temp.cleanup()

    def test_legacy_auto_chat_is_summarized_then_archived_once(self):
        temp, store, _candidates = self.make()
        try:
            useful = store.create(
                scope="global",
                memory_type="core_preference",
                title="偏好：旧聊天片段",
                content="用户信息：我希望面向我的界面和说明尽量使用中文。",
                source="auto_chat",
                pinned=True,
            )
            junk = store.create(
                scope="project",
                memory_type="pitfall",
                title="问题：某次临时 Bug",
                content="用户提到：这个项目现在按钮点不开，帮我修一下。 相关结论：已修复。",
                project_id="project-a",
                source="auto_chat",
            )
            result = migrate_legacy_auto_memories(store)
            self.assertEqual(result["status"], "migrated")
            self.assertEqual(result["archived_legacy"], 2)
            active = store.list(archived=False, limit=20)
            archived = store.list(archived=True, limit=20)
            self.assertTrue(any(item["title"] == "用户画像 · 沟通与产品偏好" for item in active))
            self.assertEqual({item["memory_id"] for item in archived}, {useful["memory_id"], junk["memory_id"]})
            self.assertEqual(migrate_legacy_auto_memories(store)["status"], "migrated")
            self.assertEqual(len(store.list(archived=False, limit=20)), len(active))
        finally:
            temp.cleanup()


if __name__ == "__main__":
    unittest.main()
