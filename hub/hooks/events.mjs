#!/usr/bin/env node
// Claude Code hook (and Codex's, with --assistant=codex): Ravenry's own
// record of each session's state. Registered on SessionStart, SessionEnd,
// UserPromptSubmit, Notification and Stop (no per-tool events, so it stays
// cheap); in Codex on SessionStart, SessionEnd, UserPromptSubmit, Stop,
// PermissionRequest and Interrupt (docs/ASSISTANTS.md). See docs/STATE-RULES.md,
// "Events first, screen second".
//
// For each event it appends one compact JSON line to
// <RAVENRY_HOME>/events/<session_id>.jsonl, then tells the board (best effort,
// 300 ms at most). The file is the truth; the POST only makes the
// board look sooner. It never prints, never blocks a session, and always
// exits 0, whatever goes wrong.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { endingQuestion } from '../server/state.mjs';
import { RAVENRY_HOME } from '../server/home.mjs';
import { runningTasks, logTasks } from '../server/tasks.mjs';
import { terminalOf } from '../server/termenv.mjs';
import { assistantOf, shape, codexDaemon } from '../server/assistanthook.mjs';

const DIR = path.join(RAVENRY_HOME, 'events');
// The board's port: MC_BOARD_URL, else the one the running board wrote to
// <RAVENRY_HOME>/board.json when it started (PORT=4700 ravenry), else 4600.
function boardUrl() {
  if (process.env.MC_BOARD_URL) return process.env.MC_BOARD_URL;
  try {
    const port = Number(JSON.parse(fs.readFileSync(path.join(RAVENRY_HOME, 'board.json'), 'utf8')).port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  } catch { /* no board started yet, or an older one */ }
  return 'http://127.0.0.1:4600';
}
const BOARD = boardUrl();
const POST_MS = 300;
// One file per session. Past MAX_BYTES it is cut to its last KEEP lines, and
// files untouched for PRUNE_DAYS are deleted at the next SessionStart.
const MAX_BYTES = 128 * 1024;
const KEEP = 200;
const PRUNE_DAYS = 14;
const SAFE_ID = /^[A-Za-z0-9_-]{6,80}$/;

// Which assistant runs this hook: `--assistant=codex` in the command Codex's
// hooks.json names (server/hookinstall.mjs); Claude Code's names none.
// Codex's events come in the board's shape (server/assistanthook.mjs).
const ASSISTANT = assistantOf();

const bye = () => process.exit(0);
process.on('uncaughtException', bye);
process.on('unhandledRejection', bye);
// A stuck stdin or a hung board can never hold a session: hard stop.
setTimeout(bye, 1500).unref();

const cap = (s, n) => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

function record(input, daemon = false) {
  const sh = shape(ASSISTANT, input);
  if (!sh) return null;
  const ev = sh.event;
  const r = {
    at: new Date().toISOString(),
    event: ev,
    session_id: input.session_id,
    assistant: ASSISTANT,
    cwd: input.cwd || undefined,
    transcript_path: input.transcript_path || undefined,
    workspace_id: process.env.CMUX_WORKSPACE_ID || undefined,
    surface_id: process.env.CMUX_SURFACE_ID || undefined,
  };
  // The Claude process this session runs in, so the board can tie a process
  // (and its memory) to a session. Claude Code runs a hook through `sh -c`,
  // which execs a single command, so the hook's parent is Claude itself. It
  // costs nothing; the board trusts it only when that pid is a live claude
  // process that started before this event.
  // Codex's hooks run under Codex or its app-server daemon, which holds many
  // sessions, so its pid is kept under its own name and never mapped.
  if (process.ppid > 1) r[ASSISTANT === 'claude' ? 'claude_pid' : ASSISTANT + '_pid'] = process.ppid;
  // Which terminal the session runs in, and its id there (iTerm2's and
  // Terminal's session ids, Rex's block and session), so the board picks the adapter that can reach
  // it, or shows it watch only (docs/TERMINALS.md, server/termenv.mjs).
  // Not from Codex's daemon, whose environment is another terminal's.
  if (daemon) {
    delete r.workspace_id; delete r.surface_id;
    r.codex_daemon = true;
  } else {
    Object.assign(r, terminalOf(process.env));
    // Pane ids of terminals with no adapter yet, recorded for a later one.
    const pane = process.env.TMUX_PANE || process.env.WEZTERM_PANE || process.env.KITTY_WINDOW_ID;
    if (pane) r.pane = pane;
  }
  if (input.agent_id) r.agent_id = input.agent_id;
  if (ev === 'SessionStart') { r.source = input.source || undefined; r.model = input.model || undefined; }
  else if (ev === 'SessionEnd') r.reason = input.reason || undefined;
  else if (ev === 'Notification' && sh.extra.notification_type) Object.assign(r, sh.extra);
  else if (ev === 'Notification') {
    r.notification_type = input.notification_type || undefined;
    r.message = cap(input.message, 300);
    r.title = cap(input.title, 100);
  } else if (ev === 'Stop') {
    const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    // The hand-off hook's bookkeeping line: the board reads the question
    // from the transcript instead (it skips that line).
    if (last.startsWith('Hand-off deferred:')) r.deferred = true;
    else {
      const q = last ? endingQuestion(last) : null;
      r.ends_on_question = !!q;
      if (q) r.question = cap(q, 300);
    }
    // Only tasks still running: Claude Code can keep a finished one listed
    // (server/tasks.mjs checks the transcript). What it sent is logged.
    const running = runningTasks(input);
    logTasks(RAVENRY_HOME, input, running);
    r.background_tasks = running.length;
    if (Array.isArray(input.session_crons) && input.session_crons.length) r.crons = input.session_crons.length;
    if (input.stop_hook_active) r.stop_hook_active = true;
  }
  return r;
}

function trim(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, lines.slice(-KEEP).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

function prune() {
  const old = Date.now() - PRUNE_DAYS * 86400000;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(DIR, f);
    try { if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p); } catch { /* raced */ }
  }
}

// A hand-written HTTP/1.1 POST over a plain socket: loading node:http costs
// about 13 ms per run, more than the rest of the hook together.
// X-Mission-Control is the guard header's name from before the rename, sent
// too so a board started before it still takes the nudge.
function post(line) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/hook-event', BOARD); } catch { return resolve(); }
    const port = Number(u.port) || 80;
    const body = Buffer.from(line);
    const sock = net.connect({ host: u.hostname, port });
    const finish = () => { sock.destroy(); resolve(); };
    sock.setTimeout(POST_MS, finish);
    setTimeout(finish, POST_MS + 20).unref();
    sock.on('error', finish);
    sock.on('data', finish); // the board answered; nothing to read
    sock.on('end', finish);
    sock.on('connect', () => {
      sock.write(`POST ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nX-Ravenry: 1\r\nX-Mission-Control: 1\r\nConnection: close\r\n\r\n`);
      sock.write(body);
    });
  });
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  if (!input || !SAFE_ID.test(String(input.session_id || '')) || !input.hook_event_name) return;
  const r = record(input, ASSISTANT === 'codex' && await codexDaemon());
  if (!r) return;
  const line = JSON.stringify(r);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, r.session_id + '.jsonl');
    fs.appendFileSync(file, line + '\n');
    if (fs.statSync(file).size > MAX_BYTES) trim(file);
    if (r.event === 'SessionStart') prune();
  } catch { /* the POST may still reach the board */ }
  await post(line);
}

main().then(bye, bye);
