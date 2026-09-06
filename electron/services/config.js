const path = require('node:path');

const DEFAULTS = Object.freeze({
  configVersion: 9,
  connectionMode: 'official',
  bridgeRemovedNotice: false,
  workspace: '',
  permissionMode: 'safe',
  toolMode: 'smart',
  mcpPort: 18765,
  healthPort: 18081,
  proxyMode: 'auto',
  proxyUrl: '',
  tunnelId: '',
  tunnelProfile: 'coding-tools',
  startWithWindows: false,
  autoStartServices: false,
  keepRunningOnClose: true,
  progressReportSeconds: 90,
  taskNotifications: true,
  taskNotificationOnlyWhenUnfocused: false,
  taskNotificationSound: true,
  taskNotificationMinSeconds: 0,
  theme: 'light',
  firstRunCompleted: false,
  guideProgress: {},
  recentWorkspaces: [],
  authorizedRoots: []
});

function normalizeWorkspacePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // 盘符根目录统一为绝对根形式（D:\ / D: / D:. / D:\. / D:\.. 都归一为 D:\）。
  // 盘符相对路径（如 D:.）在 Electron 与 Python Runtime 两侧会解析出不同结果，
  // 曾导致 /__control/health 的 workspace 校验永远失败（部署误报“旧进程”）。
  const driveRoot = /^([a-zA-Z]:)(?:[\\/]+|\.)?$/.exec(path.win32.normalize(text));
  if (driveRoot) return `${driveRoot[1]}\\`;
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
  merged.configVersion = 9;
  merged.connectionMode = 'official';
  merged.bridgeRemovedNotice = Boolean(merged.bridgeRemovedNotice);
  if (sourceVersion > 0 && sourceVersion <= 6 && sourceMode === 'bridge') {
    merged.autoStartServices = false;
    merged.bridgeRemovedNotice = true;
  }
  merged.permissionMode = ['safe', 'trusted'].includes(merged.permissionMode) ? merged.permissionMode : 'safe';
  merged.toolMode = 'smart';
  merged.proxyMode = ['auto', 'system', 'manual', 'direct'].includes(merged.proxyMode) ? merged.proxyMode : 'auto';
  merged.mcpPort = Number.isInteger(Number(merged.mcpPort)) ? Number(merged.mcpPort) : 18765;
  merged.healthPort = Number.isInteger(Number(merged.healthPort)) ? Number(merged.healthPort) : 18081;
  merged.proxyUrl = String(merged.proxyUrl || '').trim();
  merged.workspace = normalizeWorkspacePath(merged.workspace);
  merged.tunnelId = String(merged.tunnelId || '').trim();
  if (sourceVersion < 5 && merged.theme === 'dark') merged.theme = 'light';
  merged.theme = merged.theme === 'dark' ? 'dark' : 'light';
  merged.progressReportSeconds = [60, 90, 120, 180].includes(Number(merged.progressReportSeconds))
    ? Number(merged.progressReportSeconds)
    : 90;
  merged.taskNotifications = Boolean(merged.taskNotifications);
  merged.taskNotificationOnlyWhenUnfocused = Boolean(merged.taskNotificationOnlyWhenUnfocused);
  merged.taskNotificationSound = Boolean(merged.taskNotificationSound);
  merged.taskNotificationMinSeconds = [0, 15, 30, 60, 120].includes(Number(merged.taskNotificationMinSeconds))
    ? Number(merged.taskNotificationMinSeconds)
    : 0;
  if (sourceVersion > 0 && sourceVersion <= 8) {
    merged.taskNotificationOnlyWhenUnfocused = false;
    merged.taskNotificationMinSeconds = 0;
  }
  merged.firstRunCompleted = Boolean(merged.firstRunCompleted);
  merged.guideProgress = merged.guideProgress && typeof merged.guideProgress === 'object' ? merged.guideProgress : {};
  merged.recentWorkspaces = mergeRecentWorkspaces(merged.recentWorkspaces, merged.workspace, 50);
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
    throw new Error('MCP 端口必须在 1024-65535 之间。');
  }
  if (!Number.isInteger(settings.healthPort) || settings.healthPort < 1024 || settings.healthPort > 65535) {
    throw new Error('Tunnel 健康端口必须在 1024-65535 之间。');
  }
  if (settings.mcpPort === settings.healthPort) throw new Error('MCP 端口和 Tunnel 健康端口不能相同。');
  if (settings.tunnelId && !/^tunnel_[A-Za-z0-9_-]{4,}$/.test(settings.tunnelId)) {
    throw new Error('Tunnel ID 格式不正确，应以 tunnel_ 开头。');
  }
  if (settings.proxyMode === 'manual' && !settings.proxyUrl) {
    throw new Error('手动代理模式需要填写代理地址。');
  }
  if (settings.proxyUrl) {
    let parsed;
    try { parsed = new URL(settings.proxyUrl); } catch { throw new Error('代理地址不是有效 URL。'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('代理地址只支持 http:// 或 https://。');
    if (parsed.username || parsed.password) throw new Error('请不要在代理地址中保存用户名或密码。');
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

