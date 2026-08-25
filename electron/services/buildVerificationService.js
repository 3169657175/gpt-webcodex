const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./commandRunner');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }

function requireWorkspace(root) {
  const value = String(root || '').trim();
  if (!value) throw new Error('请先选择工作目录。');
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('当前工作目录不存在。');
  return resolved;
}

function detectProject(root) {
  root = requireWorkspace(root);
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg.name) {
    const manager = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    const runWord = manager === 'yarn' ? '' : 'run ';
    const scripts = pkg.scripts || {};
    const buildName = ['build', 'dist', 'package'].find((name) => scripts[name]) || '';
    return { type: pkg.main ? 'electron' : 'node', name: pkg.name, version: pkg.version || '', manager, testCommand: scripts.test && !String(scripts.test).includes('no test specified') ? `${manager} ${runWord}test`.trim() : '', buildCommand: buildName ? `${manager} ${runWord}${buildName}`.trim() : '', artifacts: [pkg.build?.directories?.output || 'dist', 'build'] };
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) return { type: 'python', name: path.basename(root), version: '', manager: 'python', testCommand: fs.existsSync(path.join(root, 'tests')) ? 'python -m pytest' : '', buildCommand: 'python -m build', artifacts: ['dist'] };
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return { type: 'rust', name: path.basename(root), version: '', manager: 'cargo', testCommand: 'cargo test', buildCommand: 'cargo build --release', artifacts: ['target/release'] };
  if (fs.existsSync(path.join(root, 'go.mod'))) return { type: 'go', name: path.basename(root), version: '', manager: 'go', testCommand: 'go test ./...', buildCommand: 'go build ./...', artifacts: ['bin'] };
  return { type: 'unknown', name: path.basename(root), version: '', manager: '', testCommand: '', buildCommand: '', artifacts: [] };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inferProjectRoot(root, ...commands) {
  root = requireWorkspace(root);
  const patterns = [
    /(?:npm|pnpm)\s+(?:--prefix|-C)\s+["']?([^"'\s;&]+)/i,
    /yarn\s+--cwd\s+["']?([^"'\s;&]+)/i,
    /(?:^|&&|;)\s*cd\s+["']?([^"';&]+?)["']?\s*(?:&&|;)/i
  ];
  for (const command of commands) {
    for (const pattern of patterns) {
      const match = String(command || '').match(pattern);
      if (!match) continue;
      const candidate = path.resolve(root, match[1].trim());
      if (!isWithin(root, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
      if (['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'].some((name) => fs.existsSync(path.join(candidate, name)))) return candidate;
    }
  }
  return root;
}

function normalizeArtifactEntries(root, entries) {
  return [...new Set((entries || []).map((entry) => String(entry || '').trim()).filter(Boolean))].map((entry) => {
    const target = path.resolve(root, entry);
    if (!isWithin(root, target)) throw new Error(`产物路径必须位于工作目录内：${entry}`);
    return target;
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

async function collectArtifacts(root, entries) {
  const results = [];
  const walk = async (target) => {
    if (results.length >= 200) return;
    let stat;
    try { stat = await fsp.lstat(target); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      results.push({ path: path.relative(root, target), size: stat.size, sha256: await hashFile(target), modifiedAt: stat.mtime.toISOString() });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of await fsp.readdir(target)) await walk(path.join(target, name));
  };
  for (const target of normalizeArtifactEntries(root, entries)) await walk(target);
  return results;
}

class BuildVerificationService {
  constructor(log, emit = () => {}) { this.log = log; this.emit = emit; this.running = false; this.lastReport = null; }
  inspect(root) { return detectProject(root); }
  async execute(root, options = {}) {
    if (this.running) throw new Error('已有构建验证正在运行。');
    this.running = true;
    root = requireWorkspace(root);
    const initialProject = detectProject(root);
    const requestedTest = String(options.testCommand ?? initialProject.testCommand).trim();
    const requestedBuild = String(options.buildCommand ?? initialProject.buildCommand).trim();
    const projectRoot = inferProjectRoot(root, requestedBuild, requestedTest);
    const project = detectProject(projectRoot);
    const testCommand = String(options.testCommand ?? project.testCommand).trim();
    const buildCommand = String(options.buildCommand ?? project.buildCommand).trim();
    const runCommand = async (stage, command) => {
      if (!command) return { status: 'skipped', command, summary: '未检测到命令' };
      if (command.length > 1000 || /[\r\n\0]/.test(command)) throw new Error('构建命令格式不安全。');
      this.emit({ stage, status: 'running', command });
      const started = Date.now();
      const explicitRootCommand = projectRoot !== root && ((stage === 'test' && options.testCommand) || (stage === 'build' && options.buildCommand));
      const result = await run('cmd.exe', ['/d', '/s', '/c', command], { cwd: explicitRootCommand ? root : projectRoot, allowFailure: true, timeoutMs: 600000, onOutput: (stream, text) => this.emit({ stage, status: 'output', stream, text }) });
      return { status: result.code === 0 ? 'passed' : 'failed', command, exitCode: result.code, durationMs: Date.now() - started, summary: `${result.stdout}\n${result.stderr}`.trim().slice(-4000) };
    };
    try {
      const testResult = options.runTests === false ? { status: 'skipped' } : await runCommand('test', testCommand);
      const buildResult = testResult.status === 'failed' || options.runBuild === false ? { status: options.runBuild === false ? 'skipped' : 'blocked' } : await runCommand('build', buildCommand);
      const artifactEntries = options.artifacts?.length ? options.artifacts : project.artifacts;
      const artifacts = buildResult.status === 'passed' ? await collectArtifacts(projectRoot, artifactEntries) : [];
      const passed = testResult.status !== 'failed' && buildResult.status !== 'failed' && buildResult.status !== 'blocked' && (options.runBuild === false || artifacts.length > 0);
      this.lastReport = { project, projectRoot: path.relative(root, projectRoot) || '.', testResult, buildResult, artifacts, overallStatus: passed ? 'passed' : 'failed', generatedAt: new Date().toISOString() };
      this.emit({ stage: 'complete', status: this.lastReport.overallStatus, report: this.lastReport });
      this.log?.info?.('构建验证完成', { project: project.name, status: this.lastReport.overallStatus, artifacts: artifacts.length });
      return this.lastReport;
    } finally { this.running = false; }
  }
}

module.exports = { BuildVerificationService, detectProject, inferProjectRoot, collectArtifacts, requireWorkspace };
