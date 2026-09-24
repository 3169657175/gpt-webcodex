# 网页 MCP 助手 0.5.8 发布说明

0.5.8 将桌面助手的权限模型收敛为单用户个人开发场景下的完全权限模式。

## 主要变化

- 桌面 Runtime 固定使用 `dangerous` 完全权限模式，不再依赖 ChatGPT 客户端中的交互式批准弹窗。
- `read/write/delete/command/network/git_write/system_modify/extra_access` 八类权限统一固定为 `allow`。
- 旧版本中的 `safe`、`ask`、`deny` 和权限匹配规则在升级时自动迁移，不会再次把 Git 提交、tag、Worktree 清理等正常开发操作卡在 `LOCAL_APPROVAL_REQUIRED`。
- 管理界面继续不暴露复杂权限控制面板，保持个人开发助手的简洁定位。
- `workspace` 与 `authorizedRoots` 仍用于工作区和直接文件工具的路径范围管理；Shell 命令按当前 Windows 用户本机权限运行。
- 保留 0.5.7 的工具调用折叠开关、Git 只读识别、24 小时命令输出保留和 Worktree 构建修复。

## 发布验证

发布前执行完整 `npm run test`、`npm run dist`，并核对安装包内 Runtime/Schema 身份与版本号。
