#!/usr/bin/env node
// A pick's HTML variant drawn as a picture (GET
// /api/checkpoints/<id>/variants/<n>?as=png, server/pagepicture.mjs), by a
// hub that has no Playwright, as the installed app's hub has none (it is a
// development dependency). On 2026-11-19 two .html variants, dark pages of
// data: JPEGs in scrolling rows, drew as two black wells in the Mac app:
// every ?as=png answered 501 there.
//
//   - the page as it looks: its data: pictures are in the picture, 16:10;
//   - the same protection as before: no script runs, and a file of this
//     Mac the page names (file://) is never drawn; the same for a page
//     drawn at a size of its own (an idea's mockup, 800x500, in a frame).
//
// A test board on a free port with a throwaway RAVENRY_HOME holding the
// kept pick (server/picks.mjs keep), started with Playwright made
// unresolvable. Never touches the real board or ~/.ravenry.
//
// Usage: node tools/pick-page-picture-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'pick-page-picture-test');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const FILES = path.join(T, 'agent-files');
for (const d of [MC, FILES]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = MC;
const picks = await import('../server/picks.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 600) : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PNG in and out: 8-bit RGB or RGBA, not interlaced (what sips and Quick Look write).
function encodePng(w, h, px) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(rows, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => { const b = Buffer.alloc(8 + data.length + 4); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buf) {
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; inter = d[12]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ctype];
  if (depth !== 8 || !bpp || inter) throw new Error(`PNG depth ${depth}, colour type ${ctype}, interlace ${inter}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = out.subarray(y * stride, (y + 1) * stride), up = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255;
    }
  }
  return { w, h, share: (test) => { let n = 0; for (let i = 0; i < out.length; i += bpp) if (test(out[i], out[i + 1], out[i + 2])) n++; return n / (w * h); } };
}

// The pictures: tall screenshots, orange with a noisy band (so each JPEG
// weighs what a real screenshot does), as data: JPEGs in a dark page of
// scrolling rows, the shape of the page that drew black.
const W = 600, H = 1300;
const px = Buffer.alloc(W * H * 3);
let seed = 7;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 3;
  if (y < 900) { px[o] = 255; px[o + 1] = 140; px[o + 2] = 0; } else { for (let k = 0; k < 3; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[o + k] = seed & 255; } }
}
fs.writeFileSync(path.join(T, 'shot.png'), encodePng(W, H, px));
execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(T, 'shot.png'), '--out', path.join(T, 'shot.jpg')], { stdio: 'ignore' });
const JPG = `data:image/jpeg;base64,${fs.readFileSync(path.join(T, 'shot.jpg')).toString('base64')}`;
const row = (n) => `<div class="row">${Array.from({ length: n }, () => `<img src="${JPG}">`).join('')}</div>`;
fs.writeFileSync(path.join(FILES, 'A.html'), `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#111;color:#eee;font:600 28px -apple-system,sans-serif;margin:24px}.row{display:flex;gap:16px;overflow-x:auto;margin:12px 0 28px}.row img{height:520px;border-radius:12px}</style></head><body><h2>A: question first</h2>${row(4)}<h2>iPad</h2>${row(3)}</body></html>`);
// A page that tries to run a script (the whole page red) and to draw a
// red picture of this Mac by its file:// path.
const RED = path.join(T, 'red.png');
fs.writeFileSync(RED, encodePng(64, 64, Buffer.alloc(64 * 64 * 3).fill(Buffer.from([255, 0, 0]))));
fs.writeFileSync(path.join(FILES, 'B.html'), `<!doctype html><html><body style="background:#111;margin:0"><img src="file://${RED}" style="width:900px;height:500px"><img src="${RED}" style="width:900px;height:500px"><script>document.documentElement.style.background='#f00';document.body.style.background='#f00'</script></body></html>`);
const pageSize = fs.statSync(path.join(FILES, 'A.html')).size;

const read = async (f) => { try { return { ok: true, data: fs.readFileSync(f) }; } catch { return { ok: false, error: 'gone' }; } };
const ID = 'cpage001';
await picks.keep({ id: ID, kind: 'pick', state: 'open', title: 'Which one leads?', created_at: new Date().toISOString(), variants: [{ label: 'A', path: path.join(FILES, 'A.html'), type: 'html' }, { label: 'B', path: path.join(FILES, 'B.html'), type: 'html' }] }, { projectId: null, read });
check(`the pick is kept with its two pages (A: ${(pageSize / 1e6).toFixed(2)} MB)`, !!picks.keptFile(ID, 0) && picks.keptFile(ID, 0).type === 'html' && !!picks.keptFile(ID, 1));

// The board, with Playwright unresolvable, as in the installed app.
const NOPW = path.join(ROOT, 'tools', 'no-playwright.mjs');
const PORT = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${PORT}`;
let log = '';
const env = withTestHome({ PATH: process.env.PATH, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'ravenry', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0', MC_PHONE_LAN: 'none', TEST_RAVENRY: '1', MC_TEST: '1', MC_CLAUDE_SETTINGS: path.join(T, 'settings.json'), MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects') });
const board = spawn(process.execPath, ['--import', NOPW, path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
process.on('exit', () => { try { board.kill('SIGTERM'); } catch { /* gone */ } });
const get = async (p) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(30000) }); return { status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) }; } catch (e) { return { status: 0, type: '', body: Buffer.from(String(e)) }; } };
for (let i = 0; i < 150; i++) { if ((await get('/api/whoami')).status) break; await sleep(100); }
const pw = await get('/api/checkpoints/cnone/variants/0');
check('the test board is up, without Playwright', pw.status === 404, log.slice(-600));

const a = await get(`/api/checkpoints/${ID}/variants/0?as=png`);
let pa = null;
try { pa = a.status === 200 ? decodePng(a.body) : null; } catch (e) { log += `\n${e.message}`; }
const orange = pa ? pa.share((r, g, b) => r > 200 && g > 100 && g < 180 && b < 70) : 0;
check('?as=png draws the page with its data: pictures (not a dark well), 16:10', !!pa && a.type === 'image/png' && pa.w * 10 === pa.h * 16 && orange > 0.15, `${a.status} ${a.type} ${pa ? `${pa.w}x${pa.h}, ${(orange * 100).toFixed(1)}% orange` : a.body.toString('utf8').slice(0, 300)}`);
if (pa) fs.writeFileSync(path.join(T, 'A-as-png.png'), a.body);

const b = await get(`/api/checkpoints/${ID}/variants/1?as=png`);
let pb = null;
try { pb = b.status === 200 ? decodePng(b.body) : null; } catch (e) { log += `\n${e.message}`; }
const red = pb ? pb.share((r, g, bl) => r > 200 && g < 60 && bl < 60) : 1;
check('and keeps the protection: no script runs, no file of this Mac is drawn', !!pb && red < 0.001, `${b.status} ${pb ? `${(red * 100).toFixed(1)}% red` : b.body.toString('utf8').slice(0, 300)}`);

// An idea's mockup is drawn the same way at its own size (server/mockups.mjs,
// 800x500, in a frame): the same protection in the frame.
const { drawPage } = await import('../server/pagepicture.mjs');
const FR = path.join(T, 'frame.png');
let pf = null;
try { await drawPage(path.join(FILES, 'B.html'), FR, { width: 800, height: 500 }); pf = decodePng(fs.readFileSync(FR)); } catch (e) { log += `\n${e.message}`; }
const fred = pf ? pf.share((r, g, bl) => r > 200 && g < 60 && bl < 60) : 1;
check('a page drawn at 800x500 (a mockup): 800x500, no script, no file of this Mac', !!pf && pf.w === 800 && pf.h === 500 && fred < 0.001, pf ? `${pf.w}x${pf.h}, ${(fred * 100).toFixed(1)}% red` : 'not drawn');

console.log(fails ? `\n${fails} failed\n${log.slice(-1500)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
