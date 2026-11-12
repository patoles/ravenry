#!/usr/bin/env node
// The hooks record the assistant's own process, through the app's
// executable run as Node too (2026-11-12, found on the maintainer's Mac: a
// session running in iTerm2 said it had ended there and offered Continue).
// The Electron app wrote its hooks as `ELECTRON_RUN_AS_NODE=1
// .../Contents/MacOS/Ravenry <data>/current/hub/hooks/events.mjs`; in this
// app that executable is NodeRunner.swift, which starts Node as its child
// and stays its parent, so the hook took the relay for Claude
// (claude_pid = its parent) and the board judged a live session gone.
//
// A stand-in assistant (a Node process here) runs each hook command as
// Claude Code does, through `sh -c`, with this tree's hub/hooks/events.mjs:
//
// 1 relay      the Electron-era form through APP's executable: claude_pid is
//              the stand-in's pid, not the relay's (the sh's child)
// 2 codex      the same for Codex's hook (--assistant=codex): codex_pid
// 3 app-server a stand-in whose command line is Codex's app-server: the hook
//              sees it is (codex_daemon), through the relay too
// 4 node       the form the hub writes now (Contents/MacOS/node directly)
// 5 inherited  a RAVENRY_RELAY handed down from further up (a pane under
//              the hub) is not believed: the hook's own parent is recorded
// 6 hub        a test board (127.0.0.1, its own HOME), started as the
//              service starts it (through APP's executable as Node): an
//              iTerm2 session whose stand-in still runs, reported only
//              through the relay, says outside.open true and no Continue;
//              its name file (~/.claude/sessions/<pid>.json naming an older
//              session) resolves to the session the hooks named; the
//              stand-in ends: outside.open false and Continue offered. What
//              the board starts carries no RAVENRY_RELAY.
//
// The board's ps lists the stand-ins only while they run (kill -0), so
// "still runs" is the real process's.
//
//   node scripts/hookpidcheck.mjs [APP]   default build/RavenryMac.app
//
// A development build carries no Node: a clone of it with build/node's
// (the version package.mjs puts in) is made under hub/.tmp and removed after.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const HUB = path.join(REPO, 'hub');
const HOOK = path.join(HUB, 'hooks', 'events.mjs');
// In the hub's .tmp: a test hook or board keeps its data only there (hub/server/home.mjs).
fs.mkdirSync(path.join(HUB, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(HUB, '.tmp', 'hookpid.'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`); };
async function until(ms, f) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f().catch(() => null); if (v) return v; await sleep(200); } return null; }
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ------------------------------------------------------------ the app, with its Node
let { app: APP, exe: EXE } = testApp(process.argv[2] || path.join(MAC, 'build', 'RavenryMac.app'));
if (!fs.existsSync(path.join(APP, 'Contents', 'MacOS', 'node'))) {
  const nodeDir = path.join(MAC, 'build', 'node');
  const v = fs.existsSync(nodeDir) ? fs.readdirSync(nodeDir).sort().pop() : null;
  const bin = v && path.join(nodeDir, v, 'bin', 'node');
  if (!bin || !fs.existsSync(bin)) { console.error(`hookpidcheck: ${APP} has no Contents/MacOS/node and build/node has none to put in (scripts/package.mjs downloads it)`); process.exit(2); }
  const copy = path.join(T, path.basename(APP));
  execFileSync('/bin/cp', ['-cR', APP, copy]);
  fs.copyFileSync(bin, path.join(copy, 'Contents', 'MacOS', 'node'));
  fs.chmodSync(path.join(copy, 'Contents', 'MacOS', 'node'), 0o755);
  ({ app: APP, exe: EXE } = testApp(copy));
  console.log(`hookpidcheck: a clone of the build with Node ${v}: ${APP}`);
}
const NODE = path.join(APP, 'Contents', 'MacOS', 'node');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ELECTRON_FORM = (extra = '') => `ELECTRON_RUN_AS_NODE=1 ${q(EXE)} ${q(HOOK)} --ravenryd${extra}`;
const NODE_FORM = (extra = '') => `${q(NODE)} ${q(HOOK)} --ravenryd${extra}`;

// ------------------------------------------------------------ the stand-in assistant
// standin.mjs PLAN [app-server]: runs each { command, input } of PLAN (a
// JSON file) through `sh -c` as Claude Code runs a hook, writes
// { pid, shells: [the sh's pid per command] } to PLAN.out, then stays
// until SIGTERM when PLAN says stay.
const STANDIN = path.join(T, 'standin.mjs');
fs.writeFileSync(STANDIN, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const shells = [];
for (const s of plan.steps) {
  await new Promise((done) => {
    const c = spawn(s.command, { shell: '/bin/sh', stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ...(s.env || {}) } });
    shells.push(c.pid);
    c.on('close', done);
    c.stdin.end(JSON.stringify(s.input));
  });
}
fs.writeFileSync(process.argv[2] + '.out', JSON.stringify({ pid: process.pid, shells }));
if (plan.stay) setInterval(() => {}, 1000); else process.exit(0);
`);
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE_DIR = path.join(HOME, '.claude');
for (const d of [path.join(MC, 'events'), PROJ, path.join(CLAUDE_DIR, 'projects'), path.join(CLAUDE_DIR, 'sessions')]) fs.mkdirSync(d, { recursive: true });
const ITERM_UUID = 'C0FFEE00-1111-4222-8333-444444444444';
// A clean environment (none of this shell's RAVENRY_PANE, RAVENRY_SOCKET,
// cmux or iTerm2 variables): an iTerm2 tab's.
const standinEnv = (board) => ({ PATH: '/usr/bin:/bin', HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, MC_BOARD_URL: board, TEST_RAVENRY: '1', TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: `w0t0p0:${ITERM_UUID}` });
let planN = 0;
function startStandin(steps, { board = 'http://127.0.0.1:9', stay = false, appServer = false } = {}) {
  const plan = path.join(T, `plan${++planN}.json`);
  fs.writeFileSync(plan, JSON.stringify({ steps, stay }));
  const args = [STANDIN, plan, ...(appServer ? ['app-server'] : [])];
  const child = spawn(process.execPath, args, { env: standinEnv(board), stdio: 'ignore' });
  const done = until(15000, async () => (fs.existsSync(plan + '.out') ? JSON.parse(fs.readFileSync(plan + '.out', 'utf8')) : null));
  return { child, done };
}
const linesOf = (sid) => { try { return fs.readFileSync(path.join(MC, 'events', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const input = (sid, ev, extra = {}) => ({ session_id: sid, transcript_path: path.join(CLAUDE_DIR, 'projects', `${sid}.jsonl`), cwd: PROJ, hook_event_name: ev, ...extra });
const sidN = (n) => `0000${n}000-1111-4222-8333-${String(n).padStart(12, '0')}`;

const kids = [];
let board = null;
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } } if (board) { try { board.kill('SIGTERM'); } catch { /* gone */ } } });

try {
  // 1 relay
  {
    const sid = sidN(1);
    const s = startStandin([{ command: ELECTRON_FORM(), input: input(sid, 'SessionStart', { source: 'startup' }) }, { command: ELECTRON_FORM(), input: input(sid, 'Stop', { last_assistant_message: 'Done.' }) }]);
    kids.push(s.child);
    const out = await s.done;
    const ls = linesOf(sid);
    check('1 relay: through the app\'s executable as Node (the Electron-era hook), every event names the stand-in assistant\'s pid, not the relay\'s', !!out && ls.length === 2 && ls.every((l) => l.claude_pid === out.pid) && !ls.some((l) => out.shells.includes(l.claude_pid)), JSON.stringify({ standin: out, relays: out && out.shells, recorded: ls.map((l) => l.claude_pid) }));
    check('1 relay: and the terminal the session runs in (iTerm2, its tab)', ls.length === 2 && ls.every((l) => l.terminal === 'iterm' && l.terminal_id === `w0t0p0:${ITERM_UUID}`), JSON.stringify(ls.map((l) => [l.terminal, l.terminal_id])));
  }
  // 2 codex
  {
    const sid = sidN(2);
    const s = startStandin([{ command: ELECTRON_FORM(' --assistant=codex'), input: input(sid, 'SessionStart', { source: 'startup' }) }]);
    kids.push(s.child);
    const out = await s.done;
    const l = linesOf(sid)[0];
    check('2 codex: Codex\'s hook through the relay names Codex\'s pid (codex_pid), not the relay\'s, and is not taken for the app-server', !!out && !!l && l.assistant === 'codex' && l.codex_pid === out.pid && !l.claude_pid && !l.codex_daemon, JSON.stringify({ standin: out, line: l }));
  }
  // 3 app-server
  {
    const sid = sidN(3);
    const s = startStandin([{ command: ELECTRON_FORM(' --assistant=codex'), input: input(sid, 'SessionStart', { source: 'startup' }) }], { appServer: true });
    kids.push(s.child);
    const out = await s.done;
    const l = linesOf(sid)[0];
    check('3 app-server: a hook Codex\'s app-server runs through the relay is seen as the app-server\'s (codex_daemon, no terminal ids)', !!out && !!l && l.codex_daemon === true && l.codex_pid === out.pid && !l.terminal, JSON.stringify({ standin: out, line: l }));
  }
  // 4 node
  {
    const sid = sidN(4);
    const s = startStandin([{ command: NODE_FORM(), input: input(sid, 'SessionStart', { source: 'startup' }) }]);
    kids.push(s.child);
    const out = await s.done;
    const l = linesOf(sid)[0];
    check('4 node: the form the hub writes now (the app\'s Node directly) names the stand-in\'s pid', !!out && !!l && l.claude_pid === out.pid, JSON.stringify({ standin: out, line: l }));
  }
  // 5 inherited
  {
    const sid = sidN(5);
    const s = startStandin([{ command: NODE_FORM(), input: input(sid, 'SessionStart', { source: 'startup' }), env: { RAVENRY_RELAY: `${process.pid}:4242` } }]);
    kids.push(s.child);
    const out = await s.done;
    const l = linesOf(sid)[0];
    check('5 inherited: a RAVENRY_RELAY from further up is not believed: the hook\'s own parent is recorded', !!out && !!l && l.claude_pid === out.pid, JSON.stringify({ standin: out, line: l }));
  }

  // 6 hub
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const SID = '6e6e6e6e-1111-4222-8333-000000000006';
  const OLD = '6e6e6e6e-1111-4222-8333-0000000000a1'; // the session the name file still names
  // ps for the board: the stand-ins it is told of, while they run; it logs
  // whether its environment carries RAVENRY_RELAY.
  const PSSTATE = path.join(T, 'ps-state.json');
  const PSLOG = path.join(T, 'ps-env.log');
  fs.writeFileSync(PSSTATE, '[]');
  const PSWRAP = path.join(T, 'pswrap.mjs');
  fs.writeFileSync(PSWRAP, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(PSLOG)}, (process.env.RAVENRY_RELAY ? 'RELAY=' + process.env.RAVENRY_RELAY : 'none') + '\\n');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const procs = JSON.parse(fs.readFileSync(${JSON.stringify(PSSTATE)}, 'utf8')).filter((p) => alive(p.pid));
const f = ${JSON.stringify(PSSTATE)} + '.now';
fs.writeFileSync(f, JSON.stringify(procs));
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(HUB, 'tools', 'stub-ps.mjs'))}, ...process.argv.slice(2)], { env: { ...process.env, STUB_PS_STATE: f }, encoding: 'utf8' });
process.stdout.write(r.stdout || '');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
  const FAKE_IT = path.join(T, 'fake-iterm.json');
  fs.writeFileSync(FAKE_IT, JSON.stringify({ running: true, sessions: [{ uuid: ITERM_UUID, windowId: '7', tty: '/dev/ttys009', title: '✳ Kite tail' }], screens: { [ITERM_UUID]: '❯ \n' } }));
  const FAKE_BIN = path.join(HUB, 'tools', 'fake-iterm.mjs');
  const env = {
    PATH: '/usr/bin:/bin', HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_HUB_BIND: '127.0.0.1', RAVENRY_TERMINAL: 'ravenry',
    RAVENRY_RUNTIME_DIR: path.join(T, 'run'), RAVENRY_STATE_DIR: path.join(T, 'state'),
    MC_PS_BIN: PSWRAP, MC_LSOF_BIN: PSWRAP, CLAUDE_CONFIG_DIR: CLAUDE_DIR, MC_CLAUDE_PROJECTS: path.join(CLAUDE_DIR, 'projects'), MC_CLAUDE_SETTINGS: path.join(CLAUDE_DIR, 'settings.json'),
    MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1', MC_APPS: 'iterm,ravenry',
    CMUX_BIN: path.join(HUB, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
    ITERM_OSASCRIPT_BIN: FAKE_BIN, MC_OSASCRIPT_BIN: FAKE_BIN, RAVENRY_ITERM_PYTHON: FAKE_BIN, FAKE_ITERM_STATE: FAKE_IT,
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(HUB, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
    ELECTRON_RUN_AS_NODE: '1',
  };
  fs.writeFileSync(env.MC_CLAUDE_SETTINGS, '{}');
  fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [], screens: {} }));
  // As the service runs it: the app's executable as Node, the hub its child.
  board = spawn(EXE, [path.join(HUB, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let blog = '';
  board.stdout.on('data', (d) => { blog += d; });
  board.stderr.on('data', (d) => { blog += d; });
  const state = async () => (await fetch(BASE + '/api/state')).json();
  const up = await until(30000, state);
  check('6 hub: a test board runs through the app\'s executable as Node', !!up, blog.slice(-400));

  // The session's transcript, so it reads as a conversation.
  const TR = path.join(CLAUDE_DIR, 'projects', `${SID}.jsonl`);
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  fs.writeFileSync(TR, [
    { type: 'user', cwd: PROJ, sessionId: SID, timestamp: at(60), message: { role: 'user', content: 'Make the kite tail flutter' } },
    { type: 'assistant', cwd: PROJ, sessionId: SID, timestamp: at(50), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The tail now flutters.' }], usage: { input_tokens: 5, output_tokens: 20 } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const ip = (ev, extra = {}) => ({ ...input(SID, ev, extra), transcript_path: TR });
  const live = startStandin([
    { command: ELECTRON_FORM(), input: ip('SessionStart', { source: 'startup' }) },
    { command: ELECTRON_FORM(), input: ip('UserPromptSubmit', { prompt: 'Make the kite tail flutter' }) },
    { command: ELECTRON_FORM(), input: ip('Stop', { last_assistant_message: 'The tail now flutters.' }) },
  ], { board: BASE, stay: true });
  kids.push(live.child);
  const lo = await live.done;
  // What the board's ps says of it while it runs: Claude Code in that iTerm2 tab.
  fs.writeFileSync(PSSTATE, JSON.stringify([{ pid: lo.pid, ppid: process.pid, rssKb: 300000, startedAt: new Date(Date.now() - 90000).toISOString(), command: `claude --session-id ${OLD}`, cwd: PROJ, env: `TERM_PROGRAM=iTerm.app ITERM_SESSION_ID=w0t0p0:${ITERM_UUID}` }]));
  // Claude Code's name file for the process, naming the session it started as.
  fs.writeFileSync(path.join(CLAUDE_DIR, 'sessions', `${lo.pid}.json`), JSON.stringify({ pid: lo.pid, sessionId: OLD, name: 'kite-7f', startedAt: Date.now() - 90000 }));
  const recorded = linesOf(SID).map((l) => l.claude_pid);
  check('6 hub: the live session\'s events, reported through the relay, name its process', recorded.length === 3 && recorded.every((p) => p === lo.pid), JSON.stringify({ standin: lo.pid, relays: lo.shells, recorded }));
  const sessionOf = (st) => { const p = (st.projects || []).find((x) => x.id === 'kite'); return p ? p.sessions.find((s) => s.sessionId === SID) || null : null; };
  const s1 = await until(20000, async () => { const s = sessionOf(await state()); return s && s.outside && s.outside.open === true ? s : null; }) || sessionOf(await state());
  check('6 hub: running in iTerm2, it says it is open there, and Continue is not offered', !!s1 && s1.term === 'iterm' && s1.outside && s1.outside.open === true && s1.outside.resumable === false, JSON.stringify(s1 && { term: s1.term, outside: s1.outside, surfaceId: s1.surfaceId }) + (s1 ? '' : blog.slice(-600)));
  const r1 = await fetch(BASE + '/api/sessions/resume', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ projectId: 'kite', sessionId: SID }) });
  const r1b = await r1.json().catch(() => ({}));
  check('6 hub: Continue in Ravenry asked anyway is refused while it runs there (409)', r1.status === 409 && r1b.open === true, `${r1.status} ${JSON.stringify(r1b)}`);
  const names = await until(20000, async () => { const j = await (await fetch(BASE + '/api/session-names')).json(); return j.names && j.names['kite-7f'] ? j : null; });
  const nm = names && names.names['kite-7f'];
  check('6 hub: its session name resolves through its process to the session its hooks named (not the one its name file started as)', !!nm && nm.sessionId === SID && nm.live === true && nm.projectId === 'kite', JSON.stringify(names));

  // It ends (the process goes, as when its tab is closed).
  live.child.kill('SIGKILL');
  const s2 = await until(20000, async () => { const s = sessionOf(await state()); return s && s.outside && s.outside.open === false ? s : null; }) || sessionOf(await state());
  check('6 hub: its process gone, it says it ended there and offers Continue', !!s2 && s2.outside && s2.outside.open === false && s2.outside.resumable === true, JSON.stringify(s2 && s2.outside));
  const psEnv = fs.existsSync(PSLOG) ? fs.readFileSync(PSLOG, 'utf8').trim().split('\n') : [];
  check('6 hub: what the board starts carries no RAVENRY_RELAY', psEnv.length > 0 && psEnv.every((l) => l === 'none'), `${psEnv.length} runs: ${[...new Set(psEnv)].join(', ')}`);
} catch (e) {
  check('ran to the end', false, e.stack || e.message);
} finally {
  if (board) { board.kill('SIGTERM'); await sleep(500); }
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  if (!process.env.KEEP) fs.rmSync(T, { recursive: true, force: true });
}
console.log(`hookpidcheck: ${passes} pass, ${fails} fail (${path.basename(APP)}, ${EXE})`);
process.exit(fails ? 1 : 0);
