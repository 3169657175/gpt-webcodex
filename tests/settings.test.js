const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, validateRuntimeSettings, mergeRecentWorkspaces, normalizeWorkspacePath, workspaceKey } = require('../electron/services/config');

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

test('drive-root workspaces are canonicalized so Electron and Python agree', () => {
  // 回归：选择整个盘符作为工作区时，设置里曾存成盘符相对路径 'D:.'，
  // 与 Python Runtime 解析出的 'D:\' 不一致，导致身份健康检查永远失败。
  for (const form of ['D:', 'D:.', 'D:\\', 'D:\\.', 'D:\\..']) {
    assert.equal(normalizeWorkspacePath(form), 'D:\\');
  }
  assert.equal(workspaceKey('D:'), workspaceKey('D:\\'));
  assert.equal(workspaceKey('D:.'), workspaceKey('D:\\'));

  // 旧设置文件中的 'D:.' 在下一次加载时被自动规范化。
  assert.equal(normalize({ workspace: 'D:.' }).workspace, 'D:\\');

  // 授权目录中的盘根写法同样归一并去重；不与工作区相同的保留。
  const withRoots = normalize({ workspace: 'D:\\', authorizedRoots: ['C:.', 'C:\\', 'D:\\other'] });
  assert.deepEqual(withRoots.authorizedRoots, ['C:\\', 'D:\\other']);

  // 最近工作区列表对 'D:\' 与 'D:.' 去重为一条。
  assert.deepEqual(mergeRecentWorkspaces(['D:\\'], 'D:.'), ['D:\\']);

  // 普通路径与盘符相对子路径不受影响。
  assert.equal(normalizeWorkspacePath('D:\\chatgpt\\'), 'D:\\chatgpt');
  assert.equal(normalizeWorkspacePath('D:foo'), 'D:foo');
});
