# v0.7.4 · Google 登录修复

## 修复原因与入口

Google 会拒绝部分嵌入式浏览器登录，反复刷新或者仅修改 User-Agent 无法可靠解决。新增助手顶部「登录修复」，改用真正的 Chrome 或 Edge 窗口手动完成 ChatGPT 登录。

设计依据：[Google 官方浏览器支持说明](https://support.google.com/accounts/answer/7675428)、[Chrome 官方调试配置隔离说明](https://developer.chrome.com/blog/remote-debugging-port)。

1. 点击「登录修复」，会打开助手专用的独立浏览器配置。
2. 在此窗口打开 ChatGPT 的登录入口并选择 Google，自行完成登录。
3. 看到 ChatGPT 聊天主页后，回到助手点击「登录完成，返回助手」。
4. 原生浏览器与内置页面两次验证均成功后才显示修复完成。

不能直接把之前失败的 Google OAuth 链接交给另一个配置，因为 OAuth state、nonce 和 Cookie 属于原来的浏览器会话；必须在新窗口重新发起登录。

## 数据安全与失败处理

- 每次创建专用临时浏览器配置，不连接或读取用户日常 Chrome/Edge 配置。
- 使用本机回环调试连接，仅在用户明确点击返回时读取 ChatGPT 第一方 Cookie；不会导出 Google Cookie、浏览器密码或完整 session 响应。
- 不用自动化标记启动实际登录浏览器，不填写或提交账号密码，不关闭 sandbox/webSecurity。
- Cloudflare 风控 Cookie 和分区 Cookie 不参与同步。
- 同步失败回滚原有 ChatGPT Cookie，保留独立窗口供重试。
- 成功、取消、窗口关闭、应用退出和 15 分钟超时都会处理助手拥有的浏览器进程。不会按浏览器进程名结束日常 Chrome。
- 临时配置被系统占用无法清理时显示清理警告，不宣称已经删除。
- 本地工具、工作区与 Tunnel 不参与登录修复，不会因此重启。
- 按发布基线规则移除历史上误跟踪的 31 个 Python 缓存文件；只移出版本控制，磁盘缓存保留，安装包不包含这些生成物。

Chrome/Google/OpenAI 的账号风控不在助手控制范围内。自动测试使用合成数据，不能代替真实账号的手动登录验收。

## 验证

- Windows 正常权限下完整 `npm test` 通过：Python 271/271，Node 首次全量 196/196；最终补充回滚失败测试后 Node 再次全量 197/197。
- 登录专项 16/16，覆盖失败回滚、恢复失败提示、并发取消、关闭窗口、通信超时、Cookie 范围与属性保留。
- 真实 Chrome CDP / Electron 合成 Cookie 同步 / 自有进程退出与临时配置清理通过；不访问真实登录账号。
- 真实 Electron 工具栏在 1360px 与 960px 宽度通过布局检查。
- Schema v10 / 9 tools，hash `cb44f23fd265c4a7d10c801ca9ef88ee0fa4228b7a73151b02ff693f23757949`，桌面与 Runtime 均为 0.7.4。
- NSIS 发行构建完成，`app.asar` 内 8 个相关界面/登录源码文件与开发目录逐字节一致；打包 Python 可实际导入 Runtime 0.7.4。
- 安装包 `dist/web-mcp-assistant-setup-0.7.4.exe`，126,297,292 bytes。
- SHA-256：`B776A8FBAA57EC231F112827235266BCABAAFAA41D8F323D66D3AAB25CD3BB67`。
- 安装包未做 Authenticode 签名，Windows 可能提示未知发布者。

沙箱内首次 Python 回归有两项 Windows 进程查询/清理失败；进程树专项及完整回归在正常本机权限下均通过，没有跳过或放宽测试。

真实账号的 Google → ChatGPT 登录及回到助手的流程必须由用户手动验收，不能用合成 Cookie 测试冒充验证成功。GitHub 上传未执行，本次只交付本地安装包。
