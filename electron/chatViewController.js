const { shell, session, WebContentsView } = require('electron');
const { DownloadService } = require('./services/downloadService');

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

class ChatViewController {
  constructor({ window, log, settings, toolbarHeight = 64, onState = () => {}, onDownload = () => {} }) {
    this.window = window;
    this.log = log;
    this.toolbarHeight = toolbarHeight;
    this.onState = onState;
    this.settings = settings;
    this.onDownload = onDownload;
    this.view = null;
    this.loading = false;
    this.lastError = '';
    this.errorLayer = '';
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.nextRetryAt = 0;
    this.boundResize = () => this.resize();
  }

  clearRetryState({ resetAttempt = true } = {}) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = 0;
    if (resetAttempt) this.retryAttempt = 0;
  }

  scheduleTransientRetry(url, description) {
    if (!isTransientChatLoadError(description) || !isAllowedNavigation(url) || this.retryTimer) return false;
    const delay = Math.min(30000, 1500 * (2 ** Math.min(this.retryAttempt, 5)));
    this.retryAttempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = 0;
      const contents = this.view?.webContents;
      if (!contents || contents.isDestroyed()) return;
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
    new DownloadService({ electronSession: chatSession, settings: this.settings, log: this.log, onState: this.onDownload }).bind();
    const mayWriteClipboard = (permission, origin) => permission === 'clipboard-sanitized-write' && isAllowedNavigation(origin);
    chatSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(mayWriteClipboard(permission, details.requestingUrl || details.securityOrigin || ''));
    });
    chatSession.setPermissionCheckHandler((_webContents, permission, origin) => mayWriteClipboard(permission, origin));

    this.view = new WebContentsView({
      webPreferences: {
        partition: CHAT_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    this.view.setBackgroundColor('#f7f7f8');
    this.window.contentView.addChildView(this.view);
    this.window.on('resize', this.boundResize);
    this.resize();
    this.bindWebContents();
    this.loadHome();
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
      this.loading = true;
      this.lastError = '';
      this.errorLayer = '';
      this.emitState();
    });
    contents.on('did-finish-load', () => {
      this.clearRetryState();
      this.lastError = '';
      this.errorLayer = '';
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
    contents.on('page-title-updated', () => this.emitState());
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
      if (window.__mcpCompactToolObserver) {
        try { window.__mcpCompactToolObserver.disconnect(); } catch {}
        window.__mcpCompactToolObserver = null;
      }
      if (window.__mcpCompactToolTimer) {
        clearTimeout(window.__mcpCompactToolTimer);
        window.__mcpCompactToolTimer = 0;
      }
      document.querySelectorAll('[data-mcp-tool-summary="1"]').forEach((node) => node.remove());
      document.querySelectorAll('.mcp-tool-call-hidden').forEach((node) => node.classList.remove('mcp-tool-call-hidden'));
      document.querySelectorAll('.mcp-tool-call-row').forEach((node) => node.classList.remove('mcp-tool-call-row'));
      document.querySelectorAll('[data-mcp-tools-expanded]').forEach((node) => delete node.dataset.mcpToolsExpanded);
      return true;
    })()`, true).catch(() => false);
  }

  scheduleChatUiEnhancements() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    [700, 2400].forEach((delay) => setTimeout(() => {
      if (contents.isDestroyed()) return;
      contents.executeJavaScript(`(() => {
        const STYLE_ID = 'mcp-chat-compact-tools-style';
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = [
            '.mcp-tool-call-row{margin-top:2px!important;margin-bottom:2px!important;min-height:0!important;}',
            '.mcp-tool-call-hidden{display:none!important;}',
            '.mcp-tool-turn-hidden{display:none!important;}',
            '.mcp-tool-call-summary{display:inline-flex!important;align-items:center!important;gap:7px!important;margin:7px 0 5px!important;padding:6px 10px!important;border:1px solid rgba(0,0,0,.09)!important;border-radius:10px!important;background:rgba(0,0,0,.035)!important;color:inherit!important;font:inherit!important;font-size:12px!important;line-height:1.2!important;cursor:pointer!important;}',
            '.mcp-tool-cluster-toggle{display:inline-flex!important;align-items:center!important;margin-left:7px!important;padding:3px 7px!important;border:0!important;border-radius:7px!important;background:rgba(0,0,0,.045)!important;color:inherit!important;font:inherit!important;font-size:11px!important;line-height:1.2!important;cursor:pointer!important;}',
            '.dark .mcp-tool-call-summary{border-color:rgba(255,255,255,.12)!important;background:rgba(255,255,255,.055)!important;}',
            '.mcp-tool-call-summary:hover{background:rgba(0,0,0,.065)!important;}',
            '.dark .mcp-tool-call-summary:hover{background:rgba(255,255,255,.09)!important;}'
          ].join('');
          document.head.appendChild(style);
        }

        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isToolLabel = (value) => {
          const text = normalize(value).toLowerCase();
          return text.includes('已调用工具') || text.includes('called tool') ||
            text.includes('used tool') || text.includes('tool called');
        };
        const findRow = (button, host) => {
          const existing = button.closest('.mcp-tool-call-row');
          if (existing && host.contains(existing)) return existing;
          let node = button;
          for (let depth = 0; depth < 4; depth += 1) {
            const parent = node.parentElement;
            if (!parent || parent === host) break;
            if (parent.querySelector('[data-mcp-tool-summary="1"]')) break;
            const text = normalize(parent.innerText || parent.textContent);
            const controls = parent.querySelectorAll('button,[role="button"]').length;
            if (text.length <= 100 && controls <= 2) node = parent;
            else break;
          }
          return node;
        };

        const compactHost = (host) => {
            if (!host) return;
            const buttons = Array.from(host.querySelectorAll('button,[role="button"]')).filter((button) => {
              if (button.dataset.mcpToolSummary === '1') return false;
              return isToolLabel(button.innerText || button.textContent);
            });
            const rows = [];
            const seen = new Set();
            for (const button of buttons) {
              const row = findRow(button, host);
              if (!row || seen.has(row)) continue;
              seen.add(row);
              row.classList.add('mcp-tool-call-row');
              rows.push(row);
            }

            let summary = host.querySelector(':scope > [data-mcp-tool-summary="1"], [data-mcp-tool-summary="1"]');
            if (rows.length < 1) {
              if (summary) summary.remove();
              rows.forEach((row) => row.classList.remove('mcp-tool-call-hidden'));
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
            const label = expanded ? ('▾ 工具 × ' + rows.length + ' · 收起') : ('▸ 工具 × ' + rows.length);
            const title = expanded ? '收起工具调用记录' : '展开查看全部工具调用记录';
            if (summary.textContent !== label) summary.textContent = label;
            if (summary.title !== title) summary.title = title;
            rows.forEach((row) => row.classList.toggle('mcp-tool-call-hidden', !expanded));
        };

        const refresh = () => {
          const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
          if (turns.length) {
            turns.forEach(compactHost);
            return;
          }
          document.querySelectorAll('[data-message-author-role="assistant"]').forEach(compactHost);
        };

        const target = document.querySelector('main') || document.body;
        const scheduleStableRefresh = (delayMs = 1800) => {
          if (window.__mcpCompactToolTimer) clearTimeout(window.__mcpCompactToolTimer);
          window.__mcpCompactToolTimer = setTimeout(() => {
            const observer = window.__mcpCompactToolObserver;
            try { observer?.disconnect(); } catch {}
            try { refresh(); } finally {
              if (observer && target?.isConnected) {
                observer.observe(target, { childList: true, subtree: true });
              }
            }
          }, delayMs);
        };
        window.__mcpCompactSchedule = scheduleStableRefresh;
        if (!window.__mcpCompactToolObserver) {
          window.__mcpCompactToolObserver = new MutationObserver(() => scheduleStableRefresh(1800));
          if (target) window.__mcpCompactToolObserver.observe(target, { childList: true, subtree: true });
        }
        scheduleStableRefresh(1800);
        return true;
      })()`, true).catch(() => false);
    }, delay));
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
      canGoForward: Boolean(contents && !contents.isDestroyed() && contents.canGoForward())
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
    else if (action === 'reload') contents.reload();
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

module.exports = { ChatViewController, CHAT_HOME, CHAT_PARTITION, isAllowedNavigation, isAuthPopup, isChatGptNavigation, isTransientChatLoadError };
