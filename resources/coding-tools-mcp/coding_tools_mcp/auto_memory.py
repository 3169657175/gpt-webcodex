from __future__ import annotations
import re
from typing import Any
from .memory_store import MemoryStore
from .memory_write import MemoryCandidateStore, MemoryWriteError, inspect_memory_safety

_CHITCHAT = re.compile(r"^(?:你好|您好|哈喽|嗨|hi|hello|hey|早上好|早安|晚安|晚上好|谢谢|谢了|多谢|好的|好|行|可以|收到|知道了|明白了|嗯|哦|噢|哈哈+|呵呵+|lol|再见|拜拜|bye)[！!。,.，\s]*$", re.I)
_PROJECT = re.compile(r"(?:项目|代码|仓库|软件|应用|界面|页面|前端|后端|接口|数据库|MCP|Electron|Runtime|Tunnel|Git|工作区|版本|安装包|测试|构建|发布|功能|bug|修复|开发|脚本|模型|API|服务|服务器)", re.I)
_EXPLICIT_PROJECT = re.compile(r"(?:这个项目|当前项目|目前项目|本项目|该项目|这个软件|当前软件|这个应用|当前应用|这个仓库|当前仓库)", re.I)
_PERSONAL_PREF = re.compile(r"(?:我(?:更)?喜欢|我偏好|我希望|我想要|我不喜欢|我讨厌|对我来说|我个人(?:更)?喜欢|我个人(?:更)?希望)", re.I)
_PERSONAL_GOAL = re.compile(r"(?:我的目标|我的计划|我打算|我准备|我希望自己|我以后要)", re.I)
_PREFERENCE = re.compile(r"(?:我(?:更)?喜欢|我偏好|我希望|我想要|我不喜欢|我讨厌|对我来说|尽量|最好|优先|默认|以后.*(?:请|希望)|不要|别再)", re.I)
_WORK_STYLE = re.compile(r"(?:我习惯|我的习惯|工作方式|学习方式|做事方式|一般会|通常会|每次都|长期都|总是|经常会)", re.I)
_GOAL = re.compile(r"(?:目标|计划|准备|打算|想要|希望.*(?:完成|做到|达到|实现)|以后要|下一步|待办|后续|还需要|还没|继续)", re.I)
_DECISION = re.compile(r"(?:决定|确定|以后|必须|不要|不再|采用|保持|改成|规则|原则|统一|固定|默认|优先|只允许|禁止)", re.I)
_PITFALL = re.compile(r"(?:bug|问题|异常|报错|失败|卡住|中断|不稳定|丢失|重复|错误|无法|不能|没反应)", re.I)
_PROJECT_SUMMARY = re.compile(r"(?:这个项目|当前项目|目前项目|项目是|项目目标|现在的架构|目前架构|整体架构)", re.I)
_MARKDOWN_NOISE = re.compile(r"```.*?```", re.S)
_URL = re.compile(r"https?://\S+", re.I)
_TOOL_LINE = re.compile(r"(?im)^\s*(?:工具\s*[×x]\s*\d+|called tool|used tool|tool call|thinking|正在思考|正在调用工具).*$")

def _plain(value: Any, *, limit: int) -> str:
    text = _MARKDOWN_NOISE.sub(" [代码省略] ", str(value or "")); text = _URL.sub("", text); text = _TOOL_LINE.sub("", text); text = re.sub(r"[`*_#>|]+", " ", text); text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit: return text
    cut = text[:limit]; boundary = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind("."), cut.rfind("!"), cut.rfind("?"))
    if boundary >= max(24, limit // 2): cut = cut[: boundary + 1]
    return cut.rstrip() + "…"

def _title_fragment(text: str, *, limit: int = 52) -> str:
    value = re.sub(r"^(?:请|帮我|麻烦|能不能|可以|我个人认为|我觉得|我希望|我想要)\s*", "", text, flags=re.I).strip(); value = re.split(r"[。！？!?\n]", value, maxsplit=1)[0].strip(" ：:，,；;"); return (value[:limit].rstrip() + ("…" if len(value) > limit else "")) or "对话中的有用信息"

def extract_auto_memory(user_text: str, assistant_text: str = "", *, project_id: str = "", task_id: str = "") -> dict[str, Any]:
    raw_user, raw_assistant = str(user_text or ""), str(assistant_text or "")
    if not raw_user.strip() or _CHITCHAT.fullmatch(re.sub(r"\s+", " ", raw_user).strip()): return {"status": "skipped_chitchat"}
    safety = inspect_memory_safety("自动记忆", raw_user, allow_sensitive_personal=False)
    if not safety["allowed"]: return {"status": "skipped_sensitive" if safety["code"] == "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED" else "rejected_secret", "category": safety.get("category", "")}
    user, assistant = _plain(raw_user, limit=560), _plain(raw_assistant, limit=300)
    if not user: return {"status": "skipped_empty"}
    explicit_project = bool(project_id and _EXPLICIT_PROJECT.search(user))
    personal_context = bool(_WORK_STYLE.search(user) or _PERSONAL_PREF.search(user) or _PERSONAL_GOAL.search(user))
    projectish = bool(project_id and (explicit_project or (_PROJECT.search(user) and not personal_context)))
    scope = "project" if projectish else "global"
    if projectish:
        if _DECISION.search(user): memory_type, prefix = "decision", "决定"
        elif _PITFALL.search(user): memory_type, prefix = "pitfall", "问题"
        elif _GOAL.search(user): memory_type, prefix = "open_loop", "待继续"
        elif _PROJECT_SUMMARY.search(user): memory_type, prefix = "project_summary", "项目"
        else: memory_type, prefix = (("task_summary", "任务") if assistant else ("note", "记录"))
    else:
        if _WORK_STYLE.search(user): memory_type, prefix = "working_style", "习惯"
        elif _PREFERENCE.search(user): memory_type, prefix = "core_preference", "偏好"
        elif _GOAL.search(user): memory_type, prefix = "open_loop", "目标"
        else: memory_type, prefix = "note", "记录"
    title = f"{prefix}：{_title_fragment(user)}"
    content = f"用户信息：{user}" if memory_type in {"core_preference", "working_style", "open_loop"} else (f"用户提到：{user}\n相关结论：{assistant}" if assistant else f"用户提到：{user}")
    content = _plain(content, limit=980); final_safety = inspect_memory_safety(title, content, allow_sensitive_personal=False)
    if not final_safety["allowed"]: return {"status": "skipped_sensitive" if final_safety["code"] == "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED" else "rejected_secret", "category": final_safety.get("category", "")}
    return {"status": "ready", "scope": scope, "memory_type": memory_type, "title": title, "content": content, "project_id": str(project_id or "") if scope == "project" else "", "task_id": "", "source": "auto_chat", "confidence": 0.82, "pinned": memory_type in {"core_preference", "working_style"}}

def _candidate_meta(result: dict[str, Any]) -> dict[str, Any]: return {key: result.get(key) for key in ("candidate_id", "status", "scope", "memory_type", "title", "existing_memory_id") if result.get(key) not in (None, "")}

def ingest_auto_memory(store: MemoryStore, candidates: MemoryCandidateStore, *, user_text: str, assistant_text: str = "", project_id: str = "", task_id: str = "") -> dict[str, Any]:
    mode = str(store.config().get("auto_memory") or "off")
    if mode == "off": return {"status": "skipped_off", "mode": mode}
    extracted = extract_auto_memory(user_text, assistant_text, project_id=project_id, task_id=task_id)
    if extracted.get("status") != "ready": return {**extracted, "mode": mode}
    try: proposed = candidates.propose(scope=str(extracted["scope"]), memory_type=str(extracted["memory_type"]), title=str(extracted["title"]), content=str(extracted["content"]), project_id=str(extracted.get("project_id") or ""), task_id="", source="auto_chat", confidence=0.82, pinned=bool(extracted.get("pinned", False)), allow_sensitive_personal=False)
    except MemoryWriteError as error:
        if error.code == "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED": return {"status": "skipped_sensitive", "mode": mode, "category": error.details.get("category", "")}
        if error.code == "SECRET_REJECTED": return {"status": "rejected_secret", "mode": mode, "category": error.details.get("category", "")}
        raise
    base = {"mode": mode, "scope": str(extracted["scope"]), "memory_type": str(extracted["memory_type"]), "title": str(extracted["title"])}; relation = str(proposed.get("status") or "")
    if relation == "duplicate": return {**base, "status": "duplicate", "existing": proposed.get("existing")}
    if relation == "conflict": return {**base, "status": "conflict", "candidate": _candidate_meta(proposed)}
    if mode == "suggest": return {**base, "status": "candidate", "candidate": _candidate_meta(proposed)}
    confirmed = candidates.confirm(str(proposed.get("candidate_id") or "")); confirmed_status = str(confirmed.get("status") or "")
    if confirmed_status in {"created", "updated"}:
        memory = confirmed.get("memory") or {}; return {**base, "status": "remembered", "action": confirmed_status, "memory": {"memory_id": str(memory.get("memory_id") or ""), "scope": str(memory.get("scope") or extracted["scope"]), "memory_type": str(memory.get("memory_type") or extracted["memory_type"]), "title": str(memory.get("title") or extracted["title"])}}
    if confirmed_status == "duplicate": return {**base, "status": "duplicate", "existing": confirmed.get("existing")}
    return {**base, "status": confirmed_status or "candidate", "candidate": _candidate_meta(proposed)}
