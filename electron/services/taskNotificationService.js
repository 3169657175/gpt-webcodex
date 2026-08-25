function clip(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function durationSeconds(state, nowMs) {
  const started = Date.parse(String(state?.created_at || ''));
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${Math.floor(value)} 秒`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function needsHumanAttention(state) {
  const lifecycle = String(state?.lifecycle_state || '');
  if (lifecycle === 'needs_user') return true;
  if (lifecycle === 'waiting_model') return false;
  if (String(state?.status || '') !== 'waiting') return false;
  const text = [state?.current_step, state?.next_step, state?.failure]
    .filter(Boolean)
    .join(' ');
  return /(waiting\s+for\s+(user|approval|permission|confirmation|input|review)|needs?\s+(user|approval|permission|confirmation|input)|requires?\s+(approval|permission|confirmation|input)|用户|人工|确认|授权|批准|输入|选择|审阅|审核)/i.test(text);
}

function eventForState(state) {
  const lifecycle = String(state?.lifecycle_state || '');
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'failed') return 'failed';
  if (lifecycle === 'cancelled') return 'stopped';
  if (lifecycle === 'needs_user') return 'attention';
  const status = String(state?.status || 'idle');
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  if (needsHumanAttention(state)) return 'attention';
  return null;
}

function titleForEvent(event) {
  return {
    completed: '任务已完成',
    failed: '任务执行失败',
    stopped: '任务已中断',
    attention: '任务需要你的处理'
  }[event] || '任务状态更新';
}

function latestFailedResult(state) {
  const results = [
    ...(Array.isArray(state?.test_results) ? state.test_results : []),
    ...(Array.isArray(state?.build_results) ? state.build_results : [])
  ].filter((item) => item && item.status === 'failed');
  return results.at(-1) || null;
}

function completedResultSummary(state, elapsed) {
  const parts = [];
  const files = Array.isArray(state?.modified_files) ? state.modified_files.length : 0;
  const tests = Array.isArray(state?.test_results) ? state.test_results : [];
  const builds = Array.isArray(state?.build_results) ? state.build_results : [];
  const report = state?.last_build_report && typeof state.last_build_report === 'object'
    ? state.last_build_report
    : null;
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts.length : 0;
  const passedTests = tests.filter((item) => item?.status === 'passed').length;
  const passedBuilds = builds.filter((item) => item?.status === 'passed').length;

  if (files) parts.push(`修改 ${files} 个文件`);
  if (passedTests) parts.push(`测试通过 ${passedTests} 项`);
  if (passedBuilds || report?.overall_status === 'passed') parts.push('构建通过');
  if (artifacts) parts.push(`产物 ${artifacts} 个`);
  parts.push(`耗时 ${formatDuration(elapsed)}`);
  return clip(parts.join(' · '), 180);
}

function notificationDetail(event, state, elapsed) {
  if (event === 'completed') return completedResultSummary(state, elapsed);
  if (event === 'failed') {
    const failed = latestFailedResult(state);
    return clip(
      state?.failure
        || failed?.summary
        || failed?.command
        || state?.current_step
        || '请打开助手查看失败详情。',
      180
    );
  }
  if (event === 'attention') {
    return clip(state?.current_step || state?.next_step || state?.failure || '任务正在等待你的确认或输入。', 180);
  }
  if (event === 'stopped') {
    return clip(state?.failure || state?.current_step || state?.next_step || '任务已停止执行。', 180);
  }
  return '';
}

function taskbarState(state) {
  const lifecycle = String(state?.lifecycle_state || '');
  if (['created', 'preparing', 'running', 'waiting_model'].includes(lifecycle)) return { progress: 2, mode: 'indeterminate' };
  if (['paused', 'needs_user'].includes(lifecycle)) return { progress: 1, mode: 'paused' };
  if (['failed', 'cancelled'].includes(lifecycle)) return { progress: 1, mode: 'error' };
  const status = String(state?.status || 'idle');
  if (status === 'active') return { progress: 2, mode: 'indeterminate' };
  if (status === 'paused' || needsHumanAttention(state)) return { progress: 1, mode: 'paused' };
  if (status === 'failed' || status === 'stopped') return { progress: 1, mode: 'error' };
  return { progress: -1, mode: 'none' };
}

function taskCanBeBlockedByRuntime(state) {
  const lifecycle = String(state?.lifecycle_state || '');
  if (lifecycle) return ['created', 'preparing', 'running', 'waiting_model'].includes(lifecycle);
  const status = String(state?.status || 'idle');
  return status === 'active' || (status === 'waiting' && !needsHumanAttention(state));
}

function runtimeOutageLabel(status) {
  const mcpDown = status?.mcpRunning === false;
  const tunnelDown = status?.tunnelRunning === false;
  if (mcpDown && tunnelDown) return '本地工具与连接通道均已断开';
  if (mcpDown) return '本地工具服务已断开';
  if (tunnelDown) return '网页连接通道已断开';
  return '本地工具连接异常';
}

const TASK_EVENT_NOTIFICATION = Object.freeze({
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'stopped',
  'task.needs_user': 'attention'
});

function runKey(state) {
  return String(state?.run_id || state?.task_id || '');
}

class TaskNotificationService {
  constructor(options = {}) {
    this.getSettings = options.getSettings || (() => ({}));
    this.getWorkspace = options.getWorkspace || (() => '');
    this.readTaskState = options.readTaskState || (() => null);
    this.subscribeTaskEvents = options.subscribeTaskEvents || null;
    this.loadNotificationCheckpoint = options.loadNotificationCheckpoint || (() => null);
    this.saveNotificationCheckpoint = options.saveNotificationCheckpoint || (() => {});
    this.getChatWindow = options.getChatWindow || (() => null);
    this.getTray = options.getTray || (() => null);
    this.showChatWindow = options.showChatWindow || (() => {});
    this.NotificationClass = options.NotificationClass;
    this.icon = options.icon || undefined;
    this.log = options.log || null;
    this.now = options.now || (() => Date.now());
    this.pollIntervalMs = Math.max(5000, Number(options.pollIntervalMs || 30000));
    this.streamWarningIntervalMs = Math.max(5000, Number(options.streamWarningIntervalMs || 30000));
    this.lastStreamWarningAt = 0;
    this.timer = null;
    this.unsubscribeStream = null;
    this.workspace = null;
    this.lastState = null;
    this.lastRuntimeStatus = null;
    this.runtimeOutage = null;
    this.runtimeHealthyRunId = '';
    this.notifiedKeys = new Set();
    this.notifiedOrder = [];
    this.checkpointWorkspace = '';
    this.lastEventId = 0;
    this.checkpointInitialized = false;
    this.checkpointPersistDelayMs = Math.max(50, Number(options.checkpointPersistDelayMs || 750));
    this.checkpointTimer = null;
    this.checkpointDirty = false;
    this.checkpointPendingWorkspace = '';
    this.notificationDiagnostics = [];
  }

  start() {
    if (this.timer || this.unsubscribeStream) return;
    this.poll().catch(() => {});
    this.startStream();
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushCheckpoint();
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
  }

  startStream() {
    if (!this.subscribeTaskEvents || this.unsubscribeStream) return;
    const workspace = String(this.getWorkspace() || '');
    const checkpoint = this.activateCheckpoint(workspace);
    try {
      this.unsubscribeStream = this.subscribeTaskEvents(
        (payload) => payload?.type
          ? this.acceptTaskEvent(payload)
          : this.acceptState(payload?.state ?? payload, payload?.workspace),
        (error) => this.reportStreamWarning(error, '任务事件流暂时不可用，正在自动重新连接。'),
        {
          lastEventId: checkpoint.lastEventId,
          baselineLatest: !checkpoint.initialized,
          onBaseline: (eventId) => this.setEventBaseline(workspace, eventId)
        }
      );
    } catch (error) {
      this.reportStreamWarning(error, '任务事件流启动失败，已保留低频状态同步作为兜底。');
    }
  }

  reportStreamWarning(error, message) {
    const now = this.now();
    if (this.lastStreamWarningAt && now - this.lastStreamWarningAt < this.streamWarningIntervalMs) return;
    this.lastStreamWarningAt = now;
    this.log?.warn?.(message, { error: error?.message || String(error) });
  }

  restartStream() {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.startStream();
  }

  reset() {
    this.flushCheckpoint();
    this.workspace = null;
    this.lastState = null;
    this.lastRuntimeStatus = null;
    this.runtimeOutage = null;
    this.runtimeHealthyRunId = '';
    this.checkpointWorkspace = '';
    this.lastEventId = 0;
    this.checkpointInitialized = false;
    this.notifiedKeys = new Set();
    this.notifiedOrder = [];
  }

  activateCheckpoint(workspace) {
    const target = String(workspace || '');
    if (target && target === this.checkpointWorkspace) {
      return { initialized: this.checkpointInitialized, lastEventId: this.lastEventId };
    }
    let checkpoint = null;
    try { checkpoint = this.loadNotificationCheckpoint(target); } catch { checkpoint = null; }
    this.checkpointWorkspace = target;
    this.checkpointInitialized = checkpoint?.initialized === true;
    this.lastEventId = this.checkpointInitialized ? Math.max(0, Number(checkpoint?.lastEventId || 0)) : 0;
    this.notifiedKeys = new Set();
    this.notifiedOrder = [];
    const remembered = Array.isArray(checkpoint?.notifiedKeys) ? checkpoint.notifiedKeys.slice(-120) : [];
    for (const raw of remembered) {
      const key = String(raw || '');
      if (!key || this.notifiedKeys.has(key)) continue;
      this.notifiedKeys.add(key);
      this.notifiedOrder.push(key);
    }
    return { initialized: this.checkpointInitialized, lastEventId: this.lastEventId };
  }

  persistCheckpoint(workspace = this.checkpointWorkspace || this.getWorkspace()) {
    const target = String(workspace || '');
    if (!target) return;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.checkpointDirty = false;
    this.checkpointPendingWorkspace = '';
    try {
      this.saveNotificationCheckpoint(target, {
        initialized: true,
        lastEventId: Math.max(0, Number(this.lastEventId || 0)),
        notifiedKeys: this.notifiedOrder.slice(-120)
      });
      this.checkpointInitialized = true;
    } catch { /* notification persistence must never break task execution */ }
  }

  scheduleCheckpointPersist(workspace = this.checkpointWorkspace || this.getWorkspace()) {
    const target = String(workspace || '');
    if (!target) return;
    this.checkpointDirty = true;
    this.checkpointPendingWorkspace = target;
    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      if (this.checkpointDirty) this.persistCheckpoint(this.checkpointPendingWorkspace || target);
    }, this.checkpointPersistDelayMs);
    this.checkpointTimer.unref?.();
  }

  flushCheckpoint() {
    if (!this.checkpointDirty) {
      if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
      return;
    }
    const target = this.checkpointPendingWorkspace || this.checkpointWorkspace || this.getWorkspace();
    this.persistCheckpoint(target);
  }

  setEventBaseline(workspace, eventId) {
    this.activateCheckpoint(workspace);
    this.lastEventId = Math.max(this.lastEventId, Math.max(0, Number(eventId || 0)));
    this.persistCheckpoint(workspace);
  }

  async poll() {
    const workspace = String(this.getWorkspace() || '');
    let state = null;
    try {
      state = await Promise.resolve(this.readTaskState());
    } catch {
      state = null;
    }

    this.acceptState(state, workspace);
  }

  recordDiagnostic(entry) {
    const item = { time: new Date(this.now()).toISOString(), ...entry };
    this.notificationDiagnostics = [...this.notificationDiagnostics, item].slice(-100);
    return item;
  }

  getDiagnostics() {
    return this.notificationDiagnostics.map((item) => ({ ...item }));
  }

  hasNotificationKey(key) {
    return Boolean(key && this.notifiedKeys.has(key));
  }

  rememberNotificationKey(key) {
    if (!key || this.notifiedKeys.has(key)) return;
    this.notifiedKeys.add(key);
    this.notifiedOrder.push(key);
    while (this.notifiedOrder.length > 300) this.notifiedKeys.delete(this.notifiedOrder.shift());
  }

  semanticNotificationKey(event, state) {
    const key = runKey(state);
    return key && event ? `run:${key}:${event}` : '';
  }

  acceptTaskEvent(record) {
    if (!record || typeof record !== 'object') return;
    const workspace = String(record.workspace || this.getWorkspace() || '');
    this.activateCheckpoint(workspace);
    const eventIdNumber = Math.max(0, Number(record.event_id || 0));
    const state = record.state && typeof record.state === 'object' ? record.state : null;
    if (workspace !== this.workspace) {
      this.workspace = workspace;
      this.lastState = null;
      this.runtimeOutage = null;
      this.runtimeHealthyRunId = '';
    }
    if (state) {
      const previousRun = runKey(this.lastState);
      this.lastState = { ...state };
      this.updateShell(state);
      const currentRun = runKey(state);
      if (currentRun && currentRun !== previousRun) {
        this.runtimeOutage = null;
        this.runtimeHealthyRunId = this.lastRuntimeStatus?.fullyReady ? currentRun : '';
      }
    }

    if (eventIdNumber > this.lastEventId) {
      this.lastEventId = eventIdNumber;
    }
    const notificationEvent = TASK_EVENT_NOTIFICATION[String(record.type || '')];
    if (!notificationEvent || !state) {
      if (eventIdNumber) this.scheduleCheckpointPersist(workspace);
      return;
    }
    const eventKey = eventIdNumber > 0 ? `event:${eventIdNumber}` : '';
    const semanticKey = this.semanticNotificationKey(notificationEvent, state);
    if (this.hasNotificationKey(eventKey) || this.hasNotificationKey(semanticKey)) {
      if (eventIdNumber) this.scheduleCheckpointPersist(workspace);
      this.recordDiagnostic({ event: record.type, eventId: record.event_id || null, runId: runKey(state), shown: false, reason: '重复事件' });
      return;
    }
    const settings = this.getSettings() || {};
    if (!settings.taskNotifications) {
      if (eventIdNumber) this.scheduleCheckpointPersist(workspace);
      this.recordDiagnostic({ event: record.type, eventId: record.event_id || null, runId: runKey(state), shown: false, reason: '桌面任务提醒已关闭' });
      return;
    }
    this.rememberNotificationKey(eventKey);
    this.rememberNotificationKey(semanticKey);
    this.persistCheckpoint(workspace);
    this.showEvent(notificationEvent, state, durationSeconds(state, this.now()), settings, {
      sourceEvent: record.type,
      eventId: record.event_id || null
    });
  }

  acceptState(state, workspaceValue = this.getWorkspace()) {
    const workspace = String(workspaceValue || '');
    if (workspace !== this.workspace) {
      this.activateCheckpoint(workspace);
      this.workspace = workspace;
      this.lastState = state && typeof state === 'object' ? { ...state } : null;
      this.runtimeHealthyRunId = taskCanBeBlockedByRuntime(state) && this.lastRuntimeStatus?.fullyReady ? runKey(state) : '';
      this.updateShell(state);
      return;
    }

    const previous = this.lastState;
    this.lastState = state && typeof state === 'object' ? { ...state } : null;
    this.updateShell(state);
    if (!state || !state.task_id) return;

    const event = eventForState(state);
    if (!event) return;
    const previousEvent = previous?.task_id === state.task_id ? eventForState(previous) : null;
    const transitioned = previous?.task_id !== state.task_id || previousEvent !== event;
    if (!transitioned) return;

    const settings = this.getSettings() || {};
    if (!settings.taskNotifications) return;
    const elapsed = durationSeconds(state, this.now());
    const semanticKey = this.semanticNotificationKey(event, state);
    if (this.hasNotificationKey(semanticKey)) return;
    this.rememberNotificationKey(semanticKey);
    this.showEvent(event, state, elapsed, settings, { sourceEvent: 'legacy-state-fallback', eventId: null });
  }

  isForeground() {
    const window = this.getChatWindow();
    return Boolean(window && !window.isDestroyed?.() && window.isVisible?.() && window.isFocused?.());
  }

  acceptRuntimeStatus(status) {
    if (!status || typeof status !== 'object') return;
    this.lastRuntimeStatus = { ...status };
    const currentRun = runKey(this.lastState);

    if (status.fullyReady) {
      if (currentRun && taskCanBeBlockedByRuntime(this.lastState)) this.runtimeHealthyRunId = currentRun;
      const outage = this.runtimeOutage;
      this.runtimeOutage = null;
      if (!outage?.notified) return;
      const settings = this.getSettings() || {};
      if (!settings.taskNotifications) return;
      const objective = clip(this.lastState?.objective || outage.objective || '当前任务', 120);
      this.showRuntimeNotification(
        '连接已恢复',
        `${objective}\n本地工具与网页连接通道已恢复，可以继续执行任务。`,
        settings,
        'runtime-recovered'
      );
      return;
    }

    if (status.manuallyStopped) {
      this.runtimeOutage = null;
      return;
    }
    if (status.busy || status.recovering) return;
    if (!taskCanBeBlockedByRuntime(this.lastState)) return;
    if (!currentRun || this.runtimeHealthyRunId !== currentRun) return;
    if (Number(status.failures || 0) < 2) return;
    if (this.runtimeOutage) return;

    const settings = this.getSettings() || {};
    const outage = {
      mcpDown: status.mcpRunning === false,
      tunnelDown: status.tunnelRunning === false,
      objective: this.lastState?.objective || '',
      runId: currentRun,
      notified: false
    };
    this.runtimeOutage = outage;
    if (!settings.taskNotifications) return;
    const objective = clip(this.lastState?.objective || '当前任务', 120);
    outage.notified = this.showRuntimeNotification(
      '任务连接中断',
      `${objective}\n${runtimeOutageLabel(status)}。任务可能暂时无法继续，助手正在尝试自动恢复。`,
      settings,
      'runtime-outage'
    );
  }

  updateShell(state) {
    const window = this.getChatWindow();
    const { progress, mode } = taskbarState(state);
    if (window && !window.isDestroyed?.() && typeof window.setProgressBar === 'function') {
      try { window.setProgressBar(progress, { mode }); } catch { /* platform may not support progress state */ }
    }
    const tray = this.getTray();
    if (tray && !tray.isDestroyed?.()) {
      const status = String(state?.status || 'idle');
      const objective = clip(state?.objective, 42);
      const label = {
        active: '任务进行中', waiting: needsHumanAttention(state) ? '等待你的处理' : '任务等待中',
        paused: '任务已暂停', failed: '任务失败', stopped: '任务已中断', completed: '任务已完成'
      }[status] || '后台运行中';
      try { tray.setToolTip(`网页 MCP 助手 · ${label}${objective ? ` · ${objective}` : ''}`); } catch { /* no-op */ }
    }
  }

  showEvent(event, state, elapsed, settings = this.getSettings() || {}, metadata = {}) {
    const NotificationClass = this.NotificationClass;
    if (!NotificationClass || (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported())) {
      this.recordDiagnostic({ event: metadata.sourceEvent || event, eventId: metadata.eventId || null, runId: runKey(state), shown: false, reason: '当前系统不支持桌面通知' });
      return false;
    }
    const objective = clip(state?.objective || '当前任务', 120);
    const detail = notificationDetail(event, state, elapsed);
    try {
      const notification = new NotificationClass({
        title: `网页 MCP 助手 · ${titleForEvent(event)}`,
        body: `${objective}${detail ? `\n${detail}` : ''}`,
        icon: this.icon,
        silent: !settings.taskNotificationSound,
        timeoutType: 'default'
      });
      notification.on?.('click', () => this.showChatWindow());
      notification.show();
      this.recordDiagnostic({ event: metadata.sourceEvent || event, eventId: metadata.eventId || null, runId: runKey(state), shown: true, reason: '已请求 Windows 显示' });
      this.log?.info?.('已发送任务桌面通知', { event, taskId: state?.task_id, runId: state?.run_id, objective });
      return true;
    } catch (error) {
      this.recordDiagnostic({ event: metadata.sourceEvent || event, eventId: metadata.eventId || null, runId: runKey(state), shown: false, reason: 'Windows 通知调用失败', error: error?.message || String(error) });
      this.log?.warn?.('Windows 任务通知调用失败', { event, error: error?.message || String(error) });
      return false;
    }
  }

  showRuntimeNotification(title, body, settings = this.getSettings() || {}, event = 'runtime') {
    const NotificationClass = this.NotificationClass;
    if (!NotificationClass || (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported())) {
      this.recordDiagnostic({ event, runId: runKey(this.lastState), shown: false, reason: '当前系统不支持桌面通知' });
      return false;
    }
    try {
      const notification = new NotificationClass({
        title: `网页 MCP 助手 · ${title}`,
        body: String(body || '').slice(0, 260),
        icon: this.icon,
        silent: !settings.taskNotificationSound,
        timeoutType: 'default'
      });
      notification.on?.('click', () => this.showChatWindow());
      notification.show();
      this.recordDiagnostic({ event, runId: runKey(this.lastState), shown: true, reason: '已请求 Windows 显示' });
      this.log?.info?.('已发送运行环境桌面通知', { event, taskId: this.lastState?.task_id });
      return true;
    } catch (error) {
      this.recordDiagnostic({ event, runId: runKey(this.lastState), shown: false, reason: 'Windows 通知调用失败', error: error?.message || String(error) });
      return false;
    }
  }

  testNotification() {
    const settings = this.getSettings() || {};
    const NotificationClass = this.NotificationClass;
    if (!NotificationClass || (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported())) {
      throw new Error('当前系统不支持桌面通知。');
    }
    const notification = new NotificationClass({
      title: '网页 MCP 助手 · 桌面提醒测试',
      body: '任务完成、失败、中断或需要你处理时，会在 Windows 右下角提醒你。',
      icon: this.icon,
      silent: !settings.taskNotificationSound,
      timeoutType: 'default'
    });
    notification.on?.('click', () => this.showChatWindow());
    notification.show();
    return true;
  }
}

module.exports = {
  TaskNotificationService,
  completedResultSummary,
  durationSeconds,
  eventForState,
  notificationDetail,
  needsHumanAttention,
  runtimeOutageLabel,
  taskCanBeBlockedByRuntime,
  taskbarState
};
