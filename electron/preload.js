const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpAssistant', {
  snapshot: (options) => ipcRenderer.invoke('app:snapshot', options),
  chooseWorkspace: () => ipcRenderer.invoke('dialog:workspace'),
  switchWorkspace: (workspace) => ipcRenderer.invoke('workspace:switch', workspace),
  updateAuthorizedRoots: (roots) => ipcRenderer.invoke('workspace:authorized-roots', roots),
  taskState: () => ipcRenderer.invoke('task-state:read'),
  clearTaskState: () => ipcRenderer.invoke('task-state:clear'),
  pauseTask: () => ipcRenderer.invoke('task-state:pause'),
  resumeTask: () => ipcRenderer.invoke('task-state:resume'),
  stopTask: () => ipcRenderer.invoke('task-state:stop'),
  taskHistory: () => ipcRenderer.invoke('task-state:history'),
  performanceTrace: () => ipcRenderer.invoke('performance:read'),
  clearPerformanceTrace: () => ipcRenderer.invoke('performance:clear'),
  workspaceContext: () => ipcRenderer.invoke('mcp:workspace-context'),
  codingToolsGuide: (options = {}) => ipcRenderer.invoke('mcp:coding-tools-guide', options),
  taskRuntime: (options = {}) => ipcRenderer.invoke('mcp:task-runtime', options),
  taskWorktrees: () => ipcRenderer.invoke('mcp:task-worktrees'),
  taskWorktreeDiff: (runId) => ipcRenderer.invoke('mcp:task-worktree-diff', runId),
  applyTaskWorktree: (runId) => ipcRenderer.invoke('mcp:task-worktree-apply', runId),
  discardTaskWorktree: (runId) => ipcRenderer.invoke('mcp:task-worktree-discard', runId),
  testTaskNotification: () => ipcRenderer.invoke('notification:test'),
  inspectBuild: () => ipcRenderer.invoke('build:inspect'),
  runBuild: (options) => ipcRenderer.invoke('build:run', options),
  inspectHealth: () => ipcRenderer.invoke('health:inspect'),
  repairHealth: () => ipcRenderer.invoke('health:repair'),
  closeManager: () => ipcRenderer.invoke('manager:close'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveRuntimeKey: (value) => ipcRenderer.invoke('secrets:runtime-key', value),
  removeRuntimeKey: () => ipcRenderer.invoke('secrets:runtime-key-remove'),
  regenerateMcpToken: () => ipcRenderer.invoke('secrets:mcp-token-regenerate'),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  restart: () => ipcRenderer.invoke('runtime:restart'),
  logs: () => ipcRenderer.invoke('logs:read'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openExternal: (target) => ipcRenderer.invoke('shell:open', target),
  installPython: () => ipcRenderer.invoke('environment:install-python'),
  detectProxy: () => ipcRenderer.invoke('environment:detect-proxy'),
  clearChatSession: () => ipcRenderer.invoke('chat:clear-session'),
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
  onStatus: (listener) => { const wrapped = (_event, payload) => listener(payload); ipcRenderer.on('runtime:status-changed', wrapped); return () => ipcRenderer.removeListener('runtime:status-changed', wrapped); },
  onHeartbeat: (listener) => { const wrapped = (_event, payload) => listener(payload); ipcRenderer.on('runtime:heartbeat', wrapped); return () => ipcRenderer.removeListener('runtime:heartbeat', wrapped); },
  onBuildProgress: (listener) => { const wrapped = (_event, payload) => listener(payload); ipcRenderer.on('build:progress', wrapped); return () => ipcRenderer.removeListener('build:progress', wrapped); }
});


