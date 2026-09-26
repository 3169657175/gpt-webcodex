# 网页 MCP 助手（GPT-WebCodex）

让 **ChatGPT 网页版直接连接 Windows 本地开发环境** 的桌面开发助手。

它把 ChatGPT 的模型能力与本地 Electron + Coding Tools MCP 结合起来，让网页聊天可以真正读取项目、修改代码、执行命令、运行测试、构建安装包、处理 Git，并在长任务中持续汇报和恢复执行。

> 项目定位：个人使用的轻量级 Codex 桌面助手。
> ChatGPT Web 负责模型能力，本地应用负责项目、工具、执行与状态管理，不额外维护第二套 OpenAI 模型 API。

## 当前版本

| 组件 | 版本 |
| --- | --- |
| 网页 MCP 助手 Desktop | **v0.7.0** |
| Coding Tools MCP Runtime | **v0.7.0** |
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
- **ChatGPT 页面增强**：保留原生页面渲染，提供连续 MCP 状态观察、动态资源错误提示和长时间无新内容的可操作反馈。

## v0.7.0 重点更新

0.7.0 面向“长任务看起来卡住、网页正在运行但没有反馈、页面更新后资源加载异常”等真实使用问题：

- 移除工具调用折叠和强制 CSS 注入，ChatGPT 工具展示完全交给官方页面，减少 DOM 适配回归。
- 增加网页生成活动心跳；45 秒没有新内容时明确标记为“页面可能停滞”，可直接停止生成或刷新页面。
- 本地任务事件通过 SSE 即时推送到 ChatGPT 界面，命令即使没有输出也每 5 秒更新运行心跳。
- 动态导入模块、Chunk 加载失败会显示明确的刷新动作，不会误重启健康的 MCP Runtime。
- 附件下载完成后可以直接从工作区打开，绕过 ChatGPT 在线预览缓存限制。
- 设置页删除失效的工具折叠选项，保留连接、通知和诊断等真正有效的控制项。

## v0.6.0 重点更新

0.6.0 是一次状态内核与管理中心的大版本收口，重点处理“任务已经结束但仍显示运行”“长任务看起来卡住”“旧失败状态反复复活”“空 Worktree 误报”和管理界面层级杂乱等问题：

- 重构任务终态结算、归档与恢复边界，已完成/失败任务不再被后续无关命令重新激活。
- 强化长任务与命令状态汇总，让运行中、等待模型、失败和完成状态更容易区分。
- 改进 ChatGPT stream recovery 与轮询边界，减少无响应、假运行和恢复超时带来的状态错位。
- 收紧 Worktree 清理与回收判断：无差异自动收口，有未应用修改时继续保留。
- 重构管理中心 UI，改为更清晰的侧栏、状态摘要、服务状态、任务详情和诊断层级。
- 保持 Runtime / Schema / Desktop 版本同步，并增加 0.6.0 状态内核、ChatGPT stream、Worktree 与 UI 专项回归。

详细变化见 [v0.6.0 发布说明](docs/RELEASE_NOTES_0.6.0.md)。

## 安装

推荐直接从 GitHub Releases 下载最新版：

**[下载 v0.7.0](https://github.com/3169657175/gpt-webcodex/releases/tag/v0.7.0)**

安装包：

`web-mcp-assistant-setup-0.7.0.exe`

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

v0.6.0 面向**单用户个人开发场景**，默认采用完全权限模式：

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
- Windows NSIS 发行构建
- 安装包、`app.asar`、Runtime、Schema 与版本号核对
- Git commit / tag / clean 状态检查

当前 v0.7.0 安装包 SHA-256：

```text
4F4E86BEF05CFB0C932A9A987F8AC819336454CB6FF25A108604C558F4A52D63
```

## License

本项目使用 [MIT License](LICENSE)。

第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
