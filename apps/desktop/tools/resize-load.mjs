// A resize with a person's real load: TABS shell tabs, each running a
// program that draws as Claude Code does (its whole transcript, long
// coloured lines that wrap, written again after its scrollback is cleared,
// in one synchronized update, at each size), so the terminals kept alive
// hidden (app.ts POOL) hold full scrollbacks too. The window is dragged
// 1280 -> 900 and left there; measured in the page, through the prototypes
// (so it runs on any build): the long tasks and long animation frames from
// the drag to 2.5 s after it, and for each terminal its xterm.js resizes
// (ms, buffer lines), the bytes written in (synchronously or not) and the
// time parsing them, and its draws. Offscreen, in a throwaway HOME.
//
//   node tools/resize-load.mjs [OUT.json] [--tabs 6] [--lines 3000]
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';
import { startDemoHub } from './demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const TABS = Number(opt('--tabs', '6'));
const LINES = Number(opt('--lines', '3000'));
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'resize-load.json'));
const K = Number(process.env.FLASH_SCALE || 2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvrl-'));
const work = path.join(root, 'w');
const rt = path.join(root, 'r');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = 'window.__ravenry';

// The Claude-like program: LINES transcript lines (bullets, coloured words,
// 60 to 400 characters), its input box, all again at each size.
const TUI = path.join(work, 'claude-like.mjs');
fs.writeFileSync(TUI, `const N = Number(process.argv[2] || 1000);
const words = 'the quick brown fox jumps over the lazy dog while seven wizards quietly judge boxing matches in the old harbour hall'.split(' ');
const col = ['\\x1b[38;5;174m', '\\x1b[1m', '\\x1b[38;5;246m', '\\x1b[32m', '\\x1b[36m'];
const lines = [];
for (let i = 0; i < N; i++) { const n = 60 + (i * 53) % 340; let s = i % 7 === 0 ? '\\x1b[38;5;174m\\u23fa\\x1b[0m ' : '  '; let len = 0, k = i;
  while (len < n) { const w = words[k++ % words.length]; s += (k % 9 === 0 ? col[k % col.length] + w + '\\x1b[0m' : w) + ' '; len += w.length + 1; }
  lines.push(s); }
function draw() {
  const c = process.stdout.columns || 80; const w = Math.max(10, c - 2);
  const box = ['\\x1b[38;5;246m\\u256d' + '\\u2500'.repeat(w - 2) + '\\u256e', '\\u2502 > ' + ' '.repeat(w - 5) + '\\u2502', '\\u2570' + '\\u2500'.repeat(w - 2) + '\\u256f\\x1b[0m', '  ? for shortcuts'];
  process.stdout.write('\\x1b[?2026h\\x1b[2J\\x1b[3J\\x1b[H' + lines.join('\\r\\n') + '\\r\\n\\r\\n' + box.join('\\r\\n') + '\\x1b[?2026l');
}
process.stdout.on('resize', draw);
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => { if (String(d).includes('\\x03')) process.exit(0); });
draw();
`);

// Measured through the prototypes: TerminalView (fitNow, drawNow), xterm.js's
// Terminal (resize), its WriteBuffer (write, writeSync, _innerWrite) and RenderService (_renderRows).
const INSTRUMENT = `(() => { if (window.__rl) return true; const L = window.__rl = { on: false, ev: [], long: [], loaf: [], ids: new Map() };
  const id = (o) => { if (!L.ids.has(o)) L.ids.set(o, L.ids.size); return L.ids.get(o); };
  const now = () => performance.now();
  const wrap = (proto, name, rec) => { const f = proto[name]; if (typeof f !== 'function' || f.__rl) return false; const g = function (...a) { const t = now(); try { return f.apply(this, a); } finally { if (L.on) rec(this, a, now() - t, t); } }; g.__rl = true; proto[name] = g; return true; };
  const v0 = ${R}.views()[0]; const T = Object.getPrototypeOf(v0.term); const core = v0.term._core;
  const tid = (t) => id(t);
  wrap(T, 'resize', (t, a, ms, at) => L.ev.push({ k: 'resize', t: tid(t), at, ms, cols: a[0], rows: a[1], lines: t.buffer.normal.length, hidden: getComputedStyle(t.element).visibility === 'hidden' }));
  const WB = Object.getPrototypeOf(core._writeBuffer);
  const owner = (wb) => { for (const v of ${R}.__allTerms()) if (v._core && v._core._writeBuffer === wb) return tid(v); return -1; };
  const len = (d) => typeof d === 'string' ? d.length : d.byteLength;
  wrap(WB, 'writeSync', (wb, a, ms, at) => L.ev.push({ k: 'writeSync', t: owner(wb), at, ms, bytes: len(a[0]) }));
  wrap(WB, 'write', (wb, a, ms, at) => L.ev.push({ k: 'write', t: owner(wb), at, ms, bytes: len(a[0]) }));
  wrap(WB, '_innerWrite', (wb, a, ms, at) => L.ev.push({ k: 'parse', t: owner(wb), at, ms }));
  const RS = Object.getPrototypeOf(core._renderService);
  wrap(RS, '_renderRows', (rs, a, ms, at) => { let o = -1; for (const v of ${R}.__allTerms()) if (v._core && v._core._renderService === rs) o = tid(v); L.ev.push({ k: 'draw', t: o, at, ms }); });
  try { new PerformanceObserver((l) => { if (L.on) for (const e of l.getEntries()) L.long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' }); } catch {}
  try { new PerformanceObserver((l) => { if (L.on) for (const e of l.getEntries()) L.loaf.push({ at: e.startTime, ms: e.duration, blocking: e.blockingDuration }); }).observe({ type: 'long-animation-frame' }); } catch {}
  L.start = () => { L.ev = []; L.long = []; L.loaf = []; L.on = true; L.t0 = now(); return true; };
  L.mark = (n) => { L[n] = now(); return true; };
  L.stop = () => { L.on = false; return { t0: L.t0, settle: L.settle, ev: L.ev, long: L.long, loaf: L.loaf, terms: ${R}.__allTerms().map((t) => ({ id: tid(t), lines: t.buffer.normal.length, cols: t.cols, hidden: getComputedStyle(t.element).visibility === 'hidden' })) }; };
  return true; })()`;
// Every xterm.js in the page (pooled ones included): found from their elements.
const ALL_TERMS = `(() => { ${R}.__allTerms = () => { const out = []; for (const v of ${R}.views()) if (v) out.push(v.term); for (const t of (window.__rlTerms || [])) if (!out.includes(t)) out.push(t); return out; }; return true; })()`;

let hub = null;
let raw = null;
try {
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true });
  // Each xterm.js is caught as it is made (Terminal.prototype.open), before any tab is opened.
  const CATCH = `(() => { window.__rlTerms = window.__rlTerms || []; const T = Object.getPrototypeOf(${R}.views()[0].term); if (!T.__rlCatch) { const o = T.open; T.open = function (...a) { window.__rlTerms.push(this); return o.apply(this, a); }; T.__rlCatch = true; } if (!window.__rlTerms.includes(${R}.views()[0].term)) window.__rlTerms.push(${R}.views()[0].term); return true; })()`;
  const steps = [
    { ready: true },
    { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2 && ${R}.term().attached && ${R}.term().ready`, timeout: 30000 },
    { js: CATCH }, { js: ALL_TERMS },
    { size: [1280 * K, 820 * K] }, { sleep: 800 },
    { js: `(() => { const b = document.querySelector('[aria-label="Hide the panel"]'); if (b) b.click(); return true; })()` }, { sleep: 500 },
  ];
  for (let i = 0; i < TABS; i++) {
    if (i > 0) steps.push({ js: `${R}.newShell(), true` }, { until: `${R}.S.tabs.filter((t) => t.kind === 'shell').length >= ${i + 1} && ${R}.term().ready`, timeout: 15000 }, { sleep: 500 });
    steps.push({ type: `${process.execPath} ${TUI} ${LINES}\r` });
    steps.push({ until: `${R}.term().term.buffer.normal.length >= ${Math.min(9000, LINES * 2)} && /for shortcuts/.test(${R}.term().term.buffer.normal.getLine(${R}.term().term.buffer.normal.baseY + ${R}.term().term.buffer.normal.cursorY).translateToString(true))`, timeout: 30000, soft: true }, { sleep: 400 });
  }
  steps.push({ sleep: 1500 }, { js: INSTRUMENT });
  // The drag: 1280 -> 900 in 30 sizes at 60 Hz, then left there 2.5 s.
  steps.push({ main: `const js = (c) => win.webContents.executeJavaScript(c, true); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const w0 = ${1280 * K}, w1 = ${900 * K}, h = ${820 * K};
    await js('window.__rl.start()');
    for (let i = 1; i <= 30; i++) { win.setContentSize(Math.round(w0 + (w1 - w0) * i / 30), h); await sleep(16); }
    await js('window.__rl.mark("settle")');
    await sleep(2500);
    return await js('window.__rl.stop()');`, out: path.join(work, 'run.json') });
  fs.mkdirSync(path.join(root, 'apphome'), { recursive: true });
  await runApp({ name: 'rl', work, rt, bin: BIN, home: path.join(root, 'apphome'), hubUrl: hub.url, timeoutMs: 400000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_TEST_SCALE: String(K) }, width: 1280 * K, height: 820 * K, steps });
  raw = JSON.parse(fs.readFileSync(path.join(work, 'run.json'), 'utf8'));
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}

const r1 = (x) => Math.round(x * 10) / 10;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// From the drag's start to its last size (drag), and from then on (settle).
function part(from, to) {
  const ev = raw.ev.filter((e) => e.at >= from && e.at < to);
  const per = {};
  for (const t of raw.terms) {
    const e = ev.filter((x) => x.t === t.id);
    const of = (k) => e.filter((x) => x.k === k);
    if (!e.length) continue;
    per[`term${t.id}${t.hidden ? ' (hidden)' : ''}`] = { lines: t.lines, resizes: of('resize').length, resizeMs: r1(sum(of('resize').map((x) => x.ms))), resizeMaxMs: r1(Math.max(0, ...of('resize').map((x) => x.ms))),
      bytesSync: sum(of('writeSync').map((x) => x.bytes)), writeSyncMs: r1(sum(of('writeSync').map((x) => x.ms))), writeSyncMaxMs: r1(Math.max(0, ...of('writeSync').map((x) => x.ms))),
      bytesAsync: sum(of('write').map((x) => x.bytes)), parseMs: r1(sum(of('parse').map((x) => x.ms))), parseMaxMs: r1(Math.max(0, ...of('parse').map((x) => x.ms))),
      draws: of('draw').length, drawMs: r1(sum(of('draw').map((x) => x.ms))) };
  }
  const lt = raw.long.filter((x) => x.at >= from && x.at < to);
  const lf = raw.loaf.filter((x) => x.at >= from && x.at < to);
  return { longTasks: lt.map((x) => r1(x.ms)), longTaskMax: r1(Math.max(0, ...lt.map((x) => x.ms))), longFrames: lf.map((x) => r1(x.ms)), perTerm: per };
}
const result = { tabs: TABS, lines: LINES, terms: raw.terms, drag: part(raw.t0, raw.settle), settle: part(raw.settle, Infinity) };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ ...result, raw }, null, 1));
console.log(JSON.stringify(result, null, 1));
