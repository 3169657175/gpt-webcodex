const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('0.8.4 compact progress trigger opens a native owned Activity Detail window without resizing ChatGPT', () => {
  const html = read('renderer/browser.html');
  const js = read('renderer/browser.js');
  const preload = read('electron/browserPreload.js');
  const detailHtml = read('renderer/activity-detail.html');
  const main = read('electron/main.js');
  const controller = read('electron/chatViewController.js');
  assert.match(html, /id="progressBand"/);
  assert.match(html, /id="progressDetailTrigger"/);
  assert.doesNotMatch(html, /id="activityPanel"|aria-controls="activityPanel"/);
  assert.match(js, /activityDetailShow/);
  assert.match(js, /buildActivityDetailPayload/);
  assert.match(js, /commandRunning[\s\S]*?正在执行本地命令/);
  assert.match(js, /progressDetailTrigger\?\.addEventListener\('mouseenter'/);
  assert.doesNotMatch(js, /\$\('#progressBand'\)\?\.addEventListener\('mouseenter'/);
  assert.match(preload, /activityDetailShow|activityDetailUpdate|onActivityDetailState/);
  assert.match(main, /activityDetailWindow = new BrowserWindow\(\{[\s\S]*?parent: chatWindow && !chatWindow\.isDestroyed\(\) \? chatWindow : undefined/);
  assert.match(main, /loadFile\(path\.join\(__dirname, '\.\.', 'renderer', 'activity-detail\.html'\)\)/);
  assert.doesNotMatch(main, /activity-detail:[\s\S]{0,600}toolbarHeight\s*=|activity-detail:[\s\S]{0,600}chatController\.resize/);
  assert.match(controller, /y: this\.toolbarHeight/);
  assert.match(detailHtml, /id="facts"/);
  assert.match(detailHtml, /id="diagnosis"/);
  assert.match(detailHtml, /id="timeline"/);
  assert.match(js, /api\.onTaskEvent/);
  assert.match(js, /setInterval\(refreshTask, 30000\)/);
});

test('0.8.2 runtime settles elapsed time and terminal workflow state cleanly', () => {
  const state = read('resources/coding-tools-mcp/coding_tools_mcp/task_state.py');
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  const processes = read('resources/coding-tools-mcp/coding_tools_mcp/processes.py');
  assert.match(state, /state\["current_step"\] = ""/);
  assert.match(state, /_duration_ms_between/);
  assert.match(processes, /"elapsed_ms": elapsed_ms/);
  assert.match(server, /set_stage\("finalize", "Finalizing result"\)/);
});
