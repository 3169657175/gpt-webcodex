# v0.7.6 · 首次配置流程重构

0.7.6 重点修复“配置教程看起来完整、实际按顺序操作却会失败”的问题。教程现在按真实依赖关系重新排列，不再让用户在 Runtime/Tunnel 尚未启动时提前去 ChatGPT 创建 MCP 应用。

## 完整首次配置顺序

1. 在 OpenAI Platform 创建 Tunnel 和 API Key，并把 Tunnel ID / API Key 保存到助手。
2. 添加或选择一个实际存在的本地工作区。
3. 启动 Runtime 与 Tunnel，确认 Runtime 正常、Tunnel 已连接。
4. 再进入 ChatGPT 开启开发者人员模式。
5. 最后创建 Coding Tools MCP 应用，并回到 ChatGPT 对话实际调用验证。

## 交互改进

- 教程新增独立“设置工作区”步骤和“添加 / 选择工作区”按钮。
- 工作区变更后，教程页会即时刷新当前工作区状态，无需重新打开设置。
- “启动服务”按钮只有在 Tunnel ID、API Key 和工作区都准备完成后才可用。
- 启动区直接显示 Runtime / Tunnel 的真实状态，并明确提示“必须先启动服务，再创建 MCP 应用”。
- 创建 MCP 应用移动到流程最后，创建完成后通过首次实际调用确认 ChatGPT MCP 挂载状态。
- 保留 Tunnel ID 脱敏显示，不在教程页回显完整 ID。

## 验证

完整测试：**215 / 215 通过**。

Windows 安装包：`web-mcp-assistant-setup-0.7.6.exe`

SHA-256：1FEE463B1774A63DE6A66F485B6F87158246E1B8A8ED48E48E52B527C568A335。
