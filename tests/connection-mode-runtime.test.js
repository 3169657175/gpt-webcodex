const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HealthService } = require('../electron/services/healthService');

function makeHealth() {
  const settings = {
    load: () => ({
      connectionMode: 'official',
      workspace: 'C:\\work',
      mcpPort: 18765,
      healthPort: 18081,
      tunnelId: 'tunnel_demo'
    }),
    save: (patch) => patch
  };
  const secrets = {
    status: () => ({ runtimeApiKey: true, mcpAuthToken: true })
  };
  const environment = {
    inspect: async () => ({
      python: { installed: true, version: 'Python 3.12' },
      workspace: { exists: true },
      tunnelClient: { installed: true },
      ports: { mcpListening: true, tunnelListening: true }
    })
  };
  const orchestrator = {
    native: { status: async () => true },
    tunnel: { status: async () => true },
    ensureToken: async () => 'token',
    restart: async () => true
  };
  return new HealthService({ settings, secrets, environment, orchestrator });
}

test('health always checks the official MCP and Tunnel chain', async () => {
  const report = await makeHealth().inspect();
  const ids = report.checks.map((item) => item.id);
  assert.equal(report.healthy, true);
  for (const id of ['runtime-key', 'tunnel-id', 'tunnel-client', 'tunnel-port', 'tunnel']) assert.ok(ids.includes(id));
  assert.ok(!ids.includes('bridge'));
});

test('runtime orchestrator has no DOM Bridge channel', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'electron/services/runtimeOrchestrator.js'), 'utf8');
  assert.match(source, /this\.tunnel\.start/);
  assert.doesNotMatch(source, /this\.bridge|bridgeRunning|bridge-start|bridge-local/);
  assert.match(source, /connectionStatus/);
  assert.match(source, /const connectionRunning = tunnelRunning/);
  assert.match(source, /fullyReady: runtimeRunning && connectionRunning/);
});
