const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpAssistant', {
  snapshot: (options) => ipcRenderer.invoke('app:snapshot', options),
  openWorkspaceWindow: () => ipcRenderer.invoke('workspace-window:open'),
  openApprovalWindow: () => ipcRenderer.invoke('approval-window:open'),
  workspaceHub: () => ipcRenderer.invoke('workspace:hub'),
  chooseAndSwitchWorkspace: () => ipcRenderer.invoke('workspace:choose-and-switch'),
  chooseAuthorizedRoot: () => ipcRenderer.invoke('workspace:choose-authorized-root'),
  updateAuthorizedRoots: (roots) => ipcRenderer.invoke('workspace:authorized-roots', roots),
  taskState: () => ipcRenderer.invoke('task-state:read'),
  taskRuntime: (options = {}) => ipcRenderer.invoke('mcp:task-runtime', options),
  taskWorktrees: () => ipcRenderer.invoke('mcp:task-worktrees'),
  taskWorktreeDiff: (runId) => ipcRenderer.invoke('mcp:task-worktree-diff', runId),
  applyTaskWorktree: (runId) => ipcRenderer.invoke('mcp:task-worktree-apply', runId),
  discardTaskWorktree: (runId) => ipcRenderer.invoke('mcp:task-worktree-discard', runId),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveRuntimeKey: (value) => ipcRenderer.invoke('secrets:runtime-key', value),
  removeRuntimeKey: () => ipcRenderer.invoke('secrets:runtime-key-remove'),
  regenerateMcpToken: () => ipcRenderer.invoke('secrets:mcp-token-regenerate'),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  restart: () => ipcRenderer.invoke('runtime:restart'),
  detectProxy: () => ipcRenderer.invoke('environment:detect-proxy'),
  clearChatSession: () => ipcRenderer.invoke('chat:clear-session'),

  memoryStatus: () => ipcRenderer.invoke('memory:control', { action: 'status' }),
  memoryList: (options = {}) => ipcRenderer.invoke('memory:control', { ...options, action: 'list' }),
  memorySearch: (query = '', options = {}) => ipcRenderer.invoke('memory:control', { ...options, query, action: 'search' }),
  memoryCandidates: () => ipcRenderer.invoke('memory:control', { action: 'candidates' }),
  memoryConfirm: (candidateId, resolution = '') => ipcRenderer.invoke('memory:control', { action: 'confirm', candidate_id: candidateId, resolution }),
  memoryReject: (candidateId) => ipcRenderer.invoke('memory:control', { action: 'reject', candidate_id: candidateId }),
  memoryUpdate: (memoryId, changes = {}) => ipcRenderer.invoke('memory:control', { ...changes, action: 'update', memory_id: memoryId }),
  memoryArchive: (memoryId) => ipcRenderer.invoke('memory:control', { action: 'archive', memory_id: memoryId, confirm: true }),
  memoryDelete: (memoryId) => ipcRenderer.invoke('memory:control', { action: 'delete', memory_id: memoryId, confirm: true }),
  memorySetConfig: (autoMemory) => ipcRenderer.invoke('memory:control', { action: 'set_config', auto_memory: autoMemory }),
  memoryExport: () => ipcRenderer.invoke('memory:control', { action: 'export' }),
  memoryImport: (applyConfig = false) => ipcRenderer.invoke('memory:control', { action: 'import', apply_config: Boolean(applyConfig) }),

  inspectHealth: () => ipcRenderer.invoke('health:inspect'),
  repairHealth: () => ipcRenderer.invoke('health:repair'),
  doctorInspect: () => ipcRenderer.invoke('doctor:inspect'),
  exportSupportReport: () => ipcRenderer.invoke('support:report-save'),
  logs: () => ipcRenderer.invoke('logs:read'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  closeManager: () => ipcRenderer.invoke('manager:close'),

  onProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:progress', wrapped);
    return () => ipcRenderer.removeListener('runtime:progress', wrapped);
  },
  onLog: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('logs:entry', wrapped);
    return () => ipcRenderer.removeListener('logs:entry', wrapped);
  },
  onStatus: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:status-changed', wrapped);
    return () => ipcRenderer.removeListener('runtime:status-changed', wrapped);
  },
  onHeartbeat: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:heartbeat', wrapped);
    return () => ipcRenderer.removeListener('runtime:heartbeat', wrapped);
  },
  onChatState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:state', wrapped);
    return () => ipcRenderer.removeListener('chat:state', wrapped);
  }
});
