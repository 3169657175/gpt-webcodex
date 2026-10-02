from __future__ import annotations

import json
import re
from typing import Any

from .memory_store import MemoryStore, utc_now
from .memory_write import MemoryCandidateStore, MemoryWriteError, inspect_memory_safety

PROFILE_SOURCE = "auto_profile_v2"
PROFILE_MIGRATION_FILE = "auto-profile-v2.json"
LEGACY_CLEANUP_FILE = "legacy-cleanup-v3.json"
DISCOVERY_SOURCE = "auto_discovery_v3"

_CHITCHAT = re.compile(r"^(?:你好|您好|哈喽|嗨|hi|hello|hey|早上好|早安|晚安|晚上好|谢谢|谢了|多谢|好的|好|行|可以|收到|知道了|明白了|嗯|哦|噢|哈哈+|呵呵+|lol|再见|拜拜|bye)[！!。,.，\s]*$", re.I)
_MARKDOWN_NOISE = re.compile(r"```.*?```", re.S)
_URL = re.compile(r"https?://\S+", re.I)
_TOOL_LINE = re.compile(r"(?im)^\s*(?:工具\s*[×x]\s*\d+|called tool|used tool|tool call|thinking|正在思考|正在调用工具).*$")
_EXPLICIT_PROJECT = re.compile(r"(?:这个项目|当前项目|目前项目|本项目|该项目|这个软件|当前软件|这个应用|当前应用|这个仓库|当前仓库)", re.I)
_LONG_TERM_PROJECT = re.compile(r"(?:以后|长期|必须|默认|统一|固定|原则|规则|发布前|每次发布|始终|一律|不要再|不再)", re.I)
_PROJECT_SUMMARY = re.compile(r"(?:项目目标|这个项目是|本项目是|当前项目是|整体架构|目前架构|项目主要用于|项目用途)", re.I)

_TECH_TERMS = (
    ("前端", "前端"), ("后端", "后端"), ("网页", "网页开发"), ("网站", "网页开发"),
    ("应用", "应用开发"), ("Electron", "Electron"), ("MCP", "MCP"), ("大模型", "大模型"),
    ("AI", "AI"), ("Python", "Python"), ("Java", "Java"), ("API", "API"),
    ("数据库", "数据库"), ("Docker", "Docker"), ("Cloudflare", "Cloudflare"), ("GitHub", "GitHub"),
)
_INTEREST_CONTEXT = re.compile(r"(?:我.{0,12}(?:感兴趣|喜欢|关注|主要做|经常做|常做|方向|擅长)|我的.{0,8}(?:兴趣|方向)|常做的项目|比较感兴趣|平时.{0,6}做)", re.I)
_PROJECT_CONTEXT = re.compile(r"(?:常做的项目|经常做.{0,8}项目|平时.{0,8}项目|项目类型|项目.{0,12}(?:前端|后端|网页|网站|应用))", re.I)
_IDENTITY_CONTEXT = re.compile(r"(?:我是|本人是|我的身份|我目前是|我现在是|在读|读研|读博|研究生|硕士|博士|本科生)", re.I)
_MULTI_PROJECT = re.compile(r"(?:经常.{0,8}项目|常有.{0,8}项目|多个项目|很多项目|项目在做|同时.{0,6}项目)", re.I)


def _plain(value: Any, *, limit: int = 600) -> str:
    text = _MARKDOWN_NOISE.sub(" [代码省略] ", str(value or ""))
    text = _URL.sub("", text)
    text = _TOOL_LINE.sub("", text)
    text = re.sub(r"[`*_#>|]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    boundary = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind("."), cut.rfind("!"), cut.rfind("?"))
    if boundary >= max(24, limit // 2):
        cut = cut[: boundary + 1]
    return cut.rstrip() + "…"


def _title_fragment(text: str, *, limit: int = 48) -> str:
    value = re.sub(r"^(?:请|帮我|麻烦|能不能|可以|我个人认为|我觉得|我希望|我想要)\s*", "", text, flags=re.I).strip()
    value = re.split(r"[。！？!?\n]", value, maxsplit=1)[0].strip(" ：:，,；;")
    return (value[:limit].rstrip() + ("…" if len(value) > limit else "")) or "长期规则"


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = re.sub(r"\s+", "", value).strip("。；;，,").lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value.strip())
    return result


def _profile_item(title: str, memory_type: str, facts: list[str], *, scope: str = "global", project_id: str = "", pinned: bool = True) -> dict[str, Any] | None:
    facts = _unique(facts)
    if not facts:
        return None
    content = "\n".join(f"- {fact.rstrip('。')}。" for fact in facts)
    safety = inspect_memory_safety(title, content, allow_sensitive_personal=False)
    if not safety["allowed"]:
        return None
    return {
        "scope": scope,
        "memory_type": memory_type,
        "title": title,
        "content": content,
        "project_id": project_id if scope == "project" else "",
        "task_id": "",
        "source": PROFILE_SOURCE,
        "confidence": 0.92,
        "pinned": bool(pinned and scope == "global"),
    }


def extract_profile_memories(user_text: str, assistant_text: str = "", *, project_id: str = "", task_id: str = "") -> tuple[list[dict[str, Any]], str]:
    raw = str(user_text or "")
    compact = re.sub(r"\s+", " ", raw).strip()
    if not compact:
        return [], "skipped_empty"
    if _CHITCHAT.fullmatch(compact):
        return [], "skipped_chitchat"
    safety = inspect_memory_safety("自动记忆", raw, allow_sensitive_personal=False)
    if not safety["allowed"]:
        return [], "skipped_sensitive" if safety["code"] == "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED" else "rejected_secret"
    user = _plain(raw, limit=900)
    items: list[dict[str, Any]] = []

    identity_facts: list[str] = []
    if _IDENTITY_CONTEXT.search(user):
        if re.search(r"博士(?:研究生)?|读博", user):
            identity_facts.append("身份背景：博士研究生")
        elif re.search(r"硕士(?:研究生)?|研究生|读研", user):
            identity_facts.append("身份背景：研究生")
        elif re.search(r"本科生|本科在读", user):
            identity_facts.append("身份背景：本科生")
    if _MULTI_PROJECT.search(user):
        identity_facts.append("工作背景：经常同时推进多个项目")
    item = _profile_item("用户画像 · 身份与长期背景", "core_preference", identity_facts)
    if item:
        items.append(item)

    matched_tech: list[str] = []
    if _INTEREST_CONTEXT.search(user):
        lower = user.lower()
        for needle, label in _TECH_TERMS:
            if needle.lower() in lower:
                matched_tech.append(label)
    if matched_tech:
        item = _profile_item("用户画像 · 技术兴趣", "core_preference", ["技术兴趣：" + "、".join(_unique(matched_tech))])
        if item:
            items.append(item)

    if _PROJECT_CONTEXT.search(user):
        project_labels: list[str] = []
        lower = user.lower()
        for needle, label in _TECH_TERMS[:8]:
            if needle.lower() in lower and label in {"前端", "后端", "网页开发", "应用开发", "Electron", "MCP", "大模型", "AI"}:
                project_labels.append(label)
        if project_labels:
            item = _profile_item("用户画像 · 常做项目", "working_style", ["常做项目：" + "、".join(_unique(project_labels))])
            if item:
                items.append(item)

    style_facts: list[str] = []
    if re.search(r"(?:长任务|复杂任务).{0,30}(?:连续|从头到尾|不要.{0,8}停|直接做到|不中断)", user, re.I):
        style_facts.append("长任务偏好：尽量连续执行到完成，不要无必要地中途停下询问")
    if re.search(r"(?:进度|状态|反馈|汇报).{0,24}(?:及时|持续|看得到|可见|告诉我)|不要.{0,12}(?:没反馈|不汇报|没动静)", user, re.I):
        style_facts.append("协作偏好：长任务持续提供可见进度，并在异常或卡住时及时反馈")
    if re.search(r"(?:不需要|不要).{0,14}(?:每一步|每次).{0,10}(?:问|确认)|低风险.{0,10}(?:直接|继续)", user, re.I):
        style_facts.append("执行偏好：低风险修改可直接推进，避免每一步重复确认")
    item = _profile_item("用户画像 · 工作与协作方式", "working_style", style_facts)
    if item:
        items.append(item)

    communication_facts: list[str] = []
    if re.search(r"(?:界面|说明|回复|内容).{0,18}(?:中文|汉化)|(?:中文).{0,18}(?:界面|说明|回复|内容)", user, re.I):
        communication_facts.append("语言偏好：面向用户的界面、说明和反馈优先使用中文")
    if re.search(r"(?:长度适中|不要太长也不要太短|别太长|不要太啰嗦)", user, re.I):
        communication_facts.append("表达偏好：说明长度适中、重点清晰，避免过长或过短")
    if re.search(r"(?:UI|界面).{0,28}(?:干净|简洁|企业级|专业)|(?:不喜欢|不要).{0,16}(?:赛博|花里胡哨|花架子)", user, re.I):
        communication_facts.append("产品偏好：界面应干净、专业、实用，避免花哨但无实际价值的设计")
    item = _profile_item("用户画像 · 沟通与产品偏好", "core_preference", communication_facts)
    if item:
        items.append(item)

    environment_facts: list[str] = []
    if re.search(r"(?:Windows|Win11|Win10)", user, re.I) and re.search(r"(?:我|本地|电脑|环境|常用|主要)", user, re.I):
        environment_facts.append("常用开发环境：Windows")
    tools: list[str] = []
    if re.search(r"(?:我.{0,16}(?:常用|经常用|主要用)|常用工具|常用平台)", user, re.I):
        for name in ("Docker", "Cloudflare", "GitHub", "Electron", "Python", "VS Code", "Codex"):
            if name.lower() in user.lower():
                tools.append(name)
    if tools:
        environment_facts.append("常用工具与平台：" + "、".join(_unique(tools)))
    item = _profile_item("用户画像 · 常用环境", "working_style", environment_facts)
    if item:
        items.append(item)

    if project_id and _EXPLICIT_PROJECT.search(user) and _LONG_TERM_PROJECT.search(user):
        item = _profile_item(
            f"项目长期规则 · {_title_fragment(user)}",
            "decision",
            [_plain(user, limit=320)],
            scope="project",
            project_id=str(project_id),
            pinned=False,
        )
        if item:
            items.append(item)
    elif project_id and _EXPLICIT_PROJECT.search(user) and _PROJECT_SUMMARY.search(user):
        item = _profile_item(
            "项目摘要 · 长期背景",
            "project_summary",
            [_plain(user, limit=360)],
            scope="project",
            project_id=str(project_id),
            pinned=False,
        )
        if item:
            items.append(item)

    # De-duplicate same title/scope from a single turn.
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        key = (str(item["scope"]), str(item["title"]))
        if key not in merged:
            merged[key] = item
            continue
        facts = [line.strip() for line in (str(merged[key]["content"]) + "\n" + str(item["content"])).splitlines() if line.strip()]
        merged[key]["content"] = "\n".join(_unique(facts))
    return list(merged.values()), "ready" if merged else "skipped_low_value"


def extract_auto_memory(user_text: str, assistant_text: str = "", *, project_id: str = "", task_id: str = "") -> dict[str, Any]:
    items, status = extract_profile_memories(user_text, assistant_text, project_id=project_id, task_id=task_id)
    if not items:
        return {"status": status}
    first = dict(items[0])
    first["status"] = "ready"
    first["items"] = items
    return first


def _normalize_line(value: str) -> str:
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE).lower()


def _merge_content(existing: str, incoming: str, *, max_lines: int = 14) -> str:
    result: list[str] = []
    seen: set[str] = set()
    for line in (str(existing or "") + "\n" + str(incoming or "")).splitlines():
        line = line.strip()
        if not line:
            continue
        key = _normalize_line(line)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(line)
    return "\n".join(result[-max_lines:])


def _find_slot(store: MemoryStore, item: dict[str, Any]) -> dict[str, Any] | None:
    for existing in store.list(scope=str(item["scope"]), project_id=str(item.get("project_id") or ""), archived=False, limit=200):
        if str(existing.get("title") or "") != str(item["title"]):
            continue
        if str(existing.get("source") or "") != PROFILE_SOURCE:
            continue
        return existing
    return None


def _upsert_profile(store: MemoryStore, item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    existing = _find_slot(store, item)
    if existing is None:
        created = store.create(
            scope=str(item["scope"]), memory_type=str(item["memory_type"]), title=str(item["title"]), content=str(item["content"]),
            project_id=str(item.get("project_id") or ""), task_id="", source=PROFILE_SOURCE,
            confidence=float(item.get("confidence", 0.92)), pinned=bool(item.get("pinned", False)),
        )
        return "created", created
    merged = _merge_content(str(existing.get("content") or ""), str(item.get("content") or ""))
    desired_pinned = bool(item.get("pinned", False))
    if merged == str(existing.get("content") or "") and bool(existing.get("pinned")) == desired_pinned:
        return "duplicate", existing
    updated = store.update(existing["memory_id"], content=merged, source=PROFILE_SOURCE, confidence=max(float(existing.get("confidence", 0.0) or 0.0), float(item.get("confidence", 0.92))), pinned=desired_pinned)
    return "updated", updated


def _candidate_meta(result: dict[str, Any]) -> dict[str, Any]:
    return {key: result.get(key) for key in ("candidate_id", "status", "scope", "memory_type", "title", "existing_memory_id") if result.get(key) not in (None, "")}


def ingest_auto_memory(store: MemoryStore, candidates: MemoryCandidateStore, *, user_text: str, assistant_text: str = "", project_id: str = "", task_id: str = "") -> dict[str, Any]:
    mode = str(store.config().get("auto_memory") or "auto")
    if mode == "off":
        return {"status": "skipped_off", "mode": mode}
    items, extracted_status = extract_profile_memories(user_text, assistant_text, project_id=project_id, task_id=task_id)
    if not items:
        return {"status": extracted_status, "mode": mode}

    proposed_items: list[dict[str, Any]] = []
    relation = "duplicate"
    for item in items:
        try:
            proposed = candidates.propose(
                scope=str(item["scope"]), memory_type=str(item["memory_type"]), title=str(item["title"]), content=str(item["content"]),
                project_id=str(item.get("project_id") or ""), task_id="", source=DISCOVERY_SOURCE,
                confidence=float(item.get("confidence", 0.92)), pinned=bool(item.get("pinned", False)), allow_sensitive_personal=False,
            )
        except MemoryWriteError as error:
            if error.code == "SENSITIVE_PERSONAL_CONFIRMATION_REQUIRED":
                continue
            if error.code == "SECRET_REJECTED":
                return {"status": "rejected_secret", "mode": mode, "category": error.details.get("category", ""), "discovery_only": True}
            raise
        proposed_items.append(_candidate_meta(proposed))
        if str(proposed.get("status") or "") == "conflict":
            relation = "conflict"
        elif str(proposed.get("status") or "") not in {"duplicate", ""} and relation != "conflict":
            relation = "candidate"
    first = items[0]
    return {
        "status": relation, "mode": mode, "scope": first["scope"], "memory_type": first["memory_type"], "title": first["title"],
        "candidates": proposed_items, "candidate_count": sum(1 for entry in proposed_items if entry.get("status") not in {"duplicate", ""}),
        "discovery_only": True,
    }


def _legacy_user_text(content: str) -> str:
    text = str(content or "").strip()
    if text.startswith("用户信息："):
        return text[len("用户信息："):].strip()
    if text.startswith("用户提到："):
        text = text[len("用户提到："):]
        return text.split("相关结论：", 1)[0].strip()
    return text


def _looks_like_raw_task_prompt(item: dict[str, Any]) -> bool:
    if str(item.get("scope") or "") == "global" and bool(item.get("pinned")):
        return False
    if str(item.get("source") or "") in {"explicit_user", "model_summary"}:
        return False
    text = f"{item.get('title') or ''}\n{item.get('content') or ''}"
    if len(text) < 320:
        return False
    stage_hits = len(re.findall(r"(?:【?第[一二三四五六七八九十\d]+阶段[：:】]?|第一阶段|第二阶段|第三阶段)", text, re.I))
    task_hits = sum(1 for pattern in (
        r"目标不是.{0,30}(?:分析|方案)", r"读取当前项目", r"根据实际代码", r"不要让我选择方案",
        r"你自己决定", r"一步一步", r"最终(?:生成|发布|完成)", r"必须分析根因",
    ) if re.search(pattern, text, re.I))
    return stage_hits >= 2 and task_hits >= 2


def _cleanup_legacy_raw_prompts(store: MemoryStore) -> dict[str, Any]:
    marker = store.system_dir / LEGACY_CLEANUP_FILE
    if marker.exists():
        try:
            return json.loads(marker.read_text(encoding="utf-8"))
        except Exception:
            return {"status": "already_cleaned", "archived_raw_prompts": 0}
    archived_ids: list[str] = []
    for item in list(store.list(archived=False, limit=200)):
        if not _looks_like_raw_task_prompt(item):
            continue
        store.archive(str(item["memory_id"]), reason="Legacy V3：疑似一次性阶段式任务 Prompt")
        archived_ids.append(str(item["memory_id"]))
    result = {
        "status": "cleaned", "policy_version": 3,
        "archived_raw_prompts": len(archived_ids), "archived_memory_ids": archived_ids,
        "cleaned_at": utc_now(),
    }
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def migrate_legacy_auto_memories(store: MemoryStore) -> dict[str, Any]:
    marker = store.system_dir / PROFILE_MIGRATION_FILE
    if marker.exists():
        try:
            result = json.loads(marker.read_text(encoding="utf-8"))
        except Exception:
            result = {"status": "already_migrated", "policy_version": 2, "archived_legacy": 0, "summarized": 0}
    else:
        archived = 0
        summarized = 0
        for old in list(store.list(archived=False, limit=200)):
            if str(old.get("source") or "") != "auto_chat":
                continue
            raw = _legacy_user_text(str(old.get("content") or ""))
            items, _ = extract_profile_memories(raw, project_id=str(old.get("project_id") or ""), task_id=str(old.get("task_id") or ""))
            for item in items:
                action, _memory = _upsert_profile(store, item)
                if action in {"created", "updated"}:
                    summarized += 1
            store.archive(str(old["memory_id"]), reason="Legacy V2：旧版自动聊天记忆迁移")
            archived += 1
        result = {"status": "migrated", "policy_version": 2, "archived_legacy": archived, "summarized": summarized, "migrated_at": utc_now()}
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    cleanup = _cleanup_legacy_raw_prompts(store)
    return {**result, "legacy_cleanup": cleanup, "archived_raw_prompts": int(cleanup.get("archived_raw_prompts") or 0)}
