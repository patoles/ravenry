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
import path from 'node:path';

// An allow-list of in-flight words, not a deny-list of finished ones: a
// status this file has never seen counts as not running, so it can never
// hold a hand-off back forever. Claude Code only sends running and pending;
// in_progress is here in case a later version renames them.
const RUNNING = new Set(['running', 'pending', 'in_progress']);
// Claude Code's own housekeeping, not work the session started.
const HOUSEKEEPING = new Set(['dream', 'auto-mode scan', 'memory import', 'memory save']);
// Transcripts reach 100 MB; the scan reads at most this much of the end.
const MAX_READ = 64 * 1024 * 1024;

function readTail(file, max = MAX_READ) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch { return null; } finally { fs.closeSync(fd); }
}

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

function finishedIn(mk, ids) {
  const out = new Set();
  for (const id of ids) {
    const at = mk.end.get(id);
    if (at != null && !(mk.restart.get(id) > at)) out.add(id);
  }
  return out;
}

// Ids of tasks the transcripts show as finished: a completed, failed or
// killed notification with no restart after it, in the session's own
// transcript or in the transcript of the subagent that started the task.
// A task a subagent started (a shell, say) whose subagent has finished
// counts as finished too: nothing is left to wait on it.
export function finishedTaskIds(transcriptPath, ids) {
  const want = new Set((ids || []).filter((x) => typeof x === 'string' && x));
  const out = new Set();
  if (!want.size || !transcriptPath) return out;
  const main = readTail(transcriptPath);
  if (main == null) return out;
  const mainMarks = marks(main);
  for (const id of finishedIn(mainMarks, want)) out.add(id);
  const left = [...want].filter((id) => !out.has(id));
  if (!left.length) return out;
  // Not settled by the session's own transcript. A task the session itself
  // started is named there (its launch result carries the id), so one that
  // is named and has no finished notification is running. One that is not
  // named was started by a subagent: find the subagent whose transcript
  // names it, newest first, and stop reading at 96 MB (together they reach
  // hundreds of MB). Its subagent finished: nothing is left to wait on it.
  // Not found at all: running, as Claude Code says.
  const unnamed = left.filter((id) => !main.includes(id));
  if (!unnamed.length) return out;
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((x, y) => y.t - x.t).map((x) => x.f);
  } catch { return out; }
  const ownerOf = (f) => f.slice('agent-'.length, -'.jsonl'.length);
  let budget = 96 * 1024 * 1024;
  const todo = new Set(unnamed);
  for (const f of files) {
    if (!todo.size || budget <= 0) break;
    const text = readTail(path.join(dir, f), Math.min(16 * 1024 * 1024, budget));
    if (!text) continue;
    budget -= text.length;
    const here = [...todo].filter((id) => text.includes(id));
    if (!here.length) continue;
    for (const id of here) todo.delete(id);
    const ended = finishedIn(marks(text), here);
    const ownerDone = finishedIn(mainMarks, [ownerOf(f)]).size > 0;
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
  const look = (text) => { for (const id of ids) if (text.includes(`Monitor started (task ${id}`)) found.add(id); };
  const main = readTail(transcriptPath);
  if (main) look(main);
  if (found.size === ids.length) return found;
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f)); } catch { return found; }
  let budget = 96 * 1024 * 1024;
  for (const f of files) {
    if (found.size === ids.length || budget <= 0) break;
    const text = readTail(path.join(dir, f), Math.min(16 * 1024 * 1024, budget));
    if (!text) continue;
    budget -= text.length;
    look(text);
  }
  return found;
}

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
