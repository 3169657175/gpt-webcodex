// Synthetic smoke test only: never visits a login page or reads a real browser profile.
// Run with node_modules/electron/dist/electron.exe scripts/smoke-native-login.js
const { app, session, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { NativeLoginService, LoginCdp, portableCookie } = require('../electron/services/nativeLoginService');

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
      webPreferences: { preload: path.join(__dirname, '../electron/browserPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadFile(path.join(__dirname, '../renderer/browser.html'));
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
    }
    window.destroy();
    console.log('PASS: real Chrome CDP + Electron cookies + owned process/profile cleanup (synthetic data only)');
    console.log('PASS: real Electron login toolbar fits 1360px and 960px (isolated, no account/network)');
    app.exit(0);
  } catch (error) {
    page?.close();
    await service?.cancel();
    console.error(`FAIL: ${error.message}`);
    app.exit(1);
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
