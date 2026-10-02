const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(file)=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('0.9.1 activity detail hides meaningless telemetry and waiting-model noise',()=>{
  const detail=read('renderer/activity-detail.js'),html=read('renderer/activity-detail.html'),browser=read('renderer/browser.js');
  assert.match(detail,/String\(raw\)\.trim\(\) === '—'/);
  assert.match(detail,/outputSection.*hidden = !output/s);
  assert.match(detail,/timelineSection.*hidden = !timeline\.children\.length/s);
  assert.match(html,/id="outputSection" hidden/);
  assert.match(html,/id="timelineSection" hidden/);
  assert.match(browser,/function meaningfulTimeline/);
  assert.match(browser,/showHeartbeat/);
  assert.match(browser,/formatActivityAge/);
  assert.doesNotMatch(browser,/尚无命令输出。/);
});

test('0.9.1 manager version comes from Electron app version',()=>{
  const main=read('electron/main.js'),app=read('renderer/app.js'),html=read('renderer/index.html');
  assert.match(main,/appVersion: app\.getVersion\(\)/);
  assert.match(app,/#aboutVersion/);
  assert.match(app,/#brandVersion/);
  assert.doesNotMatch(html,/<h3>网页 MCP 助手 <span>v0\.8\.3<\/span>/);
});
