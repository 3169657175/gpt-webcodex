const path = require('node:path');
const { app } = require('electron');

function resourcesRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources')
    : path.join(app.getAppPath(), 'resources');
}

function dataRoot() {
  return app.getPath('userData');
}

module.exports = {
  resourcesRoot,
  dataRoot,
  settingsFile: () => path.join(dataRoot(), 'settings.json'),
  secretsFile: () => path.join(dataRoot(), 'secrets.bin'),
  stateFile: () => path.join(dataRoot(), 'runtime-state.json'),
  notificationStateFile: () => path.join(dataRoot(), 'notification-state.json'),
  logFile: () => path.join(dataRoot(), 'logs', 'assistant.log'),
  mcpLogFile: () => path.join(dataRoot(), 'logs', 'mcp.log'),
  tunnelLogFile: () => path.join(dataRoot(), 'logs', 'tunnel.log'),
  tunnelExecutable: () => path.join(resourcesRoot(), 'tools', 'tunnel-client.exe'),
  portablePython: () => path.join(resourcesRoot(), 'native-python', 'python.exe')
};

