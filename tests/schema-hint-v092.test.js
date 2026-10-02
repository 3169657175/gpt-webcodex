const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('0.9.2 schema hint uses chat/runtime identity mismatch instead of historical notice age', () => {
  const browser = fs.readFileSync('renderer/browser.js', 'utf8');
  const runtime = fs.readFileSync('electron/services/runtimeOrchestrator.js', 'utf8');
  assert.match(browser, /schemaIdentityKey\(lastRuntimeState\?\.schemaIdentity/);
  assert.match(browser, /mcp-chat-schema:/);
  assert.match(browser, /currentChatSchemaIdentity !== runtimeIdentity/);
  assert.match(browser, /dismissedSchemaMismatch/);
  assert.doesNotMatch(browser, /chatSchemaRefreshRecommended/);
  assert.match(runtime, /schemaIdentity/);
});
