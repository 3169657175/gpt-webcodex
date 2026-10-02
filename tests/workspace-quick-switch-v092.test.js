const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('renderer/browser.html', 'utf8');
const js = fs.readFileSync('renderer/browser.js', 'utf8');
const css = fs.readFileSync('renderer/browser.css', 'utf8');

test('0.9.2 offers recent-workspace quick switching while retaining Workspace Center', () => {
  assert.match(html, /id="workspaceQuickMenu"/);
  assert.match(html, /id="workspaceQuickCenter"/);
  assert.match(js, /renderWorkspaceQuickMenu/);
  assert.match(js, /await switchWorkspace\(workspace\)/);
  assert.match(js, /api\.openWorkspaceWindow/);
  assert.match(css, /\.workspace-quick-menu/);
});

test('0.9.2 uses local switch feedback and shared tone classes', () => {
  assert.match(js, /function setSwitchState/);
  assert.match(js, /切换失败/);
  assert.match(js, /tone-\$\{window\.assistantState\.toneFor\(view\)\}/);
  assert.match(js, /tone-\$\{view\.tone\}/);
  assert.match(css, /\.task-strip\.tone-danger/);
});
