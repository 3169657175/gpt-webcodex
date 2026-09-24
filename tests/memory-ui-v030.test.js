const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Manager exposes a simplified Chinese local-memory page through semantic private IPC', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const preload = read('electron/preload.js');
  assert.match(html, /data-page="memory"/);
  assert.match(html, /data-page-view="memory"/);
  assert.match(html, /自动记忆模式/);
  assert.match(html, /id="memoryList"/);
  assert.match(html, /id="memoryCandidatePanel" hidden/);
  assert.match(preload, /memoryStatus/);
  assert.match(preload, /memoryList/);
  assert.match(preload, /memoryUpdate/);
  assert.doesNotMatch(preload, /memoryControl:\s*/);
  assert.doesNotMatch(app, /memoryNewTitle|memoryPropose/);
});
