// An answer the person gives on a card always reaches the agent that asked
// (2026-11-15: the person answered "Publish now" on a card an agent had sent
// with `ravenry ask --no-wait`, and the agent never heard of it, since
// nothing was waiting on the answer).
//
// A card that closes with nobody waiting on it (the daemon's
// nobody_waiting: no `ask`, `pick`, `approve` or `checkpoint ID --wait`
// blocked on it) is typed into the session that asked, the one its pane
// runs, as the board's Reply types the person's words: one line an agent
// understands. A client that waits gets the answer as before and nothing
// is typed. A secret's value is never typed: only that it is ready.
//
// The line is Ravenry's, not the person writing to the session, so it
// never withdraws the session's other open cards
// (server/terminalanswer.mjs): the transcripts' readers leave out a prompt
// that is one of these lines (isCardLine). Rules only, no model call
// (HUB-013).

import { cutAtWord } from './handoffline.mjs';

export const KINDS = new Set(['ask', 'pick', 'approve', 'secret']);
const TITLE_MAX = 80;
const ANSWER = 'Answer to your card "';
const SECRET = 'Your secret for "';

/** Whether this closed card is the hub's to deliver: the person answered or declined it and nobody waited on it. */
export function wants(cp) {
  return !!cp && cp.nobody_waiting === true && KINDS.has(cp.kind) && (cp.state === 'answered' || cp.state === 'declined') && typeof cp.pane === 'string' && cp.pane !== '';
}

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const titleOf = (cp) => cutAtWord(String(cp.title || '').replace(/\r/g, '').trim().split('\n')[0], TITLE_MAX);
const f4 = (x) => Number(x).toFixed(4);

/** The words typed into the asking session: one line, never a secret's value. */
export function lineFor(cp) {
  const a = cp.answer || {};
  const t = titleOf(cp);
  const declined = cp.state === 'declined' || a.declined;
  if (cp.kind === 'secret' && !declined) return `${SECRET}${t}" is ready: run ravenry checkpoint ${cp.id} --wait to read it.`;
  const head = `${ANSWER}${t}": `;
  if (declined) return `${head}declined${a.reason && one(a.reason) ? `. Their reason: ${one(a.reason)}` : ''}`;
  if (cp.kind === 'pick') {
    const pk = a.pick || {};
    const r = pk.region;
    return `${head}${one(pk.label)}${r ? ` (region ${f4(r.x)} ${f4(r.y)} ${f4(r.w)} ${f4(r.h)})` : ''}${pk.note && one(pk.note) ? `. Their note: ${one(pk.note)}` : ''}`;
  }
  if (cp.kind === 'approve') {
    const edited = !!a.command;
    const did = edited ? 'approved with their edit' : 'approved';
    const out = `(${edited ? 'what ran and ' : ''}its output: ravenry checkpoint ${cp.id} --wait)`;
    const exit = cp.run && cp.run.exit;
    if (!exit) return `${head}${did}, but the command did not run${cp.reason ? `: ${one(cp.reason)}` : ''}`;
    if (exit.signal) return `${head}${did}; the command was stopped by ${exit.signal} ${out}`;
    return `${head}${did}; the command exited ${exit.code} ${out}`;
  }
  const answer = a.option ?? a.text ?? (a.choice != null && Array.isArray(cp.options) ? cp.options[a.choice] : null);
  return `${head}${one(answer)}`;
}

/** Whether a prompt in a transcript is one of these lines (Ravenry's, not the person's). */
export function isCardLine(text) {
  const t = String(text || '').trimStart();
  return (t.startsWith(ANSWER) && t.includes('": ')) || (t.startsWith(SECRET) && /" is ready: run ravenry checkpoint c[a-z2-7]{7} --wait to read it\.$/.test(t.trimEnd()));
}

// How long a line the session cannot take yet (half-typed text in its
// prompt, a choice open on screen) is tried again, and how often.
export const RETRY_MS = 5 * 60000;
export const RETRY_EVERY_MS = 5000;
