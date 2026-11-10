import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'output/playwright/g1');
const port = Number(process.argv[3] || 8787);
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1:' + port);
  let filename;
  if (url.pathname === '/') filename = 'review.html';
  else if (url.pathname === '/sources.json') filename = 'sources.json';
  else if (url.pathname === '/figma-package.json') filename = 'figma-package.json';
  else if (url.pathname === '/favicon.ico') {res.writeHead(204).end();return;}
  else if (/^\/media\/[1-9]\d*\.(jpg|png|webp)$/.test(url.pathname)) filename = url.pathname.slice(1);
  else { res.writeHead(404).end(); return; }
  try {
    const data = await fs.readFile(path.join(directory, filename));
    const ext = path.extname(filename);
    const contentType = {'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[ext];
    res.writeHead(200, {'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      ...(filename === 'figma-package.json' ? {'Access-Control-Allow-Origin':'*'} : {}),
      'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log('G1 review: http://127.0.0.1:' + port));
