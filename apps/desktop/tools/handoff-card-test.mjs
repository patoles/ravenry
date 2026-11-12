#!/usr/bin/env node
// The hand-off card in the panel (2026-11-12, "The hand-off card is a wall of
// text, not really useful"): the hub's line for the brief's newest Hand-off
// entry (hub/server/handoffline.mjs) drawn at most two lines, "›" after its
// time; a press on the card opens the brief scrolled to its Hand-off heading,
// where the entry stands whole. The stub hub sends the line the real hub
// makes from a long entry, and the brief file holds that entry whole.
//
//   node tools/handoff-card-test.mjs [OUT] [--exe APP_EXECUTABLE]
import { briefBody, hubState } from './stub-state.mjs';
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';
import { handoffLine } from '../../../hub/server/handoffline.mjs';
import { plain } from '../../../hub/server/state.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'handoff-card-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvho-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (ok) passes++; else fails++; };

const LONG = "Session 25204b9f (ravenry-1d) is main. Native 0.1.37+00eedd8 installed 00:39 (integration: 5d1bfe4 schema and types, b6bd411 quits on SIGTERM with a dialog up, 5b80f8c bump, 00eedd8 three flakes; selftest 185/185, sidetest 36 runs 2021 checks 0 failed, scripts pass, installcheck 20/23 = 3 update steps need a same-version Electron build). Launched clean, app.log 'launch: native app 0.1.37', board 200, doctor all good. Rollback: the scratchpad's rollback zip. Then main integrates 0.1.38.";
const LINE = handoffLine(plain(LONG));
const briefDir = path.join(root, 'kite');
fs.mkdirSync(briefDir, { recursive: true });
const briefFile = path.join(briefDir, 'BRIEF.md');
// Enough above the Hand-off that the page scrolls to it, and below it that its heading can reach the top.
const background = Array.from({ length: 40 }, (_, i) => `- Kite ${i + 1} gets its own tail length from the wind tests.`).join('\n');
fs.writeFileSync(briefFile, `# kite\n\nGoal: A kite that flies in light wind.\n\n## Next step\n- Cut the tail\n\n## Background\n${background}\n\n## Hand-off\n- 2026-11-12 00:45 ${LONG}\n  - State: the card test's entry\n- 2026-11-05 18:20 Older hand-off.\n\n## Later\n${background}\n`);
const mtime = new Date(Date.now() - 20 * 60000);

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'handoff-card-test' });
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', 'echo the session; exec cat'], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();
const KEY = `kite/ravenry:${pane.id}`;

let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const kite = state.projects.find((p) => p.id === 'kite');
kite.brief = { ...(kite.brief || {}), goal: 'A kite that flies in light wind.', next: '- Cut the tail' };
// As the hub sends it (hub/server/index.mjs): the line, and the whole entry in full.
kite.timeline = [{ when: '2026-11-12 00:45', text: LINE, full: plain(LONG), from: 'brief' }];
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  if (q.url.startsWith('/api/brief?project=kite')) {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify(briefBody({ project: 'kite', file: briefFile, path: briefFile, text: fs.readFileSync(briefFile, 'utf8'), updatedAt: mtime.toISOString(), by: 'Claude' }, '- Cut the tail')));
    return;
  }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
// The card's line: its text, the lines it draws (its height over its line height) and whether its words run past them.
const CARD = `(() => { const c = document.querySelector('#panel .ho-card'); if (!c) return null; const l = c.querySelector('.ho-line'); const lh = parseFloat(getComputedStyle(l).lineHeight);
  return { text: l.textContent, lines: Math.round(l.getBoundingClientRect().height / lh), clipped: l.scrollHeight > l.clientHeight + 1, head: c.querySelector('.sec-h').textContent, cursor: getComputedStyle(c).cursor, role: c.getAttribute('role'), title: c.title }; })()`;
const DOC = `(() => { const d = document.getElementById('brief'); if (!d || d.hidden) return null; const h2 = [...d.querySelectorAll('.md h2')].find((x) => x.textContent.trim() === 'Hand-off'); if (!h2) return { noHeading: true };
  let s = h2.parentElement; while (s && s !== document.body && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
  const box = s && s !== document.body ? s.getBoundingClientRect() : { top: 0, bottom: innerHeight }; const r = h2.getBoundingClientRect();
  return { tab: !!document.querySelector('#tabs .tab.on[data-key="brief:kite"]'), scrolled: s && s !== document.body ? s.scrollTop : null, inView: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, fromTop: Math.round(r.top - box.top), whole: d.textContent.includes('Then main integrates 0.1.38.') && d.textContent.includes('Session 25204b9f (ravenry-1d) is main.') }; })()`;
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0' };

try {
  await runApp({ name: 'handoff-card', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1440, height: 900, steps: [
    { ready: true },
    { until: `document.querySelector('#side .ss[data-key="${KEY}"]')`, timeout: 15000 },
    { click: `#side .ss[data-key="${KEY}"]` },
    { until: `document.querySelector('#panel .ho-card')`, timeout: 10000 },
    { sleep: 300 },
    save('card', CARD),
    { shot: path.join(OUT, 'electron-handoff-card-dark.png'), el: '#panel' },
    { theme: 'light' }, { sleep: 300 },
    { shot: path.join(OUT, 'electron-handoff-card-light.png'), el: '#panel' },
    { theme: 'dark' }, { sleep: 200 },
    { click: '#panel .ho-card .ho-line' },
    { until: `document.querySelector('#brief:not([hidden]) .md h2')`, timeout: 10000 },
    { sleep: 500 },
    save('doc', DOC),
    { shot: path.join(OUT, 'electron-handoff-brief-at-handoff.png') },
  ] });
  const c = read('card');
  check('hub line: the id-only first sentence skipped, short', LINE.startsWith('Native 0.1.37+00eedd8 installed') && LINE.length <= 120 && !/25204b9f|ravenry-1d/.test(LINE), LINE);
  const stem = c ? c.text.replace(/\u2026$/, '') : '';
  check('card: the hub\'s line in at most two lines, cut at a word with "…", nothing clipped', !!c && c.text.endsWith('\u2026') && c.text.length < LINE.length && LINE.startsWith(stem) && /[\s,;:)\u2026]/.test(LINE[stem.length]) && c.lines >= 1 && c.lines <= 2 && !c.clipped, c);
  check('card: "›" after the time, the pointing hand, a button that says where it goes', !!c && /Hand-off\s*2026-11-12 00:45\s*›$/.test(c.head) && c.cursor === 'pointer' && c.role === 'button' && c.title === 'Open the brief at its Hand-off', c);
  const d = read('doc');
  check('a press opens the brief in its tab, scrolled to the Hand-off heading', !!d && d.tab && d.scrolled > 0 && d.inView && d.fromTop < 120, d);
  check('the brief page shows the entry whole', !!d && d.whole, d);
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
console.log(fails ? `\n${fails} FAILED, ${passes} pass` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
