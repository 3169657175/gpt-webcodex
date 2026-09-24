const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const { normalize } = require('../electron/services/config');

test('experimental local Bridge UI and migration banner are fully removed', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const main = read('electron/main.js');
  assert.doesNotMatch(html, /data-connection-mode=|modeGate|changeConnectionMode|bridgeRemovedNotice|实验性本地 Bridge 已移除/);
  assert.doesNotMatch(app, /LOCAL_MCP_CALL|WEB_MCP_BRIDGE|bridgeRemovedNotice/);
  assert.doesNotMatch(main, /ChatBridgeService|bridgeService/);
});

test('legacy Bridge installs migrate silently to official mode without auto-start', () => {
  const migrated = normalize({ configVersion: 6, connectionMode: 'bridge', autoStartServices: true });
  assert.equal(migrated.connectionMode, 'official');
  assert.equal(migrated.autoStartServices, false);
  assert.equal(Object.hasOwn(migrated, 'bridgeRemovedNotice'), false);
});
