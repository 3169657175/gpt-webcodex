const api = window.browserAssistant;
const $ = (selector) => document.querySelector(selector);
let switching = false;
let activeWorkspace = '';
let lastRuntimeState = null;
let lastRuntimeCheckAt = 0;
let workspaceHubState = { workspaces: [] };
let lastApprovalRequestId = '';
let lastStreamState = { status: 'unknown', updatedAt: 0 };
let progressInput = { task: null, operation: null, available: true };

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function taskPresentation(task, runningOperation) {
  const lifecycle = String(task?.lifecycle_state || '');
  const rawStatus = String(task?.status || '');
  const running = Boolean(runningOperation)
    || ['active', 'running', 'created', 'preparing'].includes(rawStatus)
    || ['created', 'preparing', 'running'].includes(lifecycle);
  const needsUser = ['needs_user', 'waiting_user', 'waiting_approval', 'paused'].includes(lifecycle)
    || rawStatus === 'paused'
    || (rawStatus === 'waiting' && lifecycle !== 'waiting_model');
  const failed = lifecycle === 'failed' || rawStatus === 'failed';
  const stopped = lifecycle === 'cancelled' || rawStatus === 'stopped';
  const completed = lifecycle === 'completed' || rawStatus === 'completed';
  if (running) return { key: 'active', label: '执行中', detail: task?.objective || '正在处理本地开发任务', canStop: true };
  if (lifecycle === 'waiting_model') return { key: 'waiting', label: '等待模型', detail: task?.current_step || task?.objective || '等待 ChatGPT 继续处理', canStop: false };
  if (needsUser) return { key: 'waiting', label: '等待处理', detail: task?.next_step || task?.current_step || task?.objective || '任务正在等待你的处理', canStop: false };
  if (failed) return { key: 'failed', label: '失败', detail: task?.failure || task?.objective || '任务执行失败', canStop: false };
  if (stopped) return { key: 'stopped', label: '已停止', detail: task?.objective || '任务已停止', canStop: false };
  if (completed) return { key: 'completed', label: '已完成', detail: task?.objective || '任务已完成', canStop: false };
  return { key: 'idle', label: '空闲', detail: '暂无任务', canStop: false };
}

function renderChatState(state) {
  if (!state) return;
  lastStreamState = state.streamState || lastStreamState;
  renderProgress();
  $('#backButton').disabled = !state.canGoBack;
  $('#forwardButton').disabled = !state.canGoForward;
  const element = $('#pageState');
  element.classList.toggle('loading', Boolean(state.loading));
  element.classList.toggle('ready', !state.loading && !state.error);
  element.classList.toggle('error', Boolean(state.error));
  element.querySelector('span').textContent = state.error
    ? `加载失败：${state.error}`
    : state.loading ? '正在切换页面…' : 'ChatGPT 已就绪';
}

function renderProgress() {
  const view = window.progressPresentation.describe(progressInput.task, progressInput.operation, lastStreamState, Date.now(), progressInput.available);
  const band = $('#progressBand');
  band.className = `progress-band ${view.key}`;
  $('#progressMessage').textContent = view.message;
  $('#progressDetail').textContent = view.detail;
  $('#progressElapsed').textContent = view.elapsed ? `已运行 ${view.elapsed}` : '';
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
  try { renderServiceState(unwrap(await api.lightweightStatus())); }
  catch { renderServiceState(null); }
}

async function refreshTask() {
  const strip = $('#taskStrip');
  if (!strip) return;
  try {
    let runtime = null;
    try { runtime = unwrap(await api.taskRuntime({ detail: 'compact' })); } catch { runtime = null; }
    let task = runtime?.state || null;
    if (!task) {
      try { task = unwrap(await api.taskState())?.state || null; } catch { task = null; }
    }
    const runningOperation = Array.isArray(runtime?.operations)
      ? runtime.operations.filter((item) => item?.status === 'running').slice(-1)[0]
      : null;
    if (task && ['completed', 'failed', 'stopped'].includes(String(task.status || '')) && !runningOperation) {
      const updatedAt = Date.parse(task.updated_at || task.created_at || '') || Date.now();
      const keepVisibleMs = task.status === 'completed' ? 30000 : 120000;
      const newerChatTurn = lastStreamState.status === 'generating' && Number(lastStreamState.updatedAt || 0) > updatedAt;
      if (newerChatTurn || Date.now() - updatedAt > keepVisibleMs) task = null;
    }
    progressInput = { task, operation: runningOperation, available: Boolean(runtime || task) || lastRuntimeState?.mcpRunning === false };
    renderProgress();
    const view = taskPresentation(task, runningOperation);
    strip.className = `task-strip ${view.key}`;
    $('#taskStatusLabel').textContent = view.label;
    $('#taskTitle').textContent = view.detail;
    $('#taskTitle').title = view.detail;
    $('#stopTask').hidden = !view.canStop;
    strip.title = view.canStop ? '任务正在后台执行；需要时可以停止' : view.detail;
  } catch {
    progressInput = { task: null, operation: null, available: false };
    renderProgress();
    strip.className = 'task-strip idle';
    $('#taskStatusLabel').textContent = '空闲';
    $('#taskTitle').textContent = '暂无任务';
    $('#stopTask').hidden = true;
  }
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
api.onWorkspaceChanged?.(renderWorkspace);
api.onDownload((item) => {
  const node = $('#downloadState');
  if (item.status === 'completed') node.textContent = `已保存：${baseName(item.path)}`;
  else if (item.status === 'progressing') node.textContent = `附件 ${item.totalBytes ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0}%`;
  else if (item.error) node.textContent = item.error;
});
api.chatStatus().then((result) => renderChatState(unwrap(result))).catch(() => {});
refreshStatus();
refreshWorkspace();
refreshTask();
refreshApprovals();
setInterval(refreshWorkspace, 15000);
setInterval(refreshTask, 3000);
setInterval(renderProgress, 1000);
setInterval(refreshApprovals, 3000);
