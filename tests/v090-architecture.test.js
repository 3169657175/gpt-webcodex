const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('0.9.0 manager has a React TypeScript Vite migration layer', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies.react);
  assert.ok(pkg.dependencies['react-dom']);
  assert.ok(pkg.devDependencies.vite);
  assert.ok(pkg.devDependencies.typescript);
  assert.match(read('renderer-ui/src/manager.tsx'), /createPortal/);
  assert.match(read('renderer-ui/src/manager.tsx'), /mcp-manager-state/);
  const html = read('renderer/index.html');
  for (const page of ['status', 'workspace', 'memory', 'settings']) assert.match(html, new RegExp(`data-react-slot="${page}"`));
  assert.match(html, /react-dist\/manager-react\.js/);
});

test('0.9.0 uses shared AssistantState and event-first task refresh', () => {
  const app = read('renderer/app.js');
  const browser = read('renderer/browser.js');
  const notify = read('electron/services/taskNotificationService.js');
  assert.match(app, /window\.assistantState\.describe/);
  assert.match(app, /api\.onTaskEvent/);
  assert.match(browser, /window\.assistantState\.describe/);
  assert.match(notify, /renderer\/assistantState/);
  assert.doesNotMatch(browser, /setInterval\(refreshTask, 1000\)/);
  assert.match(browser, /setInterval\(refreshTask, 30000\)/);
});

test('0.9.0 runtime tool registry is split out of the monolithic server', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const registry = read('resources/coding-tools-mcp/coding_tools_mcp/tool_registry.py');
  assert.match(server, /from \.tool_registry import TOOL_REGISTRY, ToolSpec/);
  assert.doesNotMatch(server, /class ToolSpec:/);
  assert.match(registry, /class ToolSpec:/);
  assert.match(registry, /"remember_context": ToolSpec/);
});

test('0.9.0 exposes tiered test and release verification scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const key of ['test:quick', 'test', 'release:verify', 'release:git-ready', 'ui:check', 'ui:build']) assert.ok(pkg.scripts[key], key);
});
