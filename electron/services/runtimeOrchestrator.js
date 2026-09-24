const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { NativeService } = require('./nativeService');
const { TunnelService } = require('./tunnelService');
const { LocalMcpClient } = require('./localMcpClient');
const { validateRuntimeSettings, mergeRecentWorkspaces, workspaceKey } = require('./config');
const { canConnect } = require('./environmentService');
const { resolveProxy } = require('./proxyService');
const { stateFile } = require('../paths');
const { readJson, updateJsonAtomic } = require('./jsonStore');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function probeMcpIdentity(port, token, expectedWorkspace = '') {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/__control/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 1200
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve(null); return; }
        try {
          const payload = JSON.parse(body);
          const workspaceMatches = !expectedWorkspace
            || workspaceKey(payload.workspace) === workspaceKey(expectedWorkspace);
          resolve(payload.ready === true && workspaceMatches ? payload : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
    request.end();
  });
}

async function probeMcp(port, token, expectedWorkspace = '') {
  return Boolean(await probeMcpIdentity(port, token, expectedWorkspace));
}

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 5000));
  while (Date.now() < deadline) {
    if (!(await canConnect('127.0.0.1', port, 200))) return true;
    await wait(100);
  }
  return !(await canConnect('127.0.0.1', port, 200));
}

function runtimeIdentityMatches(identity, launch) {
  if (!identity || !launch) return false;
  return Number(identity.process_id || 0) === Number(launch.pid || 0)
    && String(identity.launch_id || '') === String(launch.launchId || '')
    && String(identity.source_fingerprint || '') === String(launch.sourceFingerprint || '');
}

function recoveryLayerFor(status = {}) {
  if (!status.mcpRunning) return 'runtime';
  if (!status.tunnelRunning) return 'tunnel';
  return '';
}

const SCHEMA_REFRESH_NOTICE_MS = 24 * 60 * 60 * 1000;

function compactSchemaIdentity(identity = {}) {
  return {
    version: String(identity.version || ''),
    schemaVersion: Number(identity.schemaVersion || identity.schema_version || 0),
    schemaHash: String(identity.schemaHash || identity.schema_hash || ''),
    toolCount: Number(identity.toolCount || identity.tool_count || 0)
  };
}

function schemaIdentityChanged(previous, current) {
  const before = compactSchemaIdentity(previous || {});
  const after = compactSchemaIdentity(current || {});
  if (!after.schemaVersion || !after.schemaHash) return false;
  if (!before.schemaVersion || !before.schemaHash) return true;
  return before.version !== after.version
    || before.schemaVersion !== after.schemaVersion
    || before.schemaHash !== after.schemaHash
    || before.toolCount !== after.toolCount;
}

function activeSchemaRefreshNotice(now = Date.now()) {
  const state = readJson(stateFile(), {});
  const notice = state.schemaRefreshNotice;
  if (!notice || typeof notice !== 'object') return null;
  const changedAt = Date.parse(String(notice.changedAt || ''));
  if (!Number.isFinite(changedAt) || now - changedAt > SCHEMA_REFRESH_NOTICE_MS) return null;
  return notice;
}

function recordSchemaDiscovery(identity) {
  const current = compactSchemaIdentity(identity);
  let activeNotice = null;
  updateJsonAtomic(stateFile(), (state) => {
    const previous = state.lastDiscoveredSchema && typeof state.lastDiscoveredSchema === 'object'
      ? state.lastDiscoveredSchema
      : null;
    const changed = schemaIdentityChanged(previous, current);
    const notice = changed ? {
      changedAt: new Date().toISOString(),
      previous: previous ? compactSchemaIdentity(previous) : null,
      current,
      message: '本地工具定义已升级；如果这个聊天是在升级前打开的，请新建聊天以刷新工具参数。'
    } : state.schemaRefreshNotice;
    activeNotice = notice || null;
    return { ...state, lastDiscoveredSchema: current, schemaRefreshNotice: notice || null };
  });
  return activeNotice;
}


function switchMcpWorkspace(port, token, workspace) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ workspace });
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/__control/workspace',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, (response) => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (payload.length < 65536) payload += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = payload ? JSON.parse(payload) : {}; } catch { /* handled below */ }
        if (response.statusCode !== 200 || parsed.ready !== true) {
          reject(new Error(parsed.error || `MCP 工作区切换失败（HTTP ${response.statusCode}）`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => { request.destroy(new Error('MCP 工作区切换超时')); });
    request.on('error', reject);
    request.end(body);
  });
}

function setMcpAuthorizedRoots(port, token, roots) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ roots });
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/__control/roots',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, (response) => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (payload.length < 65536) payload += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = payload ? JSON.parse(payload) : {}; } catch { /* handled below */ }
        if (response.statusCode !== 200 || parsed.ready !== true) {
          reject(new Error(parsed.error || `MCP 授权目录更新失败（HTTP ${response.statusCode}）`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => { request.destroy(new Error('MCP 授权目录更新超时')); });
    request.on('error', reject);
    request.end(body);
  });
}

class RuntimeOrchestrator {
  constructor({ settings, secrets, environment, log, emitProgress, emitStatus = () => {} }) {
    this.settingsStore = settings;
    this.secrets = secrets;
    this.environment = environment;
    this.log = log;
    this.emitProgress = emitProgress;
    this.emitStatus = emitStatus;
    this.native = new NativeService(log);
    this.tunnel = new TunnelService(log);
    this.busy = false;
    this.snapshotCache = null;
    this.snapshotCacheAt = 0;
    this.snapshotInFlight = null;
    this.heartbeatFailures = 0;
    this.recovering = false;
    this.recoveryAttempts = 0;
    this.nextRecoveryAt = 0;
    this.autoRecoveryBlocked = false;
    this.lastStartFailure = '';
  }

  progress(step, percent, message) {
    this.emitProgress({ step, percent, message, time: new Date().toISOString() });
    this.log.info(message, { step, percent });
  }

  invalidateSnapshot() {
    this.snapshotCacheAt = 0;
  }

  publishSnapshot(snapshot, reason = 'refresh') {
    const signature = (value) => JSON.stringify(value ? { settings: value.settings, secrets: value.secrets, environment: value.environment, status: value.status } : null);
    const previous = signature(this.snapshotCache);
    this.snapshotCache = snapshot;
    this.snapshotCacheAt = Date.now();
    if (previous !== signature(snapshot)) this.emitStatus({ reason, snapshot });
    return snapshot;
  }

  async ensureToken() {
    let token = this.secrets.get('mcpAuthToken');
    if (!token) {
      token = crypto.randomBytes(32).toString('base64url');
      this.secrets.set('mcpAuthToken', token);
    }
    return token;
  }

  isManuallyStopped() {
    return readJson(stateFile(), {}).manualStop === true;
  }

  setManualStop(value) {
    updateJsonAtomic(stateFile(), (state) => ({
      ...state,
      manualStop: Boolean(value),
      intentChangedAt: new Date().toISOString()
    }));
  }

  validate(settings) {
    if (!settings.workspace || !fs.existsSync(settings.workspace)) throw new Error('请选择一个存在的工作目录。');
    validateRuntimeSettings(settings);
  }

  async start(options = {}) {
    if (this.busy) throw new Error('当前已有部署任务正在运行。');
    const automatic = options.automatic === true;
    if (!automatic) {
      this.autoRecoveryBlocked = false;
      this.lastStartFailure = '';
      this.heartbeatFailures = 0;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
    }
    this.busy = true;
    try {
      this.progress('config-check', 2, '正在检查工作区、Runtime API Key、Tunnel ID 与端口配置');
      const settings = this.settingsStore.load();
      this.validate(settings);
      const runtimeApiKey = this.secrets.get('runtimeApiKey');
      if (!runtimeApiKey) throw new Error('请先在“设置与诊断”中保存 Runtime API Key。');
      if (!settings.tunnelId) throw new Error('请先填写 OpenAI Tunnel ID。');
      const token = await this.ensureToken();
      this.progress('config-ready', 5, '必要配置检查通过');

      this.progress('preflight', 8, '正在检查工作目录、运行环境和端口');
      const env = await this.environment.inspect(settings, { forceProxy: true });
      if (!env.tunnelClient.installed) throw new Error('缺少 OpenAI tunnel-client 运行文件。');
      if (!env.python.installed) {
        throw new Error('便携运行时尚未准备好，开发版需要 Python 3.11+；发行包将内置 Python。');
      }

      this.progress('proxy-detect', 14, '正在检测直连、Windows 系统代理和本地代理端口');
      const proxy = await resolveProxy(settings);
      if (settings.proxyMode === 'manual' && !proxy.reachable) {
        throw new Error(`手动代理不可用：${settings.proxyUrl}。请启动代理软件、修改端口，或切换到自动检测。`);
      }
      const proxyLabel = proxy.resolvedUrl || '直连';
      this.log.info('网络路径检测完成', { mode: settings.proxyMode, source: proxy.source, route: proxyLabel, reachable: proxy.reachable });
      this.progress('proxy-ready', 16, proxy.reachable ? `网络路径可用：${proxyLabel}` : '未验证到可用网络路径，将继续尝试直连并保留诊断日志');

      this.progress('runtime-stop-old', 18, '正在清理本助手上一次启动的旧运行实例');
      await this.tunnel.stop();
      await this.native.stop().catch(() => false);
      if (!(await waitForPortRelease(settings.mcpPort, 5000))) {
        throw new Error(`本地端口 ${settings.mcpPort} 正被其他程序占用。助手不会强制结束未知进程，请在“工作目录”页面更换 MCP 端口。`);
      }
      if (!(await waitForPortRelease(settings.healthPort, 5000))) {
        throw new Error(`本地端口 ${settings.healthPort} 正被其他程序占用。助手不会强制结束未知进程，请更换 Tunnel 控制台端口。`);
      }

      const launch = await this.native.start(settings, token, this.progress.bind(this));

      this.progress('mcp-health', 64, '正在验证 Coding Tools MCP');
      let identity = null;
      for (let index = 0; index < 35; index += 1) {
        const candidate = await probeMcpIdentity(settings.mcpPort, token, settings.workspace);
        if (runtimeIdentityMatches(candidate, launch)) { identity = candidate; break; }
        if (!(await this.native.status(settings))) {
          throw new Error('Coding Tools MCP 进程已提前退出。请查看运行日志中的 mcp.log 获取具体启动错误。');
        }
        await wait(1000);
      }
      if (!identity) throw new Error('Coding Tools MCP 未能以本次启动实例通过身份健康检查，可能仍连接到旧进程。');

      const discoveryClient = new LocalMcpClient({ port: settings.mcpPort, token, log: this.log });
      await discoveryClient.discoverTools();
      const discovered = discoveryClient.schemaIdentity();
      if (discovered.runtimeInstanceId !== String(identity.runtime_instance_id || identity.instance_id || '')
        || discovered.processId !== Number(identity.process_id || 0)
        || discovered.sourceFingerprint !== String(identity.source_fingerprint || '')
        || discovered.schemaVersion !== Number(identity.schema_version || 0)
        || discovered.schemaHash !== String(identity.schema_hash || '')) {
        throw new Error('MCP tools discovery 与健康检查身份不一致，已拒绝继续启动 Tunnel。');
      }
      recordSchemaDiscovery(discovered);

      await this.tunnel.start({ ...settings, effectiveProxyUrl: proxy.resolvedUrl }, runtimeApiKey, token, this.progress.bind(this));
      this.setManualStop(false);
      this.autoRecoveryBlocked = false;
      this.lastStartFailure = '';
      this.heartbeatFailures = 0;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      this.progress('complete', 100, '部署完成，MCP 与 OpenAI Tunnel 均已运行');
      this.invalidateSnapshot();
      return await this.snapshot({ force: true, reason: 'started' });
    } catch (error) {
      this.autoRecoveryBlocked = true;
      this.lastStartFailure = error.message;
      this.heartbeatFailures = 0;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      await this.tunnel.stop().catch(() => false);
      await this.native.stop().catch(() => false);
      this.invalidateSnapshot();
      this.log.error(error.message, { stage: 'start' });
      this.emitProgress({ step: 'failed', percent: 100, message: error.message, time: new Date().toISOString() });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async stop(options = {}) {
    if (this.busy) throw new Error('当前已有任务正在运行。');
    this.busy = true;
    try {
      if (options.manual !== false) this.setManualStop(true);
      this.progress('stop-connection', 20, '正在停止当前连接通道');
      await this.tunnel.stop();
      this.progress('stop-runtime', 65, '正在停止 Coding Tools MCP');
      await this.native.stop().catch(() => false);
      this.progress('stopped', 100, '所有由本助手启动的服务均已停止');
      this.invalidateSnapshot();
      return await this.snapshot({ force: true, reason: 'stopped' });
    } finally {
      this.busy = false;
    }
  }

  async restart(options = {}) {
    await this.stop({ manual: false });
    return this.start(options);
  }

  async restartRuntime(options = {}) {
    if (this.busy) throw new Error('当前已有部署或恢复操作正在进行。');
    this.busy = true;
    try {
      const settings = this.settingsStore.load();
      this.validate(settings);
      const token = await this.ensureToken();
      this.progress('runtime-mode-restart', 25, '正在静默重启本地 MCP Runtime，Tunnel 保持运行');
      await this.native.stop().catch(() => false);
      if (!(await waitForPortRelease(settings.mcpPort, 5000))) {
        throw new Error(`本地端口 ${settings.mcpPort} 未及时释放，无法切换 Agent 模式。`);
      }
      const launch = await this.native.start(settings, token, this.progress.bind(this));
      let identity = null;
      for (let index = 0; index < 35; index += 1) {
        const candidate = await probeMcpIdentity(settings.mcpPort, token, settings.workspace);
        if (runtimeIdentityMatches(candidate, launch)) { identity = candidate; break; }
        if (!(await this.native.status(settings))) throw new Error('Coding Tools MCP 在模式切换过程中提前退出。');
        await wait(500);
      }
      if (!identity) throw new Error('新 Agent 模式的 MCP Runtime 未通过身份校验。');
      const discoveryClient = new LocalMcpClient({ port: settings.mcpPort, token, log: this.log });
      await discoveryClient.discoverTools();
      const discovered = discoveryClient.schemaIdentity();
      if (discovered.runtimeInstanceId !== String(identity.runtime_instance_id || identity.instance_id || '')
        || discovered.processId !== Number(identity.process_id || 0)
        || discovered.sourceFingerprint !== String(identity.source_fingerprint || '')
        || discovered.schemaVersion !== Number(identity.schema_version || 0)
        || discovered.schemaHash !== String(identity.schema_hash || '')) {
        throw new Error('Agent 模式切换后 MCP discovery 与 Runtime 身份不一致。');
      }
      recordSchemaDiscovery(discovered);
      this.autoRecoveryBlocked = false;
      this.lastStartFailure = '';
      this.heartbeatFailures = 0;
      this.invalidateSnapshot();
      this.progress('runtime-mode-ready', 100, 'Agent 模式已生效，Tunnel 未重启');
      return await this.snapshot({ force: true, reason: options.reason || 'runtime-restarted' });
    } catch (error) {
      this.lastStartFailure = error.message;
      this.invalidateSnapshot();
      this.log.error(error.message, { stage: 'runtime-only-restart' });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async restartTunnel(options = {}) {
    if (this.busy) throw new Error('当前已有部署任务正在运行。');
    this.busy = true;
    try {
      const settings = this.settingsStore.load();
      this.validate(settings);
      const runtimeApiKey = this.secrets.get('runtimeApiKey');
      if (!runtimeApiKey) throw new Error('Runtime API Key 不可用，无法恢复 Tunnel。');
      if (!settings.tunnelId) throw new Error('Tunnel ID 不可用，无法恢复连接通道。');
      const token = await this.ensureToken();
      const identity = await probeMcpIdentity(settings.mcpPort, token, settings.workspace);
      if (!identity) throw new Error('本地 MCP Runtime 当前不可用，不能执行 Tunnel-only 恢复。');

      const proxy = await resolveProxy(settings, { force: true });
      if (!proxy.reachable) {
        throw new Error('当前没有可用的 OpenAI 网络路径，暂不重启 Tunnel；网络恢复后会自动重试。');
      }
      this.progress('tunnel-recovery-stop', 30, '本地 MCP 正常，仅重启 OpenAI Tunnel');
      await this.tunnel.stop();
      if (!(await waitForPortRelease(settings.healthPort, 5000))) {
        throw new Error(`Tunnel 控制端口 ${settings.healthPort} 未能释放。`);
      }
      await this.tunnel.start({ ...settings, effectiveProxyUrl: proxy.resolvedUrl }, runtimeApiKey, token, this.progress.bind(this));
      this.lastStartFailure = '';
      this.heartbeatFailures = 0;
      this.invalidateSnapshot();
      this.progress('tunnel-recovery-complete', 100, 'OpenAI Tunnel 已恢复，本地 MCP Runtime 未重启');
      return await this.snapshot({ force: true, reason: options.automatic ? 'tunnel-auto-recovered' : 'tunnel-restarted' });
    } finally {
      this.busy = false;
    }
  }

  async switchWorkspace(nextWorkspace) {
    if (this.busy) throw new Error('当前已有任务正在运行。');
    const previous = this.settingsStore.load();
    const workspace = path.resolve(String(nextWorkspace || '').trim());
    if (!workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('请选择一个存在的工作目录。');
    }

    const recentWorkspaces = mergeRecentWorkspaces(previous.recentWorkspaces, workspace);
    if (workspaceKey(previous.workspace) === workspaceKey(workspace)) {
      if (JSON.stringify(recentWorkspaces) !== JSON.stringify(previous.recentWorkspaces || [])) {
        this.settingsStore.save({ recentWorkspaces });
      }
      return this.snapshot({ force: true, reason: 'workspace-reselected' });
    }

    this.busy = true;
    let runtimeWasRunning = false;
    try {
      runtimeWasRunning = await this.native.status();
    } catch {
      runtimeWasRunning = false;
    }

    if (!runtimeWasRunning) {
      this.settingsStore.save({ workspace, recentWorkspaces });
      this.progress('workspace-saved', 100, '工作目录已保存，服务下次启动时生效');
      this.busy = false;
      this.invalidateSnapshot();
      return this.snapshot({ force: true, reason: 'workspace-saved' });
    }

    const token = await this.ensureToken();
    try {
      this.progress('workspace-switch', 20, '正在热切换 MCP 工作目录');
      await switchMcpWorkspace(previous.mcpPort, token, workspace);
      const next = this.settingsStore.save({ workspace, recentWorkspaces });
      await this.native.markWorkspace(next);
      this.progress('workspace-health', 80, '正在验证新的工作目录');
      const ready = await probeMcp(next.mcpPort, token, workspace);
      if (!ready) throw new Error('新工作目录与 MCP 实际目录不一致。');
      this.progress(
        'workspace-complete',
        100,
        '工作目录已切换，MCP 与 Tunnel 均未重启'
      );
      this.invalidateSnapshot();
      return this.snapshot({ force: true, reason: 'workspace-switched' });
    } catch (error) {
      this.log.error(error.message, { stage: 'workspace-switch', rollback: previous.workspace });
      try {
        await switchMcpWorkspace(previous.mcpPort, token, previous.workspace);
        this.settingsStore.save(previous);
        await this.native.markWorkspace(previous);
      } catch (rollbackError) {
        this.log.error(rollbackError.message, { stage: 'workspace-rollback' });
      }
      throw new Error(`工作目录切换失败：${error.message}`);
    } finally {
      this.busy = false;
    }
  }

  async updateAuthorizedRoots(roots) {
    if (this.busy) throw new Error('当前已有任务正在运行。');
    const previous = this.settingsStore.load();
    const normalized = (Array.isArray(roots) ? roots : [])
      .map((item) => path.resolve(String(item || '').trim()))
      .filter((item) => item && fs.existsSync(item) && fs.statSync(item).isDirectory())
      .filter((item, index, all) => all.findIndex((other) => workspaceKey(other) === workspaceKey(item)) === index)
      .filter((item) => workspaceKey(item) !== workspaceKey(previous.workspace))
      .slice(0, 32);
    this.busy = true;
    try {
      const runtimeWasRunning = await this.native.status().catch(() => false);
      if (runtimeWasRunning) {
        const token = await this.ensureToken();
        await setMcpAuthorizedRoots(previous.mcpPort, token, normalized);
      }
      const saved = this.settingsStore.save({ authorizedRoots: normalized });
      if (runtimeWasRunning) await this.native.markWorkspace(saved);
      this.invalidateSnapshot();
      return this.snapshot({ force: true, reason: 'authorized-roots-updated' });
    } finally {
      this.busy = false;
    }
  }

  async lightweightSnapshot() {
    const settings = this.settingsStore.load();
    const token = this.secrets.get('mcpAuthToken');
    const schemaRefreshNotice = activeSchemaRefreshNotice();
    const [mcpRunning, tunnelState] = await Promise.all([
      token ? probeMcp(settings.mcpPort, token, settings.workspace) : Promise.resolve(false),
      this.tunnel.connectionStatus(settings).catch(() => ({ localReady: false, upstreamReachable: false }))
    ]);
    const tunnelRunning = Boolean(tunnelState.localReady);
    const connectionRunning = tunnelRunning && Boolean(tunnelState.upstreamReachable);
    const failureLayer = recoveryLayerFor({ mcpRunning, tunnelRunning });
    return {
      workspace: settings.workspace,
      connectionMode: 'official',
      mcpRunning,
      tunnelRunning,
      tunnelUpstreamReachable: Boolean(tunnelState.upstreamReachable),
      connectionRunning,
      fullyReady: mcpRunning && connectionRunning,
      busy: this.busy,
      recovering: this.recovering,
      manuallyStopped: this.isManuallyStopped(),
      failures: this.heartbeatFailures,
      failureLayer,
      recoveryBlocked: this.autoRecoveryBlocked,
      lastStartFailure: this.lastStartFailure,
      chatSchemaRefreshRecommended: Boolean(schemaRefreshNotice),
      schemaRefreshNotice
    };
  }

  async supervise() {
    const status = await this.lightweightSnapshot();
    if (status.fullyReady) {
      this.heartbeatFailures = 0;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      return status;
    }
    const runtimeState = readJson(stateFile(), {});
    const expectedRunning = runtimeState.manualStop === false
      && Boolean(runtimeState.nativePid || runtimeState.tunnelPid || this.settingsStore.load().autoStartServices);
    if (this.busy || this.recovering || this.isManuallyStopped() || !expectedRunning) return status;
    if (this.autoRecoveryBlocked) {
      return { ...status, recoveryBlocked: true, lastStartFailure: this.lastStartFailure };
    }
    const failureLayer = recoveryLayerFor(status);
    if (!failureLayer) {
      this.heartbeatFailures = 0;
      return status;
    }
    this.heartbeatFailures += 1;
    const failureThreshold = failureLayer === 'tunnel' ? 6 : 3;
    if (this.heartbeatFailures < failureThreshold || Date.now() < this.nextRecoveryAt) {
      return { ...status, failures: this.heartbeatFailures };
    }

    this.recovering = true;
    this.recoveryAttempts += 1;
    const delay = Math.min(60000, 2000 * (2 ** Math.min(this.recoveryAttempts - 1, 5)));
    this.nextRecoveryAt = Date.now() + delay;
    this.log.warn('运行时协议健康检查连续失败，开始自动恢复', {
      failures: this.heartbeatFailures,
      attempt: this.recoveryAttempts,
      mcpRunning: status.mcpRunning,
      tunnelRunning: status.tunnelRunning,
      connectionMode: status.connectionMode,
      failureLayer
    });
    try {
      if (failureLayer === 'tunnel') {
        await this.restartTunnel({ automatic: true });
      } else {
        await this.restart({ automatic: true });
      }
      this.heartbeatFailures = 0;
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
    } catch (error) {
      this.log.error(error.message, { stage: 'automatic-recovery', retryAfterMs: delay });
    } finally {
      this.recovering = false;
    }
    return this.lightweightSnapshot();
  }

  async snapshot(options = {}) {
    const force = options.force === true;
    if (!force && this.snapshotCache && Date.now() - this.snapshotCacheAt < 15000) return this.snapshotCache;
    if (!force && this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = this._collectSnapshot(options.reason || 'refresh');
    try { return await this.snapshotInFlight; }
    finally { this.snapshotInFlight = null; }
  }

  async _collectSnapshot(reason) {
    const settings = this.settingsStore.load();
    const environment = await this.environment.inspect(settings);
    const schemaRefreshNotice = activeSchemaRefreshNotice();
    const token = this.secrets.get('mcpAuthToken');
    const runtimeRunning = token
      ? await probeMcp(settings.mcpPort, token, settings.workspace)
      : false;
    const tunnelState = await this.tunnel.inspect(settings).catch(() => ({
      localReady: false,
      upstreamReachable: false,
      adminReady: false,
      clientInstanceId: '',
      tunnelId: settings.tunnelId || '',
      tunnelName: '',
      mainChannelProbe: 'unavailable',
      mainChannelReady: false
    }));
    const tunnelRunning = Boolean(tunnelState.localReady);
    const connectionRunning = tunnelRunning && Boolean(tunnelState.upstreamReachable);
    return this.publishSnapshot({
      settings,
      secrets: this.secrets.status(),
      environment,
      status: {
        busy: this.busy,
        runtimeRunning,
        tunnelRunning,
        tunnelUpstreamReachable: Boolean(tunnelState.upstreamReachable),
        tunnelDiagnostics: tunnelState,
        connectionRunning,
        connectionMode: 'official',
        fullyReady: runtimeRunning && connectionRunning,
        localMcpUrl: `http://127.0.0.1:${settings.mcpPort}/mcp`,
        tunnelUiUrl: `http://127.0.0.1:${settings.healthPort}/ui`,
        manuallyStopped: this.isManuallyStopped(),
        chatSchemaRefreshRecommended: Boolean(schemaRefreshNotice),
        schemaRefreshNotice
      }
    }, reason);
  }
}

module.exports = { RuntimeOrchestrator, probeMcp, probeMcpIdentity, runtimeIdentityMatches, recoveryLayerFor,
  compactSchemaIdentity, schemaIdentityChanged, activeSchemaRefreshNotice, recordSchemaDiscovery,
  waitForPortRelease, setMcpAuthorizedRoots };


