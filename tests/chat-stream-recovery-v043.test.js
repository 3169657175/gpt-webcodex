const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('electron/chatViewController.js', 'utf8');

test('0.4.3 observes ChatGPT stream interruption without intercepting sends', () => {
  assert.match(source, /scheduleStreamObserver\(\)/);
  assert.match(source, /__mcpStreamObserver/);
  assert.match(source, /\[web-mcp-stream\]/);
  assert.match(source, /连接已中断/);
  assert.match(source, /正在等待完整回复/);
  assert.match(source, /Connection interrupted/i);
  assert.doesNotMatch(source, /scheduleStreamObserver[\s\S]{0,5000}\.reload\(/);
  assert.doesNotMatch(source, /scheduleStreamObserver[\s\S]{0,5000}restartRuntime/);
});

test('stream observer reports only state metadata, not chat text', () => {
  assert.match(source, /streamState/);
  assert.match(source, /page-stream-interrupted/);
  assert.match(source, /page-stream-recovered/);
  assert.doesNotMatch(source, /web-mcp-stream[\s\S]{0,800}textContent:\s*/);
});

test('stream observer reports whether ChatGPT is generating without reading message content', () => {
  assert.match(source, /page-response-generating/);
  assert.match(source, /button\[data-testid=\\?"stop-button/);
});

test('0.5.6 classifies ChatGPT stream recovery polling timeout without auto retry side effects', () => {
  assert.match(source, /ChatGPT stream recovery polling timed out/);
  assert.match(source, /page-stream-recovery-timeout/);
  assert.match(source, /isChatStreamRecoveryTimeoutText/);
  assert.doesNotMatch(source, /page-stream-recovery-timeout[\s\S]{0,1200}\.reload\(/);
  assert.doesNotMatch(source, /page-stream-recovery-timeout[\s\S]{0,1200}\.click\(/);
});

