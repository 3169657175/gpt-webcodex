const api = window.browserAssistant;
const $ = (selector) => document.querySelector(selector);
let switching = false;
let activeWorkspace = '';
let lastRuntimeState = null;
let lastRuntimeCheckAt = 0;
let workspaceHubState = { workspaces: [] };
let lastApprovalRequestId = '';
let lastStreamState = { status: 'unknown', updatedAt: 0 };
let progressInput = { task: null, operation: null, activity: null, runtimeLayers: null, feedbackCapabilities: null, available: true, stale: false };
let taskRefreshPromise = null;
let lastTaskRefreshAt = 0;
let taskRefreshWarning = '';
let nativeLoginState = { status: 'idle', message: '' };
let loginState = { status: 'idle', mode: '', prompt: false };
let activityPopoverPinned = false;
let activityDetailVisible = false;
let activityOpenTimer = null;
let activityCloseTimer = null;

function withTimeout(promise, timeoutMs, label = '请求') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function taskPresentation(task, runningOperation, streamState, available = true, activity = null, runtimeLayers = null) {
  const view = window.progressPresentation.describe(task, runningOperation, streamState, Date.now(), available, activity, !available, runtimeLayers);
  return { key: view.key, label: view.userState === 'testing' ? '测试中' : view.userState === 'building' ? '构建中' : view.userState === 'waiting_model' ? '等待模型' : view.userState === 'waiting_user' ? '等待处理' : view.userState === 'quiet' ? '仍在运行' : view.userState === 'suspected_stall' ? '疑似停滞' : view.userState === 'stalled' ? '疑似卡住' : view.userState === 'generating' ? '模型处理中' : view.key === 'failed' ? '失败' : view.key === 'completed' ? '已完成' : view.key === 'stopped' ? '已停止' : view.key === 'idle' ? '空闲' : '执行中', detail: view.message, canStop: Boolean(view.canStop) };
}

function formatActivityTime(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
}

function formatActivityDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function clearActivityTimers() {
  if (activityOpenTimer) clearTimeout(activityOpenTimer);
  if (activityCloseTimer) clearTimeout(activityCloseTimer);
  activityOpenTimer = null;
  activityCloseTimer = null;
}

function activityAnchorPayload(anchor) {
  const rect = (anchor || $('#progressDetailTrigger')).getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function openActivityPanel(anchor, { pin = false } = {}) {
  if ($('#activityToggle')?.hidden) return;
  clearActivityTimers();
  if (pin) activityPopoverPinned = true;
  activityDetailVisible = true;
  void api.activityDetailShow?.({
    anchor: activityAnchorPayload(anchor),
    pinned: activityPopoverPinned,
    payload: buildActivityDetailPayload()
  });
  $('#activityToggle')?.setAttribute('aria-expanded', 'true');
  $('#progressDetailTrigger')?.setAttribute('aria-expanded', 'true');
  if ($('#activityToggle')) $('#activityToggle').textContent = activityPopoverPinned ? '收起详情' : '活动详情';
}

function closeActivityPanel({ force = false } = {}) {
  if (activityPopoverPinned && !force) return;
  clearActivityTimers();
  if (force) {
    activityPopoverPinned = false;
    activityDetailVisible = false;
    void api.activityDetailClose?.();
    $('#activityToggle')?.setAttribute('aria-expanded', 'false');
    $('#progressDetailTrigger')?.setAttribute('aria-expanded', 'false');
  } else {
    void api.activityDetailHide?.();
  }
}

function scheduleActivityOpen(anchor) {
  if ($('#activityToggle')?.hidden) return;
  if (activityCloseTimer) clearTimeout(activityCloseTimer);
  activityOpenTimer = setTimeout(() => openActivityPanel(anchor), 150);
}

function scheduleActivityClose() {
  if (activityPopoverPinned) return;
  if (activityOpenTimer) clearTimeout(activityOpenTimer);
  activityCloseTimer = setTimeout(() => closeActivityPanel(), 180);
}

function buildActivityDetailPayload() {
  const { task, operation, activity, runtimeLayers, feedbackCapabilities, available, stale } = progressInput;
  const command = activity?.command && typeof activity.command === 'object'
    ? activity.command
    : (task?.current_command && typeof task.current_command === 'object' ? task.current_command : null);
  const lastCommand = task?.last_command && typeof task.last_command === 'object' ? task.last_command : null;
  const timeline = Array.isArray(activity?.timeline) ? activity.timeline : [];
  const view = window.progressPresentation.describe(task, operation, lastStreamState, Date.now(), available, activity, stale, runtimeLayers);
  const stateLabel = {
    testing: '正在测试', building: '正在构建', waiting_model: '等待 ChatGPT', waiting_user: '等待处理', quiet: '仍在运行',
    suspected_stall: '疑似停滞', stalled: '疑似卡住', local_running: '本地运行中', planning: '正在规划', recovering: '正在恢复',
    completed: '已完成', failed: '失败', stopped: '已停止', generating: '模型处理中'
  }[view.userState || view.key] || view.key || '—';
  const commandRunning = command?.status === 'running'
    || command?.execution_lifecycle_state === 'running'
    || runtimeLayers?.process?.state === 'running'
    || runtimeLayers?.execution?.state === 'running';
  const stage = commandRunning
    ? '正在执行本地命令'
    : (task?.current_step || operation?.phase || operation?.status || (task?.status === 'completed' ? '本地任务已完成' : '—'));
  const lastActivityAt = command?.last_output_at || lastCommand?.finished_at || timeline.at(-1)?.timestamp || task?.updated_at || operation?.updated_at;
  let waitReason = '—';
  const lifecycle = String(task?.lifecycle_state || '');
  if (!available) waitReason = '等待本地状态连接恢复';
  else if (commandRunning) waitReason = command?.last_output_at ? '等待命令继续输出或结束' : '命令已启动，等待首段输出';
  else if (lifecycle === 'waiting_model') waitReason = '等待 ChatGPT 发起下一次工具调用';
  else if (operation && ['running', 'queued'].includes(String(operation.status || ''))) waitReason = operation.status === 'queued' ? '等待后台执行槽位' : '等待后台阶段完成';
  else if (lastStreamState.status === 'generating') waitReason = '等待网页端发起本地工具调用';
  const nativeStatus = feedbackCapabilities?.chatgpt_tool_invocation_status?.supported;
  const desktopStream = feedbackCapabilities?.desktop_activity_stream?.supported;
  const lastResultStatus = lastCommand?.status || task?.latest_test_result?.status || task?.latest_build_result?.status || '';
  const lastExitCode = lastCommand?.exit_code;
  const lastResult = lastResultStatus
    ? `${lastResultStatus}${lastExitCode == null ? '' : ` · exit ${lastExitCode}`}${lastCommand?.elapsed_ms == null ? '' : ` · ${formatActivityDuration(lastCommand.elapsed_ms)}`}`
    : '—';
  const output = String(command?.latest_output || '').trim();
  return {
    status: view.message,
    capturedAt: `${stale ? '最后成功读取 ' : '状态读取 '}${formatActivityTime(activity?.captured_at || task?.updated_at)}`,
    state: stateLabel,
    stage,
    elapsed: view.elapsed || formatActivityDuration(command?.elapsed_ms ?? lastCommand?.elapsed_ms),
    lastSeen: formatActivityTime(lastActivityAt),
    heartbeat: view.heartbeatAge == null ? '—' : `${Math.floor(view.heartbeatAge)} 秒前`,
    process: runtimeLayers?.process?.state === 'running' ? '运行中' : runtimeLayers?.process?.state === 'background' ? '后台任务' : (view.canStop ? '运行中' : '无本地命令'),
    waitReason,
    nextStep: task?.next_step || (view.userState === 'waiting_model' ? '等待 ChatGPT 继续' : '—'),
    channel: nativeStatus && desktopStream ? 'ChatGPT 调用提示 + 桌面实时状态' : desktopStream ? '桌面实时状态' : '任务状态快照',
    taskId: task?.task_id || '—',
    runId: task?.run_id || operation?.run_id || '—',
    operationId: operation?.operation_id || '—',
    lastResult,
    diagnosis: view.diagnostic || (view.userState === 'waiting_model' ? '本地执行已经结束，目前在等待 ChatGPT 继续。' : '当前没有发现异常。'),
    command: command?.command || '',
    output: output || (commandRunning ? '命令已启动，尚无输出。' : '尚无命令输出。'),
    outputMeta: commandRunning ? '实时更新' : '',
    timeline: timeline.slice(-8).reverse().map((event) => ({
      label: event.label || event.type || '状态更新',
      detail: event.detail || event.step || '',
      time: formatActivityTime(event.timestamp)
    }))
  };
}

function renderActivityPanel() {
  const toggle = $('#activityToggle');
  if (!toggle) return;
  const { task, operation, activity, runtimeLayers } = progressInput;
  const command = activity?.command || task?.current_command;
  const hasContent = Boolean(task || operation || command || (Array.isArray(activity?.timeline) && activity.timeline.length) || runtimeLayers);
  toggle.hidden = !hasContent;
  if (!hasContent) {
    activityPopoverPinned = false;
    activityDetailVisible = false;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '活动详情';
    void api.activityDetailClose?.();
    return;
  }
  const view = window.progressPresentation.describe(progressInput.task, progressInput.operation, lastStreamState, Date.now(), progressInput.available, progressInput.activity, progressInput.stale, progressInput.runtimeLayers);
  if (!activityDetailVisible) toggle.textContent = ['quiet', 'suspected_stall', 'stalled'].includes(view.userState) ? '为什么看起来卡住了？' : '活动详情';
  if (activityDetailVisible) void api.activityDetailUpdate?.(buildActivityDetailPayload());
}

function renderChatState(state) {
  if (!state) return;
  lastStreamState = state.streamState || lastStreamState;
  nativeLoginState = state.nativeLogin || nativeLoginState;
  loginState = state.login || loginState;
  renderLogin();
  renderProgress();
  $('#backButton').disabled = !state.canGoBack;
  $('#forwardButton').disabled = !state.canGoForward;
  const element = $('#pageState');
  element.classList.toggle('loading', Boolean(state.loading));
  element.classList.toggle('ready', !state.loading && !state.error);
  element.classList.toggle('error', Boolean(state.error));
  element.querySelector('span').textContent = state.error
    ? `加载失败：${state.error}`
    : state.url?.startsWith('https://accounts.google.com/') ? 'Google 登录请使用右侧「登录修复」'
    : state.loading ? '正在切换页面…' : 'ChatGPT 已就绪';
}

function renderProgress() {
  renderActivityPanel();
  const login = nativeLoginState;
  const activeLogin = login.active || ['starting', 'waiting', 'syncing', 'closing'].includes(login.status);
  $('#nativeLoginButton').disabled = ['starting', 'syncing', 'closing'].includes(login.status);
  $('#nativeLoginFinish').hidden = !['waiting', 'syncing'].includes(login.status);
  $('#nativeLoginFinish').disabled = login.status === 'syncing';
  $('#nativeLoginCancel').hidden = !activeLogin;
  $('#nativeLoginCancel').disabled = login.status === 'closing';
  if (activeLogin || ['error', 'success'].includes(login.status)) {
    $('#progressBand').className = `progress-band ${login.status === 'error' ? 'failed' : login.status === 'success' ? 'active' : 'waiting'}`;
    $('#progressMessage').textContent = login.status === 'success' ? 'ChatGPT 登录修复完成' : login.status === 'error' ? '登录修复未完成' : '浏览器登录修复';
    $('#progressDetail').textContent = login.cleanupWarning || login.message;
    $('#progressDetail').title = `${login.message}${login.cleanupWarning ? ` ${login.cleanupWarning}` : ''}`;
    $('#progressElapsed').textContent = '';
    $('#progressAction').hidden = true;
    return;
  }
  if (loginState.mode === 'embedded' && !loginState.prompt) {
    $('#progressBand').className = 'progress-band waiting';
    $('#progressMessage').textContent = loginState.returning ? '登录已确认，正在自动返回' : '正在应用内登录 ChatGPT';
    $('#progressDetail').textContent = loginState.message;
    $('#progressElapsed').textContent = '';
    $('#progressAction').hidden = true;
    return;
  }
  const view = window.progressPresentation.describe(
    progressInput.task,
    progressInput.operation,
    lastStreamState,
    Date.now(),
    progressInput.available,
    progressInput.activity,
    progressInput.stale,
    progressInput.runtimeLayers
  );
  const band = $('#progressBand');
  band.className = `progress-band ${view.key}`;
  $('#progressMessage').textContent = view.message;
  $('#progressDetail').textContent = view.detail;
  $('#progressElapsed').textContent = view.elapsed ? `已运行 ${view.elapsed}` : '';
  const action = $('#progressAction');
  if (action) {
    action.hidden = !view.action;
    action.textContent = view.actionLabel || '';
    action.dataset.action = view.action || '';
    action.title = view.actionLabel || '';
  }
}

function renderServiceState(state) {
  lastRuntimeState = state || null;
  lastRuntimeCheckAt = Date.now();
  const connectionRunning = state?.tunnelRunning;
  const schemaHint = $('#schemaRefreshHint');
  if (schemaHint) {
    schemaHint.hidden = !state?.chatSchemaRefreshRecommended;
    schemaHint.title = state?.schemaRefreshNotice?.message || '如果当前聊天在工具升级前已经打开，请新建聊天刷新 MCP 工具参数。';
  }
  const label = $('#connectionStateLabel');
  if (label) label.textContent = '连接通道';
  [['#mcpState', state?.mcpRunning], ['#tunnelState', connectionRunning]].forEach(([selector, value]) => {
    const element = $(selector);
    element.classList.toggle('ready', Boolean(value));
    element.classList.toggle('error', !value);
  });
  renderWorkspaceHealth();
}

function renderWorkspaceHealth() {
  const button = $('#workspaceHealthButton');
  if (!button) return;
  const synced = Boolean(activeWorkspace && lastRuntimeState?.mcpRunning);
  button.classList.toggle('ready', synced);
  button.classList.toggle('error', Boolean(activeWorkspace) && !synced);
  $('#workspaceHealthName').textContent = baseName(activeWorkspace) || '未选择工作区';
  $('#workspaceHealthPath').textContent = activeWorkspace || '-';
  $('#workspaceHealthState').textContent = !activeWorkspace ? '未选择' : synced ? '✓ 已同步' : lastRuntimeState?.recovering ? '正在恢复' : '等待同步';
  $('#workspaceHealthTime').textContent = lastRuntimeCheckAt ? new Date(lastRuntimeCheckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  button.title = !activeWorkspace ? '未选择工作区' : synced ? '工作区已与 MCP 同步' : '工作区正在等待 MCP 同步';
}

async function refreshStatus() {
  try { renderServiceState(unwrap(await withTimeout(api.lightweightStatus(), 2500, '连接状态读取'))); }
  catch { renderServiceState(null); }
}

async function refreshTask() {
  const strip = $('#taskStrip');
  if (!strip) return;
  if (taskRefreshPromise) return taskRefreshPromise;
  taskRefreshPromise = (async () => {
  try {
    let runtime = null;
    try { runtime = unwrap(await withTimeout(api.taskRuntime({ detail: 'compact' }), 2800, '任务状态读取')); } catch { runtime = null; }
    let task = runtime?.state || null;
    if (!task) {
      try { task = unwrap(await withTimeout(api.taskState(), 1600, '任务状态兜底读取'))?.state || null; } catch { task = null; }
    }
    const runningOperation = Array.isArray(runtime?.operations)
      ? runtime.operations.filter((item) => ['running', 'queued'].includes(String(item?.status || ''))).slice(-1)[0]
      : null;
    if (task && ['completed', 'failed', 'stopped'].includes(String(task.status || '')) && !runningOperation) {
      const updatedAt = Date.parse(task.updated_at || task.created_at || '') || Date.now();
      const keepVisibleMs = task.status === 'completed' ? 30000 : 120000;
      const newerChatTurn = lastStreamState.status === 'generating' && Number(lastStreamState.updatedAt || 0) > updatedAt;
      if (newerChatTurn || Date.now() - updatedAt > keepVisibleMs) task = null;
    }
    const stateAvailable = Boolean(runtime || task);
    if (stateAvailable) {
      progressInput = {
        task,
        operation: runningOperation,
        activity: runtime?.activity || progressInput.activity,
        runtimeLayers: runtime?.runtime_layers || progressInput.runtimeLayers,
        feedbackCapabilities: runtime?.feedback_capabilities || progressInput.feedbackCapabilities,
        available: true,
        stale: !runtime
      };
    } else {
      progressInput = { ...progressInput, available: false, stale: true };
    }
    lastTaskRefreshAt = Date.now();
    taskRefreshWarning = stateAvailable ? '' : '暂时无法确认本地任务状态，已保留最后一次结果并自动重试';
    renderProgress();
    const view = taskPresentation(progressInput.task, progressInput.operation, lastStreamState, progressInput.available, progressInput.activity, progressInput.runtimeLayers);
    strip.className = `task-strip ${view.key}`;
    $('#taskStatusLabel').textContent = view.label;
    $('#taskTitle').textContent = view.detail;
    $('#stopTask').hidden = !view.canStop;
  } catch {
    taskRefreshWarning = '任务状态读取失败，正在自动重试';
    progressInput = { ...progressInput, available: false, stale: true };
    renderProgress();
    const view = taskPresentation(progressInput.task, progressInput.operation, lastStreamState, false, progressInput.activity);
    strip.className = `task-strip ${view.key}`;
    $('#taskStatusLabel').textContent = view.label;
    $('#taskTitle').textContent = view.detail;
    $('#stopTask').hidden = true;
  }
  if (nativeLoginState.status === 'idle' && loginState.mode !== 'embedded' && taskRefreshWarning && !progressInput.task && !progressInput.operation) {
    $('#progressDetail').textContent = taskRefreshWarning;
  }
  })();
  try { return await taskRefreshPromise; } finally { taskRefreshPromise = null; }
}

async function refreshApprovals() {
  if (!api.approvalList || !api.openApprovalWindow) return;
  try {
    const payload = unwrap(await api.approvalList());
    const pending = Array.isArray(payload?.pending) ? payload.pending : [];
    const newest = pending[0]?.request_id || '';
    if (!newest) {
      lastApprovalRequestId = '';
      return;
    }
    if (newest === lastApprovalRequestId) return;
    lastApprovalRequestId = newest;
    await api.openApprovalWindow();
  } catch { /* approval polling must never disturb ChatGPT */ }
}

function renderWorkspace(hub) {
  workspaceHubState = hub || { workspaces: [] };
  activeWorkspace = hub.activeWorkspace || '';
  $('#activeWorkspace').textContent = activeWorkspace || '未选择';
  $('#activeWorkspace').title = activeWorkspace;
  renderWorkspaceHealth();
  const workspaces = Array.isArray(hub.workspaces)
    ? hub.workspaces
    : (hub.recentWorkspaces || []).filter(Boolean).map((workspace) => ({ path: workspace, name: baseName(workspace), active: workspace === activeWorkspace, status: 'ready' }));
  $('#workspacePickerButton').textContent = `全部工作区（${workspaces.length}）${Number(hub.invalidCount || 0) ? ` · ⚠ ${hub.invalidCount}` : ''}`;
}

async function refreshWorkspace() {
  try { renderWorkspace(unwrap(await api.workspaceHub())); }
  catch { /* retain the last usable workspace state */ }
}

async function switchWorkspace(workspace, showProgress = true) {
  if (switching || !workspace || workspace === activeWorkspace) return;
  switching = true;
  if (showProgress) $('#switchState').textContent = 'MCP 正在后台切换工作区…';
  try {
    unwrap(await api.switchWorkspace(workspace));
    $('#switchState').textContent = '工作区已就绪';
    await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
    setTimeout(() => { $('#switchState').textContent = ''; }, 1800);
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
}

async function navigate(action) {
  try { unwrap(await api.navigate(action)); }
  catch (error) { renderChatState({ error: error.message }); }
}

$('#backButton').onclick = () => navigate('back');
$('#forwardButton').onclick = () => navigate('forward');
$('#reloadButton').onclick = () => navigate('reload');
$('#homeButton').onclick = () => navigate('home');
async function runNativeLogin(method) {
  try { nativeLoginState = unwrap(await api[method]()); }
  catch (error) { nativeLoginState = { status: 'error', message: error.message }; }
  renderProgress();
  try { renderChatState(unwrap(await api.chatStatus())); } catch { /* retain the last visible login state */ }
  if (nativeLoginState.status === 'success') {
    setTimeout(() => {
      if (nativeLoginState.status === 'success') { nativeLoginState = { status: 'idle', message: '' }; renderProgress(); }
    }, 12000);
  }
}
async function runLoginAction(method) {
  try { renderChatState(unwrap(await api[method]())); }
  catch (error) { $('#loginDialogMessage').textContent = error.message; }
}
function renderLogin() {
  const dialog = $('#loginDialog');
  if (!loginState.prompt) { if (dialog.open) dialog.close(); return; }
  const external = loginState.mode === 'native';
  const busy = external && ['starting', 'syncing', 'closing'].includes(nativeLoginState.status);
  $('#loginDialogTitle').textContent = external ? nativeLoginState.status === 'syncing' ? '登录已检测到，正在自动返回' : '请在浏览器窗口完成登录'
    : loginState.kind === 'blocked' ? '登录需要重新连接' : '在助手内登录 ChatGPT';
  $('#loginDialogMessage').textContent = loginState.message;
  $('#loginDialogBadge').textContent = external ? 'CHATGPT · 自动返回已开启' : 'CHATGPT · 应用内登录';
  $('#embeddedLoginStart').hidden = external;
  $('#embeddedLoginStart').textContent = loginState.kind === 'blocked' ? '在应用内重新登录' : '在应用内继续登录';
  $('#loginBrowserFallback').hidden = external && Boolean(nativeLoginState.active);
  $('#loginBrowserFallback').textContent = external ? '重新打开浏览器登录窗口' : '应用内遇到问题？使用 Chrome 备用登录';
  $('#loginCheckNow').hidden = !external || !nativeLoginState.active;
  $('#loginCheckNow').disabled = busy;
  $('#loginDialogCancel').disabled = external && nativeLoginState.status === 'closing';
  $('#loginDialogCancel').textContent = external ? '取消登录，返回助手' : '暂不登录，返回页面';
  $('#loginDialogNote').textContent = external ? '成功后会自动同步并返回助手，无需点击右上角按钮。遇到问题可点「立即检查」。不读取日常 Chrome 配置。'
    : '登录过程保持在应用内，账号验证完成后自动返回聊天。不会把“看到聊天页面”误当作已经登录。';
  if (!dialog.open) dialog.showModal();
}
$('#nativeLoginButton').onclick = () => runLoginAction('openLogin');
$('#embeddedLoginStart').onclick = () => runLoginAction('embeddedLogin');
$('#loginBrowserFallback').onclick = () => runNativeLogin('nativeLoginStart');
$('#loginCheckNow').onclick = () => runNativeLogin('nativeLoginFinish');
$('#loginDialogCancel').onclick = () => runLoginAction('dismissLogin');
$('#loginDialog').addEventListener('cancel', (event) => { event.preventDefault(); void runLoginAction('dismissLogin'); });
$('#nativeLoginFinish').onclick = () => runNativeLogin('nativeLoginFinish');
$('#nativeLoginCancel').onclick = () => runNativeLogin('nativeLoginCancel');
$('#progressAction').onclick = async () => {
  const action = $('#progressAction').dataset.action;
  try {
    if (action === 'stop-generation') {
      await api.stopGeneration?.();
      await refreshTask();
    } else if (action === 'reload-page') {
      await navigate('reload');
    }
  } catch (error) { $('#switchState').textContent = error.message; }
};
$('#activityToggle').onclick = (event) => {
  event.stopPropagation();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel($('#progressDetailTrigger'), { pin: true });
};
const progressDetailTrigger = $('#progressDetailTrigger');
progressDetailTrigger?.addEventListener('mouseenter', () => scheduleActivityOpen(progressDetailTrigger));
progressDetailTrigger?.addEventListener('mouseleave', scheduleActivityClose);
progressDetailTrigger?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel(progressDetailTrigger, { pin: true });
});
progressDetailTrigger?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (activityDetailVisible && activityPopoverPinned) closeActivityPanel({ force: true });
  else openActivityPanel(progressDetailTrigger, { pin: true });
});
$('#workspaceHealthButton').onclick = (event) => {
  event.stopPropagation();
  const popover = $('#workspaceHealthPopover');
  const nextHidden = !popover.hidden;
  popover.hidden = nextHidden;
  $('#workspaceHealthButton').setAttribute('aria-expanded', String(!nextHidden));
};
document.addEventListener('click', (event) => {
  const label = $('#workspaceLabel');
  if (label?.contains(event.target)) return;
  const popover = $('#workspaceHealthPopover');
  if (popover && !popover.hidden) {
    popover.hidden = true;
    $('#workspaceHealthButton').setAttribute('aria-expanded', 'false');
  }
  const progressDetailTrigger = $('#progressDetailTrigger');
  const activityToggle = $('#activityToggle');
  if (activityPopoverPinned && !progressDetailTrigger?.contains(event.target) && !activityToggle?.contains(event.target)) closeActivityPanel({ force: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activityDetailVisible) closeActivityPanel({ force: true });
});
api.onActivityDetailState?.((state) => {
  activityDetailVisible = Boolean(state?.visible);
  activityPopoverPinned = Boolean(state?.pinned);
  $('#activityToggle')?.setAttribute('aria-expanded', String(activityDetailVisible));
  $('#progressDetailTrigger')?.setAttribute('aria-expanded', String(activityDetailVisible));
  if ($('#activityToggle')) $('#activityToggle').textContent = activityPopoverPinned ? '收起详情' : '活动详情';
});
$('#managerButton').onclick = () => api.openManager();
$('#workspacePickerButton').onclick = (event) => {
  event.stopPropagation();
  api.openWorkspaceWindow?.().catch((error) => { $('#switchState').textContent = error.message; });
};
$('#stopTask').onclick = async () => {
  if (!window.confirm('停止当前正在执行的本地任务？')) return;
  try { unwrap(await api.stopTask()); await refreshTask(); }
  catch (error) { $('#switchState').textContent = error.message; }
};
$('#addAuthorizedRootQuick').onclick = async () => {
  if (switching) return;
  switching = true;
  $('#switchState').textContent = '请选择要授权的额外目录…';
  try {
    const result = unwrap(await api.chooseAuthorizedRoot());
    $('#switchState').textContent = result?.selected ? `已授权：${baseName(result.selected)}` : '';
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
};
$('#addWorkspace').onclick = async () => {
  if (switching) return;
  switching = true;
  $('#switchState').textContent = '请选择工作目录…';
  try {
    const result = unwrap(await api.chooseAndSwitchWorkspace());
    if (result) {
      $('#switchState').textContent = '工作区已添加';
      await Promise.all([refreshWorkspace(), refreshStatus(), refreshTask()]);
    } else {
      $('#switchState').textContent = '';
    }
  } catch (error) {
    $('#switchState').textContent = error.message;
  } finally {
    switching = false;
  }
};

api.onChatState(renderChatState);
api.onHeartbeat(renderServiceState);
api.onTaskEvent?.(() => refreshTask());
api.onWorkspaceChanged?.(renderWorkspace);
api.onDownload((item) => {
  const node = $('#downloadState');
  const openButton = $('#openDownloadButton');
  if (item.status === 'completed') {
    node.textContent = `已保存：${baseName(item.path)}`;
    if (openButton) openButton.hidden = false;
  }
  else if (item.status === 'progressing') node.textContent = `附件 ${item.totalBytes ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0}%`;
  else if (item.error) { node.textContent = item.error; if (openButton) openButton.hidden = true; }
});
$('#openDownloadButton').onclick = () => api.openLastDownload?.().catch((error) => { $('#downloadState').textContent = error.message; });
api.chatStatus().then((result) => renderChatState(unwrap(result))).catch(() => {});
refreshStatus();
refreshWorkspace();
refreshTask();
refreshApprovals();
setInterval(refreshWorkspace, 15000);
setInterval(refreshTask, 1000);
setInterval(renderProgress, 1000);
setInterval(refreshApprovals, 3000);
