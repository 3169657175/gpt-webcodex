const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.7.6 setup guide follows the real first-run dependency order', () => {
  const html = read('renderer/index.html');
  const order = [
    'id="setupStepPlatform"',
    'id="setupStepWorkspace"',
    'id="setupStepServices"',
    'id="setupStepDeveloper"',
    'id="setupStepApp"'
  ].map((marker) => html.indexOf(marker));

  assert.ok(order.every((index) => index >= 0), 'all five setup stages must exist');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'setup stages must appear in dependency order');
  assert.match(html, /id="setupOpenWorkspace"/);
  assert.match(html, /id="setupStartServices"/);
  assert.match(html, /必须先启动服务，再去 ChatGPT 创建 MCP 应用/);
});

test('0.7.6 setup guide blocks service startup until secrets and workspace are ready', () => {
  const app = read('renderer/app.js');
  assert.match(app, /const workspaceReady = Boolean\(settings\.workspace\)/);
  assert.match(app, /const prerequisitesReady = configured && workspaceReady/);
  assert.match(app, /setupStartServices'\)\.disabled = !prerequisitesReady/);
  assert.match(app, /请先完成第 1 步/);
  assert.match(app, /请先设置工作区/);
  assert.match(app, /setupOpenWorkspace'\)\.onclick = \(\) => api\.openWorkspaceWindow\(\)/);
});

test('0.7.6 manager refreshes tutorial state immediately after workspace changes', () => {
  const preload = read('electron/preload.js');
  const main = read('electron/main.js');
  const app = read('renderer/app.js');
  assert.match(preload, /onWorkspaceChanged/);
  assert.match(preload, /ipcRenderer\.on\('workspace:changed'/);
  assert.match(main, /managerWindow\.webContents\.send\('workspace:changed', hub\)/);
  assert.match(app, /api\.onWorkspaceChanged\?\.\(async \(\) =>/);
});

test('0.7.7 keeps Desktop and bundled Runtime versions aligned', () => {
  const pkg = JSON.parse(read('package.json'));
  const runtimeInit = read('resources/coding-tools-mcp/coding_tools_mcp/__init__.py');
  const pyproject = read('resources/coding-tools-mcp/pyproject.toml');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
  assert.equal(pkg.version, '0.8.1');
  assert.ok(runtimeInit.includes('__version__ = "0.8.1"'));
  assert.ok(pyproject.includes('version = "0.8.1"'));
  assert.equal(contract.runtime_version, '0.8.1');
});
