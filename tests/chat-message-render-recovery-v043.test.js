const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const controller = fs.readFileSync('electron/chatViewController.js', 'utf8');
const { isChatMessageRenderErrorText } = require('../electron/chatViewController');

test('0.4.3 recognizes ChatGPT message render failures separately from stream interruption', () => {
  assert.equal(isChatMessageRenderErrorText('出错了，无法显示此消息。'), true);
  assert.equal(isChatMessageRenderErrorText('There was an error displaying this message.'), true);
  assert.equal(isChatMessageRenderErrorText('Unable to display this message'), true);
  assert.equal(isChatMessageRenderErrorText('连接已中断。正在等待完整回复'), false);
});

test('0.4.3 message render errors are observation-only and never auto reload', () => {
  assert.match(controller, /page-message-render-error/);
  assert.match(controller, /getBoundingClientRect\(\)/);
  assert.match(controller, /\[role="alert"\]/);
  assert.doesNotMatch(controller, /safeToReload/);
  assert.doesNotMatch(controller, /scheduleMessageRenderRecovery/);
});

test('0.4.3 only user navigation may actively reload ChatGPT', () => {
  const streamStart = controller.indexOf('  scheduleStreamObserver() {');
  const streamEnd = controller.indexOf('  scheduleContinuousMcpMode()', streamStart);
  const streamBlock = controller.slice(streamStart, streamEnd);
  assert.ok(streamStart >= 0 && streamEnd > streamStart);
  assert.doesNotMatch(streamBlock, /\.reload\s*\(/);
  assert.doesNotMatch(streamBlock, /reloadIgnoringCache/);
  assert.doesNotMatch(streamBlock, /restartRuntime|restartTunnel|sendInputEvent|\.click\(/);
  assert.match(controller, /user-navigation-reload/);
  assert.match(controller, /ChatGPT 页面重载/);
});
