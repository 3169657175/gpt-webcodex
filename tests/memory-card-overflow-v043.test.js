const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('0.5.1 memory cards constrain arbitrary long text inside the card width', () => {
  const css = read('renderer/manager-v2.css');
  const app = read('renderer/app.js');
  assert.match(css, /\.memory-card\{[^}]*min-width:0/);
  assert.match(css, /\.memory-content\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /word-break:break-word/);
  assert.match(app, /body\.textContent/);
  assert.match(app, /title\.textContent/);
});
