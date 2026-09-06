const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RuntimeOrchestrator } = require('../electron/services/runtimeOrchestrator');
const { normalize } = require('../electron/services/config');

function createStore(initial) {
  let current = normalize(initial || {});
  return {
    load: () => current,
    save: (patch) => { current = normalize({ ...current, ...patch }); return current; }
  };
}

function createOrchestrator(settingsStore) {
  return new RuntimeOrchestrator({
    settings: settingsStore,
    secrets: {},
    environment: {},
    log: { info() {}, warn() {}, error() {} }
  });
}

test('removeRecentWorkspaces drops targeted entries using canonical path keys', () => {
  const store = createStore({ workspace: 'D:\\work', recentWorkspaces: ['D:\\work', 'D:\\chatgpt', 'C:\\junk', 'D:.'] });
  const orchestrator = createOrchestrator(store);
  const result = orchestrator.removeRecentWorkspaces(['C:\\junk', 'D:.']);
  assert.equal(result.activeWorkspace, 'D:\\work');
  // 'D:.' 与 'D:\' 指向同一盘根，归一化后一并移除
  assert.deepEqual(result.recentWorkspaces, ['D:\\work', 'D:\\chatgpt']);
});

test('the active workspace cannot be removed and always returns to the list', () => {
  const store = createStore({ workspace: 'D:\\work', recentWorkspaces: ['D:\\work', 'D:\\chatgpt'] });
  const orchestrator = createOrchestrator(store);
  // 即使把全部记录（含当前工作区）都作为移除目标，当前工作区也会被 normalize 回填
  const result = orchestrator.removeRecentWorkspaces(['D:\\work', 'D:\\chatgpt']);
  assert.deepEqual(result.recentWorkspaces, ['D:\\work']);
});

test('removing nothing keeps the existing list with the active workspace first', () => {
  const store = createStore({ workspace: 'D:\\work', recentWorkspaces: ['D:\\chatgpt'] });
  const orchestrator = createOrchestrator(store);
  const result = orchestrator.removeRecentWorkspaces([]);
  assert.deepEqual(result.recentWorkspaces, ['D:\\work', 'D:\\chatgpt']);
});

test('clearActiveWorkspace unbinds the active workspace while preserving history', async () => {
  const store = createStore({ workspace: 'D:\\work', recentWorkspaces: ['D:\\work', 'D:\\chatgpt'] });
  const orchestrator = createOrchestrator(store);
  const result = await orchestrator.clearActiveWorkspace();
  assert.equal(result.activeWorkspace, '');
  assert.deepEqual(result.recentWorkspaces, ['D:\\work', 'D:\\chatgpt']);
  assert.equal(store.load().workspace, '');

  // Calling it again when already cleared is a safe no-op
  const second = await orchestrator.clearActiveWorkspace();
  assert.equal(second.activeWorkspace, '');
});

test('workspace cleanup UI and IPC are wired end to end', () => {
  const root = path.join(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  assert.match(read('renderer', 'browser.html'), /id="workspaceCleanButton"/);
  assert.match(read('renderer', 'browser.html'), /id="workspaceCleanPopover"/);
  assert.match(read('renderer', 'browser.html'), /id="workspaceCleanActive"/);
  assert.match(read('renderer', 'browser.js'), /removeRecentWorkspaces/);
  assert.match(read('renderer', 'browser.js'), /workspaceCleanAll/);
  assert.match(read('renderer', 'browser.js'), /handleClearActiveWorkspace/);
  assert.match(read('electron', 'browserPreload.js'), /workspace:remove-recent/);
  assert.match(read('electron', 'browserPreload.js'), /workspace:clear-active/);
  assert.match(read('electron', 'main.js'), /workspace:remove-recent/);
  assert.match(read('electron', 'main.js'), /workspace:clear-active/);
  assert.match(read('electron', 'services', 'runtimeOrchestrator.js'), /removeRecentWorkspaces\(targets/);
  assert.match(read('electron', 'services', 'runtimeOrchestrator.js'), /clearActiveWorkspace\(\)/);
});
