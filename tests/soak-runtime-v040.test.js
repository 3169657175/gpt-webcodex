const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// The npm electron package exports the executable path in plain Node. Stub
// only the app paths needed by runtimeOrchestrator so this test exercises the
// real supervisor without launching an Electron renderer.
const electronModuleId = require.resolve('electron');
require.cache[electronModuleId] = {
  id: electronModuleId, filename: electronModuleId, loaded: true,
  exports: { app: { isPackaged: false, getAppPath: function () { return process.cwd(); }, getPath: function () { return path.join(os.tmpdir(), 'web-mcp-soak-electron'); } } }
};
const { RuntimeOrchestrator } = require('../electron/services/runtimeOrchestrator');

function makeOrchestrator() {
  const settingsValue = {
    workspace: process.cwd(),
    mcpPort: 18765,
    healthPort: 18081,
    tunnelId: 'soak-tunnel',
    autoStartServices: true
  };
  const settings = { load: () => ({ ...settingsValue }), save: (patch) => ({ ...settingsValue, ...patch }) };
  const secrets = { get: () => 'token', set: () => {} };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const orchestrator = new RuntimeOrchestrator({
    settings,
    secrets,
    environment: {},
    log,
    emitProgress: () => {},
    emitStatus: () => {}
  });
  orchestrator.isManuallyStopped = function () { return false; };
  orchestrator.setManualStop(false);
  return orchestrator;
}

test('upstream-only tunnel outage never restarts a healthy local runtime', async () => {
  const orchestrator = makeOrchestrator();
  let tunnelRestarts = 0;
  let fullRestarts = 0;
  orchestrator.restartTunnel = async () => { tunnelRestarts += 1; };
  orchestrator.restart = async () => { fullRestarts += 1; };
  orchestrator.lightweightSnapshot = async () => ({
    fullyReady: false,
    mcpRunning: true,
    tunnelRunning: true,
    tunnelUpstreamReachable: false,
    connectionRunning: false,
    busy: false,
    recovering: false,
    manuallyStopped: false
  });

  for (let index = 0; index < 12; index += 1) await orchestrator.supervise();
  assert.equal(tunnelRestarts, 0);
  assert.equal(fullRestarts, 0);
  assert.equal(orchestrator.heartbeatFailures, 0);
});

test('local tunnel failure reaches its threshold and restarts only the tunnel layer', async () => {
  const orchestrator = makeOrchestrator();
  let tunnelRestarts = 0;
  let fullRestarts = 0;
  orchestrator.restartTunnel = async () => { tunnelRestarts += 1; };
  orchestrator.restart = async () => { fullRestarts += 1; };
  orchestrator.lightweightSnapshot = async () => ({
    fullyReady: false,
    mcpRunning: true,
    tunnelRunning: false,
    tunnelUpstreamReachable: false,
    connectionRunning: false,
    busy: false,
    recovering: false,
    manuallyStopped: false
  });

  for (let index = 0; index < 6; index += 1) await orchestrator.supervise();
  assert.equal(tunnelRestarts, 1);
  assert.equal(fullRestarts, 0);
  assert.equal(orchestrator.heartbeatFailures, 0);
  assert.equal(orchestrator.recoveryAttempts, 0);
});
