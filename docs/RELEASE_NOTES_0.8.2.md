# 网页 MCP 助手 v0.8.2

## 本次重点

v0.8.2 是 0.8.1 的可观测性收尾版本，重点解决详细状态卡位置错误、信息不足、运行耗时不准，以及任务结束后的状态残留。

### 详细状态卡回到主进度区域

- 详情卡只由“本地步骤已完成，正在等待 ChatGPT 继续 / Waiting for model”所在的主进度带触发。
- 顶部工作区任务条只保留紧凑摘要，不再弹出原生单行 title 提示。
- 主进度带支持悬停展开、点击固定和键盘 Enter/Space 固定。
- 详情卡加宽，并显示当前状态、阶段、真实耗时、最近活动、心跳、进程、等待原因、下一步、反馈通道、Task / Run / Operation ID、最近结果、命令、最新输出、诊断和事件时间线。

### 终态和耗时收口

- ExecSession 快照直接返回实时 `elapsed_ms`，修复运行数分钟仍显示 `0.0s`。
- `last_command.elapsed_ms` 缺失时根据开始和结束时间补算。
- completed / failed / cancelled 终态清空 `current_step/current_command`。
- 成功完成时未收口的 finalize 步骤统一标记 completed，不再出现 `cancelled + pending`。
- 测试/构建结束后立即进入真实的 `Finalizing result` 阶段，避免最后整理结果时仍显示 `Testing and building`。
- 桌面任务状态轮询从 3 秒缩短到 1 秒，同时继续保留任务事件推送。

## 发布验证

正式发布需通过完整测试、Schema 契约一致性检查、Windows NSIS 构建、安装包版本与 SHA-256 校验，以及 Git commit / tag / clean 检查。
