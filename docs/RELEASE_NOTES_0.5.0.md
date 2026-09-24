# 网页 MCP 助手 0.5.0

## 目标

0.5.0 不做双平台或 Codex Bridge，集中把现有 ChatGPT + 本地 MCP 模式做得更稳定、更可恢复、更节省上下文。

## 九阶段升级

1. Workspace Manager V2：检测失效目录、单项移除、批量清理、收藏、搜索、最近使用元数据。
2. Agent Runtime V2：execution/model/process/connection/recovery/workspace 分层状态。
3. Event Log + Trace：durable events 增加 task/run/local-session/operation/execution/process correlation。
4. 长任务 Runtime：后台 operation 生命周期继续独立于单次 ChatGPT 响应，并可持久查询。
5. Checkpoint V2：自动裁剪旧 checkpoint 文件，保留 continuation/resume 所需边界。
6. Context Engine V2：Repo Map / symbols / imports 与动态 context budget 统一进入 workspace_context。
7. Context Compaction：压力分级、continuation checkpoint 建议、output_ref 优先策略。
8. Tool Registry V2：workspace scoped generation、core tool、工具组、side-effect / retry-safe 元数据。
9. Permission V2：路径与命令 pattern 规则，可在本地设置页配置。

## 磁盘安全

- Worktree 创建前自动执行保守 GC。
- 已应用 Worktree 可清理。
- 未应用 Worktree 只有在 Git 状态干净且 HEAD 仍等于 snapshot baseline 时，才可能按保留策略清理。
- 已提交但尚未应用回主工作区的分支不会因“工作区干净”被误删。
- dist/build 和 __pycache__/pyc 可从工作区面板清理。
- 不再通过截断 worktrees.json 隐藏老 Worktree；达到上限时明确阻止继续创建。

## 发布验证

发布前必须通过 MCP Python 回归、Schema v8 contract、Node/Electron 回归、source-root clean 检查、npm run dist，并确认 0.5.0 Windows NSIS 安装包存在。
