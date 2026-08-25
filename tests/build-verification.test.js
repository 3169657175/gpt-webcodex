const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject, inferProjectRoot, collectArtifacts, requireWorkspace } = require('../electron/services/buildVerificationService');

test('build verification detects Electron package scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-mcp-build-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', main: 'main.js', scripts: { test: 'node --test', dist: 'electron-builder' }, build: { directories: { output: 'release' } } }));
    const project = detectProject(root);
    assert.equal(project.type, 'electron');
    assert.equal(project.testCommand, 'npm run test');
    assert.equal(project.buildCommand, 'npm run dist');
    assert.deepEqual(project.artifacts, ['release', 'build']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artifact collection rejects paths outside workspace and hashes files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-mcp-artifact-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'app.exe'), 'artifact');
    const artifacts = await collectArtifacts(root, ['dist']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].sha256.length, 64);
    await assert.rejects(() => collectArtifacts(root, ['..']), /工作目录内/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace is required before build verification', () => {
  assert.throws(() => requireWorkspace(''), /选择工作目录/);
});

test('monorepo npm --prefix resolves the child project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-mcp-monorepo-'));
  try {
    const child = path.join(root, 'canvas-web');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'canvas-web', scripts: { build: 'vite build' } }));
    assert.equal(inferProjectRoot(root, 'npm --prefix canvas-web run build'), child);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
