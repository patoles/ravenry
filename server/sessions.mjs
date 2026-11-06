// Claude Code and Codex processes, the memory they hold, and closing the
// idle Claude Code ones.
// The rules are written up in docs/SESSIONS.md; keep the two in step.
//
// Reads only: `ps` (every claude process, its RSS and argv), `ps -E` (its
// CMUX_SURFACE_ID, ITERM_SESSION_ID or REX_BLOCK, read once per process), `lsof` (its
// working folder). The closing itself goes through the terminal interface
// (server/terminal.mjs close), called by the server only after it
// re-checked the session right before.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { RAVENRY_HOME } from './registry.mjs';
import { plain, endingQuestion } from './state.mjs';

export const CLOSED_DIR = path.join(RAVENRY_HOME, 'closed');
export const KEEP_DAYS = 14;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOME = os.homedir();
// A test or demo board reads made-up processes instead of this Mac's own
// (tools/stub-ps.mjs, which stands in for both).
const PS_BIN = process.env.MC_PS_BIN || '/bin/ps';
const LSOF_BIN = process.env.MC_LSOF_BIN || '/usr/sbin/lsof';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    // ps and lsof exit 1 when one of the pids asked for is gone; what they
    // printed for the others still counts.
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(out || (err ? null : '')));
  });
}

// ------------------------------------------------------------ processes

// What a claude process is: a session (counted), a helper (skipped), or
// not claude at all. Only argv[0] named exactly `claude` counts, so the
// Claude desktop app (`Claude`) and node scripts that mention claude in a
// path never do.
export function claudeKind(command) {
  const first = String(command || '').split(/\s+/)[0];
  if (path.basename(first) !== 'claude') return null;
  if (/\s--chrome-native-host(\s|$)/.test(command)) return 'helper';
  if (/^\S+\s+(mcp|doctor|update|install|migrate-installer|setup-token|plugin|config)(\s|$)/.test(command)) return 'helper';
  return 'session';
}

// The session id a process was launched with. A fork gets a new id, so its
// argument names the parent and is not used.
export function argvSession(command) {
  const c = String(command || '');
  if (/\s--fork-session(\s|$)/.test(c)) return null;
  const m = c.match(/\s(?:--session-id|--resume|-r)[ =]['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=['"\s]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

// What a codex process is: an interactive session (counted), a helper, or
// not codex at all. Only argv[0] named exactly `codex` counts: the native
// binary the npm package execs (its node launcher is `node .../codex`), so
// the launcher never counts twice. Measured on Codex 0.166.0 (`codex
// --help`): the terminal interface runs with no subcommand, or `resume` or
// `fork`; every other subcommand (exec, which Plans and Ideas run, review,
// app-server, the daemon and VS Code's, mcp, login...) is not a session in
// a tab. Options before the subcommand are skipped, with the value of the
// ones that take one (`codex -c features.x=true app-server`).
const CODEX_SESSION_CMDS = new Set(['resume', 'fork']);
const CODEX_VALUE_OPTS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--local-provider', '--remote']);
export function codexKind(command) {
  const words = String(command || '').split(/\s+/).filter(Boolean);
  if (!words.length || path.basename(words[0]) !== 'codex') return null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') return 'session';
    if (w.startsWith('-')) { if (CODEX_VALUE_OPTS.has(w)) i++; continue; }
    // The first word that is not an option: a subcommand, or the prompt.
    return /^[a-z][a-z-]*$/.test(w) && !CODEX_SESSION_CMDS.has(w) && CODEX_HELPERS.has(w) ? 'helper' : 'session';
  }
  return 'session';
}
const CODEX_HELPERS = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help']);

// The assistant and kind of a process: { assistant, kind } or null.
export function processKind(command) {
  const c = claudeKind(command);
  if (c) return { assistant: 'claude', kind: c };
  const x = codexKind(command);
  return x ? { assistant: 'codex', kind: x } : null;
}

// The session a codex process was launched with: `codex resume <id>`.
export function codexArgvSession(command) {
  const m = String(command || '').match(/\sresume\s+['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=['"\s]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

// `ps -axww -o pid=,ppid=,rss=,lstart=,command=` -> claude and codex processes.
export function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(PS_LINE);
    if (!m) continue;
    const k = processKind(m[5]);
    if (!k) continue;
    const started = new Date(m[4]);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), startedAt: isNaN(started) ? null : started.toISOString(), kind: k.kind, assistant: k.assistant, command: m[5] });
  }
  return out;
}

// `ps -E -ww -o pid=,command= -p ...`: the environment follows argv, so the
// last CMUX_SURFACE_ID= on the line is the process's own. ITERM_SESSION_ID
// ("w0t1p0:<UUID>") names its iTerm2 session, used only outside cmux and tmux.
// REX_BLOCK ("block:<uuid>") names its Rex pane, outside cmux and tmux, and
// wins over an ITERM_SESSION_ID inherited from the terminal that started
// Rex's server unless TERM_PROGRAM says iTerm2 (server/termenv.mjs).
export function parseEnv(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s/);
    if (!m) continue;
    const last = (re) => { let v = null; for (const x of line.matchAll(re)) v = x[1]; return v; };
    out.set(Number(m[1]), {
      surfaceId: last(/\sCMUX_SURFACE_ID=([0-9A-Fa-f-]{36})(?=\s|$)/g),
      workspaceId: last(/\sCMUX_WORKSPACE_ID=([0-9A-Fa-f-]{36})(?=\s|$)/g),
      // Inside tmux the iTerm2 session is tmux's client, not this pane.
      itermId: /\sTMUX=/.test(line) ? null : last(/\sITERM_SESSION_ID=(?:\w+:)?([0-9A-Fa-f-]{36})(?=\s|$)/g),
      rexId: /\sTMUX=/.test(line) ? null : last(/\sREX_BLOCK=block:([0-9A-Fa-f-]{36})(?=\s|$)/g),
    });
    const x = out.get(Number(m[1]));
    if (x.rexId) {
      if (x.itermId && last(/\sTERM_PROGRAM=(\S+)(?=\s|$)/g) === 'iTerm.app') x.rexId = null;
      else x.itermId = null;
    }
  }
  return out;
}

// `lsof -a -d cwd -Fn -p ...` -> pid -> working folder.
export function parseLsof(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

const envCache = new Map(); // pid -> { startedAt, surfaceId, workspaceId }

// Every claude and codex session process with its memory, tab and folder.
export async function readProcesses() {
  const ps = await run(PS_BIN, ['-axww', '-o', 'pid=,ppid=,rss=,lstart=,command=']);
  if (ps == null) throw new Error('ps did not answer');
  const all = parsePs(ps);
  const procs = all.filter((p) => p.kind === 'session');
  const need = procs.filter((p) => { const c = envCache.get(p.pid); return !c || c.startedAt !== p.startedAt; });
  if (need.length) {
    const envs = parseEnv(await run(PS_BIN, ['-E', '-ww', '-o', 'pid=,command=', '-p', need.map((p) => p.pid).join(',')]));
    for (const p of need) envCache.set(p.pid, { startedAt: p.startedAt, surfaceId: null, workspaceId: null, itermId: null, rexId: null, ...(envs.get(p.pid) || {}) });
  }
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of envCache.keys()) if (!alive.has(pid)) envCache.delete(pid);
  const cwds = procs.length ? parseLsof(await run(LSOF_BIN, ['-a', '-d', 'cwd', '-Fn', '-p', procs.map((p) => p.pid).join(',')])) : new Map();
  return {
    at: new Date().toISOString(),
    helpers: all.length - procs.length,
    procs: procs.map((p) => {
      const e = envCache.get(p.pid) || {};
      return { pid: p.pid, rssKb: p.rssKb, startedAt: p.startedAt, assistant: p.assistant, surfaceId: e.surfaceId || null, workspaceId: e.workspaceId || null, itermId: (!e.surfaceId && e.itermId) || null, rexId: (!e.surfaceId && e.rexId) || null, cwd: cwds.get(p.pid) || null, argvSession: p.assistant === 'codex' ? codexArgvSession(p.command) : argvSession(p.command) };
    }),
  };
}

// Right before a close: the process is still the one we saw (same start),
// still a claude session, and still in the same tab (cmux, iTerm2 or Rex).
export async function stillThere(pid, startedAt) {
  const ps = await run(PS_BIN, ['-ww', '-o', 'pid=,ppid=,rss=,lstart=,command=', '-p', String(pid)]);
  const p = parsePs(ps).find((x) => x.pid === pid && x.kind === 'session' && x.assistant === 'claude');
  if (!p || p.startedAt !== startedAt) return null;
  const env = parseEnv(await run(PS_BIN, ['-E', '-ww', '-o', 'pid=,command=', '-p', String(pid)])).get(pid) || {};
  return { rssKb: p.rssKb, surfaceId: env.surfaceId || null, itermId: (!env.surfaceId && env.itermId) || null, rexId: (!env.surfaceId && env.rexId) || null };
}

export async function waitGone(pid, startedAt, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ps = await run(PS_BIN, ['-o', 'pid=,ppid=,rss=,lstart=,command=', '-p', String(pid)]);
    if (!parsePs(ps).some((x) => x.pid === pid && x.startedAt === startedAt)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ------------------------------------------------------------ mapping

// Which session a process holds, and how we know. Never a guess: a process
// none of these name stays unmapped.
//   1. hook events (pid): hooks/events.mjs records claude_pid on every event;
//      the newest session that reported from this pid since it started.
//   2. cmux hook record (pid): cmux's own Claude hook records the pid too.
//   3. the board's mapping of the process's cmux tab (CMUX_SURFACE_ID from
//      its environment), when that mapping is not one of the board's guesses.
//   4. launch argument: `--session-id <id>` or `--resume <id>` in argv. A
//      /clear or /resume inside the session moves it on, which 1 and 2 see,
//      so this comes last.
export function mapProcess(p, { evAll, hooks, boardTab }) {
  const born = p.startedAt ? Date.parse(p.startedAt) - 2000 : 0;
  let best = null;
  for (const e of evAll.values()) {
    if (e.pid !== p.pid || !e.pidAt || Date.parse(e.pidAt) < born) continue;
    if (!best || e.pidAt > best.pidAt) best = e;
  }
  if (best && !best.endedAt) return { sessionId: best.sessionId, method: 'hook events (pid)' };
  const h = (hooks || []).filter((x) => x.pid === p.pid && x.sessionId && x.pidAlive && (!x.updatedAt || Date.parse(x.updatedAt) >= born))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (h) return { sessionId: h.sessionId, method: 'cmux hook record (pid)' };
  const b = p.surfaceId && boardTab ? boardTab.get(p.surfaceId) : null;
  if (b && b.sessionId && !/guess/.test(b.method || '')) return { sessionId: b.sessionId, method: `its tab (${b.method})` };
  if (p.argvSession) return { sessionId: p.argvSession, method: 'launch argument' };
  return null;
}

// ------------------------------------------------------------ the rules

const BUSY = new Set(['working', 'dialog']);

// Where a mapped session goes on the Sessions page.
//   use     in use: working, a dialog open, background tasks or a loop
//           running, or activity in the last `idleMs`.
//   left    idle, but its last message asks the user a question or a reply is
//           half typed in its prompt: listed, not ticked.
//   handed  wrote its hand-off: listed at any age, ticked.
//   idle    no activity for `idleMs` or more: ticked.
export function classify({ st, t, ev, marker, screen, startedAt }, idleMs, now) {
  const state = st ? st.state : 'unknown';
  const handed = !!(marker && (marker.state === 'written' || marker.state === 'resumed'));
  const stop = ev && ev.lastStop;
  const jobs = !!(ev && ev.last && ev.last.event === 'Stop' && ev.last.background_tasks > 0);
  const loops = !!(stop && stop.crons > 0);
  const sc = screen && screen.readable ? screen : null;
  const times = [ev && ev.lastEventAt, t && t.lastActivityAt, t && t.lastTurnEndAt, t && t.lastTextAt, t && t.lastPromptAt]
    .filter(Boolean).map((x) => Date.parse(x)).filter((x) => !isNaN(x));
  // Nothing at all recorded: the process start is the last sign of life.
  const lastAt = times.length ? Math.max(...times) : (startedAt ? Date.parse(startedAt) : null);
  const base = { lastAt: lastAt ? new Date(lastAt).toISOString() : null, handed };
  if (BUSY.has(state)) return { ...base, group: 'use', why: state === 'working' ? 'working' : 'a dialog is open' };
  if (sc && (sc.working || sc.agentsRunning > 0)) return { ...base, group: 'use', why: 'working' };
  if (sc && sc.dialog) return { ...base, group: 'use', why: 'a dialog is open' };
  if (jobs) return { ...base, group: 'use', why: 'background tasks running' };
  if (loops) return { ...base, group: 'use', why: 'a scheduled loop is set' };
  if (!handed && (lastAt == null || now - lastAt < idleMs)) return { ...base, group: 'use', why: 'active recently' };
  if (sc && sc.draft) return { ...base, group: 'left', tag: 'draft' };
  const q = !handed && t && t.lastText ? endingQuestion(t.lastText) : null;
  if (q) return { ...base, group: 'left', tag: 'asked', question: q };
  if (handed) return { ...base, group: 'handed', since: marker.writtenAt || marker.resumedAt || base.lastAt };
  return { ...base, group: 'idle', since: base.lastAt };
}

// The one line a row shows: what the session last said.
export function lastLine({ t, marker, cls, topic }) {
  if (cls && cls.tag === 'draft') return 'Your reply is half typed in its prompt';
  if (cls && cls.tag === 'asked') return cls.question;
  if (cls && cls.handed) {
    const f = marker && marker.handoffFile ? path.basename(marker.handoffFile) : 'its brief';
    return `Handed off to ${f}, a fresh session carried on`;
  }
  const paras = t && t.lastText ? String(t.lastText).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : [];
  let s = paras.length ? plain(paras[paras.length - 1]).replace(/\s+/g, ' ').trim() : '';
  if (s.length > 200) s = s.slice(0, 197).replace(/\s+\S*$/, '') + '...';
  return s || (t && t.title) || topic || '';
}

// A folder outside every project, short enough for a row: ~ for home,
// otherwise ~/.../parent/name.
export function folderLabel(cwd) {
  if (!cwd) return 'Unknown folder';
  if (cwd === HOME) return '~ (home folder)';
  const s = cwd.startsWith(HOME + '/') ? '~' + cwd.slice(HOME.length) : cwd;
  const parts = s.split('/');
  return parts.length > 4 ? `${parts[0] || '/'}/.../${parts.slice(-2).join('/')}`.replace('//', '/') : s;
}

// MC_IDLE_OVERRIDE="<session id>=<minutes>[,...]": a test board's own
// throwaway session can be idle sooner. Never set on the real board.
export function idleOverrides(env = process.env.MC_IDLE_OVERRIDE) {
  const out = new Map();
  for (const part of String(env || '').split(',')) {
    const m = part.trim().match(/^([0-9a-f-]{36})=(\d+(?:\.\d+)?)$/i);
    if (m) out.set(m[1].toLowerCase(), Number(m[2]) * 60000);
  }
  return out;
}

// MC_CLOSE_ALLOW="<id>,<id>": a test board may close and reopen these
// sessions and no other. Unset on the real board.
export function closeAllow(env = process.env.MC_CLOSE_ALLOW) {
  if (!env) return null;
  return new Set(String(env).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}

// ------------------------------------------------------------ recently closed

function recordPath(id) {
  return UUID.test(String(id || '')) ? path.join(CLOSED_DIR, String(id).toLowerCase() + '.json') : null;
}

export function writeClosed(rec) {
  const p = recordPath(rec.id);
  if (!p) throw new Error('bad session id');
  fs.mkdirSync(CLOSED_DIR, { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return p;
}

export function readClosed(id) {
  const p = recordPath(id);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function dropClosed(id) {
  const p = recordPath(id);
  if (p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
}

// Newest first. Records older than KEEP_DAYS are deleted here.
export function listClosed(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(CLOSED_DIR); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(CLOSED_DIR, f);
    let r;
    try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!r || !UUID.test(String(r.id || ''))) continue;
    if (!r.closedAt || now - Date.parse(r.closedAt) > KEEP_DAYS * 86400000) { try { fs.unlinkSync(p); } catch { /* raced */ } continue; }
    out.push(r);
  }
  return out.sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
}
