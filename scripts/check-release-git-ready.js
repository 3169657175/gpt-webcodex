const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const status = git('status', '--porcelain');
if (status) {
  console.error('[release-git-ready] FAIL: working tree is not clean');
  console.error(status);
  process.exit(1);
}
const tag = `v${pkg.version}`;
let tagged = '';
try { tagged = git('rev-list', '-n', '1', tag); } catch {}
const head = git('rev-parse', 'HEAD');
if (!tagged || tagged !== head) {
  console.error(`[release-git-ready] FAIL: ${tag} does not point at HEAD`);
  process.exit(1);
}
let sync = 'no-upstream';
try {
  const counts = git('rev-list', '--left-right', '--count', '@{upstream}...HEAD').split(/\s+/).map(Number);
  sync = `behind=${counts[0] || 0} ahead=${counts[1] || 0}`;
} catch {}
console.log(`[release-git-ready] PASS ${tag} ${head.slice(0, 10)} ${sync}`);
