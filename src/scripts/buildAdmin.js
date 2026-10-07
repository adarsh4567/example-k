require('dotenv').config();
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const outputDir = path.join(projectRoot, 'admin-dist');
const configuredApiBase = String(
  process.env.ADMIN_API_BASE_URL || 'https://kaaryo-api-37hi.onrender.com'
).trim();
const parsedApiBase = new URL(configuredApiBase);
const isLocal = parsedApiBase.protocol === 'http:' && parsedApiBase.hostname === 'localhost';
if (parsedApiBase.protocol !== 'https:' && !isLocal) {
  throw new Error('ADMIN_API_BASE_URL must be HTTPS, except localhost during development');
}
if (parsedApiBase.pathname !== '/' || parsedApiBase.search || parsedApiBase.hash) {
  throw new Error('ADMIN_API_BASE_URL must be an origin without a path, query, or fragment');
}
const apiBase = parsedApiBase.origin;

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'admin.html'), path.join(outputDir, 'index.html'));
fs.writeFileSync(
  path.join(outputDir, 'config.js'),
  `window.KAARYO_CONFIG = Object.freeze(${JSON.stringify({ API_BASE_URL: apiBase })});\n`,
  { mode: 0o644 }
);
console.log(`Admin build ready for ${apiBase}`);
