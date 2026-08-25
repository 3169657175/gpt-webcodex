const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LocalMcpClient, parseRpcPayload, parseSseEventBlock } = require('../electron/services/localMcpClient');

function createFakeMcpServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url !== '/mcp' || req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      const rpc = JSON.parse(body);
      calls.push({ rpc, session: req.headers['mcp-session-id'] || '', origin: req.headers['x-coding-tools-origin'] || '' });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'session-test');
      if (rpc.method === 'server/discover') {
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          result: {
            serverInfo: {
              name: 'coding-tools-mcp', version: '0.4.3', schemaVersion: 3, schemaHash: 'abc123', toolCount: 1,
              runtimeInstanceId: 'runtime-1', processId: 4321, launchId: 'launch-1', sourceFingerprint: 'source-1', workspace: 'C:\\work'
            },
            tools: [{ name: 'workspace_context', inputSchema: { type: 'object' } }]
          }
        }));
        return;
      }
      if (rpc.method === 'tools/call') {
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          result: { ok: true, echoed: rpc.params }
        }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
    });
  });
  return { server, calls };
}

test('local MCP client discovers tools then calls them over the same session', async (t) => {
  const fake = createFakeMcpServer();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fake.server.close(resolve)));
  const port = fake.server.address().port;
  const client = new LocalMcpClient({ port, token: 'test-token' });

  const tools = await client.discoverTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['workspace_context']);
  assert.deepEqual(client.schemaIdentity(), {
    version: '0.4.3', schemaVersion: 3, schemaHash: 'abc123', toolCount: 1,
    runtimeInstanceId: 'runtime-1', processId: 4321, launchId: 'launch-1', sourceFingerprint: 'source-1', workspace: 'C:\\work'
  });
  const result = await client.callTool('workspace_context', { path: '.' });
  assert.equal(result.ok, true);
  assert.equal(result.echoed.name, 'workspace_context');
  assert.deepEqual(result.echoed.arguments, { path: '.' });
  assert.equal(fake.calls[0].session, '');
  assert.equal(fake.calls[1].session, 'session-test');
  assert.equal(fake.calls[0].origin, 'desktop');
  assert.equal(fake.calls[1].origin, 'desktop');
});

test('tool discovery deliberately drops a stale MCP session before rediscovery', async (t) => {
  const fake = createFakeMcpServer();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fake.server.close(resolve)));
  const client = new LocalMcpClient({ port: fake.server.address().port, token: 'test-token' });
  client.sessionId = 'stale-session-from-old-runtime';
  await client.discoverTools();
  assert.equal(fake.calls[0].session, '');
  assert.equal(client.sessionId, 'session-test');
});

test('local MCP client rejects a tool that was not discovered', async () => {
  const client = new LocalMcpClient({ port: 18765, token: 'test-token' });
  client.tools = [{ name: 'workspace_context' }];
  await assert.rejects(() => client.callTool('made_up_tool', {}), /未暴露工具/);
});

test('RPC parser accepts JSON and event-stream payloads', () => {
  assert.deepEqual(parseRpcPayload('{"jsonrpc":"2.0","result":{"ok":true}}', 'application/json'), {
    jsonrpc: '2.0', result: { ok: true }
  });
  assert.deepEqual(parseRpcPayload('event: message\ndata: {"jsonrpc":"2.0","result":{"ok":true}}\n\n', 'text/event-stream'), {
    jsonrpc: '2.0', result: { ok: true }
  });
});

test('task-event SSE parser preserves id, event name and JSON payload', () => {
  assert.deepEqual(parseSseEventBlock('id: 3\nevent: task-event\ndata: {"event_id":3,"type":"task.completed","state":{"status":"completed"}}'), {
    id: '3',
    event: 'task-event',
    data: { event_id: 3, type: 'task.completed', state: { status: 'completed' } }
  });
  assert.equal(parseSseEventBlock(': heartbeat'), null);
});

test('local MCP client subscribes to authenticated task events', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, lastEventId: req.headers['last-event-id'] || '' });
    if (req.url !== '/__control/events' || req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('id: 1\n');
    res.write('event: task-event\n');
    res.write('data: {"event_id":1,"type":"task.started","workspace":"C:\\\\work","state":{"task_id":"push","status":"active"}}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new LocalMcpClient({ port: server.address().port, token: 'test-token' });
  let unsubscribe = () => {};
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('task event timeout')), 1000);
    unsubscribe = client.subscribeTaskEvents((event) => {
      clearTimeout(timer);
      resolve(event);
    }, { onError: reject });
  });
  unsubscribe();
  assert.equal(payload.event_id, 1);
  assert.equal(payload.type, 'task.started');
  assert.equal(payload.state.status, 'active');
  assert.equal(requests[0].url, '/__control/events');
  assert.equal(requests[0].authorization, 'Bearer test-token');
});

test('task event reconnect sends Last-Event-ID and ignores duplicate durable events', async (t) => {
  const requests = [];
  let connection = 0;
  const server = http.createServer((req, res) => {
    connection += 1;
    requests.push({ url: req.url, lastEventId: req.headers['last-event-id'] || '' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (connection === 1) {
      res.end('id: 7\nevent: task-event\ndata: {"event_id":7,"type":"task.completed","state":{"status":"completed"}}\n\n');
      return;
    }
    res.write('id: 7\nevent: task-event\ndata: {"event_id":7,"type":"task.completed","state":{"status":"completed"}}\n\n');
    res.write('id: 8\nevent: task-event\ndata: {"event_id":8,"type":"task.started","state":{"status":"active"}}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new LocalMcpClient({ port: server.address().port, token: 'test-token' });
  const ids = [];
  let unsubscribe = () => {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('event replay timeout')), 2500);
    unsubscribe = client.subscribeTaskEvents((event) => {
      ids.push(event.event_id);
      if (event.event_id === 8) {
        clearTimeout(timer);
        resolve();
      }
    }, { reconnectMs: 50, onError: reject });
  });
  unsubscribe();
  assert.deepEqual(ids, [7, 8]);
  assert.equal(requests[1].lastEventId, '7');
});
