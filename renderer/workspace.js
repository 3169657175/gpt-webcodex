const api = window.workspaceAssistant;
const $ = (selector) => document.querySelector(selector);
let hubState = { workspaces: [], authorizedRoots: [] };
let busy = false;
let activeWorkspaceView = 'workspaces';

const theme = new URLSearchParams(location.search).get('theme');
document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}

function baseName(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value || '未选择';
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function setBusy(value, text = '') {
  busy = value;
  document.body.classList.toggle('busy', value);
  if (text) $('#statusText').textContent = text;
}

function workspaceStatusText(item) {
  if (item.active) return '当前';
  if (item.status === 'missing') return '目录不存在';
  if (item.status === 'not_directory') return '不是文件夹';
  if (item.status === 'unavailable') return item.code === 'EACCES' ? '无访问权限' : '暂不可访问';
  return item.favorite ? '已收藏' : '可用';
}

function switchWorkspaceView(view, options = {}) {
  const next = view === 'authorized' ? 'authorized' : 'workspaces';
  activeWorkspaceView = next;
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    const active = button.dataset.workspaceTab === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-workspace-view]').forEach((panel) => {
    const active = panel.dataset.workspaceView === next;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  if (options.focusSearch && next === 'workspaces') {
    requestAnimationFrame(() => $('#workspaceSearch')?.focus());
  }
}

function renderHub(hub) {
  hubState = hub || { workspaces: [], authorizedRoots: [] };
  const workspaces = Array.isArray(hubState.workspaces) ? hubState.workspaces : [];
  const authorizedRoots = Array.isArray(hubState.authorizedRoots) ? hubState.authorizedRoots : [];
  const current = hubState.activeWorkspace || '';
  $('#currentName').textContent = current ? baseName(current) : '尚未选择工作区';
  $('#currentPath').textContent = current || '-';
  $('#currentPath').title = current;
  $('#workspaceCount').textContent = String(workspaces.length);
  $('#authorizedCount').textContent = String(authorizedRoots.length);
  const invalid = Number(hubState.invalidCount || 0);
  $('#cleanupInvalid').hidden = invalid < 1;
  $('#cleanupInvalid').textContent = invalid ? `清理 ${invalid} 项` : '清理失效';
  renderList(workspaces);
  renderAuthorizedRoots(hubState.authorizedRootDetails || []);
}


function authorizedStatusText(item) {
  if (item.status === 'missing') return '目录不存在';
  if (item.status === 'not_directory') return '不是文件夹';
  if (item.status === 'unavailable') return item.code === 'EACCES' ? '无访问权限' : '暂不可访问';
  return '已授权';
}

function renderAuthorizedRoots(items) {
  const target = $('#authorizedRootList');
  if (!target) return;
  const roots = Array.isArray(items) ? items : [];
  target.replaceChildren();
  $('#clearAuthorizedRoots').hidden = roots.length === 0;
  if (!roots.length) {
    const empty = document.createElement('div');
    empty.className = 'authorized-empty';
    const title = document.createElement('b');
    title.textContent = '没有额外授权目录';
    const detail = document.createElement('span');
    detail.textContent = '需要同时访问主工作区之外的目录时，再添加授权。';
    empty.append(title, detail);
    target.appendChild(empty);
    return;
  }

  for (const item of roots) {
    const row = document.createElement('div');
    row.className = `authorized-row ${item.status || ''}`;
    const icon = document.createElement('div');
    icon.className = 'authorized-icon';
    icon.textContent = item.status === 'ready' ? '✓' : '!';
    const copy = document.createElement('div');
    copy.className = 'authorized-copy';
    const name = document.createElement('b');
    name.textContent = item.name || baseName(item.path);
    const code = document.createElement('code');
    code.textContent = item.path;
    code.title = item.path;
    copy.append(name, code);
    const status = document.createElement('span');
    status.className = 'authorized-status';
    status.textContent = authorizedStatusText(item);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger-soft authorized-remove';
    remove.textContent = '取消授权';
    remove.onclick = async () => {
      if (busy) return;
      if (!window.confirm(`取消这个目录的额外授权？\n\n${item.path}\n\n不会删除磁盘文件。`)) return;
      setBusy(true, '正在更新授权目录…');
      try {
        const nextRoots = (hubState.authorizedRoots || []).filter((root) => String(root).toLowerCase() !== String(item.path).toLowerCase());
        unwrap(await api.updateAuthorizedRoots(nextRoots));
        await refreshHub();
        $('#statusText').textContent = '已取消目录授权';
      } catch (error) {
        $('#statusText').textContent = error.message;
      } finally {
        setBusy(false);
      }
    };
    row.append(icon, copy, status, remove);
    target.appendChild(row);
  }
}

function renderList(items) {
  const list = $('#workspaceList');
  const query = String($('#workspaceSearch').value || '').trim().toLowerCase();
  const filtered = (items || []).filter((item) => !query || `${item.name || ''} ${item.path || ''}`.toLowerCase().includes(query));
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = query ? '没有匹配的工作区' : '还没有工作区，点击右上角添加一个目录';
    list.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const row = document.createElement('div');
    row.className = `workspace-row ${item.active ? 'current' : ''} ${item.status || ''}`;

    const favorite = document.createElement('button');
    favorite.className = `favorite ${item.favorite ? 'active' : ''}`;
    favorite.type = 'button';
    favorite.title = item.favorite ? '取消收藏' : '收藏';
    favorite.textContent = item.favorite ? '★' : '☆';
    favorite.onclick = async () => {
      if (busy) return;
      try { renderHub(unwrap(await api.toggleWorkspaceFavorite(item.path))); }
      catch (error) { $('#statusText').textContent = error.message; }
    };

    const main = document.createElement('div');
    main.className = 'workspace-main';
    const name = document.createElement('b');
    name.textContent = item.name || baseName(item.path);
    const code = document.createElement('code');
    code.textContent = item.path;
    code.title = item.path;
    main.append(name, code);

    const status = document.createElement('span');
    status.className = 'workspace-status';
    status.textContent = workspaceStatusText(item);

    const switchButton = document.createElement('button');
    switchButton.className = 'switch-button';
    switchButton.type = 'button';
    switchButton.textContent = item.active ? '使用中' : '切换';
    switchButton.disabled = item.active || item.status !== 'ready';
    const doSwitch = async () => {
      if (busy || switchButton.disabled) return;
      setBusy(true, `正在切换到 ${item.name || baseName(item.path)}…`);
      try {
        unwrap(await api.switchWorkspace(item.path));
        renderHub(unwrap(await api.workspaceHub()));
        $('#statusText').textContent = `已切换到 ${item.name || baseName(item.path)}`;
      } catch (error) {
        $('#statusText').textContent = error.message;
      } finally {
        setBusy(false);
      }
    };
    switchButton.onclick = doSwitch;
    main.onclick = doSwitch;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = item.active ? '当前工作区不能移除' : '从列表移除';
    remove.disabled = Boolean(item.active);
    remove.onclick = async () => {
      if (busy || item.active) return;
      if (!window.confirm(`从工作区列表移除？\n\n${item.path}\n\n只移除记录，不会删除磁盘文件。`)) return;
      try { renderHub(unwrap(await api.removeWorkspace(item.path))); }
      catch (error) { $('#statusText').textContent = error.message; }
    };

    row.append(favorite, main, status, switchButton, remove);
    list.appendChild(row);
  }
}

async function refreshHub() {
  try { renderHub(unwrap(await api.workspaceHub())); }
  catch (error) { $('#statusText').textContent = error.message; }
}

async function refreshStorage() {
  try {
    const status = unwrap(await api.storageStatus());
    const bytes = status.bytes || {};
    $('#storageText').textContent = `Worktree ${formatBytes(bytes.worktrees)} · dist ${formatBytes(bytes.dist)} · build ${formatBytes(bytes.build)}`;
  } catch {
    $('#storageText').textContent = '安全缓存占用检测失败';
  }
}

$('#closeWindow').onclick = () => api.closeWindow();
document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
  button.onclick = () => switchWorkspaceView(button.dataset.workspaceTab);
});
$('#workspaceSearch').oninput = () => renderList(hubState.workspaces || []);
$('#inspectWorkspaces').onclick = async () => {
  if (busy) return;
  setBusy(true, '正在检测工作区目录…');
  try {
    const report = unwrap(await api.inspectWorkspaces());
    renderHub(report);
    $('#statusText').textContent = Number(report.invalidCount || 0) ? `检测完成，发现 ${report.invalidCount} 个失效记录` : '检测完成，全部工作区目录正常';
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
};
$('#cleanupInvalid').onclick = async () => {
  if (busy) return;
  const invalid = Number(hubState.invalidCount || 0);
  if (!invalid) return;
  if (!window.confirm(`确认清理 ${invalid} 个失效工作区记录？\n\n只会删除列表记录，不会删除磁盘文件。`)) return;
  setBusy(true, '正在清理失效记录…');
  try {
    const result = unwrap(await api.cleanupInvalidWorkspaces());
    renderHub(result.hub);
    $('#statusText').textContent = `已清理 ${result.removed.length} 个失效记录`;
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
};
$('#addWorkspace').onclick = async () => {
  if (busy) return;
  setBusy(true, '请选择新的工作目录…');
  try {
    const result = unwrap(await api.chooseAndSwitchWorkspace());
    if (result) {
      await refreshHub();
      switchWorkspaceView('workspaces');
      $('#statusText').textContent = '工作区已添加并切换完成';
    } else $('#statusText').textContent = '已取消添加工作区';
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
};
async function chooseAuthorizedRoot() {
  if (busy) return;
  setBusy(true, '请选择要额外授权的目录…');
  try {
    const result = unwrap(await api.chooseAuthorizedRoot());
    await refreshHub();
    switchWorkspaceView('authorized');
    $('#statusText').textContent = result?.selected ? `已授权：${baseName(result.selected)}` : '已取消授权';
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

$('#authorizeRootInline').onclick = chooseAuthorizedRoot;
$('#clearAuthorizedRoots').onclick = async () => {
  if (busy || !(hubState.authorizedRoots || []).length) return;
  if (!window.confirm('清空全部额外授权目录？\n\n主工作区不会受到影响，也不会删除任何磁盘文件。')) return;
  setBusy(true, '正在清空额外授权…');
  try {
    unwrap(await api.updateAuthorizedRoots([]));
    await refreshHub();
    $('#statusText').textContent = '额外授权目录已清空';
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
};

$('#cleanupStorage').onclick = async () => {
  if (busy) return;
  if (!window.confirm('清理 dist/build、Python 缓存，以及符合保留策略且 Git 状态干净的旧 Worktree？\n\n存在未应用修改的 Worktree 会保留。')) return;
  setBusy(true, '正在清理安全缓存…');
  try {
    const result = unwrap(await api.cleanupStorage());
    $('#statusText').textContent = `清理完成：Worktree ${result.removedWorktrees.length} 个，生成目录 ${result.removedGenerated.length} 个`;
    await refreshStorage();
  } catch (error) {
    $('#statusText').textContent = error.message;
  } finally {
    setBusy(false);
  }
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.closeWindow();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    switchWorkspaceView('workspaces', { focusSearch: true });
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '1') {
    event.preventDefault();
    switchWorkspaceView('workspaces');
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '2') {
    event.preventDefault();
    switchWorkspaceView('authorized');
  }
});
api.onWorkspaceChanged?.(renderHub);
switchWorkspaceView(activeWorkspaceView);

Promise.all([refreshHub(), refreshStorage()]).catch(() => {});
