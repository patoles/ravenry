#!/usr/bin/env node
// A session running in a Ravenry pane is on the board straight away, from
// the daemon's panes and the process list, without waiting for a hook
// event (2026-11-08: after an update restarted the hub, a session in a pane
// showed nowhere until it was typed into, which sent a hook event).
//
// A real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd) runs two
// stand-in Claude Code processes (apps/desktop/tools/stand-in-claude.mjs)
// in panes of a project's folder: one started with `--session-id <id>`, one
// plain (no session id anywhere). No hooks are installed, so neither ever
// sends an event. A board in Ravenry mode starts, is stopped and starts
// again; each time both rows must be in the project within 2 s of its
// start. tools/stub-ps.mjs stands in for ps and lsof (the stand-ins list
// themselves in it), so the board never reads this Mac's processes.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/pane-listed-test.mjs
// Prints the measured time from each board's start to both rows.
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  pane-listed-test: no ravenryd at ${BIN} (set RAVENRYD_BIN)`); process.exit(0); }
const STAND_IN = path.join(ROOT, '..', 'apps', 'desktop', 'tools', 'stand-in-claude.mjs');
const LIMIT_MS = 2000;

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'pane-listed-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE = path.join(HOME, '.claude', 'projects');
for (const d of [path.join(MC, 'events'), PROJ, CLAUDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const PS = path.join(T, 'stub-ps.json'); // the stand-ins write <HOME>/../stub-ps.json
fs.writeFileSync(PS, '[]');
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// The daemon: its folders short and outside the repo (a socket path is
// limited to about 100 bytes).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvpl-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const DENV = { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let board = null;
let boardLog = '';
const cleanup = () => {
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  // The stand-ins end with their panes; any left over are ended here.
  try { for (const p of JSON.parse(fs.readFileSync(PS, 'utf8'))) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the daemon is up', !!sock);
if (!sock) process.exit(1);
const c = await connectSocket(sock, { name: 'pane-listed-test' });
const SID = '5e55107e-0000-4000-8000-00000000d1d1';
const paneA = (await c.request('pane.new', { cwd: PROJ, name: 'kite', command: [process.execPath, STAND_IN, '--session-id', SID] })).pane.id;
const paneB = (await c.request('pane.new', { cwd: PROJ, name: 'kite', command: [process.execPath, STAND_IN] })).pane.id;
// Both stand-ins running and listed in the stub process list.
const listed = async () => { try { return JSON.parse(fs.readFileSync(PS, 'utf8')); } catch { return []; } };
for (let i = 0; i < 100 && (await listed()).length < 2; i++) await sleep(50);
const procs = await listed();
check('two stand-ins run in their panes, listed with their pane', procs.length === 2 && procs.every((p) => /RAVENRY_PANE=p/.test(p.env) && /TERM_PROGRAM=ravenry/.test(p.env)), JSON.stringify(procs.map((p) => p.env)));
check('no hook event was sent (no events on disk)', fs.readdirSync(path.join(MC, 'events')).length === 0);

const PORT = await freePort();
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: SETTINGS, MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
});
fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [] }));
const base = `http://127.0.0.1:${PORT}`;
const rowsNow = async () => {
  const st = await (await fetch(base + '/api/state')).json();
  const p = (st.projects || []).find((x) => x.id === 'kite');
  return p ? p.sessions : [];
};

const runs = [];
for (const run of ['first start', 'restart']) {
  const t0 = Date.now();
  board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  board.stdout.on('data', (d) => { boardLog += d; });
  board.stderr.on('data', (d) => { boardLog += d; });
  let seen = null;
  let last = [];
  while (Date.now() - t0 < 10000) {
    try { last = await rowsNow(); } catch { last = []; }
    const a = last.find((s) => s.surfaceId === `ravenry:${paneA}`);
    const b = last.find((s) => s.surfaceId === `ravenry:${paneB}`);
    if (a && b) { seen = { ms: Date.now() - t0, a, b }; break; }
    await sleep(50);
  }
  runs.push(seen ? seen.ms : null);
  console.log(`${run}: both rows ${seen ? `after ${seen.ms} ms` : 'not there after 10 s'}`);
  check(`${run}: both pane sessions are rows of the project within ${LIMIT_MS} ms`, !!seen && seen.ms <= LIMIT_MS, seen ? `${seen.ms} ms` : JSON.stringify(last.map((s) => ({ surfaceId: s.surfaceId, sessionId: s.sessionId, state: s.state }))) + '\n' + boardLog.slice(-1500));
  if (seen) {
    check(`${run}: the one started with its session id has it`, seen.a.sessionId === SID && seen.a.term === 'ravenry' && seen.a.terminal === true, JSON.stringify({ sessionId: seen.a.sessionId, term: seen.a.term, method: seen.a.method }));
    check(`${run}: both show their pane's screen`, [seen.a, seen.b].every((s) => (s.screen || []).join('\n').includes('fake claude ready')), JSON.stringify([seen.a.screen, seen.b.screen]));
    if (run === 'restart') fs.writeFileSync(path.join(T, 'rows.json'), JSON.stringify([seen.a, seen.b].map((s) => ({ surfaceId: s.surfaceId, sessionId: s.sessionId, method: s.method, state: s.state, term: s.termName, topic: s.topic, screen: s.screen })), null, 2));
  }
  if (seen && run === 'restart') {
    // The plain one's first hook event comes (as when it is typed into): its
    // row takes the session id the event gives, and stays one row.
    const SB = '5e55107e-0000-4000-8000-00000000d2d2';
    const pidB = procs.find((p) => !/--session-id/.test(p.command)).pid;
    fs.writeFileSync(path.join(MC, 'events', SB + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'UserPromptSubmit', session_id: SB, assistant: 'claude', cwd: PROJ, claude_pid: pidB, terminal: 'ravenry', terminal_id: paneB, pane: paneB }) + '\n');
    let rows = [];
    for (let i = 0; i < 80; i++) { rows = (await rowsNow()).filter((s) => s.surfaceId === `ravenry:${paneB}`); if (rows.some((s) => s.sessionId === SB)) break; await sleep(100); }
    check('a hook event later: the pane\'s row takes its session id and stays one row', rows.length === 1 && rows[0].sessionId === SB, JSON.stringify(rows.map((s) => ({ sessionId: s.sessionId, method: s.method }))));
    fs.rmSync(path.join(MC, 'events', SB + '.jsonl'));
  }
  board.kill('SIGTERM');
  await new Promise((r) => { if (board.exitCode !== null) r(); else board.once('exit', r); });
  board = null;
}
check('no hook event was sent by the stand-ins all along', fs.readdirSync(path.join(MC, 'events')).length === 0);
c.close();
console.log(`\ntime to both rows: ${runs.map((x) => (x == null ? 'never' : `${x} ms`)).join(', ')} (limit ${LIMIT_MS} ms)`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
