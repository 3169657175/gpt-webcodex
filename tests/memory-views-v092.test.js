const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('renderer/index.html', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');

test('memory UI exposes active candidates and archived views', () => {
  assert.match(html, /id="memoryViewActive"/);
  assert.match(html, /id="memoryViewCandidates"/);
  assert.match(html, /id="memoryViewArchived"/);
  assert.match(app, /view:\s*'active'/);
  assert.match(app, /archived:\s*archivedView/);
});

test('archived memories can be restored or permanently deleted', () => {
  assert.match(preload, /memoryUnarchive/);
  assert.match(app, /恢复为有效/);
  assert.match(app, /永久删除这条已归档记忆/);
  assert.match(app, /archive_reason/);
  assert.match(app, /archived_at/);
});
