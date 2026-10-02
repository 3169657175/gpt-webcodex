# 网页 MCP 助手 v0.9.0

这是一次架构收口版本，不以增加功能数量为目标，而是统一长期上下文、运行状态、管理界面和发布验证链路。

## 主要变化

### 长期上下文 V3
- ChatGPT 模型通过 `remember_context` 主动总结并写入真正稳定、长期、可复用的非敏感信息。
- ChatGPT 页面 DOM / 正则观察降级为“候选发现”，不再直接持久化。
- 候选池增加内部去重；模型写入相同主题后自动清理对应候选。
- 管理中心显示模型写入数量、候选数量、扫描次数、发现/跳过/错误统计。
- 凭据、Token、支付信息和敏感个人信息的自动写入保护保持不变。

### 统一运行状态与事件驱动
- 新增共享 `AssistantState` 层，统一管理中心、ChatGPT 顶部状态与桌面通知的状态语义。
- Runtime/Task 事件优先驱动刷新；高频轮询改为 30～60 秒 watchdog。
- 保留 UI 的秒级耗时刷新，不再因此每秒请求任务状态。

### React + TypeScript + Vite 管理中心
- 新增 `renderer-ui/`，使用 React、TypeScript、Vite。
- 首页、工作区、长期上下文和设置页增加 React 状态摘要组件，通过事件桥接现有 Electron/Renderer 状态。
- 采用渐进迁移，不重写 ChatGPT WebContents，不移除已经稳定的管理操作链路。

### Runtime 模块化
- 将 ToolSpec、Tool Registry 和图像内容构造从 `server.py` 拆到 `tool_registry.py`。
- MCP Tool Schema 升级到 v14，公开工具数量保持 10 个。

### 测试与发布
- `npm run test:quick`：类型检查、Schema 契约和核心架构专项测试。
- `npm test`：完整 Python + Node 回归。
- `npm run release:verify`：React 构建、完整测试、quick soak 与版本一致性检查。
- `npm run release:git-ready`：正式提交后检查工作区、版本 Tag 与上游同步状态。
- `npm run dist`：正式安装包构建前自动执行 release verify。

## 版本
- Desktop：`0.9.0`
- Coding Tools MCP Runtime：`0.9.0`
- MCP Tool Schema：`v14 / 10 tools`

## 兼容性
- Windows Electron 桌面架构保持不变。
- ChatGPT WebContents、OpenAI Tunnel、MCP Runtime 继续按独立故障层恢复。
- 工作区权限模型与完全权限单用户模式保持不变。
- 未进行安装包瘦身，内置 Python、Tunnel、rg/fd 等资源全部保留。
