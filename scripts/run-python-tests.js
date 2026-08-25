const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const portable = path.join(root, 'resources', 'native-python', 'python.exe');
const mcpRoot = path.join(root, 'resources', 'coding-tools-mcp');
const vendorRoot = path.join(mcpRoot, 'python_vendor');

function available(executable, prefixArgs = []) {
  const result = spawnSync(executable, [...prefixArgs, '--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function resolvePython() {
  if (fs.existsSync(portable)) return { executable: portable, prefixArgs: [], label: '便携 Python' };
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ executable: process.env.PYTHON, prefixArgs: [], label: 'PYTHON 环境变量' });
  candidates.push(
    { executable: 'python', prefixArgs: [], label: '系统 Python' },
    { executable: 'py', prefixArgs: ['-3'], label: 'Windows Python Launcher' }
  );
  const found = candidates.find((item) => available(item.executable, item.prefixArgs));
  if (!found) throw new Error('未找到可用 Python。主安装包应包含便携 Python；Worktree/开发环境请安装 Python 3.11+。');
  return found;
}

function run(python, args, env) {
  const result = spawnSync(python.executable, [...python.prefixArgs, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const python = resolvePython();
const env = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONPATH: [vendorRoot, mcpRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
};
console.log(`[Python 测试] ${python.label}: ${python.executable}`);
run(python, ['scripts/check-schema-contract.py'], env);
run(python, ['-B', '-m', 'unittest', 'discover', '-s', 'resources/coding-tools-mcp/tests', '-p', 'test*.py'], env);
