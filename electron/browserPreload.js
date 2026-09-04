const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAssistant', {
  openManager: () => ipcRenderer.invoke('manager:open'),
  navigate: (action) => ipcRenderer.invoke('chat:navigate', action),
  chatStatus: () => ipcRenderer.invoke('chat:status'),
  lightweightStatus: () => ipcRenderer.invoke('app:lightweight-snapshot'),
  workspaceHub: () => ipcRenderer.invoke('workspace:hub'),
  removeRecentWorkspaces: (targets) => ipcRenderer.invoke('workspace:remove-recent', targets),
  switchWorkspace: (workspace) => ipcRenderer.invoke('workspace:switch', workspace),
  chooseAndSwitchWorkspace: () => ipcRenderer.invoke('workspace:choose-and-switch'),
  chooseAuthorizedRoot: () => ipcRenderer.invoke('workspace:choose-authorized-root'),
  onChatState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:state', wrapped);
    return () => ipcRenderer.removeListener('chat:state', wrapped);
  },
  onHeartbeat: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:heartbeat', wrapped);
    return () => ipcRenderer.removeListener('runtime:heartbeat', wrapped);
  },
  onDownload: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:download', wrapped);
    return () => ipcRenderer.removeListener('chat:download', wrapped);
  },
  taskState: () => ipcRenderer.invoke('task-state:read'),
  taskRuntime: (options = {}) => ipcRenderer.invoke('mcp:task-runtime', options),
  performanceTrace: () => ipcRenderer.invoke('performance:read'),
  pauseTask: () => ipcRenderer.invoke('task-state:pause'),
  resumeTask: () => ipcRenderer.invoke('task-state:resume'),
  stopTask: () => ipcRenderer.invoke('task-state:stop'),
  contextUsage: () => ipcRenderer.invoke('context:usage'),
  resetContextUsage: () => ipcRenderer.invoke('context:reset-usage'),
  onContextUsage: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('context:usage-changed', wrapped);
    return () => ipcRenderer.removeListener('context:usage-changed', wrapped);
  },
  readTaskConsole: () => ipcRenderer.invoke('task:read-console'),
  killActiveCommand: () => ipcRenderer.invoke('task:kill-active-command'),
  openWorkspaceInExplorer: (target) => ipcRenderer.invoke('workspace:open-in-explorer', target),
  openWorkspaceInEditor: (target) => ipcRenderer.invoke('workspace:open-in-editor', target),
  showInFolder: (path) => ipcRenderer.invoke('workspace:show-in-folder', path),
  gitFileDiff: (relativePath) => ipcRenderer.invoke('git:file-diff', relativePath),
  gitCommitAndPush: (options) => ipcRenderer.invoke('git:commit-and-push', options),
  generateTaskSnapshot: () => ipcRenderer.invoke('task:generate-snapshot'),
  injectPrompt: (text, autoSend) => ipcRenderer.invoke('chat:inject-prompt', text, autoSend)
});
