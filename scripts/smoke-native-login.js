// Synthetic smoke test only: never visits a login page or reads a real browser profile.
// Run with node_modules/electron/dist/electron.exe scripts/smoke-native-login.js
const { app, session, BrowserWindow, ipcMain, WebContentsView, webContents } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { NativeLoginService, LoginCdp, portableCookie } = require('../electron/services/nativeLoginService');
const { ChatViewController } = require('../electron/chatViewController');

// A GUI executable may outlive the launching terminal's pipe. Test logs must never crash Electron.
for (const stream of [process.stdout, process.stderr]) stream.on('error', (error) => {
  if (error.code !== 'EPIPE') process.exitCode = 1;
});
let phase = 'startup';

const smokeRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'assistant-login-smoke-'));
fsSync.mkdirSync(path.join(smokeRoot, 'electron'));
app.setPath('userData', path.join(smokeRoot, 'electron'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let root;
  let service;
  let page;
  try {
    root = path.join(smokeRoot, 'browser');
    phase = 'native browser / synthetic cookie';
    const isolated = session.fromPartition(`native-login-smoke-${Date.now()}`);
    service = new NativeLoginService({ root, session: isolated, verify: async () => false, dependencies: {
      spawn: (exe, args) => spawn(exe, [...args.slice(0, -1), '--headless=new', 'about:blank'], { stdio: 'ignore', windowsHide: true })
    } });
    assert.equal((await service.start()).status, 'waiting');
    const run = service.run;
    const targets = await run.browser.call('Target.getTargets');
    const target = targets.targetInfos.find((item) => item.type === 'page');
    const response = await fetch(`http://127.0.0.1:${run.port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const pages = await response.json();
    page = await LoginCdp.connect(pages.find((item) => item.id === target.targetId).webSocketDebuggerUrl);
    const result = await page.call('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true });
    // Headless smoke may mark automation. Production launch never passes headless/automation flags.
    assert.equal(typeof result.result.value, 'boolean');
    await page.call('Network.setCookie', { name: '__Secure-assistant-smoke', value: 'synthetic-not-an-account', url: 'https://chatgpt.com/', secure: true, httpOnly: true, sameSite: 'Lax' });
    const cookies = await page.call('Network.getCookies', { urls: ['https://chatgpt.com/'] });
    const cookie = portableCookie(cookies.cookies.find((item) => item.name === '__Secure-assistant-smoke'));
    assert.ok(cookie);
    await isolated.cookies.set(cookie);
    await isolated.cookies.flushStore();
    const actual = await isolated.cookies.get({ name: '__Secure-assistant-smoke' });
    assert.equal(actual[0].value, 'synthetic-not-an-account');
    assert.equal(actual[0].httpOnly, true);
    page.close();
    page = null;
    const profile = run.profile;
    await service.cancel();
    assert.equal(run.exited, true);
    assert.equal(service.getState().cleanupWarning, '');
    await assert.rejects(fs.access(profile));
    await isolated.clearStorageData();
    // Exercise the real toolbar at normal and minimum supported widths, without ChatGPT/network.
    for (const channel of ['chat:status', 'app:lightweight-snapshot', 'workspace:hub', 'task-state:read', 'mcp:task-runtime', 'approval:list']) {
      ipcMain.handle(channel, () => ({ ok: true, data: { workspaces: [], pending: [] } }));
    }
    const window = new BrowserWindow({ width: 1360, height: 900, show: false,
      webPreferences: { preload: path.join(__dirname, '../electron/browserPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await window.loadFile(path.join(__dirname, '../renderer/browser.html'));
    phase = 'central login dialog';
    for (const width of [1360, 960]) {
      window.setContentSize(width, 900);
      const fits = await window.webContents.executeJavaScript(`(() => {
        renderChatState({nativeLogin:{status:'waiting',message:'请在 Chrome 窗口手动登录 ChatGPT，看到聊天主页后点击「登录完成，返回助手」。'}});
        return ['nativeLoginButton','nativeLoginFinish','nativeLoginCancel','managerButton'].every(id => {
          const element = document.getElementById(id), rect = element.getBoundingClientRect();
          return !element.hidden && rect.width > 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= 164;
        });
      })()`);
      assert.equal(fits, true, `Login toolbar controls must fit width ${width}`);
      const central = await window.webContents.executeJavaScript(`(() => {
        renderChatState({nativeLogin:{status:'idle'},login:{prompt:true,kind:'entry',status:'prompt',message:'模拟登录提示'}});
        const dialog = document.getElementById('loginDialog'), rect = dialog.getBoundingClientRect();
        const primary = document.getElementById('embeddedLoginStart');
        const fits = dialog.open && !primary.hidden && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
        renderChatState({nativeLogin:{status:'waiting',active:true},login:{prompt:true,mode:'native',status:'waiting'}});
        const automatic = !document.getElementById('loginCheckNow').hidden && document.getElementById('embeddedLoginStart').hidden;
        renderChatState({nativeLogin:{status:'success'},login:{prompt:false,status:'success'}});
        return fits && automatic && !dialog.open;
      })()`);
      assert.equal(central, true, `Central login dialog/automatic return must fit width ${width}`);
      if (width === 1360 && process.env.ASSISTANT_LOGIN_SMOKE_SCREENSHOT) {
        await window.webContents.executeJavaScript(`renderChatState({nativeLogin:{status:'idle'},login:{prompt:true,kind:'entry',status:'prompt',message:'可以直接在助手内完成登录，登录成功后自动回到聊天。'}}); true;`);
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
        const picture = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await fs.writeFile(process.env.ASSISTANT_LOGIN_SMOKE_SCREENSHOT, picture.toPNG());
        await window.webContents.executeJavaScript(`renderChatState({login:{prompt:false}}); true;`);
      }
    }
    // Real Chromium child adoption and opener continuity; only about:blank, no account/network.
    const authSession = `synthetic-auth-${Date.now()}`;
    phase = 'native child adoption';
    const controller = new ChatViewController({ window, log: { info() {}, warn() {} }, settings: { load: () => ({}) }, toolbarHeight: 164 });
    controller.view = new WebContentsView({ webPreferences: { partition: authSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.contentView.addChildView(controller.view);
    const authChild = webContents.create({ partition: authSession, sandbox: true, contextIsolation: true, nodeIntegration: false });
    controller.createEmbeddedAuthView({ webContents: authChild });
    await authChild.loadURL('about:blank');
    phase = 'nested popup creation';
    await authChild.executeJavaScript(`window.__syntheticOpener = 'synthetic-parent'; window.open('about:blank'); true;`);
    assert.equal(controller.authViews.length, 2);
    const nested = controller.authViews.at(-1).webContents;
    phase = 'nested opener verification';
    assert.equal(await nested.executeJavaScript('window.opener.__syntheticOpener'), 'synthetic-parent');
    assert.equal(nested.session, authChild.session);
    const closed = Promise.all([authChild, nested].map((contents) => new Promise((resolve) => contents.once('destroyed', resolve))));
    controller.dismissLogin();
    await closed;
    assert.equal(authChild.isDestroyed(), true);
    assert.equal(nested.isDestroyed(), true);
    controller.dispose();
    window.destroy();
    console.log('PASS: real Chrome CDP + Electron cookies + owned process/profile cleanup (synthetic data only)');
    console.log('PASS: real Electron login toolbar fits 1360px and 960px (isolated, no account/network)');
    console.log('PASS: central login dialog and in-app nested OAuth adoption retain opener and session (synthetic only)');
    app.exit(0);
  } catch (error) {
    page?.close();
    await service?.cancel();
    console.error(`FAIL [${phase}]: ${error.stack || error.message}`);
    app.exit(1);
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
