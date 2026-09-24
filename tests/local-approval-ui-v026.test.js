const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.5.1 removes the permission matrix and approval inbox from Manager', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.doesNotMatch(html, /data-tool-permission|操作权限策略|待本地确认|pathPermissionPatterns|commandPermissionPatterns/);
  assert.doesNotMatch(app, /loadApprovals|approvalDecide|toolPermissions/);
});

test('dangerous local approvals use a dedicated on-demand trusted window', () => {
  const html = read('renderer/approval.html');
  const js = read('renderer/approval.js');
  const preload = read('electron/approvalPreload.js');
  const browser = read('renderer/browser.js');
  const main = read('electron/main.js');
  const runtime = read('resources/coding-tools-mcp/coding_tools_mcp/approval.py');
  assert.match(html, /需要你的确认/);
  assert.match(js, /allow_once/);
  assert.match(js, /allow_project/);
  assert.match(js, /deny/);
  assert.match(preload, /approval:decide/);
  assert.match(main, /approval-window:open/);
  assert.match(browser, /refreshApprovals/);
  assert.match(runtime, /PENDING_TTL_SECONDS/);
  assert.match(runtime, /"delete": "ask"/);
  assert.match(runtime, /"git_write": "ask"/);
  assert.match(runtime, /"system_modify": "ask"/);
  assert.match(runtime, /"command": "allow"/);
});
