# 网页 MCP 助手 0.5.9 发布说明

0.5.9 重点更新首次配置教程，适配新版 OpenAI Platform 与 ChatGPT 插件 / MCP 应用创建流程。

## 主要变化

- “配置教程”从弹窗升级为“设置与诊断”下的独立二级导航页面。
- 第 1 步直接引导打开 OpenAI Platform Tunnel 与 API Key 页面。
- 教程内可直接填写并保存 Tunnel ID。
- 教程内可直接安全保存 OpenAI API Key，继续使用 Windows 安全存储且不回显明文。
- 明确提醒 API Key 创建后立即复制保存。
- 新增 ChatGPT 开发者人员模式直达入口。
- 适配新版“插件 → + → 创建应用 → 创建 MCP 应用”流程。
- MCP 应用配置明确为：连接方式“隧道”、选择已创建 Tunnel、身份验证“无身份认证”、名称“Coding Tools MCP”。
- 最后一页直接显示 Runtime、Tunnel、ChatGPT MCP 状态，并提供启动 / 重启与返回 ChatGPT 按钮。
- 更新管理中心左侧版本显示为 0.5.9。

## 配置入口

- Tunnel: https://platform.openai.com/settings/organization/tunnels
- API Key: https://platform.openai.com/settings/organization/api-keys
- 开发者人员模式: https://chatgpt.com/plugins#settings/Security?section=developer-mode
- 插件: https://chatgpt.com/plugins

## 验证

发布前执行完整 npm run test、npm run dist，并核对安装包内 Desktop / Runtime / Schema 身份。
