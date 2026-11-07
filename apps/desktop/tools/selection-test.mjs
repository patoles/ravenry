#!/usr/bin/env node
// The selection and the middle are one thing (2026-11-07: the panel showed
// a session while the launch shell stayed in front, and a click on its row
// did nothing: "why I need to click it again to select?"). The window runs
// offscreen on a stub hub that serves the shape of that day's state
// (test/fixtures/live-session-in-pane.json: a session in a Ravenry pane,
// also open in cmux, the project in Needs you) and sends it again every
// 300 ms, as a busy hub does; its pane is a real one in a test ravenryd.
//
//   - at launch the launch shell is in front, and the highlighted row, the
//     panel and the front tab name the same thing (none highlighted);
//   - a real mouse click on the session's row (press, pause, release, the
//     sidebar drawn again meanwhile) brings its pane to the front, and the
//     three agree; the click is in app.log with what it did;
//   - another session moving into Needs you leaves the front alone, says
//     so in a toast, and its Show brings it to the front; that toast is
//     still there after 9 s, the same session needing you again replaces
//     it (one toast, the new one), and the pointer over it keeps it;
//   - relaunched, the session that was in front is in front again, its pane
//     shown, with no launch shell opened for it.
//
// Usage: node build.mjs && node tools/selection-test.mjs [OUT]
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'selection-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsel-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r s');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The session's pane, in a daemon of the test's.
const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(HERE, '..', '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'selection-test' });
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', 'echo kite pane is here; exec cat'], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();
const KEY = `kite/ravenry:${pane.id}`;
const NOTES = 'notes/ev:c3c3c3c3-0000-4000-8000-000000000003';

// The stub hub: the fixture, sent again every 300 ms.
let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(state)); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tickTimer = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const TOASTS_EXPR = `[...document.querySelectorAll('#toast .ti')].map((e) => e.textContent)`;
// What the window shows in front, highlights and has in its panel, as keys.
const SEL = `(() => { const on = document.querySelector('#tabs .tab.on'); const sel = document.querySelector('#side .ss.sel'); const p = document.getElementById('panel'); return { front: on ? on.dataset.key : null, row: sel ? sel.dataset.key : null, panel: p.hidden ? null : p.dataset.key }; })()`;
const AGREE = `(() => { const s = ${SEL}; const session = !!s.front && !s.front.startsWith('tab:') && !s.front.startsWith('pane:'); return (session ? s.row === s.front || (s.row === null && ![...document.querySelectorAll('#side .ss')].some((e) => e.dataset.key === s.front)) : s.row === null) && (s.panel === null || s.panel === s.front); })()`;
const sig = (n) => path.join(work, `${n}.signal`);
const go = (n) => path.join(work, `${n}.go`);
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0' };

try {
  const feed = (async () => {
    while (!fs.existsSync(sig('arrive'))) await new Promise((r) => setTimeout(r, 50));
    // notes' session stops on a question: it moves into Needs you.
    const n = state.projects[1];
    state = { ...state, projects: [state.projects[0], { ...n, state: 'you', sessions: [{ ...n.sessions[0], state: 'asked', words: { line: 'Ship it?' } }] }] };
    fs.writeFileSync(go('arrive'), '1');
    // It goes back to work, then asks again: a second arrival for the same session.
    while (!fs.existsSync(sig('again'))) await new Promise((r) => setTimeout(r, 50));
    const n2 = state.projects[1];
    state = { ...state, projects: [state.projects[0], { ...n2, state: 'work', sessions: [{ ...n2.sessions[0], state: 'working', words: { line: 'Shipping' } }] }] };
    await new Promise((r) => setTimeout(r, 1200));
    state = { ...state, projects: [state.projects[0], { ...n2, state: 'you', sessions: [{ ...n2.sessions[0], state: 'asked', words: { line: 'Ship it now?' } }] }] };
    fs.writeFileSync(go('again'), '1');
  })();
  const [firstLog] = await Promise.all([runApp({ name: 'first', work, rt, bin: BIN, home, hubUrl, env, steps: [
    { ready: true },
    { until: `${R}.S.tabs.length === 1 && ${R}.term().attached && ${R}.S.hub && ${R}.S.hub.projects`, timeout: 15000 },
    { until: AGREE, timeout: 5000 },
    { save: { expr: SEL, out: path.join(work, 'launch.json') } },
    { click: `[...document.querySelectorAll('#side .ss')].find((e) => e.dataset.key === '${KEY}')`, clickJs: true, hold: 400 },
    { until: `${R}.term().ready && ${R}.term().attached && ${R}.term().attached.pane === '${pane.id}' && ${R}.text().includes('kite pane is here') && ${AGREE}`, timeout: 10000 },
    { save: { expr: SEL, out: path.join(work, 'clicked.json') } },
    { shot: path.join(OUT, 'selection-clicked.png') },
    { signal: sig('arrive') }, { wait: go('arrive') },
    { until: `!document.getElementById('toast').hidden && /needs you/.test(document.getElementById('toast').textContent)`, timeout: 10000 },
    { until: AGREE, timeout: 3000 },
    { save: { expr: SEL, out: path.join(work, 'arrived.json') } },
    // A toast with an action stays at least 12 s: still there at 9 s (it went at 8 s before).
    { sleep: 9000 },
    { save: { expr: `${TOASTS_EXPR}`, out: path.join(work, 'after9.json') } },
    // The same session needs you again: its toast is replaced, not stacked.
    { js: `document.querySelectorAll('#toast .ti').forEach((e) => { e.dataset.first = '1'; })` },
    { signal: sig('again') }, { wait: go('again') },
    { until: `${TOASTS_EXPR}.some((t) => t.includes('needs you')) && ${R}.S.hub.projects[1].sessions[0].words.line === 'Ship it now?'`, timeout: 10000 },
    { sleep: 1500 },
    { save: { expr: `${TOASTS_EXPR}`, out: path.join(work, 'again.json') } },
    { save: { expr: `[...document.querySelectorAll('#toast .ti')].filter((e) => e.dataset.first).length`, out: path.join(work, 'againOld.json') } },
    // The pointer over it pauses its time: still there 14 s later.
    { hover: '#toast .ti' }, { sleep: 14000 },
    { save: { expr: `${TOASTS_EXPR}`, out: path.join(work, 'hovered.json') } },
    { shot: path.join(OUT, 'selection-toast.png') },
    { hover: [700, 400] },
    { click: `[...document.querySelectorAll('#toast button')].find((b) => b.textContent === 'Show')`, clickJs: true },
    { until: `${R}.S.view.kind === 'session' && ${R}.S.view.key === '${NOTES}' && ${AGREE}`, timeout: 10000 },
    { save: { expr: SEL, out: path.join(work, 'shown.json') } },
    // Back to the kite session, the one in front when the app quits.
    { click: `[...document.querySelectorAll('#side .ss')].find((e) => e.dataset.key === '${KEY}')`, clickJs: true },
    { until: `${R}.term().attached && ${R}.term().attached.pane === '${pane.id}' && ${AGREE}`, timeout: 10000 },
    { save: { expr: `${R}.S.tabs.filter((t) => t.kind === 'shell').length`, out: path.join(work, 'shells1.json') } },
  ] }), feed]);
  const j = (f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8'));
  check('launch: the launch shell is in front; no row is highlighted, and the panel shows that shell', j('launch.json').front.startsWith('tab:') && j('launch.json').row === null && (j('launch.json').panel === null || j('launch.json').panel === j('launch.json').front), JSON.stringify(j('launch.json')));
  check('a real click on the row (the sidebar redrawn meanwhile) brings its pane to the front; row, panel and tab agree', j('clicked.json').front === KEY && j('clicked.json').row === KEY && j('clicked.json').panel === KEY, JSON.stringify(j('clicked.json')));
  check('another session moving into Needs you leaves the front alone (a toast says so)', j('arrived.json').front === KEY && j('arrived.json').row === KEY, JSON.stringify(j('arrived.json')));
  const needs = (f) => j(f).filter((t) => /^Sync settings in notes needs you: Ship it/.test(t)).length;
  check('no toast about the session in front (Kite tail), all along', ['after9.json', 'again.json', 'hovered.json'].every((f) => !j(f).some((t) => /Kite tail/.test(t))), JSON.stringify(j('hovered.json')));
  check('a toast with an action is still there 9 s after it came', needs('after9.json') === 1, JSON.stringify(j('after9.json')));
  check('the same session needing you again replaces its toast, never stacks a second', needs('again.json') === 1 && j('againOld.json') === 0, JSON.stringify([j('again.json'), j('againOld.json')]));
  check('the pointer over a toast keeps it (14 s later, over 12 s)', needs('hovered.json') === 1, JSON.stringify(j('hovered.json')));
  check('its Show brings it to the front; row, panel and tab agree', j('shown.json').front === NOTES && j('shown.json').row === NOTES, JSON.stringify(j('shown.json')));
  // What app.log gets (the packaged app writes it to the file; this build says it on its output).
  const log = firstLog;
  check('the click is a line in app.log with what it did', log.includes(`window: session click ${KEY}: its pane ${pane.id}`), log.split('\n').filter((l) => l.includes('window: session')).join(' | ') || '(no session lines)');

  await runApp({ name: 'second', work, rt, bin: BIN, home, hubUrl, env, steps: [
    { ready: true },
    { until: `${R}.term().ready && ${R}.term().attached && ${R}.term().attached.pane === '${pane.id}' && ${AGREE}`, timeout: 15000 },
    { save: { expr: `({ sel: ${SEL}, shells: ${R}.S.tabs.filter((t) => t.kind === 'shell').length })`, out: path.join(work, 'relaunch.json') } },
    { shot: path.join(OUT, 'selection-relaunch.png') },
  ] });
  const rl = j('relaunch.json');
  check('relaunched: the session that was in front is in front again, its pane shown; no launch shell opened for it', rl.sel.front === KEY && rl.sel.row === KEY && rl.shells === j('shells1.json'), JSON.stringify(rl));

  // Its pane is gone (its daemon ended it): at the next launch nothing of it
  // comes back, the launch shell is in front, and nothing is said.
  const dc2 = await connectSocket(sock, { name: 'selection-test' });
  await dc2.request('pane.close', { pane: pane.id });
  dc2.close();
  const third = await runApp({ name: 'third', work, rt, bin: BIN, home, hubUrl, env, steps: [
    { ready: true },
    { until: `${R}.term().ready && ${R}.term().attached && ${AGREE}`, timeout: 15000 },
    { sleep: 1500 },
    { save: { expr: `({ sel: ${SEL}, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent })`, out: path.join(work, 'gone.json') } },
  ] });
  const gn = j('gone.json');
  const asks = (third.match(/could not show pane/g) || []).length;
  if (asks) console.log(third.split('\n').filter((l) => /window:/.test(l)).join('\n'));
  check('its pane gone: the launch shell is in front, no toast, no repeated tries', gn.sel.front.startsWith('tab:') && gn.sel.row === null && !/Could not/.test(gn.toast) && asks === 0 && /is gone; the launch shell instead/.test(third), JSON.stringify({ ...gn, asks }));
} finally {
  clearInterval(tickTimer);
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
