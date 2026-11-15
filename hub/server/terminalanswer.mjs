// A card closes by itself when the person answers the agent in its
// terminal instead (2026-11-15: a question card stayed on the board and the
// phone after the person wrote "Ok you can do those fixes" to the session
// that asked, until they clicked an answer they had already given).
//
// An open ask, approve or pick from a session is withdrawn once that
// session's transcript has a message the person sent after the card went
// out: a prompt (Claude Code, Codex) or a message they typed while the
// agent worked (Claude Code queues it). The hub cancels it at the daemon
// with answered_in `terminal` (checkpoints.withdrawAnswered): it leaves the
// board, the Mac app and the phone, its phone alert is taken back
// (push.syncCheckpoints), and an agent still waiting on it exits 123, told
// to read the person's message. Its record says "Answered in the terminal"
// (cpwords.mjs afterOf); nothing the person typed is copied anywhere.
//
// The session is the one the card's pane runs (RAVENRY_PANE), as the
// card's "which session asks" line finds it; a card with no known session
// is left alone. A secret is never withdrawn this way (the person cannot
// give one in the chat), nor a drive (another pane's), nor a page's run
// button (the person pressed it, no agent asked). Rules only: no model
// call, nothing leaves the Mac (HUB-013).

export const KINDS = new Set(['ask', 'approve', 'pick']);

/** When the person last wrote to the session (ms), from its transcript's summary, or null. */
export function personAt(t) {
  if (!t) return null;
  const at = [t.lastPromptAt, t.lastQueuedAt].map((x) => (x ? Date.parse(x) : NaN)).filter(Number.isFinite);
  return at.length ? Math.max(...at) : null;
}

/**
 * The open cards the person answered in the terminal: [{ cp, session }].
 * `sessionOf(cp)` is the session that asked, { at } with `at` when the
 * person last wrote to it (personAt of its transcript), or null.
 */
export function answeredInTerminal(open, sessionOf) {
  const out = [];
  for (const cp of open || []) {
    if (!cp || cp.state !== 'open' || !KINDS.has(cp.kind) || !cp.pane) continue;
    const created = Date.parse(cp.created_at);
    if (!Number.isFinite(created)) continue;
    const s = sessionOf(cp);
    if (!s) continue;
    if (s.at != null && s.at > created) out.push({ cp, session: s });
  }
  return out;
}
