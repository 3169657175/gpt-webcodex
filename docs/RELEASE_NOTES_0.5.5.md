# 网页 MCP 助手 0.5.5 发布说明

发布日期：2026-09-24

## 本版定位

0.5.5 是 0.5.4 之后的稳定性收口版本，重点修复长任务、agent_workflow、Windows Worktree 命令执行、后台任务状态与进度反馈中实际测试暴露的问题。

## 主要修复

- 修复 Windows Worktree 中 npm.CMD / .cmd / .bat 路径带空格时的命令包装问题，避免项目测试本身正常却被误报为 Worktree 验证失败。
- 测试/构建结果新增环境启动失败分类，不再把“命令根本没有启动”错误归类成“测试失败”。
- 修复后台 agent_workflow heartbeat 与任务 heartbeat 脱节，长任务能持续刷新真实活动时间。
- 修复后台 operation 的失败原因传播，保留真实错误码、类别和 operation/execution 关联信息。
- 修复失败任务执行后续命令时无法自然恢复的问题，支持 failed -> recovering -> running/waiting_model。
- 修复成功的普通工具调用可能错误清空真实 command failure 的问题。
- 修复 command_control poll/read 查询旧 Session 失败会污染当前任务 failure 的问题。
- 修复 command_control poll 完成真实命令后 current_command 仍可能保持 running 的问题；poll/write/kill 现在会同步真实命令生命周期。
- 只读 task_control 查询不再改变任务成败状态。
- Manager 状态中心区分排队、执行、恢复、等待模型等状态。
- 后台心跳长时间没有更新时明确显示，而不是看起来像无反馈卡死。
- Manager 状态读取临时失败时保留最后一次有效任务进度，并显示“状态待确认”，不再直接把任务卡片清空。
- command_control poll/read 在权限分类中按只读观察处理，减少不必要的安全拦截。
- Schema 提升至 v9，Runtime 提升至 0.5.3，桌面端可识别旧 Runtime/旧 Schema 并要求重新部署，避免代码已升级但会话仍使用旧工具定义。
- 保持便携 Python Runtime 优先，系统只有 Python 3.13 时不再造成项目不可用。
- 发布资源继续排除 __pycache__ 与 .pyc。

## 新增回归测试

- Windows npm.CMD 嵌套引号。
- 环境启动失败与真实测试失败分类。
- failed 任务自动恢复。
- blocking command 真实失败原因保留。
- command_control stale session 不污染任务。
- command_control poll 正确收尾当前命令。
- 只读 task_control 查询不清空真实失败。
- 后台 heartbeat 正常/过期展示。
- 状态刷新失败保留最近有效进度。

## 发布身份

- Desktop: 0.5.5
- Coding Tools MCP Runtime: 0.5.3
- MCP Tool Schema: v9 / 9 tools
- Schema hash: cb44f23fd265c4a7d10c801ca9ef88ee0fa4228b7a73151b02ff693f23757949
