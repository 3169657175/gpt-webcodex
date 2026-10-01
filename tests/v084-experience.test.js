const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.8.4 names the product surface 长期上下文 and explains model-first capture', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.match(html, />长期上下文<\/span>/);
  assert.match(html, /<h2>长期上下文<\/h2>/);
  assert.match(html, /由 ChatGPT 主动总结为主/);
  assert.match(html, /自动画像辅助/);
  assert.match(html, /模型主动总结和自动画像都会在这里汇总、去重/);
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

test('0.8.4 exposes remember_context as the tenth smart MCP tool with schema v13', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
  assert.match(server, /TOOL_SCHEMA_VERSION = 13/);
  assert.match(server, /"remember_context": ToolSpec/);
  assert.match(server, /def remember_context\(self, args/);
  assert.match(server, /Do NOT call it for one-off questions/);
  assert.equal(contract.schema_version, 13);
  assert.equal(contract.tool_count, 10);
  assert.equal(contract.runtime_version, '0.8.4');
});
