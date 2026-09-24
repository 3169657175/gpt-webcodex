const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Compact and Resume remain private Runtime capabilities', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const client = read('electron/services/localMcpClient.js');
  const main = read('electron/main.js');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
  assert.match(server, /\/__control\/compact/);
  assert.match(server, /handle_control_compact/);
  assert.match(client, /compactLocalSession\(\)/);
  assert.match(main, /secureHandle\('local-session:compact'/);
  assert.equal(contract.schema_version, 10);
  assert.equal(contract.tool_count, 9);
});

test('0.5.1 removes manual Compact controls from Manager while Runtime resume remains', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.doesNotMatch(html, /compactLocalSession|压缩并准备新对话|compactSessionResult/);
  assert.doesNotMatch(app, /compactCurrentSession/);
  assert.match(server, /phase == "resume"|phase == 'resume'/);
});
