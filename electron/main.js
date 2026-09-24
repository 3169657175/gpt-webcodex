const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage, session, Notification } = require('electron');
const { SettingsStore } = require('./services/settingsStore');
const { SecretStore } = require('./services/secretStore');
const { LogService } = require('./services/logService');
const { EnvironmentService } = require('./services/environmentService');
const { RuntimeOrchestrator } = require('./services/runtimeOrchestrator');
const { ChatViewController } = require('./chatViewController');
const { run } = require('./services/commandRunner');
const { resolveProxy, clearProxyCache } = require('./services/proxyService');
const { BuildVerificationService } = require('./services/buildVerificationService');
const { HealthService } = require('./services/healthService');
const { readJson, writeJsonAtomic } = require('./services/jsonStore');
const { LocalMcpClient } = require('./services/localMcpClient');
const { TaskNotificationService } = require('./services/taskNotificationService');
const { NotificationCheckpointStore } = require('./services/notificationCheckpointStore');
const { ApprovalService } = require('./services/approvalService');
const { DoctorService } = require('./services/doctorService');
const { AutoMemoryService } = require('./services/autoMemoryService');
const { WorkspaceManager } = require('./services/workspaceManager');
const { notificationStateFile } = require('./paths');

let chatWindow;
let managerWindow;
let workspaceWindow;
let chatController;
let orchestrator;
let forceQuit = false;
let tray = null;
let buildVerification;
let healthService;
let doctorService;
let taskNotificationService;
let autoMemoryService;
let sharedLocalMcpClient = null;
const settings = new SettingsStore();
const secrets = new SecretStore();
const log = new LogService();
const environment = new EnvironmentService();
const notificationCheckpoints = new NotificationCheckpointStore(notificationStateFile);
const approvalService = new ApprovalService(settings);
const workspaceManager = new WorkspaceManager(settings);

if (process.platform === 'win32') app.setAppUserModelId('com.gptwebcodex.assistant');

function appIconPath() {
  return path.join(__dirname, 'app-icon.png');
}

function sendManager(channel, payload) {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send(channel, payload);
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertTrustedIpc(event) {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
  if (!url.startsWith('file://')) throw new Error('已阻止来自非本地页面的 IPC 调用。');
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event);
    return handler(event, ...args);
  });
}

function workspaceStatePaths() {
  const workspace = String(settings.load().workspace || '').trim();
  if (!workspace) throw new Error('请先选择工作目录。');
  const root = path.resolve(workspace);
  return {
    root,
    statePath: path.join(root, '.coding-tools', 'task-state.json'),
    historyPath: path.join(root, '.coding-tools', 'task-history.json'),
    performancePath: path.join(root, '.coding-tools', 'performance.json')
  };
}

function archiveTask(state, historyPath, reason) {
  if (!state || typeof state !== 'object' || (!state.task_id && !state.objective)) return;
  const history = readJson(historyPath, []);
  const items = Array.isArray(history) ? history : [];
  items.push({ ...state, archived_at: new Date().toISOString(), archive_reason: reason });
  writeJsonAtomic(historyPath, items.slice(-100));
}

async function invokeSafely(action) {
  try { return { ok: true, data: await action() }; }
  catch (error) {
    return {
      ok: false,
      error: safeMessage(error),
      code: String(error?.code || ''),
      details: error?.details && typeof error.details === 'object' ? error.details : null
    };
  }
}

async function callLocalMcpTool(name, args = {}) {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  const client = sharedLocalMcpClient;
  if (!client.tools.length) await client.discoverTools();
  let result;
  try {
    result = await client.callTool(name, args);
  } catch (error) {
    client.resetDiscoveryState();
    if (!localMcpCallCanRetry(name, args)) throw error;
    await client.discoverTools();
    result = await client.callTool(name, args);
  }
  if (result?.isError) {
    const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
    throw new Error(text || `${name} 调用失败。`);
  }
  return result?.structuredContent ?? result;
}

function invalidateLocalMcpDiscovery() {
  sharedLocalMcpClient?.resetDiscoveryState();
}

function localMcpCallCanRetry(name, args = {}) {
  if (name === 'workspace_context' || name === 'coding_tools_guide') return true;
  if (name !== 'task_control') return false;
  return ['get', 'history', 'operation', 'worktree_list', 'worktree_get', 'worktree_diff']
    .includes(String(args?.action || 'get').toLowerCase());
}

function showChatWindow() {
  const target = createChatWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const icon = nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('网页 MCP 助手 · 后台运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开网页 MCP 助手', click: () => showChatWindow() },
    { label: '打开管理设置', click: () => { showChatWindow(); openManagerWindow(); } },
    { type: 'separator' },
    { label: '退出助手（保留 MCP 服务）', click: () => { forceQuit = true; app.quit(); } }
  ]));
  tray.on('click', () => showChatWindow());
  tray.on('double-click', () => showChatWindow());
  return tray;
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  chatWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f7f8',
    title: '网页 MCP 助手',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'browserPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  chatWindow.removeMenu();
  chatWindow.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'));

  chatController = new ChatViewController({
    window: chatWindow,
    log,
    settings,
    toolbarHeight: 164,
    onState: (payload) => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat:state', payload);
      sendManager('chat:state', payload);
    },
    onDownload: (payload) => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat:download', payload);
    },
    onConversationTurn: (turn) => autoMemoryService?.ingestTurn(turn)
  });
  chatController.mount();

  chatWindow.once('ready-to-show', () => chatWindow.show());
  chatWindow.on('closed', () => {
    if (chatController) chatController.dispose();
    chatController = null;
    chatWindow = null;
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.destroy();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.destroy();
  });
  chatWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    if (settings.load().keepRunningOnClose) {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.hide();
      if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.hide();
      chatWindow.hide();
      return;
    }
    if (!orchestrator) {
      forceQuit = true;
      app.quit();
      return;
    }
    orchestrator.stop().catch((error) => log.error(error.message, { stage: 'close' })).finally(() => {
      forceQuit = true;
      app.quit();
    });
  });
  return chatWindow;
}

function openWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.show();
    workspaceWindow.focus();
    return workspaceWindow;
  }

  const chatBounds = chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null;
  const width = 820;
  const height = 620;
  const x = chatBounds ? Math.round(chatBounds.x + Math.max(0, (chatBounds.width - width) / 2)) : undefined;
  const y = chatBounds ? Math.round(chatBounds.y + Math.max(0, (chatBounds.height - height) / 2)) : undefined;

  workspaceWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 700,
    minHeight: 540,
    show: false,
    skipTaskbar: true,
    frame: false,
    transparent: false,
    backgroundColor: '#f7f7f8',
    title: '网页 MCP 助手 · 工作区中心',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'workspacePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  workspaceWindow.removeMenu();
  const initialTheme = settings.load().theme === 'light' ? 'light' : 'dark';
  workspaceWindow.loadFile(path.join(__dirname, '..', 'renderer', 'workspace.html'), { query: { theme: initialTheme } });
  workspaceWindow.once('ready-to-show', () => workspaceWindow.show());
  workspaceWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    workspaceWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
  });
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

function openApprovalWindow() {
  const pending = approvalService.list();
  if (!pending.pending_count) return null;
  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.show();
    approvalWindow.focus();
    approvalWindow.webContents.send('approval:refresh');
    return approvalWindow;
  }

  const chatBounds = chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null;
  const width = 540;
  const height = 420;
  const x = chatBounds ? Math.round(chatBounds.x + Math.max(0, (chatBounds.width - width) / 2)) : undefined;
  const y = chatBounds ? Math.round(chatBounds.y + Math.max(0, (chatBounds.height - height) / 2)) : undefined;

  approvalWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 480,
    minHeight: 340,
    show: false,
    skipTaskbar: true,
    frame: false,
    resizable: true,
    backgroundColor: '#f7f7f8',
    title: '网页 MCP 助手 · 需要确认',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'approvalPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  approvalWindow.removeMenu();
  approvalWindow.loadFile(path.join(__dirname, '..', 'renderer', 'approval.html'));
  approvalWindow.once('ready-to-show', () => approvalWindow.show());
  approvalWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    approvalWindow.hide();
  });
  approvalWindow.on('closed', () => { approvalWindow = null; });
  return approvalWindow;
}

function broadcastWorkspaceHub(hub = workspaceManager.hub()) {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('workspace:changed', hub);
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.webContents.send('workspace:changed', hub);
  return hub;
}

function openManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return managerWindow;
  }

  const chatBounds = chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null;
  const width = 980;
  const height = 720;
  const x = chatBounds ? Math.round(chatBounds.x + Math.max(0, (chatBounds.width - width) / 2)) : undefined;
  const y = chatBounds ? Math.round(chatBounds.y + Math.max(0, (chatBounds.height - height) / 2)) : undefined;

  managerWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 820,
    minHeight: 580,
    show: false,
    skipTaskbar: true,
    frame: false,
    transparent: false,
    backgroundColor: '#f7f7f8',
    title: '网页 MCP 助手 · 管理中心',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  managerWindow.removeMenu();
  const initialTheme = settings.load().theme === 'light' ? 'light' : 'dark';
  managerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { theme: initialTheme } });
  managerWindow.once('ready-to-show', () => managerWindow.show());
  managerWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    managerWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
  });
  managerWindow.on('closed', () => { managerWindow = null; });
  return managerWindow;
}

async function prepareLocalHistoryResume(historyId) {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  return sharedLocalMcpClient.prepareHistoryResume(historyId);
}

async function compactLocalSession() {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  return sharedLocalMcpClient.compactLocalSession();
}

async function searchLocalHistory(options = {}) {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  return sharedLocalMcpClient.historySearch(options);
}

function localMcpClient() {
  const current = settings.load();
  const token = secrets.get('mcpAuthToken');
  if (!token) throw new Error('本地 MCP 尚未生成认证 Token。');
  if (!sharedLocalMcpClient) sharedLocalMcpClient = new LocalMcpClient({ port: current.mcpPort, token, log });
  else sharedLocalMcpClient.configure({ port: current.mcpPort, token });
  return sharedLocalMcpClient;
}

const MEMORY_CONTROL_ACTIONS = new Set([
  'status', 'config', 'set_config', 'list', 'search', 'candidates', 'propose', 'confirm', 'reject', 'ingest',
  'update', 'revisions', 'restore', 'archive', 'delete', 'export', 'import'
]);

function sanitizeMemoryControlPayload(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const action = String(source.action || 'status').trim().toLowerCase();
  if (!MEMORY_CONTROL_ACTIONS.has(action)) throw new Error('不支持的本地记忆操作。');
  const result = { action };
  const copyText = (key, limit) => {
    if (source[key] !== undefined && source[key] !== null) result[key] = String(source[key]).slice(0, limit);
  };
  copyText('query', 1000); copyText('scope', 20); copyText('memory_type', 40); copyText('title', 300);
  copyText('content', 131072); copyText('memory_id', 80); copyText('candidate_id', 80); copyText('resolution', 40);
  copyText('auto_memory', 20); copyText('project_id', 200); copyText('task_id', 200); copyText('source', 120);
  copyText('user_text', 6000); copyText('assistant_text', 8000); copyText('conversation_id', 160); copyText('turn_id', 160);
  if (source.limit !== undefined) result.limit = Math.max(1, Math.min(Number(source.limit || 50), 200));
  if (source.revision !== undefined) result.revision = Math.max(1, Number(source.revision || 1));
  if (source.confidence !== undefined) result.confidence = Math.max(0, Math.min(Number(source.confidence || 0), 1));
  for (const key of ['pinned', 'archived', 'allow_sensitive_personal', 'confirm', 'apply_config']) {
    if (source[key] !== undefined) result[key] = source[key] === true;
  }
  if (['restore', 'archive', 'delete'].includes(action) && result.confirm !== true) {
    throw new Error('此记忆操作需要本机明确确认。');
  }
  return result;
}

async function controlLocalMemory(payload = {}) {
  const request = sanitizeMemoryControlPayload(payload);
  const response = await localMcpClient().memoryControl(request);
  if (request.action === 'status' && response?.result && autoMemoryService) response.result.auto_capture = autoMemoryService.getStatus();
  return response;
}

function registerIpc() {
  secureHandle('app:snapshot', (_event, options) => invokeSafely(async () => {
    const snapshot = await orchestrator.snapshot(options || {});
    return { ...snapshot, chat: chatController?.getState() || null };
  }));
  secureHandle('app:lightweight-snapshot', () => invokeSafely(() => orchestrator.lightweightSnapshot()));
  secureHandle('workspace:hub', () => invokeSafely(() => workspaceManager.hub()));
  secureHandle('workspace:inspect', () => invokeSafely(() => workspaceManager.inspectAll()));
  secureHandle('workspace:remove', (_event, workspace) => invokeSafely(() => broadcastWorkspaceHub(workspaceManager.remove(workspace))));
  secureHandle('workspace:cleanup-invalid', () => invokeSafely(() => {
    const result = workspaceManager.cleanupInvalid();
    broadcastWorkspaceHub(result.hub);
    return result;
  }));
  secureHandle('workspace:favorite', (_event, workspace) => invokeSafely(() => broadcastWorkspaceHub(workspaceManager.toggleFavorite(workspace))));
  secureHandle('workspace:storage', () => invokeSafely(() => workspaceManager.storageStatus()));
  secureHandle('workspace:cleanup-storage', () => invokeSafely(async () => {
    const current = settings.load();
    let worktreeCleanup = null;
    try {
      worktreeCleanup = await callLocalMcpTool('task_control', {
        action: 'worktree_cleanup',
        retention_days: Number(current.storageRetentionDays || 7),
        keep: Number(current.storageRetentionCount || 5)
      });
    } catch (error) {
      log.warn?.('workspace-worktree-cleanup-skipped', { error: safeMessage(error) });
    }
    const localCleanup = workspaceManager.cleanupStorage();
    const removedWorktrees = Array.isArray(worktreeCleanup?.cleanup?.removed)
      ? worktreeCleanup.cleanup.removed.map((item) => item?.path || item).filter(Boolean)
      : [];
    return { ...localCleanup, removedWorktrees, worktreeCleanup };
  }));
  secureHandle('workspace:switch', (_event, workspace) => invokeSafely(async () => {
    const result = await orchestrator.switchWorkspace(workspace);
    workspaceManager.touch(workspace);
    invalidateLocalMcpDiscovery();
    taskNotificationService?.reset();
    taskNotificationService?.restartStream();
    broadcastWorkspaceHub();
    return result;
  }));
  secureHandle('workspace:authorized-roots', (_event, roots) => invokeSafely(async () => {
    const snapshot = await orchestrator.updateAuthorizedRoots(Array.isArray(roots) ? roots : []);
    broadcastWorkspaceHub();
    return snapshot;
  }));
  secureHandle('approval:list', () => invokeSafely(() => approvalService.list()));
  secureHandle('approval:decide', (_event, requestId, decision) => invokeSafely(() => approvalService.decide(requestId, decision)));
  secureHandle('workspace:choose-authorized-root', () => invokeSafely(async () => {
    const dialogParent = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : chatWindow;
    const result = await dialog.showOpenDialog(dialogParent, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = path.resolve(result.filePaths[0]);
    const current = settings.load();
    const roots = Array.isArray(current.authorizedRoots) ? current.authorizedRoots : [];
    const key = selected.toLowerCase();
    const merged = roots.some((item) => String(item).toLowerCase() === key) ? roots : [...roots, selected];
    const snapshot = await orchestrator.updateAuthorizedRoots(merged);
    broadcastWorkspaceHub();
    return { selected, snapshot };
  }));
  secureHandle('task-state:read', () => invokeSafely(async () => {
    let statePath;
    try { ({ statePath } = workspaceStatePaths()); } catch { return { exists: false, state: null }; }
    try {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return { exists: true, statePath, state };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, statePath, state: null };
      throw new Error(`任务状态读取失败：${safeMessage(error)}`);
    }
  }));
  secureHandle('task-state:clear', () => invokeSafely(async () => {
    let paths;
    try { paths = workspaceStatePaths(); } catch { return false; }
    const { statePath, historyPath } = paths;
    archiveTask(readJson(statePath, null), historyPath, 'cleared-from-assistant');
    await fs.unlink(statePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    return true;
  }));
  secureHandle('task-state:pause', () => invokeSafely(() => callLocalMcpTool('task_control', {
    action: 'pause',
    reason: '用户从桌面助手暂停任务'
  })));
  secureHandle('task-state:resume', () => invokeSafely(() => callLocalMcpTool('task_control', {
    action: 'resume'
  })));
  secureHandle('task-state:stop', () => invokeSafely(() => callLocalMcpTool('task_control', {
    action: 'stop',
    reason: '用户从 ChatGPT 主窗口停止任务'
  })));
  secureHandle('task-state:history', (_event, options = {}) => invokeSafely(async () => {
    try { return await searchLocalHistory(options || {}); }
    catch (runtimeError) {
      let historyPath;
      try { ({ historyPath } = workspaceStatePaths()); } catch { return { items: [], source: 'legacy', warning: safeMessage(runtimeError) }; }
      try {
        const value = JSON.parse(await fs.readFile(historyPath, 'utf8'));
        const query = String(options?.query || '').trim().toLowerCase();
        const items = (Array.isArray(value) ? value : []).slice().reverse().filter((item) => {
          if (!query) return true;
          return [item?.objective, item?.summary, item?.failure, ...(Array.isArray(item?.modified_files) ? item.modified_files.map((entry) => entry?.path) : [])]
            .filter(Boolean).join(' ').toLowerCase().includes(query);
        }).slice(0, Math.max(1, Math.min(Number(options?.limit || 30), 50)));
        return { items, count: items.length, source: 'legacy', warning: `SQLite 历史暂不可用：${safeMessage(runtimeError)}` };
      } catch (error) {
        if (error?.code === 'ENOENT') return { items: [], count: 0, source: 'legacy', warning: safeMessage(runtimeError) };
        throw error;
      }
    }
  }));
  secureHandle('task-state:history-prepare', (_event, historyId) => invokeSafely(() => prepareLocalHistoryResume(historyId)));
  secureHandle('performance:read', () => invokeSafely(async () => {
    let performancePath;
    try { ({ performancePath } = workspaceStatePaths()); } catch { return null; }
    try { return JSON.parse(await fs.readFile(performancePath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }));
  secureHandle('performance:clear', () => invokeSafely(async () => {
    const { performancePath } = workspaceStatePaths();
    await fs.rm(performancePath, { force: true });
    return true;
  }));
  secureHandle('mcp:workspace-context', () => invokeSafely(() => callLocalMcpTool('workspace_context', { detail: 'compact', max_entries: 80 })));
  secureHandle('mcp:coding-tools-guide', (_event, options) => invokeSafely(() => callLocalMcpTool('coding_tools_guide', options || {})));
  secureHandle('mcp:task-runtime', (_event, options = {}) => invokeSafely(() => callLocalMcpTool('task_control', {
    action: 'get',
    detail: String(options?.detail || 'compact') === 'full' ? 'full' : 'compact'
  })));
  secureHandle('mcp:task-worktrees', () => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_list' })));
  secureHandle('mcp:task-worktree-diff', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_diff', run_id: String(runId || ''), max_bytes: 262144 })));
  secureHandle('mcp:task-worktree-apply', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_apply', run_id: String(runId || '') })));
  secureHandle('mcp:task-worktree-discard', (_event, runId) => invokeSafely(() => callLocalMcpTool('task_control', { action: 'worktree_discard', run_id: String(runId || '') })));
  secureHandle('local-session:compact', () => invokeSafely(() => compactLocalSession()));
  secureHandle('memory:control', (_event, payload = {}) => invokeSafely(async () => {
    const action = String(payload?.action || 'status').trim().toLowerCase();
    if (action === 'export') {
      const result = await dialog.showSaveDialog(managerWindow || chatWindow, {
        title: '导出本地记忆备份',
        defaultPath: path.join(app.getPath('documents'), `gpt-webcodex-memory-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.zip`),
        filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      return localMcpClient().memoryControl({ action: 'export', target: result.filePath });
    }
    if (action === 'import') {
      const result = await dialog.showOpenDialog(managerWindow || chatWindow, {
        title: '导入本地记忆备份',
        properties: ['openFile'],
        filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      return localMcpClient().memoryControl({ action: 'import', source: result.filePaths[0], confirm: true, apply_config: payload?.apply_config === true });
    }
    return controlLocalMemory(payload);
  }));
  secureHandle('notification:test', () => invokeSafely(() => taskNotificationService?.testNotification() ?? false));
  secureHandle('build:inspect', () => invokeSafely(() => buildVerification.inspect(settings.load().workspace)));
  secureHandle('build:run', (_event, options) => invokeSafely(() => buildVerification.execute(settings.load().workspace, options || {})));
  secureHandle('health:inspect', () => invokeSafely(() => healthService.inspect()));
  secureHandle('health:repair', () => invokeSafely(() => healthService.repair()));
  secureHandle('doctor:inspect', () => invokeSafely(() => doctorService.inspect({ network: true })));
  secureHandle('support:report-save', () => invokeSafely(async () => {
    const report = await doctorService.createSupportReport({ network: true });
    const result = await dialog.showSaveDialog(managerWindow || chatWindow, {
      title: '保存脱敏支持报告',
      defaultPath: path.join(app.getPath('documents'), report.filename),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true, filename: report.filename };
    await fs.writeFile(result.filePath, report.text, 'utf8');
    return { canceled: false, filename: path.basename(result.filePath), filePath: result.filePath };
  }));
  secureHandle('workspace:choose-and-switch', () => invokeSafely(async () => {
    const dialogParent = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : chatWindow;
    const result = await dialog.showOpenDialog(dialogParent, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const switched = await orchestrator.switchWorkspace(result.filePaths[0]);
    workspaceManager.touch(result.filePaths[0]);
    invalidateLocalMcpDiscovery();
    taskNotificationService?.reset();
    taskNotificationService?.restartStream();
    broadcastWorkspaceHub();
    return switched;
  }));
  secureHandle('manager:close', () => invokeSafely(async () => {
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
    return true;
  }));
  secureHandle('manager:open', () => invokeSafely(async () => { openManagerWindow(); return true; }));
  secureHandle('workspace-window:open', () => invokeSafely(async () => { openWorkspaceWindow(); return true; }));
  secureHandle('approval-window:open', () => invokeSafely(async () => {
    openApprovalWindow();
    return true;
  }));
  secureHandle('approval-window:close', () => invokeSafely(async () => {
    if (approvalWindow && !approvalWindow.isDestroyed()) approvalWindow.hide();
    return true;
  }));
  secureHandle('workspace-window:close', () => invokeSafely(async () => {
    if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.hide();
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
    return true;
  }));
  secureHandle('chat:navigate', (_event, action) => invokeSafely(async () => chatController?.navigate(action)));
  secureHandle('chat:status', () => invokeSafely(async () => chatController?.getState() || null));
  secureHandle('chat:clear-session', () => invokeSafely(async () => {
    if (!chatController) throw new Error('ChatGPT 页面尚未初始化。');
    await chatController.clearSession();
    return true;
  }));
  secureHandle('dialog:workspace', () => invokeSafely(async () => {
    const result = await dialog.showOpenDialog(managerWindow || chatWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  }));
  secureHandle('settings:save', (_event, patch) => invokeSafely(async () => {
    const allowed = ['mcpPort', 'healthPort', 'proxyMode', 'proxyUrl', 'tunnelId', 'tunnelProfile', 'startWithWindows', 'autoStartServices', 'keepRunningOnClose', 'taskNotifications', 'taskNotificationSound', 'compactToolCalls', 'theme'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.includes(key)));
    const previous = settings.load();
    const proxyChanged = (Object.hasOwn(clean, 'proxyMode') && String(clean.proxyMode || '') !== String(previous.proxyMode || 'auto'))
      || (Object.hasOwn(clean, 'proxyUrl') && String(clean.proxyUrl || '') !== String(previous.proxyUrl || ''));
    const saved = settings.save(clean);
    if (Object.hasOwn(clean, 'startWithWindows')) {
      app.setLoginItemSettings({ openAtLogin: Boolean(saved.startWithWindows), path: process.execPath });
    }
    if (Object.hasOwn(clean, 'mcpPort')) taskNotificationService?.restartStream();
    clearProxyCache();
    if (proxyChanged && chatController) await chatController.applyBrowserProxyPolicy({ closeConnections: true, forceProbe: true });
    if (Object.hasOwn(clean, 'compactToolCalls') && chatController) chatController.scheduleChatUiEnhancements();
    return saved;
  }));
  secureHandle('environment:detect-proxy', () => invokeSafely(async () => resolveProxy(settings.load(), { force: true })));
  secureHandle('secrets:runtime-key', (_event, value) => invokeSafely(async () => {
    if (String(value || '').trim().length < 12) throw new Error('Runtime API Key 长度不正确。');
    secrets.set('runtimeApiKey', value);
    return secrets.status();
  }));
  secureHandle('secrets:runtime-key-remove', () => invokeSafely(async () => {
    secrets.remove('runtimeApiKey');
    return secrets.status();
  }));
  secureHandle('secrets:mcp-token-regenerate', () => invokeSafely(async () => {
    secrets.set('mcpAuthToken', crypto.randomBytes(32).toString('base64url'));
    return secrets.status();
  }));
  secureHandle('runtime:start', () => invokeSafely(async () => { const result = await orchestrator.start(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('runtime:stop', () => invokeSafely(async () => { const result = await orchestrator.stop(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('runtime:restart', () => invokeSafely(async () => { const result = await orchestrator.restart(); invalidateLocalMcpDiscovery(); return result; }));
  secureHandle('logs:read', () => invokeSafely(async () => log.read()));
  secureHandle('logs:clear', () => invokeSafely(async () => { log.clear(); return true; }));
  secureHandle('environment:install-python', () => invokeSafely(async () => {
    const result = await run('winget.exe', ['install', '--id', 'Python.Python.3.12', '-e', '--accept-source-agreements', '--accept-package-agreements']);
    return result.stdout;
  }));
  secureHandle('shell:open', (_event, target) => invokeSafely(async () => {
    const allowed = new Set(['chatgpt-connectors', 'openai-tunnels', 'openai-runtime-keys', 'tunnel-ui']);
    if (!allowed.has(target)) throw new Error('不允许打开该地址。');
    if (target === 'chatgpt-connectors' && chatController) {
      await chatController.openUrl('https://chatgpt.com/#settings/Connectors');
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.show();
        chatWindow.focus();
      }
      return true;
    }
    const current = settings.load();
    const urls = {
      'chatgpt-connectors': 'https://chatgpt.com/#settings/Connectors',
      'openai-tunnels': 'https://platform.openai.com/settings/organization/tunnels',
      'openai-runtime-keys': 'https://platform.openai.com/settings/organization/api-keys',
      'tunnel-ui': `http://127.0.0.1:${current.healthPort}/ui`
    };
    await shell.openExternal(urls[target]);
    return true;
  }));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => showChatWindow());

app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.load().startWithWindows), path: process.execPath });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  createTray();
  orchestrator = new RuntimeOrchestrator({
    settings,
    secrets,
    environment,
    log,
    emitProgress: (payload) => sendManager('runtime:progress', payload),
    emitStatus: (payload) => sendManager('runtime:status-changed', payload)
  });
  buildVerification = new BuildVerificationService(log, (payload) => sendManager('build:progress', payload));
  healthService = new HealthService({ settings, secrets, environment, orchestrator });
  doctorService = new DoctorService({
    settings,
    secrets,
    environment,
    orchestrator,
    healthService,
    log,
    getChatState: () => chatController?.getState() || {},
    appVersion: app.getVersion()
  });
  autoMemoryService = new AutoMemoryService({ memoryControl: (payload) => localMcpClient().memoryControl(sanitizeMemoryControlPayload(payload)), log });
  log.on('entry', (payload) => sendManager('logs:entry', payload));
  registerIpc();
  const startupSettings = settings.load();
  createChatWindow();
  taskNotificationService = new TaskNotificationService({
    getSettings: () => settings.load(),
    getWorkspace: () => settings.load().workspace,
    loadNotificationCheckpoint: (workspace) => notificationCheckpoints.load(workspace),
    saveNotificationCheckpoint: (workspace, checkpoint) => notificationCheckpoints.save(workspace, checkpoint),
    readTaskState: () => {
      try { return readJson(workspaceStatePaths().statePath, null); }
      catch { return null; }
    },
    subscribeTaskEvents: (listener, onError, streamOptions = {}) => {
      const current = settings.load();
      const token = secrets.get('mcpAuthToken');
      const client = new LocalMcpClient({ port: current.mcpPort, token, log });
      return client.subscribeTaskEvents(listener, { onError, ...streamOptions });
    },
    getChatWindow: () => chatWindow,
    getTray: () => tray,
    showChatWindow,
    NotificationClass: Notification,
    icon: appIconPath(),
    log
  });
  taskNotificationService.start();
  setInterval(() => orchestrator.supervise().then((status) => {
    taskNotificationService?.acceptRuntimeStatus?.(status);
    sendManager('runtime:heartbeat', status);
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('runtime:heartbeat', status);
  }).catch(() => {}), 5000).unref();
  log.info('网页 MCP 助手已启动');
  if (startupSettings.autoStartServices && !orchestrator.isManuallyStopped()) {
    orchestrator.start({ automatic: true }).catch((error) => log.error(error.message, { stage: 'auto-start' }));
  }
});

app.on('before-quit', () => {
  forceQuit = true;
  taskNotificationService?.stop();
});
app.on('window-all-closed', () => {
  if (!forceQuit && settings.load().keepRunningOnClose) return;
  if (!forceQuit) app.quit();
});
app.on('activate', () => showChatWindow());






