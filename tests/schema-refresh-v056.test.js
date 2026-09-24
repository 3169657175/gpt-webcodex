const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { compactSchemaIdentity, schemaIdentityChanged } = require('../electron/services/runtimeOrchestrator');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.5.8 schema identity change detects first discovery and actual generation changes', () => {
  const current = { version: '0.5.8', schemaVersion: 10, schemaHash: 'abc', toolCount: 9 };
  assert.equal(schemaIdentityChanged(null, current), true);
  assert.equal(schemaIdentityChanged(current, current), false);
  assert.equal(schemaIdentityChanged(current, { ...current, schemaVersion: 11 }), true);
  assert.equal(schemaIdentityChanged(current, { ...current, schemaHash: 'def' }), true);
  assert.equal(schemaIdentityChanged(current, { ...current, toolCount: 10 }), true);
  assert.deepEqual(compactSchemaIdentity({
    version: '0.5.8', schema_version: 10, schema_hash: 'abc', tool_count: 9
  }), current);
});

test('0.5.8 browser exposes a temporary stale-chat schema refresh hint', () => {
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  assert.match(html, /id=\"schemaRefreshHint\"[^>]*hidden/);
  assert.match(js, /chatSchemaRefreshRecommended/);
  assert.match(js, /schemaRefreshNotice/);
  assert.match(js, /新建聊天/);
});

test('0.5.8 runtime commands and Python tests default to UTF-8 without bytecode caches', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const runner = read('scripts/run-python-tests.js');
  for (const text of [server, runner]) {
    assert.match(text, /PYTHONDONTWRITEBYTECODE/);
    assert.match(text, /PYTHONIOENCODING/);
  }
});
