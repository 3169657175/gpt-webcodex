const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryLayerFor } = require('../electron/services/runtimeOrchestrator');
const { tunnelAdminState } = require('../electron/services/tunnelService');

test('0.9.2 healthy Runtime with a broken upstream recovers only the Tunnel layer', () => {
  assert.equal(recoveryLayerFor({ mcpRunning: true, tunnelRunning: true, connectionRunning: false }), 'tunnel');
  assert.equal(recoveryLayerFor({ mcpRunning: true, tunnelRunning: false, connectionRunning: false }), 'tunnel');
  assert.equal(recoveryLayerFor({ mcpRunning: false, tunnelRunning: true, connectionRunning: true }), 'runtime');
  assert.equal(recoveryLayerFor({ mcpRunning: true, tunnelRunning: true, connectionRunning: true }), '');
});

test('0.9.2 Tunnel health requires a ready main channel and matching control-plane identity', () => {
  const ok = tunnelAdminState({ control_plane_tunnel_id: 'tunnel_a', channels: [{ name: 'main', probe_status: 'ok' }] }, 'tunnel_a');
  assert.deepEqual([ok.adminReady, ok.mainChannelReady, ok.controlPlaneReady], [true, true, true]);
  const broken = tunnelAdminState({ control_plane_tunnel_id: 'tunnel_b', channels: [{ name: 'main', probe_status: 'failed' }] }, 'tunnel_a');
  assert.equal(broken.mainChannelReady, false);
  assert.equal(broken.controlPlaneReady, false);
});
