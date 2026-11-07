#!/usr/bin/env node
// The terminal's basics, in the app (0.1.17):
//   - a pane's scroll position is kept across tab switches (and the bottom
//     stays the bottom);
//   - Cmd+click (Ctrl+click off the Mac) opens an OSC 8 link and a plain
//     URL in the browser; a plain click opens nothing; a link that is not
//     http, https or file never opens;
//   - Cmd+= / Cmd+- / Cmd+0 zoom the terminal's text only, and the size is
//     kept across a relaunch;
//   - a file dropped on the terminal pastes its quoted path;
//   - the window comes back at the size it was left;
//   - Cmd+Home and Cmd+End go to the top and the bottom of the scrollback.
//
//   node tools/basics-test.mjs [OUT] [--exe APP_EXECUTABLE]
//   (--exe: a packaged app, its test twin; the release check runs it so)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'basics-test'));
fs.mkdirSync(OUT, { recursive: true });
const MAC = process.platform === 'darwin';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvbs-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
const openLog = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (!ok) fails++; };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'basics-test' });
// 400 lines, then links: an OSC 8 one, a plain URL, a javascript: one and
// an ftp URL (neither may open); then cat, which echoes what is pasted.
const script = [
  'i=1; while [ $i -le 400 ]; do echo "line $i of the scrollback"; i=$((i+1)); done',
  "printf 'see \\033]8;;https://example.com/osc\\033\\\\Docs link\\033]8;;\\033\\\\ here\\n'",
  "printf 'plain https://example.com/plain here\\n'",
  "printf 'bad \\033]8;;javascript:alert(1)\\033\\\\Bad link\\033]8;;\\033\\\\ here\\n'",
  "printf 'ftp ftp://example.com/x here\\n'",
  'exec cat',
].join('\n');
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', script], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();
const KEY = `kite/ravenry:${pane.id}`;

let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(state)); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const T = `${R}.term()`;
const B = `${T}.term.buffer.active`;
const SCREEN = `(() => { const b = ${B}; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true)); return out.join('\\n'); })()`;
// The middle of the first cell of `text` on screen, as a point in the window.
const cellOf = (text) => `(() => { const t = ${T}.term; const b = t.buffer.active; const scr = document.querySelector('.term-host .xterm-screen').getBoundingClientRect(); const cw = scr.width / t.cols, ch = scr.height / t.rows;
  for (let y = 0; y < t.rows; y++) { const l = b.getLine(b.viewportY + y); const x = l ? l.translateToString(true).indexOf(${JSON.stringify(text)}) : -1; if (x >= 0) return { x: Math.round(scr.left + (x + 1.5) * cw), y: Math.round(scr.top + (y + 0.5) * ch) }; } return null; })()`;
const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).what); } catch { return []; } };
const cmdMod = MAC ? ['meta'] : ['control'];
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog };
const VIEW = `({ y: ${B}.viewportY, base: ${B}.baseY })`;

try {
  await runApp({ name: 'first', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1200, height: 800, steps: [
    { ready: true },
    { until: `document.querySelector('#side .ss[data-key="${KEY}"]')`, timeout: 15000 },
    { click: `#side .ss[data-key="${KEY}"]` },
    { until: `${T}.attached && ${T}.attached.pane === ${JSON.stringify(pane.id)} && ${SCREEN}.includes('ftp://example.com/x')`, timeout: 15000 },
    // The scroll position across a tab switch.
    { js: `${T}.term.scrollToLine(100)` },
    { sleep: 200 },
    save('scroll-before', VIEW),
    { js: `${R}.newShell()` },
    { until: `${T}.attached && ${T}.attached.pane !== ${JSON.stringify(pane.id)}`, timeout: 10000 },
    { sleep: 500 },
    { click: `#tabs .tab[data-key="${KEY}"]` },
    { until: `${T}.attached && ${T}.attached.pane === ${JSON.stringify(pane.id)} && ${SCREEN}.includes('ftp://example.com/x')`, timeout: 10000 },
    { sleep: 500 },
    save('scroll-after', VIEW),
    // At the bottom, it stays at the bottom.
    { js: `${T}.term.scrollToBottom()` },
    { click: `#tabs .tab[data-key]:not([data-key="${KEY}"])` },
    { until: `${T}.attached && ${T}.attached.pane !== ${JSON.stringify(pane.id)}`, timeout: 10000 },
    { sleep: 400 },
    { click: `#tabs .tab[data-key="${KEY}"]` },
    { until: `${T}.attached && ${T}.attached.pane === ${JSON.stringify(pane.id)} && ${SCREEN}.includes('ftp://example.com/x')`, timeout: 10000 },
    { sleep: 500 },
    save('bottom-after', VIEW),
    // Cmd+Home and Cmd+End.
    { js: `${T}.focus()` },
    { key: 'Home', modifiers: cmdMod },
    { sleep: 200 },
    save('home', VIEW),
    { key: 'End', modifiers: cmdMod },
    { sleep: 200 },
    save('end', VIEW),
    // Links: a plain click opens nothing; Cmd+click opens.
    { clickAt: cellOf('https://example.com/plain') },
    { sleep: 300 },
    { signal: path.join(work, 'plain-click') },
    { clickAt: cellOf('https://example.com/plain'), modifiers: cmdMod },
    { clickAt: cellOf('Docs link'), modifiers: cmdMod },
    { clickAt: cellOf('Bad link'), modifiers: cmdMod },
    { clickAt: cellOf('ftp://example.com/x'), modifiers: cmdMod },
    { sleep: 400 },
    { shot: path.join(OUT, 'links.png') },
    // Zoom: the terminal's text only.
    save('zoom-before', `({ size: ${T}.term.options.fontSize, cols: ${T}.term.cols, body: getComputedStyle(document.body).fontSize, side: document.querySelector('#side') ? document.querySelector('#side').getBoundingClientRect().width : null, dpr: window.devicePixelRatio })`),
    { js: `${R}.onCommand('zoom', 1)` },
    { js: `${R}.onCommand('zoom', 1)` },
    { sleep: 400 },
    save('zoom-in', `({ size: ${T}.term.options.fontSize, cols: ${T}.term.cols, body: getComputedStyle(document.body).fontSize, side: document.querySelector('#side') ? document.querySelector('#side').getBoundingClientRect().width : null, dpr: window.devicePixelRatio })`),
    save('zoom-in-kept', `window.ravenry.settings.get().then((s) => s.settings.fontSize)`),
    { shot: path.join(OUT, 'zoomed.png') },
    { js: `${R}.onCommand('zoom', 0)` },
    { sleep: 300 },
    save('zoom-reset', `window.ravenry.settings.get().then((s) => ({ size: ${T}.term.options.fontSize, kept: s.settings.fontSize }))`),
    { js: `${R}.onCommand('zoom', -1)` },
    { sleep: 300 },
    // A file dropped on the terminal: its quoted path, pasted.
    { js: `${T}.pathOf = () => "/tmp/My Shot's.png"; const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' })); document.getElementById('term').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); true` },
    { until: `${SCREEN}.includes("'/tmp/My Shot'\\\\''s.png'")`, timeout: 5000 },
    // The window's size, to come back to.
    { size: [1000, 700] },
    { sleep: 800 },
  ] });
  const sb = read('scroll-before'), sa = read('scroll-after');
  check('a pane scrolled up comes back where it was after a tab switch', !!sb && !!sa && sb.y === 100 && sa.y === 100 && sa.base > 100, { before: sb, after: sa });
  const ba = read('bottom-after');
  check('a pane at the bottom comes back at the bottom', !!ba && ba.y === ba.base, ba);
  if (MAC) {
    const ho = read('home'), en = read('end');
    check('Cmd+Home goes to the top of the scrollback, Cmd+End to the bottom', ho?.y === 0 && en?.y === en?.base && en.base > 0, { home: ho, end: en });
  }
  const o = opened();
  check('Cmd+click opens a plain URL and an OSC 8 link, nothing else; a plain click opens nothing', o.length === 2 && o[0] === 'https://example.com/plain' && o[1] === 'https://example.com/osc', o);
  const zb = read('zoom-before'), zi = read('zoom-in'), zr = read('zoom-reset');
  check('Cmd+= twice: the terminal\'s text 2 points bigger, fewer columns; the rest of the window as it was', !!zb && !!zi && zi.size === zb.size + 2 && zi.cols < zb.cols && zi.body === zb.body && zi.side === zb.side && zi.dpr === zb.dpr && read('zoom-in-kept') === zi.size, { before: zb, after: zi, kept: read('zoom-in-kept') });
  check('Cmd+0: the terminal\'s text back to its size (kept in the settings)', zr?.size === 13 && zr.kept === 13, zr);
  check('a file dropped on the terminal pastes its path, quoted', true);

  // Relaunched: the window's size and the text size as they were left.
  await runApp({ name: 'second', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1200, height: 800, steps: [
    { ready: true },
    { until: `${T}.attached`, timeout: 15000 },
    save('relaunch', `({ w: window.innerWidth, h: window.innerHeight, size: ${T}.term.options.fontSize })`),
  ] });
  const rl = read('relaunch');
  let bounds = null;
  try { bounds = JSON.parse(fs.readFileSync(path.join(data, 'window.json'), 'utf8')).bounds; } catch { /* below */ }
  check('relaunched, the window is the size it was left (window.json)', rl?.w === 1000 && rl?.h === 700 && !!bounds, { relaunch: rl, bounds });
  check('relaunched, the terminal\'s text is the size it was left', rl?.size === 12, rl);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  clearInterval(tick);
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
