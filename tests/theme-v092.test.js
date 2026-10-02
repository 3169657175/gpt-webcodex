const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const config = fs.readFileSync('electron/services/config.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/manager-v2.css', 'utf8');
const bootstrap = fs.readFileSync('renderer/theme-bootstrap.js', 'utf8');

test('0.9.2 supports light dark and system themes end to end', () => {
  assert.match(config, /\['light', 'dark', 'system'\]/);
  assert.match(main, /\['light', 'dark', 'system'\]\.includes\(settings\.load\(\)\.theme\)/);
  assert.match(html, /value="system">跟随系统/);
  assert.match(app, /prefers-color-scheme: dark/);
  assert.match(bootstrap, /prefers-color-scheme: dark/);
});

test('0.9.2 uses teal semantic visual tokens and readable text', () => {
  assert.match(css, /--color-primary:var\(--m-accent\)/);
  assert.match(css, /--m-accent:#0b8f72/);
  assert.match(css, /font-size:13px/);
  assert.match(css, /font-size:12px/);
});
