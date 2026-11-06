// The Ravenry terminal adapter (docs/TERMINALS.md): panes of ravenryd, the
// daemon that owns Ravenry's own terminals, driven over protocol v1
// (packages/protocol/PROTOCOL.md) on its unix socket. The only module that
// talks to ravenryd.
//
// A pane is named by its id, RAVENRY_PANE in its environment ("p" and seven
// characters), which the hook records; the board's id for it is
// "ravenry:<id>". Pane ids are unique across daemons in practice, so the
// board keys them without the daemon, and finds the daemon that holds one
// when it acts on it.
//
// Besides the terminal operations, this adapter follows each daemon's agent
// status channel (startStatus): what ravenryd panes' hooks report reaches
// the board as the same records hooks/events.mjs writes, and the hub
// decides what a waiting hook answers (the hand-off at a Stop). If the hub
// is down, the daemon lets the session go on.
//
// A test board (RAVENRY_HOME or MC_HOME set) never talks to a daemon of the
// user's: it needs RAVENRY_RUNTIME_DIR set to the test's own folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME_OVERRIDE, RAVENRY_HOME } from './home.mjs';
import { record } from './hookrecord.mjs';
import { decideStop } from './handoffstop.mjs';

const env = process.env;
export const PREFIX = 'ravenry:';
const PANE_RE = /^p[a-z2-7]{7}$/;

export function paneOf(id) {
  const s = String(id || '');
  const p = s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
  return PANE_RE.test(p) ? p : null;
}
export function tabIdOf(paneId) {
  const p = paneOf(paneId);
  return p ? PREFIX + p : null;
}

const held = () => !!HOME_OVERRIDE && !env.RAVENRY_RUNTIME_DIR;

// The client (packages/node-client): installed beside the hub, else this
// repo's copy. Loaded on first use, so a board without it still starts.
let lib = null;
async function nodeClient() {
  if (lib) return lib;
  try { lib = await import('@ravenry/node-client'); } catch {
    lib = await import(new URL('../../packages/node-client/index.mjs', import.meta.url).href);
  }
  return lib;
}

// Where the ravenryd command is: RAVENRY_DAEMON_BIN, then the PATH. null
// when none is there.
export function findBin(e = env, has = fs.existsSync) {
  if (e.RAVENRY_DAEMON_BIN) return e.RAVENRY_DAEMON_BIN === 'none' ? null : e.RAVENRY_DAEMON_BIN;
  for (const d of String(e.PATH || '').split(':')) {
    if (d && path.isAbsolute(d) && has(path.join(d, 'ravenryd'))) return path.join(d, 'ravenryd');
  }
  return null;
}

// ---------------------------------------------------------------- daemons

// socket -> { c (client), version, key } for every daemon that answered.
const conns = new Map();
let statusOpts = null;

// Connects to every daemon in the runtime folder (newest first) and drops
// the connections that closed. Returns the live ones.
async function daemons() {
  if (held()) return [];
  const { daemonSockets, connectSocket } = await nodeClient();
  const socks = daemonSockets();
  for (const [sock, d] of conns) if (d.c.closed || !socks.some((s) => s.socket === sock)) { d.c.close(); conns.delete(sock); }
  await Promise.all(socks.filter((s) => !conns.has(s.socket)).map(async (s) => {
    try {
      const c = await connectSocket(s.socket, { name: 'ravenry-hub', timeoutMs: 2000 });
      const d = { c, version: s.version, key: `${c.hello.daemon.pid}:${c.hello.daemon.started_at}` };
      conns.set(s.socket, d);
      c.on('close', () => { if (conns.get(s.socket) === d) conns.delete(s.socket); });
      if (statusOpts) await follow(d);
    } catch { /* a socket left by a daemon that is gone */ }
  }));
  return socks.map((s) => conns.get(s.socket)).filter(Boolean);
}

// The daemon that holds a pane: the last listing's, else asked.
const where = new Map(); // pane id -> socket
async function daemonOf(id) {
  const p = paneOf(id);
  if (!p) return null;
  const live = await daemons();
  const known = live.find((d) => d.c.socket === where.get(p));
  if (known) return known;
  for (const d of live) {
    try {
      const { panes } = await d.c.request('pane.list', { hidden: true }, { timeoutMs: 3000 });
      if (panes.some((x) => x.id === p)) { where.set(p, d.c.socket); return d; }
    } catch { /* that daemon went away */ }
  }
  return null;
}

async function call(id, method, params, timeoutMs = 6000) {
  const d = await daemonOf(id);
  if (!d) return { ok: false, err: 'That Ravenry tab is closed.' };
  try {
    return { ok: true, result: await d.c.request(method, { pane: paneOf(id), ...params }, { timeoutMs }), out: '', err: '' };
  } catch (e) {
    return { ok: false, err: e.code === 'not_found' ? 'That Ravenry tab is closed.' : `ravenryd: ${e.message}`, out: '' };
  }
}

// { ok, sockets, error }: whether the board can drive Ravenry's panes now.
export async function check() {
  if (held()) return { ok: false, error: 'a test board does not reach the real ravenryd' };
  const live = await daemons();
  return live.length ? { ok: true, daemons: live.map((d) => d.version) } : { ok: false, error: 'ravenryd is not running' };
}

// ---------------------------------------------------------------- reads

// Every pane of every daemon: { id: "ravenry:<id>", paneId, title, name,
// cwd, agent, shell, daemon }. Throws when no daemon answers, so the board
// shows the sessions there watch only, with the reason.
export async function listTabs() {
  const live = await daemons();
  if (!live.length) throw new Error(held() ? 'Ravenry: a test board does not reach the real ravenryd' : 'Ravenry: ravenryd is not running');
  const tabs = [];
  for (const d of live) {
    let panes = [];
    try { ({ panes } = await d.c.request('pane.list', {}, { timeoutMs: 3000 })); } catch { continue; }
    for (const p of panes) {
      where.set(p.id, d.c.socket);
      tabs.push({ id: PREFIX + p.id, paneId: p.id, title: p.title || p.name || '', name: p.name || '', cwd: p.cwd, state: p.state, agent: p.agent || null, shell: p.shell || null, daemon: d.version });
    }
  }
  return tabs;
}

// The screen and up to `lines` lines of scrollback as plain text, trailing
// blanks and blank rows trimmed, ending in a newline (as cmux's
// read-screen); the last `lines` lines. null on failure.
export async function readScreen(id, lines = 40) {
  const r = await call(id, 'pane.capture', { history: Math.max(0, lines) });
  if (!r.ok) return null;
  return tidy(r.result.lines.map((l) => l.text).join('\n'), lines);
}

export function tidy(text, lines) {
  const rows = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const keep = lines > 0 ? rows.slice(-lines) : rows;
  return keep.length ? keep.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------- writes
// Callers must have checked the target (server/index.mjs). Nothing here decides.

// Text as one paste: bracketed when the program asked for it, so newlines
// arrive as written (the daemon encodes it, PROTOCOL.md section 7).
export const pasteText = (id, text) => send(id, [{ text: String(text), mode: 'paste' }]);
// Text key by key, for the "!" that turns on Claude Code's bash mode.
export const typeText = (id, text) => send(id, [{ text: String(text), mode: 'typed' }]);

const KEYS = { enter: 'Enter', up: 'Up', down: 'Down', backspace: 'Backspace', escape: 'Escape', tab: 'Tab' };
export async function pressKey(id, key) {
  if (!KEYS[key]) return { ok: false, err: `the board does not send the ${key} key to Ravenry` };
  return send(id, [{ key: KEYS[key] }]);
}

async function send(id, input) {
  const r = await call(id, 'pane.send', { input });
  return r.ok ? { ok: true, out: '', err: '' } : r;
}

// "Open in Ravenry": the windows that show panes are asked to show it.
export async function focus(id) {
  const r = await call(id, 'pane.focus', {});
  if (!r.ok) return r;
  if (!r.result.displays) return { ok: false, err: 'The Ravenry app is not open, so the board cannot show the tab there.' };
  return { ok: true, out: '', err: '' };
}

// A NEW pane running the login shell in `cwd`, named `label`, on the
// daemon of `near` (a pane's id) when it is there, else on the newest
// daemon, which is started when none runs (RAVENRY_DAEMON_BIN or ravenryd
// on the PATH). The caller types the command into it, so the pane outlives
// the command. Returns { ok, surfaceId, surfaceRef }.
export async function openTab({ near = null, cwd = null, label = null } = {}) {
  if (held()) return { ok: false, err: 'a test board does not reach the real ravenryd' };
  let d = near ? await daemonOf(near) : null;
  if (!d) d = (await daemons())[0] || null;
  if (!d) {
    const started = await startDaemon();
    if (!started.ok) return started;
    d = (await daemons())[0] || null;
    if (!d) return { ok: false, err: 'ravenryd started but does not answer' };
  }
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const name = String(label || (cwd ? path.basename(cwd) : '') || 'Claude').slice(0, 60);
  try {
    const { pane } = await d.c.request('pane.new', { cwd: dir, name }, { timeoutMs: 10000 });
    where.set(pane.id, d.c.socket);
    return { ok: true, surfaceId: PREFIX + pane.id, surfaceRef: 'Ravenry tab' };
  } catch (e) {
    return { ok: false, err: `ravenryd did not open a pane: ${e.message}` };
  }
}

function startDaemon() {
  const bin = findBin();
  if (!bin) return Promise.resolve({ ok: false, err: 'ravenryd is not running, and its command is not on this machine' });
  return new Promise((resolve) => {
    const c = spawn(bin, ['serve', '--detach'], { stdio: 'ignore' });
    c.on('error', (e) => resolve({ ok: false, err: `ravenryd did not start: ${e.message}` }));
    c.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, err: `ravenryd serve exited with ${code}` }));
  });
}

// Closes ONE pane and every process in it, which ends the Claude in it; its
// transcript stays. The caller re-checks it first.
export async function close(id) {
  const r = await call(id, 'pane.close', {}, 90000);
  return r.ok ? { ok: true, out: '', err: '' } : r;
}

// ---------------------------------------------------------------- status

// Follows every daemon's agent status channel until stopStatus:
//   onRecord(rec)   a hook event, as hooks/events.mjs records it
//   onChange()      something changed in a pane (refresh sooner)
//   decide(report)  a hook waits: resolve to { stdout, stderr, exit_code }
//                   to answer it, or null to let the session go on
// New daemons are found every `everyMs`.
let poll = null;
const lastSeq = new Map(); // daemon key -> last report seen
export function startStatus(opts) {
  statusOpts = { onRecord: () => {}, onChange: () => {}, decide: async () => null, everyMs: 5000, ...opts };
  for (const d of conns.values()) follow(d);
  const tickNow = () => { daemons().catch(() => {}); };
  tickNow();
  if (poll) clearInterval(poll);
  poll = setInterval(tickNow, statusOpts.everyMs);
  poll.unref();
  return stopStatus;
}

export function stopStatus() {
  statusOpts = null;
  if (poll) clearInterval(poll);
  poll = null;
  for (const d of conns.values()) d.c.close();
  conns.clear();
}

async function follow(d) {
  if (d.following || !statusOpts) return;
  d.following = true;
  const o = statusOpts;
  d.c.on('event', (e) => {
    if (e.event === 'agent.report') { take(d, e.report); o.onChange(); }
    else if (e.event === 'agent.decision') answer(d, e);
    else if (String(e.event).startsWith('pane.')) o.onChange();
  });
  try {
    await d.c.request('events.subscribe', {});
    if (d.c.has('agent.decisions')) await d.c.request('agent.decisions', {});
    // What this daemon reported while the hub was not following it.
    for (;;) {
      const r = await d.c.request('agent.events', { since: lastSeq.get(d.key) || 0, limit: 1000 });
      for (const rep of r.reports) take(d, rep);
      if (r.reports.length < 1000) break;
    }
    o.onChange();
  } catch { /* the daemon went away: found again at the next poll */ }
}

function take(d, rep) {
  if (!rep || rep.seq <= (lastSeq.get(d.key) || 0)) return;
  lastSeq.set(d.key, rep.seq);
  const rec = recordOf(rep);
  if (rec && statusOpts) statusOpts.onRecord(rec);
}

async function answer(d, e) {
  let reply = null;
  try { reply = await statusOpts.decide(e.report); } catch { reply = null; }
  try { await d.c.request('agent.decide', { request: e.request, ...(reply ? { reply } : {}) }, { timeoutMs: 2000 }); } catch { /* timed out on the daemon's side */ }
}

// A daemon's agent report as the board's hook record (server/hookrecord.mjs),
// or null for a report the board's sessions do not use (a program's own
// status report, which the app shows from the pane).
export function recordOf(rep) {
  if (!rep) return null;
  if (rep.source === 'hook' && rep.data && typeof rep.data.session_id === 'string') {
    const paneEnv = rep.pane ? { RAVENRY_PANE: rep.pane, TERM_PROGRAM: 'ravenry' } : {};
    return record(rep.assistant, rep.data, { env: paneEnv, ppid: rep.pid || 0, daemon: !rep.pane, home: RAVENRY_HOME, at: rep.at });
  }
  // The daemon saw the agent go: its pane's process exited, or the shell's
  // prompt came back without a SessionEnd.
  if (rep.source === 'daemon' && rep.state === 'ended' && rep.session) {
    return { at: rep.at, event: 'SessionEnd', session_id: rep.session, assistant: rep.assistant, reason: rep.event === 'exit' ? 'pane_exited' : 'shell_prompt', terminal: 'ravenry', terminal_id: rep.pane };
  }
  return null;
}

// The hub's answer to a waiting hook: the clean hand-off at a Stop of
// Claude Code or Codex (server/handoffstop.mjs), in their hook format.
export async function handoffDecider(rep) {
  if (!rep || rep.source !== 'hook' || rep.event !== 'Stop' || !rep.data) return null;
  if (rep.assistant !== 'claude' && rep.assistant !== 'codex') return null;
  const out = await decideStop(rep.data, {
    assistant: rep.assistant,
    tab: rep.pane ? { surfaceId: PREFIX + rep.pane } : null,
    codexDaemon: async () => !rep.pane,
  });
  return out ? { stdout: JSON.stringify(out) + '\n' } : null;
}
