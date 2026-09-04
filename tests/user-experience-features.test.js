const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('workspace quick actions and show item IPC are configured', () => {
  const main = read('electron/main.js');
  const preload = read('electron/browserPreload.js');

  // Verify IPC channels
  assert.match(main, /secureHandle\('workspace:open-in-explorer'/);
  assert.match(main, /secureHandle\('workspace:open-in-editor'/);
  assert.match(main, /secureHandle\('workspace:show-in-folder'/);

  // Verify Preload exposure
  assert.match(preload, /openWorkspaceInExplorer/);
  assert.match(preload, /openWorkspaceInEditor/);
  assert.match(preload, /showInFolder/);
});

test('task modified files tree and completion audio are wired into the browser UI', () => {
  const html = read('renderer/browser.html');
  const css = read('renderer/browser.css');
  const js = read('renderer/browser.js');

  // Verify HTML elements
  assert.match(html, /id="openInExplorerBtn"/);
  assert.match(html, /id="openInEditorBtn"/);
  assert.match(html, /id="taskChangesBtn"/);
  assert.match(html, /id="consoleTabLogs"/);
  assert.match(html, /id="consoleTabFiles"/);
  assert.match(html, /id="consoleFilesList"/);

  // Verify CSS styles
  assert.match(css, /\.workspace-quick-tools/);
  assert.match(css, /\.console-tabs/);
  assert.match(css, /\.console-files-view/);
  assert.match(css, /\.browser-toolbar\{[^}]*height:112px/);

  // Verify JS logic
  assert.match(js, /playTaskCompletionSound/);
  assert.match(js, /renderModifiedFilesList/);
  assert.match(js, /switchConsoleTab/);
});
