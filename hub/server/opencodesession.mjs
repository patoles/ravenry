// OpenCode's session file as the board reads it: what Ravenry's plugin
// (hooks/opencode-plugin.js) writes per session, in the shape
// server/transcript.mjs gives a Claude Code transcript. Node built-ins
// only: the hand-off hook loads it at every stop (server/handoffstop.mjs).

import fs from 'node:fs';

export function fromFile(j) {
  const num = (x) => (Number.isFinite(x) && x >= 0 ? x : null);
  const tokens = num(j.contextTokens);
  return {
    usage: tokens != null ? { total_tokens: tokens } : null,
    model: typeof j.model === 'string' ? j.model : null,
    modelName: typeof j.modelName === 'string' ? j.modelName : null,
    contextTokens: tokens,
    contextWindow: num(j.contextWindow),
    usageAt: j.updatedAt || null,
    lastText: j.lastText || null, lastTextAt: j.lastTextAt || null,
    lastPrompt: j.lastPrompt || null, lastPromptAt: j.lastPromptAt || null,
    lastPersonPromptAt: j.lastPersonPromptAt || null,
    lastTurnEndAt: j.lastTurnEndAt || null, lastActivityAt: j.lastActivityAt || null,
    lastTool: j.lastTool || null, lastToolAt: j.lastToolAt || null,
    lastInterruptAt: null, recap: null, recapAt: null,
    title: j.title || null, cwd: j.cwd || null,
    firstPrompt: j.firstPrompt || null,
    inTurn: !!j.inTurn,
    turns: (Array.isArray(j.turns) ? j.turns : []).filter((t) => t && t.text).slice(-12).reverse(),
  };
}

/** The hand-off's reading (server/handoffstop.mjs): { tokens, window, model, lastText, lastPromptAt, lastPrompt }. */
export function lastUsage(file, io = null) {
  let j = null;
  try { j = io && io.remote ? JSON.parse(io.text(file) || 'null') : JSON.parse(fs.readFileSync(file, 'utf8')); } catch { j = null; }
  if (!j) return null;
  const v = fromFile(j);
  return { tokens: v.contextTokens, window: v.contextWindow, model: v.model, lastText: v.lastText, lastPromptAt: v.lastPersonPromptAt, lastPrompt: v.lastPrompt };
}
