const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('0.8.1 task strip exposes a hover/click detail popover instead of relying on one-line text', () => {
  const html = read('renderer/browser.html');
  const css = read('renderer/browser.css');
  const js = read('renderer/browser.js');
  assert.match(html, /id="taskStrip"[^>]+aria-controls="activityPanel"/);
  assert.match(html, /id="activityElapsed"/);
  assert.match(html, /id="activityNextStep"/);
  assert.match(css, /\.activity-panel\{[^}]*width:min\(640px/);
  assert.match(js, /scheduleActivityOpen/);
  assert.match(js, /mouseenter/);
  assert.match(js, /150/);
  assert.match(js, /activityPopoverPinned/);
});

test('0.8.1 runtime fixes direct command state, structured workflow errors, and commands-only fast path', () => {
  const state = read('resources/coding-tools-mcp/coding_tools_mcp/task_state.py');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(state, /superseded-by-command/);
  assert.match(server, /fast_path": "commands_only"/);
  assert.match(server, /command_fast_path = bool/);
  assert.match(server, /failure_payload = \{/);
  assert.match(server, /side_effect_possible/);
  assert.match(server, /retry_safe/);
});
