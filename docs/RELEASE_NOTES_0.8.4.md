# 网页 MCP 助手 v0.8.4

v0.8.4 聚焦四个真实使用问题：长期上下文命名、由模型主动总结长期信息、运行详情误触范围过大，以及服务启动链路状态乱亮。

## 长期上下文

- 管理中心将“本地记忆”统一改名为“长期上下文”，更准确地覆盖用户长期画像、协作习惯、项目规则与持久决策。
- 页面明确区分“ChatGPT 主动总结”和“自动画像辅助”：自动采集不再被描述为唯一来源。
- 旧 MemoryStore/SQLite/Markdown 数据继续兼容，不做破坏性目录重命名。

## 模型主动总结：`remember_context`

- Coding Tools MCP smart 模式新增第 10 个公开工具 `remember_context`。
- 模型可以在日常聊天和开发过程中自行判断：只有稳定、长期、可复用、未来协作仍有价值的信息才写入。
- 支持全局上下文与当前项目上下文；支持核心偏好、工作方式、项目决策、项目背景等语义。
- 同内容自动去重；同标题/同类型的更新会合并到原记录并保留修订链，不制造重复候选。
- 密码、Token、支付凭据等 secret 直接拒绝；敏感个人信息不会通过模型主动写入通道落盘。
- 原有自动画像 observer 继续保留，仅作为兜底辅助。

## 运行详情触发范围

- 原生 Activity Detail 浮窗继续保持，不会挤压 ChatGPT 页面。
- 隐式 hover/click 热区从整条进度带缩小到左侧状态文案块，宽度约 390–400px。
- 右侧计时、空白区域和其他按钮不再误触运行详情。
- 显式“活动详情”按钮仍可固定/关闭详情窗口。

## 服务启动链路

- 启动阶段固定为：检查配置 → 检查环境与网络 → 启动 Runtime → 验证本地 MCP → 启动 Tunnel → 验证 OpenAI 通道 → 检查 ChatGPT MCP。
- RuntimeOrchestrator 增加明确的 `runtime-ready`、`mcp-ready`、`tunnel-ready`、`upstream-ready` 里程碑。
- 管理中心不再根据彼此独立的健康探针随意点绿，而是只显示“最长连续就绪前缀”：前一步没完成，后面的步骤一律保持灰色。
- 当前执行阶段单独显示进行中；失败阶段显示红色；后续阶段不会越级。

## Runtime / Schema

- Desktop：`0.8.4`
- Coding Tools MCP Runtime：`0.8.4`
- MCP Tool Schema：`v13 / 10 tools`
- Schema Hash：`ddc6ffcbf2d76157c312709b95bff9136d0e4827f7b539e42d4710ba963ea4b2`

## 安装包

- `dist/web-mcp-assistant-setup-0.8.4.exe`
- 大小：`126,318,404 bytes`（约 `120.47 MiB`）
- SHA-256：`08C4A64437177301D96361317BA58D8248090CEB1DCA4CF1864E17DB2CD95B3E`
- FileVersion / ProductVersion：`0.8.4`
