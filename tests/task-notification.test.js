const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TaskNotificationService,
  completedResultSummary,
  eventForState,
  notificationDetail,
  needsHumanAttention,
  runtimeOutageLabel,
  taskCanBeBlockedByRuntime,
  taskbarState
} = require('../electron/services/taskNotificationService');

class FakeNotification {
  static instances = [];
  static isSupported() { return true; }
  constructor(options) {
    this.options = options;
    this.handlers = {};
    FakeNotification.instances.push(this);
  }
  on(name, handler) { this.handlers[name] = handler; }
  show() { this.shown = true; }
}

function makeWindow({ focused = false } = {}) {
  return {
    progress: [],
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    setProgressBar(progress, options) { this.progress.push({ progress, options }); }
  };
}

function makeService(overrides = {}) {
  let state = overrides.initialState || null;
  let workspace = 'C:\\work';
  let settings = {
    taskNotifications: true,
    taskNotificationOnlyWhenUnfocused: false,
    taskNotificationSound: true,
    taskNotificationMinSeconds: 0,
    ...(overrides.settings || {})
  };
  const window = overrides.window || makeWindow();
  const shown = [];
  const service = new TaskNotificationService({
    getSettings: () => settings,
    getWorkspace: () => workspace,
    readTaskState: () => state,
    subscribeTaskEvents: overrides.subscribeTaskEvents || null,
    loadNotificationCheckpoint: overrides.loadNotificationCheckpoint || (() => null),
    saveNotificationCheckpoint: overrides.saveNotificationCheckpoint || (() => {}),
    getChatWindow: () => window,
    getTray: () => null,
    showChatWindow: () => shown.push('chat'),
    NotificationClass: FakeNotification,
    now: () => Date.parse('2026-08-11T10:10:00Z')
  });
  return {
    service, window, shown,
    setState(value) { state = value; },
    setWorkspace(value) { workspace = value; },
    setSettings(value) { settings = { ...settings, ...value }; }
  };
}

test('task state boundaries distinguish real attention from ordinary model waiting', () => {
  assert.equal(needsHumanAttention({ status: 'waiting', current_step: 'Waiting for model' }), false);
  assert.equal(needsHumanAttention({ status: 'waiting', current_step: '等待用户确认是否继续' }), true);
  assert.equal(eventForState({ status: 'completed' }), 'completed');
  assert.equal(eventForState({ status: 'failed' }), 'failed');
  assert.equal(eventForState({ status: 'stopped' }), 'stopped');
  assert.equal(eventForState({ status: 'waiting', next_step: 'Waiting for user input' }), 'attention');
  assert.equal(taskbarState({ status: 'active' }).mode, 'indeterminate');
  assert.equal(taskbarState({ status: 'failed' }).mode, 'error');
});

test('completed notification summary reports useful local task results', () => {
  const state = {
    modified_files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }],
    test_results: [{ status: 'passed' }, { status: 'passed' }],
    build_results: [{ status: 'passed' }],
    last_build_report: { overall_status: 'passed', artifacts: [{ path: 'dist/app.exe' }] }
  };
  const summary = completedResultSummary(state, 125);
  assert.match(summary, /修改 3 个文件/);
  assert.match(summary, /测试通过 2 项/);
  assert.match(summary, /构建通过/);
  assert.match(summary, /产物 1 个/);
  assert.match(summary, /耗时 2 分钟/);
});

test('failure and attention summaries prefer actionable details', () => {
  assert.equal(notificationDetail('failed', { failure: 'npm test: 2 tests failed' }, 1), 'npm test: 2 tests failed');
  assert.equal(notificationDetail('failed', {
    test_results: [{ status: 'failed', summary: 'AssertionError: expected true' }]
  }, 1), 'AssertionError: expected true');
  assert.equal(notificationDetail('attention', {
    current_step: '等待用户确认是否覆盖 release 文件'
  }, 1), '等待用户确认是否覆盖 release 文件');
  assert.equal(notificationDetail('stopped', {
    failure: '用户从助手停止任务'
  }, 1), '用户从助手停止任务');
});

test('completion notification fires once after a real state transition and click returns to chat', async () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  ctx.setState({ task_id: 't1', status: 'active', objective: '修复登录问题', created_at: '2026-08-11T10:00:00Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 0);
  ctx.setState({
    task_id: 't1', status: 'completed', objective: '修复登录问题', created_at: '2026-08-11T10:00:00Z',
    modified_files: [{ path: 'src/login.js' }], test_results: [{ status: 'passed' }]
  });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /任务已完成/);
  assert.match(FakeNotification.instances[0].options.body, /修改 1 个文件/);
  assert.match(FakeNotification.instances[0].options.body, /测试通过 1 项/);
  FakeNotification.instances[0].handlers.click();
  assert.deepEqual(ctx.shown, ['chat']);
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 1);
});

test('foreground completion still notifies while ordinary model waiting stays silent', async () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService({ window: makeWindow({ focused: true }) });
  ctx.setState({ task_id: 't2', run_id: 'r2', status: 'active', lifecycle_state: 'running', objective: '任务', created_at: '2026-08-11T10:09:59Z' });
  await ctx.service.poll();
  ctx.setState({ task_id: 't2', run_id: 'r2', status: 'waiting', lifecycle_state: 'waiting_model', current_step: 'Waiting for model', objective: '任务', created_at: '2026-08-11T10:09:59Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 0);
  ctx.setState({ task_id: 't2', run_id: 'r2', status: 'completed', lifecycle_state: 'completed', objective: '任务', created_at: '2026-08-11T10:09:59Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /任务已完成/);
});

test('attention and failures notify without duration gates', async () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  ctx.setState({ task_id: 't3', status: 'active', objective: '短任务', created_at: '2026-08-11T10:09:55Z' });
  await ctx.service.poll();
  ctx.setState({ task_id: 't3', status: 'waiting', current_step: 'Waiting for user confirmation', objective: '短任务', created_at: '2026-08-11T10:09:55Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 1);
  ctx.setState({ task_id: 't3', status: 'active', objective: '短任务', created_at: '2026-08-11T10:09:55Z' });
  await ctx.service.poll();
  ctx.setState({ task_id: 't3', status: 'failed', failure: '构建失败', objective: '短任务', created_at: '2026-08-11T10:09:55Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 2);
  assert.match(FakeNotification.instances[1].options.title, /失败/);
});

test('workspace switch establishes a silent baseline instead of notifying old finished work', async () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  ctx.setState({ task_id: 't4', status: 'active', objective: 'A', created_at: '2026-08-11T10:00:00Z' });
  await ctx.service.poll();
  ctx.setWorkspace('D:\\other');
  ctx.setState({ task_id: 'old', status: 'completed', objective: '旧任务', created_at: '2026-08-11T09:00:00Z' });
  await ctx.service.poll();
  assert.equal(FakeNotification.instances.length, 0);
});

test('canonical durable events notify immediately, deduplicate, and write diagnostics', () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService({ window: makeWindow({ focused: true }) });
  ctx.service.acceptTaskEvent({
    event_id: 1, type: 'task.started', workspace: 'C:\\work',
    state: { task_id: 'push1', run_id: 'run-push1', status: 'active', lifecycle_state: 'running', objective: '后台修复', created_at: '2026-08-11T10:09:59Z' }
  });
  ctx.service.acceptTaskEvent({
    event_id: 2, type: 'task.waiting_model', workspace: 'C:\\work',
    state: { task_id: 'push1', run_id: 'run-push1', status: 'waiting', lifecycle_state: 'waiting_model', objective: '后台修复', created_at: '2026-08-11T10:09:59Z' }
  });
  assert.equal(FakeNotification.instances.length, 0);
  const completed = {
    event_id: 3, type: 'task.completed', workspace: 'C:\\work',
    state: { task_id: 'push1', run_id: 'run-push1', status: 'completed', lifecycle_state: 'completed', objective: '后台修复', created_at: '2026-08-11T10:09:59Z' }
  };
  ctx.service.acceptTaskEvent(completed);
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /任务已完成/);
  ctx.service.acceptTaskEvent(completed);
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(ctx.service.getDiagnostics().at(-1).reason, '重复事件');
  assert.equal(ctx.service.getDiagnostics().some((item) => item.shown && item.event === 'task.completed'), true);
});

test('canonical needs-user event notifies while waiting-model event does not', () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  const base = { task_id: 'ask1', run_id: 'run-ask1', objective: '需要确认', created_at: '2026-08-11T10:09:59Z' };
  ctx.service.acceptTaskEvent({ event_id: 10, type: 'task.waiting_model', workspace: 'C:\\work', state: { ...base, status: 'waiting', lifecycle_state: 'waiting_model' } });
  assert.equal(FakeNotification.instances.length, 0);
  ctx.service.acceptTaskEvent({ event_id: 11, type: 'task.needs_user', workspace: 'C:\\work', state: { ...base, status: 'waiting', lifecycle_state: 'needs_user', current_step: '需要你确认是否继续' } });
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /需要你的处理/);
});

test('stream reconnect warnings are throttled while fallback polling stays available', () => {
  const warnings = [];
  const ctx = makeService();
  ctx.service.log = { warn: (...args) => warnings.push(args) };
  ctx.service.reportStreamWarning(new Error('offline'), 'stream offline');
  ctx.service.reportStreamWarning(new Error('offline again'), 'stream offline');
  assert.equal(warnings.length, 1);
  assert.equal(ctx.service.pollIntervalMs, 30000);
});

test('runtime outage helpers distinguish blocking tasks and failed services', () => {
  assert.equal(taskCanBeBlockedByRuntime({ status: 'active' }), true);
  assert.equal(taskCanBeBlockedByRuntime({ status: 'waiting', current_step: 'Waiting for model' }), true);
  assert.equal(taskCanBeBlockedByRuntime({ status: 'waiting', current_step: '等待用户确认' }), false);
  assert.equal(taskCanBeBlockedByRuntime({ status: 'paused' }), false);
  assert.equal(runtimeOutageLabel({ mcpRunning: false, tunnelRunning: true }), '本地工具服务已断开');
  assert.equal(runtimeOutageLabel({ mcpRunning: true, tunnelRunning: false }), '网页连接通道已断开');
});

test('runtime outage notifies once after two failures and once again on recovery', () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  ctx.service.acceptState({ task_id: 'runtime1', run_id: 'run-runtime1', status: 'active', lifecycle_state: 'running', objective: '后台重构' }, 'C:\\work');
  ctx.service.acceptRuntimeStatus({ fullyReady: true, mcpRunning: true, tunnelRunning: true, failures: 0 });
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: true, tunnelRunning: false, failures: 1 });
  assert.equal(FakeNotification.instances.length, 0);
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: true, tunnelRunning: false, failures: 2 });
  assert.equal(FakeNotification.instances.length, 1);
  assert.match(FakeNotification.instances[0].options.title, /任务连接中断/);
  assert.match(FakeNotification.instances[0].options.body, /网页连接通道已断开/);
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: true, tunnelRunning: false, failures: 4 });
  assert.equal(FakeNotification.instances.length, 1);
  ctx.service.acceptRuntimeStatus({ fullyReady: true, mcpRunning: true, tunnelRunning: true, failures: 0 });
  assert.equal(FakeNotification.instances.length, 2);
  assert.match(FakeNotification.instances[1].options.title, /连接已恢复/);
});

test('task that starts while runtime is already unhealthy does not raise a fake fresh outage', () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService();
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: false, failures: 4 });
  ctx.service.acceptState({ task_id: 'runtime-down', run_id: 'run-down', status: 'active', lifecycle_state: 'running', objective: '启动中的任务' }, 'C:\\work');
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: false, failures: 5 });
  assert.equal(FakeNotification.instances.length, 0);
});

test('intentional runtime changes and human-attention waits do not raise outage alerts', () => {
  FakeNotification.instances.length = 0;
  const active = makeService();
  active.service.acceptState({ task_id: 'runtime2', status: 'active', objective: '任务' }, 'C:\\work');
  active.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: false, failures: 3, busy: true });
  active.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: false, failures: 3, manuallyStopped: true });
  assert.equal(FakeNotification.instances.length, 0);

  const attention = makeService();
  attention.service.acceptState({ task_id: 'runtime3', status: 'waiting', objective: '等待选择', current_step: '等待用户确认' }, 'C:\\work');
  attention.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: true, failures: 3 });
  assert.equal(FakeNotification.instances.length, 0);
});

test('no healthy baseline never produces a recovery-only notification', () => {
  FakeNotification.instances.length = 0;
  const ctx = makeService({ window: makeWindow({ focused: true }) });
  ctx.service.acceptState({ task_id: 'runtime4', run_id: 'run-runtime4', status: 'active', lifecycle_state: 'running', objective: '前台任务' }, 'C:\\work');
  ctx.service.acceptRuntimeStatus({ fullyReady: false, mcpRunning: false, tunnelRunning: true, failures: 2 });
  ctx.service.acceptRuntimeStatus({ fullyReady: true, mcpRunning: true, tunnelRunning: true, failures: 0 });
  assert.equal(FakeNotification.instances.length, 0);
});

test('cold start establishes latest event baseline without replaying historical notifications', () => {
  FakeNotification.instances.length = 0;
  const saved = [];
  let streamOptions = null;
  const ctx = makeService({
    subscribeTaskEvents: (_listener, _onError, options) => {
      streamOptions = options;
      options.onBaseline(284);
      return () => {};
    },
    loadNotificationCheckpoint: () => null,
    saveNotificationCheckpoint: (_workspace, checkpoint) => saved.push(checkpoint)
  });
  ctx.service.start();
  assert.equal(streamOptions.baselineLatest, true);
  assert.equal(streamOptions.lastEventId, 0);
  assert.equal(saved.at(-1).initialized, true);
  assert.equal(saved.at(-1).lastEventId, 284);
  assert.equal(FakeNotification.instances.length, 0);
  ctx.service.stop();
});

test('persisted cursor resumes after the last event and semantic keys survive restart', () => {
  FakeNotification.instances.length = 0;
  const saved = [];
  let listener = null;
  let streamOptions = null;
  const ctx = makeService({
    subscribeTaskEvents: (nextListener, _onError, options) => {
      listener = nextListener;
      streamOptions = options;
      return () => {};
    },
    loadNotificationCheckpoint: () => ({
      initialized: true,
      lastEventId: 224,
      notifiedKeys: ['run:old-run:completed']
    }),
    saveNotificationCheckpoint: (_workspace, checkpoint) => saved.push(checkpoint)
  });
  ctx.service.start();
  assert.equal(streamOptions.baselineLatest, false);
  assert.equal(streamOptions.lastEventId, 224);
  listener({
    event_id: 225,
    type: 'task.completed',
    workspace: 'C:\\work',
    state: { task_id: 'new-task', run_id: 'new-run', status: 'completed', lifecycle_state: 'completed', objective: '新任务' }
  });
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(saved.at(-1).lastEventId, 225);
  assert.ok(saved.at(-1).notifiedKeys.includes('run:new-run:completed'));
  ctx.service.stop();
});
