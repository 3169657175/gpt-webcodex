const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.7.1 local memory library exposes pagination and bulk archive controls', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const css = read('renderer/manager-v2.css');

  for (const id of ['memorySelectPage', 'memoryBatchArchive', 'memoryPageSize', 'memoryPrevPage', 'memoryNextPage', 'memoryPageLabel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /按页加载/);
  assert.match(app, /function renderMemoryPagination/);
  assert.match(app, /function archiveSelectedMemories/);
  assert.match(app, /api\.memoryArchive\(memoryId\)/);
  assert.match(app, /details\.className = 'memory-card-details'/);
  assert.match(app, /state\.memory\.selected/);
  assert.match(css, /\.memory-bulk-toolbar/);
  assert.match(css, /\.memory-pagination/);
  assert.match(css, /\.memory-card-details/);
});

test('0.7.1 memory list fetch keeps the runtime request bounded', () => {
  const app = read('renderer/app.js');
  assert.match(app, /const options = \{ limit: 200 \};/);
  assert.match(app, /state\.memory\.pageSize/);
  assert.match(app, /items\.slice\(start, start \+ pageSize\)/);
});
