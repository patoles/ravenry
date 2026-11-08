// Reads an OpenAI Codex transcript, its rollout file
// (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl),
// into the shape server/transcript.mjs gives a Claude Code transcript, so the
// state rules read both alike. Node built-ins only: the hand-off hook loads
// it at every Codex stop (lastUsage).
//
// What a rollout holds, measured on Codex 0.166.0 (docs/ASSISTANTS.md):
// one JSON record per line, { timestamp, type, payload }.
//   session_meta        payload.id, payload.cwd
//   turn_context        payload.model, payload.cwd, at the start of each turn
//   response_item       payload.type 'message' with role 'user' (a typed
//                       prompt; text starting with "<" is Codex's own:
//                       <environment_context>, <hook_prompt> (a Stop hook's
//                       reason), <turn_aborted>) or role 'assistant'
//                       (content[].output_text); 'custom_tool_call' and
//                       'function_call' (a tool call), '*_output' (its result)
//   event_msg           payload.type 'task_started', 'task_complete' (a turn
//                       ended), 'turn_aborted' (Esc, or a refused permission),
//                       'token_count' (info.last_token_usage, info.model_context_window)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Codex's data folder: CODEX_HOME, else ~/.codex. MC_CODEX_HOME points a
// test at a scratch one.
export function codexHome(env = process.env) {
  return env.MC_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// The hand-off hook's line: what Codex answers when it is not at a clean
// point (server/handoff.mjs DEFERRED; kept in step).
const DEFERRED = 'Hand-off deferred: not at a clean point.';

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    // Whole lines only: the cursor (readRollout) goes on after the last.
    const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
    const last = buf.lastIndexOf(0x0a);
    const text = last >= from ? buf.toString('utf8', from, last) : '';
    return { text, whole: start === 0, end: last >= 0 ? start + last + 1 : start };
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content, kind) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === kind && typeof c.text === 'string').map((c) => c.text).join('\n');
}

// A prompt the user typed (not Codex's own context, nor a hook's reason).
const isUserText = (t) => !!t && !/^\s*</.test(t);

// What a custom tool call ran: Codex 0.166 runs commands through an `exec`
// tool whose input is a short script naming `cmd: "..."`.
function toolWhat(p) {
  const raw = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
  const m = raw.match(/\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return JSON.parse(`"${m[1]}"`).slice(0, 200); } catch { return m[1].slice(0, 200); } }
  return null;
}

export function parseRollout(text) {
  const r = freshRollout();
  feedRollout(r, text);
  return r;
}

// The parse state of a rollout, fed its lines in order: kept per file, so a
// rollout that grew is read from where the last read stopped.
function freshRollout() {
  return {
    usage: null, model: null, usageAt: null, contextWindow: null,
    lastText: null, lastTextAt: null,
    lastPromptAt: null, lastPrompt: null,
    lastTurnEndAt: null, lastActivityAt: null,
    lastTool: null, lastToolAt: null,
    lastInterruptAt: null,
    recap: null, recapAt: null, title: null, cwd: null,
    turns: [],
    pendingText: null,
  };
}

function feedRollout(r, text) {
  let { pendingText } = r;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec.payload || {};
    const at = rec.timestamp || null;
    if (rec.type === 'session_meta' && p.cwd) r.cwd = p.cwd;
    if (rec.type === 'turn_context') { if (p.cwd) r.cwd = p.cwd; if (p.model) r.model = p.model; }
    if (rec.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') {
        const t = textOf(p.content, 'output_text').trim();
        if (t && !t.startsWith(DEFERRED)) { r.lastText = t; r.lastTextAt = at; pendingText = t; }
        if (at) r.lastActivityAt = at;
      } else if (p.type === 'message' && p.role === 'user') {
        const t = textOf(p.content, 'input_text').trim();
        if (isUserText(t)) { r.lastPromptAt = at; r.lastPrompt = t; if (at) r.lastActivityAt = at; }
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
        r.lastTool = { name: p.name || p.type, what: toolWhat(p) };
        r.lastToolAt = at;
        if (at) r.lastActivityAt = at;
      } else if (/_output$/.test(p.type || '')) {
        if (at) r.lastActivityAt = at;
      }
    }
    if (rec.type === 'event_msg') {
      // A turn that said nothing new (a "! command") has no text of its own.
      if (p.type === 'task_complete') { r.lastTurnEndAt = at; r.turns.push({ at, text: pendingText }); pendingText = null; }
      if (p.type === 'turn_aborted') { r.lastTurnEndAt = at; r.lastInterruptAt = at; }
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        r.usage = p.info.last_token_usage;
        r.usageAt = at;
        if (p.info.model_context_window) r.contextWindow = p.info.model_context_window;
      }
    }
  }
  r.pendingText = pendingText;
  if (r.turns.length > 60) r.turns = r.turns.slice(-60);
}

// Context in use: the last request's tokens, input (cached included) and
// output, which the next request carries again.
export function tokensOf(u) {
  if (!u) return null;
  if (u.total_tokens != null) return u.total_tokens;
  return (u.input_tokens || 0) + (u.output_tokens || 0);
}

const cache = new Map();

// Summary of one rollout, as server/transcript.mjs readTranscript gives
// Claude Code's; null if unreadable. contextWindow is the model's own.
export function readRollout(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = null;
  let state = null;
  let offset = 0;
  try {
    if (hit && hit.state && st.size >= hit.offset && st.size - hit.offset <= TAIL) {
      // Grown: only the bytes added since, whole lines (a cursor per file).
      state = hit.state;
      offset = hit.offset;
      if (st.size > offset) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          const last = buf.lastIndexOf(0x0a);
          if (last >= 0) { feedRollout(state, buf.toString('utf8', 0, last)); offset += last + 1; }
        } finally { fs.closeSync(fd); }
      }
    } else {
      const t = readTail(file, TAIL);
      state = parseRollout(t.text);
      offset = t.end;
      if ((!state.usage || !state.model) && !t.whole) {
        const more = parseRollout(readTail(file, 6 * 1024 * 1024).text);
        if (!state.usage) Object.assign(state, { usage: more.usage, usageAt: more.usageAt, contextWindow: more.contextWindow });
        if (!state.model) state.model = more.model;
        if (!state.cwd) state.cwd = more.cwd;
      }
    }
    const { pendingText, ...v } = state;
    value = v;
    value.contextTokens = tokensOf(value.usage);
    value.inTurn = !!(value.lastActivityAt && (!value.lastTurnEndAt || value.lastActivityAt > value.lastTurnEndAt));
    value.turns = value.turns.filter((t) => t.text).slice(-12).reverse();
    value.path = file;
    value.mtimeMs = st.mtimeMs;
  } catch {
    value = null;
    state = null;
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value, state, offset });
  return value;
}

const TAIL = 768 * 1024;

// The hand-off hook's reading: { tokens, window, model, lastText,
// lastPromptAt, lastPrompt } from the end of the rollout, or null when it
// cannot be read. lastPromptAt is the newest prompt the user typed (a Stop
// hook's reason comes back wrapped in <hook_prompt>, so it is not one): the
// hook's deferral waits for it.
//
// `io` (server/handoff.mjs localIo, or the hub's view of a remote machine)
// reads a rollout that is on another machine.
export function lastUsage(file, io = null) {
  const v = io && io.remote ? remoteRollout(file, io) : readRollout(file);
  if (!v) return null;
  return { tokens: v.contextTokens, window: v.contextWindow, model: v.model, lastText: v.lastText, lastPromptAt: v.lastPromptAt, lastPrompt: v.lastPrompt };
}

function remoteRollout(file, io) {
  const t = io.tail(file, 6 * 1024 * 1024);
  if (!t) return null;
  let text = t.buf.toString('utf8');
  if (t.start > 0) text = text.slice(text.indexOf('\n') + 1);
  try {
    const value = parseRollout(text);
    value.contextTokens = tokensOf(value.usage);
    return value;
  } catch { return null; }
}

// Finds the rollout of a session id: rollout-*-<id>.jsonl under
// sessions/YYYY/MM/DD, newest days first.
// The rollouts whose session started in a folder (its session_meta's cwd),
// among the newest `max` (by day folder): Codex keeps them by date, not by
// folder. Each one's first line only is read.
export function rolloutsFor(cwd, { home = codexHome(), max = 400 } = {}) {
  if (!cwd) return [];
  const root = path.join(home, 'sessions');
  const list = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  const out = [];
  let seen = 0;
  for (const y of list(root)) for (const m of list(path.join(root, y))) for (const d of list(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    for (const f of list(dir)) {
      if (!f.endsWith('.jsonl') || ++seen > max) continue;
      const file = path.join(dir, f);
      let first = '';
      try { const fd = fs.openSync(file, 'r'); try { const buf = Buffer.alloc(16384); const n = fs.readSync(fd, buf, 0, buf.length, 0); first = buf.toString('utf8', 0, n).split('\n')[0]; } finally { fs.closeSync(fd); } } catch { continue; }
      // The first line (session_meta) runs past 20 KB with its instructions:
      // its cwd comes early, read from the start of it.
      if (!/"type":"session_meta"/.test(first)) continue;
      let at = null;
      try { const m = first.match(/"cwd":("(?:[^"\\]|\\.)*")/); at = m ? JSON.parse(m[1]) : null; } catch { /* not a string */ }
      const id = (f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) || [])[1];
      if (id && at && path.resolve(at) === path.resolve(cwd)) out.push({ path: file, sessionId: id.toLowerCase() });
    }
  }
  return out;
}

export function findRollout(sessionId, home = codexHome()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId || ''))) return null;
  const root = path.join(home, 'sessions');
  const list = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of list(root)) for (const m of list(path.join(root, y))) for (const d of list(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    const f = list(dir).find((x) => x.endsWith(`-${sessionId}.jsonl`));
    if (f) return path.join(dir, f);
  }
  return null;
}

// The first prompt typed into a session, from the head of its rollout.
export function firstPrompt(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const p = rec.payload || {};
      if (rec.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') continue;
      const t = textOf(p.content, 'input_text').trim();
      if (isUserText(t)) return t;
    }
    return null;
  } catch { return null; } finally { fs.closeSync(fd); }
}
