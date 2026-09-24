const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('chat toolbar stays Chinese-first and task strip is user-facing', () => {
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  assert.match(html, />本地工具<\/span>/);
  assert.match(html, /id="connectionStateLabel">连接通道/);
  assert.match(html, /id="taskStatusLabel">空闲/);
  assert.match(js, /执行中/);
  assert.match(js, /等待处理/);
  assert.doesNotMatch(html, /taskProgressBar|pauseTask|resumeTask/);
});

test('Manager primary navigation exposes four Chinese-first business entries', () => {
  const html = read('renderer/index.html');
  assert.match(html, />状态中心<\/span>/);
  assert.match(html, />工作区<\/span>/);
  assert.match(html, />本地记忆<\/span>/);
  assert.match(html, />设置与诊断<\/span>/);
  assert.doesNotMatch(html, /data-page="task"|data-page="overview"|data-page="support"|data-page="build"/);
});

test('settings keep common options visible and low-frequency controls collapsed', () => {
  const html = read('renderer/index.html');
  assert.match(html, /常用设置/);
  assert.match(html, /连接与运行/);
  assert.match(html, /高级维护/);
  assert.match(html, /桌面任务提醒/);
  assert.doesNotMatch(html, /操作权限策略|项目构建检查|长任务汇报间隔|连续 MCP 兼容监测/);
});

test('build and task consoles are absent from the Manager product surface', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.doesNotMatch(html, /data-page-view="build"|data-page-view="task"|安全隔离区|历史与性能|自动验证方案/);
  assert.doesNotMatch(app, /renderTaskIsolation|renderPerformanceTrace|runBuildVerification/);
});

test('diagnostics consolidate maintenance into one page', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  for (const id of ['diagRuntime','diagTunnel','diagUpstream','diagAttachment','runDiagnostics','repairHealth','exportSupportReport','logOutput']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(app, /doctorInspect/);
  assert.match(app, /inspectHealth/);
  assert.match(app, /renderDiagnostics/);
});
