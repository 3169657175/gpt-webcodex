const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceState } = require('../renderer/assistantState');
const fs = require('node:fs');

test('0.9.2 canonical service state collapses startup details when healthy', () => {
  const ready = serviceState({ workspaceReady: true, runtimeRunning: true, tunnelRunning: true, connectionRunning: true, attachmentReady: true });
  assert.equal(ready.key, 'ready');
  assert.equal(ready.showStartup, false);
  const recovering = serviceState({ workspaceReady: true, runtimeRunning: true, tunnelRunning: false, connectionRunning: false, recovering: true });
  assert.equal(recovering.key, 'recovering');
  assert.equal(recovering.showStartup, true);
});

test('0.9.2 React status strip consumes canonical serviceState instead of raw service flags', () => {
  const source = fs.readFileSync('renderer-ui/src/manager.tsx', 'utf8');
  const statusStrip = source.slice(source.indexOf('function StatusStrip'), source.indexOf('function WorkspaceStrip'));
  assert.match(statusStrip, /state\.serviceState/);
  assert.doesNotMatch(statusStrip, /runtimeRunning|tunnelRunning|connectionRunning/);
});
