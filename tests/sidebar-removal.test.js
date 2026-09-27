const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('obsolete custom conversation sidebar is removed from the product code', () => {
  const combined = [
    read('renderer/browser.html'),
    read('renderer/browser.css'),
    read('renderer/browser.js'),
    read('electron/browserPreload.js'),
    read('electron/chatViewController.js'),
    read('electron/main.js'),
    read('electron/paths.js')
  ].join('\n');
  for (const obsolete of [
    'agentSidebar', 'agent-sidebar', 'railToggle', 'conversationIndex',
    'syncVisibleConversations', 'setConversationWorkspace', 'setLeftInset',
    'discoverVisibleConversations', 'collapseNativeSidebar', 'conversation:index-changed'
  ]) {
    assert.equal(combined.includes(obsolete), false, obsolete);
  }
  assert.equal(fs.existsSync(path.join(root, 'electron/services/conversationIndexStore.js')), false);
});

test('embedded ChatGPT view uses the full available width', () => {
  const controller = read('electron/chatViewController.js');
  assert.match(controller, /x:\s*0,/);
  assert.match(controller, /width:\s*Math\.max\(0, width\)/);
});

test('authentication popup returns completed ChatGPT login to the embedded view', () => {
  const controller = read('electron/chatViewController.js');
  assert.match(controller, /createWindow:.*createEmbeddedAuthView/);
  assert.match(controller, /webContents: options\.webContents/);
  assert.match(controller, /readAuthenticatedSession/);
  assert.match(controller, /primary\?\.composer/);
  assert.doesNotMatch(controller, /bindAuthPopup/);
});
