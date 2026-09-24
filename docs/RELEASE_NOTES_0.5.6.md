# 网页 MCP 助手 0.5.6 发布说明

## 定位

0.5.6 是 0.5.5 之后的工程基线与连续执行收口版本。重点不是增加花哨功能，而是让 Git、Worktree、Schema、任务终态、中文输出、长任务进度和 ChatGPT 网页断流恢复更可信。

## 核心修复

- 重建发布基线：清理历史缓存/生成物问题，修复 Worktree 快照会被已跟踪但后续忽略的 Python 缓存卡死的问题。
- agent_workflow 轻量隔离：只读 diagnose 与纯构建发布任务不再无条件创建 Worktree；真正修改源码时仍保持隔离。
- Worktree 可见性与回收：记录准备耗时；任务成功后仅在相对 snapshot 完全无差异时自动回收，有任何未应用修改都保留。
- 任务终态一致性：任务完成/失败/取消时同步 last_command.status、execution_lifecycle_state、execution_finished_at 和 exit_code。
- 恢复状态收口：失败后的修复命令一旦成功，清理 follow_up_command 连续恢复计数，不再长期累积成虚假的高 attempt。
- Schema v10：Runtime discovery、health 与本地 contract 继续强一致；Schema 代际变化后 24 小时提示旧聊天可能需要新建聊天刷新工具参数。
- Windows UTF-8：Runtime 与 Python 测试链统一 PYTHONIOENCODING=utf-8，并禁用 bytecode 缓存；保留 Windows 系统命令的本地代码页兼容，避免 tasklist 等命令被错误按 UTF-8 解码。
- ChatGPT 网页恢复超时：识别 ChatGPT stream recovery polling timed out，区分“网页回复恢复失败”和“本地 MCP 任务失败”；不自动点击重试、不自动重复工具调用。
- 长任务准备期反馈：显示隔离策略判断、Worktree 准备状态与耗时，减少长时间只有 Run complete agent workflow 的假卡顿感。
- 发布纪律：正式版本发布后必须同步 Git baseline、tag 与干净状态，避免源码与 Git 历史长期脱节。

## 安全原则

- 只读诊断不为隔离付出不必要成本。
- 源码写入仍优先 Worktree 隔离。
- Worktree 有任何未应用差异时禁止自动删除。
- 网页断流恢复不自动重发用户消息、不自动重复有副作用的 MCP 调用。
- Runtime 重启后对未知执行结果仍保持 unsafe_to_retry，不擅自重放。

## 验收重点

- 同一会话连续 MCP 调用。
- agent_workflow diagnose 不创建 Worktree。
- 写操作保持安全隔离。
- Worktree 无差异自动回收、有差异保留。
- Schema v10 contract 与实际 Runtime discovery 一致。
- last_command 与 task 终态一致。
- Windows 中文输出使用 UTF-8 主路径。
- ChatGPT stream recovery timeout 可识别且不误判为本地任务丢失。
- npm test 全绿。
- npm run dist 成功并输出 0.5.6 安装包。
