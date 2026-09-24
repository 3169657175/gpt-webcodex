# 网页 MCP 助手（GPT-WebCodex）

让网页版 ChatGPT 连接 Windows 本地开发环境，把网页聊天变成一个可以理解项目、修改代码、执行命令、跑测试、构建安装包，并在新对话或切换 ChatGPT 账号后继续同一开发工作的桌面开发助手。

当前版本：

- 网页 MCP 助手 Desktop：**v0.5.6**
- Coding Tools MCP Runtime：**v0.5.3**
- MCP Tool Schema：**v9 / 9 tools**
- Schema hash：`cb44f23fd265c4a7d10c801ca9ef88ee0fa4228b7a73151b02ff693f23757949`
- Electron：**43.2.0**
- 平台：**Windows**

> 核心路线：**ChatGPT Web 负责模型能力，本地 Electron + Coding Tools MCP 负责项目、工具、安全、任务、执行、索引、Checkpoint、Session、History、Rules、Recipes、Skills 和长期 Memory。** 项目不额外维护第二套 OpenAI 模型 API。

---

# 0.5.0：Workspace / Agent Runtime / Context / Permission V2

0.5.0 聚焦“更像 Codex 地持续工作”，不引入第二套 Codex 平台。主要升级：

- Workspace Manager V2：失效目录检测、单项移除、收藏、搜索、批量清理；工作区与额外授权目录继续分离。
- 磁盘治理：Worktree 安全 GC、dist/build 与 Python 缓存清理；不会清理存在未应用修改或提交差异的隔离 Worktree。
- Agent Runtime V2：execution / model / process / connection / recovery / workspace 分层状态。
- Event Log + Trace：任务、run、operation、execution、process、local session 关联信息进入紧凑持久事件。
- 长任务与 Checkpoint V2：后台 operation 可查询/恢复，checkpoint 自动裁剪旧实体文件。
- Context Engine / Compaction：继续复用 Repo Map、符号/依赖图与上下文压力预算，并在高压力时推荐 continuation checkpoint / output refs。
- Tool Registry V2：核心工具稳定暴露，提供 workspace-scoped registry generation、工具组、side-effect 与 retry-safe 元数据。
- Permission V2：增加路径/命令 pattern allow/ask/deny 规则，并纳入 Runtime fingerprint；设置页可直接配置。
- MCP Schema 升级到 v8。

# 0.4.3：ChatGPT 浏览器壳与连接稳定化

0.4.3 继续针对真实 dogfooding 中最头疼的现象：长回复或多次 MCP 调用期间，ChatGPT 页面偶尔显示“连接已中断。正在等待完整回复”，或者某一条已经生成的回复显示“出错了，无法显示此消息”，切换到其它 conversation 再回来后消息又立即正常出现。

这类问题不能简单等同于“本地 MCP 挂了”。0.4.3 将 ChatGPT 页面、浏览器网络、OpenAI Tunnel、本地 Runtime 继续拆成独立故障层，并优先修正 Electron 内嵌网页本身的浏览器行为与局部渲染失步。

## 标准浏览器身份

项目继续使用 Electron 官方现代嵌入方式 `WebContentsView`，并继续使用：

`persist:chatgpt-session`

保存 ChatGPT 登录态。

实际探针曾显示原始 User-Agent 为：

`Chrome/150.0.7871.129 Electron/43.2.0`

0.4.3 不引入随机浏览器指纹，也不伪造另一套 Chrome 版本，而是保留当前 Electron 内置 Chromium 的真实版本，只移除 `Electron/<version>` / 应用标记，使网站看到内部一致的普通 Chrome UA。

同时对 ChatGPT 主页面和登录弹窗设置：

- `backgroundThrottling: false`
- `webContents.setBackgroundThrottling(false)`

避免窗口隐藏、切后台或长时间工具任务期间 Chromium 对 ChatGPT 页面定时器和流式状态进行后台节流。

实机 Electron 探针验证：

- persistent session：通过
- normalized UA：保留真实 Chrome 150，移除 Electron 标记
- background throttling：`false`

## 浏览器与 Tunnel 代理路径

0.4.3 使用 Electron `Session.setProxy()` / `resolveProxy()` 管理 ChatGPT persistent session 的网络策略，并与 Tunnel 使用的软件代理配置进行对照。

代理语义：

- `direct`：ChatGPT 浏览器明确直连。
- `manual`：ChatGPT 浏览器明确使用用户填写的 HTTP/HTTPS 代理。
- `system`：继续使用 Chromium/Electron 系统代理模式。
- `auto`：浏览器保留系统代理语义，同时记录浏览器实际 route 与 Tunnel route 是否一致，不在正在生成回复时突然切换出口。

`chat:status` 现在包含 `browserNetwork`：

- `mode`
- `browserRoute`
- `tunnelRoute`
- `aligned`
- `source`
- `updatedAt`

用户主动修改代理设置时才刷新 ChatGPT Session 的 proxy policy，并关闭旧连接池；不会清 Cookie、LocalStorage 或 ChatGPT 登录态。

## ChatGPT Stream Observer

0.4.3 新增只读 Stream Observer，识别页面已经显示的：

- `连接已中断`
- `正在等待完整回复`
- `出错了，无法显示此消息`
- 对应英文 interruption / waiting / message display error 状态

普通 Stream 状态会上报：

- `page-stream-interrupted`
- `page-stream-recovered`

消息渲染失步会上报：

- `page-message-render-error`
- `page-message-render-recovered`

并把状态放入 `chat:status.streamState`。

### 严重热修：撤回自动 message render reload

0.4.3 曾尝试在检测到“消息已生成但无法显示”后自动执行受保护的 `webContents.reload()`。真实使用发现这一策略仍可能被隐藏 DOM、历史节点或页面内部瞬时状态误触发，表现为**没有明显错误提示时界面也会莫名刷新**。

最新 0.4.3 已彻底撤回这条自动 reload 路径：

- Stream Observer **只能观测和上报状态，不能刷新页面**。
- `message render error` 不再携带 `safeToReload`，不存在 1.8 秒自动恢复计时器，也不存在 45 秒自动 reload 冷却逻辑。
- 错误识别不再扫描整个 `main.innerText`，只检查当前页面中**可见、结构化的错误候选节点**，例如 `role="alert"`、`aria-live="assertive"` 或明确的 error 容器。
- 主动 `reload()` 仅保留在用户手动点击刷新按钮的导航动作中。
- 用户手动刷新会记录 `user-navigation-reload`；其它页面开始加载会记录不包含 conversation URL 或聊天正文的 reason，便于继续追踪异常刷新来源。

明确不会：

- 因 Stream Observer 自动 reload conversation。
- 因 message render error 自动 reload conversation。
- 自动重发消息。
- 重启健康的 Runtime。
- 重启健康的 Tunnel。
- 把聊天正文写进 stream/reload 诊断日志。

这样可以区分：

`ChatGPT response stream 中断 ≠ 单条消息渲染失步 ≠ Renderer 崩溃 ≠ Tunnel 中断 ≠ Runtime 中断`

## 网络与 Renderer 诊断

新增 ChatGPT 网络错误观测和 renderer `unresponsive/responsive` 事件。

日志只记录 host、resource type、网络错误类型、路由状态和页面加载 reason 等元数据，不记录 ChatGPT conversation URL 或聊天正文。

---

# 0.4.3：本地记忆页 UI 微调

根据真实界面截图继续调整 Manager V2：

- 新增候选表单字段间距收紧。
- 正文区默认高度降低，仍支持手动纵向拉伸。
- “置顶”和“加入候选”进入统一底部 action row。
- 底部使用轻量分隔线建立动作层级。
- 小屏自动纵向堆叠，提交按钮全宽。
- 右侧无候选时继续保持内容自适应，不强制与左栏等高。
- 记忆库容器、卡片和标题区域统一增加 `min-width: 0` / `max-width: 100%` 约束。
- 长中文、长英文、路径和无空格长 token 使用 `overflow-wrap:anywhere` / `word-break:break-word` 在卡片内部断行。
- 记忆正文保留 `pre-wrap`，只允许纵向滚动，禁止长文本把整个页面横向撑出边界。

本次针对用户真实的超长记忆内容增加专项回归测试，确认标题、元信息和正文都不会再撑破卡片。

---

# 0.4.2：自动本地记忆

0.4.2 将之前只有配置开关的 Memory 自动模式补成完整执行链。

普通 ChatGPT 对话即使没有主动调用 MCP，Electron 也可以只读观察已经显示完成的 user / assistant turn，并通过本机私有 Memory ingest 路径提取短记忆。

原则：

- 除明显闲聊/寒暄外，默认视为可能有长期价值。
- 可保存个人偏好、工作习惯、长期目标、计划、项目背景、项目决策、任务结论、反复问题等，不局限于技术规范。
- 不保存整段聊天原文。
- 页面 console 只发送 ready 信号，正文通过瞬时内存队列读取后清空。
- 密码、API Key、Token、Cookie、验证码、私钥、支付凭证永久拒绝。
- 敏感个人信息不静默自动写入。
- 重复内容不重复写。
- 冲突内容不会偷偷覆盖旧记忆。

自动模式：非闲聊、非敏感、非秘密内容可直接写入长期 Memory。

建议模式：自动提取后进入候选区等待确认。

默认目录：

`%LOCALAPPDATA%\GPT-WebCodex\memory-v1\`

---

# 0.4.1：Manager V2

0.4.1 重做桌面管理/设置中心的视觉系统：

- 208px 稳定窄侧栏，导航拆分“工作台 / 系统”。
- Runtime 状态降级为侧栏底部轻量状态区。
- 统一按钮、输入框、Select、Toggle、Checkbox、间距和页面宽度。
- 减少渐变、厚阴影和卡片套卡片。
- 设置页改成单列设置清单 + 右侧控件。
- 工作区、任务、记忆、诊断统一 Design Tokens。
- 提供浅色/深色和小屏响应式布局。

---

# 0.4.0：Stable Execution Kernel

0.4.0 把长期任务围绕本地持久状态组织：

```text
ChatGPT / agent_workflow
        ↓
Run Supervisor
        ↓
Step Scheduler
        ↓
Execution Ledger
        ↓
Command / Patch / Build / Test / Git Executors
        ↓
Recovery Policy
        ↓
Checkpoint + Local Session + History
```

核心包括：

- Run / Step / Execution identity。
- exactly-once / duplicate reuse。
- `unknown_outcome + side_effect_possible` 禁止盲目自动重跑。
- Heartbeat / Lease / Stuck Detector。
- bounded Recovery Policy / backoff / circuit breaker。
- ChatGPT / Tunnel / Runtime 三层解耦。
- Model Handoff Gate。
- Worktree 安全应用。
- Crash / Restart Recovery。
- 发布级 bounded electron-builder retry。

0.4.0 正式 Soak：**150 cycles / 约 30 分 43 秒**，Git index 全程保持不变。

---

# 当前公开 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `coding_tools_guide` | Coding Tools MCP 使用建议 |
| `workspace_context` | 项目、Repo Map、Git、任务、Memory 与上下文概况 |
| `agent_workflow` | 完整诊断、修改、测试、构建与 Resume 工作流 |
| `task_control` | 任务、后台 operation、Worktree 管理 |
| `document_workflow` | PDF / DOCX / Markdown / 文本工作流 |
| `exec_command` | 聚焦的本地命令执行 |
| `command_control` | 管理运行中的命令会话 |
| `request_permissions` | 请求本地额外权限 |
| `view_image` | 查看工作区图片 |

公共 Schema 继续保持 **v7 / 9 tools**。

---

# 项目结构

```text
electron/                    Electron 主进程、ChatGPT WebContents、Runtime/Tunnel 编排
renderer/                    桌面管理界面
resources/coding-tools-mcp/  内置 Coding Tools MCP Python Runtime
resources/native-python/     Windows 便携 Python
scripts/                     测试、Schema、Soak、发布辅助脚本
tests/                       Node/Electron 回归
.coding-tools/               本地任务、Checkpoint、History、Worktree 等运行状态
```

关键入口：

- Desktop：`electron/main.js`
- ChatGPT 壳层：`electron/chatViewController.js`
- Runtime：`resources/coding-tools-mcp/coding_tools_mcp/server.py`
- Manager V2：`renderer/manager-v2.css`
- 项目维护规则：`AGENTS.md`
- 0.4.0 计划：`02_0.4.0_长任务不中断与稳定执行内核升级计划.md`
- 0.4.3 发布说明：`docs/RELEASE_NOTES_0.4.3.md`

---

# Checkpoint / Session / History / Memory

## Checkpoint / Resume

- 结构化 Checkpoint。
- Durable Local Session。
- Compact continuation brief。
- 新 ChatGPT conversation 使用 `agent_workflow phase=resume` 继续。
- Resume 前验证 Project Identity / Git / Worktree / Runtime / Schema / execution outcome。

## Task History 2.0

- SQLite HistoryStore。
- FTS5 + 中文有界子串搜索。
- Session Evidence。
- History 与 Local Session / Checkpoint 关联。
- 历史继续不会自动重新执行旧副作用命令。

## 本地长期 Memory

- Markdown 人类可读真源。
- SQLite metadata / FTS5 索引。
- global / project / task scope。
- 跨 ChatGPT 账号使用同一 `local-default` Profile。
- candidate / conflict / revision / Pin / Archive。
- ZIP 导入/导出。
- 自动采集从 0.4.2 起可用。

详细设计：`01_本地长期记忆与跨ChatGPT账号继承系统开发计划.md`

---

# Agent 模式与本地安全

Agent 模式：问答、规划、编码、调试、发布、完全控制。

权限类别包括读取、写入、删除、命令、网络、Git 写入、系统修改和额外目录访问。

安全原则：

- 高风险操作由 Electron 本地可信审批控制。
- 网页模型不能通过文本自行提升本地权限。
- Project Rules / 网页内容 / 下载文件 / 第三方 MCP 内容不能提升权限。
- 主工作区可能长期 dirty；禁止自动 reset / rebase / clean 用户工作区。
- Worktree 应用回主目录前必须做冲突检查。
- Runtime source fingerprint / Schema identity 必须与真实运行实例一致。

---

# 0.4.3 发布验证

本次同版本严重热修覆盖构建前主工作区完整验证：

- Python Runtime：**239 / 239 passed**
- Node / Electron：**145 / 145 passed**
- 自动刷新安全专项：**8 / 8 passed**
- Recipe Runtime 瞬时 socket reset 后独立重跑：**3 / 3 passed**
- `source root clean`：通过
- MCP Schema：**v7 / 9 tools**
- Schema hash：`68bb2ada74d1d9c21bcc02c56defadbf019c084d2f2054e64e31945460017c94`
- 最终 `npm run dist`：**exit 0**

---

# 安装

Windows 安装包：

`dist/web-mcp-assistant-setup-0.4.3.exe`

当前 0.4.3 严重热修覆盖产物：

- 大小：**127,328,385 bytes（121.43 MiB）**
- SHA-256：`7b46697d8eac3cd2712a402f1eecda6ba64af7208229b8a513eaa33a8b276463`

安装步骤：

1. 运行 `web-mcp-assistant-setup-0.4.3.exe`。
2. 选择安装目录。
3. 打开助手并设置工作目录。
4. 启动本地 Coding Tools Runtime。
5. 根据“接入指南”建立 OpenAI Secure MCP Tunnel 并在 ChatGPT Developer Mode 配置 MCP。

Windows 可能对未商业代码签名的个人项目显示安全提示，请确认安装包来源后再运行。

---

# 开发者运行

```powershell
npm install
npm start

npm run test
npm run soak:quick
npm run soak
npm run dist
```

构建产物位于 `dist/`。

---

# 已知上游边界

## ChatGPT Developer MCP 后续轮次 namespace / attachment 消失

仍可能遇到 ChatGPT 上游 Developer MCP attachment/namespace 在后续 turn 消失的问题。本项目不再使用强制自动 `@Coding Tools MCP` 或文本 Bridge 绕过，因为这会破坏普通聊天发送并制造新的不稳定性。

当前原则：上游 attachment 故障不连带重启健康 Runtime/Tunnel，等待 OpenAI 修复。

## ChatGPT 网页回答流/消息渲染异常

0.4.3 已增强浏览器层行为和诊断，但网页 response stream 最终仍由 ChatGPT/OpenAI 服务端与 Chromium 网络链路共同决定，因此不能保证完全消除上游或互联网瞬时中断。

本地原则：

- 普通页面 stream 异常不自动重启健康 Runtime/Tunnel。
- 后台 execution / Run 继续以本地持久状态为真源。
- “连接已中断/等待完整回复”只记录 interrupted/recovered，不在生成过程中强刷 conversation。
- “出错了，无法显示此消息”只作为独立 message render error 观测，不再自动 reload。
- 正常使用期间程序不得因 Stream/Message Observer 自行刷新 ChatGPT；主动 reload 仅允许用户手动导航刷新。
- 若再次出现页面自己重新加载，通过 `page-or-browser-navigation` / `user-navigation-reload` 等 reason 诊断继续区分是 ChatGPT/Chromium 自身导航还是本程序主动动作。

---

# 关于“指纹浏览器”

0.4.3 没有引入独立指纹浏览器内核。

当前 Electron 已使用现代 `WebContentsView` 和持久 Session。连接稳定性问题首先通过真实 Chromium 版本一致的 Chrome-like UA、关闭后台节流、标准 Session 代理、网络路径对齐诊断、Stream Observer 和 message render 只读观测处理。

完整指纹浏览器更偏向多账号隔离、反自动化检测和身份伪装，会额外引入浏览器内核、指纹一致性、Cookie/登录迁移、升级与安全维护成本。只有在 0.4.3 实机长期测试仍证明普通 Chromium 嵌入本身是主要故障来源时，才值得进入独立 Browser Profile / Browser Companion 的实验阶段。

---

# 版本简史

## v0.4.3

ChatGPT 浏览器壳标准化、Chrome-like UA、关闭后台节流、浏览器/Tunnel 代理路径诊断、Stream interruption observer、message render 只读观测且禁止自动 reload、本地记忆 UI 与长文本溢出修复。

## v0.4.2

普通 ChatGPT 对话自动 Memory ingest；除闲聊/敏感/秘密内容外可自动记住长期有用信息。

## v0.4.1

Manager V2 设置中心视觉系统重构。

## v0.4.0

Stable Execution Kernel：Run Supervisor、Execution Ledger 2.0、heartbeat/lease/stuck detector、Recovery Policy、Model Handoff Gate、Chaos/Soak 和发布级 bounded retry。

## v0.3.1

取消强制自动 `@Coding Tools MCP` / send interception。

## v0.3.0

本地长期 Memory、Rules、Recipes、Skills。

---

# 后续优先方向

继续按真实 dogfooding 排优先级，而不是扩张 Tool Surface：

- 收集 0.4.3 的 `streamState + browserNetwork + Tunnel/Runtime health + page load reason` 真实中断样本。
- 将“ChatGPT 回答流中断，但本地任务仍健康”更直观地展示在管理界面。
- 如果仍出现非用户触发的页面重新加载，优先根据 `page-or-browser-navigation` 诊断来源，不再新增自动 reload 绕过。
- deterministic change set 偶发错误进入 `waiting_model` 的状态机问题。
- Worktree 对未纳入 Git 的便携工具路径解析。
- Runtime/Schema 暴露与已连接客户端之间的漂移检测。
- Manager V2 长期使用中的密度和小屏微调。

---

# 开源协议

- 本项目：MIT License。
- 内置 Coding Tools MCP 来源于 `xyTom/coding-tools-mcp`，第三方许可见 `THIRD_PARTY_NOTICES.md`。
