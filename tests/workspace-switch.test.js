const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  switchMcpWorkspace,
  switchMcpWorkspaceConfirmed,
} = require('../electron/services/runtimeOrchestrator');

function createWorkspaceControlServer({ responseDelayMs = 0, responseStatus = 200 } = {}) {
  let currentWorkspace = 'C:\\old-workspace';
  const server = http.createServer((request, response) => {
    if (request.url === '/__control/health') {
      const body = JSON.stringify({ ready: true, workspace: currentWorkspace });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body);
      return;
    }
    if (request.url !== '/__control/workspace') {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      currentWorkspace = JSON.parse(raw).workspace;
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(responseStatus === 200
          ? { ready: true, workspace: currentWorkspace }
          : { error: 'simulated switch failure' }));
      }, responseDelayMs);
    });
  });
  return {
    server,
    workspace: () => currentWorkspace,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('workspace switch confirms Runtime identity after the control response', async () => {
  const fixture = createWorkspaceControlServer({ responseDelayMs: 80 });
  const port = await listen(fixture.server);
  try {
    const result = await switchMcpWorkspaceConfirmed(port, 'test-token', 'C:\\new-workspace', {
      requestTimeoutMs: 2000,
      confirmTimeoutMs: 1000,
      intervalMs: 50,
    });
    assert.equal(result.responseRecovered, false);
    assert.equal(result.identity.workspace, 'C:\\new-workspace');
    assert.equal(fixture.workspace(), 'C:\\new-workspace');
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('workspace switch treats a lost control response as successful when health confirms the target', async () => {
  const fixture = createWorkspaceControlServer({ responseDelayMs: 1200 });
  const port = await listen(fixture.server);
  try {
    const result = await switchMcpWorkspaceConfirmed(port, 'test-token', 'C:\\new-workspace', {
      requestTimeoutMs: 1000,
      confirmTimeoutMs: 1000,
      intervalMs: 50,
    });
    assert.equal(result.responseRecovered, true);
    assert.equal(result.identity.workspace, 'C:\\new-workspace');
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('workspace switch uses a long request timeout instead of the old five-second cutoff', async () => {
  const fixture = createWorkspaceControlServer({ responseDelayMs: 80 });
  const port = await listen(fixture.server);
  try {
    const result = await switchMcpWorkspace(port, 'test-token', 'C:\\new-workspace', { timeoutMs: 6000 });
    assert.equal(result.ready, true);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
