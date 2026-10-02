const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'build', 'ui-smoke');
const reportPath = path.join(outDir, 'result.json');

if (!fs.existsSync(reportPath)) throw new Error('Renderer smoke result.json is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (report.ok !== true) throw new Error(`Renderer smoke report failed: ${report.error || 'unknown error'}`);

const themes = new Set((report.results || []).map((item) => item.theme));
for (const theme of ['light', 'dark']) {
  if (!themes.has(theme)) throw new Error(`Renderer smoke missing ${theme} result`);
  const png = path.join(outDir, `${theme}.png`);
  if (!fs.existsSync(png) || fs.statSync(png).size < 1024) throw new Error(`Renderer smoke missing valid ${theme}.png`);
}

console.log('Renderer smoke assertion PASS: light + dark');
