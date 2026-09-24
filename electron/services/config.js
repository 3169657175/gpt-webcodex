const path = require('node:path');

const DEFAULTS = Object.freeze({
  configVersion: 13,
  connectionMode: 'official',
  workspace: '',
  permissionMode: 'safe',
  agentMode: 'code',
  toolPermissions: {
    read: 'allow',
    write: 'allow',
    delete: 'ask',
    command: 'allow',
    network: 'allow',
    git_write: 'ask',
    system_modify: 'ask',
    extra_access: 'allow'
  },
  mcpPort: 18765,
  healthPort: 18081,
  proxyMode: 'auto',
  proxyUrl: '',
  tunnelId: '',
  tunnelProfile: 'coding-tools',
  startWithWindows: false,
  autoStartServices: false,
  keepRunningOnClose: true,
  continuousMcpMode: true,
  progressReportSeconds: 30,
  taskNotifications: true,
  taskNotificationSound: true,
  theme: 'light',
  recentWorkspaces: [],
  workspaceMetadata: {},
  authorizedRoots: [],
  storageRetentionDays: 7,
  storageRetentionCount: 5,
  permissionPatterns: { paths: [], commands: [] }
});

function normalizeWorkspacePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = path.normalize(text).replace(/[\\/]+$/, '');
  return normalized || path.parse(text).root || text;
}

function workspaceKey(value) {
  const normalized = normalizeWorkspacePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function mergeRecentWorkspaces(existing, workspace, limit = 50) {
  const candidates = [
    normalizeWorkspacePath(workspace),
    ...(Array.isArray(existing) ? existing : []).map(normalizeWorkspacePath)
  ].filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const key = workspaceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function normalize(input = {}) {
  const sourceVersion = Number(input.configVersion) || 0;
  const sourceMode = String(input.connectionMode || '').trim();
  const merged = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(input, key)) merged[key] = input[key];
  }

  merged.configVersion = 13;
  merged.connectionMode = 'official';

  // Old bridge installs must not silently auto-start after migration.
  if (sourceVersion > 0 && sourceVersion <= 6 && sourceMode === 'bridge') {
    merged.autoStartServices = false;
  }

  merged.permissionMode = 'safe';
  merged.agentMode = 'code';

  const permissionDefaults = DEFAULTS.toolPermissions;
  const permissionSource = merged.toolPermissions && typeof merged.toolPermissions === 'object'
    ? merged.toolPermissions
    : {};
  merged.toolPermissions = Object.fromEntries(Object.entries(permissionDefaults).map(([key, fallback]) => {
    const value = String(permissionSource[key] || fallback).trim().toLowerCase();
    return [key, ['allow', 'ask', 'deny'].includes(value) ? value : fallback];
  }));

  // 0.5.1 personal-development migration:
  // ordinary work should flow without an approval inbox; destructive boundaries remain ask/deny.
  if (sourceVersion > 0 && sourceVersion <= 12) {
    for (const key of ['read', 'write', 'command', 'network', 'extra_access']) {
      if (merged.toolPermissions[key] === 'ask') merged.toolPermissions[key] = 'allow';
    }
  }

  merged.proxyMode = ['auto', 'system', 'manual', 'direct'].includes(merged.proxyMode) ? merged.proxyMode : 'auto';
  merged.mcpPort = Number.isInteger(Number(merged.mcpPort)) ? Number(merged.mcpPort) : 18765;
  merged.healthPort = Number.isInteger(Number(merged.healthPort)) ? Number(merged.healthPort) : 18081;
  merged.proxyUrl = String(merged.proxyUrl || '').trim();
  merged.workspace = normalizeWorkspacePath(merged.workspace);
  merged.tunnelId = String(merged.tunnelId || '').trim();
  if (sourceVersion < 5 && merged.theme === 'dark') merged.theme = 'light';
  merged.theme = merged.theme === 'dark' ? 'dark' : 'light';

  // These are product defaults now, not user-facing knobs.
  merged.progressReportSeconds = 30;
  merged.continuousMcpMode = true;
  merged.taskNotifications = Boolean(merged.taskNotifications);
  merged.taskNotificationSound = Boolean(merged.taskNotificationSound);

  merged.recentWorkspaces = mergeRecentWorkspaces(merged.recentWorkspaces, merged.workspace, 50);
  merged.workspaceMetadata = merged.workspaceMetadata && typeof merged.workspaceMetadata === 'object'
    ? merged.workspaceMetadata
    : {};
  merged.storageRetentionDays = Math.min(90, Math.max(1, Number(merged.storageRetentionDays || 7)));
  merged.storageRetentionCount = Math.min(20, Math.max(1, Number(merged.storageRetentionCount || 5)));

  const permissionPatterns = merged.permissionPatterns && typeof merged.permissionPatterns === 'object'
    ? merged.permissionPatterns
    : {};
  merged.permissionPatterns = {
    paths: Array.isArray(permissionPatterns.paths) ? permissionPatterns.paths.slice(0, 100) : [],
    commands: Array.isArray(permissionPatterns.commands) ? permissionPatterns.commands.slice(0, 100) : []
  };

  merged.authorizedRoots = (Array.isArray(merged.authorizedRoots) ? merged.authorizedRoots : [])
    .map(normalizeWorkspacePath)
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((other) => workspaceKey(other) === workspaceKey(item)) === index)
    .filter((item) => workspaceKey(item) !== workspaceKey(merged.workspace))
    .slice(0, 32);

  return merged;
}

function validateRuntimeSettings(settings) {
  if (!Number.isInteger(settings.mcpPort) || settings.mcpPort < 1024 || settings.mcpPort > 65535) {
    throw new Error('MCP port must be between 1024 and 65535.');
  }
  if (!Number.isInteger(settings.healthPort) || settings.healthPort < 1024 || settings.healthPort > 65535) {
    throw new Error('Tunnel health port must be between 1024 and 65535.');
  }
  if (settings.mcpPort === settings.healthPort) throw new Error('MCP port and Tunnel health port must be different.');
  if (settings.tunnelId && !/^tunnel_[A-Za-z0-9_-]{4,}$/.test(settings.tunnelId)) {
    throw new Error('Tunnel ID is invalid; it must start with tunnel_.');
  }
  if (settings.proxyMode === 'manual' && !settings.proxyUrl) {
    throw new Error('Manual proxy mode requires a proxy URL.');
  }
  if (settings.proxyUrl) {
    let parsed;
    try { parsed = new URL(settings.proxyUrl); } catch { throw new Error('Proxy URL is invalid.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Proxy URL must use http:// or https://.');
    if (parsed.username || parsed.password) throw new Error('Do not store credentials in the proxy URL.');
  }
}

module.exports = {
  DEFAULTS,
  normalize,
  validateRuntimeSettings,
  normalizeWorkspacePath,
  workspaceKey,
  mergeRecentWorkspaces
};
