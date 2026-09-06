const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ContextUsageTracker, estimateTokens } = require('../electron/services/contextUsageTracker');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('estimateTokens calculates reasonable counts for english, code, and chinese text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);

  const english = 'Hello world, this is a test prompt.';
  const engTokens = estimateTokens(english);
  assert.ok(engTokens >= 8 && engTokens <= 14, `Expected engTokens around 10, got ${engTokens}`);

  const chinese = '这是一个中文测试提示词，测试上下文容量统计。';
  const cnTokens = estimateTokens(chinese);
  assert.ok(cnTokens >= 20 && cnTokens <= 35, `Expected cnTokens around 28, got ${cnTokens}`);

  const codeSnippet = 'function foo(bar) { return bar.map(x => x * 2); }';
  const codeTokens = estimateTokens(codeSnippet);
  assert.ok(codeTokens >= 10 && codeTokens <= 25, `Expected codeTokens around 14, got ${codeTokens}`);
});

test('ContextUsageTracker accumulates tool calls, tracks max, and computes pressure levels', () => {
  const tracker = new ContextUsageTracker({ contextBudget: 1000 });
  const initial = tracker.snapshot();
  assert.equal(initial.totalTokens, 0);
  assert.equal(initial.totalBytes, 0);
  assert.equal(initial.callCount, 0);
  assert.equal(initial.pressureLevel, 'safe');

  let emitted = null;
  tracker.on('change', (snap) => { emitted = snap; });

  // 1. Small call
  tracker.recordToolCall('workspace_context', { detail: 'compact' }, { ready: true });
  assert.equal(tracker.callCount, 1);
  assert.ok(tracker.totalBytes > 0);
  assert.ok(tracker.totalTokens > 0);
  assert.equal(tracker.pressureLevel(), 'safe');
  assert.equal(emitted.callCount, 1);

  // 2. Large call that pushes ratio above 25% (250 tokens in 1000 budget)
  const bigContent = 'x'.repeat(1200);
  tracker.recordToolCall('read_file', { path: 'big.js' }, { content: bigContent });
  assert.equal(tracker.callCount, 2);
  assert.equal(tracker.maxCall.tool, 'read_file');
  assert.ok(tracker.totalTokens > 250);
  assert.equal(tracker.pressureLevel(), 'moderate');

  // 3. Huge call that pushes ratio above 60%
  const hugeContent = 'y'.repeat(2000);
  tracker.recordToolCall('exec_command', { cmd: 'build' }, { output: hugeContent });
  assert.equal(tracker.callCount, 3);
  assert.equal(tracker.maxCall.tool, 'exec_command');
  assert.equal(tracker.pressureLevel(), 'heavy');

  // 4. Reset
  const resetSnap = tracker.reset();
  assert.equal(resetSnap.totalTokens, 0);
  assert.equal(resetSnap.callCount, 0);
  assert.equal(resetSnap.pressureLevel, 'safe');
  assert.equal(tracker.totalTokens, 0);

  // 5. syncWithRuntime from Python MCP performance trace
  const trace = {
    current_session_id: 'test-session-123',
    tool_calls: 5,
    request_bytes: 1200,
    response_bytes: 16000,
    recent: [
      { tool: 'read_file', request_bytes: 200, response_bytes: 8000, finished_at: '2026-09-04T12:00:00Z' },
      { tool: 'apply_patch', request_bytes: 1000, response_bytes: 8000, finished_at: '2026-09-04T12:01:00Z' }
    ]
  };
  const syncedSnap = tracker.syncWithRuntime(trace);
  assert.equal(syncedSnap.callCount, 5);
  assert.ok(syncedSnap.totalBytes >= 17200);
  assert.ok(syncedSnap.totalTokens >= 5000);
  assert.equal(syncedSnap.pressureLevel, 'heavy'); // budget is 1000, ratio > 5
  assert.ok(syncedSnap.maxCall);
  assert.equal(syncedSnap.maxCall.tool, 'apply_patch');

  // 6. Test session baseline: new session ignores previous 17200 bytes
  tracker.setSessionBaseline(trace);
  const freshSessionSnap = tracker.snapshot();
  assert.equal(freshSessionSnap.totalTokens, 0);
  assert.equal(freshSessionSnap.callCount, 0);
  assert.equal(freshSessionSnap.totalBytes, 0);

  // When a new call happens in Python MCP, only the delta is counted
  const nextTrace = {
    ...trace,
    tool_calls: 6,
    request_bytes: 1500,
    response_bytes: 18000
  };
  const deltaSnap = tracker.syncWithRuntime(nextTrace);
  assert.equal(deltaSnap.callCount, 1);
  assert.equal(deltaSnap.totalBytes, 2300); // 19500 - 17200
});

test('context usage UI and IPC are wired end to end', () => {
  const html = read('renderer/browser.html');
  const css = read('renderer/browser.css');
  const js = read('renderer/browser.js');
  const preload = read('electron/browserPreload.js');
  const main = read('electron/main.js');

  assert.match(html, /id="contextUsageWrap"/);
  assert.match(html, /id="contextUsageButton"/);
  assert.match(html, /id="contextUsagePopover"/);
  assert.match(html, /id="resetContextUsage"/);
  assert.match(css, /\.context-usage-button/);
  assert.match(css, /\.context-usage-popover/);
  assert.match(js, /renderContextUsage/);
  assert.match(js, /refreshContextUsage/);
  assert.match(preload, /contextUsage:/);
  assert.match(preload, /resetContextUsage:/);
  assert.match(main, /context:usage/);
  assert.match(main, /context:reset-usage/);
  assert.match(main, /contextUsageTracker\.recordToolCall/);
});
