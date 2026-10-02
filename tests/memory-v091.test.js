const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('0.9.1 conflict candidates compare existing and new content in Chinese',()=>{const app=read('renderer/app.js'),css=read('renderer/manager-v2.css');assert.match(app,/已有内容/);assert.match(app,/新内容/);assert.match(app,/采用新内容/);assert.match(app,/两条都保留/);assert.match(css,/memory-conflict-grid/);});
