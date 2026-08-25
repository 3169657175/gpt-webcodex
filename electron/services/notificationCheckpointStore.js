const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

function workspaceKey(workspace) {
  const value = String(workspace || '').trim();
  if (!value) return '';
  try { return path.resolve(value).toLowerCase(); }
  catch { return value.toLowerCase(); }
}

class NotificationCheckpointStore {
  constructor(getFilePath) {
    this.getFilePath = typeof getFilePath === 'function' ? getFilePath : () => String(getFilePath || '');
  }

  load(workspace) {
    const key = workspaceKey(workspace);
    if (!key) return null;
    const root = readJson(this.getFilePath(), { version: 1, workspaces: {} });
    const workspaces = root?.workspaces && typeof root.workspaces === 'object' ? root.workspaces : {};
    const item = workspaces[key];
    if (!item || typeof item !== 'object') return null;
    return {
      initialized: item.initialized === true,
      lastEventId: Math.max(0, Number(item.lastEventId || 0)),
      notifiedKeys: Array.isArray(item.notifiedKeys) ? item.notifiedKeys.slice(-120).map(String) : []
    };
  }

  save(workspace, checkpoint = {}) {
    const key = workspaceKey(workspace);
    if (!key) return;
    const filePath = this.getFilePath();
    const root = readJson(filePath, { version: 1, workspaces: {} });
    const workspaces = root?.workspaces && typeof root.workspaces === 'object' ? { ...root.workspaces } : {};
    workspaces[key] = {
      initialized: checkpoint.initialized === true,
      lastEventId: Math.max(0, Number(checkpoint.lastEventId || 0)),
      notifiedKeys: Array.isArray(checkpoint.notifiedKeys) ? checkpoint.notifiedKeys.slice(-120).map(String) : [],
      updatedAt: new Date().toISOString()
    };
    const recent = Object.entries(workspaces)
      .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
      .slice(0, 50);
    writeJsonAtomic(filePath, { version: 1, workspaces: Object.fromEntries(recent) });
  }
}

module.exports = { NotificationCheckpointStore, workspaceKey };
