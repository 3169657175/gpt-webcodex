const test = require('node:test');
const assert = require('node:assert/strict');

const { recoveryLayerFor } = require('../electron/services/runtimeOrchestrator');

test('recovery layer preserves MCP when only Tunnel is down', () => {
  assert.equal(recoveryLayerFor({ mcpRunning: true, tunnelRunning: false }), 'tunnel');
  assert.equal(recoveryLayerFor({ mcpRunning: false, tunnelRunning: true }), 'runtime');
  assert.equal(recoveryLayerFor({ mcpRunning: false, tunnelRunning: false }), 'runtime');
  assert.equal(recoveryLayerFor({ mcpRunning: true, tunnelRunning: true }), '');
});
