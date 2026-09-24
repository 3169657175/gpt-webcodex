from __future__ import annotations
import tempfile, unittest
from pathlib import Path
from coding_tools_mcp.auto_memory import extract_auto_memory, ingest_auto_memory
from coding_tools_mcp.memory_store import MemoryStore
from coding_tools_mcp.memory_write import MemoryCandidateStore
class AutoMemoryV042Tests(unittest.TestCase):
    def make(self):
        temp=tempfile.TemporaryDirectory(); store=MemoryStore(Path(temp.name)/'memory'); return temp,store,MemoryCandidateStore(store)
    def test_chitchat_is_skipped(self):
        t,s,c=self.make();
        try: s.set_auto_memory('auto'); self.assertEqual(ingest_auto_memory(s,c,user_text='你好',assistant_text='你好呀')['status'],'skipped_chitchat'); self.assertEqual(s.list(limit=20),[])
        finally:t.cleanup()
    def test_suggest_broad_preference_candidate(self):
        t,s,c=self.make();
        try: s.set_auto_memory('suggest'); r=ingest_auto_memory(s,c,user_text='我平时更喜欢深色界面，而且展示给我的内容尽量使用中文。',assistant_text='明白。'); self.assertEqual((r['status'],r['scope'],r['memory_type']),('candidate','global','core_preference')); self.assertEqual(len(c.list()),1); self.assertEqual(s.list(limit=20),[])
        finally:t.cleanup()
    def test_auto_work_style_and_goal(self):
        t,s,c=self.make();
        try: s.set_auto_memory('auto'); a=ingest_auto_memory(s,c,user_text='我习惯长任务从头到尾连续执行，不要每一步都停下来问我。'); b=ingest_auto_memory(s,c,user_text='我的计划是今年把日语学到 N2 水平。'); self.assertEqual((a['status'],a['memory_type']),('remembered','working_style')); self.assertEqual((b['status'],b['memory_type']),('remembered','open_loop')); self.assertEqual(len(s.list(limit=20)),2)
        finally:t.cleanup()
    def test_project_decision_and_conclusion(self):
        a=extract_auto_memory('这个项目以后发布前必须完整跑测试，不能只跑专项测试。',project_id='p'); self.assertEqual((a['scope'],a['memory_type']),('project','decision')); b=extract_auto_memory('帮我把这个软件的设置页面彻底重构。','设置页面已经完成重构并通过全部测试。',project_id='p'); self.assertEqual(b['scope'],'project'); self.assertIn('相关结论',b['content'])
    def test_secret_and_sensitive_not_stored(self):
        t,s,c=self.make();
        try: s.set_auto_memory('auto'); self.assertEqual(ingest_auto_memory(s,c,user_text='我的 API Key: sk-abcdefghijklmnop')['status'],'rejected_secret'); self.assertEqual(ingest_auto_memory(s,c,user_text='我刚做完骨折手术，需要长期恢复。')['status'],'skipped_sensitive'); self.assertEqual(s.list(limit=20),[]); self.assertEqual(c.list(),[])
        finally:t.cleanup()
    def test_duplicate(self):
        t,s,c=self.make();
        try: s.set_auto_memory('auto'); x='我希望软件里所有面向我的界面都尽量使用中文。'; self.assertEqual(ingest_auto_memory(s,c,user_text=x)['status'],'remembered'); self.assertEqual(ingest_auto_memory(s,c,user_text=x)['status'],'duplicate'); self.assertEqual(len(s.list(limit=20)),1)
        finally:t.cleanup()
    def test_conflict_stays_candidate(self):
        t,s,c=self.make();
        try: s.set_auto_memory('auto'); x='这个项目以后默认使用深色主题。'; e=extract_auto_memory(x,project_id='p'); s.create(scope=e['scope'],memory_type=e['memory_type'],title=e['title'],content='旧决定：默认使用浅色主题。',project_id='p',source='manual'); r=ingest_auto_memory(s,c,user_text=x,project_id='p'); self.assertEqual(r['status'],'conflict'); self.assertEqual(len(c.list()),1); self.assertEqual(len(s.list(limit=20)),1)
        finally:t.cleanup()
if __name__=='__main__': unittest.main()
