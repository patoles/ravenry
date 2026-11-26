// Which of a Stop hook's background_tasks are really still running. Shared
// by the hand-off hook (hooks/handoff-stop.mjs, through server/handoff.mjs)
// and the events hook (hooks/events.mjs). Node built-ins only: both hooks
// run on every stop of every session.
//
// What Claude Code sends (read from its source, 2.1.316 and 2.1.317, and
// captured from a real Stop in 2.1.317): one entry per task it still holds
// as in flight, never a finished one:
//   { id, type, status, description, command? | agent_type? | name? | server?, tool? }
//   type    "shell" | "subagent" | "workflow" | "monitor" | "MCP task" |
//           "teammate" | "cloud session" | "dream" | "auto-mode scan" |
//           "memory import"
//   status  "running" | "pending" (its own filter: status running or
//           pending, and not foregrounded)
// A task drops out of the list once Claude Code marks it finished. But a
// long session can keep tasks it has finished as "running": one
// session of 2026-11-02/03 listed 11 at every stop for hours while its
// transcript held a completed or failed notification for every agent and
// shell it ever started. So the list is checked against the transcript.

import fs from 'node:fs';
import { breathe } from './slice.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RAVENRY_HOME } from './home.mjs';

// An allow-list of in-flight words, not a deny-list of finished ones: a
// status this file has never seen counts as not running, so it can never
// hold a hand-off back forever. Claude Code only sends running and pending;
// in_progress is here in case a later version renames them.
const RUNNING = new Set(['running', 'pending', 'in_progress']);
// Claude Code's own housekeeping, not work the session started.
const HOUSEKEEPING = new Set(['dream', 'auto-mode scan', 'memory import', 'memory save']);
// Transcripts reach 100 MB; the scan reads at most this much of the end.
const MAX_READ = 64 * 1024 * 1024;

const STATUS = /<status>([A-Za-z_]+)<\/status>/;
const TO = /"to":"([A-Za-z0-9_-]+)"/g;

// Per task id in this text: where its last finished notification and its
// last restart are, in one pass each (transcripts reach 100 MB). A
// SendMessage to a finished agent resumes it, so a notification only counts
// when nothing started the task again after it.
function marks(text) {
  const end = new Map();
  for (let i = text.indexOf('<task-id>'); i >= 0; i = text.indexOf('<task-id>', i + 9)) {
    const j = text.indexOf('</task-id>', i);
    if (j < 0 || j - i > 120) continue;
    const st = STATUS.exec(text.slice(j, j + 4000));
    if (st && !RUNNING.has(st[1].toLowerCase())) end.set(text.slice(i + 9, j), i);
  }
  const restart = new Map();
  TO.lastIndex = 0;
  let m;
  while ((m = TO.exec(text))) restart.set(m[1], m.index);
  return { end, restart };
}

// What a transcript says about tasks, read once and then only the bytes
// added since (a cursor per file): where each task's last finished
// notification and last restart are (byte positions, in one order across
// reads), which Monitor calls started, and, for the ids asked about, whether
// the transcript names them. Re-reading up to 64 MB of a transcript's end
// for each Stop report took about 52 ms; replayed for the 761 reports a
// daemon kept, it held the hub's main thread for 40 s (2026-11-07).
const index = new Map(); // file -> { size, end, restart, monitors, named: Map(id -> bool) }
const MONITOR = /Monitor started \(task ([A-Za-z0-9_-]+)/g;

function readRange(file, start, end) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf;
  } catch { return null; } finally { fs.closeSync(fd); }
}

// Folds text read at byte `base` into the entry.
function fold(e, text, base) {
  const mk = marks(text);
  for (const [id, at] of mk.end) e.end.set(id, base + at);
  for (const [id, at] of mk.restart) e.restart.set(id, base + at);
  MONITOR.lastIndex = 0;
  let m;
  while ((m = MONITOR.exec(text))) e.monitors.add(m[1]);
  for (const [id, named] of e.named) if (!named && text.includes(id)) e.named.set(id, true);
}

// The cursor kept on disk, for the Stop hooks: each runs in a process of
// its own, so without it each Stop read the transcript's last 64 MB again
// (twice: the events hook and the hand-off hook). One small file per
// transcript, <RAVENRY_HOME>/cache/tasks/<hash>.json, written whole (a
// rename); the 32 bytes before its cursor tell a rewritten transcript.
const STORE = path.join(RAVENRY_HOME, 'cache', 'tasks');
const storeFile = (file) => path.join(STORE, crypto.createHash('sha1').update(file).digest('hex').slice(0, 20) + '.json');
function sigAt(file, size) {
  const b = readRange(file, Math.max(0, size - 32), size);
  return b ? b.toString('hex') : null;
}
function loadStored(file, size) {
  let j;
  try { j = JSON.parse(fs.readFileSync(storeFile(file), 'utf8')); } catch { return null; }
  if (!j || j.v !== 1 || j.file !== file || !(j.size <= size) || sigAt(file, j.size) !== j.sig) return null;
  const e = { size: j.size, base: j.base, end: new Map(j.end), restart: new Map(j.restart), monitors: new Set(j.monitors), named: new Map(j.named), saved: j.size };
  index.set(file, e);
  return e;
}
function saveStored(file, e) {
  if (e.saved === e.size && !e.dirty) return;
  try {
    fs.mkdirSync(STORE, { recursive: true });
    const out = storeFile(file);
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, file, size: e.size, base: e.base, sig: sigAt(file, e.size), end: [...e.end], restart: [...e.restart], monitors: [...e.monitors], named: [...e.named] }));
    fs.renameSync(tmp, out);
    e.saved = e.size;
    e.dirty = false;
  } catch { /* the cursor is kept in memory; the next process reads again */ }
}

// The entry for a file, brought up to date; `max` caps the first read (its end).
function indexed(file, max = MAX_READ) {
  const e = indexedNow(file, max);
  if (e) saveStored(file, e);
  return e;
}
function indexedNow(file, max) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  let e = index.get(file) || loadStored(file, size);
  if (!e || size < e.size) {
    // First read, or the file was rewritten: its end, whole lines only.
    const start = Math.max(0, size - max);
    const buf = readRange(file, start, size);
    if (!buf) return null;
    const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
    const last = buf.lastIndexOf(0x0a);
    e = { size: last >= 0 ? start + last + 1 : start, end: new Map(), restart: new Map(), monitors: new Set(), named: new Map(), base: start + from };
    if (last >= from) fold(e, buf.toString('utf8', from, last), start + from);
    index.set(file, e);
    if (index.size > 400) index.delete(index.keys().next().value);
    return e;
  }
  if (size > e.size) {
    const buf = readRange(file, e.size, size);
    if (!buf) return e;
    const last = buf.lastIndexOf(0x0a);
    if (last >= 0) { fold(e, buf.toString('utf8', 0, last), e.size); e.size += last + 1; }
  }
  return e;
}

// Whether the transcript names these ids: read from its indexed part once
// per id, then kept up to date by the cursor.
function namedIn(file, e, ids) {
  const ask = ids.filter((id) => !e.named.has(id));
  if (ask.length) {
    const buf = readRange(file, e.base, e.size);
    const text = buf ? buf.toString('utf8') : '';
    for (const id of ask) e.named.set(id, text.includes(id));
    e.dirty = true;
    saveStored(file, e);
  }
  return new Set(ids.filter((id) => e.named.get(id)));
}

function finishedOf(e, ids) {
  const out = new Set();
  for (const id of ids) {
    const at = e.end.get(id);
    if (at != null && !(e.restart.get(id) > at)) out.add(id);
  }
  return out;
}

function subagentFiles(transcriptPath) {
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((x, y) => y.t - x.t).map((x) => x.f);
  } catch { return []; }
}

// Ids of tasks the transcripts show as finished: a completed, failed or
// killed notification with no restart after it, in the session's own
// transcript or in the transcript of the subagent that started the task.
// A task a subagent started (a shell, say) whose subagent has finished
// counts as finished too: nothing is left to wait on it.
export function finishedTaskIds(transcriptPath, ids) {
  const want = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  const out = new Set();
  if (!want.length || !transcriptPath) return out;
  const main = indexed(transcriptPath);
  if (!main) return out;
  for (const id of finishedOf(main, want)) out.add(id);
  const left = want.filter((id) => !out.has(id));
  if (!left.length) return out;
  // Not settled by the session's own transcript. A task the session itself
  // started is named there (its launch result carries the id), so one that
  // is named and has no finished notification is running. One that is not
  // named was started by a subagent: find the subagent whose transcript
  // names it, newest first, at most 96 MB of them in all (16 MB each).
  // Its subagent finished: nothing is left to wait on it. Not found at
  // all: running, as Claude Code says.
  const named = namedIn(transcriptPath, main, left);
  const todo = new Set(left.filter((id) => !named.has(id)));
  if (!todo.size) return out;
  let budget = 96 * 1024 * 1024;
  for (const f of subagentFiles(transcriptPath)) {
    if (!todo.size || budget <= 0) break;
    const e = indexed(f, Math.min(16 * 1024 * 1024, budget));
    if (!e) continue;
    budget -= e.size - e.base;
    const here = [...namedIn(f, e, [...todo])];
    if (!here.length) continue;
    for (const id of here) todo.delete(id);
    const ended = finishedOf(e, here);
    const owner = path.basename(f).slice('agent-'.length, -'.jsonl'.length);
    const ownerDone = finishedOf(main, [owner]).size > 0;
    for (const id of here) if (ownerDone || ended.has(id)) out.add(id);
  }
  return out;
}

// Monitor tasks a Monitor call really started, in the session's transcript
// or a subagent's: its result reads "Monitor started (task <id>, ...". Claude
// Code also lists watches it keeps for itself as running monitors (a page
// published with the Artifact tool keeps one for good); nothing launched
// those, nothing will finish them, and they are not work in progress.
function launchedMonitors(transcriptPath, ids) {
  const found = new Set();
  const main = indexed(transcriptPath);
  if (main) for (const id of ids) if (main.monitors.has(id)) found.add(id);
  if (found.size === ids.length) return found;
  let budget = 96 * 1024 * 1024;
  for (const f of subagentFiles(transcriptPath)) {
    if (found.size === ids.length || budget <= 0) break;
    const e = indexed(f, Math.min(16 * 1024 * 1024, budget));
    if (!e) continue;
    budget -= e.size - e.base;
    for (const id of ids) if (e.monitors.has(id)) found.add(id);
  }
  return found;
}

// ---- the same, for the board's main thread: read in 256 KB chunks, the
// event loop given back between them (a first read of a big transcript is
// tens of MB).
// 256 KB: a 2 MB chunk's lines took the main thread 20 to 40 ms at once.
const CHUNK = 256 * 1024;
// Reads [start, end) of a file as whole lines, chunk by chunk: onText(text,
// base) for each, base the byte position of its first character. Returns
// the position after the last whole line.
async function eachChunk(file, start, end, onText, skipFirst = false) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    let pos = start;
    let carry = Buffer.alloc(0);
    let first = skipFirst;
    while (pos < end) {
      const n = Math.min(CHUNK, end - pos);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, pos);
      let all = carry.length ? Buffer.concat([carry, buf]) : buf;
      let base = pos - carry.length;
      if (first) { const nl = all.indexOf(0x0a); if (nl < 0) { carry = all; pos += n; continue; } all = all.subarray(nl + 1); base += nl + 1; first = false; }
      const last = all.lastIndexOf(0x0a);
      if (last >= 0) { onText(all.toString('utf8', 0, last), base); carry = all.subarray(last + 1); } else carry = all;
      pos += n;
      await breathe();
    }
    return pos - carry.length;
  } finally { await fh.close().catch(() => {}); }
}

async function indexedAsync(file, max = MAX_READ) {
  const e = await indexedAsyncNow(file, max);
  if (e) saveStored(file, e);
  return e;
}
async function indexedAsyncNow(file, max) {
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch { return null; }
  let e = index.get(file) || loadStored(file, size);
  if (!e || size < e.size) {
    const start = Math.max(0, size - max);
    const fresh = { size: start, end: new Map(), restart: new Map(), monitors: new Set(), named: new Map(), base: null };
    const upTo = await eachChunk(file, start, size, (text, base) => { if (fresh.base == null) fresh.base = base; fold(fresh, text, base); }, start > 0);
    if (upTo == null) return null;
    fresh.size = upTo;
    if (fresh.base == null) fresh.base = upTo;
    index.set(file, fresh);
    if (index.size > 400) index.delete(index.keys().next().value);
    return fresh;
  }
  if (size > e.size) {
    const upTo = await eachChunk(file, e.size, size, (text, base) => fold(e, text, base));
    if (upTo != null) e.size = upTo;
  }
  return e;
}

async function namedInAsync(file, e, ids) {
  const ask = ids.filter((id) => !e.named.has(id));
  if (ask.length) {
    const found = new Set();
    await eachChunk(file, e.base, e.size, (text) => { for (const id of ask) if (!found.has(id) && text.includes(id)) found.add(id); });
    for (const id of ask) e.named.set(id, found.has(id));
    e.dirty = true;
    saveStored(file, e);
  }
  return new Set(ids.filter((id) => e.named.get(id)));
}

// runningTasks for the board: the same answer, never holding its main thread.
export async function runningTasksAsync(input) {
  const ts = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
  const live = ts.filter((t) => t && RUNNING.has(String(t.status || '').toLowerCase()) && !HOUSEKEEPING.has(String(t.type || '').toLowerCase()));
  if (!live.length || !input.transcript_path) return live;
  const file = input.transcript_path;
  const ids = [...new Set(live.map((t) => t.id).filter((x) => typeof x === 'string' && x))];
  const main = await indexedAsync(file);
  if (!main) return live;
  const done = finishedOf(main, ids);
  const left = ids.filter((id) => !done.has(id));
  const named = left.length ? await namedInAsync(file, main, left) : new Set();
  const todo = new Set(left.filter((id) => !named.has(id)));
  const mons = new Set(live.filter((t) => String(t.type || '').toLowerCase() === 'monitor').map((t) => t.id));
  const monFound = new Set([...mons].filter((id) => main.monitors.has(id)));
  if (todo.size || monFound.size < mons.size) {
    let budget = 96 * 1024 * 1024;
    for (const f of subagentFiles(file)) {
      if ((!todo.size && monFound.size === mons.size) || budget <= 0) break;
      const e = await indexedAsync(f, Math.min(16 * 1024 * 1024, budget));
      if (!e) continue;
      budget -= e.size - e.base;
      for (const id of mons) if (e.monitors.has(id)) monFound.add(id);
      if (!todo.size) continue;
      const here = [...await namedInAsync(f, e, [...todo])];
      if (!here.length) continue;
      for (const id of here) todo.delete(id);
      const ended = finishedOf(e, here);
      const owner = path.basename(f).slice('agent-'.length, -'.jsonl'.length);
      const ownerDone = finishedOf(main, [owner]).size > 0;
      for (const id of here) if (ownerDone || ended.has(id)) done.add(id);
    }
  }
  return live.filter((t) => !done.has(t.id) && (String(t.type || '').toLowerCase() !== 'monitor' || monFound.has(t.id)));
}

// What a person's "Hand off now" does not wait for: a shell or a monitor
// left running in the background (a dev server, a log tail, a watch). The
// person sees no task there, and it may never end, so a request by hand
// went on waiting for good (a dev server listed at every stop of a session
// at rest). Any other kind (an agent, a workflow, a teammate) is work that
// reports back into the session, and the request waits for it.
export const LEFT_RUNNING = new Set(['shell', 'monitor']);
export const holdsManual = (t) => !LEFT_RUNNING.has(String((t && t.type) || '').toLowerCase());
// The kinds among running tasks, for the event record (background_kinds).
export const kindsOf = (ts) => [...new Set((ts || []).map((t) => String((t && t.type) || '').toLowerCase()).filter(Boolean))].sort();

// The background tasks of a Stop hook input that are still running.
export function runningTasks(input, { transcript = true } = {}) {
  const ts = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
  const live = ts.filter((t) => t && RUNNING.has(String(t.status || '').toLowerCase()) && !HOUSEKEEPING.has(String(t.type || '').toLowerCase()));
  if (!live.length || !transcript || !input.transcript_path) return live;
  const done = finishedTaskIds(input.transcript_path, live.map((t) => t.id));
  let left = live.filter((t) => !done.has(t.id));
  const mons = left.filter((t) => String(t.type || '').toLowerCase() === 'monitor').map((t) => t.id);
  if (mons.length) {
    const launched = launchedMonitors(input.transcript_path, mons);
    left = left.filter((t) => String(t.type || '').toLowerCase() !== 'monitor' || launched.has(t.id));
  }
  return left;
}

// A record of what Claude Code really sent, so the next surprise in this
// list can be read instead of guessed: ids, types and statuses only (never
// a description, command or prompt), the last 200 stops that listed any.
export function logTasks(home, input, running) {
  try {
    const ts = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
    if (!ts.length) return;
    const dir = path.join(home, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'background-tasks.jsonl');
    const line = JSON.stringify({
      at: new Date().toISOString(), session_id: input.session_id,
      listed: ts.map((t) => ({ id: t && t.id, type: t && t.type, status: t && t.status, ...(t && t.agent_type ? { agent_type: t.agent_type } : {}) })),
      running: running.map((t) => t.id),
    });
    fs.appendFileSync(file, line + '\n');
    if (fs.statSync(file).size > 256 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200);
      fs.writeFileSync(file, lines.join('\n') + '\n');
    }
  } catch { /* a log can never fail a stop */ }
}
