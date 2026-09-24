const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workspaceKey } = require('./config');

function nowIso() { return new Date().toISOString(); }

function safeStat(target) {
  try {
    const stat = fs.statSync(target);
    return { exists: true, accessible: true, directory: stat.isDirectory(), mtimeMs: stat.mtimeMs };
  } catch (error) {
    const code = String(error?.code || '');
    return {
      exists: !['ENOENT', 'ENOTDIR'].includes(code),
      accessible: false,
      directory: false,
      code,
      mtimeMs: 0
    };
  }
}

function directoryBytes(root, options = {}) {
  const maxEntries = Math.max(100, Number(options.maxEntries || 20000));
  if (!root || !fs.existsSync(root)) return 0;
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < maxEntries) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > maxEntries) break;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch { /* best-effort storage inspection */ }
    }
  }
  return total;
}

function removePath(target) {
  if (!target || !fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
  return true;
}

function isCleanGitWorktree(target) {
  if (!target || !fs.existsSync(target)) return false;
  const result = spawnSync('git', ['-C', target, 'status', '--porcelain=v1', '--untracked-files=all'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
    shell: false
  });
  return result.status === 0 && !String(result.stdout || '').trim();
}

class WorkspaceManager {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
  }

  _metadata(settings) {
    return settings.workspaceMetadata && typeof settings.workspaceMetadata === 'object'
      ? { ...settings.workspaceMetadata }
      : {};
  }

  _metaFor(metadata, workspace) {
    return metadata[workspaceKey(workspace)] || {};
  }

  touch(workspace) {
    const current = this.settingsStore.load();
    const metadata = this._metadata(current);
    const key = workspaceKey(workspace);
    if (!key) return current;
    const previous = metadata[key] || {};
    metadata[key] = {
      ...previous,
      path: workspace,
      addedAt: previous.addedAt || nowIso(),
      lastUsedAt: nowIso(),
      favorite: Boolean(previous.favorite)
    };
    return this.settingsStore.save({ workspaceMetadata: metadata });
  }

  inspectWorkspace(workspace) {
    const state = safeStat(workspace);
    let status = 'ready';
    if (!state.exists) status = 'missing';
    else if (!state.accessible) status = 'unavailable';
    else if (!state.directory) status = 'not_directory';
    return { path: workspace, ...state, status };
  }

  hub() {
    const current = this.settingsStore.load();
    const metadata = this._metadata(current);
    const activeKey = workspaceKey(current.workspace);
    const workspaces = (current.recentWorkspaces || []).filter(Boolean).map((workspace, index) => {
      const health = this.inspectWorkspace(workspace);
      const meta = this._metaFor(metadata, workspace);
      return {
        ...health,
        name: path.basename(workspace) || workspace,
        active: workspaceKey(workspace) === activeKey,
        favorite: Boolean(meta.favorite),
        lastUsedAt: String(meta.lastUsedAt || ''),
        addedAt: String(meta.addedAt || ''),
        order: index
      };
    }).sort((a, b) => Number(b.active) - Number(a.active)
      || Number(b.favorite) - Number(a.favorite)
      || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))
      || a.order - b.order);
    const invalid = workspaces.filter((item) => ['missing', 'not_directory'].includes(item.status));
    const authorizedRoots = (current.authorizedRoots || []).filter(Boolean).map((root) => {
      const health = this.inspectWorkspace(root);
      return {
        ...health,
        name: path.basename(root) || root,
        activeWorkspace: workspaceKey(root) === activeKey
      };
    });
    return {
      activeWorkspace: current.workspace,
      recentWorkspaces: current.recentWorkspaces || [],
      workspaces,
      invalidCount: invalid.length,
      authorizedRoots: (current.authorizedRoots || []).filter(Boolean),
      authorizedRootDetails: authorizedRoots,
      invalidAuthorizedRootCount: authorizedRoots.filter((item) => item.status !== 'ready').length
    };
  }

  inspectAll() {
    const hub = this.hub();
    const counts = hub.workspaces.reduce((result, item) => {
      result[item.status] = (result[item.status] || 0) + 1;
      return result;
    }, {});
    return { ...hub, counts, checkedAt: nowIso() };
  }

  remove(workspace) {
    const current = this.settingsStore.load();
    const key = workspaceKey(workspace);
    if (!key) throw new Error('工作区路径不能为空。');
    if (key === workspaceKey(current.workspace)) throw new Error('当前正在使用的工作区不能移除，请先切换到其它工作区。');
    const recentWorkspaces = (current.recentWorkspaces || []).filter((item) => workspaceKey(item) !== key);
    const workspaceMetadata = this._metadata(current);
    delete workspaceMetadata[key];
    this.settingsStore.save({ recentWorkspaces, workspaceMetadata });
    return this.hub();
  }

  cleanupInvalid() {
    const current = this.settingsStore.load();
    const activeKey = workspaceKey(current.workspace);
    const workspaceMetadata = this._metadata(current);
    const removed = [];
    const kept = [];
    for (const workspace of current.recentWorkspaces || []) {
      const health = this.inspectWorkspace(workspace);
      const removable = workspaceKey(workspace) !== activeKey && ['missing', 'not_directory'].includes(health.status);
      if (removable) {
        removed.push(workspace);
        delete workspaceMetadata[workspaceKey(workspace)];
      } else kept.push(workspace);
    }
    this.settingsStore.save({ recentWorkspaces: kept, workspaceMetadata });
    return { removed, hub: this.hub() };
  }

  toggleFavorite(workspace) {
    const current = this.settingsStore.load();
    const metadata = this._metadata(current);
    const key = workspaceKey(workspace);
    if (!key || !(current.recentWorkspaces || []).some((item) => workspaceKey(item) === key)) {
      throw new Error('工作区记录不存在。');
    }
    const previous = metadata[key] || {};
    metadata[key] = {
      ...previous,
      path: workspace,
      addedAt: previous.addedAt || nowIso(),
      lastUsedAt: previous.lastUsedAt || '',
      favorite: !previous.favorite
    };
    this.settingsStore.save({ workspaceMetadata: metadata });
    return this.hub();
  }

  storageStatus() {
    const current = this.settingsStore.load();
    const workspace = String(current.workspace || '').trim();
    if (!workspace) throw new Error('请先选择工作区。');
    const codingTools = path.join(workspace, '.coding-tools');
    const worktrees = path.join(codingTools, 'worktrees');
    const dist = path.join(workspace, 'dist');
    const build = path.join(workspace, 'build');
    return {
      workspace,
      bytes: {
        worktrees: directoryBytes(worktrees),
        dist: directoryBytes(dist),
        build: directoryBytes(build),
        codingTools: directoryBytes(codingTools)
      },
      retentionDays: Number(current.storageRetentionDays || 7),
      retentionCount: Number(current.storageRetentionCount || 5),
      checkedAt: nowIso()
    };
  }

  cleanupStorage() {
    const current = this.settingsStore.load();
    const workspace = String(current.workspace || '').trim();
    if (!workspace) throw new Error('请先选择工作区。');
    const removedGenerated = [];
    for (const generated of [path.join(workspace, 'dist'), path.join(workspace, 'build')]) {
      if (removePath(generated)) removedGenerated.push(generated);
    }
    const removedCaches = [];
    const stack = [workspace];
    let scanned = 0;
    while (stack.length && scanned < 12000) {
      const currentDir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++scanned > 12000) break;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__pycache__') { if (removePath(full)) removedCaches.push(full); continue; }
          if (['.git', 'node_modules', '.coding-tools'].includes(entry.name)) continue;
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.pyc')) {
          try { fs.rmSync(full, { force: true }); removedCaches.push(full); } catch { /* best effort */ }
        }
      }
    }
    return { removedWorktrees: [], removedGenerated, removedCaches, status: this.storageStatus() };
  }}

module.exports = { WorkspaceManager, safeStat, directoryBytes, isCleanGitWorktree };
