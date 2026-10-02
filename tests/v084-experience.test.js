const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.9.0 names the product surface 长期上下文 and explains model-primary capture', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.match(html, />长期上下文<\/span>/);
  assert.match(html, /<h2>长期上下文<\/h2>/);
  assert.match(html, /由 ChatGPT 主动总结为主/);
  assert.match(html, /模型主导 · 自动发现辅助/);
  assert.match(html, /DOM\/规则观察只发现候选，不再直接写入/);
  assert.doesNotMatch(html, />本地记忆<\/span>|<h2>本地记忆<\/h2>/);
  assert.match(app, /'长期上下文'/);
});

test('0.8.4 limits implicit Activity Detail hover and click to the compact left trigger', () => {
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  const css = read('renderer/browser.css');
  assert.match(html, /id="progressBand" aria-live="polite"/);
  assert.match(html, /id="progressDetailTrigger" role="button" tabindex="0"/);
  assert.match(js, /progressDetailTrigger\?\.addEventListener\('mouseenter'/);
  assert.match(js, /progressDetailTrigger\?\.addEventListener\('click'/);
  assert.match(js, /progressDetailTrigger\?\.addEventListener\('keydown'/);
  assert.doesNotMatch(js, /\$\('#progressBand'\)\?\.addEventListener\('mouseenter'/);
  assert.doesNotMatch(js, /\$\('#progressBand'\)\.addEventListener\('click'/);
  assert.match(css, /\.progress-detail-trigger\{[^}]*max-width:390px[^}]*flex:0 1 390px/);
  assert.doesNotMatch(css, /\.progress-band:hover/);
});

test('0.8.4 startup UI uses an ordered readiness prefix and explicit runtime milestones', () => {
  const app = read('renderer/app.js');
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  assert.match(app, /function startupPrerequisitesDone/);
  assert.match(app, /if \(!startupPrerequisitesDone\(stageId\)\) return false/);
  assert.match(app, /let prefixReady = true/);
  assert.match(app, /const done = prefixReady && Boolean\(probe\.ready\)/);
  assert.match(app, /prefixReady = false/);
  assert.doesNotMatch(app, /if \(runtimeOk\) \{[\s\S]{0,160}setStartupStage\('mcp', 'done'/);
  for (const event of ['runtime-ready', 'mcp-ready', 'tunnel-ready', 'upstream-check', 'upstream-ready']) {
    assert.match(orchestrator, new RegExp(`progress\\('${event}'`));
  }
});

test('0.9.0 exposes model-primary remember_context as the tenth smart MCP tool with schema v14', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const registry = read('resources/coding-tools-mcp/coding_tools_mcp/tool_registry.py');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
  assert.match(server, /TOOL_SCHEMA_VERSION = 14/);
  assert.match(registry, /"remember_context": ToolSpec/);
  assert.match(server, /def remember_context\(self, args/);
  assert.match(registry, /Automatic page observation is discovery-only/);
  assert.equal(contract.schema_version, 14);
  assert.equal(contract.tool_count, 10);
  assert.equal(contract.runtime_version, JSON.parse(read('package.json')).version);
});
