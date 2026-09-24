const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('HistoryStore remains private Runtime infrastructure without a Manager history console', () => {
  const main = read('electron/main.js');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const html = read('renderer/index.html');
  const preload = read('electron/preload.js');
  assert.match(main, /task-state:history/);
  assert.match(server, /history/);
  assert.doesNotMatch(html, /taskHistory|历史与性能|任务历史/);
  assert.doesNotMatch(preload, /taskHistory|prepareHistoryResume/);
});
