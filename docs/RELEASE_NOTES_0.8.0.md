# v0.8.0 · 任务可观测性与长任务可靠性

0.8.0 是一次针对真实 Agent 使用体验的专项升级。核心目标不是增加更多控制台，而是让用户始终知道：当前是在分析、执行本地命令、跑测试、构建、等待 ChatGPT、恢复连接，还是已经真正停滞。

## 主要变化

- 建立统一用户状态：`planning / local_running / testing / building / waiting_model / generating / waiting_user / recovering / quiet / suspected_stall / stalled / failed / completed`。
- 聊天页进度条显示阶段、耗时、最近输出、心跳和进程状态；活动详情增加状态判断与最近持久化事件。
- 20 秒无 stdout 但心跳健康时显示“仍在运行”；45 秒无心跳进入疑似停滞；90 秒进入疑似卡住。
- `waiting_model` 优先于仍存活的 wrapper operation，本地命令结束后不再伪装成“还在跑代码”。
- completion receipt 增加本地命令、验证、workflow 是否收口的完成屏障字段。
- Tool Schema generation 升至 v12。长任务 continuation 优先 `task_control events`，旧聊天 Schema 自动回退 `task_control operation`。
- 长任务返回 `progress_due` 与 continuation 元数据，模型能在长任务期间更可靠地给出阶段反馈。
- 参数校验进入统一结构化错误链路；错误时间线带 category / code / message / retryable，降低“失败但界面仍像在运行”的概率。
- 保持 Page / Tunnel / Runtime / Process 分层恢复；普通 `waiting_model` 不再触发 Runtime outage 误报。
- Windows 通知增加真实任务停滞与 recovery failure 语义，继续对普通 heartbeat/等待模型保持安静。
- Manager 继续维持紧凑结构，只显示必要状态，内部 correlation IDs 默认不进入主界面。

## 回归重点

新增/更新测试覆盖：健康静默长任务、45/90 秒停滞阈值、wrapper operation + waiting_model、旧 Schema fallback、completion barrier、诊断面板、任务停滞通知、参数校验结构化错误，以及既有 stream recovery / Tunnel-Runtime 分层 / 连续任务事件恢复场景。

## 版本

- Desktop：`0.8.0`
- Coding Tools MCP Runtime：`0.8.0`
- MCP Tool Schema：`v12 / 9 tools`
- Schema Hash：`d9446f007bb783df0ffebbb24f3d19435c6978097c9a265d69323b42412f0a76`

## 发行验证

- 完整 `npm run test`：通过；Node/Electron `226/226`。
- 长任务专项场景：`28/28` 通过，包括 100 个连续终态事件、SSE 重连去重、Tunnel/Runtime 分层恢复与通知去重。
- `npm run dist`：通过；构建过程中再次完整执行测试后由 electron-builder 生成 NSIS 安装包。
- 安装包：`dist/web-mcp-assistant-setup-0.8.0.exe`
- 文件大小：`126,308,483 bytes`（约 120.46 MiB）
- FileVersion / ProductVersion：`0.8.0`
- SHA-256：`DF450652B155A6B7982B95BC2FB4E4FF029F3D1E6B951DDA3C488FE7C1968DA3`
