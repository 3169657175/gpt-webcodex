const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('workspace quick actions and show item IPC are configured', () => {
  const main = read('electron/main.js');
  const preload = read('electron/browserPreload.js');

  // Verify IPC channels
  assert.match(main, /secureHandle\('workspace:open-in-explorer'/);
  assert.match(main, /secureHandle\('workspace:open-in-editor'/);
  assert.match(main, /secureHandle\('workspace:show-in-folder'/);

  // Verify Preload exposure
  assert.match(preload, /openWorkspaceInExplorer/);
  assert.match(preload, /openWorkspaceInEditor/);
  assert.match(preload, /showInFolder/);
});

test('task modified files tree and completion audio are wired into the browser UI', () => {
  const html = read('renderer/browser.html');
  const css = read('renderer/browser.css');
  const js = read('renderer/browser.js');

  // Verify HTML elements
  assert.match(html, /id="openInExplorerBtn"/);
  assert.match(html, /id="openInEditorBtn"/);
  assert.match(html, /id="taskChangesBtn"/);
  assert.match(html, /id="consoleTabLogs"/);
  assert.match(html, /id="consoleTabFiles"/);
  assert.match(html, /id="consoleFilesList"/);

  // Verify CSS styles
  assert.match(css, /\.workspace-quick-tools/);
  assert.match(css, /\.console-tabs/);
  assert.match(css, /\.console-files-view/);
  assert.match(css, /\.browser-toolbar\{[^}]*height:112px/);

  // Verify JS logic
  assert.match(js, /playTaskCompletionSound/);
  assert.match(js, /renderModifiedFilesList/);
  assert.match(js, /switchConsoleTab/);
});

test('git diff, commit assistant and task context snapshot handoff are wired end to end', () => {
  const main = read('electron/main.js');
  const preload = read('electron/browserPreload.js');
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  const css = read('renderer/browser.css');

  // Verify IPC in main.js
  assert.match(main, /secureHandle\('git:file-diff'/);
  assert.match(main, /secureHandle\('git:commit-and-push'/);
  assert.match(main, /secureHandle\('task:generate-snapshot'/);
  assert.match(main, /secureHandle\('chat:inject-prompt'/);

  // Verify Preload
  assert.match(preload, /gitFileDiff/);
  assert.match(preload, /gitCommitAndPush/);
  assert.match(preload, /generateTaskSnapshot/);
  assert.match(preload, /injectPrompt/);

  // Verify HTML elements
  assert.match(html, /id="continueContextUsage"/);
  assert.match(html, /id="consoleDiffColumn"/);
  assert.match(html, /id="diffViewContent"/);
  assert.match(html, /id="gitCommitInput"/);
  assert.match(html, /id="gitCommitBtn"/);
  assert.match(html, /id="gitCommitPushBtn"/);

  // Verify JS handlers
  assert.match(js, /showFileDiff/);
  assert.match(js, /handleGitCommit/);
  assert.match(js, /#continueContextUsage/);

  // Verify CSS styles
  assert.match(css, /\.btn-continue/);
  assert.match(css, /\.console-git-commit-bar/);
  assert.match(css, /\.diff-line-add/);
  assert.match(css, /\.diff-line-del/);
  assert.match(css, /\.browser-toolbar\{[^}]*height:112px/);
});

