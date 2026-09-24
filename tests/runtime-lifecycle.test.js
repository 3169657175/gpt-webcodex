const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFingerprint, runtimeSourceFingerprint, currentRuntimeState } = require('../electron/services/nativeService');
const { normalizeProxyValue } = require('../electron/services/proxyService');

test('native runtime identity changes with workspace and port while tool mode stays smart', () => {
  const base = { workspace: 'C:\\work\\one', mcpPort: 18765, permissionMode: 'dangerous', agentMode: 'code' };
  assert.equal(runtimeFingerprint(base), runtimeFingerprint({ ...base }));
  assert.notEqual(runtimeFingerprint(base), runtimeFingerprint({ ...base, workspace: 'C:\\work\\two' }));
  assert.notEqual(runtimeFingerprint(base), runtimeFingerprint({ ...base, mcpPort: 18766 }));
  assert.notEqual(runtimeFingerprint(base), runtimeFingerprint({ ...base, authorizedRoots: ['D:\\shared'] }));
  assert.equal(runtimeFingerprint(base), runtimeFingerprint({ ...base, toolMode: 'readonly' }));
  assert.notEqual(runtimeFingerprint(base), runtimeFingerprint({ ...base, agentMode: 'plan' }));
});

test('proxy values from Windows settings are normalized', () => {
  assert.equal(normalizeProxyValue('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyValue('http=127.0.0.1:8080;https=127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyValue('http://user:pass@127.0.0.1:7890'), '');
});

test('background runtime processes are hidden and never detached on Windows', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  for (const relative of ['electron/services/nativeService.js', 'electron/services/tunnelService.js']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /windowsHide:\s*true/);
    assert.match(source, /detached:\s*false/);
    assert.doesNotMatch(source, /detached:\s*true/);
  }
  const runner = fs.readFileSync(path.join(root, 'electron/services/commandRunner.js'), 'utf8');
  assert.doesNotMatch(runner, /spawnDetached/);
  const mcpServer = fs.readFileSync(path.join(root, 'resources/coding-tools-mcp/coding_tools_mcp/server.py'), 'utf8');
  assert.match(mcpServer, /CREATE_NO_WINDOW/);
  assert.match(mcpServer, /encoding="utf-8"/);
});

test('runtime state migration keeps only current native and tunnel fields', () => {
  assert.deepEqual(
    currentRuntimeState({ nativePid: 1, tunnelPid: 2, nativeInstanceId: 'launch', nativeSourceFingerprint: 'source', obsoletePid: 3 }),
    { nativePid: 1, tunnelPid: 2, nativeInstanceId: 'launch', nativeSourceFingerprint: 'source' }
  );
});

test('runtime source fingerprint covers the complete Python runtime tree and schema contract', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const native = fs.readFileSync(path.resolve(__dirname, '../electron/services/nativeService.js'), 'utf8');
  assert.match(native, /entry\.name\.endsWith\('\.py'\)/);
  assert.match(native, /schema-contract\.json/);
  assert.match(native, /CODING_TOOLS_MCP_SOURCE_FINGERPRINT/);
  assert.match(runtimeSourceFingerprint(), /^[a-f0-9]{64}$/);
});
