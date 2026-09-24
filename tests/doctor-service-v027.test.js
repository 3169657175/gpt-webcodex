const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadDoctorWithState(fakeState) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './jsonStore' && parent?.filename?.endsWith('doctorService.js')) return { readJson: () => fakeState };
    if (request === '../paths' && parent?.filename?.endsWith('doctorService.js')) return { stateFile: () => 'fake-state.json' };
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../electron/services/doctorService')];
  const mod = require('../electron/services/doctorService');
  Module._load = original;
  return mod;
}

function fixture(overrides = {}) {
  const settingsValue = { workspace: 'C:/work', mcpPort: 18765, healthPort: 18081, tunnelId: 'tunnel-secret-id', proxyMode: 'auto' };
  const secretState = { runtimeApiKey: true, mcpAuthToken: true };
  const snapshot = {
    environment: { python: { version: 'Python 3.12.10' }, proxy: { configured: true, url: 'http://127.0.0.1:7890', source: 'auto-local' } },
    status: {
      runtimeRunning: true,
      tunnelRunning: true,
      tunnelDiagnostics: { localReady: true, adminReady: true, upstreamReachable: true, clientInstanceId: 'client-abcdef123456', mainChannelReady: true, mainChannelProbe: 'ok' }
    }
  };
  const health = {
    environment: snapshot.environment,
    schemaIdentity: {
      expected: { runtime_version: '0.4.13', schema_version: 7, schema_hash: 'expectedhash' },
      runtime: { version: '0.4.13', schemaVersion: 7, schemaHash: 'runtimehash123456', processId: 4321, runtimeInstanceId: 'runtime-abcdef123456' }
    }
  };
  return {
    settings: { load: () => ({ ...settingsValue, ...(overrides.settings || {}) }) },
    secrets: { status: () => ({ ...secretState, ...(overrides.secrets || {}) }) },
    environment: { inspect: async () => snapshot.environment },
    orchestrator: { snapshot: async () => ({ ...snapshot, ...(overrides.snapshot || {}) }) },
    healthService: { inspect: async () => ({ ...health, ...(overrides.health || {}) }) },
    log: { read: () => [{ time: 'now', level: 'error', message: 'Authorization: Bearer super-secret-token Cookie=session-secret api_key=key-secret limited failure' }, { time: 'now', level: 'info', message: 'skip' }] },
    getChatState: () => ({ mcpAttachment: { status: 'attached', detail: '' } }),
    appVersion: '0.2.8',
    probeDirectFn: async () => true,
    probeHttpProxyFn: async () => true
  };
}

test('DoctorService builds read-only layered diagnosis without secret values', async () => {
  const { DoctorService } = loadDoctorWithState({ nativePid: 111, tunnelPid: 222 });
  const result = await new DoctorService(fixture()).inspect();
  assert.equal(result.severity, 'ready');
  assert.deepEqual(result.checks.map((item) => item.id), ['runtime','tunnel_admin','control_plane','main_channel','attachment','configuration']);
  assert.equal(result.network.directReachable, true);
  assert.equal(result.network.proxyReachable, true);
  assert.equal(result.process.runtimePid, 4321);
  assert.equal(result.process.tunnelPid, 222);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /tunnel-secret-id/);
  assert.doesNotMatch(serialized, /Bearer/i);
  assert.doesNotMatch(serialized, /super-secret-token|session-secret|key-secret/);
  assert.match(serialized, /已隐藏/);
});

test('DoctorService distinguishes local Tunnel survival from upstream and main-channel failures', async () => {
  const { DoctorService } = loadDoctorWithState({ nativePid: 111, tunnelPid: 222 });
  const deps = fixture();
  deps.orchestrator.snapshot = async () => ({
    environment: { python: { version: 'Python 3.12' }, proxy: { configured: false, source: 'direct' } },
    status: { runtimeRunning: true, tunnelRunning: true, tunnelDiagnostics: { localReady: true, adminReady: true, upstreamReachable: false, mainChannelReady: false, mainChannelProbe: 'degraded' } }
  });
  deps.healthService.inspect = async () => ({
    environment: { python: { version: 'Python 3.12' }, proxy: { configured: false, source: 'direct' } },
    schemaIdentity: { expected: { runtime_version: '0.4.13', schema_version: 7 }, runtime: { version: '0.4.13', schemaVersion: 7, processId: 4321 } }
  });
  deps.probeDirectFn = async () => false;
  const result = await new DoctorService(deps).inspect();
  assert.equal(result.checks.find((item) => item.id === 'tunnel_admin').state, 'ready');
  assert.equal(result.checks.find((item) => item.id === 'control_plane').state, 'warn');
  assert.equal(result.checks.find((item) => item.id === 'main_channel').state, 'warn');
  assert.equal(result.network.directReachable, false);
  assert.equal(result.severity, 'warn');
});

test('DoctorService does not perform public network probes when network=false', async () => {
  const { DoctorService } = loadDoctorWithState({});
  let probes = 0;
  const deps = fixture();
  deps.probeDirectFn = async () => { probes += 1; return true; };
  deps.probeHttpProxyFn = async () => { probes += 1; return true; };
  const result = await new DoctorService(deps).inspect({ network: false });
  assert.equal(probes, 0);
  assert.equal(result.network.directReachable, null);
  assert.equal(result.network.proxyReachable, null);
});


test('Support Report filename and final redaction stay bounded and shareable', async () => {
  const { DoctorService, redactSensitivePaths, supportReportFilename, renderSupportReport } = loadDoctorWithState({ nativePid: 111, tunnelPid: 222 });
  const deps = fixture();
  deps.log = { read: () => [{
    time: 'now', level: 'error',
    message: 'command=do-danger Authorization: Bearer final-secret Cookie=cookie-secret C:\\Users\\private-user\\Desktop\\secret /Users/alice/work /home/bob/repo'
  }] };
  const report = await new DoctorService(deps).createSupportReport({ date: new Date(2026, 7, 28, 15, 42), network: false });
  assert.equal(report.filename, 'support-report-20260828-1542.txt');
  assert.match(report.text, /Support Report/);
  assert.match(report.text, /Runtime API Key configured: 是/);
  assert.doesNotMatch(report.text, /final-secret|cookie-secret|private-user|\/Users\/alice|\/home\/bob/);
  assert.match(report.text, /%USERPROFILE%|\$HOME/);
  assert.doesNotMatch(report.text, /tunnel-secret-id/);
  assert.equal(supportReportFilename(new Date(2026, 0, 2, 3, 4)), 'support-report-20260102-0304.txt');
  assert.equal(redactSensitivePaths('C:\\Users\\name\\Desktop\\x'), '%USERPROFILE%\\Desktop\\x');
  assert.doesNotMatch(renderSupportReport({ recentErrors: [{ message: 'token=abc123456' }] }), /abc123456/);
});
