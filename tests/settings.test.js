const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const { normalize, validateRuntimeSettings, mergeRecentWorkspaces } = require('../electron/services/config');

test('0.5.8 fixes product mode to personal full permissions', () => {
  const result = normalize({ permissionMode: 'safe', toolMode: 'dangerous', agentMode: 'full', proxyMode: 'dangerous' });
  assert.equal(result.permissionMode, 'dangerous');
  assert.equal(result.agentMode, 'code');
  assert.equal(result.proxyMode, 'auto');
  assert.equal(Object.hasOwn(result, 'toolMode'), false);
  assert.equal(result.continuousMcpMode, true);
  assert.equal(result.compactToolCalls, true);
  assert.equal(result.progressReportSeconds, 30);
});

test('legacy approval-heavy settings migrate every category to allow', () => {
  const result = normalize({ configVersion: 14, permissionMode:'safe', toolPermissions: { read:'deny', write:'ask', command:'ask', network:'deny', extra_access:'ask', delete:'ask', git_write:'ask', system_modify:'deny' }, permissionPatterns:{paths:[{pattern:'*',decision:'deny'}],commands:[{pattern:'git *',decision:'ask'}]} });
  for (const key of ['read','write','delete','command','network','git_write','system_modify','extra_access']) {
    assert.equal(result.toolPermissions[key], 'allow');
  }
  assert.deepEqual(result.permissionPatterns, { paths: [], commands: [] });
});

test('all installations use official mode and old Bridge users migrate safely', () => {
  const migrated = normalize({ configVersion: 6, connectionMode: 'bridge', autoStartServices: true });
  assert.equal(migrated.connectionMode, 'official');
  assert.equal(migrated.autoStartServices, false);
  assert.equal(Object.hasOwn(migrated, 'bridgeRemovedNotice'), false);
});

test('unknown legacy settings are removed from normalized settings', () => {
  const result = normalize({ unknownThing: true, guideProgress: { a: true }, firstRunCompleted: true, taskNotificationMinSeconds: 60 });
  assert.equal(Object.hasOwn(result, 'unknownThing'), false);
  assert.equal(Object.hasOwn(result, 'guideProgress'), false);
  assert.equal(Object.hasOwn(result, 'firstRunCompleted'), false);
  assert.equal(Object.hasOwn(result, 'taskNotificationMinSeconds'), false);
});

test('trusted ordinary settings are preserved', () => {
  const result = normalize({ configVersion: 13, theme:'dark', proxyMode:'manual', proxyUrl:'http://127.0.0.1:7890', mcpPort:19001, healthPort:19002, tunnelId:'tunnel_demo1' });
  assert.equal(result.theme, 'dark');
  assert.equal(result.proxyMode, 'manual');
  assert.equal(result.mcpPort, 19001);
  assert.equal(result.healthPort, 19002);
});

test('runtime ports cannot overlap', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ mcpPort: 19000, healthPort: 19000 })));
});

test('proxy credentials are rejected', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ proxyMode:'manual', proxyUrl:'http://user:pass@127.0.0.1:7890' })));
});

test('manual proxy mode requires an address', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ proxyMode:'manual', proxyUrl:'' })));
});

test('tunnel id must use the official prefix', () => {
  assert.throws(() => validateRuntimeSettings(normalize({ tunnelId:'bad-id' })));
});

test('recent workspaces use a 50-item MRU list', () => {
  const values = Array.from({length:60},(_,i)=>'C:\\work\\'+i);
  const result = mergeRecentWorkspaces(values, 'C:\\work\\new');
  assert.equal(result.length, 50);
  assert.match(result[0], /new$/);
});
