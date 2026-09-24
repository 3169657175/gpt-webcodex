const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHAT_PARTITION, chromeLikeUserAgent, browserProxyConfig, proxyRouteKey } = require('../electron/chatViewController');

const source = fs.readFileSync(path.resolve(__dirname, '../electron/chatViewController.js'), 'utf8');

test('ChatGPT shell keeps a persistent isolated session', () => {
  assert.equal(CHAT_PARTITION, 'persist:chatgpt-session');
  assert.match(source, /session\.fromPartition\(CHAT_PARTITION\)/);
});

test('ChatGPT shell presents Chromium as normal Chrome without changing the Chrome version', () => {
  const input = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) web-mcp-assistant/0.4.2 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36';
  const output = chromeLikeUserAgent(input);
  assert.match(output, /Chrome\/150\.0\.7871\.129/);
  assert.match(output, /Safari\/537\.36/);
  assert.doesNotMatch(output, /Electron\//);
  assert.doesNotMatch(output, /web-mcp-assistant\//);
});

test('ChatGPT shell disables Chromium background throttling for long streaming turns', () => {
  assert.match(source, /backgroundThrottling:\s*false/);
  assert.match(source, /setBackgroundThrottling\(false\)/);
});

test('ChatGPT network diagnostics never log request URLs or chat payloads', () => {
  assert.match(source, /onErrorOccurred/);
  assert.match(source, /host:\s*parsed\?\.hostname/);
  assert.doesNotMatch(source, /ChatGPT 浏览器网络请求失败'[\s\S]{0,500}url:\s*details\.url/);
});


test('ChatGPT browser proxy policy preserves explicit user semantics', () => {
  assert.deepEqual(browserProxyConfig({ proxyMode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(browserProxyConfig({ proxyMode: 'system' }), { mode: 'system' });
  assert.deepEqual(browserProxyConfig({ proxyMode: 'auto' }), { mode: 'system' });
  assert.deepEqual(browserProxyConfig({ proxyMode: 'manual', proxyUrl: '127.0.0.1:7890' }), {
    mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '<local>'
  });
});

test('ChatGPT browser and Tunnel routes can be compared without request URLs', () => {
  assert.equal(proxyRouteKey('DIRECT'), 'direct');
  assert.equal(proxyRouteKey('PROXY 127.0.0.1:7890'), '127.0.0.1:7890');
  assert.equal(proxyRouteKey('http://127.0.0.1:7890'), '127.0.0.1:7890');
});
