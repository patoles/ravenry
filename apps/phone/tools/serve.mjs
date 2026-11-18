#!/usr/bin/env node
// The phone board in a browser, for development and the screenshots: dist/
// at /phone/, and hub/<path> beside it passed to a hub on this machine, as
// the shells pass it (docs/PHONE.md section 1). A browser stands in for no
// shell feature: no push, fingerprint, camera, microphone or private
// keyboard (?features=photo,voice,... draws their buttons for a picture).
//
//   node tools/serve.mjs [--port 4680] [--hub http://127.0.0.1:4600]
//   node tools/serve.mjs --demo [--port 4680] [--log requests.jsonl]
//
// --demo serves the demo as the shells do (src/demo.ts): no hub at all, the
// board's page from dist/board with the app's layer first (marked as the
// demo's), its pictures from dist/demo, and the app's own screens marked the
// same. --log writes every request it was asked for, one JSON line each.
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
const DEMO = args.includes('--demo');
const HUB = new URL(opt('--hub', process.env.RAVENRY_HUB_URL || 'http://127.0.0.1:4600'));
if (!DEMO && HUB.port === '4600' && !args.includes('--real')) { console.error('Refused: :4600 is the real board. Pass --hub with a test board, or --real.'); process.exit(1); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const LOG = opt('--log', null);

/** The demo, as the shells serve it: nothing here reaches a hub. */
function demo(req, res, u) {
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const file = (abs) => (abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs) : null);
  const inside = (dir, rel) => { const abs = path.resolve(dir, rel); return abs.startsWith(dir + path.sep) ? abs : null; };
  if (u.pathname === '/phone/left-demo') return send(200, 'text/html; charset=utf-8', '<!doctype html><title>Left the demo</title><p id="left">Left the demo: the pairing screen.</p>');
  if (u.pathname === '/phone/' || u.pathname === '/phone/index.html') {
    return send(200, TYPES['.html'], fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace('<html lang="en">', '<html lang="en" data-demo>'));
  }
  const hubPath = u.pathname.startsWith('/phone/hub/') ? u.pathname.slice('/phone/hub'.length) : u.pathname.startsWith('/phone/') ? null : u.pathname;
  if (hubPath === null) {
    const b = file(inside(DIST, u.pathname.replace(/^\/phone\//, '')));
    return b ? send(200, TYPES[path.extname(u.pathname)] || 'application/octet-stream', b) : send(404, 'text/plain', '');
  }
  if (hubPath === '/') {
    return send(200, TYPES['.html'], fs.readFileSync(path.join(DIST, 'board', 'index.html'), 'utf8').replace('<head>', '<head>\n<script src="/phone/board.js" data-demo></script>'));
  }
  if (hubPath.startsWith('/api/')) {
    const files = JSON.parse(fs.readFileSync(path.join(DIST, 'demo', 'files.json'), 'utf8'));
    const k = new URL(hubPath + u.search, 'http://x'); k.searchParams.delete('v');
    const f = files[k.pathname + (k.searchParams.toString() ? '?' + k.searchParams.toString() : '')];
    const b = f && file(inside(path.join(DIST, 'demo'), f.file));
    return b ? send(200, f.type, b) : send(404, 'application/json', '{"error":"not in the demo"}');
  }
  const b = file(inside(path.join(DIST, 'board'), hubPath.slice(1)));
  return b ? send(200, TYPES[path.extname(hubPath)] || 'application/octet-stream', b) : send(404, 'text/plain', '');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: req.method, url: req.url }) + '\n');
  if (DEMO) return demo(req, res, u);
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
  if (DEMO) { sock.destroy(); return; }
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

server.listen(PORT, '127.0.0.1', () => console.log(DEMO ? `the demo on http://127.0.0.1:${PORT}/ (no hub)` : `phone board on http://127.0.0.1:${PORT}/phone/ (hub ${HUB.origin})`));
