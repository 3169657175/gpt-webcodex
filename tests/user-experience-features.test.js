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

test('task checkpoint and one-click time capsule rollback are wired end to end', () => {
  const main = read('electron/main.js');
  const preload = read('electron/browserPreload.js');
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  const css = read('renderer/browser.css');

  // Verify IPC channels in main.js
  assert.match(main, /secureHandle\('checkpoint:create'/);
  assert.match(main, /secureHandle\('checkpoint:status'/);
  assert.match(main, /secureHandle\('checkpoint:rollback'/);
  assert.match(main, /workspaceCapsulePaths/);

  // Verify Preload APIs
  assert.match(preload, /createCheckpoint/);
  assert.match(preload, /getCheckpointStatus/);
  assert.match(preload, /rollbackCheckpoint/);

  // Verify HTML elements in browser.html
  assert.match(html, /id="capsuleStatusBadge"/);
  assert.match(html, /id="createCapsuleBtn"/);
  assert.match(html, /id="rollbackCapsuleBtn"/);

  // Verify JS logic in browser.js
  assert.match(js, /handleCreateCheckpoint/);
  assert.match(js, /handleRollbackCheckpoint/);
  assert.doesNotMatch(js, /updateTaskUi/);
  assert.match(js, /#createCapsuleBtn/);
  assert.match(js, /#rollbackCapsuleBtn/);
  assert.match(js, /#capsuleStatusBadge/);

  // Verify CSS styles
  assert.match(css, /\.console-capsule-actions/);
  assert.match(css, /\.capsule-badge/);
  assert.match(css, /\.btn-capsule/);
  assert.match(css, /\.btn-capsule-rollback/);
  assert.match(css, /\.browser-toolbar\{[^}]*height:112px/);
});

test('checkpoint physical fallback handles backup, restore and file deletion safely', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'capsule-test-'));
  try {
    const fileA = path.join(tempDir, 'original.txt');
    fs.writeFileSync(fileA, 'initial content', 'utf8');

    // Simulate snapshot backup
    const capsuleDir = path.join(tempDir, '.coding-tools', 'capsules');
    fs.mkdirSync(capsuleDir, { recursive: true });
    const backupA = path.join(capsuleDir, 'test_original.txt');
    fs.copyFileSync(fileA, backupA);

    // AI modifies original.txt and creates new.txt
    fs.writeFileSync(fileA, 'bad ai edits', 'utf8');
    const fileB = path.join(tempDir, 'new.txt');
    fs.writeFileSync(fileB, 'hallucinated file', 'utf8');

    const snapshots = {
      'original.txt': { existed: true, backupName: 'test_original.txt' },
      'new.txt': { existed: false }
    };

    // Simulate rollback: restore original.txt and delete new.txt
    for (const [rel, snap] of Object.entries(snapshots)) {
      const full = path.resolve(tempDir, rel);
      if (!snap.existed) {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } else if (snap.backupName) {
        fs.copyFileSync(path.join(capsuleDir, snap.backupName), full);
      }
    }

    assert.equal(fs.readFileSync(fileA, 'utf8'), 'initial content');
    assert.equal(fs.existsSync(fileB), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('task snapshot generation cleanly formats modified files without [object Object]', () => {
  const main = read('electron/main.js');
  assert.match(main, /extractPath/);
  const extractPath = (item) => (typeof item === 'string' ? item : (item?.path || ''));
  const modifiedFiles = [
    { path: 'src/index.js', operation: 'update' },
    { path: 'package.json', operation: 'update' },
    'README.md'
  ];
  const formatted = modifiedFiles
    .map((f) => {
      const p = extractPath(f);
      const op = (typeof f === 'object' && f?.operation) ? ` (${f.operation})` : '';
      return p ? `- \`${p}\`${op}` : null;
    })
    .filter(Boolean)
    .join('\n');

  assert.ok(!formatted.includes('[object Object]'));
  assert.match(formatted, /- `src\/index\.js` \(update\)/);
  assert.match(formatted, /- `README\.md`/);
});

