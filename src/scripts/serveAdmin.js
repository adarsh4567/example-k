const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'admin-dist');
const port = Number(process.env.ADMIN_PREVIEW_PORT) || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http.createServer((req, res) => {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Admin preview: http://127.0.0.1:${port}`);
});
