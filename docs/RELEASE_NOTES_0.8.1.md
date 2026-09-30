# v0.8.1 · 运行状态卡片与连续执行修复

0.8.1 聚焦 0.8.0 安装版真实使用中暴露的四个体验问题：运行状态过于狭窄、直接命令可能被误显示为空闲、短工作流失败可能冒出通用 JSON-RPC 错误，以及简单工作流首次启动准备过慢。

## 主要变化

- 将聊天页顶部的本地任务状态改为悬停/点击可展开的详细运行状态卡片。紧凑状态条仍保留，悬停约 150ms 即可查看当前阶段、已运行时间、最近活动、后台心跳、本地进程、等待原因、下一步、状态判断、命令输出和最近事件；点击可固定，Esc、外部点击或再次点击可收起。
- 直接 `exec_command` 在前一个任务已经完成、失败或停止后启动时，会自动归档旧终态并创建新的隐式命令任务。统一 Runtime / Process / heartbeat 状态因此能正确显示 `local_running`，不再出现“命令实际上在运行但界面显示空闲”。内部 workflow / verification 命令仍保持原 run 的终态不可变语义，不会偷偷复活失败任务。
- `agent_workflow` 在交接等待时间内快速失败时，不再向 ChatGPT 冒出通用 JSON-RPC `-32603`。失败现在通过标准工具结果返回结构化 `code / message / category / retryable`，并保留 `operation_id / execution_id / side_effect_possible / retry_safe`，方便判断是否适合重试。
- 对仅包含命令、`verification=none`、没有文件/搜索/补丁的 `diagnose` / `custom` 工作流增加 commands-only fast path。此类任务不再执行完整项目上下文准备，减少首次简单任务的无意义冷启动开销。
- 保持 0.8.0 的旧聊天 Schema fallback：升级前已打开的聊天仍可用 `task_control operation` 跟踪后台任务；新聊天继续使用 Runtime 中已存在的 `events` 增量事件能力。

## 实测

- commands-only 工作流入口：本轮实测约 `0.190s`，此前安装版同类第一次执行曾出现约 35 秒准备延迟。
- 直接命令在旧终态之后启动：实测统一状态为 `TASK_LIFECYCLE=running / USER_STATE=local_running / PROCESS_STATE=running`。
- 0.8.1 新增 Node/Electron 专项与相关状态回归：39/39 通过。
- 0.8.1 Python 可观测性专项：5/5 通过。
- Node/Electron 全量回归：228/228 通过。
- Python Runtime 全量测试：通过。

## 版本

- Desktop：`0.8.1`
- Coding Tools MCP Runtime：`0.8.1`
- MCP Tool Schema：`v12 / 9 tools`
- Schema Hash：`d9446f007bb783df0ffebbb24f3d19435c6978097c9a265d69323b42412f0a76`
- 本次没有修改公开 MCP 参数结构，因此 Schema generation 保持 v12。

## 发行验证

- `npm run test`：exit 0；Python Runtime、Schema contract、Node/Electron 与 source-root-clean 全部通过。
- `npm run dist`：exit 0；发行脚本内置的完整测试门槛再次通过，随后 Electron / NSIS 构建成功。
- 安装包：`dist/web-mcp-assistant-setup-0.8.1.exe`
- 文件大小：`126,311,291 bytes`（约 `120.46 MiB`）
- FileVersion：`0.8.1`
- ProductVersion：`0.8.1`
- SHA-256：`942AF278CCA5BCCA505EA49F099484F013928288568060847623E9D605AE3694`
