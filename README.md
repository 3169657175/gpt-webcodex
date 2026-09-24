# 网页 MCP 助手（GPT-WebCodex）

让 **ChatGPT 网页版直接连接 Windows 本地开发环境** 的桌面开发助手。

它把 ChatGPT 的模型能力与本地 Electron + Coding Tools MCP 结合起来，让网页聊天可以真正读取项目、修改代码、执行命令、运行测试、构建安装包、处理 Git，并在长任务中持续汇报和恢复执行。

> 项目定位：个人使用的轻量级 Codex 桌面助手。
> ChatGPT Web 负责模型能力，本地应用负责项目、工具、执行与状态管理，不额外维护第二套 OpenAI 模型 API。

## 当前版本

| 组件 | 版本 |
| --- | --- |
| 网页 MCP 助手 Desktop | **v0.5.8** |
| Coding Tools MCP Runtime | **v0.5.8** |
| MCP Tool Schema | **v10 / 9 tools** |
| Schema Hash | `cb44f23fd265c4a7d10c801ca9ef88ee0fa4228b7a73151b02ff693f23757949` |
| Electron | **43.2.0** |
| 平台 | **Windows** |

## 能做什么

- **直接操作本地项目**：读取、搜索、修改和创建代码文件。
- **执行开发命令**：运行 PowerShell、Git、npm、Python 和项目自己的脚本。
- **自动测试与构建**：完成测试、诊断、打包和发布流程。
- **多工作区管理**：可切换项目，并单独管理额外授权目录。
- **长任务持续执行**：保留任务、命令、进度与恢复状态，网络或页面短暂异常后可以继续。
- **Git / Worktree 工作流**：支持 Git 操作、隔离 Worktree、安全应用修改与清理。
- **本地会话与开发上下文**：保存本地任务、历史、Checkpoint、Rules、Recipes、Skills 和 Memory 等开发上下文。
- **ChatGPT 页面增强**：支持工具调用折叠、连续 MCP 状态观察和页面异常恢复提示。

## v0.5.8 重点更新

0.5.8 主要完成权限模型与稳定性收口：

- 默认启用**个人完全权限模式**，不再依赖 ChatGPT 客户端无法弹出的二次审批窗口。
- `read / write / delete / command / network / git_write / system_modify / extra_access` 八类开发权限统一按个人助手模式放行。
- 工作区和授权目录仍用于本地文件工具的范围管理。
- 恢复“已调用工具”折叠功能，并增加独立开关；关闭后恢复 ChatGPT 原生显示。
- 优化 Git 只读/写入识别，避免普通 `git status`、`git log` 等命令被误判为高风险操作。
- 已完成命令输出保留时间提升到 24 小时，便于长任务结束后继续查看结果。
- 修复 Worktree 中构建安装包时 Electron 路径解析问题。
- 完成 v0.5.6 → v0.5.7 → v0.5.8 的正式 Git 基线、Tag 与发布流程整理。

详细变化见 [v0.5.8 发布说明](docs/RELEASE_NOTES_0.5.8.md)。

## 安装

推荐直接从 GitHub Releases 下载最新版：

**[下载 v0.5.8](https://github.com/3169657175/gpt-webcodex/releases/tag/v0.5.8)**

安装包：

`web-mcp-assistant-setup-0.5.8.exe`

安装后：

1. 启动网页 MCP 助手。
2. 登录 ChatGPT。
3. 在顶部选择或添加本地工作区。
4. 直接在 ChatGPT 中让 AI 查看项目、修改代码、运行测试或构建。

## 工作方式

```text
ChatGPT Web
    │
    ▼
网页 MCP 助手（Electron）
    │
    ├── Workspace / Authorized Roots
    ├── Runtime / Task / Recovery
    ├── Git / Worktree
    └── Coding Tools MCP
            │
            ▼
      Windows 本地项目
```

ChatGPT 页面与本地 Runtime、Tunnel、任务执行相互独立。页面短暂断流或刷新不应自动中断健康的本地任务。

## 权限说明

v0.5.8 面向**单用户个人开发场景**，默认采用完全权限模式：

- 命令执行使用当前 Windows 用户本身拥有的权限。
- Git 提交、Tag、构建、进程操作等正常开发流程不再等待聊天中的二次批准。
- 工作区与额外授权目录仍用于直接文件工具的路径范围管理。

因此，请只在你信任的本机和项目中使用。

## 开发

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm run test
```

构建 Windows 安装包：

```bash
npm run dist
```

输出目录：

```text
dist/
```

## 项目结构

```text
electron/                    Electron 主进程、ChatGPT 页面与 Runtime 编排
renderer/                    桌面管理界面
resources/coding-tools-mcp/  Coding Tools MCP Python Runtime
tests/                       Electron / Node 回归测试
scripts/                     Schema、测试与发布脚本
docs/                        正式版本发布说明
```

## 发布与验证

正式版本发布前会执行：

- 完整 `npm run test`
- Schema 契约一致性检查
- `npm run dist`
- 安装包、Runtime、Schema 与版本号核对
- Git commit / tag / clean 状态检查

当前 v0.5.8 安装包 SHA-256：

```text
542594E9BB4F4AA336A97F739EEBE45080C6F1FA575A11B87ED579F196FCCF5E
```

## License

本项目使用 [MIT License](LICENSE)。

第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
