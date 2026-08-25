const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('chat toolbar uses Chinese-first service labels', () => {
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  assert.match(html, />本地工具<\/span>/);
  assert.match(html, /id="connectionStateLabel">连接通道/);
  assert.match(js, /等待模型继续处理/);
  assert.doesNotMatch(html, /<span id="mcpState"><i><\/i>MCP<\/span>/);
});

test('manager primary navigation and section headings are Chinese-first', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  for (const english of ['CONTROL CENTER', 'RUNTIME & CONNECTION', 'WORKSPACE ACCESS', 'TASK STATE', 'BUILD & VERIFY', 'DIAGNOSE & REPAIR', 'SETUP GUIDE', 'DIAGNOSTICS', 'PREFERENCES', 'CURRENT OBJECTIVE', 'RESUMABLE TASK']) {
    assert.doesNotMatch(html, new RegExp(english.replace(/[&]/g, '\\&')));
    assert.doesNotMatch(app, new RegExp(english.replace(/[&]/g, '\\&')));
  }
  assert.match(app, /function statusLabel/);
  assert.match(app, /等待你处理/);
  assert.match(app, /function toolLabel/);
});

test('settings keep common options visible and move maintenance controls behind advanced disclosure', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.match(html, /高级设置与维护/);
  assert.match(html, /运行通道密钥（Runtime API Key）/);
  assert.doesNotMatch(html, /id="taskNotificationOnlyWhenUnfocusedToggle"/);
  assert.doesNotMatch(html, /id="taskNotificationMinSecondsSelect"/);
  assert.match(app, /taskNotificationOnlyWhenUnfocused: false/);
  assert.match(app, /taskNotificationMinSeconds: 0/);
});

test('build verification defaults to an automatic plan with manual overrides folded away', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.match(html, /自动验证方案/);
  assert.match(html, /高级：手动覆盖验证方案/);
  assert.match(html, /id="buildPlanTest"/);
  assert.match(app, /buildPlanTest/);
  assert.match(app, /不会盲目执行/);
});

test('task center exposes Chinese-first safe isolation controls without a merge action', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const browser = read('renderer/browser.js');
  assert.match(html, /安全隔离区/);
  assert.match(html, /id="taskIsolationBadge"/);
  assert.match(app, /function renderTaskIsolation/);
  assert.match(app, /查看差异/);
  assert.match(app, /应用到主工作区/);
  assert.match(app, /不会改变 Git 暂存区/);
  assert.match(app, /主工作区存在同文件的新修改，系统已拒绝写入，没有覆盖你的内容/);
  assert.match(app, /放弃隔离任务/);
  assert.match(browser, /安全隔离中/);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*合并[^<]*<\/button>/);
});
