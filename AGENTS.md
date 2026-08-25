# 网页 MCP 助手维护指令

## 项目目标

- 这是 Windows Electron 桌面助手，负责承载 ChatGPT 页面、Coding Tools MCP 本地 Runtime 与 OpenAI Tunnel。
- 优先级顺序：数据安全 > Runtime/Schema 一致性 > 长任务可恢复 > 模型上下文效率 > UI 功能数量。
- 所有面向用户的界面、状态、错误和操作说明尽量使用中文；协议字段、代码标识符和官方专有名词可保留英文。

## 关键目录

- `electron/`：Electron 主进程、ChatGPT WebContents 与 Runtime/Tunnel 编排。
- `renderer/`：桌面管理界面。
- `resources/coding-tools-mcp/`：内置 Coding Tools MCP Python Runtime。
- `tests/`：Electron/Node 回归测试。
- `resources/coding-tools-mcp/tests/`：MCP Runtime Python 回归与场景测试。
- `scripts/check-schema-contract.py`：公共 MCP Schema 契约生成与校验。

## 修改规则

- 主工作区可能长期存在未提交修改。复杂修改优先使用 run-scoped Git Worktree；应用回主工作区前必须做冲突检查，禁止自动 merge/rebase/reset 用户工作区。
- 不要提交或交付测试生成的 `__pycache__` / `.pyc` 变化。Python 测试应设置 `PYTHONDONTWRITEBYTECODE=1`。
- `current_command` 只表示当前仍在执行的命令。任务进入 `completed` / `failed` / `cancelled` 后必须结算到历史字段并清空当前命令。
- ChatGPT 页面、OpenAI Tunnel、本地 MCP Runtime 是三个故障层。页面或 Tunnel 异常不得无条件重启健康的 MCP Runtime。
- Runtime 重启必须确认旧 PID 已退出、端口已释放，并校验新 `process_id`、`launch_id`、`runtime_instance_id`、源码指纹、Schema version/hash 与 workspace。
- 修改 `coding_tools_mcp` 任意 Python 运行时代码都必须改变 Runtime source fingerprint；不要恢复成手工文件白名单。

## MCP Schema 与模型数据

- 修改公开工具名、参数、枚举、默认值或含义时，提升 `TOOL_SCHEMA_VERSION`，然后运行 `python scripts/check-schema-contract.py --write` 更新 `schema-contract.json`。
- `server/discover` 与健康端点的 Runtime/Schema 身份必须保持一致。
- ChatGPT 外部调用默认返回 compact model payload；桌面内部调用可以保留 full 数据。不要为了桌面 UI 方便把完整 events、历史 build、巨大 diff、prepared/workspace/task_resume 默认塞回模型上下文。
- 需要完整调试数据时使用显式 `detail=full` / `response_detail=full`，不要把 full 重新设为默认。

## 版本发布

- 桌面版本至少同步：`package.json`、`package-lock.json`、管理界面版本展示、相关测试与文档。
- MCP Runtime 版本同步：`coding_tools_mcp/__init__.py` 与 `pyproject.toml`。
- Schema 契约中的 runtime version、schema version、schema hash、tool count 必须由脚本生成并与运行时一致。

## 验证

- 常规全量测试：`npm run test`。
- 构建安装包：`npm run dist`；构建前必须先保证全量测试和 Schema 契约通过。
- 涉及 Runtime 重启、Schema、Tunnel 或长任务时，除单元测试外还要验证：旧进程退出、新进程身份变化、同端口同 Token 重新 discovery、后台任务状态可恢复、主 Git index 未被 Worktree 流程改动。
- 不要因为某个测试命令的工作目录或依赖环境配置错误就把代码判定为失败；先确认命令实际运行目录和内置 Python/vendor 环境。
