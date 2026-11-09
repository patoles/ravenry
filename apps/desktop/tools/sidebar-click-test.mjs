#!/usr/bin/env node
// Every sidebar row opens its session on the first click (0.1.20; 2026-11-08:
// "only "needs you" sessions are clickable, all other (waiting, idle, ..)
// are not"). The window runs offscreen on a stub hub that sends its state
// again every 300 ms, as a busy hub does, with a session in each section and
// in each kind of place:
//
//   Needs you   kite    in a Ravenry pane
//   Working     lamp    in a Ravenry pane
//   Working     notes   outside Ravenry (cmux, open)
//   Waiting     harbor  in a Ravenry pane
//   Waiting     reef    outside Ravenry, ended there
//   Idle        garden  (a project row: its main session, ended outside)
//   Waiting     dock    no session (Waiting on: from its brief)
//   Needs you   quarry  no session (a plan gate)
//   Idle        attic   no session
//
// A project with no session opens itself: its tab, its page in the middle
// (a way to start one) and its panel.
//
// Each row gets one real mouse click (press, a short hold, release), in the
// order a person might go, from whatever was in front before. After each:
// the session's tab is in front, its row is the highlighted one, the panel
// shows it, and app.log has the click with what it did.
//
//   node tools/sidebar-click-test.mjs [OUT] [--exe APP_EXECUTABLE]
//   (--exe: a packaged app, its test twin; the release check runs it so)
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'sidebar-click-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsc-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The panes, in a daemon of the test's.
const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'sidebar-click-test' });
const panes = {};
for (const p of ['kite', 'lamp', 'harbor']) {
  const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', `echo ${p} pane is here; exec cat`], labels: { 'ravenry.session': 'claude', 'ravenry.project': p } });
  panes[p] = pane.id;
}
dc.close();

const ISO = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const sid = (n) => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;
const base = (id, name, state, sessions, since) => ({
  id, name, state, since, folder: `/Users/you/Projects/${id}`, folderShort: `~/Projects/${id}`,
  line: sessions[0].words.line, headline: sessions[0].words.line, question: null, quick: [], brief: null,
  primary: sessions[0].surfaceId, machine: null, waitingOn: null, timeline: [], sessions,
});
const bare = (id, st, since) => ({ id, name: id, state: st, since, folder: `/Users/you/Projects/${id}`, folderShort: `~/Projects/${id}`, line: '', headline: '', question: null, quick: [], brief: null, primary: null, machine: null, waitingOn: null, timeline: [], sessions: [] });
const inPane = (p, n, state, line, group) => ({
  surfaceId: `ravenry:${panes[p]}`, topic: `${p} work`, live: true, sessionId: sid(n), state, since: ISO(n), source: 'events',
  terminal: true, term: 'ravenry', termName: 'Ravenry', machine: null, assistant: 'claude', working: state === 'working',
  words: { line, ...(group ? { state: group } : {}) }, screen: [], outside: null, alsoOpen: null,
});
const outside = (n, topic, state, line, group, open) => ({
  surfaceId: `ev:${sid(n)}`, topic, sessionId: sid(n), state, terminal: false, term: 'cmux', termName: 'cmux', machine: null, assistant: 'claude',
  cannot: 'cmux shows its tabs only to programs it started.', words: { line, ...(group ? { state: group } : {}) }, screen: [],
  outside: { name: 'cmux', open, resumable: !open }, alsoOpen: null, conversation: [{ ask: `About ${topic}`, text: line }],
});
let state = {
  generatedAt: new Date().toISOString(), cmuxOk: true,
  board: { kind: 'ravenry', name: 'Ravenry', installed: true },
  settings: { handoffThreshold: 50, handoffCeiling: 70, handoffEnabled: true },
  views: { ideas: 0, rules: 0, ship: 0 }, homes: { '': '/Users/you' }, checkpoints: [], machines: [], pages: [], sessions: { totalKb: 0, rows: [] },
  projects: [
    base('kite', 'kite', 'you', [{ ...inPane('kite', 1, 'asked', 'Keep it subtle?', null), words: { line: 'Keep it subtle?', question: 'Keep it subtle?' } }], ISO(1)),
    base('lamp', 'lamp', 'work', [inPane('lamp', 2, 'working', 'Wiring the dimmer', null)], ISO(2)),
    base('notes', 'notes', 'work', [outside(3, 'Sync settings', 'working', 'Syncing the settings', null, true)], ISO(3)),
    base('harbor', 'harbor', 'wait', [inPane('harbor', 4, 'waiting', 'Waiting for the build box', 'wait')], ISO(4)),
    base('reef', 'reef', 'wait', [outside(5, 'Reef survey', 'waiting', 'Waiting on the survey data', 'wait', false)], ISO(5)),
    base('garden', 'garden', 'idle', [outside(6, 'Garden plan', 'idle', 'Planted the beds', null, false)], ISO(60 * 30)),
    { ...bare('dock', 'wait', ISO(7)), waitingOn: 'the harbour master', brief: { goal: 'A dock that takes two boats.', next: 'Hear back from the harbour master.' } },
    { ...bare('quarry', 'you', ISO(8)), planGate: { short: 'Pick the stone', question: 'Granite or slate?' }, line: 'Plan gate: Pick the stone', question: 'Granite or slate?' },
    bare('attic', 'idle', ISO(60 * 48)),
  ],
};
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tickTimer = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const SEL = `(() => { const on = document.querySelector('#tabs .tab.on'); const sel = document.querySelector('#side .sl .sel'); const p = document.getElementById('panel'); return { front: on ? on.dataset.key : null, row: sel ? sel.dataset.key : null, panel: p.hidden ? null : p.dataset.key, shows: p.dataset.shows || null }; })()`;
const key = (p, s) => `${p}/${s.surfaceId}`;
const K = Object.fromEntries(state.projects.map((p) => [p.id, p.sessions.length ? key(p.id, p.sessions[0]) : `project:${p.id}`]));
// The rows, in the order clicked: [what, the element to click, the key in front, in the panel, the highlighted row's].
// A session's row by its key; a project's by its name (the way a person finds it).
const row = (k) => k.startsWith('project:')
  ? `[...document.querySelectorAll('#side .sl .pj, #side .sl .idl')].find((e) => e.querySelector('.n').textContent === ${JSON.stringify(k.slice(8))})`
  : `document.querySelector('#side .sl [data-key="${k}"] .n')`;
const CLICKS = [
  ['a Working session outside Ravenry (notes)', row(K.notes), K.notes],
  ['a Waiting session in a Ravenry pane (harbor)', row(K.harbor), K.harbor],
  ['an Idle project with a session (garden)', row('project:garden'), K.garden, 'project:garden'],
  ['a Waiting project with no session (dock)', row(K.dock), K.dock],
  ['a Working session in a Ravenry pane (lamp)', row(K.lamp), K.lamp],
  ['an Idle project with no session (attic)', row(K.attic), K.attic],
  ['a Waiting session that ended outside (reef)', row(K.reef), K.reef],
  ['a Needs you project with no session (quarry, a plan gate)', row(K.quarry), K.quarry],
  ['a Needs you session in a Ravenry pane (kite)', row(K.kite), K.kite],
  ['the Working session outside again, from a pane (notes)', row(K.notes), K.notes],
];
const env = { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0' };

try {
  const steps = [
    { ready: true },
    { until: `${R}.S.tabs.length === 1 && ${R}.term().attached && ${R}.S.hub && ${R}.S.hub.projects && document.querySelectorAll('#side .ss').length === 5 && document.querySelectorAll('#side button.idl').length === 2`, timeout: 15000 },
    { save: { expr: `[...document.querySelectorAll('#side section.grp')].map((g) => ({ cls: g.className, rows: [...g.querySelectorAll('.ss, .pj.open')].map((e) => e.dataset.key), idle: g.querySelectorAll('button.idl').length }))`, out: path.join(work, 'groups.json') } },
    { shot: path.join(OUT, 'sidebar-before.png') },
  ];
  CLICKS.forEach(([, sel, want, wantRow = want], i) => {
    steps.push(
      { save: { expr: SEL, out: path.join(work, `before${i}.json`) } },
      { click: sel, clickJs: true, hold: 120 },
      // One click only; then the front, the row and the panel name it within 3 s.
      { until: `(() => { const s = ${SEL}; return s.front === ${JSON.stringify(want)} && s.row === ${JSON.stringify(wantRow)} && s.panel === ${JSON.stringify(want)}; })()`, timeout: 3000, soft: true },
      { save: { expr: SEL, out: path.join(work, `after${i}.json`) } },
      { shot: path.join(OUT, `sidebar-click-${i}.png`) },
    );
  });
  const log = await runApp({ name: 'clicks', exe: EXE, work, rt, bin: EXE ? null : BIN, cli: BIN, home, hubUrl, env, steps });
  const j = (f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8'));
  const groups = j('groups.json');
  const want = { you: [K.kite, K.quarry], work: [K.lamp, K.notes], wait: [K.harbor, K.reef, K.dock] };
  check('the board: a row in each section (Needs you, Working, Waiting on others, Idle), with and without a session', Object.entries(want).every(([g, keys]) => { const s = groups.find((x) => x.cls.includes(`g-${g}`)); return s && keys.every((k) => s.rows.includes(k)); }) && groups.some((x) => x.cls.includes('g-idle') && x.idle === 2), JSON.stringify(groups));
  const lines = log.split('\n').filter((l) => /window: (session|project) click/.test(l));
  CLICKS.forEach(([what, , k, kr = k], i) => {
    const a = j(`after${i}.json`);
    check(`one click on ${what} brings it to the front: its tab, its row and the panel`, a.front === k && a.row === kr && a.panel === k && ['session', 'project'].includes(a.shows), JSON.stringify({ before: j(`before${i}.json`), after: a }));
  });
  check('each click is a line in app.log with what it did', CLICKS.every(([, , k]) => lines.some((l) => l.includes(` ${k.replace(/^project:/, '')}: `))), lines.join(' | ') || '(no click lines)');
} finally {
  clearInterval(tickTimer);
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
