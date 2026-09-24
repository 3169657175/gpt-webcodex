'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function currentBuildArtifacts(projectRoot = root, pkg = require(path.join(projectRoot, 'package.json'))) {
  const dist = path.join(projectRoot, 'dist');
  const installer = `web-mcp-assistant-setup-${pkg.version}.exe`;
  return [
    path.join(dist, 'win-unpacked'),
    path.join(dist, installer),
    path.join(dist, `${installer}.blockmap`),
  ];
}

function cleanCurrentBuildArtifacts(projectRoot = root, pkg) {
  for (const target of currentBuildArtifacts(projectRoot, pkg)) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch (error) {
      console.warn(`[release] 无法立即清理构建产物 ${path.relative(projectRoot, target)}: ${error.message}`);
    }
  }
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveBuilderCli(projectRoot = root) {
  const relativeCli = path.join('electron-builder', 'out', 'cli', 'cli.js');
  let cursor = path.resolve(projectRoot);
  while (true) {
    const candidate = path.join(cursor, 'node_modules', relativeCli);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    return require.resolve('electron-builder/out/cli/cli.js', { paths: [projectRoot, __dirname] });
  } catch {
    throw new Error('无法定位 electron-builder CLI；请先在主工作区安装依赖。');
  }
}

function runBuilder(projectRoot = root) {
  const cli = resolveBuilderCli(projectRoot);
  return spawnSync(process.execPath, [cli, '--win', 'nsis'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
}

function runWithRetry({
  attempts = 2,
  delayMs = 1500,
  run = runBuilder,
  cleanup = cleanCurrentBuildArtifacts,
  wait = sleep,
} = {}) {
  const maxAttempts = Math.max(1, positiveInteger(attempts, 2));
  let lastStatus = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = run();
    if (result && !result.error && result.status === 0) return 0;

    lastStatus = Number.isInteger(result?.status) ? result.status : 1;
    if (result?.error) console.error(`[release] electron-builder 启动失败: ${result.error.message}`);
    if (attempt >= maxAttempts) break;

    console.warn(`[release] electron-builder 第 ${attempt}/${maxAttempts} 次失败；仅清理当前版本构建产物，${delayMs}ms 后重试。`);
    cleanup();
    wait(delayMs);
  }

  return lastStatus || 1;
}

function main() {
  const attempts = positiveInteger(process.env.ELECTRON_BUILDER_MAX_ATTEMPTS, 2);
  const delayMs = positiveInteger(process.env.ELECTRON_BUILDER_RETRY_DELAY_MS, 1500);
  process.exitCode = runWithRetry({ attempts, delayMs });
}

if (require.main === module) main();

module.exports = {
  resolveBuilderCli,
  currentBuildArtifacts,
  cleanCurrentBuildArtifacts,
  runWithRetry,
};
