// The board's side of hooks/events.mjs: reads <RAVENRY_HOME>/events/*.jsonl into
// one summary per Claude session. The files are the truth; a POST to
// /api/hook-event only adds the event in memory until the next scan sees it
// on disk, and makes the next tick come sooner. Rules: docs/STATE-RULES.md,
// "Events first, screen second".
//
// A session in a ravenryd pane whose hooks run `ravenryd hook` reports to
// its daemon instead of a file: server/ravenryd.mjs hands each report here
// as the same record (ingestDaemon), and the daemon is its truth (it keeps
// its last reports, so a board that restarts reads them again).

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME } from './registry.mjs';

export const EVENTS_DIR = path.join(RAVENRY_HOME, 'events');
const SAFE_ID = /^[A-Za-z0-9_-]{6,80}$/;

// Notification types that mean Claude waits on the user now. Every other type
// (auth_success, elicitation_complete, quota_*, agent_completed, ...) is
// recorded but does not change the state.
export const NEEDS_YOU = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
export const IDLE = 'idle_prompt';

const files = new Map();   // sessionId -> { size, mtimeMs, events }
const posted = new Map();  // sessionId -> events seen only by POST so far
const daemonEvents = new Map(); // sessionId -> events a ravenryd reported
const DAEMON_KEEP = 200;

function key(e) {
  return `${e.at}|${e.event}|${e.notification_type || ''}`;
}

function readFile(sid) {
  const p = path.join(EVENTS_DIR, sid + '.jsonl');
  let st;
  try { st = fs.statSync(p); } catch { files.delete(sid); return []; }
  const c = files.get(sid);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.events;
  const events = [];
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { /* raced with a trim */ }
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e && e.event && e.at) events.push(e); } catch { /* half line */ }
  }
  files.set(sid, { size: st.size, mtimeMs: st.mtimeMs, events });
  return events;
}

// An event the board was told about by POST (the hook writes the file
// first, so this only matters when the file write failed).
export function ingest(e) {
  if (!e || !SAFE_ID.test(String(e.session_id || '')) || !e.event || !e.at) return false;
  const list = posted.get(e.session_id) || [];
  if (!list.some((x) => key(x) === key(e))) list.push(e);
  posted.set(e.session_id, list.slice(-50));
  return true;
}

// An event a ravenryd reported for a session in one of its panes.
export function ingestDaemon(e) {
  if (!e || !SAFE_ID.test(String(e.session_id || '')) || !e.event || !e.at) return false;
  const list = daemonEvents.get(e.session_id) || [];
  if (list.some((x) => key(x) === key(e))) return false;
  list.push(e);
  list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  daemonEvents.set(e.session_id, list.slice(-DAEMON_KEEP));
  return true;
}

// One session's events folded into what the state rules read.
export function summarize(sid, events) {
  const s = {
    sessionId: sid, assistant: null, machine: null, cwd: null, transcriptPath: null, workspaceId: null, surfaceId: null, pane: null, terminal: null, terminalId: null, terminalSession: null,
    startedAt: null, source: null, endedAt: null, endReason: null, pid: null, pidAt: null,
    last: null, lastStop: null, lastPromptAt: null, notification: null, lastEventAt: null, count: events.length,
  };
  for (const e of events) {
    s.lastEventAt = e.at;
    // Which assistant ran the hook (server/assistant.mjs); none recorded is
    // Claude Code, so events written before there was a second read as before.
    if (e.assistant) s.assistant = e.assistant;
    if (e.cwd) s.cwd = e.cwd;
    if (e.transcript_path) s.transcriptPath = e.transcript_path;
    if (e.workspace_id) s.workspaceId = e.workspace_id;
    if (e.surface_id) s.surfaceId = e.surface_id;
    if (e.pane) s.pane = e.pane;
    // A session on a remote machine (server/ravenryd.mjs tags its records).
    if (e.machine) s.machine = e.machine;
    // The terminal of its latest event that names one (a /resume in another
    // terminal moves it).
    if (e.terminal) { s.terminal = e.terminal; s.terminalId = e.terminal_id || null; s.terminalSession = e.terminal_session || null; }
    // The Claude process the session ran in at its latest event (a /resume
    // in another tab moves it, so the newest one counts).
    if (e.claude_pid) { s.pid = Number(e.claude_pid); s.pidAt = e.at; }
    if (e.event !== 'SessionEnd') { s.endedAt = null; s.endReason = null; }
    if (e.event === 'SessionStart') {
      s.startedAt = e.at; s.source = e.source || null;
      // Compaction can happen mid-turn: it does not reset the state.
      if (e.source !== 'compact') s.last = e;
    } else if (e.event === 'SessionEnd') {
      s.endedAt = e.at; s.endReason = e.reason || null; s.last = e;
      // Which copy ended: its process, or its pane (the daemon's own end).
      s.endedBy = { pid: e.claude_pid ? Number(e.claude_pid) : null, terminal: e.terminal || null, terminalId: e.terminal_id || e.pane || null };
    } else if (e.event === 'UserPromptSubmit') {
      s.lastPromptAt = e.at; s.last = e;
    } else if (e.event === 'Stop') {
      s.lastStop = e; s.last = e;
    } else if (e.event === 'Interrupt') {
      // Codex's: the turn ended without a Stop (Esc, or a refused approval).
      s.last = e;
    } else if (e.event === 'Notification') {
      s.notification = e;
      if (NEEDS_YOU.has(e.notification_type) || e.notification_type === IDLE) s.last = e;
    }
  }
  return s;
}

// Every session with an event file (or a posted event), summarized.
export function scan() {
  let names = [];
  try { names = fs.readdirSync(EVENTS_DIR); } catch { /* none yet */ }
  const ids = new Set(names.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((id) => SAFE_ID.test(id)));
  for (const id of posted.keys()) ids.add(id);
  for (const id of daemonEvents.keys()) ids.add(id);
  const out = new Map();
  for (const sid of ids) {
    let disk = readFile(sid);
    const fromDaemon = daemonEvents.get(sid);
    if (fromDaemon) {
      const have = new Set(disk.map(key));
      const add = fromDaemon.filter((e) => !have.has(key(e)));
      if (add.length) disk = [...disk, ...add].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    }
    let events = disk;
    const extra = posted.get(sid);
    if (extra) {
      const have = new Set(disk.map(key));
      const left = extra.filter((e) => !have.has(key(e)));
      if (left.length) events = [...disk, ...left].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      if (left.length) posted.set(sid, left); else posted.delete(sid);
    }
    if (events.length) out.set(sid, summarize(sid, events));
  }
  return out;
}

// A session ended in one place may run on in another: a Claude that runs
// the same session id in another terminal (Move here's "Keep it in cmux"
// ends the Ravenry copy; the cmux one runs on), or a copy started after
// the end. A SessionEnd says only that the copy that sent it ended. So a
// session whose last event is a SessionEnd, while a live process other
// than the one that ended runs it (by its launch argument, or by the
// pid its own events gave), is not ended: it moves to that process's
// terminal, at rest (2026-11-07: the release check's session A left the
// board while it ran in cmux). `procs`: the live sessions' processes
// (server/sessions.mjs: pid, startedAt, argvSession, surfaceId,
// workspaceId, itermId, rexId, ravenryId).
export function outlivedEnds(all, procs) {
  const moved = [];
  for (const s of all.values()) {
    if (!s.endedAt) continue;
    // A process launched for it that has not reported as another session
    // since it started (a /clear moves a process on; its argument stays).
    const elsewhere = (x) => [...all.values()].some((o) => o !== s && o.pid === x.pid && o.pidAt && Date.parse(o.pidAt) >= (Date.parse(x.startedAt || 0) || 0) - 2000);
    // A copy in a Ravenry pane is the board's own case (the pane stays and
    // says the conversation went on elsewhere): only another terminal's.
    // Not the copy that ended (its process, or its pane).
    const ended = s.endedBy || {};
    const isEnded = (x) => (ended.pid && x.pid === ended.pid) || (ended.terminalId && (x.ravenryId === ended.terminalId || x.surfaceId === ended.terminalId || x.itermId === ended.terminalId || x.rexId === ended.terminalId));
    const p = (procs || []).find((x) => x.argvSession === s.sessionId && !x.ravenryId && !isEnded(x) && !elsewhere(x));
    if (!p) continue;
    s.endedAt = null;
    s.endReason = null;
    s.last = s.lastStop || null;
    s.pid = p.pid;
    s.pidAt = p.startedAt || s.pidAt;
    s.outlived = true;
    if (p.surfaceId) { s.terminal = 'cmux'; s.terminalId = p.surfaceId; s.surfaceId = p.surfaceId; s.workspaceId = p.workspaceId || s.workspaceId; s.pane = null; }
    else if (p.itermId) { s.terminal = 'iterm'; s.terminalId = p.itermId; s.surfaceId = null; s.pane = null; }
    else if (p.rexId) { s.terminal = 'rex'; s.terminalId = p.rexId; s.surfaceId = null; s.pane = null; }
    moved.push({ sessionId: s.sessionId, pid: p.pid, terminal: s.terminal });
  }
  return moved;
}

// surfaceId -> the newest session that reported from that tab.
export function bySurface(all) {
  const out = new Map();
  for (const s of all.values()) {
    if (!s.surfaceId) continue;
    const prev = out.get(s.surfaceId);
    if (!prev || s.lastEventAt > prev.lastEventAt) out.set(s.surfaceId, s);
  }
  return out;
}
