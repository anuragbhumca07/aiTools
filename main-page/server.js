const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

http.createServer((req, res) => {
  const url      = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, url);
  const ext      = path.extname(filePath);
  const mime     = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n🏠  AI Tools Hub  →  http://localhost:${PORT}\n`);
});
