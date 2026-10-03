const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_PUBLIC_MCP_GATEWAY_PORT = 18768;
const PATH_DERIVATION_CONTEXT = 'web-mcp-assistant/public-mcp-gateway/v1';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function derivePublicMcpAccessKey(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  return crypto.createHmac('sha256', value).update(PATH_DERIVATION_CONTEXT).digest('base64url');
}

function publicMcpAccessPath(token) {
  const accessKey = derivePublicMcpAccessKey(token);
  return accessKey ? `/mcp/${accessKey}` : '';
}

function publicMcpUrl(baseUrl, token) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const accessPath = publicMcpAccessPath(token);
  return base && accessPath ? `${base}${accessPath}` : '';
}

function requestHeadersForUpstream(headers, token, port) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = String(name || '').toLowerCase();
    if (!normalized || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized === 'authorization' || normalized === 'host') continue;
    forwarded[name] = value;
  }
  forwarded.Authorization = `Bearer ${token}`;
  forwarded.Host = `127.0.0.1:${port}`;
  return forwarded;
}

function copyResponseHeaders(source, target) {
  for (const [name, value] of Object.entries(source || {})) {
    const normalized = String(name || '').toLowerCase();
    if (!normalized || HOP_BY_HOP_HEADERS.has(normalized) || value === undefined) continue;
    try { target.setHeader(name, value); } catch { /* invalid upstream header must not break the proxy */ }
  }
}

class PublicMcpGateway {
  constructor({ settings, secrets, log = null, host = '127.0.0.1', port = DEFAULT_PUBLIC_MCP_GATEWAY_PORT }) {
    this.settings = settings;
    this.secrets = secrets;
    this.log = log;
    this.host = host;
    this.port = Number(port);
    this.server = null;
  }

  accessPath() {
    return publicMcpAccessPath(this.secrets.get('mcpAuthToken'));
  }

  address() {
    const bound = this.server?.address?.();
    return bound && typeof bound === 'object'
      ? { host: this.host, port: Number(bound.port), path: this.accessPath() }
      : { host: this.host, port: this.port, path: this.accessPath() };
  }

  connectionInfo(baseUrl = '') {
    const token = this.secrets.get('mcpAuthToken');
    const address = this.address();
    return {
      running: Boolean(this.server),
      host: address.host,
      port: address.port,
      path: address.path,
      url: publicMcpUrl(baseUrl, token),
      localUrl: address.path ? `http://${address.host}:${address.port}${address.path}` : ''
    };
  }

  async start() {
    if (this.server) return this.address();
    const server = http.createServer((request, response) => this.handle(request, response));
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.server = server;
    const status = this.address();
    this.log?.info?.('Public MCP Gateway 已启动', { port: status.port, pathFingerprint: derivePublicMcpAccessKey(this.secrets.get('mcpAuthToken')).slice(0, 8) });
    return status;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return false;
    await new Promise((resolve) => server.close(() => resolve()));
    return true;
  }

  handle(request, response) {
    const token = String(this.secrets.get('mcpAuthToken') || '').trim();
    const expectedPath = publicMcpAccessPath(token);
    const pathname = (() => {
      try { return new URL(request.url || '/', 'http://127.0.0.1').pathname; }
      catch { return ''; }
    })();

    if (!token || !expectedPath) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Coding Tools MCP Runtime authentication is not ready.' }));
      return;
    }
    if (pathname !== expectedPath) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(String(request.method || '').toUpperCase())) {
      response.writeHead(405, { Allow: 'GET, POST, DELETE', 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const current = this.settings.load();
    const upstreamPort = Number(current.mcpPort);
    if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Coding Tools MCP Runtime port is unavailable.' }));
      return;
    }

    const upstream = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      path: '/mcp',
      method: request.method,
      headers: requestHeadersForUpstream(request.headers, token, upstreamPort)
    }, (upstreamResponse) => {
      copyResponseHeaders(upstreamResponse.headers, response);
      response.writeHead(upstreamResponse.statusCode || 502);
      upstreamResponse.pipe(response);
    });

    upstream.on('error', (error) => {
      this.log?.warn?.('Public MCP Gateway 上游连接失败', { port: upstreamPort, error: error.message });
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'Coding Tools MCP Runtime is temporarily unavailable.' }));
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  }
}

module.exports = {
  PublicMcpGateway,
  DEFAULT_PUBLIC_MCP_GATEWAY_PORT,
  derivePublicMcpAccessKey,
  publicMcpAccessPath,
  publicMcpUrl
};
