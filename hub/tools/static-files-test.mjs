// The board's own files (server/static.mjs): compressed for a client that
// takes brotli or gzip, an ETag from their content with `no-cache`, a 304
// when the client has that version, and a changed file (an update) sent at
// once with a new ETag, so a reload never runs stale code. Over the board's
// real app.js, app.css and index.html, copied to a throwaway folder.
//
// Usage: node tools/static-files-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { send, matches, sendPicture, gzipStream } from '../server/static.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-files-'));
for (const f of ['app.js', 'app.css', 'index.html']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(dir, f));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const srv = http.createServer((req, res) => (req.url.endsWith('.png') ? sendPicture(req, res, path.join(dir, req.url.slice(1)), 'image/png') : send(req, res, path.join(dir, req.url.slice(1)), TYPES[path.extname(req.url)])));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const get = (p, headers = {}) => new Promise((ok, no) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const b = []; res.on('data', (d) => b.push(d)); res.on('end', () => ok({ status: res.statusCode, h: res.headers, body: Buffer.concat(b) })); }).on('error', no);
});

const raw = fs.readFileSync(path.join(dir, 'app.js'));
const plain = await get('/app.js');
check('no Accept-Encoding: the file as it is, with an ETag and no-cache', plain.status === 200 && plain.body.equals(raw) && /^"[\w-]{22}"$/.test(plain.h.etag) && plain.h['cache-control'] === 'no-cache' && !plain.h['content-encoding'], `${plain.body.length} bytes, ${plain.h.etag}`);
const gz = await get('/app.js', { 'Accept-Encoding': 'gzip' });
check('gzip: smaller, and the same file once inflated', gz.h['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.body).equals(raw) && gz.body.length < raw.length / 3, `${raw.length} -> ${gz.body.length} bytes`);
const br = await get('/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
check('brotli when the client takes it', br.h['content-encoding'] === 'br' && zlib.brotliDecompressSync(br.body).equals(raw) && br.body.length <= gz.body.length, `${br.body.length} bytes`);
check('Vary: Accept-Encoding', /Accept-Encoding/i.test(br.h.vary || ''));
const again = await get('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.h.etag });
check('the reload with its ETag: 304, no body', again.status === 304 && again.body.length === 0 && again.h.etag === gz.h.etag);
let total = 0, reload = 0;
for (const f of ['index.html', 'app.css', 'app.js']) {
  const a = await get('/' + f, { 'Accept-Encoding': 'gzip' });
  total += a.body.length;
  const b = await get('/' + f, { 'Accept-Encoding': 'gzip', 'If-None-Match': a.h.etag });
  reload += b.body.length;
}
check('the board\'s page, CSS and code: a first load in gzip, a reload sends no body', reload === 0, `${total} bytes first (${fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)} raw), ${reload} on the reload`);
// An update: app.js changes on disk; the old ETag gets the new file at once.
fs.appendFileSync(path.join(dir, 'app.js'), '\nwindow.__updated = 1;\n');
const upd = await get('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.h.etag });
check('app.js changed: the old ETag gets 200 with the new code and a new ETag', upd.status === 200 && upd.h.etag !== gz.h.etag && zlib.gunzipSync(upd.body).toString().endsWith('window.__updated = 1;\n'));
check('If-None-Match: a list, weak tags and * match', matches('"a", W/"b"', '"b"') && matches('*', '"x"') && !matches('"a"', '"b"') && !matches(undefined, '"b"'));
const small = path.join(dir, 'tiny.js'); fs.writeFileSync(small, 'x=1');
const t = await get('/tiny.js', { 'Accept-Encoding': 'gzip' });
check('a file under 1 KB goes as it is', t.status === 200 && !t.h['content-encoding'] && t.body.toString() === 'x=1');
// A picture (a brief's): an ETag from its size and time, 304 while it is the same.
fs.copyFileSync(path.join(ROOT, 'public', 'icons', fs.readdirSync(path.join(ROOT, 'public', 'icons')).find((f) => f.endsWith('.png'))), path.join(dir, 'shot.png'));
const p1 = await get('/shot.png');
const p2 = await get('/shot.png', { 'If-None-Match': p1.h.etag });
check('a picture: an ETag, then 304 with no body', p1.status === 200 && p1.body.length === fs.statSync(path.join(dir, 'shot.png')).size && !!p1.h.etag && p2.status === 304 && p2.body.length === 0, `${p1.body.length} bytes, ${p1.h.etag}; then ${p2.status} ${p2.body.length}`);
fs.appendFileSync(path.join(dir, 'shot.png'), Buffer.from([0]));
const p3 = await get('/shot.png', { 'If-None-Match': p1.h.etag });
check('the picture replaced: 200 with the new one', p3.status === 200 && p3.body.length === p1.body.length + 1 && p3.h.etag !== p1.h.etag);
srv.close();

// A phone's live stream, gzipped as it goes: each event readable as soon as
// it is written (no waiting for more), and the snapshot a fraction of itself.
{
  const snap = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'prompt', 'ravenry-agent-wait.captures.json'), 'utf8')));
  let sres = null;
  const ss = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' }); gzipStream(res); sres = res; res.write(`event: state\ndata: ${snap}\n\n`); });
  await new Promise((r) => ss.listen(0, '127.0.0.1', r));
  const got = [];
  let wire = 0;
  const done = new Promise((ok) => {
    http.get({ host: '127.0.0.1', port: ss.address().port, path: '/', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const z = zlib.createGunzip();
      res.on('data', (d) => { wire += d.length; });
      res.pipe(z);
      let text = '';
      z.on('data', (d) => { text += d; let i; while ((i = text.indexOf('\n\n')) >= 0) { got.push({ ev: text.slice(0, i), at: Date.now() }); text = text.slice(i + 2); } });
      z.on('end', ok); z.on('error', ok);
    });
  });
  const wait = async (n) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20)); return got.length >= n; };
  const first = await wait(1);
  const t = Date.now();
  sres.write('event: notify\ndata: {"n":2}\n\n');
  const second = await wait(2);
  check('gzip stream: the snapshot arrives whole at once, compressed', first && got[0].ev === `event: state\ndata: ${snap}` && wire < snap.length / 4, `${snap.length} bytes as ${wire} on the wire`);
  check('gzip stream: a later event arrives as soon as it is written', second && got[1].ev === 'event: notify\ndata: {"n":2}' && got[1].at - t < 300, `${second ? got[1].at - t : '-'} ms`);
  sres.end();
  await done;
  ss.close();
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
