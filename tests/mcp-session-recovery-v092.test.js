const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionTerminationMessage } = require('../electron/services/localMcpClient');

test('0.9.2 recognizes stale MCP session failures and ignores ordinary tool errors', () => {
  assert.equal(isSessionTerminationMessage('Session terminated'), true);
  assert.equal(isSessionTerminationMessage('MCP session not found'), true);
  assert.equal(isSessionTerminationMessage('session expired'), true);
  assert.equal(isSessionTerminationMessage('invalid MCP session'), true);
  assert.equal(isSessionTerminationMessage('tool execution failed'), false);
});
