const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.2.4 keeps the top chrome height unchanged and exposes quick authorized-root access', () => {
  const browserCss = read('renderer/browser.css');
  const browserHtml = read('renderer/browser.html');
  const main = read('electron/main.js');
  assert.match(browserCss, /\.browser-toolbar\{[^}]*height:112px/);
  assert.match(main, /toolbarHeight:\s*112/);
  assert.match(browserCss, /\.workspace-health-popover\{position:absolute/);
  assert.match(browserHtml, /id="workspaceHealthPopover"/);
  assert.match(browserHtml, /id="addAuthorizedRootQuick"/);
  assert.match(browserHtml, /id="addWorkspace"/);
});

test('embedded ChatGPT compacts repeated tool call records without deleting their content', () => {
  const controller = read('electron/chatViewController.js');
  assert.match(controller, /scheduleChatUiEnhancements/);
  assert.match(controller, /suspendChatUiEnhancements/);
  assert.match(controller, /mcp-tool-call-hidden/);
  assert.match(controller, /工具 ×/);
  assert.match(controller, /data-testid\^=\\?"conversation-turn-/);
  assert.match(controller, /MutationObserver/);
  assert.match(controller, /scheduleStableRefresh\(1800\)/);
  assert.match(controller, /document\.querySelector\('main'\) \|\| document\.body/);
  assert.doesNotMatch(controller, /observe\(document\.documentElement/);
  assert.doesNotMatch(controller, /scheduleAttachmentCapture/);
  assert.doesNotMatch(controller, /mcpAutoSaved/);
  assert.doesNotMatch(controller, /__mcpAttachmentObserver/);
});

test('workspace manager exposes extra authorized roots without changing the chat top bar', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.match(html, /id="authorizedRootsList"/);
  assert.match(html, /id="addAuthorizedRoot"/);
  assert.match(app, /updateAuthorizedRoots/);
});

test('package and manager identify the 0.4.4 release', () => {
  const pkg = JSON.parse(read('package.json'));
  const manager = read('renderer/index.html');
  assert.equal(pkg.version, '0.4.4');
  assert.match(manager, /网页 MCP 助手 <span>v0\.4\.4<\/span>/);
  assert.match(manager, /本地工具引擎 · 0\.4\.9/);
});

test('settings window hides independently and reveals its shell before runtime inspection finishes', () => {
  const main = read('electron/main.js');
  const app = read('renderer/app.js');
  const compact = read('renderer/settings-compact.css');
  assert.doesNotMatch(main, /parent:\s*chatWindow/);
  assert.match(main, /managerWindow\.hide\(\)/);
  assert.match(main, /chatWindow\.show\(\)/);
  assert.match(app, /Show the settings shell immediately/);
  assert.match(compact, /grid-template-columns:220px/);
  assert.match(compact, /\.settings-section \.setting-row\{display:flex;min-height:74px/);
});

