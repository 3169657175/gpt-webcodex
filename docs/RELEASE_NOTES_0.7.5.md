# v0.7.5 · 应用内登录与自动返回

## 用户流程

- 顶部入口改为醒目的「登录 / 登录帮助」。检测可见的登录按钮、Google 登录环境被拒绝时，显示中央提示，不需要等出错后再找角落按钮。
- 默认「在应用内继续登录」：登录页和后续认证弹窗显示在助手内。直接采用 Chromium 提供的 WebContents，保留 opener、原始导航和同一会话；不再拒绝所有二级弹窗。
- 不再一跳到 ChatGPT 域名就关闭认证页。先通过原生 session.fetch 验证第一方账号会话，再确认主聊天输入框就绪，才关闭认证视图并返回。
- 仍被 Google 拒绝时，中央提示提供 Chrome / Edge 备用登录。该窗口完成登录后自动检查、同步并聚焦返回助手；中央「我已登录，立即检查」保留为手动检查入口。
- 加载超过 60 秒、加载失败有可操作提示；页面检查有独立时限。取消会使未完成的检查失效，迟到的结果不能再次显示成功。

## 设计与边界

参考已安装 Codex Web GPT 6.1.1 的程序代码，以及公开的 [应用内认证架构](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md) 和 [浏览器宿主](https://github.com/miuuyy/codex-chatgpt-web/blob/main/launcher/electron/browser-host.cjs)。未读取该软件的账号、Cookie、密码或用户配置。

- 保留真实浏览器身份，不另行重写 UA；不关闭 sandbox / webSecurity，不绕过 Google 的安全策略，不自动填写或提交账号凭据。
- 仅检查可见的登录控制、登录错误和输入框是否存在，不读取输入框值或聊天内容；会话验证只返回真假，不向界面或日志返回 session/token。
- OAuth 一次性回调不自动重试或记录完整地址。外部备用登录继续使用独立临时配置，不连接日常 Chrome 配置，不导出 Google Cookie；失败恢复原有 ChatGPT Cookie。
- 自动同步失败停止自动导入循环，保留浏览器和手动重试入口。成功、取消、超时及关闭时只清理自己启动的进程和临时目录。
- 页面登录不重启 Runtime / Tunnel，不清空工作区。公开 MCP 工具未改，Schema 保持 v10 / 9 tools，hash `cb44f23fd265c4a7d10c801ca9ef88ee0fa4228b7a73151b02ff693f23757949`。
- 修正登录冒烟脚本输出管道关闭时的 EPIPE 处理；验证脚本以文件日志运行并等待退出，避免测试错误再触发主进程弹窗。

Google 可能继续拒绝某些嵌入式浏览器，见 [官方浏览器支持说明](https://support.google.com/accounts/answer/7675428)。不能保证所有账号应用内登录都成功，备用方案仍有必要。

## 验证与交付

真实 Electron 隔离冒烟已通过：1360px / 960px 工具栏和中央弹窗、嵌套窗口采用原始子 WebContents、opener 与同一会话保留、取消后实际 destroyed 事件、自有 Chrome 进程退出及临时配置清理。仅使用 about:blank / 合成 Cookie，不访问真实账号。

- 正常本机权限下完整 `npm test`：Python 271/271（182.439 秒）、Node 211/211，Schema 与源目录清洁检查通过，没有跳过或放宽测试。
- 登录专项合计 30 项，覆盖弹窗采用、嵌套认证、可见入口/拒绝提示、会话与主输入框双重验证、取消、超时、页面无响应、外部自动返回、失败回滚和停止自动导入循环。
- NSIS 发行构建完成。`app.asar` 内 9 个相关登录/界面源码与开发目录逐字节一致；构建处理后的 package.json 版本、main、name 正确。打包 Python 实际从安装包资源目录导入 Runtime 0.7.5，Schema v10 / 9 tools / hash 一致。
- 安装包：`dist/web-mcp-assistant-setup-0.7.5.exe`，126,301,575 bytes。
- SHA-256：`26593E036EC093601C8E252740DF7721080703CE36BEE23E5A48E36DD3E34EB4`。
- 安装包未做 Authenticode 签名，Windows 可能提示未知发布者。Git 正式源码提交与 `v0.7.5` 标签纳入本地发布基线；不执行 GitHub 上传，也不直接覆盖应用安装目录。

真实账号 Google → ChatGPT → 返回助手仍须用户手动验收；不会把模拟测试写成真实登录成功。
