const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('0.9.2 browser chrome supports real compact and expanded toolbar heights', () => {
  const main = fs.readFileSync('electron/main.js', 'utf8');
  const preload = fs.readFileSync('electron/browserPreload.js', 'utf8');
  const browser = fs.readFileSync('renderer/browser.js', 'utf8');
  const css = fs.readFileSync('renderer/browser.css', 'utf8');
  assert.match(main, /toolbarHeight:\s*154/);
  assert.match(main, /chat:toolbar-height/);
  assert.match(preload, /setToolbarHeight/);
  assert.match(browser, /expanded \? 169 : 154/);
  assert.match(css, /\.progress-band\.compact/);
});

test('0.9.2 user-facing activity detail no longer exposes raw heartbeat terminology', () => {
  const detail = fs.readFileSync('renderer/activity-detail.js', 'utf8');
  const presentation = fs.readFileSync('renderer/progressPresentation.js', 'utf8');
  assert.doesNotMatch(detail, /后台心跳/);
  assert.doesNotMatch(presentation, /后台任务心跳|进程与心跳正常/);
  assert.match(presentation, /最近活动/);
});
