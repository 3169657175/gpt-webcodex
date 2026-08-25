const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('conversation export feature is fully removed while tool folding remains', () => {
  const files = [
    'electron/main.js',
    'electron/preload.js',
    'electron/browserPreload.js',
    'electron/services/config.js',
    'renderer/browser.html',
    'renderer/browser.js',
    'renderer/browser.css',
    'renderer/index.html',
    'renderer/app.js'
  ];
  const combined = files.map(read).join('\n');
  assert.doesNotMatch(combined, /conversation-export|exportConversationButton|conversationExportDir|chooseConversationExport|导出对话/);
  assert.equal(fs.existsSync(path.join(root, 'electron/services/conversationExportService.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'electron/services/conversationPageExtractor.js')), false);

  const chat = read('electron/chatViewController.js');
  assert.doesNotMatch(chat, /conversationPageExtractor|extractConversation/);
  assert.match(chat, /compactHost/);
  assert.match(chat, /mcp-tool-call-summary/);
  assert.match(chat, /mcp-tool-call-hidden/);
  assert.match(chat, /mcp-tool-turn-hidden/);
});
