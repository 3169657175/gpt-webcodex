const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../renderer/progressPresentation');

const now = Date.parse('2026-09-24T02:00:00Z');

test('running task shows actual step, next step and elapsed time', () => {
  const result = describe({
    status: 'active', lifecycle_state: 'running', objective: '改造界面',
    current_step: '运行自动测试', next_step: '检查安装包',
    steps: [{ status: 'completed' }, { status: 'running' }, { status: 'pending' }],
    created_at: '2026-09-24T01:58:30Z', updated_at: '2026-09-24T01:59:40Z',
    current_command: { kind: 'test', status: 'running' }
  }, null, null, now);
  assert.equal(result.key, 'active');
  assert.equal(result.message, '运行自动测试');
  assert.match(result.detail, /下一步：检查安装包/);
  assert.match(result.detail, /阶段 1\/3/);
  assert.equal(result.elapsed, '1 分 30 秒');
});

test('model generation is distinguished from local execution', () => {
  const result = describe(null, null, { status: 'generating', updatedAt: now - 18000 }, now);
  assert.equal(result.key, 'generating');
  assert.match(result.message, /ChatGPT 正在生成/);
  assert.match(result.detail, /尚未收到工具调用/);
  assert.equal(result.elapsed, '18 秒');
});

test('waiting for model is not displayed as a running local command', () => {
  const result = describe({ status: 'waiting', lifecycle_state: 'waiting_model', current_step: '准备文件' }, null, null, now);
  assert.equal(result.key, 'waiting');
  assert.match(result.message, /等待下一步调用/);
});

test('background heartbeat makes long work visibly alive even without new command output', () => {
  const result = describe({
    status: 'active', lifecycle_state: 'running', objective: '长任务',
    current_step: '运行完整测试', next_step: '生成安装包',
    created_at: '2026-09-24T01:55:00Z', updated_at: '2026-09-24T01:59:00Z'
  }, {
    status: 'running', started_at: '2026-09-24T01:58:00Z', heartbeat_age_seconds: 5
  }, null, now);
  assert.equal(result.key, 'active');
  assert.match(result.detail, /后台任务心跳正常/);
  assert.equal(result.elapsed, '2 分 0 秒');
});

test('stale background heartbeat is surfaced instead of looking silently frozen', () => {
  const result = describe({
    status: 'active', lifecycle_state: 'running', objective: '长任务',
    current_step: '运行完整测试', created_at: '2026-09-24T01:55:00Z'
  }, {
    status: 'running', started_at: '2026-09-24T01:58:00Z', heartbeat_age_seconds: 45
  }, null, now);
  assert.equal(result.key, 'active');
  assert.match(result.detail, /后台任务心跳已 45 秒未更新/);
});

test('terminal failure takes precedence over a stale page generation marker', () => {
  const result = describe({ status: 'failed', failure: 'Git worktree operation timed out.' }, null, { status: 'generating' }, now);
  assert.equal(result.key, 'failed');
  assert.match(result.message, /Git worktree operation timed out/);
});

test('stream recovery polling timeout is shown as recoverable page state, not local task failure', () => {
  const result = describe(null, null, {
    status: 'interrupted', event: 'page-stream-recovery-timeout', updatedAt: now - 5000
  }, now);
  assert.equal(result.key, 'waiting');
  assert.match(result.message, /网页回复恢复超时/);
  assert.match(result.detail, /本地任务状态/);
});

test('quiet ChatGPT generation becomes actionable instead of looking alive forever', () => {
  const result = describe(null, null, {
    status: 'generating', stalled: true, quietSeconds: 61, updatedAt: now - 61000
  }, now);
  assert.equal(result.key, 'stalled');
  assert.equal(result.action, 'stop-generation');
  assert.match(result.message, /没有新内容/);
});

test('dynamic page asset errors offer a safe manual reload', () => {
  const result = describe(null, null, {
    status: 'asset_error', event: 'page-asset-error', detail: 'Failed to fetch dynamically imported module'
  }, now);
  assert.equal(result.key, 'failed');
  assert.equal(result.action, 'reload-page');
  assert.match(result.detail, /动态|Failed|刷新/);
});

test('active local command remains visible when the ChatGPT page stream is interrupted', () => {
  const result = describe({
    status: 'active', lifecycle_state: 'running', current_step: '运行完整测试',
    created_at: '2026-09-24T01:59:00Z'
  }, null, { status: 'interrupted' }, now, true, {
    command: {
      status: 'running', started_at: '2026-09-24T01:59:10Z',
      last_output_at: '2026-09-24T01:59:58Z', latest_output: 'collecting tests\n18 passed'
    }
  });
  assert.equal(result.key, 'active');
  assert.match(result.message, /运行完整测试/);
  assert.match(result.detail, /最新输出：18 passed/);
  assert.match(result.detail, /页面连接异常.*本地执行仍在继续/);
});

test('failed status refresh preserves the last active state instead of reporting idle', () => {
  const result = describe({
    status: 'active', lifecycle_state: 'running', current_step: '构建安装包',
    created_at: '2026-09-24T01:58:00Z'
  }, null, { status: 'unknown' }, now, false, {
    command: { status: 'running', started_at: '2026-09-24T01:58:30Z' }
  }, true);
  assert.equal(result.key, 'waiting');
  assert.match(result.message, /暂不可确认/);
  assert.match(result.detail, /最后一次成功读取/);
});

test('page interruption takes precedence over a waiting-model marker', () => {
  const result = describe({
    status: 'waiting', lifecycle_state: 'waiting_model', current_step: '等待模型继续'
  }, null, { status: 'interrupted' }, now);
  assert.equal(result.key, 'failed');
  assert.match(result.message, /连接已中断/);
});

