const http = require('node:http');

function parseSsePayload(body) {
  const chunks = String(body || '')
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter(Boolean);
  if (!chunks.length) return null;
  return JSON.parse(chunks.at(-1));
}

function parseRpcPayload(body, contentType = '') {
  const text = String(body || '').trim();
  if (!text) return null;
  if (String(contentType).toLowerCase().includes('text/event-stream')) return parseSsePayload(text);
  try { return JSON.parse(text); }
  catch {
    const fromSse = parseSsePayload(text);
    if (fromSse) return fromSse;
    throw new Error('本地 MCP 返回了无法解析的响应。');
  }
}

function parseSseEventBlock(block) {
  const lines = String(block || '').split(/\r?\n/);
  const idLine = lines.find((line) => line.startsWith('id:'));
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  return {
    id: idLine ? idLine.slice(3).trim() : '',
    event: eventLine ? eventLine.slice(6).trim() : 'message',
    data: JSON.parse(data)
  };
}

class LocalMcpClient {
  constructor({ port, token, log = null }) {
    this.port = Number(port);
    this.token = String(token || '');
    this.log = log;
    this.sessionId = '';
    this.requestId = 0;
    this.tools = [];
    this.serverInfo = null;
    this.runtimeIdentityKey = '';
  }

  configure({ port, token }) {
    const nextPort = Number(port);
    const nextToken = String(token || '');
    if (nextPort !== this.port || nextToken !== this.token) this.resetDiscoveryState();
    this.port = nextPort;
    this.token = nextToken;
  }

  resetDiscoveryState() {
    this.sessionId = '';
    this.tools = [];
    this.serverInfo = null;
    this.runtimeIdentityKey = '';
  }

  async request(method, params = {}, options = {}) {
    if (!Number.isInteger(this.port) || this.port < 1) throw new Error('本地 MCP 端口无效。');
    if (!this.token) throw new Error('本地 MCP 认证 Token 不可用。');
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params
    });
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));

    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Coding-Tools-Origin': 'desktop',
        'Content-Length': Buffer.byteLength(body)
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const request = http.request({
        host: '127.0.0.1',
        port: this.port,
        path: '/mcp',
        method: 'POST',
        headers,
        timeout: timeoutMs
      }, (response) => {
        let payload = '';
        const maxBytes = Number(options.maxBytes || 8 * 1024 * 1024);
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (Buffer.byteLength(payload) < maxBytes) payload += chunk;
        });
        response.on('end', () => {
          const sessionId = response.headers['mcp-session-id'];
          if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId;
          let parsed;
          try { parsed = parseRpcPayload(payload, response.headers['content-type']); }
          catch (error) { reject(error); return; }
          if ((response.statusCode || 500) >= 400) {
            const message = parsed?.error?.message || `本地 MCP 请求失败（HTTP ${response.statusCode}）`;
            reject(new Error(message));
            return;
          }
          if (parsed?.error) {
            reject(new Error(parsed.error.message || '本地 MCP 工具调用失败。'));
            return;
          }
          resolve(parsed?.result ?? parsed ?? null);
        });
      });
      request.on('timeout', () => request.destroy(new Error(`本地 MCP 请求超时（${timeoutMs} ms）`)));
      request.on('error', reject);
      request.end(body);
    });
  }

  async ping() {
    await this.request('ping', {}, { timeoutMs: 2500, maxBytes: 65536 });
    return true;
  }

  async latestTaskEventId() {
    if (!Number.isInteger(this.port) || this.port < 1) throw new Error('本地 MCP 端口无效。');
    if (!this.token) throw new Error('本地 MCP 认证 Token 不可用。');
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: this.port, path: '/__control/health', method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, timeout: 2500
      }, (response) => {
        let payload = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { if (payload.length < 65536) payload += chunk; });
        response.on('end', () => {
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`本地 MCP 健康检查失败（HTTP ${response.statusCode}）。`));
            return;
          }
          try {
            const parsed = JSON.parse(payload || '{}');
            resolve(Math.max(0, Number(parsed.latest_task_event_id || 0)));
          } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('本地 MCP 健康检查超时。')));
      request.on('error', reject);
      request.end();
    });
  }

  async discoverTools() {
    const previousIdentity = this.runtimeIdentityKey;
    // Discovery is deliberately stateless. A runtime restarted on the same port
    // and token must not inherit an MCP session id created by the previous process.
    this.sessionId = '';
    const result = await this.request('server/discover', {}, { timeoutMs: 5000, maxBytes: 2 * 1024 * 1024 });
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    this.serverInfo = result?.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo : null;
    const identity = this.schemaIdentity();
    this.runtimeIdentityKey = [identity.runtimeInstanceId, identity.processId, identity.schemaHash, identity.sourceFingerprint].join(':');
    if (previousIdentity && previousIdentity !== this.runtimeIdentityKey) {
      this.log?.info?.('检测到 MCP Runtime 已换代，已刷新本地工具定义与会话', {
        previousIdentity,
        currentIdentity: this.runtimeIdentityKey
      });
    }
    return this.tools;
  }

  schemaIdentity() {
    return {
      version: String(this.serverInfo?.version || ''),
      schemaVersion: Number(this.serverInfo?.schemaVersion || 0),
      schemaHash: String(this.serverInfo?.schemaHash || ''),
      toolCount: Number(this.serverInfo?.toolCount || this.tools.length || 0),
      runtimeInstanceId: String(this.serverInfo?.runtimeInstanceId || ''),
      processId: Number(this.serverInfo?.processId || 0),
      launchId: String(this.serverInfo?.launchId || ''),
      sourceFingerprint: String(this.serverInfo?.sourceFingerprint || ''),
      workspace: String(this.serverInfo?.workspace || '')
    };
  }

  async callTool(name, args = {}) {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('工具名称不能为空。');
    if (this.tools.length && !this.tools.some((tool) => tool?.name === toolName)) {
      throw new Error(`本地 MCP 未暴露工具：${toolName}`);
    }
    return this.request('tools/call', { name: toolName, arguments: args || {} }, {
      timeoutMs: 610000,
      maxBytes: 16 * 1024 * 1024
    });
  }

  subscribeTaskEvents(listener, options = {}) {
    if (typeof listener !== 'function') throw new Error('Task event listener is required.');
    const reconnectMs = Math.max(500, Number(options.reconnectMs || 1500));
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    let stopped = false;
    let request = null;
    let response = null;
    let reconnectTimer = null;
    let lastEventId = Math.max(0, Number(options.lastEventId || 0));
    let baselineResolved = !(options.baselineLatest === true && lastEventId <= 0);
    const onBaseline = typeof options.onBaseline === 'function' ? options.onBaseline : () => {};
    let endpoint = '/__control/events';

    const scheduleReconnect = (error = null) => {
      if (error) onError(error);
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        beginConnect();
      }, reconnectMs);
      reconnectTimer.unref?.();
    };

    const connect = () => {
      if (stopped) return;
      if (!Number.isInteger(this.port) || this.port < 1 || !this.token) {
        scheduleReconnect(new Error('本地任务事件流尚未配置。'));
        return;
      }
      let buffer = '';
      const headers = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache'
      };
      if (endpoint === '/__control/events' && lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId);
      request = http.request({
        host: '127.0.0.1',
        port: this.port,
        path: endpoint,
        method: 'GET',
        headers
      }, (stream) => {
        response = stream;
        if ((stream.statusCode || 500) >= 400) {
          const statusCode = stream.statusCode || 500;
          stream.resume();
          if (endpoint === '/__control/events' && statusCode === 404) {
            endpoint = '/__control/task-events';
            scheduleReconnect();
            return;
          }
          scheduleReconnect(new Error(`本地任务事件流请求失败（HTTP ${statusCode}）。`));
          return;
        }
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffer += chunk;
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            if (!block.trim() || block.trimStart().startsWith(':')) continue;
            try {
              const parsed = parseSseEventBlock(block);
              if (parsed?.event === 'task-event') {
                const eventId = Math.max(0, Number(parsed.data?.event_id || parsed.id || 0));
                if (eventId && eventId <= lastEventId) continue;
                if (eventId) lastEventId = eventId;
                listener(parsed.data);
              } else if (parsed?.event === 'task-state') {
                listener(parsed.data);
              }
            } catch (error) {
              onError(error);
            }
          }
        });
        stream.on('end', () => scheduleReconnect());
        stream.on('error', (error) => scheduleReconnect(error));
      });
      request.on('error', (error) => scheduleReconnect(error));
      request.end();
    };

    const beginConnect = () => {
      if (stopped) return;
      if (baselineResolved) {
        connect();
        return;
      }
      this.latestTaskEventId().then((eventId) => {
        if (stopped) return;
        lastEventId = Math.max(lastEventId, Math.max(0, Number(eventId || 0)));
        baselineResolved = true;
        onBaseline(lastEventId);
        connect();
      }).catch((error) => scheduleReconnect(error));
    };

    beginConnect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      response?.destroy();
      response = null;
      request?.destroy();
      request = null;
    };
  }
}

module.exports = { LocalMcpClient, parseRpcPayload, parseSseEventBlock };
