const os = require('node:os');
const { readJson } = require('./jsonStore');
const { stateFile } = require('../paths');
const { probeDirect, probeHttpProxy } = require('./proxyService');

function stateOf(ok, warn = false) {
  if (ok) return 'ready';
  return warn ? 'warn' : 'error';
}

function short(value, limit = 16) {
  const text = String(value || '');
  return text ? text.slice(0, limit) : '';
}

function redactSensitiveText(value) {
  let text = String(value || '');
  text = text.replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[已隐藏]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer [已隐藏]');
  text = text.replace(/((?:api[_ -]?key|token|cookie|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]');
  return text;
}

function redactSensitivePaths(value) {
  let text = String(value || '');
  text = text.replace(/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%');
  text = text.replace(/\/Users\/[^\/\s"']+/g, '$HOME');
  text = text.replace(/\/home\/[^\/\s"']+/g, '$HOME');
  return text;
}

function supportReportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `support-report-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}

function yesNo(value) {
  return value === null || value === undefined ? '未检测' : value ? '是' : '否';
}

function renderSupportReport(doctor) {
  const versions = doctor?.versions || {};
  const processInfo = doctor?.process || {};
  const config = doctor?.configuration || {};
  const network = doctor?.network || {};
  const checks = Array.isArray(doctor?.checks) ? doctor.checks : [];
  const errors = Array.isArray(doctor?.recentErrors) ? doctor.recentErrors.slice(-8) : [];
  const lines = [
    '网页 MCP 助手 Support Report',
    `生成时间: ${doctor?.inspectedAt || new Date().toISOString()}`,
    `总体状态: ${doctor?.severity || 'unknown'} · ${doctor?.summary || ''}`,
    '',
    '[版本]',
    `Desktop: ${versions.desktop || '—'}`,
    `Runtime: ${versions.runtime || '—'}`,
    `Schema: v${versions.schemaVersion || 0} / ${versions.schemaHash || '—'}`,
    `Node: ${versions.node || '—'}`,
    `Python: ${versions.python || '—'}`,
    `Platform: ${versions.platform || '—'}`,
    '',
    '[进程身份]',
    `Runtime PID: ${processInfo.runtimePid || '—'}`,
    `Tunnel PID: ${processInfo.tunnelPid || '—'}`,
    `Runtime instance: ${processInfo.runtimeInstanceId || '—'}`,
    `Client instance: ${processInfo.clientInstanceId || '—'}`,
    '',
    '[配置存在性]',
    `Workspace configured: ${yesNo(config.workspaceConfigured)}`,
    `Runtime API Key configured: ${yesNo(config.runtimeApiKeyConfigured)}`,
    `MCP Token configured: ${yesNo(config.mcpTokenConfigured)}`,
    `Tunnel ID configured: ${yesNo(config.tunnelIdConfigured)}`,
    `Proxy mode/source: ${config.proxyMode || '—'} / ${config.proxySource || '—'}`,
    `Proxy configured: ${yesNo(config.proxyConfigured)}`,
    '',
    '[Network Doctor]',
    `Direct reachability: ${yesNo(network.directReachable)}`,
    `Proxy reachability: ${yesNo(network.proxyReachable)}`,
    `Tunnel local admin: ${yesNo(network.tunnelAdminReady)}`,
    `OpenAI control plane: ${yesNo(network.controlPlaneReachable)}`,
    `Main channel: ${yesNo(network.mainChannelReady)}`,
    '',
    '[分层诊断]'
  ];
  for (const item of checks) {
    lines.push(`- ${item.label || item.id || 'unknown'} [${item.state || 'unknown'}]`);
    if (item.evidence) lines.push(`  证据: ${String(item.evidence).slice(0, 360)}`);
    if (item.suggestion) lines.push(`  建议: ${String(item.suggestion).slice(0, 360)}`);
  }
  lines.push('', '[最近错误摘要]');
  if (!errors.length) lines.push('- 无');
  for (const item of errors) {
    lines.push(`- ${item.time || '—'} · ${String(item.message || '').replace(/[\r\n]+/g, ' ').slice(0, 320)}`);
  }
  lines.push('', '说明: 本报告不包含完整聊天正文、完整命令正文、代理 URL、工作区完整路径或秘密值。');
  return redactSensitiveText(redactSensitivePaths(lines.join('\n')));
}

function safeErrorSummary(log, limit = 8) {
  if (!log || typeof log.read !== 'function') return [];
  return log.read(120)
    .filter((item) => item && String(item.level || '').toLowerCase() === 'error')
    .slice(-limit)
    .map((item) => ({
      time: String(item.time || ''),
      message: redactSensitiveText(item.message).slice(0, 320)
    }));
}

class DoctorService {
  constructor({ settings, secrets, environment, orchestrator, healthService, log, getChatState, appVersion = '', probeDirectFn = probeDirect, probeHttpProxyFn = probeHttpProxy }) {
    Object.assign(this, { settings, secrets, environment, orchestrator, healthService, log, getChatState, appVersion, probeDirectFn, probeHttpProxyFn });
  }

  async createSupportReport(options = {}) {
    const doctor = await this.inspect(options);
    return { filename: supportReportFilename(options.date || new Date()), text: renderSupportReport(doctor), doctor };
  }

  async inspect(options = {}) {
    const current = this.settings.load();
    const [snapshot, health] = await Promise.all([
      this.orchestrator.snapshot({ force: true, reason: 'doctor' }),
      this.healthService.inspect()
    ]);
    const runtimeState = readJson(stateFile(), {});
    const chat = typeof this.getChatState === 'function' ? (this.getChatState() || {}) : {};
    const attachment = chat.mcpAttachment || snapshot.chat?.mcpAttachment || {};
    const status = snapshot.status || {};
    const tunnel = status.tunnelDiagnostics || {};
    const env = health.environment || snapshot.environment || await this.environment.inspect(current);
    const proxy = env.proxy || {};

    let directReachable = null;
    let proxyReachable = null;
    if (options.network !== false) {
      [directReachable, proxyReachable] = await Promise.all([
        this.probeDirectFn().catch(() => false),
        proxy.configured && proxy.url
          ? this.probeHttpProxyFn(proxy.url).catch(() => false)
          : Promise.resolve(null)
      ]);
    }

    const runtimeIdentity = health.schemaIdentity?.runtime || null;
    const expectedIdentity = health.schemaIdentity?.expected || null;
    const attachmentStatus = String(attachment.status || 'unknown');
    const attachmentReady = attachmentStatus === 'attached';
    const attachmentAvailable = attachmentStatus === 'available';
    const configReady = Boolean(current.workspace && this.secrets.status().runtimeApiKey && current.tunnelId && this.secrets.status().mcpAuthToken);

    const checks = [
      {
        id: 'runtime',
        label: '本地 MCP Runtime',
        state: stateOf(Boolean(status.runtimeRunning)),
        evidence: status.runtimeRunning
          ? `MCP ${current.mcpPort} · PID ${runtimeIdentity?.processId || runtimeState.nativePid || '—'} · Runtime ${runtimeIdentity?.version || '—'} · Schema v${runtimeIdentity?.schemaVersion || 0}`
          : `127.0.0.1:${current.mcpPort} 未确认当前工作区 Runtime`,
        suggestion: status.runtimeRunning ? '无需处理。' : '先检查 Runtime 是否启动、端口是否冲突，以及 Runtime/Schema 身份是否匹配。'
      },
      {
        id: 'tunnel_admin',
        label: 'Tunnel 本地管理端',
        state: stateOf(Boolean(tunnel.adminReady || tunnel.localReady)),
        evidence: tunnel.adminReady || tunnel.localReady
          ? `health ${current.healthPort} · client ${short(tunnel.clientInstanceId, 12) || '—'}`
          : `127.0.0.1:${current.healthPort} 的 Tunnel admin/status 不可用`,
        suggestion: tunnel.adminReady || tunnel.localReady ? '无需处理。' : '先检查 tunnel-client 进程和本地 health 端口，不要因上游网络问题重启健康 Runtime。'
      },
      {
        id: 'control_plane',
        label: 'OpenAI 上游 / Control Plane',
        state: stateOf(Boolean(tunnel.upstreamReachable), Boolean(tunnel.localReady || status.tunnelRunning)),
        evidence: tunnel.upstreamReachable ? 'Tunnel 报告上游路径可达' : (tunnel.localReady ? 'Tunnel 本地存活，但上游当前不可达' : 'Tunnel 本地与上游均未就绪'),
        suggestion: tunnel.upstreamReachable ? '无需处理。' : '比较 direct/proxy reachability；若只是上游短暂波动，保持本地 Runtime/Tunnel 进程不动。'
      },
      {
        id: 'main_channel',
        label: 'Tunnel main Channel',
        state: stateOf(tunnel.mainChannelReady === true, Boolean(tunnel.localReady)),
        evidence: tunnel.mainChannelReady === true ? 'main channel probe=ok' : `main channel probe=${String(tunnel.mainChannelProbe || 'unknown')}`,
        suggestion: tunnel.mainChannelReady === true ? '无需处理。' : '检查 Tunnel 本地 /api/status 的 main channel probe 与 MCP Bearer 路由，不要只看 Tunnel 进程是否存活。'
      },
      {
        id: 'attachment',
        label: '当前 ChatGPT 消息 MCP Attachment',
        state: attachmentReady ? 'ready' : attachmentAvailable ? 'warn' : 'error',
        evidence: `attachment=${attachmentStatus}${attachment.detail ? ` · ${String(attachment.detail).slice(0, 180)}` : ''}`,
        suggestion: attachmentReady ? '无需处理。' : '这层独立于 Tunnel；在新的用户消息上确认 Coding Tools MCP 已被当前消息实际挂载。'
      },
      {
        id: 'configuration',
        label: '基础配置完整性',
        state: configReady ? 'ready' : 'warn',
        evidence: `workspace=${Boolean(current.workspace)} · runtime_key=${Boolean(this.secrets.status().runtimeApiKey)} · tunnel_id=${Boolean(current.tunnelId)} · mcp_token=${Boolean(this.secrets.status().mcpAuthToken)}`,
        suggestion: configReady ? '配置项已存在；报告不会输出秘密值。' : '补齐缺失配置后再启动连接。'
      }
    ];

    const severity = checks.some((item) => item.state === 'error') ? 'error'
      : checks.some((item) => item.state === 'warn') ? 'warn' : 'ready';

    return {
      ok: true,
      inspectedAt: new Date().toISOString(),
      severity,
      summary: severity === 'ready' ? '连接链路各层均正常' : severity === 'warn' ? '连接链路存在降级项' : '连接链路存在需要处理的故障层',
      versions: {
        desktop: String(this.appVersion || ''),
        runtime: String(runtimeIdentity?.version || expectedIdentity?.runtime_version || ''),
        schemaVersion: Number(runtimeIdentity?.schemaVersion || expectedIdentity?.schema_version || 0),
        schemaHash: short(runtimeIdentity?.schemaHash || expectedIdentity?.schema_hash, 12),
        node: process.versions.node,
        python: String(env.python?.version || ''),
        platform: `${process.platform} ${os.release()}`
      },
      process: {
        runtimePid: Number(runtimeIdentity?.processId || runtimeState.nativePid || 0) || null,
        tunnelPid: Number(runtimeState.tunnelPid || 0) || null,
        runtimeInstanceId: short(runtimeIdentity?.runtimeInstanceId, 12),
        clientInstanceId: short(tunnel.clientInstanceId, 12)
      },
      configuration: {
        workspaceConfigured: Boolean(current.workspace),
        runtimeApiKeyConfigured: Boolean(this.secrets.status().runtimeApiKey),
        mcpTokenConfigured: Boolean(this.secrets.status().mcpAuthToken),
        tunnelIdConfigured: Boolean(current.tunnelId),
        proxyMode: String(current.proxyMode || 'auto'),
        proxySource: String(proxy.source || ''),
        proxyConfigured: Boolean(proxy.configured)
      },
      network: {
        directReachable,
        proxyReachable,
        tunnelAdminReady: Boolean(tunnel.adminReady || tunnel.localReady),
        controlPlaneReachable: Boolean(tunnel.upstreamReachable),
        mainChannelReady: tunnel.mainChannelReady === true
      },
      checks,
      recentErrors: safeErrorSummary(this.log)
    };
  }
}

module.exports = { DoctorService, redactSensitiveText, redactSensitivePaths, supportReportFilename, renderSupportReport, safeErrorSummary, short, stateOf };
