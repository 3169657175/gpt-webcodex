# v0.2.4 网页 MCP 助手

v0.2.4 重点提升了复杂代码任务的安全性、长任务可恢复能力以及本地 MCP Runtime 的稳定性，并补全了 Git / Worktree、任务通知、自动构建验证和系统诊断能力。

## 本版重点新增

- **Git / Worktree 安全隔离**：复杂代码任务可在独立 Git Worktree 中完成修改和验证，支持查看 Diff、应用结果或直接丢弃隔离任务。
- **保护主工作区**：应用 Worktree 结果时不主动修改主 Git 暂存区；如果任务开始后主工作区同一文件又发生变化，会拒绝静默覆盖。
- **后台长任务**：测试、构建和 Agent 工作流支持后台 operation，具备真实 heartbeat、当前步骤、正在运行命令和任务恢复状态。
- **任务可恢复**：刷新网页、切换聊天或 Runtime 重启后仍可重新读取任务状态，支持暂停、继续、停止、历史任务和失败恢复。
- **Windows 桌面通知**：任务完成、失败、中断或明确等待用户处理时弹出系统通知，点击可返回 ChatGPT，并支持通知声音与测试通知。
- **Runtime 生命周期增强**：ChatGPT 页面、OpenAI Tunnel、本地 MCP Runtime 分层处理，避免页面或 Tunnel 异常误重启健康的 MCP Runtime。
- **Runtime / Schema 一致性**：通过 process ID、launch ID、runtime instance、源码指纹以及 Schema version/hash 检查减少旧进程、旧 Schema 和错误复用问题。
- **MCP 调用恢复**：部分只读状态工具在 Runtime 变化后可重新 discovery 并安全重试。
- **性能分析**：任务中心可区分本机执行耗时与模型 / 连接通道等待时间。
- **中文界面优化**：任务中心、设置、错误提示、接入向导和管理页面进一步中文化与精简。

## 当前主要功能

- 网页版 ChatGPT 直接读取、搜索、新建和修改本地项目文件
- 执行本地命令并管理长时间运行的命令会话
- 自动读取项目类型、入口文件、Git 状态、测试 / 构建命令和项目指令
- `agent_workflow` 自动完成诊断、修改、测试、构建、重构和任务恢复
- Git 状态、Diff、日志、提交记录和 Worktree 安全隔离
- 任务中心：步骤、命令、测试结果、修改文件、构建结果、后台任务、Worktree、历史记录
- 自动测试 / 构建验证及产物 SHA-256 检查
- 系统诊断与可安全执行的一键修复
- 主工作区 + 额外授权目录的访问边界
- 便携 Python 3.12 + 内置 Coding Tools MCP，无需单独安装 Python 或 Docker
- OpenAI Tunnel 启停、健康检查、代理检测与自动重连
- Runtime API Key / MCP Token Windows 本地加密保存
- Windows 系统托盘、开机启动、后台运行
- Windows 桌面任务通知
- ChatGPT 登录数据清理
- 中文 ChatGPT MCP 接入向导
- Markdown、文本、PDF、DOCX 文档工作流
- 工作区图片查看能力

## 内置核心 MCP 工具

- `coding_tools_guide`
- `workspace_context`
- `agent_workflow`
- `task_control`
- `document_workflow`
- `exec_command`
- `command_control`
- `request_permissions`
- `view_image`

## 版本与验证

- 网页 MCP 助手：**0.2.4**
- Coding Tools MCP Runtime：**0.4.9**
- Electron：**43.2.0**
- MCP Schema：**v7 / 9 tools**
- Python 测试：**102 / 102 通过**
- Node 测试：**90 / 90 通过**
- Windows NSIS 安装包构建：**通过**

## 下载

Windows 用户直接下载：

`web-mcp-assistant-setup-0.2.4.exe`

SHA-256：

`4AE93086D24541DB6397D526DF97042225BE98DBC0356AEC08063B3355FCC0BC`

> 本项目目前未使用商业代码签名证书。Windows 可能显示安全提示，请确认安装包来自本仓库官方 Release。
