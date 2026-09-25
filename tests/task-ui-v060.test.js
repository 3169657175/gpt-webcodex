const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('renderer/app.js', 'utf8');

test('0.6.0 hides clean worktrees and exposes stalled task state', () => {
  assert.match(source, /function worktreeHasPendingChanges/);
  assert.match(source, /has_unapplied_changes/);
  assert.match(source, /changed_count/);
  assert.match(source, /unified\.state === 'stalled'/);
  assert.match(source, /疑似卡住/);
  assert.match(source, /秒无活动/);
});


test('0.6.0 Manager uses a restrained WebCodex-style desktop information architecture', () => {
  const html = fs.readFileSync('renderer/index.html', 'utf8');
  const css = fs.readFileSync('renderer/manager-v2.css', 'utf8');
  assert.match(html, /class="nav-section-label">工作</);
  assert.match(html, /class="nav-section-label">配置</);
  assert.match(html, /data-page="status"[^>]*>.*首页/s);
  assert.match(css, /--sidebar-w:224px/);
  assert.match(css, /\.service-grid\{[\s\S]*border:1px solid var\(--m-border\)/);
  assert.match(css, /\.service-card\{[\s\S]*border-radius:0/);
  assert.match(css, /\.stage-list\{[\s\S]*border-radius:8px/);
  assert.doesNotMatch(css, /linear-gradient\(145deg,#7c6ef2,#6556da\)/);
});
