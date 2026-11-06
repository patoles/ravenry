// Reads the tail of a Claude Code transcript
// (~/.claude/projects/<cwd with / as ->/<sessionId>.jsonl) and pulls out
// what the board needs: context use, the last thing Claude said, the last
// recap, turn ends, and whether a turn is still in flight.
//
// Transcripts reach 100 MB, so only the tail is read, and results are cached
// by size and mtime.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hasTag, DEFERRED } from './handoff.mjs';

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
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, whole: start === 0 };
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

function parse(text) {
  const r = {
    usage: null, model: null, usageAt: null,
    lastText: null, lastTextAt: null,
    lastPromptAt: null, lastPrompt: null,
    lastTurnEndAt: null, lastActivityAt: null,
    lastTool: null, lastToolAt: null,
    lastInterruptAt: null,
    recap: null, recapAt: null, title: null, cwd: null,
    turns: [],
  };
  let pendingText = null;
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
    if (rec.type === 'system' && rec.subtype === 'away_summary' && rec.content) { r.recap = String(rec.content); r.recapAt = at; }
    if (rec.type === 'system' && rec.subtype === 'turn_duration') {
      r.lastTurnEndAt = at;
      r.turns.push({ at, text: pendingText });
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
        if (t) r.lastPrompt = t;
      }
    }
  }
  return r;
}

// Summary of one transcript; null if unreadable.
export function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = file;
  const hit = cache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = null;
  try {
    let { text, whole } = readTail(file, 768 * 1024);
    value = parse(text);
    if (!value.usage && !whole) value = parse(readTail(file, 6 * 1024 * 1024).text);
    const u = value.usage;
    value.contextTokens = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
    // A turn is in flight when activity came after the last turn end.
    value.inTurn = !!(value.lastActivityAt && (!value.lastTurnEndAt || value.lastActivityAt > value.lastTurnEndAt));
    value.turns = value.turns.filter((t) => t.text).slice(-6).reverse();
    value.path = file;
    value.mtimeMs = st.mtimeMs;
  } catch {
    value = null;
  }
  cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}
