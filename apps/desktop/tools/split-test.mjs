#!/usr/bin/env node
// Splits, in the app (the picture ravenry-split.html, B1; app.ts SplitInfo):
//   - Cmd+D splits the pane in front: a new shell beside it, with the
//     keyboard, one xterm.js per pane on screen; the tab shows "2";
//   - Cmd+Option+arrows and a click move the keyboard between the panes;
//   - dragging the divider resizes (kept), a double click evens;
//   - Cmd+Shift+Enter shows the focused pane alone, and back;
//   - Cmd+W closes the focused pane; the tab is whole again;
//   - a tab dragged onto an edge of the pane in front splits it, the edge
//     lit with one label; a tab already split says so and stays;
//   - an agent's own pane opens as a split beside its tab, without the
//     keyboard;
//   - relaunched, the splits come back.
// Pictures in dark and light.
//
//   node tools/split-test.mjs [OUT] [--exe APP_EXECUTABLE]
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'split-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsp-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500) : ''}`); if (!ok) fails++; };

// The panes take SMOKE_RAVENRYD from this daemon (an agent's ravenry new, below).
const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state'), SMOKE_RAVENRYD: BIN, RAVENRY_PANE_PASS: 'SMOKE_RAVENRYD' };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'split-test' });
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', 'echo the session pane; exec cat'], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
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
// The tab in front, its split, both views' panes, the strip, the focused view.
const SNAP = `(() => { const S = ${R}.S; const v = S.view; const t = v.kind === 'tab' ? S.tabs.find((x) => x.id === v.id) : null; const [a, b] = ${R}.views();
  const r0 = document.getElementById('pbox0').getBoundingClientRect(), r1 = document.getElementById('pbox1').getBoundingClientRect();
  return { front: t ? t.id : null, split: t && t.split ? { ...t.split } : null, a: a && a.attached ? a.attached.pane : null, b: b && b.attached ? b.attached.pane : null, focused: ${R}.term().attached ? ${R}.term().attached.pane : null,
    strip: [...document.querySelectorAll('#tabs .tabrow .tab[data-tab]')].map((e) => ({ id: e.dataset.tab, two: !!e.querySelector('.pc2') })), b1: !document.getElementById('pbox1').hidden, b0: !document.getElementById('pbox0').hidden, w0: Math.round(r0.width), w1: Math.round(r1.width),
    heads: [...document.querySelectorAll('.phead:not([hidden]) b')].map((e) => e.textContent), badge: [...document.querySelectorAll('.phead .ag')].map((e) => e.textContent), dz: document.getElementById('dropzone').hidden ? null : document.getElementById('dropzone').textContent,
    guestPane: t && t.split ? (S.tabs.find((x) => x.id === t.split.guest) || {}).pane : null, tabs: S.tabs.map((x) => ({ id: x.id, host: x.host || null, pane: x.pane || null, name: x.name || null })) }; })()`;
const save = (name) => ({ save: { expr: SNAP, out: path.join(work, `${name}.json`) } });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
// Drag a tab (by its id expression) over the pane in front, near an edge (fx, fy of its box), then drop or not.
const dragTo = (idExpr, fx, fy, drop) => `(() => { const id = ${idExpr}; const tab = document.querySelector('#tabs .tab[data-tab="' + id + '"]'); const sp = document.getElementById('split'); const r = sp.getBoundingClientRect(); const dt = new DataTransfer();
  tab.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
  sp.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  ${drop ? "sp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y })); tab.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));" : ''} return true; })()`;
const FRONT = `${R}.S.view.id`;
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0' };
const quiet = (cmd) => `${cmd}\r`;

try {
  await runApp({ name: 'first', work, rt, bin: EXE ? undefined : BIN, cli: BIN, exe: EXE || undefined, home, hubUrl, env, width: 1440, height: 900, steps: [
    { ready: true },
    { until: `${R}.term().attached`, timeout: 15000 },
    // A shell tab in front (A), split with Cmd+D.
    { js: `${R}.newShell()` },
    { until: `${R}.S.tabs.length >= 2 && ${R}.term().attached && ${R}.S.view.kind === 'tab'`, timeout: 10000 },
    { sleep: 600 },
    { js: `window.__splitHost = ${FRONT}; ${R}.onCommand('split', 'right')` },
    { until: `(() => { const t = ${R}.S.tabs.find((x) => x.id === window.__splitHost); return t && t.split && ${R}.views()[1] && ${R}.views()[1].attached; })()`, timeout: 10000 },
    { sleep: 800 },
    save('split'),
    { shot: path.join(OUT, 'split-dark.png') },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'split-light.png') }, { theme: 'dark' },
    // Focus: Cmd+Option+Left, then a click in the right pane.
    { js: `${R}.onCommand('focus-pane', 'left')` }, { sleep: 300 },
    save('focus-left'),
    { click: '#pbox1 .term-host' }, { sleep: 300 },
    save('focus-click'),
    // Resize: drag the divider 200 px left; a double click evens it.
    { drag: '#split > .gutter', by: [-200, 0] }, { sleep: 400 },
    save('resized'),
    { dblclick: '#split > .gutter' }, { sleep: 400 },
    save('evened'),
    // Zoom the focused pane, and back.
    { js: `${R}.onCommand('zoom-pane')` }, { sleep: 400 },
    save('zoomed'),
    { js: `${R}.onCommand('zoom-pane')` }, { sleep: 400 },
    save('unzoomed'),
    // Cmd+W in the focused (right) pane: it closes, the tab is whole.
    { js: `window.__closedPane = ${R}.term().attached.pane; ${R}.onCommand('close-tab')` },
    { until: `!(${R}.S.tabs.find((x) => x.id === window.__splitHost) || {}).split`, timeout: 10000 },
    { sleep: 400 },
    save('closed'),
    { save: { expr: 'window.__closedPane', out: path.join(work, 'closed-pane.json') } },
    // A second shell tab (C), then back to A and drag C onto A's right edge.
    { js: `${R}.newShell()` },
    { until: `${FRONT} !== window.__splitHost`, timeout: 10000 },
    { sleep: 600 },
    { js: `window.__dragged = ${FRONT}; ${R}.setView({ kind: 'tab', id: window.__splitHost })` },
    { sleep: 600 },
    { js: dragTo('window.__dragged', 0.9, 0.5, false) },
    { sleep: 200 },
    save('drag-over'),
    { shot: path.join(OUT, 'drop-dark.png') },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'drop-light.png') }, { theme: 'dark' },
    { js: dragTo('window.__dragged', 0.9, 0.5, true) },
    { until: `(${R}.S.tabs.find((x) => x.id === window.__splitHost) || {}).split`, timeout: 5000 },
    { sleep: 600 },
    save('dropped'),
    // Another tab dragged onto the tab already split: it says so, nothing moves.
    { js: `${R}.newShell()` },
    { until: `${FRONT} !== window.__splitHost`, timeout: 10000 },
    { sleep: 500 },
    { js: `window.__third = ${FRONT}; ${R}.setView({ kind: 'tab', id: window.__splitHost })` },
    { sleep: 500 },
    { js: dragTo('window.__third', 0.5, 0.95, false) },
    { sleep: 200 },
    save('refused-over'),
    { js: dragTo('window.__third', 0.5, 0.95, true) },
    { sleep: 400 },
    save('refused'),
    // An agent's pane: the third tab's shell starts one with ravenry new.
    { js: `${R}.setView({ kind: 'tab', id: window.__third })` },
    { until: `${R}.term().attached && ${R}.term().ready`, timeout: 10000 },
    { sleep: 800 },
    { type: quiet('"$SMOKE_RAVENRYD" new --name "dev server" -- /bin/sh -c "echo dev server up; exec sleep 600" >/dev/null') },
    { until: `(${R}.S.tabs.find((x) => x.id === window.__third) || {}).split && ${R}.views()[1] && ${R}.views()[1].attached`, timeout: 15000 },
    { sleep: 800 },
    save('agent'),
    { shot: path.join(OUT, 'agent-dark.png') },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'agent-light.png') }, { theme: 'dark' },
    { save: { expr: `({ host: window.__splitHost, dragged: window.__dragged, third: window.__third })`, out: path.join(work, 'ids.json') } },
  ] });
  const ids = read('ids') || {};
  const sp = read('split');
  check('Cmd+D: the tab splits, a new shell on the right with the keyboard, one xterm.js per pane', !!sp?.split && sp.split.side === 'right' && sp.split.focus === 1 && sp.a && sp.b && sp.a !== sp.b && sp.focused === sp.b && sp.b1, sp);
  check('the split tab shows "2" on the strip, its second pane not a tab of its own', !!sp && sp.strip.some((x) => x.id === sp.front && x.two) && !sp.strip.some((x) => x.id === sp.split.guest), sp?.strip);
  check('each pane has its header once split', sp?.heads.length === 2, sp?.heads);
  const fl = read('focus-left'), fc = read('focus-click');
  check('Cmd+Option+Left: the keyboard to the left pane; a click in the right one: back there', fl?.split.focus === 0 && fl.focused === fl.a && fc?.split.focus === 1 && fc.focused === fc.b, { left: fl?.split, click: fc?.split });
  const rs = read('resized'), ev = read('evened');
  check('dragging the divider resizes, and the size is kept; a double click evens', !!rs && rs.split.size < 45 && rs.w0 < rs.w1 - 100 && !!ev && ev.split.size === 50 && Math.abs(ev.w0 - ev.w1) < 20, { resized: rs && [rs.split.size, rs.w0, rs.w1], evened: ev && [ev.split.size, ev.w0, ev.w1] });
  const zo = read('zoomed'), uz = read('unzoomed');
  check('Cmd+Shift+Enter: the focused pane alone, and back', zo?.split.zoom === true && !zo.b0 && zo.b1 && uz?.split.zoom === false && uz.b0 && uz.b1, { zoomed: zo && [zo.b0, zo.b1], back: uz && [uz.b0, uz.b1] });
  const cl = read('closed');
  const closedPane = read('closed-pane');
  const panesNow = (await dc.request('pane.list', {})).panes.map((p) => p.id);
  check('Cmd+W in the focused pane closes it (its process too); the tab is whole again', !!cl && !cl.split && !cl.b1 && !!closedPane && !panesNow.includes(closedPane), { split: cl?.split, closedPane, gone: !panesNow.includes(closedPane) });
  const dov = read('drag-over'), dr = read('dropped');
  check('a tab dragged near the right edge: that edge lit, one label, "Split right"', dov?.dz === 'Split right', dov?.dz);
  check('dropped there: the tab splits with it on the right, it leaves the strip and has the keyboard', !!dr?.split && dr.split.side === 'right' && dr.split.guest === ids.dragged && dr.split.focus === 1 && !dr.strip.some((x) => x.id === ids.dragged), { split: dr?.split, strip: dr?.strip });
  const ro = read('refused-over'), rf = read('refused');
  check('a tab dragged onto a tab already split: it says so, and nothing moves', /Already split/.test(ro?.dz || '') && rf?.split?.guest === ids.dragged && rf.strip.some((x) => x.id === ids.third), { label: ro?.dz, split: rf?.split });
  const ag = read('agent');
  check('an agent\'s own pane opens as a split beside its tab, without the keyboard', !!ag?.split && ag.front === ids.third && ag.split.focus === 0 && ag.focused === ag.a && ag.b && ag.badge.length === 1, { split: ag?.split, a: ag?.a, b: ag?.b, focused: ag?.focused, badge: ag?.badge });

  // Relaunched: both splits come back.
  await runApp({ name: 'second', work, rt, bin: EXE ? undefined : BIN, cli: BIN, exe: EXE || undefined, home, hubUrl, env, width: 1440, height: 900, steps: [
    { ready: true },
    { until: `${R}.S.restored && ${R}.S.tabs.length >= 3`, timeout: 15000 },
    { sleep: 1500 },
    { js: `${R}.setView({ kind: 'tab', id: ${JSON.stringify(ids.host)} })` },
    { until: `${R}.views()[1] && ${R}.views()[1].attached`, timeout: 10000 },
    { sleep: 600 },
    save('relaunch'),
  ] });
  const rl = read('relaunch');
  check('relaunched: the splits come back, with their panes', !!rl?.split && rl.split.guest === ids.dragged && rl.b && rl.a && rl.tabs.some((x) => x.id === ids.third) && rl.tabs.some((x) => x.host === ids.third), { split: rl?.split, tabs: rl?.tabs });
  console.log(`pictures: ${OUT}`);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  clearInterval(tick);
  for (const s of streams) s.end();
  srv.close();
  dc.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
