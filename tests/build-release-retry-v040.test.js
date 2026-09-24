'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const { currentBuildArtifacts, resolveBuilderCli, resolveElectronDist, runWithRetry } = require('../scripts/run-electron-builder-release');

test('0.4.0 dist uses bounded electron-builder retry after tests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.dist, /npm test && node scripts\/run-electron-builder-release\.js/);
  assert.doesNotMatch(pkg.scripts.dist, /electron-builder --win nsis/);
});

test('release builder retries once after a transient failure and then succeeds', () => {
  let runs = 0;
  let cleanups = 0;
  let waits = 0;
  const status = runWithRetry({
    attempts: 2,
    delayMs: 1,
    run: () => ({ status: runs++ === 0 ? 1 : 0 }),
    cleanup: () => { cleanups += 1; },
    wait: () => { waits += 1; },
  });
  assert.equal(status, 0);
  assert.equal(runs, 2);
  assert.equal(cleanups, 1);
  assert.equal(waits, 1);
});

test('release builder remains failed after the bounded second attempt', () => {
  let runs = 0;
  let cleanups = 0;
  const status = runWithRetry({
    attempts: 2,
    delayMs: 0,
    run: () => { runs += 1; return { status: 7 }; },
    cleanup: () => { cleanups += 1; },
    wait: () => {},
  });
  assert.equal(status, 7);
  assert.equal(runs, 2);
  assert.equal(cleanups, 1);
});

test('retry cleanup is limited to current-version build artifacts', () => {
  const fakeRoot = path.join('C:', 'workspace');
  const targets = currentBuildArtifacts(fakeRoot, { version: '0.4.0' }).map((item) => path.normalize(item));
  assert.deepEqual(targets, [
    path.join(fakeRoot, 'dist', 'win-unpacked'),
    path.join(fakeRoot, 'dist', 'web-mcp-assistant-setup-0.4.0.exe'),
    path.join(fakeRoot, 'dist', 'web-mcp-assistant-setup-0.4.0.exe.blockmap'),
  ]);
  assert.ok(!targets.includes(path.join(fakeRoot, 'dist')));
});

test('release builder resolves electron-builder from an ancestor node_modules for worktrees', () => {
  const os = require('node:os');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-mcp-builder-'));
  try {
    const mainRoot = path.join(temp, 'main');
    const worktree = path.join(mainRoot, '.coding-tools', 'worktrees', 'run-1');
    const cli = path.join(mainRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const electronDist = path.join(mainRoot, 'node_modules', 'electron', 'dist');
    fs.mkdirSync(electronDist, { recursive: true });
    fs.writeFileSync(cli, '// fake electron-builder cli');
    fs.writeFileSync(path.join(electronDist, 'electron.exe'), '');
    assert.equal(resolveBuilderCli(worktree), cli);
    assert.equal(resolveElectronDist(worktree), electronDist);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
