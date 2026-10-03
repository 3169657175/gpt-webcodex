const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  PublicMcpGateway,
  publicMcpAccessPath
} = require('../electron/services/publicMcpGateway');

test('private gateway derives a stable opaque path without exposing the Runtime token', () => {
  const path = publicMcpAccessPath('runtime-token');
  assert.match(path, /^\/mcp\/[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(path, /runtime-token/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request({ port, path, method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createRuntime(label, calls) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({
        label,
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        session: req.headers['mcp-session-id'] || '',
        body
      });
      if (req.headers.authorization !== 'Bearer runtime-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': `${label}-session`,
        'X-Upstream-Runtime': label
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { runtime: label, workspace: label === 'one' ? 'C:\\one' : 'D:\\two' } }));
    });
  });
}

test('public gateway rejects unknown paths and injects local Runtime auth', async (t) => {
  const calls = [];
  const runtime = createRuntime('one', calls);
  const runtimePort = await listen(runtime);
  t.after(() => close(runtime));
  const settingsValue = { mcpPort: runtimePort };
  const settings = { load: () => ({ ...settingsValue }) };
  const secrets = { get: (name) => name === 'mcpAuthToken' ? 'runtime-token' : '' };
  const gateway = new PublicMcpGateway({ settings, secrets, port: 0 });
  const info = await gateway.start();
  t.after(() => gateway.stop());

  const denied = await request({ port: info.port, path: '/mcp' });
  assert.equal(denied.status, 404);
  assert.equal(calls.length, 0);

  const path = publicMcpAccessPath('runtime-token');
  const proxied = await request({
    port: info.port,
    path,
    headers: {
      Authorization: 'Bearer external-value-must-not-pass-through',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': 'chatgpt-session'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers['mcp-session-id'], 'one-session');
  assert.equal(proxied.headers['x-upstream-runtime'], 'one');
  assert.equal(JSON.parse(proxied.body).result.workspace, 'C:\\one');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/mcp');
  assert.equal(calls[0].authorization, 'Bearer runtime-token');
  assert.equal(calls[0].session, 'chatgpt-session');
});

test('public gateway follows the live Runtime port without restart', async (t) => {
  const calls = [];
  const runtimeOne = createRuntime('one', calls);
  const runtimeTwo = createRuntime('two', calls);
  const portOne = await listen(runtimeOne);
  const portTwo = await listen(runtimeTwo);
  t.after(() => Promise.all([close(runtimeOne), close(runtimeTwo)]));

  const settingsValue = { mcpPort: portOne };
  const settings = { load: () => ({ ...settingsValue }) };
  const secrets = { get: () => 'runtime-token' };
  const gateway = new PublicMcpGateway({ settings, secrets, port: 0 });
  const info = await gateway.start();
  t.after(() => gateway.stop());
  const path = publicMcpAccessPath('runtime-token');

  const first = await request({ port: info.port, path, body: '{}' });
  assert.equal(JSON.parse(first.body).result.runtime, 'one');
  settingsValue.mcpPort = portTwo;
  const second = await request({ port: info.port, path, body: '{}' });
  assert.equal(JSON.parse(second.body).result.runtime, 'two');
  assert.deepEqual(calls.map((call) => call.label), ['one', 'two']);
});

test('public gateway preserves event-stream responses', async (t) => {
  const runtime = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer runtime-token') {
      res.writeHead(401); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'stream-session' });
    res.end('event: message\ndata: {"jsonrpc":"2.0","result":{"ok":true}}\n\n');
  });
  const runtimePort = await listen(runtime);
  t.after(() => close(runtime));
  const gateway = new PublicMcpGateway({
    settings: { load: () => ({ mcpPort: runtimePort }) },
    secrets: { get: () => 'runtime-token' },
    port: 0
  });
  const info = await gateway.start();
  t.after(() => gateway.stop());
  const response = await request({ port: info.port, path: publicMcpAccessPath('runtime-token'), method: 'GET' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.equal(response.headers['mcp-session-id'], 'stream-session');
  assert.match(response.body, /"ok":true/);
});
