const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('task console IPC channels and preload bindings are configured', () => {
  const main = read('electron/main.js');
  const preload = read('electron/browserPreload.js');

  // Verify IPC channels in main.js
  assert.match(main, /secureHandle\('task:read-console'/);
  assert.match(main, /secureHandle\('task:kill-active-command'/);
  assert.match(main, /mcpLogFile\(\)/);

  // Verify preload methods
  assert.match(preload, /readTaskConsole:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('task:read-console'\)/);
  assert.match(preload, /killActiveCommand:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('task:kill-active-command'\)/);
});

test('task console UI elements and styles maintain 112px toolbar layout', () => {
  const browserHtml = read('renderer/browser.html');
  const browserCss = read('renderer/browser.css');
  const browserJs = read('renderer/browser.js');

  // Verify UI buttons and drawer
  assert.match(browserHtml, /id="openTerminalButton"/);
  assert.match(browserHtml, /id="taskConsoleDrawer"/);
  assert.match(browserHtml, /id="consoleActiveCommand"/);
  assert.match(browserHtml, /id="consoleOutput"/);
  assert.match(browserHtml, /id="killConsoleBtn"/);

  // Verify CSS styles
  assert.match(browserCss, /\.task-console-drawer\{[^}]*position:fixed;bottom:0/);
  assert.match(browserCss, /\.task-strip \.terminal-toggle-btn/);

  // Verify top toolbar 112px invariance
  assert.match(browserCss, /\.browser-toolbar\{[^}]*height:112px/);

  // Verify JavaScript handler and toggle logic
  assert.match(browserJs, /refreshTaskConsole/);
  assert.match(browserJs, /toggleTaskConsole/);
  assert.match(browserJs, /#openTerminalButton/);
  assert.match(browserJs, /#killConsoleBtn/);
});
