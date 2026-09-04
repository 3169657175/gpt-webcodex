# 网页 MCP 助手（GPT-WebCodex）

让网页版 ChatGPT 直接连接 Windows 本地开发环境，把网页聊天变成一个可以读取项目、修改代码、执行命令、跑测试和构建安装包的桌面开发助手。

当前桌面版本：**v0.4.5**  
内置 Coding Tools MCP Runtime：**v0.4.9**  
平台：**Windows**

> 适合在 Codex / Cursor 额度不足时继续使用网页版 ChatGPT 操作本地工程，也可以作为独立的轻量桌面 Coding Agent 使用。普通用户无需安装 Docker 或单独配置 Python。

---

## ✨ v0.2.4 主要更新

v0.2.4 的重点不是单纯增加按钮，而是把底层任务执行、Git 隔离和 Runtime 生命周期做得更稳定、更适合长时间开发。

- **新增 Git / Worktree 安全隔离**：代码任务可以先在独立 Git Worktree 中修改和验证，再查看 Diff、应用或丢弃，尽量避免直接污染主工作区。
- **主 Git 暂存区保护**：应用 Worktree 结果时不主动改动主工作区暂存区；如果主工作区同一文件在任务快照后又发生变化，会拒绝直接覆盖。
- **长任务后台执行**：测试、构建和复杂 Agent 工作流可以转入后台运行，不再因为一次调用时间较长就表现成“卡死”。
- **真实心跳与进度状态**：后台任务保存 operation、heartbeat、当前步骤、下一步、正在执行的命令、测试结果和构建结果。
- **任务恢复能力增强**：刷新页面、切换聊天或本地 Runtime 重启后，任务状态仍可读取；支持暂停、继续、停止和历史记录。
- **Runtime 生命周期更稳定**：ChatGPT 页面、OpenAI Tunnel、本地 MCP Runtime 分层处理，页面或 Tunnel 异常不会无条件重启健康的 MCP Runtime。
- **Runtime / Schema 一致性校验**：重启时核对进程 ID、launch ID、runtime instance、源码指纹、Schema version/hash 和工作区，减少“旧进程 / 旧 Schema”问题。
- **MCP 调用恢复更稳**：只读状态类调用支持重新 discovery 后安全重试，降低 Runtime 重启后工具失效的概率。
- **Windows 桌面任务通知**：任务完成、失败、中断或等待用户处理时可弹出系统通知，并支持点击回到 ChatGPT。
- **性能与状态可观测性增强**：可以区分本机执行时间与模型 / 连接等待时间，查看后台任务、运行心跳和性能时间线。
- **中文界面进一步整理**：管理中心、任务状态、错误信息、设置项和接入说明尽量使用中文展示。

---

## 🧩 目前已经支持的功能

### 1. 网页 ChatGPT 直接操作本地项目

连接完成后，ChatGPT 可以通过 Coding Tools MCP：

- 读取文件、目录和项目结构
- 搜索代码、定位函数、错误或关键字
- 新建文件、修改文件、应用补丁
- 执行命令和管理长时间运行的命令会话
- 查看 Git 状态、Diff、日志、提交记录和文件历史
- 查看项目内图片
- 处理 Markdown、文本、PDF、DOCX 等文档工作流
- 自动运行测试、构建并检查产物

### 2. 项目上下文自动识别

`workspace_context` 会一次返回当前工作区的核心信息，包括：

- 项目类型、名称、版本和入口文件
- 根目录主要文件
- Git 分支和修改状态
- 可用测试 / 构建命令
- 当前任务状态
- `AGENTS.md` / `CLAUDE.md` 等项目指令
- 当前模型上下文压力

这样 ChatGPT 不需要每次都从头大量扫描项目。

### 3. Agent 自动工作流

内置 `agent_workflow`，适合一次完成完整开发任务：

- Bug 诊断与修复
- 新功能开发
- 重构
- 测试失败修复
- 构建 / 发布验证
- 项目创建
- 文档工作流
- 中断任务恢复

工作流会尽量把“读取上下文 → 修改 → 测试 → 构建 → 汇总结果”合并完成，减少低级工具重复调用。

### 4. Git / Worktree 安全开发

复杂代码任务支持 run-scoped Git Worktree：

- 每个任务创建独立隔离工作区
- 记录任务开始时的主工作区快照
- 在隔离区修改和验证代码
- 查看 Worktree Diff
- 一键应用到主工作区
- 一键丢弃隔离任务
- 检测主工作区后续冲突，避免静默覆盖
- 尽量保持主 Git index / 暂存区不被任务流程改变

这套机制主要解决长任务修改到一半、多个任务并行或主工作区本身有未提交内容时的安全问题。

### 5. 可恢复的长任务系统

任务中心会记录：

- 当前目标
- Task ID / Run ID
- 当前步骤与下一步
- 任务步骤完成情况
- 正在运行的命令
- 最近测试结果
- 修改过的文件
- 最近构建报告
- 后台 operation 与真实 heartbeat
- Worktree 隔离状态
- 历史任务

并支持：

- 暂停
- 继续
- 停止
- 清除状态
- Runtime 重启后重新读取状态
- 长任务定时主动汇报进度

### 6. Windows 桌面任务通知

支持系统级任务提醒：

- 任务完成提醒
- 任务失败提醒
- 任务中断提醒
- 等待用户确认 / 输入提醒
- 通知声音开关
- 点击通知回到 ChatGPT
- 设置页可直接发送测试通知

### 7. 工作区与权限控制

本地文件访问以用户明确授权的目录为边界：

- 一个主工作区
- 可添加额外授权目录
- 未授权路径会被权限策略拒绝
- 切换工作区后自动更新 MCP 访问范围
- 支持不同命令权限模式
- 高风险系统修改仍可以要求额外确认

### 8. 本地 Runtime 与连接管理

安装包内已经集成运行环境：

- 内置便携 Python 3.12
- 内置 Coding Tools MCP Runtime
- 不依赖系统 Python
- 不需要 Docker
- 本地 MCP 默认绑定 `127.0.0.1`
- 自动管理 OpenAI Tunnel
- 支持启动、停止、重启和健康检查
- Runtime 状态通过心跳持续同步到桌面界面

### 9. 更稳的 Runtime / Schema 生命周期

v0.2.4 对旧进程、旧工具定义和异常重启做了额外处理：

- Runtime 重启前确认旧 PID 退出
- 检查端口释放
- 生成并校验新的 process / launch / runtime instance 身份
- 运行时代码变化会反映到 source fingerprint
- `server/discover` 与健康端点校验相同 Runtime / Schema 身份
- 公共工具 Schema 使用 version / hash 契约校验
- 页面、Tunnel、Runtime 分成三个故障层，避免互相误伤

### 10. 自动测试、构建与产物验证

“构建验证”页面会先识别项目，再自动选择可用方案：

- 自动识别 Node.js / Electron / Python 等项目
- 自动识别测试命令
- 自动识别构建命令
- 测试失败时阻止后续构建
- 检查构建产物目录
- 输出版本和产物信息
- 生成 / 展示 SHA-256
- 也可以在高级设置中手动覆盖命令

### 11. 系统诊断与修复

“诊断与修复”可以检查：

- 当前工作区
- 便携运行环境
- 本地 MCP 服务
- 端口状态
- OpenAI Tunnel / 连接状态
- 部分常见配置问题

能够安全自动处理的问题可以执行一键修复。

### 12. 网络与代理

支持自动选择：

- 直连
- Windows 系统代理
- 常见本地代理

连接异常时会进行诊断和重连，不再固定依赖某个代理软件或固定端口。

### 13. 本地安全与密钥保护

- Runtime API Key 使用 Electron `safeStorage` / Windows DPAPI 在本机加密保存
- MCP Bearer Token 随机生成并加密保存
- 渲染进程不直接读取密钥明文
- 普通日志会隐藏 key / token / authorization / secret 等敏感字段
- 管理页面启用 `contextIsolation`，关闭 `nodeIntegration`
- 本地 MCP 和管理接口默认只监听本机地址
- 匿名遥测默认关闭，不上传聊天内容

### 14. 中文桌面管理中心

目前管理中心包括：

- 总览
- 运行与连接
- 工作区与权限
- 任务状态
- 构建验证
- 诊断与修复
- 接入指南
- 运行日志
- 偏好设置

同时支持：

- 浅色 / 深色主题
- Windows 开机启动
- 打开助手时自动启动服务
- 关闭窗口后继续后台运行
- 系统托盘
- 清除 ChatGPT 登录数据并重新登录
- 重新生成 MCP Token
- 清理运行日志

### 15. ChatGPT 接入向导

内置中文接入步骤，覆盖：

1. 创建 OpenAI Tunnel
2. 创建 Runtime API Key
3. 在助手中选择工作目录并部署
4. 在 ChatGPT 中创建自定义 MCP / 连接器
5. 完成第一次只读工具测试

同时提供可复制的 Coding Tools MCP 自定义指令。

---

## 🛠 当前公开 MCP 工具

v0.2.4 内置 Runtime 对 ChatGPT 暴露的核心工具包括：

| 工具 | 用途 |
| --- | --- |
| `coding_tools_guide` | 返回 Coding Tools MCP 使用建议 |
| `workspace_context` | 快速读取项目、Git 和任务概况 |
| `agent_workflow` | 一次完成诊断、修改、测试、构建等完整开发任务 |
| `task_control` | 查看、暂停、继续、停止任务及管理 Worktree |
| `document_workflow` | PDF / DOCX / Markdown / 文本处理 |
| `exec_command` | 执行聚焦的工作区命令 |
| `command_control` | 管理正在运行的命令会话 |
| `request_permissions` | 请求额外命令 / 文件操作权限 |
| `view_image` | 查看工作区图片 |

底层还包含 Git、文件读写、搜索、补丁、构建验证等能力，并由上述高层工具统一编排。

---

## 📦 下载和安装

普通使用不需要配置开发环境：

1. 打开 GitHub 页面右侧 **[Releases](../../releases)**。
2. 下载最新安装包：`web-mcp-assistant-setup-0.4.4.exe`。
3. 双击安装。
4. 打开助手，选择工作目录。
5. 按“接入指南”配置 OpenAI Tunnel 和 ChatGPT MCP。

> Windows 可能会对未进行商业代码签名的个人项目弹出安全提示，请确认文件来源是本仓库 Release 后再运行。

---

## 💻 开发者源码运行

```powershell
# 克隆项目
git clone https://github.com/3169657175/gpt-webcodex.git
cd gpt-webcodex

# 安装依赖
npm install

# 开发运行
npm start

# 全量测试
npm test

# 构建 Windows NSIS 安装包
npm run dist
```

构建产物默认位于 `dist/`。

---

## 🔐 安全边界说明

这个工具具备真实的本地文件写入和命令执行能力，因此它不是纯聊天插件。

建议：

- 只授权确实需要 AI 操作的项目目录
- 重要项目保留 Git 提交或其他备份
- 普通使用保持安全权限模式
- ChatGPT 请求执行高风险命令时先检查具体操作
- 不要把 Runtime Key、MCP Token 或其他密钥粘贴到聊天消息中

Git Worktree 隔离能降低复杂任务直接修改主工作区的风险，但不能替代 Git 提交和正常备份。

---

## 📜 开源协议

- 本项目使用 [MIT License](LICENSE)。
- 内置的 Coding Tools MCP 来源于 [xyTom/coding-tools-mcp](https://github.com/xyTom/coding-tools-mcp)，其许可与来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 📌 版本信息

- 网页 MCP 助手：**0.4.5**
- Coding Tools MCP Runtime：**0.4.9**
- Electron：**43.2.0**
- Windows 安装包：`web-mcp-assistant-setup-0.4.5.exe`
