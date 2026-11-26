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
// Remote machines (server/machines.mjs): the daemons the hub reaches with
// `ssh host ravenryd proxy` count as daemons here too. Their panes keep the
// same "ravenry:<id>" tab ids, and everything below (listing, typing, the
// status channel, hook decisions, checkpoints) works on them unchanged;
// each pane, record and checkpoint says its `machine` (null on this one).
// The hand-off on a remote pane reads the transcript and the brief on that
// machine through the daemon's file.stat and file.read (remoteIo).
//
// A test board (RAVENRY_HOME or MC_HOME set) never talks to a daemon of the
// user's: it needs RAVENRY_RUNTIME_DIR set to the test's own folder.

import { phase } from './startlog.mjs';
import * as shared from './slice.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME_OVERRIDE, RAVENRY_HOME } from './home.mjs';
import { record, deferredTasks } from './hookrecord.mjs';
import { stateInput } from './assistanthook.mjs';
import * as assistants from './assistants.mjs';
import { runningTasksAsync, logTasks, kindsOf } from './tasks.mjs';
import { decideStop } from './handoffstop.mjs';
import * as machines from './machines.mjs';
import { answerKey } from './person.mjs';
import { waitReady } from './launch.mjs';

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

// The sockets of the daemons that run in the board's runtime folder (none
// for a test board without its own folder), without connecting.
export async function localSockets() {
  if (held()) return [];
  const { daemonSockets } = await nodeClient();
  return daemonSockets();
}

// socket -> { c (client), version, key, id, machine } for every local
// daemon that answered; remote ones (machine set, id "ssh:<name>") come
// from server/machines.mjs.
const conns = new Map();
const remotes = new WeakMap(); // a remote machine's client -> its entry
let statusOpts = null;

// Connects to every daemon in the runtime folder (newest first) and drops
// the connections that closed. Returns the live ones, local first, then
// one per connected machine.
async function daemons() {
  if (held()) return [];
  const { daemonSockets, connectSocket } = await nodeClient();
  const socks = daemonSockets();
  for (const [sock, d] of conns) if (d.c.closed || !socks.some((s) => s.socket === sock)) { d.c.close(); conns.delete(sock); }
  await Promise.all(socks.filter((s) => !conns.has(s.socket)).map(async (s) => {
    try {
      const c = await connectSocket(s.socket, { name: 'ravenry-hub', timeoutMs: 2000, answerKey: answerKey() });
      const d = { c, version: s.version, key: `${c.hello.daemon.pid}:${c.hello.daemon.started_at}`, id: s.socket, machine: null };
      conns.set(s.socket, d);
      c.on('close', () => { if (conns.get(s.socket) === d) conns.delete(s.socket); if (statusOpts && statusOpts.onLost) statusOpts.onLost(s.socket); });
      if (statusOpts) await follow(d);
    } catch { /* a socket left by a daemon that is gone */ }
  }));
  return [...socks.map((s) => conns.get(s.socket)).filter(Boolean), ...machines.connected().map(remoteEntry)];
}

function remoteEntry(m) {
  let d = remotes.get(m.c);
  if (!d) {
    const h = m.c.hello && m.c.hello.daemon ? m.c.hello.daemon : {};
    d = { c: m.c, version: m.version || h.version, key: `${m.name}|${h.pid}:${h.started_at}`, id: m.id || `ssh:${m.name}`, machine: m.name };
    remotes.set(m.c, d);
  }
  return d;
}

// Keeps a connection to every machine in the registry's settings, and
// follows each one's status channel once it connects (the hub calls it at
// start, with startStatus; tests call it on its own).
let machinesOn = false;
export async function startMachines() {
  if (machinesOn || held()) return;
  machinesOn = true;
  const { connect } = await nodeClient();
  machines.start({
    connect,
    onUp: (m) => { const d = remoteEntry({ name: m.m.name, id: m.id, c: m.c, version: m.version }); if (statusOpts) { if (statusOpts.onMachine) statusOpts.onMachine(m.m.name, true, d.version || null); follow(d).then(() => statusOpts && statusOpts.onChange()); } },
    onDown: (m) => { if (statusOpts) { if (statusOpts.onMachine) statusOpts.onMachine(m.m.name, false, m.version || null); if (statusOpts.onLost) statusOpts.onLost(m.id || `ssh:${m.m.name}`); statusOpts.onChange(); } },
  });
}
export function stopMachines() { machinesOn = false; machines.stop(); }

// The machine a pane runs on, as the last listing saw it: a name, or null
// for this machine (and for a pane it does not know).
export function machineOfTab(id) {
  const p = paneOf(id);
  const at = p ? where.get(p) : null;
  // "ssh:<name>", or "ssh:<name>@<version>" for an older daemon there.
  return at && at.startsWith('ssh:') ? at.slice(4).split('@')[0] : null;
}

// The daemon that holds a pane: the last listing's, else asked.
const where = new Map(); // pane id -> socket
async function daemonOf(id) {
  const p = paneOf(id);
  if (!p) return null;
  const live = await daemons();
  const known = live.find((d) => d.id === where.get(p));
  if (known) return known;
  for (const d of live) {
    try {
      const { panes } = await d.c.request('pane.list', { hidden: true }, { timeoutMs: 3000 });
      if (panes.some((x) => x.id === p)) { where.set(p, d.id); return d; }
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

// A pane as the daemon that holds it lists it (pane.list, hidden ones
// included): its Pane object, or null.
export async function paneInfo(id) {
  const p = paneOf(id);
  const d = p ? await daemonOf(PREFIX + p) : null;
  if (!d) return null;
  try {
    const { panes } = await d.c.request('pane.list', { hidden: true }, { timeoutMs: 3000 });
    return (panes || []).find((x) => x.id === p) || null;
  } catch { return null; }
}

// A request to the daemon that holds a pane (its id, or "ravenry:<id>"):
// { ok, result } or { ok: false, err }.
export async function paneRequest(id, method, params = {}, timeoutMs = 6000) {
  const p = paneOf(id);
  if (!p) return { ok: false, err: 'Not a Ravenry pane.' };
  return call(PREFIX + p, method, params, timeoutMs);
}

// { ok, sockets, error }: whether the board can drive Ravenry's panes now.
export async function check() {
  if (held()) return { ok: false, error: 'a test board does not reach the real ravenryd' };
  const live = await daemons();
  return live.length ? { ok: true, daemons: live.map((d) => d.version) } : { ok: false, error: 'ravenryd is not running' };
}

// ---------------------------------------------------------------- reads

// Every pane of every daemon, this machine's and the remote ones: { id:
// "ravenry:<id>", paneId, title, name, labels, cwd, agent, shell, daemon,
// machine }. Throws when no daemon answers, so the board
// shows the sessions there watch only, with the reason.
// The machines whose last listing did not answer (a connection that
// stopped answering, before its ping finds it): their panes are missing
// from that listing, not closed.
const unlisted = new Set();
export const machineUnlisted = (name) => unlisted.has(name);

// A machine's panes as its daemons last listed them (daemon id -> { machine,
// tabs }). While the hub does not reach that machine (down, or its listing
// did not answer: a sleep, a network change; MACH-011) they stay listed,
// marked `away`, so each session keeps its pane and surface instead of
// turning watch only, and comes back as it was. They go once the machine
// is listed again, or is no longer one of the hub's.
const machineTabs = new Map();
const isAway = (name) => machines.isUp(name) === false || unlisted.has(name);

export async function listTabs() {
  const live = await daemons();
  if (!live.length && !machineTabs.size) throw new Error(held() ? 'Ravenry: a test board does not reach the real ravenryd' : 'Ravenry: ravenryd is not running');
  const tabs = [];
  const listed = new Set();
  for (const d of live) {
    let panes = [];
    try { ({ panes } = await d.c.request('pane.list', {}, { timeoutMs: 3000 })); } catch { if (d.machine) unlisted.add(d.machine); continue; }
    if (d.machine) unlisted.delete(d.machine);
    const mine = [];
    for (const p of panes) {
      where.set(p.id, d.id);
      mine.push({ id: PREFIX + p.id, paneId: p.id, title: p.title || p.name || '', name: p.name || '', labels: p.labels || {}, cwd: p.cwd, state: p.state, agent: p.agent || null, shell: p.shell || null, daemon: d.version, machine: d.machine });
    }
    tabs.push(...mine);
    if (d.machine) { machineTabs.set(d.id, { machine: d.machine, tabs: mine }); listed.add(d.id); }
  }
  for (const [id, x] of machineTabs) {
    if (listed.has(id)) continue;
    if (machines.isUp(x.machine) === null || !isAway(x.machine)) { machineTabs.delete(id); continue; }
    for (const t of x.tabs) if (!tabs.some((y) => y.id === t.id)) tabs.push({ ...t, away: true });
  }
  // Only a machine's panes kept while it is away, and no daemon answers here.
  if (!live.length && !tabs.length) throw new Error(held() ? 'Ravenry: a test board does not reach the real ravenryd' : 'Ravenry: ravenryd is not running');
  return tabs;
}

// The screen and up to `lines` lines of scrollback as plain text, trailing
// blanks and blank rows trimmed, ending in a newline (as cmux's
// read-screen); the last `lines` lines. null on failure.
export async function readScreen(id, lines = 40) {
  const r = await captureLinks(id, { history: Math.max(0, lines) });
  if (!r.ok) return null;
  const ls = r.result.lines;
  // The same read with each soft-wrapped line joined (a daemon that says
  // `wrapped`), for the Live screen, which lays it out again at the
  // reader's width (a phone's); the state rules read the rows as drawn.
  if (ls.some((l) => l.wrapped)) joinedReads.set(id, tidy(joinWrapped(ls, r.result.cols).join('\n'), 0));
  else joinedReads.delete(id);
  linkReads.set(id, joinLinks(ls, r.result.cols));
  return tidy(ls.map((l) => l.text).join('\n'), lines);
}

// pane.capture with each row's hyperlinks (OSC 8, `links`). A daemon older
// than that option refuses it (bad_request): it is asked without from then on.
const linkless = new Set(); // daemons (pid:started) that refuse `links`
async function captureLinks(id, params) {
  const d = await daemonOf(id);
  const key = d ? d.key || d.id : null;
  const ask = !!d && !linkless.has(key);
  const r = await call(id, 'pane.capture', ask ? { ...params, links: true } : params);
  if (r.ok || !ask || !/unknown field "links"/.test(r.err)) return r;
  linkless.add(key);
  return call(id, 'pane.capture', params);
}

const linkReads = new Map();
/** The hyperlinks (OSC 8) of a pane's last read: [{ t: its text, u: its URI, line: the line it is on, soft wraps joined }]. */
export const lastLinks = (id) => linkReads.get(id) ?? [];

/** Rows' hyperlinks on their lines, soft wraps joined: a link cut by the width is one link. */
export function joinLinks(lines, cols = 0) {
  const out = [];
  const joined = joinWrapped(lines, cols);
  let li = 0;
  let open = null; // the last link, while it may run on into the next row
  for (const [i, l] of lines.entries()) {
    for (const k of l.links || []) {
      if (open && open.row === i - 1 && k.col === 0 && k.uri === open.u) { open.t += k.text; open.end = k.col + k.width; open.row = i; continue; }
      if (open) out.push(open);
      open = { t: k.text, u: k.uri, line: joined[li] ?? '', end: k.col + k.width, row: i };
    }
    // Only a link that reaches the end of a soft-wrapped row runs on.
    if (open && !(open.row === i && l.wrapped && open.end >= cols)) { out.push(open); open = null; }
    if (!l.wrapped) li++;
  }
  if (open) out.push(open);
  return out.map(({ t, u, line }) => ({ t: t.trim(), u, line })).filter((k) => k.t);
}

// The visible screen with each row's styled runs (pane.capture `styles`):
// { lines: [{ text, spans: [{ col, width, text, dim, ... }] }], cols, rows,
// cursor }, or null. server/suggestion.mjs reads the prompt's dim text
// (Claude Code's suggested reply) from it, which no plain read shows.
export async function readStyled(id) {
  const r = await call(id, 'pane.capture', { styles: true });
  return r.ok && r.result && Array.isArray(r.result.lines) ? r.result : null;
}

const joinedReads = new Map();
/** The last read of a pane with its soft-wrapped lines joined, or null when none wrapped. */
export const lastJoined = (id) => joinedReads.get(id) ?? null;

/** Rows to lines: a row that runs on (`wrapped`) joins the next, its trailing blanks kept to the width. */
export function joinWrapped(lines, cols = 0) {
  const out = [];
  let cur = '';
  for (const l of lines) {
    const t = String(l.text || '');
    if (l.wrapped) { cur += cols > t.length ? t + ' '.repeat(cols - t.length) : t; continue; }
    out.push(cur + t);
    cur = '';
  }
  if (cur) out.push(cur.replace(/\s+$/, ''));
  return out;
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
// `by` says a person typed it (the composer, the phone, a page's button):
// the daemon then tags the input as the person's in the pane's input log
// (PROTOCOL.md, pane.send). Without it, the input is the hub's own (a
// hand-off's prompt), tagged as this client.
export const pasteText = (id, text, by = null) => send(id, [{ text: String(text), mode: 'paste' }], by);
// Text key by key, for the "!" that turns on Claude Code's bash mode.
export const typeText = (id, text, by = null) => send(id, [{ text: String(text), mode: 'typed' }], by);
// A line typed as if at the keyboard, then Enter: the person's answer to a
// program that waits in its pane (POST /api/program/reply).
export const typeLine = (id, text, by = null) => send(id, [{ text: String(text), mode: 'typed' }, { key: 'Enter' }], by);

const KEYS = { enter: 'Enter', up: 'Up', down: 'Down', backspace: 'Backspace', escape: 'Escape', tab: 'Tab' };
export async function pressKey(id, key, by = null) {
  if (!KEYS[key]) return { ok: false, err: `the board does not send the ${key} key to Ravenry` };
  return send(id, [{ key: KEYS[key] }], by);
}

// The phone's key bar (POST /api/keys): Esc, Tab, the arrows, Enter and
// Ctrl+C, as the person's own keys.
export const BAR_KEYS = { esc: 'Escape', tab: 'Tab', left: 'Left', up: 'Up', down: 'Down', right: 'Right', enter: 'Enter', 'ctrl-c': 'Ctrl+C' };
export async function barKeys(id, keys, by = null) {
  const list = (Array.isArray(keys) ? keys : []).map((k) => BAR_KEYS[k]);
  if (!list.length || list.length > 16 || list.some((k) => !k)) return { ok: false, err: 'Send keys from the key bar: esc, tab, left, up, down, right, enter, ctrl-c.' };
  return send(id, list.map((key) => ({ key })), by);
}

// A daemon that tags input by its source lists pane.inputs; an older one
// refuses the `by` field, so it is sent only where it is known.
export const tagsInput = (c) => !!(c && c.has && c.has('pane.inputs'));

async function send(id, input, by = null) {
  const d = await daemonOf(id);
  const tag = by && tagsInput(d && d.c) ? { by: String(by).slice(0, 64) } : {};
  const r = await call(id, 'pane.send', { input, ...tag });
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
// on the PATH). With `command` (an argv, server/launch.mjs wrapped) the
// pane runs that program instead, which ends in the login shell, so the
// pane outlives the assistant. Returns { ok, surfaceId, surfaceRef }.
export async function openTab({ near = null, cwd = null, label = null, machine = null, labels = null, env = null, command = null, cols = null, rows = null } = {}) {
  if (held()) return { ok: false, err: 'a test board does not reach the real ravenryd' };
  let d = near ? await daemonOf(near) : null;
  if (!d && machine) {
    d = (await daemons()).find((x) => x.machine === machine) || null;
    if (!d) return { ok: false, err: `${machine} is not connected${machineError(machine)}` };
  }
  if (!d) d = (await daemons()).find((x) => !x.machine) || null;
  if (!d) {
    const started = await startDaemon();
    if (!started.ok) return started;
    d = (await daemons()).find((x) => !x.machine) || null;
    if (!d) return { ok: false, err: 'ravenryd started but does not answer' };
  }
  // A folder on another machine is checked there, by the daemon.
  const dir = d.machine ? cwd || undefined : cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const name = String(label || (cwd ? path.basename(cwd) : '') || 'Claude').slice(0, 60);
  try {
    const { pane } = await d.c.request('pane.new', { ...(dir ? { cwd: dir } : {}), name, ...(labels && d.c.has('pane.update') ? { labels } : {}), ...(env ? { env } : {}), ...(command ? { command } : {}), ...(cols && rows ? { cols, rows } : {}) }, { timeoutMs: 10000 });
    where.set(pane.id, d.id);
    return { ok: true, surfaceId: PREFIX + pane.id, surfaceRef: d.machine ? `Ravenry tab on ${d.machine}` : 'Ravenry tab', machine: d.machine, pane };
  } catch (e) {
    return { ok: false, err: `ravenryd did not open a pane: ${e.message}` };
  }
}

// A session started through the hub (server/sessionstart.mjs): a new pane
// in `cwd` on `machine` (or here), labelled. With `program` (an argv,
// server/launch.mjs wrapped) the pane runs the assistant itself, then the
// login shell, so nothing the shell's startup files ask can take the
// command. Without (a remote machine, an assistant the board did not find),
// it runs the login shell and the assistant's line is typed once the shell
// drew its prompt (shell integration's mark, else a quiet screen); a screen
// that asks something is never answered and nothing is typed. Either way
// the pane outlives the assistant. Returns { ok, surfaceId, pane, machine,
// how } or { ok: false, err, question?, surfaceId? }.
export async function startSession({ machine = null, cwd, line, label = null, labels = null, cols = null, rows = null, env = null, program = null }) {
  const t0 = Date.now();
  const at = {};
  const made = await openTab({ machine, cwd, label, labels, env: program ? null : env, command: program || null, ...(cols && rows ? { cols, rows } : {}) });
  at.pane = Date.now() - t0;
  if (!made.ok) return made;
  const d = await daemonOf(made.surfaceId);
  if (!d) return { ok: false, err: 'its pane closed at once' };
  const pane = paneOf(made.surfaceId);
  if (program) return { ok: true, surfaceId: made.surfaceId, surfaceRef: made.surfaceRef, pane: made.pane, machine: d.machine, how: 'program', timing: at };
  try {
    // The shell's first prompt (shell integration): it came after every
    // startup file. Without it, a quiet screen that asks nothing.
    const w = await d.c.request('pane.wait', { pane, prompt: true, since: 0, timeout_ms: 4000 }, { timeoutMs: 6000 });
    at.prompt = Date.now() - t0;
    at.promptBy = w.condition;
    if (w.condition === 'timeout') {
      const r = await waitReady((n) => readScreen(made.surfaceId, n), { limitMs: 11000 });
      at.quiet = Date.now() - t0;
      if (!r.ok) {
        return { ok: false, surfaceId: made.surfaceId, question: r.question,
          err: r.question ? `the terminal was asking something ("${r.question}"), so nothing was typed` : 'the new pane showed no prompt, so nothing was typed' };
      }
    }
    await d.c.request('pane.send', { pane, input: [{ text: line, mode: 'paste' }, { key: 'Enter' }] }, { timeoutMs: 6000 });
    at.typed = Date.now() - t0;
  } catch (e) {
    return { ok: false, err: `the pane opened but the command was not typed: ${e.message}`, surfaceId: made.surfaceId };
  }
  return { ok: true, surfaceId: made.surfaceId, surfaceRef: made.surfaceRef, pane: made.pane, machine: d.machine, how: 'typed', timing: at };
}

// A page's run button (server/pages.mjs): an approve checkpoint on this
// machine's daemon, which the person sees and approves (or edits, or
// refuses) like an agent's; the item's values go in `env`, never in the
// command line. A daemon too old for env refuses it (bad_request), and
// then nothing is shown or run. Returns { ok, checkpoint } or { ok: false,
// status, error }.
export async function newApprove({ title, command, cwd, env = {}, why = '' }) {
  if (held()) return { ok: false, status: 409, error: 'a test board does not reach the real ravenryd' };
  let d = (await daemons()).find((x) => !x.machine) || null;
  if (!d) {
    const started = await startDaemon();
    if (!started.ok) return { ok: false, status: 502, error: `Page buttons that run a command need ravenryd, and ${started.err}.` };
    d = (await daemons()).find((x) => !x.machine) || null;
    if (!d) return { ok: false, status: 502, error: 'ravenryd started but does not answer.' };
  }
  try {
    const params = { kind: 'approve', title: String(title).slice(0, 1000), command, cwd, ...(why ? { why: String(why).slice(0, 1000) } : {}), ...(Object.keys(env).length ? { env } : {}) };
    const { checkpoint } = await d.c.request('checkpoint.new', params, { timeoutMs: 10000 });
    return { ok: true, checkpoint, daemon: d.id };
  } catch (e) {
    if (e.code === 'bad_request' && Object.keys(env).length && /env/.test(e.message)) return { ok: false, status: 409, error: `This ravenryd (${d.version || 'an older one'}) cannot pass a page's values to a command yet, so nothing was asked or run. Update Ravenry.` };
    return { ok: false, status: 502, error: `ravenryd did not take it: ${e.message}` };
  }
}

// A person's answer to a checkpoint, sent to the daemon that holds it
// (server/checkpoints.mjs). `daemon` is the id the hub gave it.
export async function answerCheckpoint(daemon, params) {
  const d = (await daemons()).find((x) => x.id === daemon);
  if (!d) { const e = new Error('that daemon is not connected'); e.code = 'disconnected'; throw e; }
  return d.c.request('checkpoint.answer', params, { timeoutMs: 15000 });
}

// Withdraws a checkpoint at the daemon that holds it (checkpoint.cancel):
// the hub's, when the person answered in the terminal instead
// (server/terminalanswer.mjs).
export async function cancelCheckpoint(daemon, params) {
  const d = (await daemons()).find((x) => x.id === daemon);
  if (!d) { const e = new Error('that daemon is not connected'); e.code = 'disconnected'; throw e; }
  return d.c.request('checkpoint.cancel', params, { timeoutMs: 15000 });
}

// The agent state of a pane on this machine's daemons (pane.list), for a
// decision an agent recorded from it: { assistant, session } or null.
export async function paneAgent(paneId) {
  for (const d of (await daemons()).filter((x) => !x.machine)) {
    try {
      const { panes } = await d.c.request('pane.list', { hidden: true }, { timeoutMs: 5000 });
      const p = (panes || []).find((x) => x.id === paneId);
      if (p) return { assistant: (p.agent && p.agent.assistant) || null, session: (p.agent && p.agent.session) || null };
    } catch { /* the next one */ }
  }
  return null;
}

// A file on the machine of the daemon `daemon` (the hub's id for it),
// read through file.stat and file.read, so a remote machine's file comes
// the same way: { ok, data: Buffer, size } or { ok: false, status, error }.
// At most `max` bytes.
export async function readDaemonFile(daemon, file, { max = 32 << 20 } = {}) {
  const d = (await daemons()).find((x) => x.id === daemon);
  if (!d) return { ok: false, status: 502, error: 'The machine that holds it is not connected.' };
  try {
    const { files } = await d.c.request('file.stat', { paths: [file] }, { timeoutMs: 10000 });
    const f = files && files[0];
    if (!f || f.type !== 'file') return { ok: false, status: 404, error: 'The file is gone.' };
    if (f.size > max) return { ok: false, status: 413, error: `The file is ${Math.round(f.size / 1048576)} MiB; at most ${max >> 20} MiB is served.` };
    const parts = [];
    let off = 0;
    while (off < f.size) {
      const r = await d.c.request('file.read', { path: file, offset: off, limit: Math.min(8 << 20, f.size - off), format: 'raw' }, { timeoutMs: 30000 });
      const b = Buffer.from(r.data || '', 'base64');
      if (!b.length) break;
      parts.push(b);
      off += b.length;
      if (off > max) return { ok: false, status: 413, error: 'The file grew past the limit.' };
    }
    return { ok: true, data: Buffer.concat(parts), size: off };
  } catch (e) {
    return { ok: false, status: e.code === 'not_found' ? 404 : 502, error: e.code === 'not_found' ? 'The file is gone.' : `ravenryd: ${e.message}` };
  }
}

function machineError(name) {
  const m = machines.status().find((x) => x.name === name);
  return m && m.error ? ` (${m.error})` : '';
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
  statusOpts = { onRecord: () => {}, onChange: () => {}, onCheckpoint: () => {}, decide: async () => null, everyMs: 5000, ...opts };
  for (const d of conns.values()) follow(d);
  startMachines().then(() => { for (const m of machines.connected()) follow(remoteEntry(m)); }).catch(() => {});
  const tickNow = () => { daemons().catch(() => {}); };
  tickNow();
  if (poll) clearInterval(poll);
  poll = setInterval(tickNow, statusOpts.everyMs);
  poll.unref();
  return stopStatus;
}

export function stopStatus() {
  statusOpts = null;
  stopMachines();
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
    // Another machine's events go on to the feed (server/feed.mjs); this
    // machine's the CLI reads from its daemons itself.
    if (d.machine && o.onEvent) { try { o.onEvent(e, { machine: d.machine, version: d.version || null }); } catch { /* the feed's own problem */ } }
    if (e.event === 'agent.report') { take(d, e.report); o.onChange(); }
    else if (e.event === 'agent.decision') answer(d, e);
    else if (String(e.event).startsWith('checkpoint.') && e.checkpoint) { o.onCheckpoint(e.checkpoint, { machine: d.machine, daemon: d.id, event: e.event }); o.onChange(); }
    else if (String(e.event).startsWith('pane.')) o.onChange();
  });
  // Each step named in the hub's start-up record, and the event loop given
  // back every 50 ms while a daemon's backlog is taken in.
  const name = d.machine ? `${d.machine}/${d.id}` : d.id;
  let slice = Date.now();
  const breathe = shared.breathe;
  try {
    phase(`daemon ${name}: subscribe`);
    await d.c.request('events.subscribe', {});
    if (d.c.has('agent.decisions')) await d.c.request('agent.decisions', {});
    // The checkpoints open while the hub was away.
    if (d.c.has('checkpoint.list')) {
      phase(`daemon ${name}: checkpoints`);
      const { checkpoints } = await d.c.request('checkpoint.list', {});
      slice = Date.now();
      for (const cp of checkpoints) { o.onCheckpoint(cp, { machine: d.machine, daemon: d.id, event: 'checkpoint.listed' }); await breathe(); }
    }
    // What this daemon reported while the hub was not following it.
    const t0 = Date.now();
    let n = 0;
    // As one batch: no transcript is read per report; each session's
    // running tasks are checked once at the end, on its last Stop.
    const batch = new Map();
    for (;;) {
      phase(`daemon ${name}: report replay`);
      const r = await d.c.request('agent.events', { since: lastSeq.get(d.key) || 0, limit: 1000 });
      slice = Date.now();
      for (const rep of r.reports) { take(d, rep, batch); await breathe(); }
      n += r.reports.length;
      if (r.reports.length < 1000) break;
    }
    phase(`daemon ${name}: running tasks`);
    void settleBatch(batch);
    if (process.uptime() < 120) console.log(`start: daemon ${name}: ${n} reports taken in ${Date.now() - t0} ms`);
    phase('idle');
    o.onChange();
  } catch { /* the daemon went away: found again at the next poll */ }
}

// A Stop's running tasks are checked against its transcript off the main
// thread's way (server/tasks.mjs runningTasksAsync): the record goes on at
// once with what Claude Code listed, and its count is set when the check is
// done. In a backlog (`batch`), only each session's last Stop is checked,
// once, at the end.
function take(d, rep, batch = null) {
  if (!rep || rep.seq <= (lastSeq.get(d.key) || 0)) return;
  lastSeq.set(d.key, rep.seq);
  // A program's own status report (OSC 7501), or the daemon's word on what
  // became of one: the board shows it from its pane (server/programs.mjs),
  // so the panes are listed from now on.
  if (rep.pane && (rep.source === 'program' || rep.program)) { programPanes.add(rep.pane); where.set(rep.pane, d.id); }
  const rec = recordOf(rep, d.machine, false);
  if (rec && rep.pane) where.set(rep.pane, d.id);
  if (rec && deferredTasks.has(rec)) {
    if (batch) batch.set(rec.session_id, rec);
    else void settle(rec);
  }
  if (rec && statusOpts) statusOpts.onRecord(rec);
}

async function settle(rec) {
  const input = deferredTasks.get(rec);
  if (!input) return;
  deferredTasks.delete(rec);
  try {
    const running = await runningTasksAsync(input);
    rec.background_tasks = running.length;
    if (running.length) rec.background_kinds = kindsOf(running); else delete rec.background_kinds;
    logTasks(RAVENRY_HOME, input, running);
  } catch { /* Claude Code's count stands */ }
  if (statusOpts) statusOpts.onChange();
}

async function settleBatch(batch) {
  for (const rec of batch.values()) await settle(rec);
}

async function answer(d, e) {
  let reply = null;
  try { reply = await statusOpts.decide(e.report, { machine: d.machine, client: d.c }); } catch { reply = null; }
  try { await d.c.request('agent.decide', { request: e.request, ...(reply ? { reply } : {}) }, { timeoutMs: 2000 }); } catch { /* timed out on the daemon's side */ }
}

// The panes a program reported its state from (take): while there is one,
// the board lists Ravenry's panes each tick even with no assistant session
// in them, and shows the program from its pane's `agent.program`.
const programPanes = new Set();
export const hasPrograms = () => programPanes.size > 0;

// A daemon's agent report as the board's hook record (server/hookrecord.mjs),
// or null for a report the board's sessions do not keep as an event: a
// program's own status report (OSC 7501) goes to take's programPanes, and
// the board shows the program from its pane (server/programs.mjs).
export function recordOf(rep, machine = null, tasks = true) {
  const r = recordOfReport(rep, tasks);
  if (r && machine) r.machine = machine;
  return r;
}

function recordOfReport(rep, tasks = true) {
  if (!rep) return null;
  if (rep.source === 'hook' && rep.data && typeof rep.data.session_id === 'string') {
    const paneEnv = rep.pane ? { RAVENRY_PANE: rep.pane, TERM_PROGRAM: 'ravenry' } : {};
    // An assistant that reports its state with `--state` (registry hooks
    // 'state' or 'antigravity'): its report as the board's event of that meaning.
    const byState = assistants.reportsByState(rep.assistant);
    const input = byState ? stateInput(rep) : rep.data;
    if (!input) return null;
    const r = record(rep.assistant, input, { env: paneEnv, ppid: rep.pid || 0, daemon: !rep.pane, home: RAVENRY_HOME, at: rep.at, tasks });
    // The daemon passes on no tool input (PROTOCOL.md, agent.report), so a
    // Codex approval's line ("Run <command>") comes from the report's
    // message, which ravenryd hook made from it.
    if (r && r.source_event === 'PermissionRequest' && typeof rep.message === 'string' && rep.message) {
      const t = rep.message.replace(/\s+/g, ' ').trim();
      r.message = t.length > 300 ? t.slice(0, 297) + '...' : t;
    }
    return r;
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
//
// On a remote machine the transcript and the brief are there, not here:
// the decision reads them through that daemon (remoteIo), and the hand-off
// file it names is on that machine too.
export async function handoffDecider(rep, { machine = null, client = null } = {}) {
  if (!rep || rep.source !== 'hook' || rep.event !== 'Stop' || !rep.data) return null;
  // Only an assistant whose Stop hook can hold a session (registry caps.handoff).
  if (!assistants.can(rep.assistant, 'handoff')) return null;
  const io = machine && client ? await remoteIo(client, rep.data) : null;
  if (machine && client && !io) return null; // cannot read there in time: let it stop
  const out = await decideStop(rep.data, {
    assistant: rep.assistant,
    tab: rep.pane ? { surfaceId: PREFIX + rep.pane, machine } : null,
    codexDaemon: async () => !rep.pane,
    ...(io ? { io } : {}),
  });
  // In the words its Stop hook takes (Antigravity CLI: "continue").
  return out ? { stdout: JSON.stringify(assistants.stopReply(rep.assistant, out)) + '\n' } : null;
}

// ---------------------------------------------------------------- remote files

// What the hand-off reads on the machine a session runs on, fetched
// through its daemon before the (synchronous) decision runs: the end of
// the transcript (TRANSCRIPT_TAIL, where the last usage and prompt are),
// whether each folder from the session's cwd up holds .git or BRIEF.md,
// the brief or HANDOFF.md the decision may name, and the hand-off file of
// a marker that waits. Anything not fetched reads as missing, so a slow or
// failed read lets the session stop rather than guess.
export const TRANSCRIPT_TAIL = 4 << 20;
export const remoteStats = { reads: 0, stats: 0 };

export async function remoteIo(c, input, { markerFile = null, extra = [] } = {}) {
  if (!c.has('file.read')) return null;
  const files = new Map(); // path -> { buf, start, size } (start > 0: only the tail)
  const kinds = new Map(); // path -> 'file' | 'dir' | 'none'
  const read = async (p, tail) => {
    if (!p || files.has(p)) return;
    try {
      remoteStats.reads++;
      const r = await c.request('file.read', { path: p, ...(tail ? { tail } : {}), limit: tail || (1 << 20), format: 'raw' }, { timeoutMs: 4000 });
      files.set(p, { buf: Buffer.from(r.data || '', 'base64'), start: r.from, size: r.size });
      kinds.set(p, 'file');
    } catch { kinds.set(p, kinds.get(p) || 'none'); }
  };
  const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : null;
  const ups = [];
  for (let d = cwd; d && ups.length < 24; d = path.dirname(d)) { ups.push(d); if (d === '/') break; }
  const probe = [...ups.flatMap((d) => [path.join(d, '.git'), path.join(d, 'BRIEF.md'), path.join(d, 'HANDOFF.md')]), ...extra].slice(0, 64);
  try {
    if (probe.length) {
      remoteStats.stats++;
      const { files: st } = await c.request('file.stat', { paths: probe }, { timeoutMs: 4000 });
      for (const f of st) kinds.set(f.path, f.type);
    }
    await Promise.all([
      typeof input.transcript_path === 'string' && input.transcript_path.startsWith('/') ? read(input.transcript_path, TRANSCRIPT_TAIL) : null,
      markerFile ? read(markerFile) : null,
      ...probe.filter((p) => /\/(BRIEF|HANDOFF)[^/]*\.md$/.test(p) && kinds.get(p) === 'file').map((p) => read(p)),
    ]);
  } catch { return null; }
  return makeIo(files, kinds, cwd);
}

// A synchronous view of fetched files, in the shape server/handoff.mjs reads
// through (localIo there).
function makeIo(files, kinds, cwd) {
  const gitRoot = (dir) => {
    for (let d = dir; d; d = path.dirname(d)) {
      if (kinds.get(path.join(d, '.git')) && kinds.get(path.join(d, '.git')) !== 'none') return d;
      if (d === '/') break;
    }
    return null;
  };
  return {
    remote: true,
    exists: (p) => (kinds.get(p) || 'none') !== 'none',
    text: (p) => { const f = files.get(p); return f && f.start === 0 ? f.buf.toString('utf8') : null; },
    tail: (p, want) => {
      const f = files.get(p);
      if (!f) return null;
      const start = Math.max(f.start, f.size - want);
      return { buf: f.buf.subarray(start - f.start), start, size: f.size };
    },
    head: (p, want) => { const f = files.get(p); return f && f.start === 0 ? f.buf.subarray(0, want) : null; },
    gitRoot,
    cwd,
  };
}
