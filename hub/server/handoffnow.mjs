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
//
// A request that waits is never silent, and never waits for a stop that
// does not come (2026-11-24: Hand off now on a session at rest, 11 s after
// its stop, waited "(it is working)": its last stop listed a dev server
// left running in the background, which the board counts as work and the
// hook as a task; no stop came until the person typed in its chat):
//   - a shell or a monitor left running holds back neither the board here
//     (restOf) nor the hook (server/handoffstop.mjs): the person sees no
//     task there and it may never end. Agents and the like still do.
//   - why it waits is recorded (`wait` on the marker) and the board words
//     it on the card, the phone and the toast: "Waits until Claude finishes
//     its turn", "Waits until you answer the choice open in it"...
//   - the hub's tick gives a waiting request (waiting) the same path as the
//     press as soon as its session is at rest (`by: 'tick'`), so a turn that
//     ends, a dialog answered or agents done deliver it without a message.

import * as h from './handoff.mjs';
import { nameOf, shortOf } from './assistants.mjs';
import { LEFT_RUNNING } from './tasks.mjs';

// Why a request by hand waits, by code (the marker's `wait.code`); the
// board words each code (shared/strings session.handOffWaits.<code>).
export const WAITS = {
  working: 'it is working',
  dialog: 'a dialog is open in it',
  agents: 'background agents are running in it',
  draft: 'there is text in its prompt',
  unsure: 'its prompt holds text no styled read can tell apart from typed text',
  screen: 'its screen could not be read',
  away: 'its screen does not show the assistant at its prompt',
  gone: 'it is not running',
  pane: 'the board cannot type into it from this Mac',
  file: 'there is no file for its hand-off',
  typing: 'the request could not be typed',
};

// Whether the board's own state of a session lets it be asked now, before
// any fresh read: { atRest, busy } with busy a WAITS code. `last` is its
// newest hook event (server/events.mjs summarize). The board calls a
// session working while its last stop lists background tasks; when those
// are only shells or monitors left running (`background_kinds`, or no
// kinds recorded), it counts as at rest here and the fresh read decides
// (an agent still running shows in its footer).
export function restOf({ live, working, dialog, last = null }) {
  if (!live) return { atRest: false, busy: 'gone' };
  if (dialog) return { atRest: false, busy: 'dialog' };
  if (!working) return { atRest: true, busy: null };
  if (last && last.event === 'Stop' && last.background_tasks > 0) {
    const kinds = Array.isArray(last.background_kinds) ? last.background_kinds : null;
    if (kinds && kinds.some((k) => !LEFT_RUNNING.has(String(k).toLowerCase()))) return { atRest: false, busy: 'agents' };
    return { atRest: true, busy: null };
  }
  return { atRest: false, busy: 'working' };
}

// A request by hand still waiting on the board: queued, or asked and put
// off (its DEFERRED answer) with the hook's hold over. The hook would act
// at the next stop, which a session at rest never has.
export function waiting(m, nowMs = Date.now()) {
  if (!m || !m.manualAt) return false;
  if (m.state === 'queued') return true;
  if (m.state !== 'requested') return false;
  const ask = Date.parse(m.lastAskAt || '');
  const def = Date.parse(m.deferredAt || '');
  return !isNaN(def) && (isNaN(ask) || def >= ask) && !h.deferralHold(m, { nowMs });
}

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
// be typed into now. `suggestion(screen)`: true only when a read of the
// same prompt is sure its text is the assistant's suggestion; 'unsure'
// when nothing could tell (a terminal with no styled read, and no probe).
// { ok } or { ok: false, why, wait } (wait: a WAITS code).
export async function promptFree(screen, suggestion = async () => false) {
  const no = (wait) => ({ ok: false, why: WAITS[wait], wait });
  if (!screen || !screen.readable) return no('screen');
  if (!screen.claudeLive) return no('away');
  if (screen.working) return no('working');
  if (screen.dialog) return no('dialog');
  if (screen.agentsRunning > 0) return no('agents');
  if (screen.draft) {
    const v = await suggestion(screen);
    if (v !== true) return no(v === 'unsure' ? 'unsure' : 'draft');
  }
  return { ok: true };
}

// Hand off now on one session. `session`: { sessionId, workspaceId,
// surfaceId, atRest (restOf: live, no dialog, not working but for shells
// left running), busy (restOf's code when not at rest), local (on this
// Mac), pane (a tab the board can type into), kind ('claude' | 'codex' |
// ...) }. `target`: where its hand-off goes (handoff.resolveHandoffFile).
// `ctx`: { pct, tokens, window } of its context. `pane`: { read() ->
// parsed screen, suggestion(screen, { probe }) -> bool, type(text) ->
// { ok, error } }. `by`: 'press' (the person, now) or 'tick' (the board
// again, for a request that waits: the press's time and the marker stay as
// they are, and a wait already recorded is not written again).
// Returns { state, delivered: 'written' | 'now' | 'next stop', why, wait }.
export async function request({ session: s, prev = null, target = null, transcriptPath = null, cwd = null, ctx = {}, settings = {}, decisions = '', pane = null, io = h.localIo, log = () => {}, by = 'press' }) {
  const sid = s.sessionId;
  const now = new Date().toISOString();
  const press = by !== 'tick';
  const base = press ? {
    manualAt: now, queuedAt: (prev && prev.queuedAt) || now,
    workspaceId: (prev && prev.workspaceId) || s.workspaceId || null, surfaceId: (prev && prev.surfaceId) || s.surfaceId || null,
  } : {};
  const file = target && target.file;
  const where = { ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(s.kind && s.kind !== 'claude' ? { assistant: s.kind } : {}) };

  // 1. Written already, in the turn after the person's last prompt.
  if (s.atRest && s.local && file) {
    const w = writtenAtRest({ file, transcriptPath, cwd, io });
    if (w) {
      h.writeMarker(sid, { ...base, ...where, ...h.targetFields(target, io), state: 'written', writtenAt: now, writtenSeenBy: 'board', writtenSince: w.promptAt, wait: null });
      log(`hand-off: ${sid} at rest had written its hand-off since its last prompt (${w.promptAt}); counted as written`);
      return { state: 'written', delivered: 'written' };
    }
  }

  const prevState = prev && prev.state === 'requested' ? 'requested' : 'queued';
  if (press) h.writeMarker(sid, { ...base, state: prevState });
  // Why it waits, for the board's words: written at a press, and by the
  // tick only when it changed (it tries again every few seconds).
  const later = (wait, why = WAITS[wait]) => {
    const had = press ? null : h.readMarker(sid);
    if (press || !had || !had.wait || had.wait.code !== wait) h.writeMarker(sid, { wait: { code: wait, why, at: now } });
    return { state: prevState, delivered: 'next stop', why, wait };
  };
  if (!s.atRest) return later(WAITS[s.busy] ? s.busy : 'working');
  if (!s.local || !s.pane || !pane) return later('pane');
  if (!file) return later('file');

  // 2. Asked now, as the hook would at a stop.
  let screen = null;
  try { screen = await pane.read(); } catch { /* below */ }
  const free = await promptFree(screen, pane.suggestion ? (sc) => pane.suggestion(sc, { probe: press }) : async () => false);
  if (!free.ok) return later(free.wait, free.why);
  // The tick's try: the hook may have asked at a stop since (it records the
  // ask before its answer lets the turn go on), so the marker is read again
  // right before typing, never asked twice.
  if (!press && !waiting(h.readMarker(sid))) return { state: (h.readMarker(sid) || {}).state || prevState, delivered: 'next stop', why: 'asked meanwhile' };
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
    lastCheck: { at: now, clean: true, why: press ? 'at rest at its prompt: asked from Ravenry' : 'at rest at its prompt again: asked from Ravenry' },
    wait: null,
  });
  let typed;
  try { typed = await pane.type(reason); } catch (e) { typed = { ok: false, error: String(e.message || e) }; }
  if (!typed || !typed.ok) {
    const why = `${WAITS.typing} (${(typed && (typed.error || typed.err)) || 'no answer'})`;
    h.writeMarker(sid, {
      state: prevState, asks: (prev && prev.asks) || 0, lastAskAt: (prev && prev.lastAskAt) || null,
      requestedAt: (prev && prev.requestedAt) || null, askedBy: (prev && prev.askedBy) || null, lastCheck: (prev && prev.lastCheck) || null,
    });
    return later('typing', why);
  }
  log(`hand-off: ${sid} at rest was asked to hand off now, in its pane${press ? '' : ' (it had waited)'}`);
  return { state: 'requested', delivered: 'now' };
}
