// The Rex adapter (docs/TERMINALS.md). The only module that runs Rex's
// command-line tool, `rex`: it lists Rex's sessions, windows (tabs) and
// blocks (panes), reads a pane's screen, types text and keys into it, opens
// a tab or a session, closes a pane, and asks the Rex app to show one.
//
// A pane is named by its block id, REX_BLOCK in its environment
// ("block:<uuid>"), which the hook records; the board's id for it is
// "rex:<uuid>". A full block id works without its session (-s), measured
// on Rex Beta 0.1.0 (1829), API revision 11.
//
// Every call passes --autostart=false, so the board never starts a Rex
// server. Before the first call, and again every so often, `rex whoami`
// says whether a server answers and which API revision it speaks; with no
// command, no server or a revision this board was not built for, Rex
// sessions are watch only and say why.
//
// A test board (RAVENRY_HOME or MC_HOME set) never runs the real rex: it
// needs RAVENRY_REX_BIN (tools/fake-rex.mjs) or MC_REX_REAL=1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { HOME_OVERRIDE } from './home.mjs';

const env = process.env;
export const PREFIX = 'rex:';
// The API revisions this adapter was built and measured against.
export const KNOWN_REVISIONS = [11];
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const APP_SUPPORT_BIN = path.join(os.homedir(), 'Library', 'Application Support', 'com.superlogical.rex', 'RexServer', 'Versions', 'Current', 'Rex Server.app', 'Contents', 'MacOS', 'rex');
const HELPER = path.join('Contents', 'Helpers', 'Rex Server.rex', 'Contents', 'MacOS', 'rex');

// "block:<uuid>", "rex:<uuid>" or "<uuid>" -> "<uuid>" (lower case), else null.
export function uuidOf(id) {
  const m = String(id || '').match(UUID_RE);
  return m ? m[1].toLowerCase() : null;
}
export function tabIdOf(rexBlock) {
  const u = uuidOf(rexBlock);
  return u ? PREFIX + u : null;
}
const blockOf = (id) => { const u = uuidOf(id); return u ? 'block:' + u : null; };

// Where the rex command is, in this order: RAVENRY_REX_BIN (tests; "none"
// stands for a Mac without Rex), the
// PATH, REX_BIN_DIR (set in every Rex pane), the copy Rex installs under
// Application Support, then the helper inside the app in /Applications.
// null when none is there.
export function findBin(e = env, has = fs.existsSync, apps = () => { try { return fs.readdirSync('/Applications'); } catch { return []; } }) {
  if (e.RAVENRY_REX_BIN) return e.RAVENRY_REX_BIN === 'none' ? null : e.RAVENRY_REX_BIN;
  for (const d of String(e.PATH || '').split(':')) {
    if (d && path.isAbsolute(d) && has(path.join(d, 'rex'))) return path.join(d, 'rex');
  }
  if (e.REX_BIN_DIR && has(path.join(e.REX_BIN_DIR, 'rex'))) return path.join(e.REX_BIN_DIR, 'rex');
  if (has(APP_SUPPORT_BIN)) return APP_SUPPORT_BIN;
  for (const a of apps().filter((x) => /^Rex.*\.app$/.test(x)).sort()) {
    const p = path.join('/Applications', a, HELPER);
    if (has(p)) return p;
  }
  return null;
}

export const REX_BIN = findBin();
const held = () => !!HOME_OVERRIDE && env.MC_REX_REAL !== '1' && !env.RAVENRY_REX_BIN;

function run(args, { timeout = 6000 } = {}) {
  if (!REX_BIN) return Promise.resolve({ ok: false, out: '', err: "Rex's rex command is not on this Mac", code: 'ENOENT' });
  if (held()) return Promise.resolve({ ok: false, out: '', err: 'a test board does not run the real rex', code: 'HELD' });
  return new Promise((resolve) => {
    execFile(REX_BIN, ['--autostart=false', ...args], { timeout, maxBuffer: 96 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const msg = String(stderr || '').trim().split('\n').filter(Boolean)[0] || (err && err.message) || '';
      if (err) resolve({ ok: false, out: stdout || '', err: plainError(msg), code: err.code });
      else resolve({ ok: true, out: stdout, err: '' });
    });
  });
}

// Rex prints "Error: <message>"; keep the message, and say the usual ones
// in the board's words.
function plainError(e) {
  const t = String(e || '').replace(/^Error:\s*/, '').trim();
  if (/no Rex server is running/i.test(t)) return 'Rex is not running (no Rex server answered)';
  if (/(block|window|session) target .* not found|not a valid (block|session)/i.test(t)) return 'That Rex tab is closed.';
  return t || 'rex gave no answer';
}

const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

// ---------------------------------------------------------------- status

// { ok, bin, version, revision, sessions, error }: whether the board may
// drive Rex now. Asked at most every 15 s (5 s after a failure).
let status = null;
export async function check({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && status && now - status.at < (status.ok ? 15000 : 5000)) return status;
  let s;
  if (!REX_BIN) s = { ok: false, bin: null, error: "Rex's rex command is not on this Mac" };
  else {
    const r = await run(['whoami', '--json'], { timeout: 4000 });
    const w = r.ok ? json(r) : null;
    if (!r.ok) s = { ok: false, bin: REX_BIN, error: r.err };
    else if (!w || typeof w.api_revision !== 'number') s = { ok: false, bin: REX_BIN, error: `${REX_BIN} did not answer like Rex's rex command` };
    else if (!KNOWN_REVISIONS.includes(w.api_revision)) s = { ok: false, bin: REX_BIN, version: w.rex_version || null, revision: w.api_revision, error: `Rex's server speaks API revision ${w.api_revision}, and this board was built for revision ${KNOWN_REVISIONS.join(' or ')}. Update Ravenry to drive this Rex` };
    else s = { ok: true, bin: REX_BIN, version: w.rex_version || null, revision: w.api_revision, sessions: w.session_count ?? null };
  }
  status = { ...s, at: now };
  return status;
}

async function ready() {
  const s = await check();
  return s.ok ? null : { ok: false, out: '', err: s.error };
}

// ---------------------------------------------------------------- reads

// Every terminal pane in every Rex session: { id: "rex:<uuid>", blockId,
// sessionId, sessionLabel, windowId, windowLabel, title }. Throws when Rex
// cannot be asked (no command, no server, an unknown API revision), so the
// board shows its sessions watch only with the reason.
let lastPanes = new Map(); // id -> pane, from the last listing
export async function listTabs() {
  const s = await check();
  if (!s.ok) throw new Error('Rex: ' + s.error);
  const r = await run(['ls', '--json']);
  if (!r.ok) { status = null; throw new Error('Rex: ' + r.err); }
  const sessions = (json(r) || {}).sessions || [];
  const panes = [];
  await pool(sessions, 4, async (se) => {
    const w = await run(['window', 'ls', '-s', se.session_id, '--json']);
    const view = w.ok ? json(w) : null;
    if (!view) return;
    for (const win of view.windows || []) {
      for (const layer of win.layers || []) {
        for (const b of layer.blocks || []) {
          if (!String(b.flavor || b.creator_name || '').startsWith('com.superlogical.terminal')) continue;
          const id = tabIdOf(b.block_id);
          if (id) panes.push({ id, blockId: b.block_id, sessionId: se.session_id, sessionLabel: se.label || '', windowId: win.window_id, windowLabel: win.label || '', paneLabel: b.label || '', title: '' });
        }
      }
    }
  });
  // Each pane's title (Claude Code's "✳ Topic"): one short call per pane.
  await pool(panes, 6, async (p) => {
    const t = await run(['block', 'call', '-b', p.blockId, 'title'], { timeout: 3000 });
    const v = t.ok ? json(t) : null;
    p.title = v && typeof v.title === 'string' ? v.title : '';
  });
  lastPanes = new Map(panes.map((p) => [p.id, p]));
  return panes;
}

// The session and window of one pane, from the last listing, else asked.
async function where(id) {
  const known = lastPanes.get(PREFIX + uuidOf(id));
  if (known) return { sessionId: known.sessionId, windowId: known.windowId };
  const r = await run(['block', 'inspect', blockOf(id), '--json']);
  const v = r.ok ? json(r) : null;
  return v && v.session_id ? { sessionId: v.session_id, windowId: (v.block && v.block.window_id) || null } : null;
}

// The screen and its scrollback as plain text (`rex capture --trim`),
// trailing spaces and blank rows trimmed, ending in a newline like cmux's
// read-screen; the last `lines` lines. null on failure.
export async function readScreen(id, lines = 40) {
  const b = blockOf(id);
  if (!b || await ready()) return null;
  const r = await run(['capture', '-b', b, '--trim'], { timeout: 5000 });
  if (!r.ok) return null;
  return tidy(r.out, lines);
}

export function tidy(text, lines) {
  const rows = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const keep = lines > 0 ? rows.slice(-lines) : rows;
  return keep.length ? keep.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------- writes
// Callers must have checked the target (server/index.mjs). Nothing here decides.

// Text as typed, with no Enter. `rex send` sends exact bytes and a line
// break is Enter, so text that holds one goes as a bracketed paste
// (ESC[200~ ... ESC[201~), which Claude Code's prompt takes as pasted text,
// newlines and all (measured: it arrived as one paste).
export async function pasteText(id, text) {
  const b = blockOf(id);
  if (!b) return { ok: false, err: 'no Rex pane named' };
  const no = await ready();
  if (no) return no;
  const t = String(text);
  const body = /[\r\n]/.test(t) ? `\x1b[200~${t.replace(/\r\n?/g, '\n')}\x1b[201~` : t;
  return run(['send', '-b', b, '--', body]);
}

const KEYS = { enter: 'enter', up: 'up', down: 'down', backspace: 'backspace' };

// One named key through `rex send-key` (the arrows arrive as ESC[A / ESC[B).
export async function pressKey(id, key) {
  const b = blockOf(id);
  if (!b) return { ok: false, err: 'no Rex pane named' };
  if (!KEYS[key]) return { ok: false, err: `the board does not send the ${key} key to Rex` };
  const no = await ready();
  if (no) return no;
  return run(['send-key', '-b', b, KEYS[key]]);
}

// The Rex app, for showing a session: the connected client whose kind is
// "app". null when none is.
async function appClient() {
  const r = await run(['client', 'ls', '--json']);
  const v = r.ok ? json(r) : null;
  const apps = ((v && v.clients) || []).filter((c) => c.info && c.info.kind === 'app' && c.connection_state !== 'disconnected');
  return apps.length ? apps[0].client_id : null;
}

// "Open in Rex": the pane's window becomes its session's active window and
// the pane its focus (`rex focus`, on the server), then the Rex app is
// asked to show that session (the client action session.select). Rex
// refuses client actions until Remote Control is on in its Settings; the
// board says so in those words and never changes the setting.
export async function focus(id) {
  const b = blockOf(id);
  if (!b) return { ok: false, err: 'no Rex pane named' };
  const no = await ready();
  if (no) return no;
  const w = await where(id);
  if (!w) return { ok: false, err: 'That Rex tab is closed.' };
  const f = await run(['focus', '-s', w.sessionId, b]);
  if (!f.ok) return f;
  const client = await appClient();
  if (!client) return { ok: false, err: 'The Rex app is not open, so the board cannot show the tab there.' };
  const args = ['-C', client, 'do', 'session.select', `session_id=${w.sessionId}`];
  if (w.windowId) args.push(`window_id=${w.windowId}`);
  const r = await run(args);
  if (r.ok) return { ok: true, out: r.out, err: '' };
  if (/remote control|not allowed|not permitted|permission|denied|disabled|refus/i.test(r.err)) return { ok: false, err: "Turn on Remote Control in Rex's Settings so the board can show sessions in Rex." };
  return { ok: false, err: 'Rex did not show the tab: ' + r.err };
}

// A NEW tab running the login shell in `cwd`: a window in the session of
// `near` (a pane's id) when it is open, else in `session` (a Rex session
// id) when that is open, else a NEW Rex session named `label`. Never
// focused in the app. The caller types the command into it (as for cmux),
// so the tab outlives the command. Returns { ok, surfaceId, surfaceRef }.
export async function openTab({ near = null, session = null, cwd = null, label = null } = {}) {
  const no = await ready();
  if (no) return no;
  const name = String(label || (cwd ? path.basename(cwd) : '') || 'Claude').slice(0, 60);
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  let sid = null;
  if (near) { const w = await where(near); if (w) sid = w.sessionId; }
  if (!sid && session) {
    const r = await run(['ls', '--json']);
    const v = r.ok ? json(r) : null;
    if (v && (v.sessions || []).some((x) => x.session_id === session)) sid = session;
  }
  let made;
  if (sid) {
    const r = await run(['window', 'new', '-s', sid, name, '-c', dir, '--focus=false', '--json']);
    if (!r.ok) return r;
    const v = json(r);
    made = v && v.block_ids && v.block_ids[0];
  } else {
    const r = await run(['new', name, '-c', dir, '--json']);
    if (!r.ok) return r;
    const v = json(r);
    made = v && v.initial_windows && v.initial_windows[0] && v.initial_windows[0].block_ids && v.initial_windows[0].block_ids[0];
  }
  const id = tabIdOf(made);
  if (!id) return { ok: false, err: 'Rex did not name the new tab' };
  return { ok: true, surfaceId: id, surfaceRef: sid ? 'Rex tab' : 'Rex session' };
}

// Closes ONE pane, which ends the Claude in it; its transcript stays. The
// caller re-checks it first.
export async function close(id) {
  const b = blockOf(id);
  if (!b) return { ok: false, out: '', err: 'no tab named, nothing closed' };
  const no = await ready();
  if (no) return no;
  return run(['block', 'close', b]);
}

// ---------------------------------------------------------------- events

// A hint to refresh sooner, as cmux's events are: one `rex events -s <id>
// --json` per Rex session that holds a pane the board reads (block events,
// such as a title change, a bell, a notification or the program exiting,
// come only per session). `watch(ids, onEvent)` keeps exactly those
// streams open; watch([]) stops them all.
const watchers = new Map(); // session id -> child
// A stream outlives the board unless ended: with no event to write, it
// never notices the pipe closed (seen: one ran on after its session was gone).
process.on('exit', () => { for (const w of watchers.values()) { w.stopped = true; if (w.child) w.child.kill(); } });
export function watch(ids, onEvent) {
  if (!REX_BIN || held() || env.MC_NO_EVENTS === '1') return;
  const want = new Set(ids);
  for (const [sid, w] of watchers) if (!want.has(sid)) { w.stopped = true; if (w.child) w.child.kill(); watchers.delete(sid); }
  for (const sid of want) {
    if (watchers.has(sid)) continue;
    const w = { child: null, stopped: false };
    const start = () => {
      if (w.stopped) return;
      w.child = spawn(REX_BIN, ['--autostart=false', 'events', '-s', sid, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      w.child.stdout.on('data', (d) => {
        buf += d;
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 1);
          if (/"block_event"/.test(line) && /"(title_changed|bell|desktop_notification|child_exited|process_changed)"/.test(line)) onEvent(sid);
        }
      });
      w.child.on('exit', () => { w.child = null; if (!w.stopped) setTimeout(start, 10000); });
      w.child.on('error', () => {});
    };
    watchers.set(sid, w);
    start();
  }
}

// ---------------------------------------------------------------- helpers

export async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}
