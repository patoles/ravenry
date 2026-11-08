// Frame time while a terminal is resized: the window dragged 1280 -> 900 ->
// 1280 (30 sizes each way at 60 Hz), then a split's divider dragged 200 px
// and back, with the left pane's scrollback filled with LINES lines of
// varied length (0: an empty pane). Offscreen, in a throwaway HOME.
// Measured in the page: each animation frame's interval (rAF), the long
// tasks (over 50 ms) and long animation frames, the time in xterm.js's
// resize and in the whole fit; in the main process, the interval between
// the frames the window presents (its 'paint' events).
//
//   node tools/frame-time.mjs [OUT.json] [--lines 10000]
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
const LINES = Number(opt('--lines', '10000'));
// --trace FILE: a Chrome trace of the window drag (to find what a long frame does).
const TRACE = opt('--trace', '');
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'frame-time.json'));
const K = Number(process.env.FLASH_SCALE || 2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvft-'));
const work = path.join(root, 'w');
const rt = path.join(root, 'r');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = 'window.__ravenry';

// Lines from 10 to 150 characters, words of a sentence, so a narrower pane rewraps many of them.
const FILL = path.join(work, 'fill.sh');
fs.writeFileSync(FILL, `awk 'BEGIN { w = "the quick brown fox jumps over the lazy dog while seven wizards quietly judge boxing matches"; for (i = 1; i <= ${LINES}; i++) { n = (i * 37) % 140 + 10; s = ""; while (length(s) < n) s = s w " "; print i ": " substr(s, (i % 13) + 1, n) } }'\n`);

// In the page: rAF intervals, long tasks, long animation frames, and the time in each view's resize and fit.
const INSTRUMENT = `(() => { const F0 = window.__ft; const F = window.__ft = F0 || { on: false, raf: [], long: [], loaf: [], resize: [], fit: [], last: 0 }; if (!F0) {
  const loop = (t) => { if (F.on && F.last) F.raf.push(t - F.last); F.last = t; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { if (F.on) for (const e of l.getEntries()) F.long.push(e.duration); }).observe({ type: 'longtask' }); } catch (e) { F.noLong = String(e); }
  try { new PerformanceObserver((l) => { if (F.on) for (const e of l.getEntries()) F.loaf.push({ ms: e.duration, blocking: e.blockingDuration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, layout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts: (e.scripts || []).map((x) => ({ inv: x.invoker, fn: x.sourceFunctionName, ms: Math.round(x.duration), layout: Math.round(x.forcedStyleAndLayoutDuration) })) }); }).observe({ type: 'long-animation-frame' }); } catch (e) { F.noLoaf = String(e); }
  }
  ${R}.views().forEach((v, i) => { if (!v || v.__ft) return; v.__ft = true; const t = v.term; const r = t.resize.bind(t);
    t.resize = (c, rw) => { const a = performance.now(); r(c, rw); if (F.on) F.resize.push({ v: i, ms: performance.now() - a, cols: c, rows: rw, lines: t.buffer.normal.length }); };
    const f = v.fitNow.bind(v); v.fitNow = (...x) => { const a = performance.now(); f(...x); if (F.on) F.fit.push({ v: i, ms: performance.now() - a }); }; });
  F.start = () => { Object.assign(F, { on: true, raf: [], long: [], loaf: [], resize: [], fit: [], last: 0 }); return true; };
  F.stop = () => { F.on = false; return { raf: F.raf, long: F.long, loaf: F.loaf, resize: F.resize, fit: F.fit, noLong: F.noLong, noLoaf: F.noLoaf }; };
  return true; })()`;

// The main process's side of a scene: paint times, and the page's numbers.
const PAINTS = `const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; const P = []; const on = (_e, _d, _i) => P.push(now()); win.webContents.on('paint', on);
  const js = (c) => win.webContents.executeJavaScript(c, true); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`;
// Presented frames: the paints from the drag's first step to 50 ms after its last.
const FINISH = `await sleep(400); win.webContents.off('paint', on); const page = await js('window.__ft.stop()'); const D = P.filter((t) => t >= t0 && t <= t1 + 50); return { paints: D.slice(1).map((t, i) => t - D[i]), t0, t1, paintTimes: P, ...page };`;

const windowDrag = `${PAINTS}
  const w0 = ${1280 * K}, w1 = ${900 * K}, h = ${820 * K}, steps = 30;
  win.setContentSize(w0, h); await sleep(800); await js('window.__ft.start()');
  const sizes = []; for (let i = 1; i <= steps; i++) sizes.push(Math.round(w0 + (w1 - w0) * i / steps)); for (let k = 0; k < 4; k++) sizes.push(w1); for (let i = steps - 1; i >= 0; i--) sizes.push(Math.round(w0 + (w1 - w0) * i / steps));
  ${TRACE ? "await electron.contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'blink', 'gpu', 'cc', 'viz', 'toplevel', 'disabled-by-default-v8.gc'] });" : ''}
  const t0 = now(); for (const w of sizes) { win.setContentSize(w, h); await sleep(16); } const t1 = now();
  ${TRACE ? `await sleep(300); await electron.contentTracing.stopRecording(${JSON.stringify(path.resolve(TRACE || '.'))});` : ''}
  ${FINISH}`;
const dividerDrag = `${PAINTS}
  const g = await js('(() => { const b = document.querySelector("#split .gutter").getBoundingClientRect(); return { x: (b.x + b.width / 2) * devicePixelRatio, y: (b.y + b.height / 2) * devicePixelRatio }; })()');
  const x = Math.round(g.x), y = Math.round(g.y), by = ${-200 * K}, steps = 30, wc = win.webContents;
  await js('window.__ft.start()');
  wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  const xs = []; for (let i = 1; i <= steps; i++) xs.push(Math.round(x + by * i / steps)); for (let k = 0; k < 4; k++) xs.push(x + by); for (let i = steps - 1; i >= 0; i--) xs.push(Math.round(x + by * i / steps));
  const t0 = now(); for (const px of xs) { wc.sendInputEvent({ type: 'mouseMove', x: px, y, button: 'left' }); await sleep(16); } const t1 = now();
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  ${FINISH}`;

let hub = null;
const raw = {};
try {
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true });
  const steps = [
    { ready: true },
    { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2 && ${R}.term().attached && ${R}.term().ready`, timeout: 30000 },
    { size: [1280 * K, 820 * K] }, { sleep: 800 },
    { js: `(() => { const b = document.querySelector('[aria-label="Hide the panel"]'); if (b) b.click(); return true; })()` }, { sleep: 500 },
  ];
  if (LINES > 0) {
    steps.push({ type: `sh ${FILL}\r` });
    steps.push({ until: `${R}.term().term.buffer.normal.length >= ${Math.min(LINES, 9000)} && /%\\s*$/.test(${R}.term().term.buffer.normal.getLine(${R}.term().term.buffer.normal.baseY + ${R}.term().term.buffer.normal.cursorY).translateToString(true))`, timeout: 60000, soft: true }, { sleep: 1500 });
  }
  steps.push({ save: { expr: `({ lines: ${R}.term().term.buffer.normal.length, cols: ${R}.term().term.cols, rows: ${R}.term().term.rows, renderer: ${R}.term().renderer, xterm: (() => { try { return ${R}.term().term._core.constructor.name; } catch { return ''; } })() })`, out: path.join(work, 'state.json') } });
  steps.push({ js: INSTRUMENT });
  steps.push({ main: windowDrag, out: path.join(work, 'window.json') }, { sleep: 600 });
  // A split: the filled pane on the left, a new shell on the right.
  steps.push({ js: `${R}.onCommand('split', 'right'), true` }, { sleep: 1500 }, { until: `${R}.views()[1] && ${R}.views()[1].ready`, timeout: 10000 }, { sleep: 800 }, { js: INSTRUMENT });
  steps.push({ main: dividerDrag, out: path.join(work, 'divider.json') }, { sleep: 600 });
  steps.push({ save: { expr: `({ lines: ${R}.views()[0].term.buffer.normal.length, cols: ${R}.views()[0].term.cols })`, out: path.join(work, 'state-after.json') } });
  fs.mkdirSync(path.join(root, 'apphome'), { recursive: true });
  await runApp({ name: 'ft', work, rt, bin: BIN, home: path.join(root, 'apphome'), hubUrl: hub.url, timeoutMs: 300000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_TEST_SCALE: String(K) }, width: 1280 * K, height: 820 * K, steps });
  for (const f of ['state', 'window', 'divider', 'state-after']) { try { raw[f] = JSON.parse(fs.readFileSync(path.join(work, `${f}.json`), 'utf8')); } catch { raw[f] = null; } }
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}

const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const FRAME = 1000 / 60;
function summary(s) {
  if (!s) return null;
  // Frames dropped: each interval counts the frames it spans beyond one.
  const dropped = (xs) => sum(xs.map((d) => Math.max(0, Math.round(d / FRAME) - 1)));
  const st = (xs) => ({ n: xs.length, p50: r1(pct(xs, 0.5)), p95: r1(pct(xs, 0.95)), max: r1(xs.length ? Math.max(...xs) : 0), over16_7: xs.filter((d) => d > FRAME + 0.5).length, dropped: dropped(xs) });
  const ms = (xs) => ({ n: xs.length, p50: r1(pct(xs, 0.5)), p95: r1(pct(xs, 0.95)), max: r1(xs.length ? Math.max(...xs) : 0), total: r1(sum(xs)) });
  return {
    dragMs: r1(s.t1 - s.t0),
    rafFrames: st(s.raf),
    presentedFrames: st(s.paints),
    longTasks: { n: s.long.length, max: r1(s.long.length ? Math.max(...s.long) : 0), over50: s.long.filter((d) => d > 50).length, all: s.long.map(r1).slice(0, 30), unsupported: s.noLong },
    longAnimationFrames: { n: s.loaf.length, max: r1(s.loaf.length ? Math.max(...s.loaf.map((x) => x.ms)) : 0), unsupported: s.noLoaf },
    xtermResize: { ...ms(s.resize.map((x) => x.ms)), byView: [0, 1].map((v) => ms(s.resize.filter((x) => x.v === v).map((x) => x.ms))), colsChanges: s.resize.filter((x, i, a) => i === 0 || x.cols !== a[i - 1].cols).length, maxLines: Math.max(0, ...s.resize.map((x) => x.lines)) },
    fit: ms(s.fit.map((x) => x.ms)),
  };
}
const result = { lines: LINES, scale: K, state: raw.state, stateAfter: raw['state-after'], windowDrag: summary(raw.window), dividerDrag: summary(raw.divider) };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ ...result, raw }, null, 2));
console.log(JSON.stringify(result, null, 2));
