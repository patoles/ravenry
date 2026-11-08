// Every session the board lists has its own row in the app's sidebar,
// titled from its transcript, in the section of its own state
// (2026-11-08: a session working in a Ravenry pane, which had written a
// hand-off earlier, showed nowhere in the sidebar while the board listed
// it; then a session done and waiting for you showed under Working, beside
// its project's working one).
//
// A real ravenryd runs three stand-in Claude Code processes
// (tools/stand-in-claude.mjs) in panes of one project's folder:
//   - one no hook event tells of (the board finds it from its process, the
//     launch argument giving its session id);
//   - one whose hook events say it is working, which wrote its hand-off
//     earlier (its marker says written) and works on;
//   - one whose turn ended (its last hook event is Stop): it needs you.
// Each has a transcript with a title. A real board (hub/server/index.mjs)
// runs in Ravenry mode on that daemon, and the built app (offscreen, a
// throwaway HOME) shows it: each row in the sidebar once, under its title,
// the one done under Needs you and the working one under Working, the
// project's header in both, each section counting 1. A picture of the
// sidebar is saved.
//
//   node tools/listed-check.mjs [OUT]
import { guardSpawns, withStubMachine } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const HUB = path.join(REPO, 'hub');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const STAND_IN = path.join(HERE, 'stand-in-claude.mjs');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'listed-check'));
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// The account: its folders, the project, the transcripts.
// Inside the hub's scratch folder: a board in a test keeps its data only there.
fs.mkdirSync(path.join(HUB, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(HUB, '.tmp', 'listed-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE = path.join(HOME, '.claude', 'projects');
for (const d of [path.join(MC, 'events'), path.join(MC, 'handoffs'), PROJ, CLAUDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const PS = path.join(T, 'stub-ps.json'); // the stand-ins list themselves in <HOME>/../stub-ps.json
fs.writeFileSync(PS, '[]');
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');

const S_PANE = '5e55107e-0000-4000-8000-0000000000a1'; // no event: found from its process
const S_EV = '5e55107e-0000-4000-8000-0000000000b2'; // its events say working; wrote a hand-off earlier
const S_DONE = '5e55107e-0000-4000-8000-0000000000c3'; // its turn ended: it needs you
const TITLES = { [S_PANE]: 'Kite tide tables', [S_EV]: 'Kite brief hand-off', [S_DONE]: 'Kite release notes' };
const trDir = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'));
fs.mkdirSync(trDir, { recursive: true });
const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
for (const sid of [S_PANE, S_EV, S_DONE]) {
  const rec = (o) => JSON.stringify({ cwd: PROJ, sessionId: sid, timestamp: at(5), ...o });
  fs.writeFileSync(path.join(trDir, `${sid}.jsonl`), [
    rec({ type: 'user', message: { role: 'user', content: 'Carry on with the kite work' } }),
    rec({ type: 'ai-title', aiTitle: TITLES[sid] }),
    ...(sid === S_DONE ? [rec({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The release notes are written.' }] } })] : []),
  ].join('\n') + '\n');
}
// The second one wrote its hand-off an hour ago, and goes on.
fs.writeFileSync(path.join(MC, 'handoffs', `${S_EV}.json`), JSON.stringify({ sessionId: S_EV, state: 'written', writtenAt: at(60), updatedAt: at(60), history: [{ state: 'written', at: at(60) }] }, null, 2));

// The daemon, its folders short (a socket path is limited to about 100 bytes).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvlc-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
const daemon = spawn(BIN, ['serve'], { env: { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE }, stdio: 'ignore' });
let board = null;
let boardLog = '';
const cleanup = () => {
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  stopDaemons(BIN, RUN);
  try { for (const p of JSON.parse(fs.readFileSync(PS, 'utf8'))) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

try {
  const { connectSocket, daemonSockets } = await import('../../../packages/node-client/index.mjs');
  let sock = null;
  for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
  if (!sock) throw new Error('the daemon did not start');
  const c = await connectSocket(sock, { name: 'listed-check' });
  const paneA = (await c.request('pane.new', { cwd: PROJ, name: 'kite', command: [process.execPath, STAND_IN, '--session-id', S_PANE] })).pane.id;
  const paneB = (await c.request('pane.new', { cwd: PROJ, name: 'kite', command: [process.execPath, STAND_IN, '--session-id', S_EV] })).pane.id;
  const paneC = (await c.request('pane.new', { cwd: PROJ, name: 'kite', command: [process.execPath, STAND_IN, '--session-id', S_DONE] })).pane.id;
  c.close();
  let procs = [];
  for (let i = 0; i < 100 && procs.length < 3; i++) { try { procs = JSON.parse(fs.readFileSync(PS, 'utf8')); } catch { procs = []; } if (procs.length < 3) await sleep(50); }
  const pidOf = (sid) => (procs.find((p) => p.command.includes(sid)) || {}).pid;
  if (!pidOf(S_EV) || !pidOf(S_DONE)) throw new Error('the stand-ins did not start');
  // Their hook events: started, then a prompt (working); the third's turn then ended.
  const events = (sid, pane, list) => fs.writeFileSync(path.join(MC, 'events', `${sid}.jsonl`), list.map((event, i) => JSON.stringify({ at: at(3 - i), event, session_id: sid, assistant: 'claude', cwd: PROJ, claude_pid: pidOf(sid), terminal: 'ravenry', terminal_id: pane, pane, transcript_path: path.join(trDir, `${sid}.jsonl`) })).join('\n') + '\n');
  events(S_EV, paneB, ['SessionStart', 'UserPromptSubmit']);
  events(S_DONE, paneC, ['SessionStart', 'UserPromptSubmit', 'Stop']);

  // The board, in Ravenry mode on that daemon, never reading this Mac.
  const PORT = await freePort();
  const env = withStubMachine({
    PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
    CMUX_BIN: path.join(HUB, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
    MC_PS_BIN: path.join(HUB, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(HUB, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
    MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: SETTINGS, MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1',
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(HUB, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
    MC_OSASCRIPT_BIN: path.join(HUB, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(HUB, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
    MC_APPS: 'ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
    RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
  });
  fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [] }));
  board = spawn(process.execPath, [path.join(HUB, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  board.stdout.on('data', (d) => { boardLog += d; });
  board.stderr.on('data', (d) => { boardLog += d; });
  const base = `http://127.0.0.1:${PORT}`;
  let rows = [];
  for (let i = 0; i < 100; i++) {
    try { const st = await (await fetch(base + '/api/state')).json(); rows = ((st.projects || []).find((p) => p.id === 'kite') || { sessions: [] }).sessions; } catch { rows = []; }
    if (rows.length >= 3) break;
    await sleep(100);
  }
  const brief = rows.map((s) => ({ surfaceId: s.surfaceId, sessionId: s.sessionId, state: s.state, topic: s.topic, handed: s.handed, method: s.method }));
  fs.writeFileSync(path.join(OUT, 'board-rows.json'), JSON.stringify(brief, null, 2));
  check('the board lists the three sessions, each in its pane, under its transcript\'s title', [[paneA, S_PANE], [paneB, S_EV], [paneC, S_DONE]].every(([p, sid]) => rows.some((s) => s.surfaceId === `ravenry:${p}` && s.sessionId === sid && s.topic === TITLES[sid])), JSON.stringify(brief) + (rows.length ? '' : '\n' + boardLog.slice(-1500)));
  check('the one that wrote its hand-off and works on is working, not handed', rows.some((s) => s.sessionId === S_EV && s.state === 'working' && !s.handed), JSON.stringify(brief));
  check('the one whose turn ended is handed back to you', rows.some((s) => s.sessionId === S_DONE && s.state === 'handback'), JSON.stringify(brief));

  // The app, offscreen, showing that board.
  const work = path.join(T, 'app');
  const rt = path.join(D, 'apprt');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(T, 'apphome'), { recursive: true });
  const R = 'window.__ravenry';
  const names = `[...document.querySelectorAll('#side .ss .n')].map((e) => e.textContent)`;
  await runApp({ name: 'listed', work, rt, bin: BIN, home: path.join(T, 'apphome'), hubUrl: base, timeoutMs: 90000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0' }, width: 1280, height: 800,
    steps: [
      { ready: true },
      { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.some((p) => p.id === 'kite' && p.sessions.length >= 3) && ${names}.length >= 3`, timeout: 20000, soft: true },
      { sleep: 400 },
      { save: { expr: `(() => ({ rows: ${names}, sections: Object.fromEntries([...document.querySelectorAll('#side section.grp')].map((g) => [g.querySelector('.grp-h .t').textContent, { count: g.querySelector('.grp-h .cnt').textContent, projects: [...g.querySelectorAll('.pj .n, .idl .n')].map((e) => e.textContent), rows: [...g.querySelectorAll('.ss .n')].map((e) => e.textContent) }])) }))()`, out: path.join(OUT, 'sidebar.json') } },
      { shot: path.join(OUT, 'sidebar.png'), el: '#side' },
    ] });
  let side = null;
  try { side = JSON.parse(fs.readFileSync(path.join(OUT, 'sidebar.json'), 'utf8')); } catch { /* below */ }
  check('the sidebar shows the three sessions, each its own row once, under its title', !!side && Object.values(TITLES).every((t) => side.rows.filter((n) => n === t).length === 1), JSON.stringify(side));
  const sec = (side && side.sections) || {};
  const one = (name, title) => { const x = sec[name]; return !!x && x.count === '1' && x.projects.length === 1 && x.projects[0] === 'kite' && x.rows.length === 1 && x.rows[0] === title; };
  check('Needs you: the project\'s header and the one done, counting 1', one('Needs you', TITLES[S_DONE]), JSON.stringify(sec['Needs you']));
  check('Working: the project\'s header and the working one, counting 1', one('Working', TITLES[S_EV]), JSON.stringify(sec.Working));
  console.log(`picture: ${path.join(OUT, 'sidebar.png')}`);
} catch (e) {
  check('measured', false, String(e.stack || e).slice(0, 3000) + '\n' + boardLog.slice(-1500));
} finally {
  cleanup();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
