const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('0.8.2 progress band owns the detailed hover card and the top task strip stays compact', () => {
  const html = read('renderer/browser.html');
  const css = read('renderer/browser.css');
  const js = read('renderer/browser.js');
  assert.match(html, /id="progressBand"[^>]+aria-controls="activityPanel"/);
  assert.doesNotMatch(html, /id="taskStrip"[^>]+aria-controls="activityPanel"/);
  assert.match(html, /id="activityTaskId"/);
  assert.match(html, /id="activityRunId"/);
  assert.match(html, /id="activityOperationId"/);
  assert.match(html, /id="activityLastResult"/);
  assert.match(css, /\.activity-panel\{[^}]*width:min\(780px/);
  assert.match(js, /\$\('#progressBand'\)\?\.addEventListener\('mouseenter'/);
  assert.doesNotMatch(js, /\$\('#taskStrip'\)\.addEventListener\('mouseenter'/);
  assert.match(js, /activityPopoverPinned/);
  assert.match(js, /setInterval\(refreshTask, 1000\)/);
});

test('0.8.2 runtime settles elapsed time and terminal workflow state cleanly', () => {
  const state = read('resources/coding-tools-mcp/coding_tools_mcp/task_state.py');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const processes = read('resources/coding-tools-mcp/coding_tools_mcp/processes.py');
  assert.match(state, /state\["current_step"\] = ""/);
  assert.match(state, /_duration_ms_between/);
  assert.match(processes, /"elapsed_ms": elapsed_ms/);
  assert.match(server, /set_stage\("finalize", "Finalizing result"\)/);
});
