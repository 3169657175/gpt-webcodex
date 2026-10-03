# 网页 MCP 助手（GPT-WebCodex）

让 **ChatGPT 网页版直接连接 Windows 本地开发环境** 的桌面开发助手。

它把 ChatGPT 的模型能力与本地 Electron + Coding Tools MCP 结合起来，让网页聊天可以真正读取项目、修改代码、执行命令、运行测试、构建安装包、处理 Git，并在长任务中持续汇报和恢复执行。

> 项目定位：个人使用的轻量级 Codex 桌面助手。
> ChatGPT Web 负责模型能力，本地应用负责项目、工具、执行与状态管理，不额外维护第二套 OpenAI 模型 API。

## 当前版本

| 组件 | 版本 |
| --- | --- |
| 网页 MCP 助手 Desktop | **v0.9.2** |
| Coding Tools MCP Runtime | **v0.9.2** |
| MCP Tool Schema | **v14 / 10 tools** |
| Schema Hash | `631ba25229260ab745932f2fcc1cef3deb982ddc0cf3bbcb900047c458e321fd` |
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

## v0.9.2 体验与界面收口版

0.9.2 在 0.9.1 稳定性基础上继续收紧真实使用体验：修复 Tunnel / MCP Session 恢复链的缺口，减少顶部状态与活动详情噪声，补齐长期上下文归档闭环，并新增更接近 ChatGPT / Codex 的纯白主题与跟随系统主题。

- **连接与恢复**：Tunnel 主通道健康进入轻量状态判断，失效 MCP Session 会清理旧 session 并安全重新 discovery；页面/Tunnel 异常不会误重启健康 Runtime。
- **唯一状态源**：首页和 React 摘要统一消费 canonical service / assistant state，正常态自动收起启动链，运行、恢复和异常时才展开细节。
- **运行信息减噪**：顶部空闲态真实压缩，心跳不再作为用户进度条展示，最近事件仅保留命令、阶段、错误和恢复等有意义变化，并尽量中文化。
- **登录层防误触发**：主 ChatGPT 页面的被动登录探测不会再自动隐藏聊天或拉起模态遮罩；只有用户主动登录或嵌入式登录真实失败时才进入登录中心。
- **长期上下文闭环**：增加“有效 / 候选 / 已归档”三视图，归档原因与时间可见，并支持恢复为有效和永久删除。
- **浅色主题**：保留现有深色主题，新增纯白浅色与“跟随系统”，统一青绿色主操作色、按钮层级、字号和 semantic tokens。
- **工作区中心**：ChatGPT 顶部“全部工作区”直接打开完整 Workspace Center，可快速切换工作区、清理失效目录并统一查看和管理授权目录。
- **服务器 URL 与 Tunnel 同后端**：新增 Public MCP Gateway；服务器 URL 连接不再启动第二套 Runtime，而是代理小助手正在使用的同一个 Coding Tools Runtime，因此工作区切换、10 个工具、任务状态/历史、授权目录和长任务恢复与 Tunnel 保持一致。公网入口使用自动生成的高强度随机路径，ChatGPT 侧无需 OAuth 或密码弹窗。
- **真实 Renderer 验证**：发布链新增 production Electron BrowserWindow smoke，真实加载 preload + React bundle，分别验证浅/深主题、React portal、横向溢出和截图，避免“Vite 构建通过但真实窗口失败”的假绿。

详细变化见 [v0.9.2 发布说明](docs/RELEASE_NOTES_0.9.2.md)。

## v0.9.1 稳定性收口版

0.9.1 重点解决真实使用中暴露的几个细节：活动详情仍有噪声、心跳跨阈值后桌面卡住提醒可能被吞、长期上下文同主题新候选可能丢失，以及 React 摘要层仍有二次解释任务状态的风险。

- **活动详情去噪**：隐藏无意义的等待模型心跳和空输出，最近事件统一中文化、去重，只保留命令、阶段和异常信息。
- **卡住提醒修复**：保存“上一次实际观察到的语义事件”，心跳从正常跨过 90 秒阈值时可以真实触发一次 `stalled` 通知；重复轮询不重复弹窗，`waiting_model` 保持静默。
- **长期上下文冲突保护**：候选与候选之间同标题不同内容时，新事实会独立保存为冲突候选，并携带旧内容和新内容供管理界面比较，不再被旧候选吞掉。
- **Legacy V3 清理**：明显的超长阶段式一次性任务 Prompt 自动安全归档，不直接删除；显式记忆和模型正式总结不会被自动清理。
- **React 状态统一**：`app.js` 发布经过共享 `AssistantState` 归一化后的中文状态、语义色调和诊断信息，React/TypeScript 层只消费 canonical state，不再自行解释 `task.status` / `lifecycle_state`。
- **版本展示统一**：设置页与关于区域从 Electron 实际版本读取版本号，避免界面版本字符串滞后。

详细变化见 [v0.9.1 发布说明](docs/RELEASE_NOTES_0.9.1.md)。

## 安装

推荐直接从 GitHub Releases 下载最新版。

本地正式安装包：

`dist/web-mcp-assistant-setup-0.9.2.exe`

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

面向**单用户个人开发场景**，默认采用完全权限模式：

- 命令执行使用当前 Windows 用户本身拥有的权限。
- Git 提交、Tag、构建、进程操作等正常开发流程不再等待聊天中的二次批准。
- 工作区与额外授权目录仍用于直接文件工具的路径范围管理。

因此，请只在你信任的本机和项目中使用。

## 开发

安装依赖：

```bash
npm install
```

运行快速验证：

```bash
npm run test:quick
```

运行完整测试：

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
renderer-ui/                 React + TypeScript + Vite 渐进迁移层
resources/coding-tools-mcp/  Coding Tools MCP Python Runtime
tests/                       Electron / Node 回归测试
scripts/                     Schema、测试与发布脚本
docs/                        正式版本发布说明
```

## 发布与验证

正式版本发布前会执行：

- React / TypeScript 类型检查与构建
- 完整 `npm run test`
- Schema 契约一致性检查
- quick soak 稳定性验证
- Windows NSIS 发行构建
- 安装包、`app.asar`、Runtime、Schema 与版本号核对
- Git commit / tag / clean 状态检查

正式安装包的 SHA-256 以发布完成后的产物校验结果为准。

历史公开版本的校验值继续保留在对应 GitHub Release 与版本发布说明中。

## License

本项目使用 [MIT License](LICENSE)。

第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
