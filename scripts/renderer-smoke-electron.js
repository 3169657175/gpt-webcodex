const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'build', 'ui-smoke');
const demoWorkspace = 'C:\\smoke\\workspace';
let currentTheme = 'light';
const smokeWindows = [];

function ok(data) { return { ok: true, data }; }

function snapshot() {
  return {
    appVersion: '0.9.2-smoke',
    settings: {
      theme: currentTheme,
      workspace: demoWorkspace,
      tunnelId: 'tunnel_smoke_renderer',
      mcpPort: 18765,
      healthPort: 18081,
      proxyMode: 'auto',
      proxyUrl: '',
      startWithWindows: false,
      autoStartServices: false,
      keepRunningOnClose: true,
      taskNotifications: true,
      taskNotificationSound: false
    },
    secrets: { runtimeApiKey: true },
    environment: { proxy: { reachable: true, resolvedUrl: 'direct' } },
    status: {
      runtimeRunning: true,
      tunnelRunning: true,
      connectionRunning: true,
      localMcpUrl: 'http://127.0.0.1:18765/mcp',
      schemaIdentity: { version: '0.9.2-smoke', schemaVersion: 14, schemaHash: 'smoke', toolCount: 10 },
      tunnelDiagnostics: { tunnelName: 'smoke-renderer', mainChannelReady: true, mainChannelProbe: 'ok' }
    },
    chat: { mcpAttachment: { status: 'attached', detail: 'smoke renderer' } }
  };
}

function taskRuntime() {
  const now = new Date().toISOString();
  return {
    state: {
      task_id: 'smoke_task',
      run_id: 'smoke_run',
      status: 'waiting',
      lifecycle_state: 'waiting_model',
      objective: 'Renderer smoke',
      current_step: '等待模型',
      updated_at: now,
      last_heartbeat_at: now
    },
    operations: [],
    activity: { latest: [] },
    runtime_layers: {
      connection: { state: 'connected', transport: 'mcp' },
      execution: { state: 'waiting', lifecycle: 'waiting_model', status: 'waiting' },
      model: { state: 'waiting', wait_reason: 'model' },
      process: { state: 'idle' },
      recovery: { state: 'healthy', attempt: 0 },
      user: { state: 'waiting_model', stalled: false, suspected_stall: false, quiet: false, heartbeat_age_seconds: 0 },
      workspace: { state: 'ready', path: demoWorkspace }
    }
  };
}

function workspaceHub() {
  return {
    activeWorkspace: demoWorkspace,
    workspaces: [{ path: demoWorkspace, name: 'workspace', active: true, status: 'ready' }],
    recentWorkspaces: [demoWorkspace],
    authorizedRoots: [demoWorkspace],
    invalidCount: 0
  };
}

function installHandlers() {
  const handlers = {
    'app:snapshot': () => ok(snapshot()),
    'workspace:hub': () => ok(workspaceHub()),
    'task-state:read': () => ok({ state: taskRuntime().state }),
    'mcp:task-runtime': () => ok(taskRuntime()),
    'mcp:task-worktrees': () => ok({ worktrees: [] }),
    'logs:read': () => ok([])
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, handler);
  }
}

async function waitForRenderer(win, theme) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`(() => ({
      booting: document.body.classList.contains('booting'),
      theme: document.body.dataset.theme || '',
      themeMode: document.body.dataset.themeMode || '',
      title: document.querySelector('#overallTitle')?.textContent || '',
      slots: Array.from(document.querySelectorAll('[data-react-slot]')).map((node) => ({ key: node.getAttribute('data-react-slot'), text: node.textContent.trim() })),
      width: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }
    }))()`);
    const mounted = state.slots.length === 4 && state.slots.every((slot) => slot.text.length > 0);
    if (!state.booting && mounted) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Renderer smoke timed out for ${theme}`);
}

async function capturePageStable(win, theme) {
  try {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (!image.isEmpty()) return image;
    throw new Error(`Empty capture for ${theme}`);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (!/UnknownVizError|surface|empty capture/i.test(message)) throw error;

    const previousBounds = win.getBounds();
    win.setBounds({ x: -10000, y: -10000, width: previousBounds.width, height: previousBounds.height }, false);
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const image = await win.capturePage();
      if (image.isEmpty()) throw new Error(`Renderer screenshot remained empty for ${theme}`);
      return image;
    } finally {
      win.hide();
      win.setBounds(previousBounds, false);
    }
  }
}

async function runTheme(theme) {
  currentTheme = theme;
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    backgroundColor: theme === 'dark' ? '#111214' : '#ffffff',
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  smokeWindows.push(win);

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) errors.push({ type: 'console', level, message, line, sourceId });
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => errors.push({ type: 'preload', preloadPath, message: error?.stack || error?.message || String(error) }));
  win.webContents.on('render-process-gone', (_event, details) => errors.push({ type: 'render-process-gone', details }));
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) errors.push({ type: 'did-fail-load', code, description, validatedURL });
  });

  await win.loadFile(path.join(root, 'renderer', 'index.html'), { query: { theme } });
  const state = await waitForRenderer(win, theme);
  const image = await capturePageStable(win, theme);
  const pngPath = path.join(outDir, `${theme}.png`);
  fs.writeFileSync(pngPath, image.toPNG());

  const fatalErrors = errors.filter((item) => {
    const text = JSON.stringify(item);
    return item.type !== 'console' || /ReferenceError|TypeError|Uncaught|process is not defined|Failed to load/i.test(text);
  });
  if (state.theme !== theme) throw new Error(`Expected ${theme} theme, got ${state.theme || 'empty'}`);
  if (state.width.scroll > state.width.client + 2) throw new Error(`Horizontal overflow in ${theme}: ${state.width.scroll} > ${state.width.client}`);
  if (fatalErrors.length) throw new Error(`Renderer errors in ${theme}: ${JSON.stringify(fatalErrors)}`);

  return { theme, state, errors, screenshot: path.relative(root, pngPath).replaceAll('\\', '/') };
}

function destroySmokeWindows() {
  for (const win of smokeWindows.splice(0)) {
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  installHandlers();
  const results = [];
  try {
    results.push(await runTheme('light'));
    results.push(await runTheme('dark'));
    const report = { ok: true, generatedAt: new Date().toISOString(), results };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
    console.log(`Renderer smoke PASS: ${results.map((item) => item.theme).join(', ')}`);
    destroySmokeWindows();
    process.exitCode = 0;
    app.quit();
  } catch (error) {
    const report = { ok: false, generatedAt: new Date().toISOString(), error: error?.stack || error?.message || String(error), results };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
    console.error(report.error);
    destroySmokeWindows();
    process.exitCode = 1;
    app.quit();
  }
});
