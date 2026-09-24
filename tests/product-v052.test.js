const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.5.6 exposes four business entries without restoring old control-console pages', () => {
  const html = read('renderer/index.html');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.5.6');
  for (const page of ['status', 'workspace', 'memory', 'settings']) {
    assert.match(html, new RegExp('data-page="' + page + '"'));
  }
  for (const page of ['task', 'build', 'guide', 'overview', 'support', 'diagnostics']) {
    assert.doesNotMatch(html, new RegExp('data-page="' + page + '"'));
  }
  assert.doesNotMatch(html, /data-tool-permission|操作权限策略|agentModeSelect|toolModeSelect|contextPressureStatus/);
});

test('Workspace Center restores full authorized-root lifecycle', () => {
  const html = read('renderer/workspace.html');
  const js = read('renderer/workspace.js');
  const preload = read('electron/workspacePreload.js');
  const manager = read('electron/services/workspaceManager.js');
  const main = read('electron/main.js');

  assert.match(html, /id="authorizedRootList"/);
  assert.match(html, /id="authorizeRootInline"/);
  assert.match(html, /id="clearAuthorizedRoots"/);
  assert.match(js, /renderAuthorizedRoots/);
  assert.match(js, /取消授权/);
  assert.match(js, /updateAuthorizedRoots\(nextRoots\)/);
  assert.match(js, /updateAuthorizedRoots\(\[\]\)/);
  assert.match(preload, /updateAuthorizedRoots/);
  assert.match(manager, /authorizedRootDetails/);
  assert.match(manager, /invalidAuthorizedRootCount/);
  assert.match(main, /workspace:authorized-roots/);
  assert.match(main, /broadcastWorkspaceHub\(\)/);
});

test('Workspace Center uses compact tabbed views instead of one long vertical page', () => {
  const html = read('renderer/workspace.html');
  const js = read('renderer/workspace.js');
  const css = read('renderer/workspace.css');
  const main = read('electron/main.js');

  assert.match(html, /class="view-tabs"/);
  assert.match(html, /data-workspace-tab="workspaces"/);
  assert.match(html, /data-workspace-tab="authorized"/);
  assert.match(html, /data-workspace-view="authorized" hidden/);
  assert.match(js, /switchWorkspaceView\('workspaces'/);
  assert.match(js, /switchWorkspaceView\('authorized'/);
  assert.doesNotMatch(js, /\$\('#authorizeRoot'\)/);
  assert.match(css, /grid-template-rows:auto auto minmax\(0,1fr\) 32px/);
  assert.match(css, /\.workspace-view\[hidden\]\{display:none!important\}/);
  assert.match(main, /const width = 820;/);
  assert.match(main, /const height = 620;/);
});

test('startup progress uses actual orchestrator stages and not a fake percentage bar', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  const preload = read('electron/preload.js');
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');

  assert.match(orchestrator, /progress\('config-check'/);
  assert.match(orchestrator, /progress\('config-ready'/);
  assert.match(orchestrator, /progress\('preflight'/);
  assert.match(orchestrator, /progress\('mcp-health'/);
  assert.match(orchestrator, /progress\('complete'/);
  assert.match(preload, /onProgress/);
  assert.match(html, /id="startupStageList"/);
  assert.match(app, /handleProgress/);
  assert.match(app, /progressStageMap/);
  assert.doesNotMatch(html, /startupProgressBar|启动百分比|progress="\d+"/);
});

test('configuration guide derives completion from real settings and service state', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');

  assert.match(html, /id="guideBackdrop"/);
  assert.match(html, /id="guideList"/);
  assert.match(html, /配置教程/);
  assert.match(app, /function guideSteps\(\)/);
  assert.match(app, /snapshot\.secrets\?\.runtimeApiKey/);
  assert.match(app, /settings\.tunnelId/);
  assert.match(app, /proxy\.reachable/);
  assert.match(app, /status\.runtimeRunning/);
  assert.match(app, /mcpAttachment/);
  assert.doesNotMatch(html, /guideProgress|接入完成度|type="checkbox"[^>]*guide/);
});

test('status center restores useful task detail but keeps internal IDs folded', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const preload = read('electron/preload.js');

  assert.match(html, /id="taskPanel"/);
  assert.match(html, /id="taskObjective"/);
  assert.match(html, /id="taskCurrentStep"/);
  assert.match(html, /id="taskElapsed"/);
  assert.match(html, /id="taskActivity"/);
  assert.match(html, /id="taskCommandRow"/);
  assert.match(html, /id="taskFailureRow"/);
  assert.match(html, /<details class="tech-details">/);
  assert.match(preload, /taskRuntime/);
  assert.match(app, /refreshTaskRuntime/);
  assert.doesNotMatch(html, /data-page-view="task"|历史与性能|后台 Operation/);
});

test('worktree recovery is hidden by default and only appears when unresolved', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const preload = read('electron/preload.js');

  assert.match(html, /id="worktreePanel" hidden/);
  assert.match(html, /id="worktreeViewDiff"/);
  assert.match(html, /id="worktreeApply"/);
  assert.match(html, /id="worktreeDiscard"/);
  assert.match(app, /function unresolvedWorktree\(\)/);
  assert.match(app, /viewWorktreeDiff/);
  assert.match(app, /applyWorktree/);
  assert.match(app, /discardWorktree/);
  assert.match(preload, /taskWorktreeDiff/);
  assert.match(preload, /applyTaskWorktree/);
  assert.match(preload, /discardTaskWorktree/);
  assert.doesNotMatch(html, /data-page-view="worktree"|Git 隔离与后台运行/);
});

test('0.5.2 keeps 0.5.1 on-demand dangerous approval instead of restoring approval inbox', () => {
  const manager = read('renderer/index.html');
  const approval = read('renderer/approval.html');
  const browser = read('renderer/browser.js');

  assert.doesNotMatch(manager, /待本地确认|approvalList|审批收件箱/);
  assert.match(approval, /需要你的确认/);
  assert.match(browser, /refreshApprovals/);
});
