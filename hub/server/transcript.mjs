// Reads the tail of a Claude Code transcript
// (~/.claude/projects/<cwd with / as ->/<sessionId>.jsonl) and pulls out
// what the board needs: context use, the last thing Claude said, the last
// recap, turn ends, and whether a turn is still in flight.
//
// Transcripts reach 100 MB, so only the tail is read, and results are cached
// by size and mtime.

import fs from 'node:fs';
import { breathe } from './slice.mjs';
import path from 'node:path';
import os from 'node:os';
import { hasTag, DEFERRED } from './handoff.mjs';
import { isCardLine } from './cardanswer.mjs';

// MC_CLAUDE_PROJECTS points a test server at fake transcripts.
export const PROJECTS_DIR = process.env.MC_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const cache = new Map();

export function slugForCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

// Finds <sessionId>.jsonl, first under the cwd's folder, then anywhere.
export function findTranscript(sessionId, cwd) {
  if (!sessionId) return null;
  if (cwd) {
    const p = path.join(PROJECTS_DIR, slugForCwd(cwd), sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no projects dir */ }
  return null;
}

// Every transcript of a folder (its sessions' conversations, newest first by
// file time; the caller orders them by their last turn).
export function transcriptsFor(cwd) {
  if (!cwd) return [];
  const dir = path.join(PROJECTS_DIR, slugForCwd(cwd));
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && /^[0-9a-f-]{36}\.jsonl$/i.test(f)).map((f) => ({ path: path.join(dir, f), sessionId: f.slice(0, -6) })); } catch { return []; }
}

// Newest transcript for a cwd: the fallback when a surface names no session.
export function newestTranscriptFor(cwd, exclude = new Set()) {
  if (!cwd) return null;
  const dir = path.join(PROJECTS_DIR, slugForCwd(cwd));
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (exclude.has(id)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: path.join(dir, f), sessionId: id, mtimeMs: st.mtimeMs };
    }
  } catch { return null; }
  return best;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    // Whole lines only: the cursor (readTranscript) goes on after the last.
    const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
    const last = buf.lastIndexOf(0x0a);
    const text = last >= from ? buf.toString('utf8', from, last) : '';
    return { text, whole: start === 0, end: last >= 0 ? start + last + 1 : start };
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

function isRealPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const c = rec.message && rec.message.content;
  // The hand-off hook's request is not the user talking.
  if (hasTag(textOf(c))) return false;
  if (typeof c === 'string') return !/^<(command|local-command|system-reminder|bash-|task-notification)/.test(c.trim());
  if (Array.isArray(c)) return c.some((x) => x.type === 'text' && x.text && !/^<(command|local-command|system-reminder|task-notification)/.test(x.text.trim())) && !c.some((x) => x.type === 'tool_result');
  return false;
}

// The parse state of a transcript, fed its lines in order (feed): what it
// read up to, kept per file, so a transcript that grew is read from where
// the last read stopped, not from its tail again.
function fresh() {
  return {
    usage: null, model: null, usageAt: null,
    lastText: null, lastTextAt: null,
    lastPromptAt: null, lastPrompt: null,
    // The last prompt the person wrote: one Ravenry typed with a card's
    // answer (server/cardanswer.mjs) is not theirs.
    lastPersonPromptAt: null,
    // A message the person typed while a turn ran (Claude Code queues it,
    // `queue-operation` enqueue): when, never what. A card's answer
    // Ravenry typed is not one.
    lastQueuedAt: null,
    lastTurnEndAt: null, lastActivityAt: null,
    lastTool: null, lastToolAt: null,
    lastInterruptAt: null,
    recap: null, recapAt: null, title: null, cwd: null,
    turns: [],
    pendingText: null,
    turnAsk: null, // the prompt the turn under way answers
  };
}

function parse(text) {
  const r = fresh();
  feed(r, text);
  return r;
}

function feed(r, text) {
  let { pendingText, turnAsk } = r;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    const at = rec.timestamp || null;
    if (rec.cwd) r.cwd = rec.cwd;
    if (rec.type === 'ai-title' && rec.aiTitle) r.title = rec.aiTitle;
    if (rec.type === 'custom-title' && rec.customTitle) r.title = rec.customTitle;
    if (rec.type === 'last-prompt' && rec.lastPrompt) r.lastPrompt = rec.lastPrompt;
    // The person typed while the agent worked: queued, read once the turn
    // can take it. A task's notification queues the same way, as a tag.
    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && at && typeof rec.content === 'string' && rec.content.trim() && !/^\s*</.test(rec.content) && !hasTag(rec.content) && !isCardLine(rec.content)) r.lastQueuedAt = at;
    if (rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) { r.recap = String(rec.content); r.recapAt = at; }
    if (rec.type === 'system' && rec.subtype === 'turn_duration') {
      r.lastTurnEndAt = at;
      r.turns.push({ at, text: pendingText, ask: turnAsk });
      turnAsk = null;
    }
    if (rec.type === 'assistant' && rec.message) {
      const m = rec.message;
      if (m.usage && m.model !== '<synthetic>') { r.usage = m.usage; r.model = m.model || r.model; r.usageAt = at; }
      const t = textOf(m.content).trim();
      // "Hand-off deferred" is the hook's bookkeeping, not news: keep the
      // message before it (often a question) as the last thing said.
      if (t && !t.startsWith(DEFERRED)) { r.lastText = t; r.lastTextAt = at; pendingText = t; }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'tool_use') {
            const d = c.input && (c.input.description || c.input.prompt && String(c.input.prompt).split('\n')[0] || c.input.command);
            r.lastTool = { name: c.name, what: d ? String(d).slice(0, 200) : null };
            r.lastToolAt = at;
          }
        }
      }
      if (at) r.lastActivityAt = at;
    }
    if (rec.type === 'user') {
      const c = rec.message && rec.message.content;
      const isToolResult = Array.isArray(c) && c.some((x) => x.type === 'tool_result');
      if (at && (isToolResult || isRealPrompt(rec))) r.lastActivityAt = at;
      // Esc mid-turn writes this and no Stop hook runs (docs/STATE-RULES.md).
      if (at && /^\[Request interrupted by user/.test(textOf(c).trim())) r.lastInterruptAt = at;
      if (isRealPrompt(rec)) {
        r.lastPromptAt = at;
        const t = textOf(rec.message.content).trim();
        if (t) { r.lastPrompt = t; turnAsk = t; }
        if (!isCardLine(t)) r.lastPersonPromptAt = at;
      }
    }
  }
  r.pendingText = pendingText;
  r.turnAsk = turnAsk;
  if (r.turns.length > 60) r.turns = r.turns.slice(-60);
}

// Summary of one transcript; null if unreadable. Read once from its tail,
// then only the lines added since (a cursor per file).
export function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = null;
  let state = null;
  let offset = 0;
  try {
    if (hit && hit.state && st.size >= hit.offset && st.size - hit.offset <= TAIL) {
      // Grown: only the bytes added since, whole lines.
      state = hit.state;
      offset = hit.offset;
      if (st.size > offset) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          const last = buf.lastIndexOf(0x0a);
          if (last >= 0) { feed(state, buf.toString('utf8', 0, last)); offset += last + 1; }
        } finally { fs.closeSync(fd); }
      }
    } else {
      // First read, rewritten, or grown by more than a tail: its tail.
      const t = readTail(file, TAIL);
      state = parse(t.text);
      // No usage in its tail: the last 6 MB are read after, in pieces (deeper).
      if (!state.usage && !t.whole) void deeper(file);
      offset = t.end;
    }
    value = summary(state);
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

// A transcript whose last 768 KB say nothing of the model's usage is read
// again from its last 6 MB, for the context size. Done at once it held the
// board's main thread 100 to 230 ms per session at start (2026-11-08, the
// start-up load test): now the tail is read asynchronously and fed in
// pieces of whole lines, the event loop given back every 15 ms, and the
// cache takes it when the file has not changed since (readTranscript goes
// on from there; the next tick shows the context size).
const deep = new Set();
async function deeper(file) {
  if (deep.has(file)) return;
  deep.add(file);
  try {
    const st = await fs.promises.stat(file);
    const fh = await fs.promises.open(file, 'r');
    let t;
    try {
      const start = Math.max(0, st.size - 6 * 1024 * 1024);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
      const last = buf.lastIndexOf(0x0a);
      t = { text: last >= from ? buf.toString('utf8', from, last) : '', end: last >= 0 ? start + last + 1 : start };
    } finally { await fh.close(); }
    const state = fresh();
    let at = Date.now();
    for (let i = 0; i < t.text.length;) {
      let j = t.text.indexOf('\n', i + 64 * 1024);
      if (j < 0) j = t.text.length;
      feed(state, t.text.slice(i, j));
      i = j + 1;
      await breathe();
    }
    const hit = cache.get(file);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) return; // changed meanwhile: read again as usual
    const value = summary(state);
    value.path = file;
    value.mtimeMs = st.mtimeMs;
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value, state, offset: t.end });
  } catch { /* the tail's reading stands */ } finally { deep.delete(file); }
}

function summary(state) {
  const { pendingText, turnAsk, ...value } = state;
  const u = value.usage;
  value.contextTokens = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
  // A turn is in flight when activity came after the last turn end.
  value.inTurn = !!(value.lastActivityAt && (!value.lastTurnEndAt || value.lastActivityAt > value.lastTurnEndAt));
  value.turns = value.turns.filter((t) => t.text).slice(-12).reverse();
  return value;
}
