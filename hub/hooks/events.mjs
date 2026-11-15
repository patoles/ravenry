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
import { RAVENRY_HOME } from '../server/home.mjs';
import { assistantOf, codexDaemon, hookParent } from '../server/assistanthook.mjs';
import { record } from '../server/hookrecord.mjs';
import * as sessionenv from '../server/sessionenv.mjs';

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
  // The PATH this session runs with (the assistant's, which this hook
  // inherits), so the board can start a session after it as a program of
  // its new tab, never typed into a shell (server/sessionenv.mjs). Also in
  // a ravenryd pane, before this copy stands down. Not from Codex's daemon,
  // whose environment is another terminal's.
  if (input.hook_event_name === 'SessionStart' && process.env.PATH && !(ASSISTANT === 'codex' && await codexDaemon(hookParent()))) {
    sessionenv.write(RAVENRY_HOME, input.session_id, { assistant: ASSISTANT, PATH: process.env.PATH });
    sessionenv.prune(RAVENRY_HOME);
  }
  // In a ravenryd pane whose hooks also run `ravenryd hook` (the hook
  // command says so with --ravenryd), the daemon reports the event: this
  // copy stands down so the board does not get it twice.
  if (process.argv.includes('--ravenryd') && process.env.RAVENRY_PANE && process.env.RAVENRY_SOCKET) return;
  // The assistant's process: this hook's parent, or the one the app's
  // executable run as Node stands in for (server/assistanthook.mjs).
  const ppid = hookParent();
  const r = record(ASSISTANT, input, { env: process.env, ppid, daemon: ASSISTANT === 'codex' && await codexDaemon(ppid), home: RAVENRY_HOME });
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
