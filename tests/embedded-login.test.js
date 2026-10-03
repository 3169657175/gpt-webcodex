const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { ChatViewController } = require('../electron/chatViewController');
const { authUrl, authenticatedSession, readAuthenticatedSession, LOGIN_DOCUMENT_PROBE } = require('../electron/services/chatLoginPolicy');

const response = (data) => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data });
class Contents extends EventEmitter {
  constructor(url = 'https://chatgpt.com/') {
    super(); this.url = url; this.destroyed = false; this.ui = { kind: '', composer: true };
    this.session = { fetch: async () => response({ user: { id: 'synthetic' } }) };
  }
  getURL() { return this.url; } getTitle() { return 'Synthetic'; }
  isDestroyed() { return this.destroyed; } canGoBack() { return false; } canGoForward() { return false; }
  setWindowOpenHandler(handler) { this.popup = handler; } setBackgroundThrottling() {}
  executeJavaScript() { return Promise.resolve(this.ui); }
  async loadURL(url) { this.url = url; }
  focus() { this.focused = true; } stop() { this.stopped = true; }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class View {
  constructor(contents) { this.webContents = contents; this.visible = true; }
  setVisible(value) { this.visible = value; } setBounds(value) { this.bounds = value; }
}
function fixture(t) {
  const options = [], views = [], states = [];
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, getContentSize: () => [1360, 900], contentView: {
    addChildView: (view) => views.push(view), removeChildView: (view) => { const i = views.indexOf(view); if (i >= 0) views.splice(i, 1); }
  } });
  const controller = new ChatViewController({ window, log: { info() {}, warn() {} }, settings: { load: () => ({}) },
    toolbarHeight: 164, onState: (state) => states.push(state), createWebContentsView: (option) => {
      options.push(option); return new View(option.webContents || new Contents());
    }
  });
  controller.view = new View(new Contents());
  t.after(() => controller.dispose());
  return { controller, options, views, states };
}

test('authentication requires account evidence, rejects errors/expiry, not an access-token field', () => {
  assert.equal(authenticatedSession({ user: { id: 'test' } }), true);
  for (const value of [{}, { user: {} }, { user: [] }, { user: { id: 'test' }, error: 'expired' },
    { user: { id: 'test' }, expires: 'bad' }, { user: { id: 'test' }, expires: '2000-01-01' }]) assert.equal(authenticatedSession(value), false);
  assert.equal(authUrl('https://accounts.google.com/signin'), true);
  assert.equal(authUrl('https://chatgpt.com/api/auth/callback/google?code=secret'), true);
  assert.equal(authUrl('https://accounts.google.com.evil.test/'), false);
  assert.equal(authUrl('http://accounts.google.com/'), false);
});

test('session proof is first-party native fetch, JSON-only and does not follow OAuth redirects', async () => {
  assert.equal(await readAuthenticatedSession(async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/api/auth/session');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'include');
    return response({ user: { id: 'test' } });
  }), true);
  assert.equal(await readAuthenticatedSession(async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) })), false);
  assert.equal(await readAuthenticatedSession(async () => { throw new Error('network'); }), false);
});

test('visible Google entry/refusal is detected without reading any input or chat message', () => {
  const node = (label) => ({ isConnected: true, textContent: label, getAttribute: () => '', getBoundingClientRect: () => ({ width: 100, height: 40 }) });
  const run = (host, path, headings, text, buttons) => vm.runInNewContext(LOGIN_DOCUMENT_PROBE, {
    location: { hostname: host, pathname: path, protocol: 'https:' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { body: { innerText: text }, querySelectorAll: (selector) => {
      if (selector.startsWith('h1')) return headings.map(node);
      if (selector.startsWith('button')) return buttons.map(node);
      assert.ok(!/input|message/.test(selector)); return [];
    } }
  });
  assert.equal(run('auth.openai.com', '/login', [], '', ['Continue with Google']).kind, 'entry');
  assert.equal(run('accounts.google.com', '/signin', ['无法登录'], '此浏览器或应用可能不安全', []).kind, 'blocked');
  assert.equal(run('chatgpt.com', '/c/test', [], '无法登录 此浏览器或应用可能不安全', []).kind, '');
});

test('OAuth child is adopted intact and nested popups retain their opener instead of being denied', (t) => {
  const f = fixture(t), child = new Contents('https://auth.openai.com/login');
  const view = f.controller.createEmbeddedAuthView({ webContents: child });
  assert.equal(view.webContents, child); assert.deepEqual(f.options[0], { webContents: child });
  const nested = child.popup({ url: 'https://accounts.google.com/signin' });
  assert.equal(nested.action, 'allow');
  assert.equal(nested.overrideBrowserWindowOptions.webPreferences.partition, 'persist:chatgpt-session');
  assert.equal(nested.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  const grandchild = new Contents('https://accounts.google.com/signin');
  assert.equal(nested.createWindow({ webContents: grandchild }), grandchild);
  assert.equal(child.isDestroyed(), false);
  assert.equal(f.controller.authViews.length, 2);
  assert.equal(view.visible, false);
  assert.equal(child.popup({ url: 'https://evil.test/' }).action, 'deny');
});

test('embedded auth overlays ChatGPT without exposing the shell loading placeholder', (t) => {
  const f = fixture(t), mainView = f.controller.view;
  const child = new Contents('https://auth.openai.com/login');
  const authView = f.controller.createEmbeddedAuthView({ webContents: child });
  assert.equal(mainView.visible, true);
  assert.equal(authView.visible, true);
  assert.equal(f.controller.activeContents(), child);
});

test('destroyed stale auth views cannot hide ChatGPT or become the active contents', (t) => {
  const f = fixture(t), mainView = f.controller.view;
  const child = new Contents('https://auth.openai.com/login');
  const authView = f.controller.createEmbeddedAuthView({ webContents: child });
  child.destroyed = true;
  f.controller.syncLoginVisibility();
  assert.equal(f.controller.authViews.includes(authView), false);
  assert.equal(mainView.visible, true);
  assert.equal(f.controller.activeContents(), mainView.webContents);
});

test('callback URL alone never closes the OAuth child or claims login success', async (t) => {
  const f = fixture(t), child = new Contents('https://chatgpt.com/api/auth/callback/google?code=synthetic');
  child.ui.composer = false;
  f.controller.createEmbeddedAuthView({ webContents: child });
  await f.controller.probeLogin(child);
  assert.equal(child.isDestroyed(), false); assert.equal(f.controller.login.status, 'waiting');
  child.url = 'https://chatgpt.com/'; child.ui.composer = true; child.session.fetch = async () => response({});
  await f.controller.probeLogin(child);
  assert.equal(child.isDestroyed(), false);
});

test('automatic return closes auth only after authenticated session AND primary composer are verified', async (t) => {
  const f = fixture(t), child = new Contents();
  f.controller.createEmbeddedAuthView({ webContents: child });
  f.controller.view.webContents.ui.composer = false;
  await f.controller.probeLogin(child);
  assert.equal(child.isDestroyed(), false); assert.equal(f.controller.login.returning, true);
  f.controller.view.webContents.ui.composer = true;
  await f.controller.probeLogin();
  assert.equal(child.isDestroyed(), true); assert.equal(f.controller.login.status, 'success');
  assert.equal(f.controller.view.visible, true); assert.equal(f.controller.view.webContents.focused, true);
});

test('passive primary-view login detection never covers ChatGPT, while explicit login still may', async (t) => {
  const f = fixture(t), main = f.controller.view.webContents;
  main.ui = { kind: 'entry', composer: false };
  await f.controller.probeLogin(main);
  assert.equal(f.controller.login.prompt, false);
  assert.equal(f.controller.view.visible, true);

  main.url = 'https://chatgpt.com/c/test';
  main.ui = { kind: 'blocked', composer: false };
  await f.controller.probeLogin(main);
  assert.equal(f.controller.login.prompt, false);
  assert.equal(f.controller.view.visible, true);

  f.controller.offerLogin('entry', main, true);
  assert.equal(f.controller.login.prompt, true);
  assert.equal(f.controller.view.visible, false);
});

test('central refusal prompt hides native views, dismissal does not reopen the same prompt', async (t) => {
  const f = fixture(t), child = new Contents('https://accounts.google.com/signin');
  child.ui = { kind: 'blocked', composer: false };
  const view = f.controller.createEmbeddedAuthView({ webContents: child });
  await f.controller.probeLogin(child);
  assert.equal(f.controller.login.prompt, true); assert.equal(view.visible, false); assert.equal(f.controller.view.visible, false);
  f.controller.dismissLogin();
  f.controller.view.webContents.url = 'https://accounts.google.com/signin';
  f.controller.offerLogin('blocked');
  assert.equal(f.controller.login.prompt, false);
  f.controller.offerLogin('blocked', f.controller.view.webContents, true);
  assert.equal(f.controller.login.prompt, true);
});

test('cancel while session validation is pending invalidates late success', async (t) => {
  const f = fixture(t), child = new Contents();
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  child.session.fetch = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  f.controller.createEmbeddedAuthView({ webContents: child });
  const checking = f.controller.probeLogin(child); await started;
  f.controller.dismissLogin(); release(response({ user: { id: 'test' } })); await checking;
  assert.equal(f.controller.login.status, 'idle');
  assert.ok(!f.states.some((state) => state.login.status === 'success'));
});

test('auth failures are visible and callback network errors are not automatically replayed', (t) => {
  const f = fixture(t), child = new Contents('https://auth.openai.com/login');
  f.controller.createEmbeddedAuthView({ webContents: child });
  child.emit('did-fail-load', {}, -101, 'network', child.url, true);
  assert.equal(f.controller.login.kind, 'load-error'); assert.equal(f.controller.login.prompt, true);
  assert.equal(f.controller.scheduleTransientRetry('https://chatgpt.com/api/auth/callback?code=secret', 'ERR_CONNECTION_RESET'), false);
  assert.equal(f.controller.retryTimer, null);
});

test('stuck auth navigation raises a visible timeout prompt and releases its watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), child = new Contents('https://auth.openai.com/login');
  f.controller.createEmbeddedAuthView({ webContents: child });
  child.emit('did-start-loading');
  t.mock.timers.tick(60001);
  assert.equal(child.stopped, true); assert.equal(f.controller.login.kind, 'load-error');
  assert.equal(f.controller.loading, false); assert.equal(f.controller.login.prompt, true);
});

test('auth renderer unresponsiveness produces actionable central guidance', (t) => {
  const f = fixture(t), child = new Contents('https://accounts.google.com/signin');
  f.controller.createEmbeddedAuthView({ webContents: child });
  child.emit('unresponsive');
  assert.equal(f.controller.login.kind, 'load-error'); assert.equal(f.controller.login.prompt, true);
});

test('unresponsive DOM check expires and does not permanently occupy the login checker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), child = new Contents('https://auth.openai.com/login');
  child.executeJavaScript = () => new Promise(() => {});
  f.controller.createEmbeddedAuthView({ webContents: child });
  const checking = f.controller.probeLogin(child); t.mock.timers.tick(6001); await checking;
  assert.equal(f.controller.loginProbe, null);
  child.executeJavaScript = async () => ({ kind: 'blocked', composer: false });
  await f.controller.probeLogin(child); assert.equal(f.controller.login.prompt, true);
});
