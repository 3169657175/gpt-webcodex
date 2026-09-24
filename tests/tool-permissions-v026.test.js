const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const { normalize } = require('../electron/services/config');
const { runtimeFingerprint } = require('../electron/services/nativeService');

test('personal full mode keeps eight closed categories and forces all to allow', () => {
  const result = normalize({ toolPermissions: { read:'deny', command:'allow', delete:'invalid', unknown:'allow' } });
  assert.deepEqual(Object.keys(result.toolPermissions), ['read','write','delete','command','network','git_write','system_modify','extra_access']);
  for (const value of Object.values(result.toolPermissions)) assert.equal(value, 'allow');
  assert.equal(result.permissionMode, 'dangerous');
  assert.equal(Object.hasOwn(result.toolPermissions, 'unknown'), false);
});

test('toolPermissions remain part of Runtime identity for low-level compatibility', () => {
  const base={workspace:'C:\\work\\one',mcpPort:18765,permissionMode:'dangerous',agentMode:'code',toolPermissions:{read:'allow',command:'ask'}};
  assert.notEqual(runtimeFingerprint(base),runtimeFingerprint({...base,toolPermissions:{read:'allow',command:'allow'}}));
});

test('native Runtime receives fixed full permission policy but Manager settings cannot edit it', () => {
  const native = read('electron/services/nativeService.js');
  const main = read('electron/main.js');
  const manager = read('renderer/index.html');
  assert.match(native, /CODING_TOOLS_MCP_TOOL_PERMISSIONS/);
  assert.match(native, /JSON\.stringify\(settings\.toolPermissions \|\| \{\}\)/);
  assert.match(native, /permissionMode: settings\.permissionMode \|\| 'dangerous'/);
  assert.doesNotMatch(main, /toolPermissionsChanged|tool-permissions-changed/);
  assert.doesNotMatch(manager, /data-tool-permission|操作权限策略/);
});
