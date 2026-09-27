const api = window.mcpAssistant;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const pageMeta = {
  status: ['运行', '首页', '运行状态、当前任务与最近异常集中在这里。'],
  workspace: ['项目', '工作区', '查看当前主工作区与额外授权边界。'],
  memory: ['记忆', '本地记忆', '管理跨 ChatGPT 账号保留的本机长期记忆。'],
  settings: ['配置', '设置与诊断', '常用设置保持简单，连接、教程和故障处理按需展开。'],
  'setup-guide': ['配置', '配置教程', '按新版 OpenAI Platform 与 ChatGPT 插件流程完成首次接入。']
};

const startupStages = [
  { id: 'config', label: '检查配置' },
  { id: 'environment', label: '检查环境与网络' },
  { id: 'runtime', label: '启动 Runtime' },
  { id: 'mcp', label: '验证本地 MCP' },
  { id: 'tunnel', label: '启动 Tunnel' },
  { id: 'upstream', label: '验证 OpenAI 通道' },
  { id: 'chat', label: '检查 ChatGPT MCP' }
];

const progressStageMap = {
  'config-check': 'config',
  'config-ready': 'config',
  preflight: 'environment',
  'proxy-detect': 'environment',
  'proxy-ready': 'environment',
  'runtime-stop-old': 'environment',
  'native-start': 'runtime',
  'mcp-health': 'mcp',
  'tunnel-start': 'tunnel',
  complete: 'tunnel',
  failed: 'failed'
};

const state = {
  snapshot: null,
  workspaceHub: null,
  currentPage: 'status',
  formsReady: false,
  logs: [],
  taskRuntime: null,
  taskRuntimeError: null,
  worktrees: [],
  activeWorktree: null,
  memory: {
    items: [],
    page: 1,
    pageSize: 12,
    selected: new Set()
  },
  startup: {
    active: false,
    startedAt: 0,
    current: '',
    message: '',
    failed: false,
    stages: Object.fromEntries(startupStages.map((item) => [item.id, { status: 'waiting', startedAt: 0, endedAt: 0, message: '' }]))
  }
};

function unwrap(result) {
  if (!result?.ok) {
    const error = new Error(result?.error || '操作失败');
    error.code = String(result?.code || '');
    error.details = result?.details && typeof result.details === 'object' ? result.details : null;
    throw error;
  }
  return result.data;
}

function memoryResult(response) {
  const data = unwrap(response);
  if (data?.canceled) return data;
  if (data && data.ok === false) {
    const error = new Error(data.error || '本地记忆操作失败');
    error.code = String(data.code || '');
    throw error;
  }
  return data?.result ?? data;
}

function textOr(value, fallback = '—') {
  return String(value ?? '').trim() || fallback;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function maskTunnelId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  const prefix = id.startsWith('tunnel_') ? 'tunnel_' : '';
  const body = id.slice(prefix.length);
  if (!body) return prefix;
  if (body.length <= 8) return prefix + body.slice(0, 2) + '…' + body.slice(-2);
  return prefix + body.slice(0, 4) + '…' + body.slice(-4);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function relativeTime(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function toast(title, message = '', type = 'success') {
  const stack = $('#toastStack');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const heading = document.createElement('b');
  heading.textContent = title;
  const detail = document.createElement('span');
  detail.textContent = message;
  node.append(heading, detail);
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4300);
}

function setBusy(value) {
  $('#busyOverlay')?.classList.toggle('visible', Boolean(value));
}

function setDot(node, status) {
  if (!node) return;
  node.classList.remove('ready', 'warn', 'error');
  if (status) node.classList.add(status);
}

function attachmentHealth(attachment = {}, upstreamReady = false) {
  const status = String(attachment?.status || 'unknown');
  const detail = String(attachment?.detail || '');
  const firstUsePending = detail === 'waiting-first-attachment';
  const ready = ['attached', 'available'].includes(status) || (firstUsePending && upstreamReady);
  const unavailable = status === 'unavailable';
  const label = status === 'attached' ? '已挂载' : ready ? '就绪' : unavailable ? '未挂载' : '检测中';
  const meta = firstUsePending
    ? '页面已就绪，首次调用后会确认本条消息的 MCP 挂载'
    : detail || '当前 ChatGPT 页面';
  return { status, detail, firstUsePending, ready, unavailable, label, meta };
}

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = value;
  if ($('#themeSelect')) $('#themeSelect').value = value;
}

function navigate(page) {
  if (!pageMeta[page]) return;
  state.currentPage = page;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.pageView === page));
  const [eyebrow, title, subtitle] = pageMeta[page];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle;
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  $('.content-viewport').scrollTop = 0;
  if (page === 'workspace') refreshWorkspaceHub();
  if (page === 'memory') loadMemoryPage();
  if (page === 'settings') loadLogs();
  if (page === 'setup-guide') renderSetupGuide();
}

function populateForms(snapshot, force = false) {
  if (!snapshot || (state.formsReady && !force)) return;
  const settings = snapshot.settings || {};
  $('#themeSelect').value = settings.theme === 'light' ? 'light' : 'dark';
  $('#startWithWindowsToggle').checked = Boolean(settings.startWithWindows);
  $('#autoStartToggle').checked = Boolean(settings.autoStartServices);
  $('#keepRunningToggle').checked = settings.keepRunningOnClose !== false;
  $('#taskNotificationsToggle').checked = settings.taskNotifications !== false;
  $('#taskNotificationSoundToggle').checked = settings.taskNotificationSound !== false;
  $('#tunnelIdInput').value = settings.tunnelId || '';
  if ($('#setupTunnelIdInput')) {
    $('#setupTunnelIdInput').value = '';
    $('#setupTunnelIdInput').placeholder = settings.tunnelId
      ? '当前已保存 ' + maskTunnelId(settings.tunnelId) + '；如需更换请粘贴新 ID'
      : 'tunnel_...';
  }
  $('#proxyModeSelect').value = settings.proxyMode || 'auto';
  $('#proxyUrlInput').value = settings.proxyUrl || '';
  $('#mcpPortInput').value = Number(settings.mcpPort || 18765);
  $('#healthPortInput').value = Number(settings.healthPort || 18081);
  $('#manualProxyField').hidden = $('#proxyModeSelect').value !== 'manual';
  applyTheme(settings.theme);
  state.formsReady = true;
}


function renderSetupGuide(snapshot = state.snapshot) {
  if (!snapshot || !$('#setupOverallState')) return;
  const settings = snapshot.settings || {};
  const status = snapshot.status || {};
  const attachment = snapshot.chat?.mcpAttachment || {};
  const hasKey = Boolean(snapshot.secrets?.runtimeApiKey);
  const hasTunnel = Boolean(settings.tunnelId);
  const workspaceReady = Boolean(settings.workspace);
  const runtimeOk = Boolean(status.runtimeRunning);
  const tunnelOk = Boolean(status.tunnelRunning && status.connectionRunning);
  const attachmentState = attachmentHealth(attachment, tunnelOk);
  const attachOk = attachmentState.ready;
  const configured = hasKey && hasTunnel;
  const servicesReady = runtimeOk && tunnelOk;
  const prerequisitesReady = configured && workspaceReady;
  const tunnelDisplay = maskTunnelId(settings.tunnelId);

  $('#setupApiKeyState').textContent = hasKey ? '已使用 Windows 安全存储保存' : '尚未保存';
  $('#setupTunnelState').textContent = hasTunnel ? '已保存（ID 已脱敏）' : '尚未保存';
  $('#setupTunnelEcho').textContent = tunnelDisplay || '尚未保存 Tunnel ID';
  $('#setupPlatformState').textContent = configured ? '第 1 步完成' : '需要保存两项配置';
  $('#setupPlatformState').className = 'soft-badge ' + (configured ? 'positive' : 'warning');

  $('#setupWorkspaceState').textContent = workspaceReady ? '第 2 步完成' : '需要设置';
  $('#setupWorkspaceState').className = 'soft-badge ' + (workspaceReady ? 'positive' : 'warning');
  $('#setupWorkspacePath').textContent = settings.workspace || '尚未选择工作区';

  $('#setupRuntimeStatus').textContent = runtimeOk ? '正常' : '未启动';
  $('#setupTunnelStatus').textContent = tunnelOk ? '已连接' : status.tunnelRunning ? '等待上游' : '未启动';
  $('#setupAttachmentStatus').textContent = attachOk ? '已就绪' : attachmentState.unavailable ? '未挂载' : '等待识别';
  $('#setupAttachmentState').textContent = attachOk ? '已识别' : servicesReady ? '等待首次调用' : '等待服务';
  $('#setupAttachmentState').className = 'soft-badge ' + (attachOk ? 'positive' : servicesReady ? 'neutral' : 'warning');

  if (servicesReady) {
    $('#setupServiceState').textContent = '服务已就绪';
    $('#setupServiceState').className = 'soft-badge positive';
  } else if (runtimeOk) {
    $('#setupServiceState').textContent = '正在连接 Tunnel';
    $('#setupServiceState').className = 'soft-badge warning';
  } else if (prerequisitesReady) {
    $('#setupServiceState').textContent = '可以启动';
    $('#setupServiceState').className = 'soft-badge neutral';
  } else {
    $('#setupServiceState').textContent = '等待前置配置';
    $('#setupServiceState').className = 'soft-badge warning';
  }

  $('#setupStartServices').disabled = !prerequisitesReady;
  $('#setupStartServices').textContent = runtimeOk ? '重新启动服务' : '启动服务';
  if (!configured) $('#setupStartHint').textContent = '请先完成第 1 步：保存 Tunnel ID 和 API Key';
  else if (!workspaceReady) $('#setupStartHint').textContent = '请先完成第 2 步：添加 / 选择工作区';
  else if (servicesReady) $('#setupStartHint').textContent = 'Runtime 与 Tunnel 已就绪，现在继续第 4、5 步';
  else $('#setupStartHint').textContent = '前置配置完整，可以启动服务';

  if (attachOk && servicesReady) {
    $('#setupOverallState').textContent = '配置完成';
    $('#setupOverallState').className = 'soft-badge positive';
  } else if (servicesReady) {
    $('#setupOverallState').textContent = '服务已就绪 · 继续 ChatGPT 配置';
    $('#setupOverallState').className = 'soft-badge positive';
  } else if (prerequisitesReady) {
    $('#setupOverallState').textContent = '下一步：启动服务';
    $('#setupOverallState').className = 'soft-badge neutral';
  } else if (configured) {
    $('#setupOverallState').textContent = '下一步：设置工作区';
    $('#setupOverallState').className = 'soft-badge neutral';
  } else {
    $('#setupOverallState').textContent = '先完成 Tunnel / API Key';
    $('#setupOverallState').className = 'soft-badge warning';
  }

  if (!$('#setupTunnelIdInput').value) {
    $('#setupTunnelIdInput').placeholder = hasTunnel
      ? '当前已保存 ' + tunnelDisplay + '；如需更换请粘贴新 ID'
      : 'tunnel_...';
  }
}

async function saveSetupTunnelId() {
  const tunnelId = $('#setupTunnelIdInput').value.trim();
  if (!tunnelId) return toast('请先填写 Tunnel ID', '通常以 tunnel_ 开头。', 'error');
  try {
    unwrap(await api.saveSettings({ tunnelId }));
    $('#tunnelIdInput').value = tunnelId;
    $('#setupTunnelIdInput').value = '';
    toast('Tunnel ID 已保存');
    await refreshSnapshot({ force: true, forceForms: true, quiet: true });
    renderSetupGuide();
  } catch (error) {
    toast('Tunnel ID 保存失败', error.message, 'error');
  }
}

async function saveSetupRuntimeKey() {
  const value = $('#setupRuntimeKeyInput').value.trim();
  if (!value) return toast('请先粘贴 API Key', '创建后请立即复制并保存。', 'error');
  try {
    unwrap(await api.saveRuntimeKey(value));
    $('#setupRuntimeKeyInput').value = '';
    toast('API Key 已安全保存', '密钥已写入 Windows 安全存储。');
    await refreshSnapshot({ force: true, forceForms: true, quiet: true });
    renderSetupGuide();
  } catch (error) {
    toast('API Key 保存失败', error.message, 'error');
  }
}

function serviceState(card, valueNode, metaNode, status, value, meta) {
  const cardNode = $(card);
  if (cardNode) {
    cardNode.classList.remove('ready', 'warn', 'error');
    if (status) cardNode.classList.add(status);
  }
  $(valueNode).textContent = value;
  $(metaNode).textContent = meta || '—';
}

function renderSnapshot(snapshot, forceForms = false) {
  if (!snapshot) return;
  state.snapshot = snapshot;
  populateForms(snapshot, forceForms);

  const settings = snapshot.settings || {};
  const status = snapshot.status || {};
  const environment = snapshot.environment || {};
  const chat = snapshot.chat || {};
  const attachment = chat.mcpAttachment || {};
  const workspace = settings.workspace || '';
  const runtimeOk = Boolean(status.runtimeRunning);
  const tunnelOk = Boolean(status.tunnelRunning);
  const upstreamOk = Boolean(status.connectionRunning);
  const attachmentState = attachmentHealth(attachment, upstreamOk);
  const attachmentOk = attachmentState.ready;
  const fullyReady = Boolean(status.fullyReady) && attachmentOk;

  $('#sideRuntimeText').textContent = fullyReady ? '全部就绪' : runtimeOk ? '服务运行中' : '服务未运行';
  setDot($('#sideRuntimeDot'), fullyReady ? 'ready' : runtimeOk && upstreamOk ? 'ready' : runtimeOk ? 'warn' : 'error');
  $('#sideWorkspace').textContent = workspace || '尚未选择工作区';
  $('#sideWorkspace').title = workspace;
  $('#sideMcp').textContent = runtimeOk ? '正常' : '停止';
  $('#sideTunnel').textContent = upstreamOk ? '已连' : tunnelOk ? '等待' : '断开';

  if (!workspace) {
    $('#overallTitle').textContent = '还没有选择工作区';
    $('#overallMeta').textContent = '先打开工作区中心选择一个项目，再完成连接配置。';
    $('#overallOrb').className = 'hero-orb warn';
  } else if (fullyReady) {
    $('#overallTitle').textContent = '开发环境已就绪';
    $('#overallMeta').textContent = `${baseName(workspace)} · Runtime、Tunnel 与 OpenAI 通道正常，ChatGPT MCP 可用`;
    $('#overallOrb').className = 'hero-orb ready';
  } else if (runtimeOk && tunnelOk && upstreamOk) {
    $('#overallTitle').textContent = '开发环境已就绪';
    $('#overallMeta').textContent = '基础链路正常；ChatGPT MCP 会在首次调用时确认本条消息的挂载状态。';
    $('#overallOrb').className = 'hero-orb ready';
  } else if (runtimeOk) {
    $('#overallTitle').textContent = '本地 Runtime 已启动';
    $('#overallMeta').textContent = '连接通道尚未完全就绪，可查看启动链路或运行诊断。';
    $('#overallOrb').className = 'hero-orb warn';
  } else {
    $('#overallTitle').textContent = '服务当前未运行';
    $('#overallMeta').textContent = '配置完整后可以启动，并在下方查看真实启动阶段。';
    $('#overallOrb').className = 'hero-orb error';
  }

  $('#runtimeActionButton').textContent = runtimeOk ? '重启服务' : '启动服务';
  $('#statusRuntimeButton').textContent = runtimeOk ? '重启服务' : '启动服务';

  serviceState('#serviceWorkspace', '#serviceWorkspaceValue', '#serviceWorkspaceMeta',
    workspace ? 'ready' : 'warn', workspace ? baseName(workspace) : '未选择', workspace || '打开工作区中心选择项目');
  serviceState('#serviceRuntime', '#serviceRuntimeValue', '#serviceRuntimeMeta',
    runtimeOk ? 'ready' : 'error', runtimeOk ? '正常' : '未运行', status.localMcpUrl || `端口 ${settings.mcpPort || 18765}`);
  serviceState('#serviceTunnel', '#serviceTunnelValue', '#serviceTunnelMeta',
    tunnelOk ? 'ready' : 'error', tunnelOk ? '运行中' : '未连接', status.tunnelDiagnostics?.tunnelName || maskTunnelId(settings.tunnelId) || '尚未配置 Tunnel ID');
  serviceState('#serviceUpstream', '#serviceUpstreamValue', '#serviceUpstreamMeta',
    upstreamOk ? 'ready' : tunnelOk ? 'warn' : 'error', upstreamOk ? '可达' : tunnelOk ? '等待上游' : '不可用',
    status.tunnelDiagnostics?.mainChannelReady ? 'main channel 正常' : textOr(status.tunnelDiagnostics?.mainChannelProbe, 'Control Plane'));
  serviceState('#serviceAttachment', '#serviceAttachmentValue', '#serviceAttachmentMeta',
    attachmentState.ready ? 'ready' : upstreamOk ? 'warn' : 'error',
    attachmentState.label,
    attachmentState.meta);

  $('#runtimeKeyHint').textContent = snapshot.secrets?.runtimeApiKey ? '已使用 Windows 安全存储保存' : '尚未保存 Runtime API Key';
  $('#settingsKeyState').textContent = snapshot.secrets?.runtimeApiKey ? '已加密保存' : '尚未保存';
  const proxy = environment.proxy || {};
  $('#proxyStatus').textContent = proxy.reachable === true ? (proxy.resolvedUrl || proxy.source || '当前网络路径可用') : proxy.reachable === false ? '当前网络路径不可用' : '等待检测';
  if (!workspace || !snapshot.secrets?.runtimeApiKey || !settings.tunnelId) $('#connectionSettings').open = true;

  renderDiagnostics(snapshot);
  renderWorkspaceSummary();
  syncStartupFromSnapshot(snapshot);
  renderSetupGuide();
}

async function refreshSnapshot(options = {}) {
  try {
    const snapshot = unwrap(await api.snapshot({ force: Boolean(options.force) }));
    renderSnapshot(snapshot, Boolean(options.forceForms));
    return snapshot;
  } catch (error) {
    $('#sideRuntimeText').textContent = '状态读取失败';
    setDot($('#sideRuntimeDot'), 'error');
    if (!options.quiet) toast('状态读取失败', error.message, 'error');
    return null;
  }
}

async function refreshWorkspaceHub() {
  try {
    state.workspaceHub = unwrap(await api.workspaceHub());
    renderWorkspaceSummary();
    renderSetupGuide();
    return state.workspaceHub;
  } catch (error) {
    if (state.currentPage === 'workspace') toast('工作区状态读取失败', error.message, 'error');
    return null;
  }
}

function renderWorkspaceSummary() {
  const hub = state.workspaceHub;
  const snapshot = state.snapshot;
  const current = hub?.activeWorkspace || snapshot?.settings?.workspace || '';
  $('#workspacePageName').textContent = current ? baseName(current) : '尚未选择';
  $('#workspacePagePath').textContent = current || '—';
  $('#workspacePagePath').title = current;
  const active = (hub?.workspaces || []).find((item) => item.active);
  $('#workspacePageHealth').textContent = !current ? '未配置' : active?.status === 'ready' || !active ? '可用' : active.status === 'missing' ? '目录不存在' : '需要检查';
  $('#workspacePageHealth').className = `soft-badge ${current && (active?.status === 'ready' || !active) ? 'positive' : 'warning'}`;
  $('#recentWorkspaceCount').textContent = String((hub?.workspaces || []).length);
  $('#authorizedRootCount').textContent = String((hub?.authorizedRoots || []).length);
  $('#invalidWorkspaceCount').textContent = String(Number(hub?.invalidCount || 0) + Number(hub?.invalidAuthorizedRootCount || 0));

  const target = $('#workspaceAuthPreview');
  target.replaceChildren();
  const roots = hub?.authorizedRootDetails || [];
  if (!roots.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-auth-empty';
    empty.textContent = '当前没有额外授权目录。';
    target.appendChild(empty);
    return;
  }
  for (const item of roots.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = `workspace-auth-row ${item.status || ''}`;
    const copy = document.createElement('div');
    const name = document.createElement('b'); name.textContent = item.name || baseName(item.path);
    const code = document.createElement('code'); code.textContent = item.path;
    copy.append(name, code);
    const status = document.createElement('span');
    status.textContent = item.status === 'ready' ? '已授权' : item.status === 'missing' ? '目录不存在' : item.status === 'unavailable' ? '不可访问' : '需要检查';
    row.append(copy, status);
    target.appendChild(row);
  }
}

function resetStartup() {
  state.startup.active = true;
  state.startup.startedAt = Date.now();
  state.startup.current = 'config';
  state.startup.message = '正在开始服务启动流程…';
  state.startup.failed = false;
  state.startup.stages = Object.fromEntries(startupStages.map((item) => [item.id, { status: 'waiting', startedAt: 0, endedAt: 0, message: '' }]));
  state.startup.stages.config = { status: 'running', startedAt: Date.now(), endedAt: 0, message: '正在检查必要配置' };
  renderStartup();
}

function setStartupStage(stageId, status, message = '') {
  const stage = state.startup.stages[stageId];
  if (!stage) return;
  if (status === 'running' && !stage.startedAt) stage.startedAt = Date.now();
  if (['done', 'failed'].includes(status) && !stage.endedAt) stage.endedAt = Date.now();
  stage.status = status;
  if (message) stage.message = message;
}

function handleProgress(payload) {
  if (!payload) return;
  if (!state.startup.active && !['stopped', 'stop-connection', 'stop-runtime'].includes(payload.step)) resetStartup();
  const stageId = progressStageMap[payload.step];
  state.startup.message = payload.message || '';
  if (payload.step === 'failed') {
    state.startup.failed = true;
    state.startup.active = false;
    const current = state.startup.current || 'config';
    setStartupStage(current, 'failed', payload.message || '启动失败');
  } else if (stageId) {
    const nextIndex = startupStages.findIndex((item) => item.id === stageId);
    startupStages.forEach((item, index) => {
      if (index < nextIndex && state.startup.stages[item.id].status !== 'failed') setStartupStage(item.id, 'done');
    });
    if (payload.step === 'config-ready') setStartupStage('config', 'done', payload.message);
    else if (payload.step === 'proxy-ready') setStartupStage('environment', 'done', payload.message);
    else if (payload.step === 'mcp-health') {
      setStartupStage('runtime', 'done');
      setStartupStage('mcp', 'running', payload.message);
    } else if (payload.step === 'tunnel-start') {
      setStartupStage('mcp', 'done');
      setStartupStage('tunnel', 'running', payload.message);
    } else if (payload.step === 'complete') {
      setStartupStage('tunnel', 'done', payload.message);
      state.startup.active = false;
    } else {
      setStartupStage(stageId, 'running', payload.message);
    }
    state.startup.current = stageId;
  }
  renderStartup();
  if (payload.step === 'complete' || payload.step === 'failed') {
    setTimeout(() => refreshSnapshot({ force: true, quiet: true }), 350);
  }
}

function syncStartupFromSnapshot(snapshot) {
  const settings = snapshot.settings || {};
  const status = snapshot.status || {};
  const env = snapshot.environment || {};
  const attachment = snapshot.chat?.mcpAttachment || {};
  const configured = Boolean(settings.workspace && snapshot.secrets?.runtimeApiKey && settings.tunnelId);
  const environmentOk = env.python?.installed !== false && env.workspace?.exists !== false;
  const runtimeOk = Boolean(status.runtimeRunning);
  const tunnelOk = Boolean(status.tunnelRunning);
  const upstreamOk = Boolean(status.connectionRunning);
  const attachmentState = attachmentHealth(attachment, upstreamOk);
  const chainReady = configured && environmentOk && runtimeOk && tunnelOk && upstreamOk && attachmentState.ready;

  if (!state.startup.failed) {
    if (configured) setStartupStage('config', 'done', '必要配置已就绪');
    if (environmentOk) setStartupStage('environment', 'done', '运行环境与网络检查通过');
    if (runtimeOk) {
      setStartupStage('runtime', 'done', 'Runtime 正常');
      setStartupStage('mcp', 'done', '本地 MCP 正常');
    }
    if (tunnelOk) setStartupStage('tunnel', 'done', 'Tunnel 运行中');
    if (upstreamOk) setStartupStage('upstream', 'done', 'OpenAI 上游通道可达');
    if (attachmentState.ready) {
      setStartupStage('chat', 'done', attachmentState.firstUsePending ? 'ChatGPT 页面可用，首次调用时确认挂载' : attachmentState.meta);
    }
    if (chainReady) {
      state.startup.active = false;
      state.startup.current = '';
      state.startup.message = '服务已就绪，启动链路已按实时状态校验完成。';
      renderStartup();
      return;
    }
  }

  if (state.startup.active || state.startup.failed) {
    if (!state.startup.failed && upstreamOk && !attachmentState.ready) {
      setStartupStage('chat', 'waiting', '首次调用时确认 MCP 挂载');
    }
    renderStartup();
    return;
  }

  state.startup.stages.config.status = configured ? 'done' : 'waiting';
  state.startup.stages.config.message = configured ? '必要配置已就绪' : '需要补全配置';
  state.startup.stages.environment.status = environmentOk ? 'done' : 'waiting';
  state.startup.stages.environment.message = environmentOk ? '运行环境可用' : '等待环境检查';
  state.startup.stages.runtime.status = runtimeOk ? 'done' : 'waiting';
  state.startup.stages.runtime.message = runtimeOk ? 'Runtime 正常' : '待启动';
  state.startup.stages.mcp.status = runtimeOk ? 'done' : 'waiting';
  state.startup.stages.mcp.message = runtimeOk ? '本地 MCP 正常' : '待验证';
  state.startup.stages.tunnel.status = tunnelOk ? 'done' : 'waiting';
  state.startup.stages.tunnel.message = tunnelOk ? 'Tunnel 运行中' : '待启动';
  state.startup.stages.upstream.status = upstreamOk ? 'done' : 'waiting';
  state.startup.stages.upstream.message = upstreamOk ? 'OpenAI 通道可达' : '待验证';
  state.startup.stages.chat.status = attachmentState.ready ? 'done' : 'waiting';
  state.startup.stages.chat.message = attachmentState.ready
    ? (attachmentState.firstUsePending ? '页面可用，首次调用时确认挂载' : attachmentState.meta)
    : upstreamOk ? '首次调用时确认 MCP 挂载' : '待检查';
  state.startup.message = chainReady
    ? '服务已就绪，启动链路已按实时状态校验完成。'
    : upstreamOk
      ? '基础服务已就绪；ChatGPT MCP 挂载将在首次调用时确认。'
      : '当前显示实时服务状态；启动时会切换为真实阶段进度。';
  renderStartup();
}

function renderStartup() {
  const target = $('#startupStageList');
  target.replaceChildren();
  for (const item of startupStages) {
    const value = state.startup.stages[item.id] || {};
    const row = document.createElement('div');
    row.className = `stage-row ${value.status || 'waiting'}`;
    const icon = document.createElement('i');
    icon.textContent = value.status === 'done' ? '✓' : value.status === 'failed' ? '!' : value.status === 'running' ? '•' : '○';
    const copy = document.createElement('div');
    const title = document.createElement('b'); title.textContent = item.label;
    const detail = document.createElement('small'); detail.textContent = value.message || (value.status === 'waiting' ? '待执行' : value.status === 'done' ? '已完成' : value.status === 'running' ? '进行中' : '失败');
    copy.append(title, detail);
    const time = document.createElement('span');
    if (value.startedAt) {
      const end = value.endedAt || Date.now();
      time.textContent = formatDuration(end - value.startedAt);
    } else time.textContent = '';
    row.append(icon, copy, time);
    target.appendChild(row);
  }

  $('#startupMessage').textContent = state.startup.message || '尚未开始新的启动流程。';
  if (state.startup.failed) {
    $('#startupBadge').textContent = '失败';
    $('#startupBadge').className = 'soft-badge danger';
  } else if (state.startup.active) {
    $('#startupBadge').textContent = '进行中';
    $('#startupBadge').className = 'soft-badge warning';
  } else {
    const allDone = startupStages.every((item) => state.startup.stages[item.id]?.status === 'done');
    $('#startupBadge').textContent = allDone ? '全部就绪' : '实时状态';
    $('#startupBadge').className = `soft-badge ${allDone ? 'positive' : 'neutral'}`;
  }
}

async function runRuntime(action) {
  resetStartup();
  const buttons = [$('#runtimeActionButton'), $('#statusRuntimeButton')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const fn = action === 'start' ? api.start : action === 'stop' ? api.stop : api.restart;
    unwrap(await fn());
    await Promise.all([refreshSnapshot({ force: true, quiet: true }), refreshWorkspaceHub(), refreshTaskRuntime()]);
    toast(action === 'start' ? '服务已启动' : action === 'stop' ? '服务已停止' : '服务已重启');
  } catch (error) {
    state.startup.active = false;
    state.startup.failed = true;
    state.startup.message = error.message;
    const current = state.startup.current || 'config';
    setStartupStage(current, 'failed', error.message);
    renderStartup();
    toast('启动流程失败', error.message, 'error');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function taskStatusView(task, operation) {
  const lifecycle = String(task?.lifecycle_state || '');
  const status = String(task?.status || '');
  if (['running', 'queued'].includes(String(operation?.status || ''))
    || ['active', 'running', 'created', 'planning', 'preparing', 'verifying', 'recovering'].includes(status)
    || ['created', 'planning', 'ready', 'preparing', 'running', 'recovering', 'verifying'].includes(lifecycle)) return ['执行中', 'warning'];
  if (['needs_user', 'waiting_user', 'waiting_approval', 'paused'].includes(lifecycle) || ['paused', 'waiting'].includes(status)) return ['等待处理', 'warning'];
  if (lifecycle === 'waiting_model') return ['等待模型', 'warning'];
  if (lifecycle === 'failed' || status === 'failed') return ['失败', 'danger'];
  if (lifecycle === 'cancelled' || status === 'stopped') return ['已停止', 'neutral'];
  if (lifecycle === 'completed' || status === 'completed') return ['已完成', 'positive'];
  return ['空闲', 'neutral'];
}

function worktreeHasPendingChanges(worktree) {
  if (!worktree || worktree.exists === false) return false;
  const status = String(worktree.status || '').toLowerCase();
  if (status.includes('conflict')) return true;
  if (worktree.has_unapplied_changes === true) return true;
  if (Number(worktree.changed_count || 0) > 0) return true;
  if (worktree.clean === true && Number(worktree.changed_count || 0) === 0) return false;
  return false;
}

function renderTaskRuntime() {
  const runtime = state.taskRuntime;
  const task = runtime?.state || null;
  const operation = Array.isArray(runtime?.operations)
    ? runtime.operations.filter((item) => ['running', 'queued'].includes(String(item?.status || ''))).slice(-1)[0]
    : null;
  const unified = runtime?.runtime_layers?.user || {};
  let [label, tone] = taskStatusView(task, operation);
  if (unified.state === 'stalled') {
    label = '疑似卡住';
    tone = 'danger';
  }
  if (state.taskRuntimeError && task) {
    label = `${label} · 状态待确认`;
    tone = 'warning';
  }
  $('#taskBadge').textContent = label;
  $('#taskBadge').className = `soft-badge ${tone}`;

  if (!task || (!task.task_id && label === '空闲')) {
    $('#taskEmpty').hidden = false;
    $('#taskContent').hidden = true;
    return;
  }
  $('#taskEmpty').hidden = true;
  $('#taskContent').hidden = false;
  $('#taskObjective').textContent = textOr(task.objective, '未命名任务');
  $('#taskCurrentStep').textContent = textOr(task.current_step || task.next_step, label);
  const created = Date.parse(task.created_at || task.updated_at || '');
  $('#taskElapsed').textContent = Number.isFinite(created) ? formatDuration(Date.now() - created) : '—';
  const lastActivity = relativeTime(task.last_heartbeat_at || task.updated_at);
  $('#taskActivity').textContent = state.taskRuntimeError
    ? `状态读取暂时失败，保留上次进度 · ${lastActivity}`
    : unified.state === 'stalled'
      ? `${Math.max(0, Number(unified.heartbeat_age_seconds || 0))} 秒无活动，建议查看诊断`
      : lastActivity;
  $('#taskId').textContent = textOr(task.task_id);
  $('#taskRunId').textContent = textOr(task.run_id);
  $('#taskOperation').textContent = textOr(operation?.operation_id || runtime?.background_operation?.operation_id);

  const command = task.current_command && typeof task.current_command === 'object' ? task.current_command : null;
  $('#taskCommandRow').hidden = !command || String(command.status || '') !== 'running';
  if (command) $('#taskCommand').textContent = command.command || command.cmd || command.kind || '正在执行命令';

  const failure = String(task.failure || '').trim();
  $('#taskFailureRow').hidden = !failure;
  $('#taskFailure').textContent = failure || '—';
}

async function refreshTaskRuntime() {
  try {
    state.taskRuntime = unwrap(await api.taskRuntime({ detail: 'full' }));
    state.taskRuntimeError = null;
    renderTaskRuntime();
    await refreshWorktrees();
  } catch (error) {
    state.taskRuntimeError = {
      message: String(error?.message || '任务状态读取失败'),
      at: Date.now()
    };
    renderTaskRuntime();
    if (!state.taskRuntime) $('#worktreePanel').hidden = true;
  }
}

function unresolvedWorktree() {
  const task = state.taskRuntime?.state || {};
  const terminal = ['completed', 'failed', 'stopped', 'paused', 'waiting'].includes(String(task.status || ''))
    || ['completed', 'failed', 'cancelled', 'needs_user', 'waiting_user'].includes(String(task.lifecycle_state || ''));
  const active = state.taskRuntime?.active_worktree;
  if (active && terminal && worktreeHasPendingChanges(active)) return active;
  return (state.worktrees || []).find((item) =>
    !['applied', 'discarded', 'cleaned', 'removed'].includes(String(item?.status || '').toLowerCase())
    && terminal
    && worktreeHasPendingChanges(item)
  ) || null;
}

function renderWorktree() {
  const worktree = unresolvedWorktree();
  state.activeWorktree = worktree;
  $('#worktreePanel').hidden = !worktree;
  if (!worktree) {
    $('#worktreeDiff').hidden = true;
    $('#worktreeDiff').textContent = '';
    return;
  }
  const task = state.taskRuntime?.state || {};
  $('#worktreeObjective').textContent = textOr(task.objective || worktree.objective, '隔离任务');
  $('#worktreePath').textContent = textOr(worktree.path);
  $('#worktreePath').title = textOr(worktree.path);
  $('#worktreeSummary').textContent = String(worktree.status || '').toLowerCase().includes('conflict')
    ? '应用隔离修改时检测到冲突，需要先查看 Diff 再决定。'
    : '任务留下了尚未应用回主工作区的隔离修改。';
}

async function refreshWorktrees() {
  try {
    const payload = unwrap(await api.taskWorktrees());
    state.worktrees = Array.isArray(payload?.worktrees) ? payload.worktrees : [];
    renderWorktree();
  } catch {
    state.worktrees = [];
    renderWorktree();
  }
}

async function viewWorktreeDiff() {
  const worktree = state.activeWorktree;
  if (!worktree) return;
  try {
    const payload = unwrap(await api.taskWorktreeDiff(worktree.run_id || state.taskRuntime?.state?.run_id || ''));
    const diff = payload?.worktree_diff?.diff || payload?.worktree_diff?.patch || payload?.diff || '没有可显示的文本差异。';
    $('#worktreeDiff').textContent = diff;
    $('#worktreeDiff').hidden = false;
  } catch (error) {
    toast('读取隔离修改失败', error.message, 'error');
  }
}

async function applyWorktree() {
  const worktree = state.activeWorktree;
  if (!worktree) return;
  if (!confirm('把这个隔离任务的修改安全应用回主工作区？\n\n如果主目录发生冲突，Runtime 会拒绝覆盖。')) return;
  setBusy(true);
  try {
    unwrap(await api.applyTaskWorktree(worktree.run_id || state.taskRuntime?.state?.run_id || ''));
    toast('隔离修改已应用');
    await refreshTaskRuntime();
  } catch (error) {
    if (error.code === 'LOCAL_APPROVAL_REQUIRED' && api.openApprovalWindow) {
      await api.openApprovalWindow();
      toast('需要本地确认', '请在弹出的风险确认窗口中处理这次 Git 写入。');
    } else {
      toast('应用失败', error.message, 'error');
    }
  } finally {
    setBusy(false);
  }
}

async function discardWorktree() {
  const worktree = state.activeWorktree;
  if (!worktree) return;
  if (!confirm('丢弃这个隔离任务及其未应用修改？\n\n这不会修改主工作区，但隔离修改将无法恢复。')) return;
  setBusy(true);
  try {
    unwrap(await api.discardTaskWorktree(worktree.run_id || state.taskRuntime?.state?.run_id || ''));
    toast('隔离修改已丢弃');
    await refreshTaskRuntime();
  } catch (error) {
    if (error.code === 'LOCAL_APPROVAL_REQUIRED' && api.openApprovalWindow) await api.openApprovalWindow();
    else toast('丢弃失败', error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function renderIssueFromLogs() {
  const issue = [...state.logs].reverse().find((entry) => ['error', 'warn', 'warning'].includes(String(entry?.level || '').toLowerCase()));
  $('#issuePanel').hidden = !issue;
  if (!issue) return;
  $('#issueText').textContent = String(issue.message || issue.msg || '检测到运行异常');
  $('#issueTime').textContent = issue.time ? new Date(issue.time).toLocaleString('zh-CN', { hour12: false }) : '—';
}

async function saveCommonSettings() {
  const saved = unwrap(await api.saveSettings({
    theme: $('#themeSelect').value === 'light' ? 'light' : 'dark',
    startWithWindows: $('#startWithWindowsToggle').checked,
    autoStartServices: $('#autoStartToggle').checked,
    keepRunningOnClose: $('#keepRunningToggle').checked,
    taskNotifications: $('#taskNotificationsToggle').checked,
    taskNotificationSound: $('#taskNotificationSoundToggle').checked
  }));
  if (state.snapshot) state.snapshot.settings = { ...state.snapshot.settings, ...saved };
}

async function saveConnectionSettings() {
  unwrap(await api.saveSettings({
    tunnelId: $('#tunnelIdInput').value.trim(),
    proxyMode: $('#proxyModeSelect').value,
    proxyUrl: $('#proxyUrlInput').value.trim(),
    mcpPort: Number($('#mcpPortInput').value || 18765),
    healthPort: Number($('#healthPortInput').value || 18081)
  }));
  toast('连接配置已保存');
  await refreshSnapshot({ force: true, forceForms: true, quiet: true });
}

async function detectProxy() {
  try {
    unwrap(await api.saveSettings({ proxyMode: $('#proxyModeSelect').value, proxyUrl: $('#proxyUrlInput').value.trim() }));
    const result = unwrap(await api.detectProxy());
    $('#proxyStatus').textContent = result?.reachable ? (result.resolvedUrl || result.url || result.source || '当前网络路径可用') : '未检测到可用网络路径';
    toast(result?.reachable ? '网络路径可用' : '网络路径不可用', result?.resolvedUrl || result?.source || '', result?.reachable ? 'success' : 'error');
    await refreshSnapshot({ force: true, quiet: true });
  } catch (error) {
    toast('网络检测失败', error.message, 'error');
  }
}

function renderDiagnostics(snapshot = state.snapshot) {
  if (!snapshot) return;
  const status = snapshot.status || {};
  const tunnel = status.tunnelDiagnostics || {};
  const attachment = snapshot.chat?.mcpAttachment || {};
  const runtimeOk = Boolean(status.runtimeRunning);
  const tunnelOk = Boolean(status.tunnelRunning);
  const upstreamOk = Boolean(status.connectionRunning);
  const attachmentState = attachmentHealth(attachment, upstreamOk);
  const attachOk = attachmentState.ready;
  $('#diagRuntime').textContent = runtimeOk ? '正常' : '停止';
  $('#diagRuntimeMeta').textContent = status.localMcpUrl || '本地 Runtime 未启动';
  $('#diagTunnel').textContent = tunnelOk ? '运行中' : '停止';
  $('#diagTunnelMeta').textContent = tunnel.tunnelName || maskTunnelId(tunnel.tunnelId) || 'OpenAI Tunnel';
  $('#diagUpstream').textContent = upstreamOk ? '可达' : tunnelOk ? '等待上游' : '不可用';
  $('#diagUpstreamMeta').textContent = tunnel.mainChannelReady ? 'main channel 正常' : textOr(tunnel.mainChannelProbe, 'Control Plane');
  $('#diagAttachment').textContent = attachmentState.label;
  $('#diagAttachmentMeta').textContent = attachmentState.meta;
  const allGood = runtimeOk && tunnelOk && upstreamOk && attachOk;
  $('#diagnosticSummary').textContent = allGood ? '全部链路正常' : runtimeOk && tunnelOk && upstreamOk ? '基础链路正常，首次调用时确认 MCP' : '检测到连接或运行异常';
  $('#diagnosticMeta').textContent = allGood ? '无需处理，可以直接回到 ChatGPT 使用。' : '运行一键诊断获取具体证据和处理建议。';
  $('#diagnosticOrb').className = 'diagnostic-orb ' + (allGood ? 'ready' : runtimeOk ? 'warn' : 'error');
}

function renderDoctor(result) {
  const target = $('#doctorResults');
  target.replaceChildren();
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  if (!checks.length) {
    const empty = document.createElement('span');
    empty.className = 'task-muted';
    empty.textContent = result?.summary || '没有额外诊断详情。';
    target.appendChild(empty);
  }
  for (const item of checks) {
    const row = document.createElement('div');
    row.className = `diagnostic-detail-row ${item.state || 'warn'}`;
    const dot = document.createElement('i');
    const copy = document.createElement('div');
    const title = document.createElement('b'); title.textContent = item.label || item.id || '诊断项';
    const evidence = document.createElement('small'); evidence.textContent = item.evidence || item.detail || '';
    const suggestion = document.createElement('em'); suggestion.textContent = item.suggestion || '';
    copy.append(title, evidence, suggestion);
    const status = document.createElement('strong'); status.textContent = item.state === 'ready' ? '正常' : item.state === 'error' ? '异常' : '注意';
    row.append(dot, copy, status);
    target.appendChild(row);
  }
  const ready = String(result?.severity || '') === 'ready';
  $('#diagnosticSummary').textContent = result?.summary || (ready ? '全部链路正常' : '诊断发现异常');
  $('#diagnosticOrb').className = `diagnostic-orb ${ready ? 'ready' : result?.severity === 'error' ? 'error' : 'warn'}`;
  $('#doctorDetails').open = !ready;
}

async function runDiagnostics() {
  setBusy(true);
  try {
    const [doctorResponse, healthResponse] = await Promise.all([api.doctorInspect(), api.inspectHealth()]);
    const doctor = unwrap(doctorResponse);
    const health = unwrap(healthResponse);
    renderDoctor(doctor || { severity: health?.healthy ? 'ready' : 'warn', summary: health?.healthy ? '系统检查正常' : '系统检查发现问题', checks: health?.checks || [] });
    navigate('settings');
    await refreshSnapshot({ force: true, quiet: true });
    toast('诊断完成', doctor?.summary || (health?.healthy ? '全部检查通过' : '请查看诊断详情'));
  } catch (error) {
    toast('诊断失败', error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function repairHealth() {
  setBusy(true);
  try {
    const result = unwrap(await api.repairHealth());
    toast(result?.healthy ? '修复完成' : '修复后仍有未解决项', Array.isArray(result?.actions) ? result.actions.join('；') : '');
    await runDiagnostics();
  } catch (error) {
    toast('修复失败', error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function renderLogs() {
  const target = $('#logOutput');
  target.replaceChildren();
  $('#logCount').textContent = `${state.logs.length} 条日志`;
  if (!state.logs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const b = document.createElement('b'); b.textContent = '暂无日志';
    const span = document.createElement('span'); span.textContent = '出现运行或连接异常时再查看。';
    empty.append(b, span);
    target.appendChild(empty);
    renderIssueFromLogs();
    return;
  }
  state.logs.slice(-200).reverse().forEach((entry) => {
    const row = document.createElement('div');
    row.className = `log-line ${String(entry?.level || 'info').toLowerCase()}`;
    const meta = document.createElement('span');
    meta.textContent = `${entry?.time ? new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}  ${String(entry?.level || 'info').toUpperCase()}`;
    const code = document.createElement('code');
    code.textContent = String(entry?.message || entry?.msg || '');
    row.append(meta, code);
    target.appendChild(row);
  });
  renderIssueFromLogs();
}

async function loadLogs() {
  try {
    state.logs = unwrap(await api.logs()) || [];
    renderLogs();
  } catch (error) {
    toast('日志读取失败', error.message, 'error');
  }
}

function memoryDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function memoryScopeLabel(value) {
  return ({ global: '全局', project: '当前项目', task: '任务' })[String(value || '')] || '本地';
}

function memoryTypeLabel(value) {
  return ({ core_preference: '核心偏好', working_style: '工作方式', project_summary: '项目摘要', architecture: '架构', decision: '技术决策', open_loop: '未闭环', pitfall: '已知坑', task_summary: '任务摘要', note: '备注' })[String(value || '')] || '记忆';
}

function renderMemoryStatus(status) {
  $('#memoryTotal').textContent = String(status?.count ?? 0);
  $('#memoryActive').textContent = String(status?.active_count ?? 0);
  $('#memoryArchived').textContent = String(status?.archived_count ?? 0);
  $('#memoryCandidateCount').textContent = String(status?.candidate_count ?? 0);
  $('#memoryUpdated').textContent = status?.last_updated ? memoryDate(status.last_updated) : '尚无记忆';
  $('#memoryProfile').textContent = textOr(status?.profile, 'local-default');
  const mode = ['off', 'suggest', 'auto'].includes(status?.config?.auto_memory) ? status.config.auto_memory : 'off';
  $('#memoryAutoMode').value = mode;
  const capture = status?.auto_capture || {};
  $('#memoryAutoCaptureStatus').textContent = mode === 'off' ? '自动记忆已关闭' : `自动采集运行中 · 已处理 ${Number(capture.processed || 0)} 轮`;
}

function memoryButton(label, className, handler) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

async function updateMemoryItem(item, changes) {
  memoryResult(await api.memoryUpdate(item.memory_id, changes));
  toast('记忆已更新');
  await loadMemoryPage();
}

function renderMemoryPagination(total) {
  const pageSize = Math.max(1, Number(state.memory.pageSize) || 12);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  state.memory.page = Math.min(Math.max(1, state.memory.page), pageCount);
  const pageLabel = $('#memoryPageLabel');
  if (pageLabel) pageLabel.textContent = `第 ${state.memory.page} / ${pageCount} 页`;
  const previous = $('#memoryPrevPage');
  const next = $('#memoryNextPage');
  if (previous) previous.disabled = state.memory.page <= 1;
  if (next) next.disabled = state.memory.page >= pageCount;
}

function syncMemorySelection(items) {
  const validIds = new Set(state.memory.items.map((item) => String(item.memory_id)));
  state.memory.selected = new Set([...state.memory.selected].filter((id) => validIds.has(String(id))));
  const selectPage = $('#memorySelectPage');
  const pageIds = items.map((item) => String(item.memory_id));
  if (selectPage) {
    selectPage.checked = pageIds.length > 0 && pageIds.every((id) => state.memory.selected.has(id));
    selectPage.indeterminate = !selectPage.checked && pageIds.some((id) => state.memory.selected.has(id));
  }
  const batch = $('#memoryBatchArchive');
  if (batch) batch.disabled = state.memory.selected.size === 0;
}

function renderMemoryItems(items) {
  const target = $('#memoryList');
  target.replaceChildren();
  const pageSize = Math.max(1, Number(state.memory.pageSize) || 12);
  const start = (state.memory.page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  if (!pageItems.length) {
    const empty = document.createElement('span');
    empty.className = 'task-muted';
    empty.textContent = '没有匹配的本地记忆。';
    target.appendChild(empty);
    syncMemorySelection([]);
    renderMemoryPagination(items.length);
    return;
  }
  for (const item of pageItems) {
    const card = document.createElement('article');
    card.className = 'memory-card';
    const head = document.createElement('div'); head.className = 'memory-card-head';
    const selector = document.createElement('label'); selector.className = 'memory-select-item'; selector.title = '选择这条记忆';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.memory.selected.has(String(item.memory_id)); checkbox.dataset.memoryId = String(item.memory_id); checkbox.setAttribute('aria-label', `选择记忆：${textOr(item.title, '未命名记忆')}`);
    checkbox.addEventListener('change', () => { if (checkbox.checked) state.memory.selected.add(String(item.memory_id)); else state.memory.selected.delete(String(item.memory_id)); syncMemorySelection(pageItems); });
    selector.appendChild(checkbox);
    const details = document.createElement('details'); details.className = 'memory-card-details';
    const summary = document.createElement('summary'); summary.className = 'memory-card-summary';
    const copy = document.createElement('div');
    const title = document.createElement('b'); title.textContent = textOr(item.title, '未命名记忆');
    const meta = document.createElement('small'); meta.textContent = `${memoryScopeLabel(item.scope)} · ${memoryTypeLabel(item.memory_type)} · ${memoryDate(item.updated_at)}`;
    copy.append(title, meta);
    const badge = document.createElement('span'); badge.className = `soft-badge ${item.pinned ? 'positive' : 'neutral'}`; badge.textContent = item.pinned ? '已置顶' : '普通';
    summary.append(copy, badge);
    const body = document.createElement('pre'); body.className = 'memory-content'; body.textContent = textOr(item.content, '（空内容）');
    const actions = document.createElement('div'); actions.className = 'memory-actions';
    const editor = document.createElement('div'); editor.className = 'memory-editor'; editor.hidden = true;
    actions.append(
      memoryButton(item.pinned ? '取消置顶' : '置顶', 'secondary-button', () => updateMemoryItem(item, { pinned: !item.pinned }).catch((error) => toast('更新失败', error.message, 'error'))),
      memoryButton('编辑', 'secondary-button', () => { editor.hidden = !editor.hidden; }),
      memoryButton('归档', 'secondary-button', async () => {
        if (!confirm('归档这条记忆？')) return;
        try { memoryResult(await api.memoryArchive(item.memory_id)); state.memory.selected.delete(String(item.memory_id)); await loadMemoryPage(); } catch (error) { toast('归档失败', error.message, 'error'); }
      }),
      memoryButton('删除', 'danger-button', async () => {
        if (!confirm('永久删除这条记忆？')) return;
        try { memoryResult(await api.memoryDelete(item.memory_id)); state.memory.selected.delete(String(item.memory_id)); await loadMemoryPage(); } catch (error) { toast('删除失败', error.message, 'error'); }
      })
    );
    const titleInput = document.createElement('input'); titleInput.value = item.title || '';
    const contentInput = document.createElement('textarea'); contentInput.value = item.content || ''; contentInput.rows = 6;
    const save = memoryButton('保存修改', 'primary-button', () => updateMemoryItem(item, { title: titleInput.value.trim(), content: contentInput.value }).catch((error) => toast('保存失败', error.message, 'error')));
    editor.append(titleInput, contentInput, save);
    details.append(summary, body, actions, editor);
    head.append(selector, details);
    card.append(head);
    target.appendChild(card);
  }
  syncMemorySelection(pageItems);
  renderMemoryPagination(items.length);
}

async function archiveSelectedMemories() {
  const ids = [...state.memory.selected];
  if (!ids.length) return;
  if (!confirm(`归档已选择的 ${ids.length} 条记忆？`)) return;
  setBusy(true);
  let archived = 0;
  try {
    for (const memoryId of ids) {
      memoryResult(await api.memoryArchive(memoryId));
      archived += 1;
    }
    state.memory.selected.clear();
    toast('批量归档完成', `已归档 ${archived} 条记忆`);
    await loadMemoryPage();
  } catch (error) {
    toast('批量归档未完成', `已归档 ${archived} 条：${error.message}`, 'error');
    await loadMemoryPage();
  } finally {
    setBusy(false);
  }
}

async function loadMemoryItems({ resetPage = false } = {}) {
  const scope = $('#memoryScope').value;
  const query = $('#memorySearch').value.trim();
  if (resetPage) state.memory.page = 1;
  const options = { limit: 200 };
  if (scope !== 'all') options.scope = scope;
  const listing = memoryResult(await api.memoryList(options));
  let items = Array.isArray(listing?.items) ? listing.items : [];
  if (query) {
    const found = memoryResult(await api.memorySearch(query, { limit: 100 }));
    const ids = new Set((found?.items || []).map((item) => item.memory_id));
    items = items.filter((item) => ids.has(item.memory_id));
  }
  state.memory.items = items;
  const pageCount = Math.max(1, Math.ceil(items.length / Math.max(1, Number(state.memory.pageSize) || 12)));
  state.memory.page = Math.min(Math.max(1, state.memory.page), pageCount);
  $('#memoryListMeta').textContent = `${items.length} 条记忆${query ? ` · 搜索“${query}”` : ''} · 第 ${state.memory.page} 页仅显示 ${Math.min(state.memory.pageSize, items.length)} 条`;
  renderMemoryItems(items);
}

async function confirmCandidate(candidate, resolution = '') {
  try {
    let result = memoryResult(await api.memoryConfirm(candidate.candidate_id, resolution));
    if (result?.status === 'conflict' && !resolution) {
      if (confirm('发现相似记忆，覆盖现有记忆？')) result = memoryResult(await api.memoryConfirm(candidate.candidate_id, 'update'));
      else if (confirm('改为另存一条新记忆？')) result = memoryResult(await api.memoryConfirm(candidate.candidate_id, 'create_new'));
      else return;
    }
    await loadMemoryPage();
  } catch (error) {
    toast('候选处理失败', error.message, 'error');
  }
}

function renderCandidates(items) {
  const values = Array.isArray(items) ? items : [];
  $('#memoryCandidatePanel').hidden = values.length === 0;
  const target = $('#memoryCandidates');
  target.replaceChildren();
  for (const candidate of values) {
    const card = document.createElement('article'); card.className = 'memory-card candidate';
    const title = document.createElement('b'); title.textContent = textOr(candidate.title, '未命名候选');
    const body = document.createElement('pre'); body.className = 'memory-content'; body.textContent = textOr(candidate.content, '（空内容）');
    const actions = document.createElement('div'); actions.className = 'memory-actions';
    if (candidate.status === 'conflict') {
      actions.append(memoryButton('覆盖现有', 'primary-button', () => confirmCandidate(candidate, 'update')), memoryButton('另存新记忆', 'secondary-button', () => confirmCandidate(candidate, 'create_new')));
    } else actions.append(memoryButton('确认', 'primary-button', () => confirmCandidate(candidate)));
    actions.append(memoryButton('拒绝', 'danger-button', async () => { memoryResult(await api.memoryReject(candidate.candidate_id)); await loadMemoryPage(); }));
    card.append(title, body, actions);
    target.appendChild(card);
  }
}

async function loadMemoryPage() {
  try {
    const [statusResponse, candidateResponse] = await Promise.all([api.memoryStatus(), api.memoryCandidates()]);
    renderMemoryStatus(memoryResult(statusResponse));
    const candidates = memoryResult(candidateResponse);
    renderCandidates(candidates?.items || []);
    await loadMemoryItems();
  } catch (error) {
    $('#memoryListMeta').textContent = '本地记忆读取失败';
    $('#memoryList').textContent = `读取失败：${error.message}`;
  }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  $('#closeManager').onclick = () => api.closeManager();
  $('#refreshButton').onclick = async () => {
    await Promise.all([refreshSnapshot({ force: true, forceForms: true }), refreshWorkspaceHub(), refreshTaskRuntime(), loadLogs()]);
  };
  $('#runtimeActionButton').onclick = () => runRuntime(state.snapshot?.status?.runtimeRunning ? 'restart' : 'start');
  $('#statusRuntimeButton').onclick = () => runRuntime(state.snapshot?.status?.runtimeRunning ? 'restart' : 'start');
  $('#statusWorkspaceButton').onclick = () => api.openWorkspaceWindow();
  $('#openWorkspacePageCenter').onclick = () => api.openWorkspaceWindow();
  $('#openWorkspaceAuth').onclick = () => api.openWorkspaceWindow();
  $('#openGuideTop').onclick = () => navigate('setup-guide');
  $('#openGuideSettings').onclick = () => navigate('setup-guide');
  $('#setupRefresh').onclick = async () => {
    await refreshSnapshot({ force: true, forceForms: true, quiet: true });
    renderSetupGuide();
  };
  $('#setupSaveTunnelId').onclick = saveSetupTunnelId;
  $('#setupSaveRuntimeKey').onclick = saveSetupRuntimeKey;
  $('#setupOpenWorkspace').onclick = () => api.openWorkspaceWindow();
  $('#setupRecheckWorkspace').onclick = async () => {
    await refreshSnapshot({ force: true, forceForms: true, quiet: true });
    renderSetupGuide();
  };
  $$('.setup-link').forEach((button) => {
    button.onclick = async () => {
      try { unwrap(await api.openSetupLink(button.dataset.setupLink)); }
      catch (error) { toast('打开页面失败', error.message, 'error'); }
    };
  });
  $$('.setup-copy').forEach((button) => {
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyValue || '');
        toast('已复制', button.dataset.copyValue || '');
      } catch {
        toast('复制失败', '请手动复制。', 'error');
      }
    };
  });
  $('#setupStartServices').onclick = () => {
    const snapshot = state.snapshot || {};
    const settings = snapshot.settings || {};
    if (!snapshot.secrets?.runtimeApiKey || !settings.tunnelId) {
      return toast('请先完成第 1 步', '保存 Tunnel ID 和 API Key 后才能启动服务。', 'error');
    }
    if (!settings.workspace) {
      return toast('请先设置工作区', '点击第 2 步的“添加 / 选择工作区”。', 'error');
    }
    return runRuntime(snapshot.status?.runtimeRunning ? 'restart' : 'start');
  };
  $('#setupBackToChat').onclick = () => api.closeManager();

  $('#startupDiagnose').onclick = runDiagnostics;
  $('#issueDiagnose').onclick = runDiagnostics;
  $('#worktreeViewDiff').onclick = viewWorktreeDiff;
  $('#worktreeApply').onclick = applyWorktree;
  $('#worktreeDiscard').onclick = discardWorktree;

  $('#themeSelect').onchange = async () => {
    applyTheme($('#themeSelect').value);
    try { await saveCommonSettings(); } catch (error) { toast('设置保存失败', error.message, 'error'); }
  };
  ['#startWithWindowsToggle', '#autoStartToggle', '#keepRunningToggle', '#taskNotificationsToggle', '#taskNotificationSoundToggle'].forEach((selector) => {
    $(selector).onchange = () => saveCommonSettings().catch((error) => toast('设置保存失败', error.message, 'error'));
  });
  $('#proxyModeSelect').onchange = () => { $('#manualProxyField').hidden = $('#proxyModeSelect').value !== 'manual'; };
  $('#proxyDetect').onclick = detectProxy;
  $('#saveConnectionSettings').onclick = () => saveConnectionSettings().catch((error) => toast('连接配置保存失败', error.message, 'error'));
  $('#saveRuntimeKey').onclick = async () => {
    const value = $('#runtimeKeyInput').value.trim();
    if (!value) return toast('请先粘贴 Runtime API Key', '', 'error');
    try {
      unwrap(await api.saveRuntimeKey(value));
      $('#runtimeKeyInput').value = '';
      toast('Runtime API Key 已安全保存');
      await refreshSnapshot({ force: true, forceForms: true, quiet: true });
    } catch (error) { toast('密钥保存失败', error.message, 'error'); }
  };
  $('#removeRuntimeKey').onclick = async () => {
    if (!confirm('删除本机保存的 Runtime API Key？')) return;
    try { unwrap(await api.removeRuntimeKey()); await refreshSnapshot({ force: true, quiet: true }); } catch (error) { toast('删除失败', error.message, 'error'); }
  };
  $('#regenerateToken').onclick = async () => {
    try { unwrap(await api.regenerateMcpToken()); toast('本地工具认证 Token 已重新生成', '重启服务后生效。'); } catch (error) { toast('生成失败', error.message, 'error'); }
  };
  $('#clearChatSession').onclick = async () => {
    if (!confirm('清除内嵌 ChatGPT 的 Cookie、缓存和登录状态？')) return;
    try { unwrap(await api.clearChatSession()); toast('ChatGPT 登录数据已清除'); } catch (error) { toast('清除失败', error.message, 'error'); }
  };

  $('#memoryRefresh').onclick = loadMemoryPage;
  $('#memorySearchButton').onclick = () => loadMemoryItems({ resetPage: true }).catch((error) => toast('搜索失败', error.message, 'error'));
  $('#memorySearch').onkeydown = (event) => { if (event.key === 'Enter') loadMemoryItems({ resetPage: true }).catch(() => {}); };
  $('#memoryScope').onchange = () => loadMemoryItems({ resetPage: true }).catch(() => {});
  $('#memoryPageSize').onchange = () => { state.memory.pageSize = Number($('#memoryPageSize').value) || 12; state.memory.page = 1; renderMemoryItems(state.memory.items); loadMemoryItems().catch((error) => toast('记忆分页刷新失败', error.message, 'error')); };
  $('#memoryPrevPage').onclick = () => { if (state.memory.page > 1) { state.memory.page -= 1; renderMemoryItems(state.memory.items); } };
  $('#memoryNextPage').onclick = () => { const pages = Math.max(1, Math.ceil(state.memory.items.length / state.memory.pageSize)); if (state.memory.page < pages) { state.memory.page += 1; renderMemoryItems(state.memory.items); } };
  $('#memorySelectPage').onchange = (event) => {
    const pageSize = Math.max(1, Number(state.memory.pageSize) || 12);
    const pageItems = state.memory.items.slice((state.memory.page - 1) * pageSize, state.memory.page * pageSize);
    for (const item of pageItems) {
      const id = String(item.memory_id);
      if (event.target.checked) state.memory.selected.add(id); else state.memory.selected.delete(id);
    }
    renderMemoryItems(state.memory.items);
  };
  $('#memoryBatchArchive').onclick = () => archiveSelectedMemories().catch((error) => { setBusy(false); toast('批量归档失败', error.message, 'error'); });
  $('#memoryAutoMode').onchange = async () => { try { memoryResult(await api.memorySetConfig($('#memoryAutoMode').value)); await loadMemoryPage(); } catch (error) { toast('模式更新失败', error.message, 'error'); } };
  $('#memoryExport').onclick = async () => { try { const result = memoryResult(await api.memoryExport()); if (!result?.canceled) toast('本地记忆已导出', textOr(result?.path, 'ZIP 备份已保存')); } catch (error) { toast('导出失败', error.message, 'error'); } };
  $('#memoryImport').onclick = async () => { if (!confirm('导入本地记忆备份？')) return; try { const result = memoryResult(await api.memoryImport(false)); if (!result?.canceled) { toast('本地记忆已导入', `导入 ${Number(result?.imported || 0)} 条`); await loadMemoryPage(); } } catch (error) { toast('导入失败', error.message, 'error'); } };

  $('#runDiagnostics').onclick = runDiagnostics;
  $('#repairHealth').onclick = repairHealth;
  $('#exportSupportReport').onclick = async () => { try { const result = unwrap(await api.exportSupportReport()); if (!result?.canceled) toast('脱敏支持报告已保存', result?.filename || ''); } catch (error) { toast('导出失败', error.message, 'error'); } };
  $('#refreshLogs').onclick = loadLogs;
  $('#clearLogs').onclick = async () => { if (!confirm('清空助手运行日志？')) return; try { unwrap(await api.clearLogs()); state.logs = []; renderLogs(); } catch (error) { toast('清空失败', error.message, 'error'); } };

}

async function initialize() {
  bindEvents();
  const requested = location.hash.replace(/^#/, '');
  navigate(pageMeta[requested] ? requested : 'status');
  const [snapshot] = await Promise.all([
    refreshSnapshot({ force: true, forceForms: true, quiet: true }),
    refreshWorkspaceHub(),
    refreshTaskRuntime(),
    loadLogs()
  ]);
  if (snapshot?.settings?.theme) applyTheme(snapshot.settings.theme);
  document.body.classList.remove('booting');

  api.onProgress?.(handleProgress);
  api.onStatus?.(() => refreshSnapshot({ quiet: true }));
  api.onHeartbeat?.(() => {
    if (state.currentPage === 'status') {
      refreshSnapshot({ quiet: true });
      refreshTaskRuntime();
    }
  });
  api.onChatState?.((chat) => {
    if (!state.snapshot) return;
    state.snapshot.chat = chat ? { ...(state.snapshot.chat || {}), ...chat } : state.snapshot.chat;
    renderSnapshot(state.snapshot);
  });
  api.onWorkspaceChanged?.(async () => {
    await Promise.all([
      refreshSnapshot({ force: true, forceForms: true, quiet: true }),
      refreshWorkspaceHub()
    ]);
    if (state.currentPage === 'setup-guide') renderSetupGuide();
  });
  api.onLog?.((entry) => {
    state.logs.push(entry);
    if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
    renderIssueFromLogs();
    if (state.currentPage === 'settings') renderLogs();
  });

  setInterval(() => {
    if (state.currentPage === 'status') refreshTaskRuntime();
  }, 4000);
  setInterval(() => {
    if (state.currentPage === 'status' || state.currentPage === 'workspace') refreshWorkspaceHub();
  }, 12000);
}

initialize().catch((error) => {
  document.body.classList.remove('booting');
  toast('管理中心初始化失败', error.message, 'error');
});
