const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activityDetail', {
  setHover: (value) => ipcRenderer.invoke('activity-detail:hover', Boolean(value)),
  close: () => ipcRenderer.invoke('activity-detail:close'),
  pin: () => ipcRenderer.invoke('activity-detail:pin'),
  unpin: () => ipcRenderer.invoke('activity-detail:unpin'),
  onPayload: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('activity-detail:payload', wrapped);
    return () => ipcRenderer.removeListener('activity-detail:payload', wrapped);
  },
  onState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('activity-detail:state', wrapped);
    return () => ipcRenderer.removeListener('activity-detail:state', wrapped);
  }
});
