const api = window.browserAssistant;
const $ = (selector) => document.querySelector(selector);
let switching = false;
let activeWorkspace = '';
let recentWorkspaceHub = null;
let lastRuntimeState = null;
let lastRuntimeCheckAt = 0;

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}分${rest}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function backgroundOperationStatus(operation) {
  const status = String(operation?.status || '');
  if (status === 'interrupted') return '后台任务已中断，可恢复';
  if (status === 'failed') return '后台任务执行失败';
  if (status === 'completed') return '后台任务已完成';
  if (status !== 'running') return '';
  const heartbeatAge = Number(operation?.heartbeat_age_seconds ?? 0);
  if (heartbeatAge >= 15) return `后台任务心跳异常（${heartbeatAge}秒未更新）`;
  return '后台任务运行正常';
}

function humanizeTaskText(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  const labels = {
    'waiting for model': '等待模型继续处理',
    'waiting for user': '等待你处理',
    completed: '已完成',
    'verification failed': '验证失败',
    'requested check failed': '检查失败',
    'running requested checks': '正在执行检查',
    'run complete agent workflow': '正在执行完整任务',
    'apply workspace changes': '正在修改项目',
    'run requested checks': '正在验证修改',
    'finalize verified result': '正在整理结果'
  };
  return labels[key] || raw;
}

function progressForTask(task, status) {
  if (status === 'completed') return 100;
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  if (steps.length) {
    const completed = steps.filter((step) => String(step?.status || '') === 'completed').length;
    const active = steps.filter((step) => ['in_progress', 'active', 'running'].includes(String(step?.status || ''))).length;
    return Math.max(status === 'active' ? 5 : 0, Math.min(95, Math.round(((completed + active * 0.5) / steps.length) * 100)));
  }
  const kind = String(task?.current_command?.kind || '');
  if (kind === 'build') return 85;
  if (kind === 'test') return 72;
  if (kind === 'command') return 52;
  const step = String(task?.current_step || '').toLowerCase();
  if (step.includes('completed')) return 100;
  if (step.includes('build')) return 82;
  if (step.includes('test') || step.includes('verify')) return 70;
  if (step.includes('apply') || step.includes('modify') || step.includes('patch')) return 42;
  if (status === 'waiting') return 62;
  if (status === 'paused') return 50;
  if (status === 'failed' || status === 'stopped') return 100;
  return status === 'active' ? 18 : 0;
}

function progressLabelForTask(task, status, runningOperation, command) {
  if (runningOperation || (command && String(command.status || '') === 'running')) return '运行中';
  if (status === 'completed') return '100%';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  if (status === 'paused') return '已暂停';
  if (status === 'waiting') return '等待';
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  if (steps.length) {
    const completed = steps.filter((step) => String(step?.status || '') === 'completed').length;
    return `${completed}/${steps.length}`;
  }
  return status === 'active' ? '进行中' : '';
}

function renderChatState(state) {
  if (!state) return;
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

function renderServiceState(state) {
  lastRuntimeState = state || null;
  lastRuntimeCheckAt = Date.now();
  const connectionRunning = state?.tunnelRunning;
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
  try {
    let runtime = null;
    if (api.taskRuntime) {
      try { runtime = unwrap(await api.taskRuntime()); } catch { runtime = null; }
    }
    let fallbackPayload = null;
    if (!runtime?.state) {
      try { fallbackPayload = unwrap(await api.taskState()); } catch { fallbackPayload = null; }
    }
    let task = runtime?.state || fallbackPayload?.state || null;
    const activeWorktree = runtime?.active_worktree && runtime.active_worktree.exists !== false ? runtime.active_worktree : null;
    const runningOperation = Array.isArray(runtime?.operations)
      ? runtime.operations.filter((item) => item?.status === 'running').slice(-1)[0]
      : null;
    const now = Date.now();
    let status = String(task?.status || (runningOperation ? 'active' : 'idle'));
    if (task && ['completed', 'failed', 'stopped'].includes(status) && !runningOperation && !activeWorktree) {
      const terminalUpdatedAt = Date.parse(task.updated_at || task.created_at || '') || now;
      const keepVisibleMs = status === 'completed' ? 30000 : 120000;
      if (now - terminalUpdatedAt > keepVisibleMs) {
        task = null;
        status = 'idle';
      }
    }
    const strip = $('#taskStrip');
    strip.className = `task-strip ${status}`;
    strip.classList.toggle('isolated', Boolean(activeWorktree));
    $('#taskTitle').textContent = task?.objective || (runningOperation ? '后台任务运行中' : '暂无任务');
    if ((!task || status === 'idle') && !runningOperation) {
      $('#taskStep').textContent = '';
      $('#taskProgressBar').style.width = '0%';
      $('#taskProgressText').textContent = '';
      strip.title = '';
      return;
    }
    const createdAt = Date.parse(task.created_at || task.updated_at || '') || now;
    const updatedAt = Date.parse(task.updated_at || task.created_at || '') || createdAt;
    const elapsed = formatDuration(now - createdAt);
    const idleFor = now - updatedAt;
    const progress = progressForTask(task, status);
    const parts = [humanizeTaskText(task?.current_step || task?.next_step) || '任务处理中'];
    if (activeWorktree) parts.unshift('安全隔离中');
    if (runningOperation) {
      const operationStartedAt = Date.parse(runningOperation.started_at || '') || (now - Number(runningOperation.elapsed_seconds || 0) * 1000);
      const heartbeatAt = Date.parse(runningOperation.heartbeat_at || '');
      const heartbeatAge = Number.isFinite(heartbeatAt)
        ? Math.max(0, Math.floor((now - heartbeatAt) / 1000))
        : Number(runningOperation.heartbeat_age_seconds || 0);
      const heartbeatText = heartbeatAge >= 15 ? `心跳偏慢 ${heartbeatAge}秒前` : `心跳 ${heartbeatAge}秒前`;
      parts.unshift(`${backgroundOperationStatus({ ...runningOperation, heartbeat_age_seconds: heartbeatAge })} · 已运行 ${formatDuration(now - operationStartedAt)} · ${heartbeatText}`);
    }
    const command = task?.current_command && typeof task.current_command === 'object' ? task.current_command : null;
    if (command && String(command.status || '') === 'running') {
      const commandStartedAt = Date.parse(command.started_at || '') || now;
      const kind = { build: '构建', test: '测试', command: '命令' }[String(command.kind || '')] || '命令';
      parts.unshift(`${kind} ${formatDuration(now - commandStartedAt)}`);
    }
    if (['active', 'paused'].includes(status)) parts.push(`已运行 ${elapsed}`);
    if (status === 'active' && idleFor >= 30000 && !runningOperation) parts.push(`最近活动 ${formatDuration(idleFor)}前`);
    if (status === 'active' && idleFor >= 120000 && !runningOperation) parts.push('较长时间没有新的任务状态，正在等待下一次更新');
    $('#taskStep').textContent = parts.filter(Boolean).join(' · ');
    $('#taskProgressBar').style.width = `${progress}%`;
    $('#taskProgressText').textContent = progressLabelForTask(task, status, runningOperation, command);
    strip.title = `状态：${status}；阶段进度：${progress}%；最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}`;
  } catch { /* no active workspace/task yet */ }
}

function renderWorkspace(hub) {
  activeWorkspace = hub.activeWorkspace || '';
  recentWorkspaceHub = hub;
  $('#activeWorkspace').textContent = activeWorkspace || '未选择';
  $('#activeWorkspace').title = activeWorkspace;
  renderWorkspaceHealth();
  renderWorkspaceClean(hub);
  const select = $('#workspaceSelect');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `\u5168\u90e8\u5de5\u4f5c\u533a（${(hub.recentWorkspaces || []).length}）`;
  select.appendChild(placeholder);
  (hub.recentWorkspaces || []).filter(Boolean).forEach((workspace) => {
    const option = document.createElement('option');
    option.value = workspace;
    option.textContent = workspace === activeWorkspace ? `\u5f53\u524d：${baseName(workspace)}` : baseName(workspace);
    option.title = workspace;
    select.appendChild(option);
  });
  select.value = '';
}

function renderWorkspaceClean(hub) {
  const list = $('#workspaceCleanList');
  list.replaceChildren();
  const entries = (hub.recentWorkspaces || []).filter(Boolean);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.textContent = '暂无最近工作区记录。';
    list.appendChild(empty);
    $('#workspaceCleanAll').disabled = true;
    return;
  }
  $('#workspaceCleanAll').disabled = false;
  entries.forEach((workspace) => {
    const row = document.createElement('div');
    row.className = 'workspace-clean-row';
    const isCurrent = workspaceKeyEquals(workspace, activeWorkspace);
    const name = document.createElement('code');
    name.textContent = baseName(workspace);
    name.title = workspace;
    row.appendChild(name);
    if (isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'workspace-clean-current';
      tag.textContent = '当前';
      row.appendChild(tag);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = `移除记录：${workspace}`;
      remove.onclick = () => removeRecentWorkspaces([workspace]);
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
}

function workspaceKeyEquals(left, right) {
  const key = (value) => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  return Boolean(left && right) && key(left) === key(right);
}

function toggleWorkspaceCleanPopover(show) {
  const popover = $('#workspaceCleanPopover');
  const nextHidden = typeof show === 'boolean' ? !show : !popover.hidden;
  popover.hidden = nextHidden;
  $('#workspaceCleanButton').setAttribute('aria-expanded', String(!nextHidden));
}

async function removeRecentWorkspaces(targets) {
  try {
    const result = unwrap(await api.removeRecentWorkspaces(targets));
    renderWorkspace({ activeWorkspace: result.activeWorkspace, recentWorkspaces: result.recentWorkspaces });
    $('#switchState').textContent = '最近工作区记录已更新';
    setTimeout(() => { $('#switchState').textContent = ''; }, 1800);
  } catch (error) {
    $('#switchState').textContent = error.message;
  }
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
$('#workspaceSelect').onchange = () => { const workspace = $('#workspaceSelect').value; $('#workspaceSelect').value = ''; if (workspace) switchWorkspace(workspace, true); };
$('#workspaceCleanButton').onclick = (event) => { event.stopPropagation(); toggleWorkspaceCleanPopover(); };
document.addEventListener('click', (event) => {
  const wrap = $('.workspace-clean-wrap');
  if (wrap?.contains(event.target)) return;
  const popover = $('#workspaceCleanPopover');
  if (popover && !popover.hidden) toggleWorkspaceCleanPopover(false);
});
$('#workspaceCleanAll').onclick = async () => {
  const entries = ((recentWorkspaceHub?.recentWorkspaces) || [])
    .filter((item) => item && !workspaceKeyEquals(item, activeWorkspace));
  if (!entries.length) return;
  if (!window.confirm(`确定清理 ${entries.length} 条最近工作区记录吗？当前工作区会保留。`)) return;
  await removeRecentWorkspaces(entries);
  toggleWorkspaceCleanPopover(false);
};
$('#pauseTask').onclick = async () => { try { unwrap(await api.pauseTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
$('#resumeTask').onclick = async () => { try { unwrap(await api.resumeTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
$('#stopTask').onclick = async () => { try { unwrap(await api.stopTask()); await refreshTask(); } catch (error) { $('#switchState').textContent = error.message; } };
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
setInterval(refreshWorkspace, 15000);
setInterval(refreshTask, 3000);
