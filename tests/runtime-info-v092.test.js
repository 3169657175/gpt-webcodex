const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('0.9.2 keeps ChatGPT native view geometry fixed while compacting only shell content', () => {
  const main = fs.readFileSync('electron/main.js', 'utf8');
  const preload = fs.readFileSync('electron/browserPreload.js', 'utf8');
  const browser = fs.readFileSync('renderer/browser.js', 'utf8');
  const css = fs.readFileSync('renderer/browser.css', 'utf8');
  const controller = fs.readFileSync('electron/chatViewController.js', 'utf8');
  assert.match(main, /toolbarHeight:\s*164/);
  assert.doesNotMatch(main, /chat:toolbar-height/);
  assert.doesNotMatch(preload, /setToolbarHeight/);
  assert.doesNotMatch(controller, /setToolbarHeight\s*\(/);
  assert.doesNotMatch(browser, /setProperty\([^\n]*--toolbar-height|setToolbarHeight/);
  assert.match(css, /--toolbar-height:164px/);
  assert.match(css, /\.progress-band\.compact/);
});

test('0.9.2 user-facing activity detail no longer exposes raw heartbeat terminology', () => {
  const detail = fs.readFileSync('renderer/activity-detail.js', 'utf8');
  const presentation = fs.readFileSync('renderer/progressPresentation.js', 'utf8');
  assert.doesNotMatch(detail, /后台心跳/);
  assert.doesNotMatch(presentation, /后台任务心跳|进程与心跳正常/);
  assert.match(presentation, /最近活动/);
});
