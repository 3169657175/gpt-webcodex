const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspaceAssistant', {
  closeWindow: () => ipcRenderer.invoke('workspace-window:close'),
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
  updateAuthorizedRoots: (roots) => ipcRenderer.invoke('workspace:authorized-roots', roots),
  onWorkspaceChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('workspace:changed', wrapped);
    return () => ipcRenderer.removeListener('workspace:changed', wrapped);
  }
});
