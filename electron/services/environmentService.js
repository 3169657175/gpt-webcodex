const fs = require('node:fs');
const net = require('node:net');
const { run } = require('./commandRunner');
const paths = require('../paths');
const { resolveProxy } = require('./proxyService');

async function commandExists(name) {
  const result = await run('where.exe', [name], { allowFailure: true });
  return result.code === 0;
}

function canConnect(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let cachedPythonStatus = null;
let cachedPythonStatusTime = 0;
const PYTHON_CACHE_TTL = 30_000;

async function checkCandidate(candidate) {
  const result = await run(candidate.command, [...candidate.args, '--version'], { allowFailure: true });
  const output = `${result.stdout} ${result.stderr}`.trim();
  const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (result.code === 0 && match && (major > 3 || (major === 3 && minor >= 11))) {
    return { installed: true, command: candidate.command, launchCommand: candidate.launchCommand, prefixArgs: candidate.args, version: match[0] };
  }
  return null;
}

async function pythonStatus(options = {}) {
  if (!options?.force && cachedPythonStatus && Date.now() - cachedPythonStatusTime < PYTHON_CACHE_TTL) {
    return cachedPythonStatus;
  }
  if (fs.existsSync(paths.portablePython())) {
    const pythonw = pathForPythonw(paths.portablePython());
    const candidate = { command: paths.portablePython(), launchCommand: fs.existsSync(pythonw) ? pythonw : paths.portablePython(), args: [] };
    const valid = await checkCandidate(candidate);
    if (valid) {
      cachedPythonStatus = valid;
      cachedPythonStatusTime = Date.now();
      return valid;
    }
  }
  if (await commandExists('py.exe')) {
    const candidate = { command: 'py.exe', launchCommand: (await commandExists('pyw.exe')) ? 'pyw.exe' : 'py.exe', args: ['-3'] };
    const valid = await checkCandidate(candidate);
    if (valid) {
      cachedPythonStatus = valid;
      cachedPythonStatusTime = Date.now();
      return valid;
    }
  }
  if (await commandExists('python.exe')) {
    const candidate = { command: 'python.exe', launchCommand: (await commandExists('pythonw.exe')) ? 'pythonw.exe' : 'python.exe', args: [] };
    const valid = await checkCandidate(candidate);
    if (valid) {
      cachedPythonStatus = valid;
      cachedPythonStatusTime = Date.now();
      return valid;
    }
  }
  const notFound = { installed: false, command: '', launchCommand: '', prefixArgs: [], version: '' };
  cachedPythonStatus = notFound;
  cachedPythonStatusTime = Date.now();
  return notFound;
}

function pathForPythonw(pythonPath) {
  return require('node:path').join(require('node:path').dirname(pythonPath), 'pythonw.exe');
}

class EnvironmentService {
  async inspect(settings, options = {}) {
    const force = options.force === true || options.forceProxy === true;
    const [python, proxy, mcpListening, tunnelListening] = await Promise.all([
      pythonStatus({ force }),
      resolveProxy(settings, { force: options.forceProxy === true }).catch(() => ({ mode: settings.proxyMode, resolvedUrl: '', source: 'error', reachable: false })),
      canConnect('127.0.0.1', settings.mcpPort),
      canConnect('127.0.0.1', settings.healthPort)
    ]);
    return {
      platform: process.platform,
      python,
      proxy: {
        mode: proxy.mode,
        configured: Boolean(proxy.resolvedUrl),
        reachable: proxy.reachable,
        url: proxy.resolvedUrl,
        source: proxy.source
      },
      tunnelClient: { installed: fs.existsSync(paths.tunnelExecutable()), path: paths.tunnelExecutable() },
      workspace: { configured: Boolean(settings.workspace), exists: Boolean(settings.workspace && fs.existsSync(settings.workspace)) },
      ports: { mcpListening, tunnelListening },
      nativePortableReady: fs.existsSync(paths.portablePython())
    };
  }

}

module.exports = { EnvironmentService, commandExists, canConnect, pythonStatus };
