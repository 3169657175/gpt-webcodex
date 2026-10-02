const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const init = read('resources/coding-tools-mcp/coding_tools_mcp/__init__.py');
const pyproject = read('resources/coding-tools-mcp/pyproject.toml');
const index = read('renderer/index.html');
const app = read('renderer/app.js');
const main = read('electron/main.js');
const readme = read('README.md');
const contract = JSON.parse(read('resources/coding-tools-mcp/schema-contract.json'));
const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
const errors = [];
const version = pkg.version;
if (lock.packages?.['']?.version !== version) errors.push(`package-lock root version ${lock.packages?.['']?.version} != ${version}`);
if (!new RegExp(`__version__\\s*=\\s*[\"']${version.replaceAll('.', '\\.')}`).test(init)) errors.push('Runtime __version__ mismatch');
if (!new RegExp(`version\\s*=\\s*[\"']${version.replaceAll('.', '\\.')}`).test(pyproject)) errors.push('pyproject version mismatch');
if (!index.includes('id="aboutVersion"')) errors.push('manager dynamic version slot missing');
if (!/snapshot\.appVersion/.test(app) || !/aboutVersion\.textContent = appVersion/.test(app)) {
  errors.push('manager dynamic version binding missing');
}
if (!/appVersion: app\.getVersion\(\)/.test(main)) errors.push('main process appVersion binding missing');
if (!readme.includes(`**v${version}**`)) errors.push('README current version mismatch');
if (contract.runtime_version !== version) errors.push(`schema runtime_version ${contract.runtime_version} != ${version}`);
const schema = Number((server.match(/TOOL_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1] || 0);
if (Number(contract.schema_version) !== schema) errors.push(`schema contract v${contract.schema_version} != server v${schema}`);
const uiBundle = path.join(root, 'renderer', 'react-dist', 'manager-react.js');
if (!fs.existsSync(uiBundle) || fs.statSync(uiBundle).size < 1000) errors.push('React manager bundle missing; run npm run ui:build');
if (errors.length) {
  console.error('[release-readiness] FAIL');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`[release-readiness] PASS version=${version} schema=v${schema} tools=${contract.tool_count}`);
