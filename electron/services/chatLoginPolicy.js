const AUTH_HOSTS = new Set([
  'auth.openai.com', 'auth0.openai.com', 'login.openai.com', 'accounts.openai.com',
  'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'idmsa.apple.com'
]);

function chatUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(u.hostname) ? u : null; }
  catch { return null; }
}

function authUrl(value) {
  try {
    const u = new URL(value);
    return Boolean(u.protocol === 'https:' && (AUTH_HOSTS.has(u.hostname)
      || chatUrl(value) && /^\/(?:auth(?:\/|$)|login(?:\/|$)|api\/auth(?:\/|$))/.test(u.pathname)));
  } catch { return false; }
}

// Only account evidence, never the session/token itself, leaves the page/native fetch.
function authenticatedSession(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user) || !Object.keys(data.user).length) return false;
  if (data.error !== undefined && data.error !== null && data.error !== '') return false;
  return data.expires === undefined || data.expires === null
    || typeof data.expires === 'string' && Number.isFinite(Date.parse(data.expires)) && Date.parse(data.expires) > now;
}

async function readAuthenticatedSession(fetchSession, timeoutMs = 6000) {
  try {
    const response = await fetchSession('https://chatgpt.com/api/auth/session', {
      credentials: 'include', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
    return authenticatedSession(await response.json());
  } catch { return false; }
}

// Inspect visible controls and login errors only. Never read password/input values or chat text.
function inspectLoginDocument() {
  const host = location.hostname;
  const isChat = ['chatgpt.com', 'www.chatgpt.com'].includes(host);
  const isProvider = ['auth.openai.com', 'auth0.openai.com', 'login.openai.com', 'accounts.openai.com',
    'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'idmsa.apple.com'].includes(host);
  if (location.protocol !== 'https:' || !isChat && !isProvider) return { kind: '', composer: false };
  const visible = (node) => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return node.isConnected && style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  if (host === 'accounts.google.com') {
    const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]')).filter(visible).map((node) => node.textContent).join(' ');
    const notice = String(document.body?.innerText || '').slice(0, 4000);
    if (/无法登录|couldn.t sign you in|could not sign you in/i.test(headings)
      && /此浏览器或应用可能不安全|this browser or app may not be secure|disallowed_useragent/i.test(notice)) {
      return { kind: 'blocked', composer: false };
    }
  }
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
  const labels = controls.map((node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim());
  const providerButton = labels.some((label) => /^(?:continue with google|sign in with google|使用\s*google\s*(?:账号)?(?:继续|登录)|通过\s*google\s*登录|继续使用\s*google)$/i.test(label));
  const entryPage = isProvider || isChat && (location.pathname === '/' || /^\/(?:auth|login)(?:\/|$)/.test(location.pathname));
  const signIn = labels.some((label) => /^(?:log in|sign in|登录|登入|登录\s*chatgpt)$/i.test(label));
  const composer = isChat && !/^\/(?:auth|login|api\/auth)(?:\/|$)/.test(location.pathname)
    && Array.from(document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"]')).some(visible);
  return { kind: entryPage && (providerButton || signIn) ? 'entry' : '', composer };
}

const LOGIN_DOCUMENT_PROBE = `(${inspectLoginDocument.toString()})()`;
module.exports = { AUTH_HOSTS, authUrl, chatUrl, authenticatedSession, readAuthenticatedSession, inspectLoginDocument, LOGIN_DOCUMENT_PROBE };
