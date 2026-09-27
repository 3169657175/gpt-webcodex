# 网页 MCP 助手（GPT-WebCodex）

让 **ChatGPT 网页版直接连接 Windows 本地开发环境** 的桌面开发助手。

它把 ChatGPT 的模型能力与本地 Electron + Coding Tools MCP 结合起来，让网页聊天可以真正读取项目、修改代码、执行命令、运行测试、构建安装包、处理 Git，并在长任务中持续汇报和恢复执行。

> 项目定位：个人使用的轻量级 Codex 桌面助手。
> ChatGPT Web 负责模型能力，本地应用负责项目、工具、执行与状态管理，不额外维护第二套 OpenAI 模型 API。

## 当前版本

| 组件 | 版本 |
| --- | --- |
| 网页 MCP 助手 Desktop | **v0.7.5** |
| Coding Tools MCP Runtime | **v0.7.5** |
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

## v0.7.5 应用内登录与自动返回

优先在助手内完成登录：识别可见的登录入口或 Google「此浏览器或应用可能不安全」错误时，显示中央登录提示；顶部也保留醒目的「登录 / 登录帮助」。登录弹窗接入应用内部，保留 Chromium 原始子窗口、opener 和同一会话，支持二级认证弹窗。

账号会话与聊天输入框都确认就绪后才自动返回聊天。如果网站仍拒绝应用内登录，可以在中央提示选择助手专用的 Chrome（未安装时尝试 Edge）备用登录，成功后自动检查、仅同步 ChatGPT 的第一方登录 Cookie 并返回，不再要求寻找右上角的返回按钮。

- 不读取日常 Chrome 的配置、账号、密码或 Cookie，不复制 Google Cookie，不使用登录 UA 伪装或关闭浏览器安全机制。
- 失败时恢复助手原有 Cookie，保留独立登录窗口供重试；取消、成功或 15 分钟超时后关闭助手自己启动的浏览器并清理临时配置。
- 登录状态受浏览器、账号风控与网站变化影响；同步验证未通过时不会显示登录成功，可以先在独立窗口继续使用。
- 本地 Runtime、Tunnel 和工作区不因登录修复而重启或清空。

本地安装包：`dist/web-mcp-assistant-setup-0.7.5.exe`。尚未上传 GitHub，下面的 v0.7.3 链接仍是已公开版本。

设计参考 [Codex Web GPT 的应用内认证架构](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md)，详细变化见 [v0.7.5 发布说明](docs/RELEASE_NOTES_0.7.5.md)。Google 的嵌入式浏览器限制不在助手控制范围内，真实账号仍需手动验收。

## v0.7.3 重点更新

0.7.3 修复管理中心与工作区中心在 Windows 任务切换时被主窗口盖住的问题，并收紧 Tunnel ID 的界面暴露：

- 设置与工作区中心现在作为主 ChatGPT 助手窗口的正式 owned window 存在，继续保持单任务栏入口，但 Alt+Tab 切走/切回时不会被主界面覆盖。
- 保留显式关闭语义：只有点击窗口关闭按钮、返回 ChatGPT 或应用自身关闭流程才隐藏这些窗口，不增加 blur 自动隐藏。
- 配置教程不再明文回显已保存的 Tunnel ID；默认只显示脱敏值，输入框也不再自动填充当前完整 ID。
- 首页与诊断等被动状态区域同样使用脱敏 Tunnel ID，完整值只保留在明确的“连接与运行”编辑设置中。
- 增加窗口 owner/Alt+Tab 行为与 Tunnel ID 脱敏回归测试。

详细变化见 [v0.7.3 发布说明](docs/RELEASE_NOTES_0.7.3.md)。
## v0.7.2 重点更新

0.7.2 重点修正管理中心的状态语义和视觉层级，让“已经能用”与“真正需要处理”清楚分开：

- ChatGPT MCP 的 waiting-first-attachment 不再被当成黄色故障；Runtime、Tunnel 与 OpenAI 通道已就绪时显示可用，首次实际调用再确认单条消息挂载。
- 首页“服务启动链路”按实时状态回填已完成阶段，避免服务已经就绪但中间方块仍像未启动。
- “配置教程”升级为与其他入口一致的标准侧栏导航，不再使用异形二级按钮。
- 左侧运行状态改成紧凑健康摘要，减少大卡片、渐变和无效空白。
- “设置与诊断”重新分组为常用设置、外观与行为、连接与运行、诊断与维护，并降低卡片密度与视觉噪音。
- 增加 0.7.2 管理中心状态语义、导航与布局回归测试。

详细变化见 [v0.7.2 发布说明](docs/RELEASE_NOTES_0.7.2.md)。

## 安装

推荐直接从 GitHub Releases 下载最新版：

**[下载 v0.7.3](https://github.com/3169657175/gpt-webcodex/releases/tag/v0.7.3)**

安装包：

`web-mcp-assistant-setup-0.7.3.exe`

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

v0.7.3 面向**单用户个人开发场景**，默认采用完全权限模式：

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

本地 v0.7.5 安装包 SHA-256：

```text
26593E036EC093601C8E252740DF7721080703CE36BEE23E5A48E36DD3E34EB4
```

已公开 v0.7.3 安装包 SHA-256：

```text
8B039DCDA2DAE437983C5B64DB27151776F1D91C3990ED77AA1C8599370E0581
```

## License

本项目使用 [MIT License](LICENSE)。

第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
