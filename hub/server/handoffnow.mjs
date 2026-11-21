// "Hand off now" (docs/HANDOFF.md, Hand off now): the request marker, and
// what the board does at once when the session sits at rest at its prompt.
//
// The Stop hook (server/handoffstop.mjs) acts on a request at the session's
// next stop. A session at rest has no next stop until it gets a message, so
// a request on one stayed queued for good (2026-11-20: the person asked a
// session in its chat to hand off, it wrote the hand-off and finished, then
// Hand off now pressed in the Mac app sat queued under a written hand-off).
// So, on a session at rest:
//   1. its hand-off is already written: a new dated bullet in the Hand-off
//      section that this session's own transcript wrote since the person's
//      last prompt. The request counts it as written, and the fresh session
//      starts as for any written hand-off.
//   2. it is not: the board gives the session the hook's own request now,
//      typed at its prompt, the same words a Stop would get, and records the
//      ask as the hook does (state requested, the section's base), so the
//      stop that ends that turn finds the hand-off as for any ask. Only into
//      a Ravenry pane on this Mac whose fresh read shows the assistant at its
//      prompt: never while it works, has a dialog open or background agents
//      running, or has typed text in its input box (Claude Code's dim
//      suggested reply is not typed text, a paste replaces it, and only a
//      styled read may say so: nothing is typed to find out). Anything else
//      waits for the next stop, as before.
// Everything it touches comes in `pane` and `io`, so a test drives it with
// stand-ins (tools/handoff-now-test.mjs) and the hub with its terminals.

import * as h from './handoff.mjs';
import { nameOf, shortOf } from './assistants.mjs';

// Case 1: the hand-off this session wrote since the person's last prompt
// (the transcript's newest prompt the person typed; the hook's own reason,
// tagged, is not one). { promptAt } or null.
export function writtenAtRest({ file, transcriptPath, cwd = null, io = h.localIo }) {
  if (!file || !transcriptPath) return null;
  const promptAt = h.lastPromptAt(transcriptPath, null, io);
  if (!promptAt) return null;
  return h.writtenSince(file, transcriptPath, promptAt, cwd, io) ? { promptAt } : null;
}

// Whether a parsed screen (server/screen.mjs parseScreen, or Codex's) may
// be typed into now. `suggestion(screen)`: true only when a styled read of
// the same prompt is sure its text is the assistant's suggestion.
// { ok } or { ok: false, why }.
export async function promptFree(screen, suggestion = async () => false) {
  if (!screen || !screen.readable) return { ok: false, why: 'its screen could not be read' };
  if (!screen.claudeLive) return { ok: false, why: 'its screen does not show the assistant at its prompt' };
  if (screen.working) return { ok: false, why: 'it is working' };
  if (screen.dialog) return { ok: false, why: 'a dialog is open in it' };
  if (screen.agentsRunning > 0) return { ok: false, why: 'background agents are running in it' };
  if (screen.draft && !(await suggestion(screen))) return { ok: false, why: 'there is text in its prompt' };
  return { ok: true };
}

// Hand off now on one session. `session`: { sessionId, workspaceId,
// surfaceId, atRest (not working, no dialog, live), local (on this Mac),
// pane (a Ravenry pane the board can type into), kind ('claude' | 'codex') }.
// `target`: where its hand-off goes (handoff.resolveHandoffFile). `ctx`:
// { pct, tokens, window } of its context. `pane`: { read() -> parsed
// screen, suggestion(screen) -> bool, type(text) -> { ok, error } }.
// Returns { state, delivered: 'written' | 'now' | 'next stop', why }.
export async function request({ session: s, prev = null, target = null, transcriptPath = null, cwd = null, ctx = {}, settings = {}, decisions = '', pane = null, io = h.localIo, log = () => {} }) {
  const sid = s.sessionId;
  const now = new Date().toISOString();
  const base = {
    manualAt: now, queuedAt: (prev && prev.queuedAt) || now,
    workspaceId: (prev && prev.workspaceId) || s.workspaceId || null, surfaceId: (prev && prev.surfaceId) || s.surfaceId || null,
  };
  const file = target && target.file;
  const where = { ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(s.kind && s.kind !== 'claude' ? { assistant: s.kind } : {}) };

  // 1. Written already, in the turn after the person's last prompt.
  if (s.atRest && s.local && file) {
    const w = writtenAtRest({ file, transcriptPath, cwd, io });
    if (w) {
      h.writeMarker(sid, { ...base, ...where, ...h.targetFields(target, io), state: 'written', writtenAt: now, writtenSeenBy: 'board', writtenSince: w.promptAt });
      log(`hand-off: ${sid} at rest had written its hand-off since its last prompt (${w.promptAt}); counted as written`);
      return { state: 'written', delivered: 'written' };
    }
  }

  const prevState = prev && prev.state === 'requested' ? 'requested' : 'queued';
  h.writeMarker(sid, { ...base, state: prevState });
  const later = (why) => ({ state: prevState, delivered: 'next stop', why });
  if (!s.atRest) return later('it is working');
  if (!s.local || !s.pane || !pane) return later('the board types only into a Ravenry pane on this Mac');
  if (!file) return later('there is no file for its hand-off');

  // 2. Asked now, as the hook would at a stop.
  let screen = null;
  try { screen = await pane.read(); } catch { /* below */ }
  const free = await promptFree(screen, pane.suggestion || (async () => false));
  if (!free.ok) return later(free.why);
  const threshold = Number(settings.handoffThreshold) || 50;
  const ceiling = Number(settings.handoffCeiling) || 70;
  const pct = ctx.pct ?? null;
  const reason = h.reasonText({
    pct, tokens: ctx.tokens ?? null, window: ctx.window || Number(settings.contextWindow) || 1000000, threshold, ceiling, manual: true,
    file, autoStart: settings.handoffAutoStart !== false, decisions,
    ...(s.kind && s.kind !== 'claude' && nameOf(s.kind) ? { name: nameOf(s.kind), short: shortOf(s.kind) } : {}),
  });
  // Recorded before the words go in: the turn they start can end before
  // the typing call returns.
  h.writeMarker(sid, {
    ...where, ...h.targetFields(target, io), pct, tokens: ctx.tokens ?? null, threshold, ceiling,
    state: 'requested', requestedAt: (prev && prev.requestedAt) || now,
    asks: ((prev && prev.asks) || 0) + 1, lastAskAt: now, over: pct != null && pct >= ceiling, askedBy: 'board',
    lastCheck: { at: now, clean: true, why: 'at rest at its prompt: asked from Ravenry' },
  });
  let typed;
  try { typed = await pane.type(reason); } catch (e) { typed = { ok: false, error: String(e.message || e) }; }
  if (!typed || !typed.ok) {
    const why = `the request could not be typed (${(typed && (typed.error || typed.err)) || 'no answer'})`;
    h.writeMarker(sid, {
      state: prevState, asks: (prev && prev.asks) || 0, lastAskAt: (prev && prev.lastAskAt) || null,
      requestedAt: (prev && prev.requestedAt) || null, askedBy: null, lastCheck: (prev && prev.lastCheck) || null,
    });
    return later(why);
  }
  log(`hand-off: ${sid} at rest was asked to hand off now, in its pane`);
  return { state: 'requested', delivered: 'now' };
}
