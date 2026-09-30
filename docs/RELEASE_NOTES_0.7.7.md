# v0.7.7 · 本地执行反馈与容错

0.7.7 重点解决网页端模型执行本地任务时“看不到是否正在运行、无法区分网络波动与命令执行、没有阶段和输出反馈”的问题。反馈链路由桌面 Runtime 状态、认证 SSE、活动快照和 ChatGPT 原生工具调用提示共同承担，不向聊天输入框注入消息，也不会打断模型当前回复。

## 执行反馈

- 主聊天窗口新增可展开的“活动详情”面板，展示当前阶段、命令、最近输出、最近活动、等待原因和事件时间线。
- Runtime 以有界、只读快照提供命令输出，桌面查看不会推进模型后续读取使用的输出游标。
- 独立 `exec_command` 即使没有预先创建任务，也会建立隐式任务记录；完成、失败或取消后仍按既有规则结算并清空当前命令。
- 命令会话记录最近输出时间，并通过 `task_id` / `run_id` 绑定保留输出，避免跨任务串台。

## 状态与容错

- 本地状态读取失败时保留最后一次可信结果并显示“状态待确认”，不再误报“空闲”。
- ChatGPT 页面连接或渲染中断时，仍在运行的本地任务保持执行中状态，并单独提示页面异常。
- 后台 queued 操作纳入执行状态，阶段、下一步、心跳、最近输出和等待原因使用统一优先级展示。
- `task_control events` 新增 `after_event_id` 与 `wait_ms`，支持基于持久化事件游标的增量等待，减少忙轮询和重复状态读取。

## ChatGPT / MCP 能力

- MCP 工具描述加入 `openai/toolInvocation/invoking` 与 `openai/toolInvocation/invoked`，让 ChatGPT 原生工具区域显示调用状态。
- Runtime discovery 与桌面状态返回显式反馈能力矩阵。
- 当前 Runtime 未注册 MCP Apps UI resource，因此不声明支持聊天内状态卡片。
- 当前协议不满足 ChatGPT MCP Events 2.0 webhook 要求，因此不把 MCP Events 误用为实时命令输出通道。

## 版本与验证

- Desktop：`0.7.7`
- Coding Tools MCP Runtime：`0.7.7`
- MCP Tool Schema：`v11`，9 tools
- Schema Hash：`d9446f007bb783df0ffebbb24f3d19435c6978097c9a265d69323b42412f0a76`
- Python：274 项通过
- Node / Electron：218 项通过
- Windows NSIS：`web-mcp-assistant-setup-0.7.7.exe`
- 安装包大小：126,306,813 bytes
- SHA-256：`62413981AF0507425A0DB36C06063DE5C043006DDBDE84A096ED62265BBFE53D`
