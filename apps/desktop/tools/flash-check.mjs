// No terminal flashes and no half-drawn view, measured on every frame the
// window draws (offscreen, so each composited frame comes through the
// 'paint' event: tools/frames.cjs, tools/flash-scenes.cjs):
//   - the window resized 1280 -> 900 -> 1280 in 30 sizes each way at 60 Hz,
//     with a pane full of `ls -la`, then with a split whose other pane runs a
//     Claude-like program that clears and draws its screen again at each
//     size (as Claude Code does);
//   - the split's divider dragged 200 px and back at 60 Hz;
//   - switches from one view to another with a real click: a tab, a
//     session, a project page, the brief, Decisions, the in-app pages,
//     Start, the panel opened and closed.
// A pane blank (under a third of its usual ink) or a frame unlike both of
// its neighbours is a flash; after a click, a frame like neither the view
// before nor the one it ends on is half-drawn. Each scene's frames from the
// middle (and each bad one) are saved as pictures.
//
//   node tools/flash-check.mjs [OUT] [--exe APP_EXECUTABLE] [--only resize|switch]
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
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const onlyAt = argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? argv.splice(onlyAt, 2)[1] : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'flash-check'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvfl-'));
const work = path.join(root, 'w');
const rt = path.join(root, 'r');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500) : ''}`); if (!ok) fails++; };
const R = 'window.__ravenry';
const SCENES = path.join(HERE, 'flash-scenes.cjs');
// The window drawn as on a Retina screen (its zoom, the window that many times bigger): canvases land on a grid of device pixels as they do there.
const K = Number(process.env.FLASH_SCALE || 2);

// A program that draws itself as Claude Code does in a Ravenry pane: at
// each size, its whole screen again in one synchronized update (BSU, the
// screen and its scrollback cleared, the transcript wrapped to the new
// width, longer than the screen, its input box, ESU), written at once.
// Its first line is a marker: seen twice in the terminal is a duplicate.
const TUI = path.join(work, 'tui.mjs');
fs.writeFileSync(TUI, `const words = 'the quick brown fox jumps over the lazy dog while seven wizards quietly judge boxing matches in the old harbour hall'.split(' ');
const out = (s) => process.stdout.write(s);
function draw() {
  const c = process.stdout.columns || 80, r = process.stdout.rows || 24;
  const lines = ['@@ transcript start @@']; let i = 0;
  while (lines.length < Math.round(r * 1.5)) { let l = ''; for (;;) { const w = words[i % words.length]; if (l.length + w.length + 1 > c - 1) break; l += (l ? ' ' : '') + w; i++; } lines.push(l); }
  const w = c - 2;
  const box = ['\\u256d' + '\\u2500'.repeat(w - 2) + '\\u256e', '\\u2502 > ' + ' '.repeat(w - 5) + '\\u2502', '\\u2570' + '\\u2500'.repeat(w - 2) + '\\u256f', '  ? for shortcuts'];
  out('\\x1b[?2026h\\x1b[2J\\x1b[3J\\x1b[H' + [...lines, '', ...box].join('\\r\\n') + '\\x1b[?2026l');
}
process.stdout.on('resize', draw);
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => { if (String(d).includes('\\x03')) process.exit(0); });
draw();
`);

// What xterm.js draws of the program's pane, at each of its renders: none
// of its rows (blank), its marker twice in the terminal (a duplicate), a
// word cut by a wrap the program did not make (reflowed).
const WATCH = `(() => { const t = ${R}.views()[1].term; const W = window.__watch = { renders: 0, blank: 0, dup: 0, midword: 0, at: [] };
  t.onRender(() => { const b = t.buffer.active; W.renders++; let empty = true, marks = 0, cut = false;
    for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (!l) continue; const s = l.translateToString(true); if (s.includes('@@ transcript start @@')) marks++;
      if (y >= b.viewportY && y < b.viewportY + t.rows) { if (s.trim()) empty = false; if (l.isWrapped && y > 0) { const p = b.getLine(y - 1).translateToString(true); if (/[a-z]$/i.test(p) && /^[a-z]/i.test(s)) cut = true; } } }
    if (empty) W.blank++; if (marks > 1) W.dup++; if (cut) W.midword++; if ((empty || marks > 1 || cut) && W.at.length < 10) W.at.push({ n: W.renders, empty, marks, cut }); }); return true; })()`;

// Every frame in which a terminal's canvas was resized (which clears it)
// and not drawn again before the frame was shown: measured in the page,
// after each frame (a rAF, then a task), so it holds for a window on the
// screen too, where nothing forces a paint as a capture does.
const CANVAS_WATCH = `(() => { if (window.__cw) return true; const C = window.__cw = { resized: 0, undrawn: 0, frames: 0, at: [] };
  const wd = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width'), hd = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const hook = (c) => { if (c.__cw) return; let gl = null; try { gl = c.getContext('webgl2'); } catch {} if (!gl) { c.__cw = 'no'; return; } c.__cw = { clear: false };
    const mark = (d) => ({ get() { return d.get.call(this); }, set(v) { if (v !== d.get.call(this)) { c.__cw.clear = true; C.resized++; } d.set.call(this, v); }, configurable: true });
    Object.defineProperty(c, 'width', mark(wd)); Object.defineProperty(c, 'height', mark(hd));
    for (const f of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const o = gl[f].bind(gl); gl[f] = (...a) => { c.__cw.clear = false; return o(...a); }; } };
  const all = () => [...document.querySelectorAll('.term-host canvas')];
  const tick = () => requestAnimationFrame(() => setTimeout(() => { C.frames++; for (const c of all()) { hook(c); if (c.__cw && c.__cw !== 'no' && c.__cw.clear) { C.undrawn++; c.__cw.clear = false; if (C.at.length < 20) C.at.push(C.frames); } } tick(); }, 0));
  for (const c of all()) hook(c); tick(); return true; })()`;
const CANVAS_TAKE = (out) => ({ save: { expr: `(() => { const C = window.__cw; const r = { resized: C.resized, undrawn: C.undrawn, frames: C.frames, at: C.at.slice() }; Object.assign(C, { resized: 0, undrawn: 0, frames: 0, at: [] }); return r; })()`, out } });

const scene = (name, fn, opts) => ({ main: `const S = require(${JSON.stringify(SCENES)}); return S.${fn}(win, ${opts});`, out: path.join(work, `${name}.json`) });

let hub = null;
try {
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true });
  const steps = [
    { ready: true },
    { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2 && ${R}.term().attached && ${R}.term().ready`, timeout: 30000 },
    { size: [1280 * K, 820 * K] }, { sleep: 800 },
  ];
  if (ONLY !== 'switch') {
    // The panel hidden, so the panes' edges follow the window's width alone.
    steps.push({ js: `(() => { const b = document.querySelector('[aria-label="Hide the panel"]'); if (b) b.click(); return true; })()` }, { sleep: 500 });
    // A pane full of text.
    steps.push({ type: 'ls -la /usr/bin\r', after: 1500 });
    steps.push({ js: CANVAS_WATCH }, CANVAS_TAKE(path.join(work, 'canvas-start.json')));
    // The pane's region at any window width: its left and top stay, its right follows the window.
    const one = `((w) => { const L = HOSTL, T = HOSTT, RI = HOSTR, B = HOSTB; return { pane: { x: L + 16, y: T + 12, w: w - RI - 24 - (L + 16), h: B - 24 } }; })`;
    steps.push({ save: { expr: `(() => { const b = document.getElementById('term').getBoundingClientRect(); return { l: b.left, t: b.top, r: innerWidth - b.right, h: b.height }; })()`, out: path.join(work, 'host.json') } });
    steps.push({ main: `const h = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(work, 'host.json'))}, 'utf8')); const S = require(${JSON.stringify(SCENES)}); return S.resizeWindow(win, { w0: ${1280 * K}, w1: ${900 * K}, h: ${820 * K}, name: 'resize-one-pane', dir: ${JSON.stringify(path.join(OUT, 'frames'))}, regions: ${JSON.stringify(one)}.replace('HOSTL', h.l).replace('HOSTT', h.t).replace('HOSTR', h.r).replace('HOSTB', h.h) });`, out: path.join(work, 'resize-one-pane.json') }, { sleep: 300 }, CANVAS_TAKE(path.join(work, 'canvas-resize-one-pane.json')));
    // What macOS shows where the window grows before the page is drawn there: the terminal's colour.
    steps.push({ main: `return win.getBackgroundColor();`, out: path.join(work, 'win-bg.json') }, { save: { expr: `(() => { const m = getComputedStyle(document.getElementById('term')).backgroundColor.match(/\\d+/g).slice(0, 3); return '#' + m.map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase(); })()`, out: path.join(work, 'term-bg.json') } });
    // A split: a new shell on the right running the Claude-like program.
    steps.push({ js: `${R}.onCommand('split', 'right'), true` }, { sleep: 1500 });
    steps.push({ until: `${R}.views()[1] && ${R}.views()[1].ready`, timeout: 10000 });
    steps.push({ type: `${process.execPath} ${TUI}\r`, after: 2000 });
    steps.push({ save: { expr: `(() => { const a = document.getElementById('pbox0').getBoundingClientRect(), b = document.getElementById('pbox1').getBoundingClientRect(), s = document.getElementById('split').getBoundingClientRect(); return { l: s.left, t: a.top, r: innerWidth - s.right, h: a.height, a: [a.left, a.right], b: [b.left, b.right] }; })()`, out: path.join(work, 'split.json') } });
    steps.push({ js: WATCH }, { js: CANVAS_WATCH }, CANVAS_TAKE(path.join(work, 'canvas-before-split.json')));
    // Each pane's region at a window width: the split stays at its share.
    steps.push({ main: `const h = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(work, 'split.json'))}, 'utf8')); const share = (h.a[1] - h.l) / (h.b[1] - h.l); const S = require(${JSON.stringify(SCENES)});
      const regions = (w) => { const right = w - h.r; const div = h.l + (right - h.l) * share; return { left: { x: h.l + 16, y: h.t + 40, w: div - 24 - (h.l + 16), h: h.h - 52 }, right: { x: div + 26, y: h.t + 40, w: right - 24 - (div + 26), h: h.h - 52 } }; };
      return S.resizeWindow(win, { w0: ${1280 * K}, w1: ${900 * K}, h: ${820 * K}, name: 'resize-split', dir: ${JSON.stringify(path.join(OUT, 'frames'))}, regions });`, out: path.join(work, 'resize-split.json') });
    steps.push({ sleep: 300 }, CANVAS_TAKE(path.join(work, 'canvas-resize-split.json')));
    steps.push({ save: { expr: 'window.__watch', out: path.join(work, 'watch-resize-split.json') } }, { js: `(() => { const W = window.__watch; Object.assign(W, { renders: 0, blank: 0, dup: 0, midword: 0, at: [] }); return true; })()` });
    // The divider dragged 200 px left and back: the regions each pane always holds.
    steps.push({ main: `const h = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(work, 'split.json'))}, 'utf8')); const S = require(${JSON.stringify(SCENES)});
      const regions = (w) => { const right = w - h.r; return { left: { x: h.l + 16, y: h.t + 40, w: h.a[1] - 200 - 24 - (h.l + 16), h: h.h - 52 }, right: { x: h.b[0] + 26, y: h.t + 40, w: right - 24 - (h.b[0] + 26), h: h.h - 52 } }; };
      return S.dragDivider(win, { name: 'divider-drag', by: -200, dir: ${JSON.stringify(path.join(OUT, 'frames'))}, regions });`, out: path.join(work, 'divider-drag.json') });
  }
  if (ONLY !== 'switch') steps.push({ save: { expr: 'window.__watch', out: path.join(work, 'watch-divider-drag.json') } }, { sleep: 300 }, CANVAS_TAKE(path.join(work, 'canvas-divider-drag.json')));
  if (ONLY !== 'resize') {
    // Two shell tabs, each full of text, and the panel shown.
    steps.push({ js: `(() => { const b = document.querySelector('[aria-label="Session panel"]'); if (b && !b.classList.contains('on')) b.click(); return true; })()` }, { sleep: 400 });
    steps.push({ js: `${R}.newShell(), true` }, { until: `${R}.S.tabs.filter((t) => t.kind === 'shell').length >= 2 && ${R}.term().ready`, timeout: 10000 }, { sleep: 600 });
    steps.push({ type: 'ls -la /usr/lib\r', after: 1200 });
    const el = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
    const btn = (re) => `[...document.querySelectorAll('#panel button')].find((b) => ${re}.test(b.textContent))`;
    const tab = (n) => `document.querySelectorAll('#tabs .tab[data-tab]')[${n}]`;
    const SW = [
      { name: 'tab to session', at: el('[data-key="garden-planner/sf-1"]') },
      { name: 'session to brief', at: btn('/Open brief/') },
      { name: 'brief to Decisions', at: el('[data-page="decisions"]') },
      { name: 'Decisions to an idle project', at: el('[data-key="project:weather-widget"]') },
      { name: 'idle project to Alerts', at: el('[aria-label="Alerts"]') },
      { name: 'Alerts to Learn', at: el('[aria-label="Learn Ravenry"]') },
      { name: 'Learn to Plans', at: el('[data-page="plans"]') },
      { name: 'Plans to session', at: el('[data-key="garden-planner/sf-1"]') },
      { name: 'session to gallery', at: btn('/^Gallery/') },
      { name: 'gallery to Start', at: el('[aria-label="New session"]') },
      { name: 'Start to tab', at: tab(0) },
      { name: 'tab to tab', at: tab(1) },
      { name: 'tab to tab back', at: tab(0) },
      { name: 'panel closed', at: el('[aria-label="Session panel"]'), resize: true },
      { name: 'panel opened', at: el('[aria-label="Session panel"]'), resize: true },
    ];
    steps.push({ save: { expr: `(() => { const b = document.getElementById('side').getBoundingClientRect(); return { x: b.right + 1, y: 0, w: innerWidth - b.right - 1, h: innerHeight }; })()`, out: path.join(work, 'region.json') } });
    steps.push({ main: `const rg = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(work, 'region.json'))}, 'utf8')); const S = require(${JSON.stringify(SCENES)}); return S.switches(win, { list: ${JSON.stringify(SW)}, region: rg, dir: ${JSON.stringify(path.join(OUT, 'switch-frames'))} });`, out: path.join(work, 'switches.json') });
  }
  fs.mkdirSync(path.join(root, 'apphome'), { recursive: true });
  await runApp({ name: 'flash', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home: path.join(root, 'apphome'), hubUrl: hub.url, timeoutMs: 400000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_TEST_SCALE: String(K) }, width: 1280 * K, height: 820 * K, steps });
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch { return null; } };
  const wbg = read('win-bg.json'), tbg = read('term-bg.json');
  if (ONLY !== 'switch') check(`the window's own colour (shown at its edge while it grows) is the terminal's at that edge: ${wbg} and ${tbg}`, !!wbg && !!tbg && String(wbg).toUpperCase().slice(-6) === String(tbg).toUpperCase().slice(-6));
  for (const n of ['resize-one-pane', 'resize-split', 'divider-drag']) {
    const r = read(`${n}.json`);
    if (!r) { if (ONLY !== 'switch') check(`${n}: measured`, false); continue; }
    fs.writeFileSync(path.join(OUT, `${n}.json`), JSON.stringify(r, null, 2));
    check(`${n}: no pane blank or flashed in any of ${r.framesDuringDrag} frames of the drag (${r.frames} kept)`, r.badFrames === 0, { bad: r.badFrames, regions: r.regions });
    const cv = read(`canvas-${n}.json`);
    if (cv) check(`${n}: no frame shown with a terminal canvas resized and not drawn again (${cv.undrawn} of ${cv.frames} frames; ${cv.resized} canvas resizes)`, cv.undrawn === 0 && cv.resized > 0, cv.at);
    const w = read(`watch-${n}.json`);
    // Its text reflows at once and the program draws itself again at the
    // new size a moment later (as in any terminal): a word cut by that
    // reflow is counted, never a blank pane or its screen twice.
    if (w) check(`${n}: the program's pane, in ${w.renders} renders: none blank (${w.blank}), none with its screen twice (${w.dup}); ${w.midword} reflowed before the program drew itself again`, w.renders > 10 && !w.blank && !w.dup, w.at);
  }
  const sw = read('switches.json');
  if (ONLY !== 'resize') {
    if (!sw) check('switches: measured', false);
    else {
      fs.writeFileSync(path.join(OUT, 'switches.json'), JSON.stringify(sw, null, 2));
      for (const r of sw) {
        if (r.error) { check(`${r.name}: measured`, false, r.error); continue; }
        // The panel opened or closed resizes the panes: their text reflows at
        // once, and a program in one draws itself again at its new size a
        // moment later (as in any terminal); never blank, never one frame off.
        if (r.resize) check(`${r.name}: no blank or flashed frame (${r.blank} blank, ${r.flash} flashed; ${r.halfDrawn} frames of text reflowed before the program in the pane drew itself again), in place ${r.fromClickMs} ms after the click`, r.changed && !r.blank && !r.flash, r.frames.slice(0, 12).join(' | '));
        else check(`${r.name}: no half-drawn, blank or flashed frame (${r.halfDrawn} half-drawn, ${r.blank} blank, ${r.flash} flashed), the view in place ${r.fromClickMs} ms after the click (${r.settledMs} after the press)${r.changed ? '' : ' (NOTHING CHANGED)'}`, r.changed && !r.halfDrawn && !r.blank && !r.flash, r.frames.slice(0, 12).join(' | '));
      }
    }
  }
} catch (e) {
  check('measured', false, String(e.message || e).slice(0, 3000));
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
