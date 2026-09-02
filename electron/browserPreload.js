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
  stopTask: () => ipcRenderer.invoke('task-state:stop')
});
