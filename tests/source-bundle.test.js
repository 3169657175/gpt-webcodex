const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('required bundled runtime artifacts exist', () => {
  const required = [
    'resources/coding-tools-mcp/coding_tools_mcp/server.py',
    'resources/coding-tools-mcp/LICENSE',
    'resources/coding-tools-mcp/NOTICE',
    'resources/tools/tunnel-client.exe',
    'resources/tools/rg.exe',
    'resources/tools/fd.exe',
    'resources/coding-tools-mcp/python_vendor/pypdf/__init__.py',
    'resources/coding-tools-mcp/python_vendor/jwt/__init__.py'
  ];
  for (const relative of required) assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
});

test('obsolete container runtime files are not bundled', () => {
  assert.equal(fs.existsSync(path.join(root, 'electron/services/dockerService.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'resources/coding-tools-mcp/Dockerfile')), false);
});

test('private runtime state is not bundled from the source checkout', () => {
  assert.equal(fs.existsSync(path.join(root, 'resources/coding-tools-mcp/.coding-tools')), false);
});

test('release resources exclude Python test caches', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bundled = pkg.build.extraResources.find((entry) => entry.from === 'resources');
  assert.ok(bundled);
  assert.ok(bundled.filter.includes('!coding-tools-mcp/**/__pycache__/**'));
  assert.ok(bundled.filter.includes('!coding-tools-mcp/**/*.pyc'));
});

test('portable Python does not contain a second stale coding_tools_mcp implementation', () => {
  const duplicate = path.join(root, 'resources/native-python/Lib/site-packages/coding_tools_mcp');
  assert.equal(fs.existsSync(path.join(duplicate, '__init__.py')), false);
  assert.equal(fs.existsSync(path.join(duplicate, 'server.py')), false);
  assert.equal(fs.existsSync(path.join(duplicate, 'transport_http.py')), false);
});

test('portable Python isolated path loads the single bundled coding_tools_mcp source', () => {
  const python = path.join(root, 'resources/native-python/python.exe');
  if (!fs.existsSync(python)) return; // Worktrees/CI intentionally do not contain ignored portable runtime files.
  const pth = fs.readFileSync(path.join(root, 'resources/native-python/python312._pth'), 'utf8');
  assert.match(pth, /\.\.\\coding-tools-mcp\\python_vendor/);
  assert.match(pth, /\.\.\\coding-tools-mcp/);
  const result = spawnSync(python, ['-m', 'coding_tools_mcp', '--help'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Serve workspace-confined coding tools over MCP/);
});
