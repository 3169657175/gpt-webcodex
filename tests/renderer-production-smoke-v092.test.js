const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('0.9.2 production React bundle does not depend on Node process globals', () => {
  const bundlePath = path.join(root, 'renderer', 'react-dist', 'manager-react.js');
  assert.ok(fs.existsSync(bundlePath), 'run npm run ui:build before this test');
  const source = fs.readFileSync(bundlePath, 'utf8');

  const host = { nodeType: 1 };
  const document = {
    getElementById(id) { return id === 'reactManagerRoot' ? host : null; },
    querySelector() { return null; },
    createElement() { return { style: {}, appendChild() {}, setAttribute() {} }; },
    createTextNode(text) { return { textContent: String(text) }; },
    addEventListener() {},
    removeEventListener() {},
    documentElement: {},
    body: {}
  };
  const window = {
    document,
    __MCP_MANAGER_STATE__: undefined,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); }
  };
  const context = vm.createContext({
    window,
    document,
    globalThis: window,
    self: window,
    navigator: { userAgent: 'Electron smoke test' },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    console
  });

  assert.equal('process' in context, false);
  assert.doesNotMatch(source, /process\.env\.NODE_ENV/);
});
