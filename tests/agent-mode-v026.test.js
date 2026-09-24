const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const { normalize } = require('../electron/services/config');

test('0.5.1 keeps Agent mode internal instead of exposing a mode switch', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const main = read('electron/main.js');
  assert.doesNotMatch(html, /agentModeSelect|完全控制|问答、规划为只读/);
  assert.doesNotMatch(app, /agentModeSelect|Agent 模式已切换/);
  assert.doesNotMatch(main, /agentModeChanged|agent-mode-changed/);
  assert.equal(normalize({ agentMode: 'full' }).agentMode, 'code');
  assert.equal(normalize({ agentMode: 'ask' }).agentMode, 'code');
});

test('runtime-only restart remains available internally without restarting Tunnel', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const start = orchestrator.indexOf('async restartRuntime(options = {})');
  const end = orchestrator.indexOf('async restartTunnel(options = {})', start);
  assert.ok(start >= 0 && end > start);
  const body = orchestrator.slice(start, end);
  assert.match(body, /this\.native\.stop/);
  assert.match(body, /this\.native\.start/);
  assert.match(body, /probeMcpIdentity/);
  assert.doesNotMatch(body, /this\.tunnel\.(start|stop)/);
});
