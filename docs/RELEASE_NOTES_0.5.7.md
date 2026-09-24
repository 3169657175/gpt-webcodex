# 网页 MCP 助手 0.5.7 发布说明

0.5.7 是 0.5.6 的体验与收口修复版本。

## 主要变化

- 恢复 ChatGPT 回复中的“已调用工具”折叠：同一回复的工具调用可汇总为“工具 × N”，点击展开/收起。
- 管理中心新增“折叠‘已调用工具’”开关，默认开启；关闭后立即移除注入样式和汇总按钮并恢复 ChatGPT 原生显示。
- 修复 Git 只读命令误触发本地批准：status/log/tag --list/branch --list/worktree list 保持只读，add/commit/tag 创建等写操作仍受 git_write 保护。
- 已完成命令输出保留窗口由 5 分钟/32 个/16MB 提升至 24 小时/128 个/64MB，减少长任务结束后 SESSION_NOT_FOUND。
- 保留 0.5.6 的 Schema v10、Worktree 安全隔离、stream recovery 保护和任务终态一致性。

## 验证

发布前执行完整 npm run test、npm run dist、安装包版本/hash/app.asar 检查。
