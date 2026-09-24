const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { tunnelExecutable, tunnelLogFile, stateFile } = require('../paths');
const { readJson, updateJsonAtomic, ensureParent } = require('./jsonStore');
const { rotateLog } = require('./logService');
const { canConnect } = require('./environmentService');
const { probeDirect, probeHttpProxy } = require('./proxyService');
const { run } = require('./commandRunner');
const { isAlive } = require('./nativeService');

function readLocalJson(port, requestPath, timeoutMs = 900) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 131072) body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

class TunnelService {
  constructor(log) {
    this.log = log;
    this.routeHealthCache = null;
    this.lastRouteHealthy = null;
  }

  async start(settings, runtimeApiKey, token, progress) {
    if (!fs.existsSync(tunnelExecutable())) throw new Error('安装包中缺少 tunnel-client.exe。');
    if (!runtimeApiKey) throw new Error('请先保存 OpenAI Runtime API Key。');
    if (!settings.tunnelId) throw new Error('请先填写 OpenAI Tunnel ID。');
    await this.stop();
    progress('tunnel-start', 72, '正在连接 OpenAI MCP Tunnel');
    ensureParent(tunnelLogFile());
    rotateLog(tunnelLogFile());
    const output = fs.openSync(tunnelLogFile(), 'a');
    const env = {
      ...process.env,
      CONTROL_PLANE_API_KEY: runtimeApiKey,
      MCP_RUNTIME_HEADER_VALUE: `Bearer ${token}`
    };
    const args = [
      'run',
      '--control-plane.tunnel-id', settings.tunnelId,
      '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
      '--health.listen-addr', `127.0.0.1:${settings.healthPort}`,
      '--mcp.server-url', `url=http://127.0.0.1:${settings.mcpPort}/mcp,channel=main`,
      '--mcp.extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
      '--mcp.discovery-extra-headers', 'Authorization: env:MCP_RUNTIME_HEADER_VALUE',
      '--log.file', tunnelLogFile()
    ];
    const proxyUrl = Object.prototype.hasOwnProperty.call(settings, 'effectiveProxyUrl')
      ? settings.effectiveProxyUrl
      : settings.proxyUrl;
    if (proxyUrl) args.push('--control-plane.http-proxy', proxyUrl);
    const child = spawn(tunnelExecutable(), args, {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', output, output],
      env
    });
    child.unref();
    updateJsonAtomic(stateFile(), (state) => ({
      ...state,
      tunnelPid: child.pid,
      tunnelStartedAt: new Date().toISOString(),
      tunnelProxyUrl: proxyUrl || '',
      tunnelRouteMode: proxyUrl ? 'proxy' : 'direct'
    }));
    this.routeHealthCache = null;
    for (let index = 0; index < 30; index += 1) {
      if (await canConnect('127.0.0.1', settings.healthPort, 500)) {
        this.log.info('OpenAI Tunnel 已启动', { pid: child.pid, tunnelId: settings.tunnelId });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Tunnel 已启动，但 ${settings.healthPort} 端口未通过就绪检查。请查看 Tunnel 日志。`);
  }

  async stop() {
    const state = readJson(stateFile(), {});
    const alive = isAlive(state.tunnelPid);
    if (!alive) {
      updateJsonAtomic(stateFile(), (value) => ({ ...value, tunnelPid: null, tunnelProxyUrl: '', tunnelRouteMode: '' }));
      this.routeHealthCache = null;
      return false;
    }
    await run('taskkill.exe', ['/PID', String(state.tunnelPid), '/T', '/F'], { allowFailure: true });
    for (let index = 0; index < 25 && isAlive(state.tunnelPid); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(state.tunnelPid)) {
      throw new Error(`OpenAI Tunnel 进程 ${state.tunnelPid} 未能完全退出，已保留进程状态。`);
    }
    updateJsonAtomic(stateFile(), (value) => ({ ...value, tunnelPid: null, tunnelProxyUrl: '', tunnelRouteMode: '' }));
    this.routeHealthCache = null;
    return true;
  }

  async routeHealthy(state, options = {}) {
    const cacheMs = Math.max(0, Number(options.cacheMs ?? 5000));
    const routeKey = `${state.tunnelPid || 0}:${state.tunnelProxyUrl || 'direct'}`;
    if (this.routeHealthCache && this.routeHealthCache.key === routeKey
      && Date.now() - this.routeHealthCache.time < cacheMs) return this.routeHealthCache.healthy;
    const healthy = state.tunnelProxyUrl
      ? await probeHttpProxy(state.tunnelProxyUrl, 1200)
      : await probeDirect(1800);
    this.routeHealthCache = { key: routeKey, time: Date.now(), healthy };
    if (this.lastRouteHealthy !== healthy) {
      this.log[healthy ? 'info' : 'warn'](
        healthy ? 'OpenAI Tunnel 上游网络路径可用' : 'OpenAI Tunnel 本地进程仍在运行，但上游网络路径不可用',
        { route: state.tunnelProxyUrl || 'direct' }
      );
      this.lastRouteHealthy = healthy;
    }
    return healthy;
  }

  async status(settings, options = {}) {
    const state = readJson(stateFile(), {});
    const localReady = isAlive(state.tunnelPid) && await canConnect('127.0.0.1', settings.healthPort, 400);
    if (!localReady || options.requireUpstream !== true) return localReady;
    return this.routeHealthy(state, options);
  }

  async connectionStatus(settings, options = {}) {
    const state = readJson(stateFile(), {});
    const localReady = isAlive(state.tunnelPid) && await canConnect('127.0.0.1', settings.healthPort, 400);
    if (!localReady) return { localReady: false, upstreamReachable: false };
    const upstreamReachable = await this.routeHealthy(state, options).catch(() => false);
    return { localReady: true, upstreamReachable };
  }

  async inspect(settings) {
    const connection = await this.connectionStatus(settings);
    if (!connection.localReady) {
      return {
        ...connection,
        adminReady: false,
        clientInstanceId: '',
        tunnelId: String(settings.tunnelId || ''),
        tunnelName: '',
        mainChannelProbe: 'unavailable',
        mainChannelReady: false
      };
    }
    const status = await readLocalJson(settings.healthPort, '/api/status');
    const main = Array.isArray(status?.channels)
      ? status.channels.find((item) => item?.name === 'main')
      : null;
    const probe = String(main?.probe_status || 'unknown');
    return {
      ...connection,
      adminReady: Boolean(status),
      clientInstanceId: String(status?.client_instance_id || ''),
      tunnelId: String(status?.control_plane_tunnel_id || status?.tunnel_metadata?.ID || settings.tunnelId || ''),
      tunnelName: String(status?.tunnel_metadata?.Name || ''),
      mainChannelProbe: probe,
      mainChannelReady: probe === 'ok'
    };
  }
}

module.exports = { TunnelService };
