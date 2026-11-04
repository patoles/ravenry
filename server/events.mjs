// The board's side of hooks/events.mjs: reads <RAVENRY_HOME>/events/*.jsonl into
// one summary per Claude session. The files are the truth; a POST to
// /api/hook-event only adds the event in memory until the next scan sees it
// on disk, and makes the next tick come sooner. Rules: docs/STATE-RULES.md,
// "Events first, screen second".

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

// One session's events folded into what the state rules read.
export function summarize(sid, events) {
  const s = {
    sessionId: sid, assistant: null, cwd: null, transcriptPath: null, workspaceId: null, surfaceId: null, pane: null, terminal: null, terminalId: null,
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
    // The terminal of its latest event that names one (a /resume in another
    // terminal moves it).
    if (e.terminal) { s.terminal = e.terminal; s.terminalId = e.terminal_id || null; }
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
  const out = new Map();
  for (const sid of ids) {
    const disk = readFile(sid);
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
