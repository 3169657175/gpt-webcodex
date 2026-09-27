const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { authenticatedSession, authUrl } = require('./chatLoginPolicy');

const CHAT_HOME = 'https://chatgpt.com/';
// Return a boolean only. Never send the session object or token to a renderer/log.
const SESSION_CHECK = `(async () => {
  try {
    if (location.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(location.hostname)) return false;
    const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
    const data = await response.json();
    return (${authenticatedSession.toString()})(data);
  } catch { return false; }
})()`;

class LoginError extends Error {}
function userError(error) { return error instanceof LoginError ? error.message : '登录修复遇到通信或存储错误，请重试；不会记录登录凭据。'; }

function isChatPage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(u.hostname); }
  catch { return false; }
}

function portableCookie(cookie) {
  const domain = String(cookie.domain || '');
  if (!['chatgpt.com', '.chatgpt.com', 'www.chatgpt.com', '.www.chatgpt.com'].includes(domain)) return null;
  // Cloudflare challenges are browser-bound, not part of the account login.
  if (['cf_clearance', '__cf_bm', '_cfuvid'].includes(cookie.name) || cookie.partitionKey) return null;
  const expiration = cookie.expirationDate ?? cookie.expires;
  if (expiration > 0 && expiration <= Date.now() / 1000) return null;
  const result = {
    url: `https://${domain.replace(/^\./, '')}${cookie.path || '/'}`,
    name: cookie.name, value: cookie.value, path: cookie.path || '/',
    secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
    sameSite: ({ None: 'no_restriction', Lax: 'lax', Strict: 'strict', no_restriction: 'no_restriction', lax: 'lax', strict: 'strict', unspecified: 'unspecified' })[cookie.sameSite] || 'unspecified'
  };
  if (domain.startsWith('.') && cookie.hostOnly !== true) result.domain = domain;
  if (!cookie.session && expiration > 0) result.expirationDate = expiration;
  return result;
}

async function findBrowser(env = process.env) {
  const candidates = [
    ['Chrome', env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'],
    ['Chrome', env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'],
    ['Chrome', env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
    ['Edge', env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'],
    ['Edge', env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe']
  ];
  for (const [name, root, relative] of candidates) {
    if (!root) continue;
    const executable = path.join(root, relative);
    try { await fs.access(executable); return { name, executable }; } catch { /* try next */ }
  }
  throw new LoginError('没有找到 Chrome 或 Edge。请安装 Chrome 后再使用登录修复。');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function terminateOwnedChild(child) {
  if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 4000 }, () => resolve()));
  } else child.kill();
}

// Bounded CDP connection. It is used only with our newly spawned, isolated profile.
class LoginCdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let payload; try { payload = JSON.parse(event.data); } catch { return; }
      const request = this.pending.get(payload.id);
      if (!request) return;
      this.pending.delete(payload.id);
      clearTimeout(request.timer);
      if (payload.error) request.reject(new Error('浏览器登录通信失败，请重试。'));
      else request.resolve(payload.result);
    });
    const disconnected = () => this.close();
    socket.addEventListener('close', disconnected, { once: true });
    socket.addEventListener('error', disconnected, { once: true });
  }

  static connect(url, WebSocketClass = WebSocket) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('登录通信地址无效。');
    return new Promise((resolve, reject) => {
      const socket = new WebSocketClass(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error('连接登录浏览器超时，请重试。')); }, 4000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new LoginCdp(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接登录浏览器，请重试。')); }, { once: true });
    });
  }

  call(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('登录浏览器响应超时，请重试。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('登录窗口已关闭，请重新打开。')); }
    });
  }

  close() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('登录窗口连接已断开。')); }
    this.pending.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }
}

class NativeLoginService {
  constructor({ root, session, verify, onState = () => {}, settings = () => ({}), dependencies = {} }) {
    this.root = path.resolve(root);
    this.session = session;
    this.verify = verify;
    this.onState = onState;
    this.settings = settings;
    this.deps = { findBrowser, reservePort, spawn, terminateOwnedChild, connect: LoginCdp.connect, fetch, ...dependencies };
    this.state = { status: 'idle', message: '', browser: '', cleanupWarning: '' };
    this.run = null;
    this.operation = null;
  }

  getState() { return { ...this.state, active: Boolean(this.run) }; }
  update(status, message, browser = this.state.browser) {
    clearTimeout(this.dismissTimer);
    this.state = { status, message, browser, cleanupWarning: this.state.cleanupWarning || '' };
    this.onState(this.getState());
    if (status === 'success') {
      this.dismissTimer = setTimeout(() => this.update('idle', ''), 12000);
      this.dismissTimer.unref?.();
    }
    return this.getState();
  }

  start() {
    if (this.operation || this.run || this.cancelling) return Promise.resolve(this.getState());
    this.state.cleanupWarning = '';
    this.update('starting', '正在打开独立浏览器登录窗口…', '');
    const run = { abort: new AbortController() };
    this.run = run;
    this.operation = this.launch(run).finally(() => { this.operation = null; });
    return this.operation;
  }

  async launch(run) {
    try {
      const browser = await this.deps.findBrowser();
      await fs.mkdir(this.root, { recursive: true });
      run.profile = await fs.mkdtemp(path.join(this.root, 'login-'));
      run.port = await this.deps.reservePort();
      if (run.abort.signal.aborted) throw new LoginError('登录已取消。');
      // A nonzero port and no automation/headless flags: Google login is manual.
      const args = [`--user-data-dir=${run.profile}`, `--remote-debugging-port=${run.port}`,
        '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--new-window', CHAT_HOME];
      const settings = this.settings();
      if (settings.proxyMode === 'direct') args.unshift('--no-proxy-server');
      if (settings.proxyMode === 'manual' && settings.proxyUrl) {
        const value = String(settings.proxyUrl).trim();
        const proxy = new URL(value.includes('://') ? value : `http://${value}`);
        if (!['http:', 'https:', 'socks5:', 'socks4:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') {
          throw new LoginError('登录修复不支持此代理格式，请改用系统代理或无认证的 HTTP/SOCKS 代理。');
        }
        args.unshift(`--proxy-server=${proxy.protocol}//${proxy.host}`);
      }
      run.child = this.deps.spawn(browser.executable, args, { stdio: 'ignore', windowsHide: false });
      run.child.once('error', () => { run.exited = true; });
      run.child.once('exit', () => {
        run.exited = true;
        if (this.run === run && ['waiting', 'error'].includes(this.state.status)) void this.cancel('登录窗口已关闭，尚未同步登录；可以重新打开。', true);
      });
      const deadline = Date.now() + 12000;
      let endpoint;
      while (!run.abort.signal.aborted && !run.exited && Date.now() < deadline) {
        try {
          const response = await this.deps.fetch(`http://127.0.0.1:${run.port}/json/version`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { endpoint = (await response.json()).webSocketDebuggerUrl; if (endpoint) break; }
        } catch { /* startup is asynchronous */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!endpoint || run.abort.signal.aborted) throw new LoginError('未能打开登录窗口，请重试。');
      const parsed = new URL(endpoint);
      if (parsed.port !== String(run.port)) throw new Error('登录通信地址无效。');
      run.browser = await this.deps.connect(endpoint);
      run.expiry = setTimeout(() => { void this.cancel('登录窗口已超过 15 分钟，为保护账号已关闭，请重新开始。', true); }, 15 * 60 * 1000);
      run.expiry.unref?.();
      run.autoWatch = setInterval(() => { void this.autoCheck(run); }, 2000);
      run.autoWatch.unref?.();
      return this.update('waiting', `请在 ${browser.name} 窗口手动登录 ChatGPT。登录成功后助手会自动验证并返回；也可以点击中央的「我已登录，立即检查」。`, browser.name);
    } catch (error) {
      await this.cleanup(run);
      return this.update('error', run.abort.signal.aborted ? '登录已取消。' : userError(error));
    }
  }

  finish() {
    if (this.cancelling) return this.cancelling;
    if (this.operation) return this.operation;
    const run = this.run;
    if (!run?.browser) return Promise.resolve(this.update('error', '请先打开浏览器登录窗口。'));
    run.autoPaused = true;
    this.update('syncing', '正在验证登录并同步到助手，不会重启本地工具…');
    this.operation = this.importLogin(run).finally(() => { this.operation = null; });
    return this.operation;
  }

  async autoCheck(run = this.run) {
    if (!run?.browser || this.run !== run || run.monitorBusy || run.autoPaused || run.abort.signal.aborted || this.operation || this.state.status !== 'waiting') return;
    run.monitorBusy = true;
    let authenticated = false;
    try {
      const targets = await run.browser.call('Target.getTargets', {}, 4000);
      const target = targets.targetInfos.find((item) => item.type === 'page' && isChatPage(item.url) && !authUrl(item.url));
      if (!target) return;
      const response = await this.deps.fetch(`http://127.0.0.1:${run.port}/json/list`, { signal: AbortSignal.timeout(3000) });
      const endpoint = (await response.json()).find((item) => item.id === target.targetId)?.webSocketDebuggerUrl;
      if (!endpoint || new URL(endpoint).port !== String(run.port) || run.abort.signal.aborted) return;
      run.monitorPage = await this.deps.connect(endpoint);
      if (run.abort.signal.aborted || this.run !== run) return;
      const verified = await run.monitorPage.call('Runtime.evaluate', { expression: SESSION_CHECK, awaitPromise: true, returnByValue: true });
      authenticated = verified.result?.value === true;
    } catch { /* During interactive navigation the page may be replaced; next bounded check retries. */ }
    finally { run.monitorPage?.close(); run.monitorPage = null; run.monitorBusy = false; }
    if (authenticated && this.run === run && !run.abort.signal.aborted && this.state.status === 'waiting' && !this.operation) {
      run.autoPaused = true;
      await this.finish();
    }
  }

  async importLogin(run) {
    let page;
    let saved = [];
    let imported = [];
    let touched = false;
    try {
      const targets = await run.browser.call('Target.getTargets');
      const target = targets.targetInfos.find((item) => item.type === 'page' && isChatPage(item.url));
      if (!target) throw new LoginError('请先在登录窗口完成登录，并回到 ChatGPT 聊天页面。');
      const response = await this.deps.fetch(`http://127.0.0.1:${run.port}/json/list`, { signal: AbortSignal.timeout(3000) });
      const pages = await response.json();
      const endpoint = pages.find((item) => item.id === target.targetId)?.webSocketDebuggerUrl;
      if (!endpoint || new URL(endpoint).port !== String(run.port)) throw new LoginError('登录窗口连接已失效，请重新打开。');
      page = await this.deps.connect(endpoint);
      const verified = await page.call('Runtime.evaluate', { expression: SESSION_CHECK, awaitPromise: true, returnByValue: true });
      if (verified.result?.value !== true) throw new LoginError('浏览器尚未完成 ChatGPT 登录。请在浏览器登录成功后再点击返回。');
      // Read only first-party ChatGPT cookies; Google/other browser accounts are not exported.
      const result = await page.call('Network.getCookies', { urls: [CHAT_HOME, 'https://www.chatgpt.com/', 'https://chatgpt.com/api/auth/session'] });
      imported = result.cookies.map(portableCookie).filter(Boolean);
      if (!imported.length) throw new LoginError('没有取得 ChatGPT 登录状态，请重新登录。');
      const current = await this.session.cookies.get({ domain: 'chatgpt.com' });
      saved = current.map(portableCookie).filter(Boolean);
      if (run.abort.signal.aborted) throw new LoginError('登录已取消。');
      touched = true;
      // Replace only our selected domain's portable cookies, preserving all other sessions.
      for (const cookie of saved) await this.session.cookies.remove(cookie.url, cookie.name);
      for (const cookie of imported) await this.session.cookies.set(cookie);
      await this.session.cookies.flushStore();
      if (run.abort.signal.aborted || !await this.verify()) throw new LoginError('内置页面登录验证未通过，已恢复原登录。独立浏览器仍保留，可以重试或先在那里继续使用。');
      if (run.abort.signal.aborted) throw new LoginError('登录已取消。');
      await this.cleanup(run);
      return this.update('success', '登录已验证并同步，可以在助手内继续使用 ChatGPT。');
    } catch (error) {
      if (touched) {
        try {
          for (const cookie of imported) await this.session.cookies.remove(cookie.url, cookie.name);
          for (const cookie of saved) await this.session.cookies.set(cookie);
          await this.session.cookies.flushStore();
        } catch {
          return this.update('error', '同步失败且原登录恢复不完整。请取消后重新登录；本地工具与工作区数据未改动。');
        }
      }
      // Keep native window available on recoverable errors so users can finish login.
      if (!touched && !run.abort.signal.aborted) run.autoPaused = false;
      return this.update('waiting', userError(error));
    } finally { page?.close(); }
  }

  cancel(message = '登录已取消，未同步的浏览器登录数据将清理。', attention = false) {
    if (this.cancelling) return this.cancelling;
    this.cancelling = this.cancelRun(message, attention).finally(() => { this.cancelling = null; });
    return this.cancelling;
  }

  async cancelRun(message, attention) {
    const run = this.run;
    if (!run) return this.update('idle', message);
    run.abort.abort();
    this.update('closing', '正在关闭独立登录窗口…');
    await this.operation?.catch(() => {});
    await this.cleanup(run);
    return this.update(attention || this.state.cleanupWarning ? 'error' : 'idle', message);
  }

  async cleanup(run) {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async () => {
      clearTimeout(run.expiry);
      clearInterval(run.autoWatch);
      run.monitorPage?.close();
      if (run.browser && !run.exited) await run.browser.call('Browser.close', {}, 1500).catch(() => {});
      run.browser?.close();
      if (run.child && !run.exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          run.child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        if (!run.exited) {
          await this.deps.terminateOwnedChild(run.child); // Exact owned PID/tree, never all Chrome processes.
          if (!run.exited) await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1500);
            run.child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
      }
      // Never recursively remove a computed/broad path or a still-running profile.
      const profile = run.profile && path.resolve(run.profile);
      if (profile && path.dirname(profile) === this.root && path.basename(profile).startsWith('login-') && (!run.child || run.exited)) {
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {
          this.state.cleanupWarning = '临时登录目录仍被占用，未能完全清理；请关闭独立登录窗口后在助手数据目录中清理 native-login 下的临时目录。';
        });
      } else if (profile) {
        this.state.cleanupWarning = '独立登录进程尚未完全退出，临时登录目录暂未删除。请关闭登录窗口后清理助手数据目录中的 native-login 临时目录。';
      }
      if (this.run === run) this.run = null;
    })();
    return run.cleanup;
  }
}

module.exports = { NativeLoginService, LoginCdp, findBrowser, portableCookie, isChatPage, SESSION_CHECK };
