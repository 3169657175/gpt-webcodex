# 网页 MCP 助手 0.6.0 发布说明

0.6.0 是一次状态内核与管理中心的大版本升级，重点解决“假运行、旧任务诈尸、空 Worktree 误报、长任务无反馈”和管理中心界面杂乱等问题。

## Run 状态内核

- 终态 Run（completed / failed / cancelled）进入冻结状态，普通后续命令不会再把旧任务复活。
- 终态任务自动结算仍在运行的 step，并生成 completion receipt。
- 终态任务只短暂保留在“当前任务”，随后退出 current view，历史仍可保留。
- 后台 operation 按 run_id 严格过滤，避免不同任务之间的 operation 串线。
- Runtime 增加统一用户状态：running / waiting_model / waiting_user / completed / failed / cancelled / stalled。
- 增加 heartbeat age 与 stall detection，长时间无活动会明确显示“疑似卡住”。

## Worktree 与执行可靠性

- Worktree 现在计算真实 changed_count / changed_paths / has_unapplied_changes。
- clean 且无真实 diff 的 Worktree 不再显示“隔离修改待处理”，终态空 Worktree 可自动清理。
- SNAPSHOT_TOO_LARGE / WORKTREE_LIMIT 在隔离预检阶段自动退化到 direct workspace，不再中途把整个任务打失败。
- Python 测试入口强制当前源码优先，避免便携 Python 误导入已安装旧 Runtime，杜绝假绿/假红。

## ChatGPT 页面状态

- “正在生成”不再只判断 Stop 按钮是否存在。
- 只有可见、可用、非 disabled 的当前停止控件才会视为 generating。
- Stop 控件消失后经过稳定等待再确认回复结束，减少 DOM 残留造成的“明明结束还显示运行”。
- 保留 stream recovery timeout 的独立分类，不与本地 MCP 执行失败混为一谈。

## 管理中心 UI

- 参考 WebCodex Desktop 的桌面信息架构重做管理中心视觉系统。
- 左侧导航增加“工作 / 配置”分组，状态入口改为“首页”。
- 降低卡片堆叠、圆角和彩色强调，改为更克制的平面布局、分隔线、列表和状态条。
- 首页、工作区、本地记忆、设置、诊断和配置教程统一视觉密度与控件风格。
- 服务状态改为连续分栏状态条；任务与启动阶段减少卡片套卡片。
- 保持浅色 / 深色主题一致。

## 验证

- 0.6.0 状态内核新增专项回归。
- ChatGPT stream、Worktree、UI 增加专项回归。
- 发布前执行完整 npm run test 与正式 electron-builder 构建。
- 安装包完成后直接检查 app.asar 内版本与关键实现。
