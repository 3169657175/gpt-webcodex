const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.7.3 manager uses one navigation language and compact sidebar health summary', () => {
  const pkg = JSON.parse(read('package.json'));
  const html = read('renderer/index.html');
  const css = read('renderer/manager-v2.css');

  assert.equal(pkg.version, '0.8.1');
  assert.match(html, /class="nav-item" data-page="setup-guide"/);
  assert.doesNotMatch(html, /class="nav-subitem"/);
  assert.match(html, /class="sidebar-health"/);
  assert.match(html, /外观与行为/);
  assert.match(html, /连接与运行/);
  assert.match(html, /诊断与维护/);
  assert.match(css, /0\.7\.2 management center/);
  assert.match(css, /\.sidebar-health\{/);
  assert.match(css, /\.settings-grid\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('0.7.3 treats first attachment observation as informational when the upstream chain is ready', () => {
  const app = read('renderer/app.js');
  const controller = read('electron/chatViewController.js');
  const doctor = read('electron/services/doctorService.js');

  assert.match(app, /function attachmentHealth\(attachment = \{\}, upstreamReady = false\)/);
  assert.match(app, /firstUsePending = detail === 'waiting-first-attachment'/);
  assert.match(app, /firstUsePending && upstreamReady/);
  assert.match(app, /服务已就绪，启动链路已按实时状态校验完成/);
  assert.match(app, /setStartupStage\('chat', 'done'/);
  assert.match(app, /value\.status === 'running' \? '•' : '○'/);

  assert.match(controller, /'waiting-first-attachment', 'available'\)/);
  assert.doesNotMatch(controller, /'waiting-first-attachment', capabilitySeen\(\) \? 'available' : 'unknown'/);
  assert.match(doctor, /\['attached', 'available'\]\.includes\(attachmentStatus\)/);
});

test('0.7.3 keeps Desktop and bundled Runtime versions aligned', () => {
  const pkg = JSON.parse(read('package.json'));
  const runtimeInit = read('resources/coding-tools-mcp/coding_tools_mcp/__init__.py');
  const pyproject = read('resources/coding-tools-mcp/pyproject.toml');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));

  assert.equal(pkg.version, '0.8.1');
  assert.ok(runtimeInit.includes(`__version__ = "${pkg.version}"`));
  assert.ok(pyproject.includes(`version = "${pkg.version}"`));
  assert.equal(contract.runtime_version, pkg.version);
});

test('0.7.3 keeps the tutorial Tunnel ID private by default', () => {
  const app = read('renderer/app.js');
  assert.match(app, /function maskTunnelId\(value\)/);
  assert.match(app, /已保存（ID 已脱敏）/);
  assert.match(app, /setupTunnelEcho'\)\.textContent = tunnelDisplay/);
  assert.doesNotMatch(app, /setupTunnelEcho'\)\.textContent = settings\.tunnelId/);
  assert.doesNotMatch(app, /setupTunnelIdInput'\)\.value = settings\.tunnelId/);
});
