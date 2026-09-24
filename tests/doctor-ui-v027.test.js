const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Diagnostics page combines health doctor support report and logs', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const preload = read('electron/preload.js');
  assert.match(html, /data-page-view="settings"/);
  assert.match(html, /设置与诊断/);
  assert.match(html, /id="runDiagnostics"/);
  assert.match(html, /id="repairHealth"/);
  assert.match(html, /id="exportSupportReport"/);
  assert.match(html, /id="logOutput"/);
  assert.match(app, /doctorInspect/);
  assert.match(app, /inspectHealth/);
  assert.match(preload, /doctorInspect/);
  assert.match(preload, /exportSupportReport/);
});
