const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { NativeLoginService, LoginCdp, portableCookie, isChatPage, SESSION_CHECK } = require('../electron/services/nativeLoginService');

const cookie = (value, extra = {}) => ({ name: '__Secure-next-auth.session-token', value, domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, session: true, sameSite: 'Lax', ...extra });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-login-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  const states = [];
  const calls = [];
  const imported = [];
  const removed = [];
  let launches = 0;
  const oldCookies = [cookie('old-secret'), cookie('google-secret', { domain: '.google.com' })];
  const browser = {
    call: async (method) => {
      calls.push(method);
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'page1', url: options.url || 'https://chatgpt.com/' }] };
      if (method === 'Browser.close') { child.emit('exit', 0); return {}; }
    }, close: () => {}
  };
  const page = {
    call: async (method, params) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return { result: { value: options.loggedIn !== false } };
      if (method === 'Network.getCookies') {
        assert.deepEqual(params.urls, ['https://chatgpt.com/', 'https://www.chatgpt.com/', 'https://chatgpt.com/api/auth/session']);
        return { cookies: [cookie('new-secret'), cookie('google-secret', { domain: '.google.com' }), cookie('waf-secret', { name: 'cf_clearance' })] };
      }
    }, close: () => {}
  };
  const service = new NativeLoginService({
    root,
    session: { cookies: {
      get: async (filter) => { assert.deepEqual(filter, { domain: 'chatgpt.com' }); return oldCookies; },
      remove: async (url, name) => removed.push({ url, name }),
      set: async (value) => {
        imported.push(value);
        if (options.setFails && value.value === 'new-secret') throw new Error('storage rejected new-secret');
        if (options.restoreFails && value.value === 'old-secret') throw new Error('storage rejected old-secret');
      }, flushStore: async () => {}
    } },
    verify: options.verify || (async () => options.verifyFails !== true),
    onState: (state) => states.push(state),
    settings: () => options.settings || {},
    dependencies: {
      findBrowser: async () => ({ name: 'Chrome', executable: 'chrome.exe' }),
      reservePort: async () => 43123,
      spawn: (_exe, args) => { launches++; calls.push(args); return child; },
      fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/json/list')
        ? [{ id: 'page1', webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/page1' }]
        : { webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/owned' } }),
      connect: async (url) => url.includes('/page/') ? page : browser
    }
  });
  t.after(() => service.cancel());
  return { service, root, calls, states, imported, removed, child, launches: () => launches };
}

test('native login uses a new isolated profile, manual browser and loopback nonzero port', async (t) => {
  const f = await fixture(t);
  const first = f.service.start();
  await f.service.start();
  assert.equal((await first).status, 'waiting');
  assert.equal(f.launches(), 1);
  const args = f.calls.find(Array.isArray);
  assert.ok(args.some((value) => value.startsWith(`--user-data-dir=${f.root}${path.sep}login-`)));
  assert.ok(args.includes('--remote-debugging-port=43123'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.doesNotMatch(args.join(' '), /enable-automation|headless|no-sandbox|disable-web-security|Default|Profile 1/);
  assert.equal(args.at(-1), 'https://chatgpt.com/');
});

test('verified import copies only ChatGPT cookies and cleans the owned browser/profile', async (t) => {
  const f = await fixture(t);
  await f.service.start();
  const profile = f.service.run.profile;
  assert.equal((await f.service.finish()).status, 'success');
  assert.deepEqual(f.imported.map((c) => c.value), ['new-secret']);
  assert.ok(f.removed.every((c) => c.url.startsWith('https://chatgpt.com/')));
  assert.ok(f.calls.includes('Browser.close'));
  assert.equal(f.service.run, null);
  await assert.rejects(fs.access(profile));
  assert.doesNotMatch(JSON.stringify(f.states), /new-secret|old-secret|google-secret|waf-secret|webSocketDebuggerUrl/);
});

test('unfinished Google login never reads or changes cookies', async (t) => {
  const f = await fixture(t, { loggedIn: false });
  await f.service.start();
  const result = await f.service.finish();
  assert.equal(result.status, 'waiting');
  assert.match(result.message, /尚未完成/);
  assert.equal(f.imported.length, 0);
  assert.equal(f.removed.length, 0);
  assert.ok(!f.calls.includes('Network.getCookies'));
});

test('non-ChatGPT page cannot be used for session verification or export', async (t) => {
  const f = await fixture(t, { url: 'https://accounts.google.com/' });
  await f.service.start();
  assert.equal((await f.service.finish()).status, 'waiting');
  assert.ok(!f.calls.includes('Runtime.evaluate'));
  assert.equal(f.imported.length, 0);
  assert.equal(isChatPage('https://chatgpt.com.evil.test/'), false);
  assert.equal(isChatPage('http://chatgpt.com/'), false);
  assert.match(SESSION_CHECK, /location\.hostname/);
});

test('rollback storage failure stays actionable with active flag and cancellation', async (t) => {
  const f = await fixture(t, { setFails: true, restoreFails: true });
  await f.service.start();
  const result = await f.service.finish();
  assert.equal(result.status, 'error');
  assert.equal(result.active, true);
  assert.match(result.message, /恢复不完整/);
  assert.doesNotMatch(JSON.stringify(f.states), /old-secret|new-secret/);
  await f.service.cancel();
  assert.equal(f.service.getState().active, false);
});

for (const options of [{ verifyFails: true }, { setFails: true }]) {
  test(`failed import restores previous session, keeps native browser open, and hides secrets: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    await f.service.start();
    const result = await f.service.finish();
    assert.equal(result.status, 'waiting');
    assert.equal(f.imported.at(-1).value, 'old-secret');
    assert.ok(!f.calls.includes('Browser.close'));
    assert.ok(f.service.run);
    assert.doesNotMatch(JSON.stringify(f.states), /new-secret|old-secret/);
  });
}

test('cancel during verification rolls back, closes only the owned browser, and settles idle', async (t) => {
  let release;
  let entered;
  const inVerify = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { verify: () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  await f.service.start();
  const finishing = f.service.finish();
  await inVerify;
  const cancelling = f.service.cancel();
  release(true);
  await finishing;
  assert.equal((await cancelling).status, 'idle');
  assert.equal(f.imported.at(-1).value, 'old-secret');
  assert.equal(f.service.run, null);
});

test('cookie conversion preserves host-only/security/SameSite and rejects foreign/partitioned/WAF cookies', () => {
  const converted = portableCookie(cookie('x', { domain: 'chatgpt.com', session: false, expires: Date.now() / 1000 + 3600, sameSite: 'None' }));
  assert.equal(converted.domain, undefined);
  assert.equal(converted.sameSite, 'no_restriction');
  assert.equal(converted.secure, true);
  assert.equal(converted.httpOnly, true);
  assert.ok(converted.expirationDate > Date.now() / 1000);
  assert.equal(portableCookie(cookie('x', { domain: '.google.com' })), null);
  assert.equal(portableCookie(cookie('x', { domain: '.evil.chatgpt.com' })), null);
  assert.equal(portableCookie(cookie('x', { partitionKey: { topLevelSite: 'https://chatgpt.com' } })), null);
  assert.equal(portableCookie(cookie('x', { expires: 1 })), null);
  assert.equal(portableCookie(cookie('x', { name: 'cf_clearance' })), null);
  for (const sameSite of ['lax', 'strict', 'no_restriction', 'unspecified']) {
    assert.equal(portableCookie(cookie('x', { sameSite })).sameSite, sameSite);
  }
  assert.equal(portableCookie(cookie('x', { expirationDate: 1 })), null);
});

test('native browser proxy follows explicit manual/direct settings', async (t) => {
  for (const settings of [{ proxyMode: 'manual', proxyUrl: '127.0.0.1:7890' }, { proxyMode: 'direct' }]) {
    const f = await fixture(t, { settings });
    await f.service.start();
    const args = f.calls.find(Array.isArray);
    assert.ok(args.includes(settings.proxyMode === 'direct' ? '--no-proxy-server' : '--proxy-server=http://127.0.0.1:7890'));
    await f.service.cancel();
  }
});

test('credentialed proxy is rejected before any browser launch', async (t) => {
  const f = await fixture(t, { settings: { proxyMode: 'manual', proxyUrl: 'http://user:password@127.0.0.1:7890' } });
  assert.equal((await f.service.start()).status, 'error');
  assert.equal(f.launches(), 0);
  assert.doesNotMatch(JSON.stringify(f.states), /password/);
  assert.equal(f.service.run, null);
});

test('closing the native browser produces a visible recovery state and cleans temporary data', async (t) => {
  const f = await fixture(t);
  await f.service.start();
  const profile = f.service.run.profile;
  f.child.emit('exit', 0);
  await f.service.cancelling;
  assert.equal(f.service.state.status, 'error');
  assert.match(f.service.state.message, /窗口已关闭/);
  assert.equal(f.service.run, null);
  await assert.rejects(fs.access(profile));
});

test('concurrent cancellations are single-flight and cannot start a new login during rollback', async (t) => {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const f = await fixture(t, { verify: () => { enter(); return new Promise((resolve) => { release = resolve; }); } });
  await f.service.start();
  const finishing = f.service.finish();
  await entered;
  const cancelling = f.service.cancel();
  assert.equal(f.service.cancel(), cancelling);
  assert.equal((await f.service.start()).status, 'closing');
  assert.equal(f.launches(), 1);
  release(false);
  await finishing;
  await cancelling;
  assert.equal(f.service.state.status, 'idle');
});

test('CDP requests time out and pending requests settle when disconnected', async () => {
  class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; }
    send() {}
    close() { this.readyState = 3; }
  }
  const socket = new FakeSocket();
  const cdp = new LoginCdp(socket);
  await assert.rejects(cdp.call('Target.getTargets', {}, 5), /超时/);
  assert.equal(cdp.pending.size, 0);
  const request = cdp.call('Target.getTargets');
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(request, /断开/);
  assert.equal(cdp.pending.size, 0);
});

test('CDP refuses remote and non-websocket endpoints', () => {
  assert.throws(() => LoginCdp.connect('ws://evil.test:43123/devtools/browser/x'));
  assert.throws(() => LoginCdp.connect('wss://127.0.0.1:43123/devtools/browser/x'));
});

test('login controls use trusted IPC, remain visible and do not restart Runtime', async () => {
  const read = (name) => fs.readFile(path.join(__dirname, '..', name), 'utf8');
  const main = await read('electron/main.js');
  const html = await read('renderer/browser.html');
  const renderer = await read('renderer/browser.js');
  const preload = await read('electron/browserPreload.js');
  for (const action of ['start', 'finish', 'cancel']) {
    assert.match(main, new RegExp(`secureHandle\\('chat:native-login-${action}'`));
    assert.ok(preload.includes(`chat:native-login-${action}`));
  }
  assert.match(html, /id="nativeLoginButton"/);
  assert.match(html, /登录完成，返回助手/);
  assert.match(renderer, /nativeLoginState\.status === 'idle' && taskRefreshWarning/);
});
