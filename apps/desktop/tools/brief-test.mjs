#!/usr/bin/env node
// The brief in the app (src/renderer/briefdoc.ts), as the approved picture
// (ravenry-brief.html, H1, H2 and H3alt):
//   - the panel's card: the goal on one line, Next as at most 3 one-line
//     items from the newest dated entry of an older brief, and "Open
//     brief, 2 older entries";
//   - Open brief: a Brief tab beside the session, the brief as a page
//     (Goal, Rules, the Next step split into its dated entries newest first
//     and open, the Plan's checklist and count), "Updated <time> by
//     Claude" and Edit, which opens the file in the Markdown editor;
//   - an older entry opens on a click; a link opens in the browser;
//   - closing the tab goes back to the session.
// Pictures in dark and light.
//
//   node tools/brief-test.mjs [OUT] [--exe APP_EXECUTABLE]
import { hubState } from './stub-state.mjs';
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'brief-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvbf-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
const openLog = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (!ok) fails++; };

// The picture's brief: a Next step that grew a dated entry per session.
const GOAL = 'A landing page for Lumen that says what it does in one screen, on any phone, and loads in under a second.';
const WALL = '2026-11-06: Released 0.3.0. Ran `release.sh`, uploaded 14 files and purged the CDN. Checked https://lumen.app on the iPhone and the Pixel. Hero image was 2.1 MB, now AVIF at 412 KB. Next: the header wraps at 390 px (issue #41), then the pricing section from sketch B, then ship 0.3.1. 2026-11-05: Picked sketch B for pricing after the pick round, with Reader in the middle and no annual toggle for now. 2026-11-04: Set up Vite 6, moved from CRA, all 10 tests pass, bundle 148 KB gzip, removed moment.js.';
const briefDir = path.join(root, 'landing-page');
fs.mkdirSync(briefDir, { recursive: true });
const briefFile = path.join(briefDir, 'BRIEF.md');
fs.writeFileSync(briefFile, `# landing-page\n\nGoal: ${GOAL}\n\n## Rules\n- Every change is checked at 390 px and 1440 px before it ships.\n- No new dependency without asking; the bundle stays under 160 KB.\n- Copy follows the [voice notes](docs/voice.md).\n\n## Next step\n${WALL}\n\n## Plan\n### Landing page\n- [x] Move to Vite\n- [x] Release 0.3.0\n- [x] Pick a pricing sketch\n- [ ] Header fits at 390 px\n- [ ] Pricing section, then 0.3.1\n\n## Hand-off\nNone yet. One is written at the next clean point past 50%.\n`);
const mtime = new Date(Date.now() - 20 * 60000);
fs.utimesSync(briefFile, mtime, mtime);

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'brief-test' });
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', 'echo the session; exec cat'], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();
const KEY = `kite/ravenry:${pane.id}`;

let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const kite = state.projects.find((p) => p.id === 'kite');
kite.brief = { ...(kite.brief || {}), goal: GOAL, next: WALL };
const streams = new Set();
let briefAsked = 0;
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  if (q.url.startsWith('/api/brief?project=kite')) {
    briefAsked++;
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ project: 'kite', file: briefFile, path: briefFile, text: fs.readFileSync(briefFile, 'utf8'), updatedAt: mtime.toISOString(), by: 'Claude' }));
    return;
  }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const CARD = `(() => { const c = document.querySelector('#panel .brief-card'); if (!c) return null; const gl = c.querySelector('.gl'); const lis = [...c.querySelectorAll('.bf li span')];
  return { goal: gl ? gl.textContent : null, goalOneLine: gl ? gl.scrollHeight <= gl.clientHeight + 2 && gl.getClientRects().length === 1 && gl.getBoundingClientRect().height < 24 : null, next: lis.map((x) => x.textContent), nextOneLine: lis.every((x) => x.getBoundingClientRect().height < 22), foot: c.querySelector('.ft2') ? c.querySelector('.ft2').textContent : null }; })()`;
const DOC = `(() => { const d = document.getElementById('brief'); if (!d || d.hidden) return null; const md = d.querySelector('.md');
  return { head: d.querySelector('.doc-h') ? d.querySelector('.doc-h').textContent : null, h2: [...md.querySelectorAll('h2')].map((x) => x.textContent), entries: [...md.querySelectorAll('.oe')].map((x) => ({ date: x.querySelector('.dt').textContent, open: x.classList.contains('open') })), checks: [...md.querySelectorAll('.chkl i.cb')].map((x) => x.classList.contains('on')), width: Math.round(md.getBoundingClientRect().width), tab: !!document.querySelector('#tabs .tab.on[data-key="brief:kite"]') }; })()`;
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog };

try {
  await runApp({ name: 'brief', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1440, height: 900, steps: [
    { ready: true },
    { until: `document.querySelector('#side .ss[data-key="${KEY}"]')`, timeout: 15000 },
    { click: `#side .ss[data-key="${KEY}"]` },
    { until: `document.querySelector('#panel .brief-card')`, timeout: 10000 },
    { sleep: 300 },
    save('card', CARD),
    { shot: path.join(OUT, 'card-dark.png'), el: '#panel' },
    { theme: 'light' }, { sleep: 300 },
    { shot: path.join(OUT, 'card-light.png'), el: '#panel' },
    { theme: 'dark' }, { sleep: 200 },
    { click: '#panel .brief-card .ft2 .lk' },
    { until: `document.querySelector('#brief:not([hidden]) .md h2')`, timeout: 10000 },
    { sleep: 300 },
    save('doc', DOC),
    { shot: path.join(OUT, 'page-dark.png') },
    { theme: 'light' }, { sleep: 300 },
    { shot: path.join(OUT, 'page-light.png') },
    { theme: 'dark' }, { sleep: 200 },
    // An older entry opens on a click; a link opens in the browser; Edit opens the file.
    { click: '#brief .oe:nth-child(2) .oe-r' },
    { sleep: 200 },
    save('doc2', DOC),
    { clickJs: true, click: `[...document.querySelectorAll('#brief .md a')].find((a) => a.textContent === 'https://lumen.app')` },
    { clickJs: true, click: `[...document.querySelectorAll('#brief .doc-h button')].find((b) => b.textContent === 'Edit')` },
    { sleep: 300 },
    // Closed: back to the session.
    { click: '#tabs .tab.on[data-key="brief:kite"] .x' },
    { until: `${'window.__ravenry'}.term().attached && document.getElementById('brief').hidden`, timeout: 10000 },
    save('closed', `({ brief: !document.getElementById('brief').hidden, tab: !!document.querySelector('#tabs .tab[data-key="brief:kite"]') })`),
  ] });
  const c = read('card');
  check('card: the goal on one line', c?.goal === GOAL && c.goalOneLine === true, c);
  check('card: Next as 3 one-line items from the newest dated entry', JSON.stringify(c?.next) === JSON.stringify(['The header wraps at 390 px (issue #41)', 'The pricing section from sketch B', 'Ship 0.3.1']) && c.nextOneLine, c?.next);
  check('card: "Open brief, 2 older entries"', c?.foot === 'Open brief, 2 older entries', c?.foot);
  const d = read('doc');
  check('Open brief: a Brief tab beside the session, the brief as a page in a 620 px column', !!d && d.tab && d.width <= 620 && d.width > 400, d);
  check('the page: "Updated <time> by Claude" and Edit in its header', !!d && /Updated \S.* by Claude/.test(d.head) && /Edit$/.test(d.head), d?.head);
  check('the page: Goal, Rules, the Next step split into 3 dated entries, the Plan with its count', JSON.stringify(d?.h2) === JSON.stringify(['Goal', 'Rules', 'Next stepsplit into 3 dated entries, newest first', 'Plan3 of 5', 'Hand-off']), d?.h2);
  check('the page: entries newest first, the newest open, the others folded', JSON.stringify(d?.entries) === JSON.stringify([{ date: '2026-11-06', open: true }, { date: '2026-11-05', open: false }, { date: '2026-11-04', open: false }]), d?.entries);
  check('the page: the plan as a checklist, 3 of 5 ticked', JSON.stringify(d?.checks) === JSON.stringify([true, true, true, false, false]), d?.checks);
  const d2 = read('doc2');
  check('an older entry opens on a click', d2?.entries?.[1]?.open === true, d2?.entries);
  const o = opened();
  check('a link opens in the browser; Edit opens the brief in the Markdown editor', o.some((x) => x.kind === 'url' && x.what === 'https://lumen.app') && o.some((x) => x.kind === 'path' && x.what === briefFile), o);
  const cl = read('closed');
  check('closing the Brief tab goes back to the session', cl && !cl.brief && !cl.tab, cl);
  check('the page asked the hub for the brief (not on every state)', briefAsked >= 1 && briefAsked <= 4, briefAsked);
  console.log(`pictures: ${OUT}`);
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
