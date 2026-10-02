const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../renderer/assistantState');

test('0.9.0 AssistantState normalizes rendering and notification semantics', () => {
  const waiting = state.describe({ status: 'waiting', lifecycle_state: 'waiting_model' }, null, null);
  assert.equal(waiting.userState, 'waiting_model');
  assert.equal(state.labelFor(waiting), '等待模型');
  assert.equal(state.eventForState({ status: 'waiting', lifecycle_state: 'waiting_model', last_heartbeat_at: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-01T00:10:00Z')), null);
  assert.equal(state.taskbarState({ status: 'waiting', lifecycle_state: 'waiting_model' }).mode, 'paused');
});

test('0.9.0 AssistantState keeps stalled local work distinct from waiting model', () => {
  const now = Date.parse('2026-10-01T00:02:00Z');
  assert.equal(state.eventForState({ status: 'active', lifecycle_state: 'running', last_heartbeat_at: '2026-10-01T00:00:00Z' }, now), 'stalled');
  assert.equal(state.needsHumanAttention({ status: 'waiting', lifecycle_state: 'waiting_user', current_step: '等待用户输入' }), true);
  assert.equal(state.labelFor({ userState: 'stalled' }), '疑似卡住');
  assert.equal(state.toneFor({ userState: 'stalled' }), 'danger');
});
