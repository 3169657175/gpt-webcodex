const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('chat chrome reserves space for verified live progress and quick workspace access', () => {
  const css = read('renderer/browser.css');
  const html = read('renderer/browser.html');
  const main = read('electron/main.js');
  assert.match(css, /\.browser-toolbar\{[^}]*height:164px/);
  assert.match(main, /toolbarHeight:\s*164/);
  assert.match(html, /id="progressBand"/);
  assert.match(html, /progressPresentation\.js/);
  assert.match(html, /id="addAuthorizedRootQuick"/);
  assert.match(html, /id="addWorkspace"/);
});

test('workspace picker opens a standalone Workspace Center without resizing ChatGPT', () => {
  const browser = read('renderer/browser.js');
  const preload = read('electron/browserPreload.js');
  const main = read('electron/main.js');
  const controller = read('electron/chatViewController.js');
  const workspace = read('renderer/workspace.html');
  assert.match(preload, /openWorkspaceWindow/);
  assert.match(main, /function openWorkspaceWindow\(\)/);
  assert.match(browser, /openWorkspaceWindow/);
  assert.match(workspace, /id="workspaceList"/);
  assert.doesNotMatch(controller, /WORKSPACE_PANEL_TOP_INSET|workspacePanelOpen|setWorkspacePanelOpen/);
  assert.doesNotMatch(main, /chat:workspace-panel/);
});

test('embedded ChatGPT tool-call folding is optional and reversible', () => {
  const controller = read('electron/chatViewController.js');
  const config = read('electron/services/config.js');
  const manager = read('renderer/index.html');
  const main = read('electron/main.js');
  assert.match(controller, /scheduleChatUiEnhancements/);
  assert.match(controller, /scheduleToolCallCompaction/);
  assert.match(controller, /mcp-tool-call-hidden|mcp-tool-call-summary|mcp-chat-compact-tools-style/);
  assert.match(controller, /compactHost|__mcpCompactToolObserver|__mcpCompactToolTimer/);
  assert.match(controller, /已调用工具/);
  assert.match(config, /compactToolCalls:\s*true/);
  assert.match(manager, /id="toolCallFoldingToggle"/);
  assert.match(main, /'compactToolCalls'/);
});

test('Workspace Center owns authorized-root management instead of duplicating it in Manager', () => {
  const manager = read('renderer/index.html');
  const workspace = read('renderer/workspace.html');
  const workspaceJs = read('renderer/workspace.js');
  assert.doesNotMatch(manager, /authorizedRootsList|addAuthorizedRoot|操作权限策略/);
  assert.match(workspace, /id="authorizeRootInline"/);
  assert.match(workspaceJs, /chooseAuthorizedRoot/);
});

test('Workspace Center separates workspaces and authorized roots into secondary tabs', () => {
  const html = read('renderer/workspace.html');
  const js = read('renderer/workspace.js');
  const css = read('renderer/workspace.css');
  assert.match(html, /data-workspace-tab="workspaces"/);
  assert.match(html, /data-workspace-tab="authorized"/);
  assert.match(html, /data-workspace-view="workspaces"/);
  assert.match(html, /data-workspace-view="authorized" hidden/);
  assert.match(js, /function switchWorkspaceView\(view, options = \{\}\)/);
  assert.match(js, /panel\.hidden = !active/);
  assert.match(css, /\.content-frame\{[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css, /\.workspace-list,.authorized-list\{[^}]*overflow:auto/);
});

test('package and Manager identify the 0.5.7 stability release', () => {
  const pkg = JSON.parse(read('package.json'));
  const manager = read('renderer/index.html');
  assert.equal(pkg.version, '0.5.7');
  assert.match(manager, /v0\.5\.7|0\.5\.7/);
  assert.match(manager, /data-page="status"/);
  assert.match(manager, /data-page="workspace"/);
  assert.doesNotMatch(manager, /data-page="task"|data-page="build"|data-page="guide"/);
});

test('Manager exposes four necessary product entries without restoring old consoles', () => {
  const html = read('renderer/index.html');
  const css = read('renderer/manager-v2.css');
  assert.match(html, /manager-v2\.css/);
  for (const page of ['status','workspace','memory','settings']) assert.match(html, new RegExp('data-page="' + page + '"'));
  for (const page of ['overview','deploy','task','support','build','health','logs','guide','diagnostics']) assert.doesNotMatch(html, new RegExp('data-page="' + page + '"'));
  assert.match(css, /\.service-grid/);
  assert.match(css, /\.stage-list/);
});

test('continuous MCP observation is fixed on and no longer user-configurable', () => {
  const html = read('renderer/index.html');
  const config = read('electron/services/config.js');
  const controller = read('electron/chatViewController.js');
  const main = read('electron/main.js');
  assert.match(config, /continuousMcpMode:\s*true/);
  assert.match(config, /merged\.continuousMcpMode = true/);
  assert.match(controller, /scheduleContinuousMcpMode/);
  assert.doesNotMatch(html, /continuousMcpModeToggle|连续 MCP 兼容监测/);
  assert.doesNotMatch(main, /'continuousMcpMode'/);
});

test('memory page has no manual new-candidate form in the normal workflow', () => {
  const html = read('renderer/index.html');
  assert.match(html, /data-page-view="memory"/);
  assert.match(html, /id="memoryCandidatePanel" hidden/);
  assert.match(html, /id="memoryList"/);
  assert.doesNotMatch(html, /memoryNewTitle|memoryNewContent|memoryPropose|memory-create-actions/);
});
