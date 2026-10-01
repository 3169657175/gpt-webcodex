const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('0.8.0 exposes heartbeat, process and diagnosis without internal IDs in the default chat strip', () => {
  const html = read('renderer/activity-detail.html');
  const detailJs = read('renderer/activity-detail.js');
  const js = read('renderer/browser.js');
  assert.match(html, /id="facts"/);
  assert.match(html, /id="diagnosis"/);
  assert.match(detailJs, /'heartbeat'/);
  assert.match(detailJs, /'process'/);
  assert.match(js, /waiting_model/);
  assert.match(js, /疑似停滞/);
  assert.match(js, /疑似卡住/);
});

test('0.8.0 runtime publishes progress_due and an old-schema operation fallback', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(server, /TOOL_SCHEMA_VERSION = 12/);
  assert.match(server, /"progress_due": report_due/);
  assert.match(server, /compatibility_fallback_action/);
  assert.match(server, /fallback_action": "operation/);
  assert.match(server, /older chat schemas must use action=operation/);
});

test('0.8.0 completion receipt is an explicit local completion barrier', () => {
  const state = read('resources/coding-tools-mcp/coding_tools_mcp/task_state.py');
  for (const field of ['local_command_settled', 'verification_settled', 'workflow_settled', 'handoff_state']) assert.match(state, new RegExp(field));
});

test('0.8.0 waiting-model no longer counts as a runtime-blocked local task', () => {
  const notifications = read('electron/services/taskNotificationService.js');
  const fn = notifications.slice(notifications.indexOf('function taskCanBeBlockedByRuntime'), notifications.indexOf('function runtimeOutageLabel'));
  assert.doesNotMatch(fn, /waiting_model/);
});

test('0.8.0 desktop can retry read-only task event reads after discovery refresh', () => {
  const main = read('electron/main.js');
  assert.ok(main.includes("['get', 'history', 'operation', 'events'"));
});
