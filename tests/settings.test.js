const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, validateRuntimeSettings, mergeRecentWorkspaces, workspaceKey } = require('../electron/services/config');

test('invalid modes fall back to safe defaults', () => {
  const result = normalize({ permissionMode: 'dangerous', toolMode: 'dangerous', proxyMode: 'dangerous' });
  assert.equal(result.permissionMode, 'safe');
  assert.equal(result.toolMode, 'smart');
  assert.equal(result.mcpPort, 18765);
  assert.equal(result.proxyMode, 'auto');
});

test('legacy tool modes migrate to smart mode', () => {
  for (const toolMode of ['readonly', 'coding', 'build', 'full', 'smart']) assert.equal(normalize({ toolMode }).toolMode, 'smart');
});

test('all installations use official mode and old Bridge users are migrated safely', () => {
  const legacy = normalize({ configVersion: 5, tunnelId: 'tunnel_demo' });
  assert.equal(legacy.connectionMode, 'official');
  assert.equal(legacy.tunnelId, 'tunnel_demo');
  assert.equal(normalize({}).connectionMode, 'official');
  const migrated = normalize({ configVersion: 6, connectionMode: 'bridge', autoStartServices: true, tunnelId: 'tunnel_demo' });
  assert.equal(migrated.connectionMode, 'official');
  assert.equal(migrated.autoStartServices, false);
  assert.equal(migrated.bridgeRemovedNotice, true);
  assert.equal(migrated.tunnelId, 'tunnel_demo');
});

test('unknown legacy settings are removed from normalized settings', () => {
  assert.deepEqual(Object.keys(normalize({ obsoleteRuntimeChoice: 'legacy' })).sort(), Object.keys(normalize()).sort());
});

test('trusted values are preserved', () => {
  const result = normalize({ permissionMode: 'trusted', mcpPort: '9000' });
  assert.equal(result.permissionMode, 'trusted');
  assert.equal(result.mcpPort, 9000);
});

test('runtime ports cannot overlap', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ connectionMode: 'official', mcpPort: 9000, healthPort: 9000 })), /不能相同/);
});

test('proxy credentials are rejected', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ connectionMode: 'official', proxyUrl: 'http://user:pass@127.0.0.1:1080' })), /不要在代理地址/);
});

test('manual proxy mode requires an address', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ connectionMode: 'official', proxyMode: 'manual', proxyUrl: '' })), /手动代理/);
});

test('tunnel id must use the official prefix', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ connectionMode: 'official', tunnelId: 'wrong-id' })), /tunnel_/);
});

test('recent workspaces use a 50-item MRU list', () => {
  let recent = [];
  for (let index = 0; index < 55; index += 1) {
    recent = mergeRecentWorkspaces(recent, `C:\\workspace-${index}`);
  }
  assert.equal(recent.length, 50);
  assert.equal(recent[0], 'C:\\workspace-54');
  assert.equal(recent.at(-1), 'C:\\workspace-5');

  recent = mergeRecentWorkspaces(recent, 'c:\\WORKSPACE-20\\');
  assert.equal(recent.length, 50);
  assert.equal(workspaceKey(recent[0]), workspaceKey('C:\\workspace-20'));
  assert.equal(recent.filter((item) => workspaceKey(item) === workspaceKey('C:\\workspace-20')).length, 1);
});
