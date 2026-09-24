const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function valueAfter(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const requestedCycles = Math.floor(positiveNumber(valueAfter('--cycles'), 0));
const minutes = positiveNumber(valueAfter('--minutes'), requestedCycles ? 0 : 30);
const intervalMs = Math.floor(positiveNumber(valueAfter('--interval-ms'), 100));
const reportPath = path.resolve(root, valueAfter('--report', 'build/soak/last.json'));
const mcpRoot = path.join(root, 'resources', 'coding-tools-mcp');
const vendorRoot = path.join(mcpRoot, 'python_vendor');

function primaryPortablePython() {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) return '';
  const commonDir = String(result.stdout || '').trim();
  if (!commonDir || path.basename(commonDir).toLowerCase() !== '.git') return '';
  return path.join(path.dirname(commonDir), 'resources', 'native-python', 'python.exe');
}

const pythonCandidates = [
  process.env.CODING_TOOLS_SOAK_PYTHON,
  path.join(root, 'resources', 'native-python', 'python.exe'),
  primaryPortablePython(),
  process.platform === 'win32' ? 'python.exe' : 'python3'
].filter(Boolean);

function commandExists(command) {
  const result = spawnSync(command, ['--version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

const python = pythonCandidates.find(commandExists);
if (!python) throw new Error('Soak Test 找不到可用 Python。');

function run(command, commandArgs, label) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [vendorRoot, mcpRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
    },
    maxBuffer: 8 * 1024 * 1024
  });
  const record = {
    label,
    command: [command, ...commandArgs].join(' '),
    exit_code: result.status,
    duration_ms: Date.now() - started,
    stdout_tail: String(result.stdout || '').trim().slice(-1200),
    stderr_tail: String(result.stderr || '').trim().slice(-1200)
  };
  if (result.status !== 0) {
    const error = new Error(`${label} 失败（exit ${result.status}）`);
    error.record = record;
    throw error;
  }
  return record;
}

function gitIndexDigest() {
  const result = spawnSync('git', ['diff', '--cached', '--binary'], {
    cwd: root,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error('无法读取 Git 暂存区用于 Soak 安全校验。');
  return crypto.createHash('sha256').update(result.stdout || Buffer.alloc(0)).digest('hex');
}

function sleep(ms) {
  if (ms <= 0) return;
  const array = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(array, 0, 0, ms);
}

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const deadlineMs = minutes > 0 ? startedMs + minutes * 60_000 : Number.POSITIVE_INFINITY;
const indexBefore = gitIndexDigest();
const cycles = [];
let cycle = 0;

try {
  while ((requestedCycles ? cycle < requestedCycles : Date.now() < deadlineMs) || cycle === 0) {
    cycle += 1;
    const cycleStarted = Date.now();
    const checks = [];
    checks.push(run(
      python,
      ['-B', '-m', 'unittest', 'discover', '-s', 'resources/coding-tools-mcp/tests', '-p', 'test_soak_cycle_v040.py'],
      'Runtime deterministic soak cycle'
    ));
    checks.push(run(
      process.execPath,
      ['--test', 'tests/soak-runtime-v040.test.js'],
      'Electron/Tunnel soak cycle'
    ));
    checks.push(run(
      python,
      ['-B', '-m', 'unittest', 'discover', '-s', 'resources/coding-tools-mcp/tests', '-p', 'test_background_progress_regression.py'],
      'Background operation regression'
    ));
    if (cycle === 1 || cycle % 5 === 0) {
      checks.push(run(
        python,
        ['-B', '-m', 'unittest', 'discover', '-s', 'resources/coding-tools-mcp/tests', '-p', 'test_runtime_scenarios.py'],
        'Runtime recovery regression'
      ));
    }
    const indexAfterCycle = gitIndexDigest();
    if (indexAfterCycle !== indexBefore) throw new Error(`第 ${cycle} 轮 Soak 改变了 Git 暂存区。`);
    const record = { cycle, duration_ms: Date.now() - cycleStarted, checks };
    cycles.push(record);
    console.log(`[soak] cycle=${cycle} duration=${record.duration_ms}ms index=unchanged`);
    if (!requestedCycles && Date.now() >= deadlineMs) break;
    sleep(intervalMs);
  }

  const schema = run(python, ['-B', 'scripts/check-schema-contract.py'], 'Schema contract');
  const indexAfter = gitIndexDigest();
  if (indexAfter !== indexBefore) throw new Error('Soak 结束时 Git 暂存区与开始时不一致。');
  const report = {
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedMs,
    requested_minutes: minutes,
    requested_cycles: requestedCycles,
    cycles_completed: cycles.length,
    python,
    git_index_unchanged: true,
    schema_contract: schema,
    cycles
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[soak] PASS cycles=${cycles.length} elapsed=${report.elapsed_ms}ms report=${path.relative(root, reportPath)}`);
} catch (error) {
  const report = {
    ok: false,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedMs,
    requested_minutes: minutes,
    requested_cycles: requestedCycles,
    cycles_completed: cycles.length,
    python,
    error: error.message,
    failed_check: error.record || null,
    cycles
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(`[soak] FAIL ${error.message}`);
  if (error.record) {
    if (error.record.stdout_tail) console.error(error.record.stdout_tail);
    if (error.record.stderr_tail) console.error(error.record.stderr_tail);
  }
  process.exitCode = 1;
}
