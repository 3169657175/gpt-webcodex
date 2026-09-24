const { shell, session, WebContentsView } = require('electron');
const { DownloadService } = require('./services/downloadService');
const { normalizeProxyValue, resolveProxy } = require('./services/proxyService');

const CHAT_HOME = 'https://chatgpt.com/';
const CHAT_PARTITION = 'persist:chatgpt-session';
const NAVIGATION_HOSTS = new Set([
  'chatgpt.com', 'www.chatgpt.com', 'openai.com', 'www.openai.com',
  'auth.openai.com', 'login.openai.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com'
]);
const POPUP_HOSTS = new Set([
  'auth.openai.com', 'login.openai.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com'
]);
const TRANSIENT_CHAT_LOAD_ERROR = /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|HTTP2_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING)/i;
const CHAT_NETWORK_DIAGNOSTIC_SESSIONS = new WeakSet();
const CHAT_RENDER_ERROR_MARKERS = [
  '出错了，无法显示此消息',
  'There was an error displaying this message',
  'Unable to display this message'
];
const CHAT_STREAM_RECOVERY_ERROR_MARKERS = [
  'ChatGPT stream recovery polling timed out'
];

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function isAllowedNavigation(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && parsed.protocol === 'https:' && NAVIGATION_HOSTS.has(parsed.hostname.toLowerCase()));
}

function isAuthPopup(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && parsed.protocol === 'https:' && POPUP_HOSTS.has(parsed.hostname.toLowerCase()));
}

function isChatGptNavigation(value) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'chatgpt.com' || host === 'www.chatgpt.com';
}

function isTransientChatLoadError(description) {
  return TRANSIENT_CHAT_LOAD_ERROR.test(String(description || ''));
}

function isChatConversationUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || !isChatGptNavigation(value)) return false;
  return /(^|\/)c\/[^/]+/i.test(parsed.pathname);
}

function isChatMessageRenderErrorText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return CHAT_RENDER_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function isChatStreamRecoveryTimeoutText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return CHAT_STREAM_RECOVERY_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function chromeLikeUserAgent(value) {
  return String(value || '')
    .replace(/\s(?:Electron|web-mcp-assistant)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function browserProxyConfig(settings = {}) {
  const mode = ['auto', 'system', 'manual', 'direct'].includes(settings.proxyMode) ? settings.proxyMode : 'auto';
  if (mode === 'direct') return { mode: 'direct' };
  if (mode === 'manual') {
    const proxyRules = normalizeProxyValue(settings.proxyUrl);
    return proxyRules
      ? { mode: 'fixed_servers', proxyRules, proxyBypassRules: '<local>' }
      : { mode: 'direct' };
  }
  return { mode: 'system' };
}

function proxyRouteKey(value) {
  const text = String(value || '').trim();
  if (!text || /^DIRECT$/i.test(text)) return 'direct';
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      return `${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    } catch { return text.toLowerCase(); }
  }
  const match = text.match(/(?:PROXY|HTTPS?|SOCKS5?)\s+([^;]+)/i);
  return match ? match[1].toLowerCase() : text.toLowerCase();
}

function bindChatNetworkDiagnostics(chatSession, log) {
  if (!chatSession || CHAT_NETWORK_DIAGNOSTIC_SESSIONS.has(chatSession)) return;
  CHAT_NETWORK_DIAGNOSTIC_SESSIONS.add(chatSession);
  const filter = { urls: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://*.openai.com/*'] };
  chatSession.webRequest.onErrorOccurred(filter, (details) => {
    const parsed = parseUrl(details.url);
    log.warn('ChatGPT 浏览器网络请求失败', {
      host: parsed?.hostname || '',
      resourceType: String(details.resourceType || ''),
      error: String(details.error || ''),
      fromCache: Boolean(details.fromCache)
    });
  });
}

class ChatViewController {
  constructor({ window, log, settings, toolbarHeight = 64, onState = () => {}, onDownload = () => {}, onConversationTurn = () => {} }) {
    this.window = window;
    this.log = log;
    this.toolbarHeight = toolbarHeight;
    this.onState = onState;
    this.settings = settings;
    this.onDownload = onDownload;
    this.onConversationTurn = onConversationTurn;
    this.view = null;
    this.loading = false;
    this.lastError = '';
    this.errorLayer = '';
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.nextRetryAt = 0;
    this.mcpAttachment = { status: 'unknown', event: 'init', detail: '', updatedAt: 0 };
    this.browserNetwork = { mode: '', browserRoute: '', tunnelRoute: '', aligned: null, source: '', updatedAt: 0 };
    this.streamState = { status: 'unknown', event: 'init', updatedAt: 0 };
    this.pendingPageLoadReason = '';
    this.boundResize = () => this.resize();
  }

  updateStreamState(payload = {}) {
    const next = {
      status: String(payload.status || this.streamState.status || 'unknown'),
      event: String(payload.event || 'page-stream'),
      updatedAt: Date.now()
    };
    const changed = next.status !== this.streamState.status || next.event !== this.streamState.event;
    this.streamState = next;
    if (changed) {
      this.log[next.status === 'interrupted' ? 'warn' : 'info']('ChatGPT 回答流状态变化', next);
      this.emitState();
    }
  }

  async refreshBrowserNetworkDiagnostics({ force = false } = {}) {
    const chatSession = session.fromPartition(CHAT_PARTITION);
    const current = this.settings.load();
    const [browserRoute, tunnelProxy] = await Promise.all([
      chatSession.resolveProxy(CHAT_HOME).catch(() => ''),
      resolveProxy(current, { force }).catch(() => ({ resolvedUrl: '', source: 'error', reachable: false }))
    ]);
    const tunnelRoute = String(tunnelProxy.resolvedUrl || 'DIRECT');
    const browserRouteText = String(browserRoute || 'DIRECT');
    const aligned = proxyRouteKey(browserRouteText) === proxyRouteKey(tunnelRoute);
    this.browserNetwork = {
      mode: String(current.proxyMode || 'auto'),
      browserRoute: browserRouteText.slice(0, 240),
      tunnelRoute: tunnelRoute.slice(0, 240),
      aligned,
      source: String(tunnelProxy.source || ''),
      updatedAt: Date.now()
    };
    this.log[aligned ? 'info' : 'warn']('ChatGPT 页面与 Tunnel 网络路径检查', this.browserNetwork);
    this.emitState();
    return { ...this.browserNetwork };
  }

  async applyBrowserProxyPolicy({ closeConnections = false, forceProbe = false } = {}) {
    const chatSession = session.fromPartition(CHAT_PARTITION);
    const current = this.settings.load();
    const config = browserProxyConfig(current);
    await chatSession.setProxy(config);
    if (closeConnections && typeof chatSession.closeAllConnections === 'function') await chatSession.closeAllConnections();
    this.refreshBrowserNetworkDiagnostics({ force: forceProbe }).catch(() => {});
    return config;
  }

  updateMcpAttachmentState(payload = {}) {
    const next = {
      status: String(payload.status || this.mcpAttachment.status || 'unknown'),
      event: String(payload.event || 'page-log'),
      detail: String(payload.detail || ''),
      updatedAt: Date.now()
    };
    const changed = next.status !== this.mcpAttachment.status
      || next.event !== this.mcpAttachment.event
      || next.detail !== this.mcpAttachment.detail;
    this.mcpAttachment = next;
    if (changed) this.emitState();
  }

  clearRetryState({ resetAttempt = true } = {}) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = 0;
    if (resetAttempt) this.retryAttempt = 0;
  }

  scheduleTransientRetry(url, description) {
    if (!isTransientChatLoadError(description) || !isAllowedNavigation(url) || this.retryTimer) return false;
    if (isChatConversationUrl(url)) {
      this.log.warn('当前 ChatGPT 对话发生瞬时网络错误，保留对话上下文并交由页面自身恢复，不自动重载', {
        url,
        description
      });
      return false;
    }
    const delay = Math.min(30000, 1500 * (2 ** Math.min(this.retryAttempt, 5)));
    this.retryAttempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = 0;
      const contents = this.view?.webContents;
      if (!contents || contents.isDestroyed()) return;
      this.pendingPageLoadReason = 'transient-retry-non-conversation';
      contents.loadURL(url).catch((error) => {
        this.lastError = error.message;
        this.errorLayer = 'chat-page';
        this.emitState();
      });
    }, delay);
    this.retryTimer.unref?.();
    this.log.warn('ChatGPT 页面网络加载中断，将按退避策略重试页面；不会重启本地 MCP', {
      url, description, attempt: this.retryAttempt, delayMs: delay
    });
    return true;
  }

  mount() {
    if (this.view || !this.window || this.window.isDestroyed()) return;
    const chatSession = session.fromPartition(CHAT_PARTITION);
    const currentUserAgent = chatSession.getUserAgent();
    const browserUserAgent = chromeLikeUserAgent(currentUserAgent);
    if (browserUserAgent && browserUserAgent !== currentUserAgent) chatSession.setUserAgent(browserUserAgent);
    bindChatNetworkDiagnostics(chatSession, this.log);
    const browserNetworkReady = this.applyBrowserProxyPolicy().catch((error) => {
      this.log.warn('ChatGPT 浏览器代理策略应用失败，将继续使用 Chromium 当前网络配置', { error: String(error?.message || error) });
    });
    new DownloadService({ electronSession: chatSession, settings: this.settings, log: this.log, onState: this.onDownload }).bind();
    const mayWriteClipboard = (permission, origin) => permission === 'clipboard-sanitized-write' && isAllowedNavigation(origin);
    chatSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(mayWriteClipboard(permission, details.requestingUrl || details.securityOrigin || ''));
    });
    chatSession.setPermissionCheckHandler((_webContents, permission, origin) => mayWriteClipboard(permission, origin));

    this.view = new WebContentsView({
      webPreferences: {
        partition: CHAT_PARTITION,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    this.view.webContents.setBackgroundThrottling(false);
    if (browserUserAgent) this.view.webContents.setUserAgent(browserUserAgent);
    this.view.setBackgroundColor('#f7f7f8');
    this.window.contentView.addChildView(this.view);
    this.window.on('resize', this.boundResize);
    this.resize();
    this.bindWebContents();
    browserNetworkReady.finally(() => this.loadHome());
  }

  bindWebContents() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (isAuthPopup(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560,
            height: 760,
            parent: this.window,
            modal: false,
            maximizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            webPreferences: {
              partition: CHAT_PARTITION,
              backgroundThrottling: false,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true
            }
          }
        };
      }
      if (isAllowedNavigation(url) && parseUrl(url)?.hostname.toLowerCase().endsWith('chatgpt.com')) {
        this.openUrl(url);
      } else if (/^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', (popup) => this.bindAuthPopup(popup));
    contents.on('will-navigate', (event, url) => {
      if (isAllowedNavigation(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    });
    contents.on('did-start-loading', () => {
      const reason = this.pendingPageLoadReason || 'page-or-browser-navigation';
      this.pendingPageLoadReason = '';
      this.log.info('ChatGPT 页面开始加载', { host: parseUrl(contents.getURL())?.hostname || '', reason });
      this.loading = true;
      this.lastError = '';
      this.errorLayer = '';
      this.emitState();
    });
    contents.on('did-finish-load', () => {
      this.clearRetryState();
      this.lastError = '';
      this.errorLayer = '';
      if (this.streamState.status === 'render_error') this.updateStreamState({ status: 'healthy', event: 'page-message-render-recovered' });
      this.emitState();
    });
    contents.on('dom-ready', () => {
      this.scheduleChatUiEnhancements();
    });
    contents.on('did-stop-loading', () => {
      this.loading = false;
      this.emitState();
      this.scheduleChatUiEnhancements();
    });
    contents.on('did-navigate', () => {
      this.emitState();
    });
    contents.on('did-navigate-in-page', () => {
      this.emitState();
      this.suspendChatUiEnhancements();
      setTimeout(() => this.scheduleChatUiEnhancements(), 1200);
    });
    contents.on('console-message', (_event, level, message) => {
      const memoryPrefix = '[web-mcp-memory] ';
      const raw = String(message || '');
      if (raw.startsWith(memoryPrefix)) {
        contents.executeJavaScript(`(() => { const payload = window.__mcpAutoMemoryQueue || null; window.__mcpAutoMemoryQueue = null; return payload; })()`, true).then((payload) => {
          if (!payload || typeof payload !== 'object') return;
          return this.onConversationTurn({ userText: String(payload.user_text || '').slice(0,6000), assistantText: String(payload.assistant_text || '').slice(0,8000), conversationId: String(payload.conversation_id || '').slice(0,160), turnId: String(payload.turn_id || '').slice(0,160) });
        }).catch(() => {});
        return;
      }
      const streamPrefix = '[web-mcp-stream] ';
      if (raw.startsWith(streamPrefix)) {
        let payload = {};
        try { payload = JSON.parse(raw.slice(streamPrefix.length)); } catch { payload = { event: 'page-stream' }; }
        this.updateStreamState({ event: payload.event, status: payload.status });
        return;
      }
      const prefix = '[web-mcp-continuous] ';
      if (!raw.startsWith(prefix)) return;
      let payload = {};
      try { payload = JSON.parse(raw.slice(prefix.length)); } catch { payload = { event: 'page-log' }; }
      const meta = {
        event: String(payload.event || 'unknown'),
        detail: String(payload.detail || ''),
        status: String(payload.status || '')
      };
      this.updateMcpAttachmentState(meta);
      if (Number(level) >= 2 || meta.event === 'attach-failed') this.log.warn('连续 MCP 页面事件', meta);
      else this.log.info('连续 MCP 页面事件', meta);
    });
    contents.on('page-title-updated', () => this.emitState());
    contents.on('unresponsive', () => {
      this.lastError = 'ChatGPT 页面暂时无响应';
      this.errorLayer = 'chat-renderer';
      this.log.warn(this.lastError, { host: parseUrl(contents.getURL())?.hostname || '' });
      this.emitState();
    });
    contents.on('responsive', () => {
      if (this.errorLayer === 'chat-renderer' && this.lastError === 'ChatGPT 页面暂时无响应') {
        this.lastError = '';
        this.errorLayer = '';
      }
      this.log.info('ChatGPT 页面已恢复响应');
      this.emitState();
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.loading = false;
      this.lastError = `${errorDescription} (${errorCode})`;
      this.errorLayer = 'chat-page';
      this.log.warn('ChatGPT 页面加载失败', { url: validatedURL, errorCode, errorDescription });
      this.scheduleTransientRetry(validatedURL, errorDescription);
      this.emitState();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loading = false;
      this.lastError = `页面进程已退出：${details.reason}`;
      this.errorLayer = 'chat-renderer';
      this.log.error(this.lastError, { exitCode: details.exitCode });
      this.emitState();
    });
  }

  bindAuthPopup(popup) {
    const popupContents = popup?.webContents;
    if (!popupContents || popupContents.isDestroyed()) return;
    let completed = false;
    const finishInMainView = (url) => {
      if (completed || !isChatGptNavigation(url)) return false;
      completed = true;
      this.openUrl(url).catch((error) => {
        this.lastError = error.message;
        this.emitState();
      }).finally(() => {
        if (!popup.isDestroyed()) popup.close();
      });
      return true;
    };
    popup.setMenuBarVisibility(false);
    popup.setMaximizable(false);
    popup.setFullScreenable(false);
    popupContents.setWindowOpenHandler(({ url }) => {
      if (finishInMainView(url)) return { action: 'deny' };
      if (/^https?:/i.test(url) && !isAllowedNavigation(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    popupContents.on('will-navigate', (event, url) => {
      if (finishInMainView(url)) {
        event.preventDefault();
        return;
      }
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      }
    });
    popupContents.on('did-navigate', (_event, url) => finishInMainView(url));
    popupContents.on('did-navigate-in-page', (_event, url) => finishInMainView(url));
  }

  suspendChatUiEnhancements() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      if (window.__mcpCompactToolObserver) { try { window.__mcpCompactToolObserver.disconnect(); } catch {} window.__mcpCompactToolObserver = null; }
      if (window.__mcpCompactToolTimer) { clearTimeout(window.__mcpCompactToolTimer); window.__mcpCompactToolTimer = 0; }
      document.querySelectorAll('[data-mcp-tool-summary="1"]').forEach((node) => node.remove());
      document.querySelectorAll('.mcp-tool-call-hidden').forEach((node) => node.classList.remove('mcp-tool-call-hidden'));
      document.querySelectorAll('.mcp-tool-call-row').forEach((node) => node.classList.remove('mcp-tool-call-row'));
      document.querySelectorAll('[data-mcp-tools-expanded]').forEach((node) => delete node.dataset.mcpToolsExpanded);
      document.getElementById('mcp-chat-compact-tools-style')?.remove();
      if (window.__mcpAutoMemoryObserver) { try { window.__mcpAutoMemoryObserver.disconnect(); } catch {} window.__mcpAutoMemoryObserver = null; }
      if (window.__mcpAutoMemoryTimer) { clearTimeout(window.__mcpAutoMemoryTimer); window.__mcpAutoMemoryTimer = 0; }
      if (window.__mcpStreamObserver) { try { window.__mcpStreamObserver.disconnect(); } catch {} window.__mcpStreamObserver = null; }
      if (window.__mcpStreamTimer) { clearTimeout(window.__mcpStreamTimer); window.__mcpStreamTimer = 0; }
      window.__mcpRenderErrorSince = 0;
      window.__mcpRenderErrorSafe = false;
      return true;
    })()`, true).catch(() => false);
  }

  scheduleChatUiEnhancements() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    this.scheduleToolCallCompaction();
    this.scheduleMemoryObserver();
    this.scheduleStreamObserver();
    this.scheduleContinuousMcpMode();
  }

  scheduleToolCallCompaction() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const enabled = this.settings.load().compactToolCalls !== false;
    contents.executeJavaScript(`(() => {
      const ENABLED = ${JSON.stringify(enabled)};
      const STYLE_ID = 'mcp-chat-compact-tools-style';
      const cleanup = () => {
        if (window.__mcpCompactToolObserver) { try { window.__mcpCompactToolObserver.disconnect(); } catch {} window.__mcpCompactToolObserver = null; }
        if (window.__mcpCompactToolTimer) { clearTimeout(window.__mcpCompactToolTimer); window.__mcpCompactToolTimer = 0; }
        document.querySelectorAll('[data-mcp-tool-summary="1"]').forEach((node) => node.remove());
        document.querySelectorAll('.mcp-tool-call-hidden').forEach((node) => node.classList.remove('mcp-tool-call-hidden'));
        document.querySelectorAll('.mcp-tool-call-row').forEach((node) => node.classList.remove('mcp-tool-call-row'));
        document.querySelectorAll('[data-mcp-tools-expanded]').forEach((node) => delete node.dataset.mcpToolsExpanded);
        if (!ENABLED) document.getElementById(STYLE_ID)?.remove();
      };
      cleanup();
      if (!ENABLED) return false;
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.mcp-tool-call-row{margin-top:2px!important;margin-bottom:2px!important;min-height:0!important;}',
          '.mcp-tool-call-hidden{display:none!important;}',
          '.mcp-tool-call-summary{display:inline-flex!important;align-items:center!important;gap:7px!important;margin:7px 0 5px!important;padding:6px 10px!important;border:1px solid rgba(0,0,0,.09)!important;border-radius:10px!important;background:rgba(0,0,0,.035)!important;color:inherit!important;font:inherit!important;font-size:12px!important;line-height:1.2!important;cursor:pointer!important;}',
          '.dark .mcp-tool-call-summary{border-color:rgba(255,255,255,.12)!important;background:rgba(255,255,255,.055)!important;}',
          '.mcp-tool-call-summary:hover{background:rgba(0,0,0,.065)!important;}',
          '.dark .mcp-tool-call-summary:hover{background:rgba(255,255,255,.09)!important;}'
        ].join('');
        document.head.appendChild(style);
      }
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isToolLabel = (value) => {
        const text = normalize(value).toLowerCase();
        return text.includes('已调用工具') || text.includes('已使用工具') ||
          text.includes('called tool') || text.includes('used tool') || text.includes('tool called');
      };
      const findRow = (button, host) => {
        const existing = button.closest('.mcp-tool-call-row');
        if (existing && host.contains(existing)) return existing;
        let node = button;
        for (let depth = 0; depth < 4; depth += 1) {
          const parent = node.parentElement;
          if (!parent || parent === host || parent.querySelector('[data-mcp-tool-summary="1"]')) break;
          const text = normalize(parent.innerText || parent.textContent);
          const controls = parent.querySelectorAll('button,[role="button"]').length;
          if (text.length <= 140 && controls <= 3) node = parent;
          else break;
        }
        return node;
      };
      const compactHost = (host) => {
        if (!host) return;
        const buttons = Array.from(host.querySelectorAll('button,[role="button"]')).filter((button) =>
          button.dataset.mcpToolSummary !== '1' && isToolLabel(button.innerText || button.textContent)
        );
        const rows = [];
        const seen = new Set();
        for (const button of buttons) {
          const row = findRow(button, host);
          if (!row || seen.has(row)) continue;
          seen.add(row);
          row.classList.add('mcp-tool-call-row');
          rows.push(row);
        }
        let summary = host.querySelector('[data-mcp-tool-summary="1"]');
        if (!rows.length) {
          summary?.remove();
          delete host.dataset.mcpToolsExpanded;
          return;
        }
        if (!summary) {
          summary = document.createElement('button');
          summary.type = 'button';
          summary.dataset.mcpToolSummary = '1';
          summary.className = 'mcp-tool-call-summary';
          summary.addEventListener('click', () => {
            host.dataset.mcpToolsExpanded = host.dataset.mcpToolsExpanded === '1' ? '0' : '1';
            refresh();
          });
          rows[0].parentElement?.insertBefore(summary, rows[0]);
        }
        const expanded = host.dataset.mcpToolsExpanded === '1';
        summary.textContent = expanded ? ('工具 × ' + rows.length + ' · 收起') : ('工具 × ' + rows.length);
        summary.title = expanded ? '收起工具调用记录' : '展开查看全部工具调用记录';
        rows.forEach((row) => row.classList.toggle('mcp-tool-call-hidden', !expanded));
      };
      const refresh = () => {
        const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
        if (turns.length) turns.forEach(compactHost);
        else document.querySelectorAll('[data-message-author-role="assistant"]').forEach(compactHost);
      };
      const target = document.querySelector('main') || document.body;
      const schedule = (delay = 900) => {
        if (window.__mcpCompactToolTimer) clearTimeout(window.__mcpCompactToolTimer);
        window.__mcpCompactToolTimer = setTimeout(() => {
          window.__mcpCompactToolTimer = 0;
          refresh();
        }, delay);
      };
      window.__mcpCompactToolObserver = new MutationObserver(() => schedule(900));
      if (target) window.__mcpCompactToolObserver.observe(target, { childList: true, subtree: true });
      schedule(250);
      return true;
    })()`, true).catch(() => false);
  }

  scheduleMemoryObserver() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      const PREFIX='[web-mcp-memory] ', SEEN_KEY='__webMcpAutoMemorySeenV1';
      const normalize=(v)=>String(v||'').replace(/\\s+/g,' ').trim();
      const digest=(value)=>{let hash=2166136261,text=String(value||'');for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return(hash>>>0).toString(16).padStart(8,'0');};
      const conversationId=()=>{const m=location.pathname.match(/(?:^|\\/)c\\/([^/?#]+)/i);return m?m[1]:'';};
      const clean=(node,limit)=>{if(!node)return'';const clone=node.cloneNode(true);clone.querySelectorAll('button,[role="button"],pre,code,svg,nav,[data-testid*="tool"]').forEach((item)=>item.remove());return normalize(clone.textContent).slice(0,limit);};
      const loadSeen=()=>{try{return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY)||'[]'));}catch{return new Set();}};
      const saveSeen=(seen)=>{try{sessionStorage.setItem(SEEN_KEY,JSON.stringify([...seen].slice(-160)));}catch{}};
      const scan=()=>{window.__mcpAutoMemoryTimer=0;if(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop"]'))return;const turns=Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));let lastUser=null;const pairs=[];for(const turn of turns){const u=turn.querySelector('[data-message-author-role="user"]'),a=turn.querySelector('[data-message-author-role="assistant"]');if(u)lastUser={text:clean(u,6000),id:String(turn.dataset.testid||'')};if(a&&lastUser){const assistant=clean(a,8000);if(lastUser.text&&assistant)pairs.push({user:lastUser.text,assistant,turnId:String(turn.dataset.testid||lastUser.id||'')});}}const pair=pairs[pairs.length-1];if(!pair)return;const id=conversationId(),stableKey=digest(id+'\\n'+pair.user+'\\n'+pair.assistant),seen=loadSeen(),dedupeKey=id+':'+stableKey;if(seen.has(dedupeKey))return;if(window.__mcpAutoMemoryStableKey!==stableKey){window.__mcpAutoMemoryStableKey=stableKey;window.__mcpAutoMemoryTimer=setTimeout(scan,1400);return;}seen.add(dedupeKey);saveSeen(seen);try{window.__mcpAutoMemoryQueue={conversation_id:id,turn_id:pair.turnId,user_text:pair.user,assistant_text:pair.assistant};console.info(PREFIX+'ready');}catch{}};
      const schedule=(delay=1800)=>{if(window.__mcpAutoMemoryTimer)clearTimeout(window.__mcpAutoMemoryTimer);window.__mcpAutoMemoryTimer=setTimeout(scan,delay);};const target=document.querySelector('main')||document.body;if(!window.__mcpAutoMemoryObserver){window.__mcpAutoMemoryObserver=new MutationObserver(()=>schedule(1800));if(target)window.__mcpAutoMemoryObserver.observe(target,{childList:true,subtree:true,characterData:true});}schedule(1200);return true;
    })()`, true).catch(()=>false);
  }

  scheduleStreamObserver() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
      const PREFIX='[web-mcp-stream] ';
      const RENDER_ERROR_MARKERS=${JSON.stringify(CHAT_RENDER_ERROR_MARKERS)};
      const STREAM_RECOVERY_ERROR_MARKERS=${JSON.stringify(CHAT_STREAM_RECOVERY_ERROR_MARKERS)};
      const normalize=(v)=>String(v||'').replace(/\\s+/g,' ').trim();
      const interrupted=(text)=>{
        const value=normalize(text);
        return (value.includes('连接已中断') && value.includes('正在等待完整回复'))
          || /Connection interrupted/i.test(value)
          || /Waiting for (?:the )?complete response/i.test(value);
      };
      const recoveryTimedOut=(text)=>{
        const value=normalize(text).toLowerCase();
        return STREAM_RECOVERY_ERROR_MARKERS.some((marker)=>value.includes(String(marker).toLowerCase()));
      };
      const visible=(node)=>{if(!node)return false;const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0;};
      const renderError=()=>Array.from(document.querySelectorAll('main [role="alert"],main [aria-live="assertive"],main [data-testid*="error" i],main [class*="error" i]')).some((node)=>{if(!visible(node))return false;const value=normalize(node.innerText||node.textContent||'').toLowerCase();return RENDER_ERROR_MARKERS.some((marker)=>value.includes(String(marker).toLowerCase()));});
      const report=(status,event,extra={})=>{try{console.info(PREFIX+JSON.stringify({status,event,...extra}));}catch{}};
      const scan=()=>{
        window.__mcpStreamTimer=0;
        const host=document.querySelector('main')||document.body;
        const text=host?.innerText||host?.textContent||'';
        if(renderError()){
          const changed=window.__mcpStreamStatus!=='render_error';
          window.__mcpStreamStatus='render_error';
          if(changed)report('render_error','page-message-render-error');
          return;
        }
        const generating=Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop"],button[aria-label*="Stop generating"],button[aria-label*="停止生成"]'));
        const recoveryTimeout=recoveryTimedOut(text);
        const next=(recoveryTimeout||interrupted(text))?'interrupted':generating?'generating':'healthy';
        if(window.__mcpStreamStatus===next)return;
        const previous=window.__mcpStreamStatus;
        window.__mcpStreamStatus=next;
        if(next==='interrupted')report(next,recoveryTimeout?'page-stream-recovery-timeout':'page-stream-interrupted');
        else if(next==='generating')report(next,'page-response-generating');
        else if(previous==='interrupted')report(next,'page-stream-recovered');
        else if(previous==='render_error')report(next,'page-message-render-recovered');
        else if(previous==='generating')report(next,'page-response-finished');
      };
      const schedule=(delay=500)=>{if(window.__mcpStreamTimer)clearTimeout(window.__mcpStreamTimer);window.__mcpStreamTimer=setTimeout(scan,delay);};
      const target=document.querySelector('main')||document.body;
      if(!window.__mcpStreamObserver){window.__mcpStreamObserver=new MutationObserver(()=>schedule(650));if(target)window.__mcpStreamObserver.observe(target,{childList:true,subtree:true,characterData:true});}
      schedule(250);
      return true;
    })()`, true).catch(()=>false);
  }

  scheduleContinuousMcpMode() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const enabled = this.settings.load().continuousMcpMode !== false;
    contents.executeJavaScript(`(() => {
      const ENABLED = ${JSON.stringify(enabled)};
      const APP_NAME = 'Coding Tools MCP';
      const STATE_KEY = '__webMcpContinuousConversations';
      const CAPABILITY_KEY = '__webMcpCapabilitySeen';
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const report = (event, detail = '', status = '') => {
        try { console.info('[web-mcp-continuous] ' + JSON.stringify({ event, detail, status })); } catch {}
      };
      const visible = (node) => {
        if (!(node instanceof Element)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const conversationId = () => {
        const match = location.pathname.match(/(?:^|\\/)c\\/([^/?#]+)/i);
        return match ? match[1] : '';
      };
      const loadArmed = () => {
        try { return new Set(JSON.parse(sessionStorage.getItem(STATE_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const saveArmed = (set) => {
        try { sessionStorage.setItem(STATE_KEY, JSON.stringify([...set].slice(-100))); } catch {}
      };
      const capabilitySeen = () => {
        try { return sessionStorage.getItem(CAPABILITY_KEY) === '1'; } catch { return false; }
      };
      const rememberCapability = (reason = '') => {
        try { sessionStorage.setItem(CAPABILITY_KEY, '1'); } catch {}
        report('capability-seen', reason, 'available');
      };
      const editor = () => document.querySelector('#prompt-textarea,[data-testid="composer-input"] textarea,textarea[data-id="root"],form [contenteditable="true"]');
      const sendButton = () => document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="发送提示"],button[aria-label="发送消息"],button[aria-label="发送"]');
      const composerRoot = () => editor()?.closest('form') || editor()?.parentElement?.parentElement || document.querySelector('main form');
      const hasHistoricalMcpUse = () => {
        const userNodes = [...document.querySelectorAll('[data-message-author-role="user"]')];
        return userNodes.some((node) => normalize((node.closest('[data-testid^="conversation-turn-"]') || node).innerText || node.textContent).includes(APP_NAME));
      };
      const armConversation = (reason = '') => {
        const id = conversationId();
        if (!id) return false;
        const armed = loadArmed();
        if (!armed.has(id)) {
          armed.add(id);
          saveArmed(armed);
          report('conversation-armed', reason || id.slice(-8), 'available');
        }
        return true;
      };
      const armFromHistory = () => {
        const id = conversationId();
        if (!id || !hasHistoricalMcpUse()) return false;
        rememberCapability('history');
        return armConversation(id.slice(-8));
      };
      const isArmed = () => {
        const id = conversationId();
        if (!id) return false;
        return loadArmed().has(id) || armFromHistory() || capabilitySeen();
      };
      const composerHasMcp = () => {
        const root = composerRoot();
        const input = editor();
        if (!root || !input) return false;
        const inputToken = [...input.querySelectorAll?.('[contenteditable="false"],[data-mention],[data-testid*="mention" i],button,[role="button"]') || []]
          .some((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
        if (inputToken) return true;
        return [...root.querySelectorAll('button,[role="button"],[data-testid],span')]
          .some((node) => node !== input && !input.contains(node) && visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
      };
      const toast = (message) => {
        document.getElementById('__webMcpContinuousToast')?.remove();
        const node = document.createElement('div');
        node.id = '__webMcpContinuousToast';
        node.textContent = message;
        Object.assign(node.style, {
          position: 'fixed', left: '50%', bottom: '92px', transform: 'translateX(-50%)', zIndex: '2147483647',
          maxWidth: '620px', padding: '10px 14px', borderRadius: '10px', color: '#fff', background: 'rgba(25,25,25,.94)',
          fontSize: '13px', lineHeight: '1.45', boxShadow: '0 8px 30px rgba(0,0,0,.22)'
        });
        document.body.appendChild(node);
        setTimeout(() => node.remove(), 4200);
      };
      const findMcpOption = () => {
        const direct = [...document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')]
          .find((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
        if (direct) return direct;
        const overlays = [...document.querySelectorAll('[role="listbox"],[role="menu"],[data-radix-popper-content-wrapper],[data-headlessui-portal]')].filter(visible);
        for (const overlay of overlays) {
          const match = [...overlay.querySelectorAll('button,[data-testid],[role="button"]')]
            .find((node) => visible(node) && normalize(node.innerText || node.textContent).includes(APP_NAME));
          if (match) return match;
        }
        return null;
      };
      const waitForOption = async (timeoutMs = 1800) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const option = findMcpOption();
          if (option) {
            rememberCapability('catalog');
            return option;
          }
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return null;
      };
      const waitForAttached = async (timeoutMs = 1400) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (composerHasMcp()) return true;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return false;
      };
      const snapshotEditor = (input) => ({
        html: input.isContentEditable ? input.innerHTML : '',
        value: 'value' in input ? String(input.value || '') : '',
        text: normalize(input.innerText || input.value || input.textContent)
      });
      const insertMentionTrigger = (input) => {
        input.focus();
        const selection = getSelection();
        if (selection && input.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } else if ('selectionStart' in input) {
          input.selectionStart = input.selectionEnd = String(input.value || '').length;
        }
        document.execCommand('insertText', false, ' @' + APP_NAME);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' @' + APP_NAME }));
      };
      const restoreEditor = (input, snapshot) => {
        input.focus();
        try { document.execCommand('undo'); } catch {}
        const current = normalize(input.innerText || input.value || input.textContent);
        if (current !== snapshot.text) {
          if (input.isContentEditable) input.innerHTML = snapshot.html;
          else if ('value' in input) input.value = snapshot.value;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'historyUndo' }));
      };
      const attachAndSend = async () => {
        if (window.__webMcpContinuousBusy) return;
        window.__webMcpContinuousBusy = true;
        const input = editor();
        let inserted = false;
        const snapshot = input ? snapshotEditor(input) : null;
        try {
          if (!input) throw new Error('未找到 ChatGPT 输入框');
          if (!composerHasMcp()) {
            insertMentionTrigger(input);
            inserted = true;
            const option = await waitForOption();
            if (!option) {
              report('catalog-missing', '当前消息没有 Coding Tools MCP 选择项', 'unavailable');
              throw new Error('没有找到 Coding Tools MCP 选择项');
            }
            option.click();
            if (!(await waitForAttached())) throw new Error('Coding Tools MCP 未成功附加到本条消息');
            inserted = false;
          }
          rememberCapability('attached');
          armConversation('attached');
          const button = sendButton();
          if (!button) throw new Error('未找到发送按钮');
          window.__webMcpContinuousBypass = true;
          report('attach-success', conversationId().slice(-8), 'attached');
          button.click();
        } catch (error) {
          if (inserted && input && snapshot) restoreEditor(input, snapshot);
          const detail = String(error?.message || error);
          report('attach-failed', detail, detail.includes('没有找到 Coding Tools MCP') ? 'unavailable' : 'error');
          const fallbackButton = sendButton();
          if (fallbackButton) {
            window.__webMcpContinuousBypass = true;
            report('attach-fallback-send', detail, 'unavailable');
            toast('连续 MCP 自动附加失败，本条消息已按 ChatGPT 原生方式继续发送；不会要求手动 @Coding Tools MCP。');
            fallbackButton.click();
          } else {
            toast('连续 MCP 自动附加失败，且未找到发送按钮；请再次发送。');
          }
        } finally {
          setTimeout(() => { window.__webMcpContinuousBusy = false; window.__webMcpContinuousBypass = false; }, 0);
        }
      };
      // v0.3.1 hotfix: never intercept ChatGPT's native send path. The DOM
      // attachment flow is too brittle across ChatGPT composer revisions and a
      // missing MCP catalog entry must never make a user message unsendable.
      const shouldIntercept = () => false;
      const clickHandler = (event) => {
        if (window.__webMcpContinuousBypass) return;
        const button = event.target?.closest?.('button');
        if (!button || button !== sendButton() || !shouldIntercept()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        attachAndSend();
      };
      const keyHandler = (event) => {
        if (window.__webMcpContinuousBypass || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        const input = editor();
        if (!input || !(event.target === input || input.contains?.(event.target)) || !shouldIntercept()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        attachAndSend();
      };
      if (window.__webMcpContinuousHandlers) {
        document.removeEventListener('click', window.__webMcpContinuousHandlers.click, true);
        document.removeEventListener('keydown', window.__webMcpContinuousHandlers.keydown, true);
        try { window.__webMcpContinuousHandlers.observer?.disconnect(); } catch {}
        window.__webMcpContinuousHandlers = null;
      }
      if (!ENABLED) {
        report('disabled', '', 'disabled');
        return false;
      }
      const syncPageCapability = () => {
        armFromHistory();
        if (composerHasMcp()) {
          rememberCapability('composer');
          armConversation('composer');
          report('composer-attached', conversationId().slice(-8), 'attached');
        }
        const text = normalize(document.querySelector('main')?.innerText || '');
        if (/does not support developer mcps/i.test(text)) {
          report('developer-mcp-unsupported', 'ChatGPT 当前对话不支持 Developer MCP', 'unavailable');
        }
      };
      const observer = new MutationObserver(() => syncPageCapability());
      observer.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
      window.__webMcpContinuousHandlers = { observer };
      report('native-send-mode', capabilitySeen() ? 'session-capability-seen' : 'waiting-first-attachment', capabilitySeen() ? 'available' : 'unknown');
      syncPageCapability();
      return true;
    })()`, true).catch((error) => {
      this.log.warn('连续 MCP 模式注入失败', { message: error.message });
    });
  }

  resize() {
    if (!this.view || !this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({
      x: 0,
      y: this.toolbarHeight,
      width: Math.max(0, width),
      height: Math.max(0, height - this.toolbarHeight)
    });
  }

  emitState() {
    this.onState(this.getState());
  }

  getState() {
    const contents = this.view?.webContents;
    return {
      loading: this.loading,
      error: this.lastError,
      errorLayer: this.errorLayer,
      retryAttempt: this.retryAttempt,
      nextRetryAt: this.nextRetryAt,
      url: contents && !contents.isDestroyed() ? contents.getURL() : '',
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      canGoBack: Boolean(contents && !contents.isDestroyed() && contents.canGoBack()),
      canGoForward: Boolean(contents && !contents.isDestroyed() && contents.canGoForward()),
      mcpAttachment: { ...this.mcpAttachment },
      browserNetwork: { ...this.browserNetwork },
      streamState: { ...this.streamState }
    };
  }

  async openUrl(url) {
    if (!isAllowedNavigation(url)) throw new Error('不允许在内联窗口打开该地址。');
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    if (contents.getURL() === url) return true;

    const target = parseUrl(url);
    const current = parseUrl(contents.getURL());
    if (target && current && target.origin === current.origin) {
      const targetPath = `${target.pathname}${target.search}${target.hash}`;
      try {
        const clicked = await contents.executeJavaScript(`(() => {
          const wanted = ${JSON.stringify(targetPath)};
          const link = Array.from(document.querySelectorAll('a[href]')).find((item) => {
            try { const parsed = new URL(item.href, location.href); return parsed.pathname + parsed.search + parsed.hash === wanted; }
            catch { return false; }
          });
          if (!link) return false;
          link.click();
          return true;
        })()`, true);
        if (clicked) return true;
      } catch { /* fall through */ }
    }

    contents.stop();
    this.pendingPageLoadReason = 'open-url';
    contents.loadURL(url).catch((error) => {
      this.lastError = error.message;
      this.emitState();
    });
    return true;
  }

  async loadHome() {
    return this.openUrl(CHAT_HOME);
  }

  async navigate(action) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    if (action === 'back' && contents.canGoBack()) contents.goBack();
    else if (action === 'forward' && contents.canGoForward()) contents.goForward();
    else if (action === 'reload') {
      this.clearRetryState();
      this.pendingPageLoadReason = 'user-navigation-reload';
      this.log.info('ChatGPT 页面重载', { host: parseUrl(contents.getURL())?.hostname || '', reason: this.pendingPageLoadReason });
      if (typeof contents.reloadIgnoringCache === 'function') contents.reloadIgnoringCache();
      else contents.reload();
    }
    else if (action === 'home') await this.loadHome();
    else throw new Error('不支持的导航操作。');
    this.emitState();
    return true;
  }

  async clearSession() {
    const chatSession = session.fromPartition(CHAT_PARTITION);
    await chatSession.clearStorageData();
    await chatSession.clearCache();
    this.clearRetryState();
    this.lastError = '';
    this.errorLayer = '';
    await this.loadHome();
  }

  dispose() {
    this.clearRetryState();
    if (this.window && !this.window.isDestroyed()) this.window.removeListener('resize', this.boundResize);
    if (this.view && this.window && !this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view); } catch { /* already detached */ }
    }
    if (this.view?.webContents && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
    this.view = null;
  }
}

module.exports = {
  ChatViewController,
  CHAT_HOME,
  CHAT_PARTITION,
  chromeLikeUserAgent,
  browserProxyConfig,
  proxyRouteKey,
  isAllowedNavigation,
  isAuthPopup,
  isChatGptNavigation,
  isTransientChatLoadError,
  isChatConversationUrl,
  isChatMessageRenderErrorText,
  isChatStreamRecoveryTimeoutText
};
