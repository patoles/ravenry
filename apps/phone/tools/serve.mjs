#!/usr/bin/env node
// The phone board in a browser, for development and the screenshots: dist/
// at /phone/, and hub/<path> beside it passed to a hub on this machine, as
// the shells pass it (docs/PHONE.md section 1). A browser stands in for no
// shell feature: no push, fingerprint, camera, microphone or private
// keyboard (?features=photo,voice,... draws their buttons for a picture).
//
//   node tools/serve.mjs [--port 4680] [--hub http://127.0.0.1:4600]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('--port', 4680));
const HUB = new URL(opt('--hub', process.env.RAVENRY_HUB_URL || 'http://127.0.0.1:4600'));
if (HUB.port === '4600' && !args.includes('--real')) { console.error('Refused: :4600 is the real board. Pass --hub with a test board, or --real.'); process.exit(1); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(302, { Location: '/phone/' }); res.end(); return; }
  if (u.pathname.startsWith('/phone/hub/')) {
    const p = u.pathname.slice('/phone/hub'.length) + u.search;
    const headers = { ...req.headers, host: `127.0.0.1:${HUB.port}` };
    delete headers.origin; delete headers.referer;
    const up = http.request({ host: HUB.hostname, port: HUB.port, path: p, method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  const rel = u.pathname === '/phone/' ? 'index.html' : u.pathname.replace(/^\/phone\//, '');
  const abs = path.resolve(DIST, rel);
  if (!abs.startsWith(DIST + path.sep) || !fs.existsSync(abs)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
});

// The terminal: the WebSocket upgrade passed through as bytes.
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/phone/hub/')) { sock.destroy(); return; }
  const p = u.pathname.slice('/phone/hub'.length) + u.search;
  const up = net.connect(Number(HUB.port), HUB.hostname, () => {
    const lines = [`GET ${p} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'origin', 'referer'].includes(k)) lines.push(`${k}: ${v}`);
    lines.push(`host: 127.0.0.1:${HUB.port}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`phone board on http://127.0.0.1:${PORT}/phone/ (hub ${HUB.origin})`));
