const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager } = require('../electron/services/workspaceManager');

function fakeSettings(initial) {
  let state = structuredClone(initial);
  return {
    load: () => structuredClone(state),
    save: (patch) => {
      state = { ...state, ...structuredClone(patch) };
      return structuredClone(state);
    }
  };
}

test('Workspace Manager detects missing records and never removes the active workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-v050-'));
  const current = path.join(root, 'current');
  const other = path.join(root, 'other');
  const missing = path.join(root, 'missing');
  fs.mkdirSync(current);
  fs.mkdirSync(other);
  const store = fakeSettings({
    workspace: current,
    recentWorkspaces: [current, other, missing],
    workspaceMetadata: {},
    authorizedRoots: [],
    storageRetentionDays: 7,
    storageRetentionCount: 5
  });
  const manager = new WorkspaceManager(store);
  const report = manager.inspectAll();
  assert.equal(report.workspaces.find((item) => item.path === current).active, true);
  assert.equal(report.workspaces.find((item) => item.path === missing).status, 'missing');
  assert.equal(report.invalidCount, 1);
  assert.throws(() => manager.remove(current), /当前正在使用/);
  const cleaned = manager.cleanupInvalid();
  assert.deepEqual(cleaned.removed, [missing]);
  assert.ok(cleaned.hub.recentWorkspaces.includes(current));
  assert.ok(cleaned.hub.recentWorkspaces.includes(other));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Workspace Manager cleanup removes generated caches but does not delete worktrees directly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-gc-v050-'));
  const dist = path.join(root, 'dist');
  const build = path.join(root, 'build');
  const pycache = path.join(root, 'src', '__pycache__');
  const worktree = path.join(root, '.coding-tools', 'worktrees', 'keep-me');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(build, { recursive: true });
  fs.mkdirSync(pycache, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(pycache, 'x.pyc'), 'x');
  fs.writeFileSync(path.join(worktree, 'important.txt'), 'preserve');
  const manager = new WorkspaceManager(fakeSettings({
    workspace: root,
    recentWorkspaces: [root],
    workspaceMetadata: {},
    authorizedRoots: [],
    storageRetentionDays: 7,
    storageRetentionCount: 5
  }));
  const result = manager.cleanupStorage();
  assert.equal(fs.existsSync(dist), false);
  assert.equal(fs.existsSync(build), false);
  assert.equal(fs.existsSync(pycache), false);
  assert.equal(fs.existsSync(worktree), true);
  assert.deepEqual(result.removedWorktrees, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Workspace favorites are persisted independently from authorization roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fav-v050-'));
  const store = fakeSettings({
    workspace: root,
    recentWorkspaces: [root],
    workspaceMetadata: {},
    authorizedRoots: ['D:\\\\external'],
    storageRetentionDays: 7,
    storageRetentionCount: 5
  });
  const manager = new WorkspaceManager(store);
  assert.equal(manager.toggleFavorite(root).workspaces[0].favorite, true);
  assert.deepEqual(store.load().authorizedRoots, ['D:\\\\external']);
  fs.rmSync(root, { recursive: true, force: true });
});
