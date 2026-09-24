const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAssistant', {
  openManager: () => ipcRenderer.invoke('manager:open'),
  openWorkspaceWindow: () => ipcRenderer.invoke('workspace-window:open'),
  navigate: (action) => ipcRenderer.invoke('chat:navigate', action),
  chatStatus: () => ipcRenderer.invoke('chat:status'),
  lightweightStatus: () => ipcRenderer.invoke('app:lightweight-snapshot'),
  workspaceHub: () => ipcRenderer.invoke('workspace:hub'),
  inspectWorkspaces: () => ipcRenderer.invoke('workspace:inspect'),
  removeWorkspace: (workspace) => ipcRenderer.invoke('workspace:remove', workspace),
  cleanupInvalidWorkspaces: () => ipcRenderer.invoke('workspace:cleanup-invalid'),
  toggleWorkspaceFavorite: (workspace) => ipcRenderer.invoke('workspace:favorite', workspace),
  storageStatus: () => ipcRenderer.invoke('workspace:storage'),
  cleanupStorage: () => ipcRenderer.invoke('workspace:cleanup-storage'),
  switchWorkspace: (workspace) => ipcRenderer.invoke('workspace:switch', workspace),
  chooseAndSwitchWorkspace: () => ipcRenderer.invoke('workspace:choose-and-switch'),
  chooseAuthorizedRoot: () => ipcRenderer.invoke('workspace:choose-authorized-root'),
  approvalList: () => ipcRenderer.invoke('approval:list'),
  openApprovalWindow: () => ipcRenderer.invoke('approval-window:open'),
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
  onWorkspaceChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('workspace:changed', wrapped);
    return () => ipcRenderer.removeListener('workspace:changed', wrapped);
  },
  taskState: () => ipcRenderer.invoke('task-state:read'),
  taskRuntime: (options = {}) => ipcRenderer.invoke('mcp:task-runtime', options),
  stopTask: () => ipcRenderer.invoke('task-state:stop')
});
