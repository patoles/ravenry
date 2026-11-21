// Antigravity CLI's transcript as the board reads it, in the shape
// server/transcript.mjs gives a Claude Code transcript. Node built-ins
// only: the hand-off hook loads it at every stop (server/handoffstop.mjs).
//
// Measured on agy 1.5.14: every hook names `transcriptPath`,
// <~/.gemini/antigravity-cli>/brain/<conversation id>/.system_generated/
// logs/transcript_full.jsonl, one JSON object per step:
//
//   USER_INPUT        source USER_EXPLICIT, the person's message inside
//                     <USER_REQUEST>...</USER_REQUEST> (and the CLI's own
//                     metadata after it)
//   PLANNER_RESPONSE  source MODEL: model, input_tokens, cache_read_tokens,
//                     output_tokens, content (its words), tool_calls
//   SYSTEM_MESSAGE    the CLI's own notes; a Stop hook's reason is
//                     "Stop hook blocked termination: <reason>"
//   GENERIC           a tool's run, its status and error
//
// It records no context window, so the board uses the one from Settings.
// A turn interrupted with Esc leaves no step.

import fs from 'node:fs';

const TAIL = 2 * 1024 * 1024;
export const STOP_MARK = 'Stop hook blocked termination:';

function readTail(file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, st.size - TAIL);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally { fs.closeSync(fd); }
}

// The person's words of a USER_INPUT step.
export function requestText(content) {
  const s = String(content || '');
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(s);
  return (m ? m[1] : s).trim();
}

const oneLine = (s, n = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

/** The transcript's text (whole lines) in the board's shape. */
export function fromText(text) {
  const out = {
    usage: null, model: null, modelName: null, contextTokens: null, contextWindow: null, usageAt: null,
    lastText: null, lastTextAt: null, lastPrompt: null, lastPromptAt: null, lastPersonPromptAt: null,
    lastTurnEndAt: null, lastActivityAt: null, lastTool: null, lastToolAt: null,
    lastInterruptAt: null, recap: null, recapAt: null, title: null, cwd: null,
    firstPrompt: null, inTurn: false, turns: [],
    // A Stop hook's reason carried on since the person's last message: the
    // next Stop is the one that answers it (Claude Code's stop_hook_active).
    stopHookActive: false, hookReason: null,
  };
  let turnText = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const at = typeof j.created_at === 'string' ? j.created_at : null;
    if (at) out.lastActivityAt = at;
    if (j.type === 'USER_INPUT') {
      const t = requestText(j.content);
      if (!t) continue;
      if (turnText) { out.turns.push({ at: out.lastTextAt, text: turnText }); out.lastTurnEndAt = out.lastTextAt; }
      turnText = null;
      out.lastPrompt = t; out.lastPromptAt = at; out.lastPersonPromptAt = at;
      if (!out.firstPrompt) out.firstPrompt = t;
      out.stopHookActive = false; out.hookReason = null;
    } else if (j.type === 'SYSTEM_MESSAGE' && typeof j.content === 'string' && j.content.includes(STOP_MARK)) {
      const r = j.content.slice(j.content.indexOf(STOP_MARK) + STOP_MARK.length).replace(/<\/SYSTEM_MESSAGE>[\s\S]*$/, '').trim();
      if (turnText) { out.turns.push({ at: out.lastTextAt, text: turnText }); out.lastTurnEndAt = out.lastTextAt; }
      turnText = null;
      out.stopHookActive = true; out.hookReason = r || null;
    } else if (j.type === 'PLANNER_RESPONSE') {
      if (typeof j.model === 'string' && j.model) out.model = j.model;
      const n = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
      const tokens = n(j.input_tokens) + n(j.cache_read_tokens) + n(j.output_tokens);
      if (tokens > 0) { out.contextTokens = tokens; out.usage = { total_tokens: tokens }; out.usageAt = at; }
      const words = typeof j.content === 'string' ? j.content.trim() : '';
      if (words) { out.lastText = words; out.lastTextAt = at; turnText = words; }
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      if (calls.length) {
        const c = calls[calls.length - 1] || {};
        const a = c.args || {};
        const what = a.CommandLine || a.Path || a.AbsolutePath || a.Query || a.Url || '';
        out.lastTool = { name: String(c.name || 'tool'), what: oneLine(typeof what === 'string' ? what.replace(/^"|"$/g, '') : JSON.stringify(what), 200) || null };
        out.lastToolAt = at;
      } else if (words) {
        // A reply with no tool call ends the model's loop.
        out.lastTurnEndAt = at;
      }
    }
  }
  if (turnText) out.turns.push({ at: out.lastTextAt, text: turnText });
  out.inTurn = !!(out.lastActivityAt && (!out.lastTurnEndAt || out.lastActivityAt > out.lastTurnEndAt));
  out.turns = out.turns.filter((t) => t.text).slice(-12).reverse();
  return out;
}

const cache = new Map();
/** A transcript file read in the board's shape (its last 2 MB), or null. */
export function readFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = null;
  try {
    value = fromText(readTail(file));
    value.path = file;
    value.mtimeMs = st.mtimeMs;
  } catch { value = null; }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * The hand-off's reading (server/handoffstop.mjs): { tokens, window,
 * model, lastText, lastPromptAt, lastPrompt, stopHookActive }. `io` reads a
 * remote machine's file (its tail).
 */
export function lastUsage(file, io = null) {
  let v = null;
  try {
    if (io && io.remote) {
      const t = io.tail(file, TAIL);
      if (!t) return null;
      let text = t.buf.toString('utf8');
      if (t.start > 0) text = text.slice(text.indexOf('\n') + 1);
      v = fromText(text);
    } else v = readFile(file);
  } catch { v = null; }
  if (!v) return null;
  return { tokens: v.contextTokens, window: v.contextWindow, model: v.model, lastText: v.lastText, lastPromptAt: v.lastPromptAt, lastPrompt: v.lastPrompt, stopHookActive: v.stopHookActive };
}
