# 网页 MCP 助手 v0.9.2

0.9.2 是体验与界面收口版本。重点不是继续堆功能，而是让状态更可信、信息更少更有意义，并让管理中心在浅色模式下更自然地融入 ChatGPT 原生白色界面。

## 主要变化

### 连接恢复与状态可信度
- Tunnel 主通道状态进入轻量健康判断，避免“本地进程还活着，但 OpenAI 网关已经长时间看不到 Tunnel”仍被误认为健康。
- MCP Session 明确失效时清理旧 session；安全只读调用允许重新 discovery，带副作用的调用不会自动重放。
- Runtime、Tunnel、ChatGPT MCP 继续分层恢复，Tunnel / 页面问题不会无条件重启健康 Runtime。
- 首页和 React 摘要统一消费 canonical service state，减少“已就绪 / 进行中 / 等待上游”同时出现的矛盾状态。

### 顶部状态与活动详情
- 顶部状态内容仍可在空闲/等待模型时视觉收起，但 ChatGPT 原生 `WebContentsView` 恢复为 0.9.1 的固定 164px 壳层边界，不再由任务状态频繁触发原生 `setBounds()`；用于修复 0.9.2 初版偶发整屏露出“正在打开 ChatGPT”占位页的问题。
- 用户界面不再直接展示后台心跳条，改用“最近活动 / 多久无活动 / 是否疑似停滞”表达。
- 最近事件继续去噪，只保留真正有意义的命令开始/完成、阶段变化、失败和恢复。
- 状态文案尽可能中文化，并统一使用 neutral / positive / warning / danger 语义色调。
- 主 ChatGPT 页面的自动登录探测不再触发模态登录层或隐藏聊天视图；只有用户主动打开登录中心，或已进入嵌入式登录后的真实失败，才允许接管界面，避免误判导致整屏遮罩/空白。
- 嵌入式认证子 View 会清理已销毁/失效实例，并保持主 ChatGPT View 在底层存活；认证层短暂空白或退出时不再把壳层启动占位页暴露出来。

### 长期上下文 V3
- 管理页增加“有效 / 候选 / 已归档”三视图。
- 已归档记忆展示归档原因与归档时间。
- 增加“恢复为有效”和永久删除操作，归档不再是单向入口。
- 同主题冲突继续保留旧内容 / 新内容对照，由模型或用户决定采用新内容、保留旧内容或两条都保留。

### 浅色主题与视觉统一
- 保留现有深色主题。
- 新增纯白浅色主题和“跟随系统”。
- Manager 与 Workspace Center 使用同一主题设置。
- 统一青绿色主操作色、semantic design tokens、按钮高度/层级和常用字号。
- 浅色模式减少重阴影和后台感，整体更接近 ChatGPT / Codex 的白色生产力界面。

### 工作区与交互效率
- ChatGPT 顶部“全部工作区”继续直接打开完整 Workspace Center，不再使用会被 ChatGPT WebContentsView 遮挡的 DOM 下拉层。
- Workspace Center 负责快速切换、新增、删除、清理失效工作区，以及授权目录查看和维护。
- 工作区切换成功使用短时局部反馈，失败直接显示在操作位置附近。

### 发布验证
- 增加真实 Electron Renderer smoke：使用正式 preload、`renderer/index.html` 和 production React bundle 启动隐藏 BrowserWindow。
- 分别验证浅色和深色主题、`booting` 退出、4 个 React portal 挂载、横向溢出、console / preload / render 错误，并生成截图。
- smoke 结果增加独立断言，`result.json` 失败或缺任一主题截图时发布验证必定失败，不再出现假绿。

## 版本
- Desktop：`0.9.2`
- Coding Tools MCP Runtime：`0.9.2`
- MCP Tool Schema：保持 `v14 / 10 tools`，本次未修改公开工具参数契约。
