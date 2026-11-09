// What a checkpoint says, in words every client shows as they come
// (PROTOCOL.md section 4): the mark on a session's sidebar row. Pure
// functions, so they are tested without a hub (hub/tools/sidebar-test.mjs).

/** "Claude", "Codex", else the kind with a capital, else null. */
export function assistantName(kind) {
  if (!kind) return null;
  if (kind === 'claude') return 'Claude';
  if (kind === 'codex') return 'Codex';
  return kind[0].toUpperCase() + kind.slice(1);
}

const KINDS = new Set(['ask', 'approve', 'secret', 'drive', 'pick']);

/** ask, approve, secret, drive, pick, else other. */
export const kindOf = (cp) => (KINDS.has(cp && cp.kind) ? cp.kind : 'other');

/** A title's first line is what the person reads first; the rest explains it. */
export function splitTitle(title) {
  const t = String(title || '').replace(/\r/g, '').trim();
  const i = t.indexOf('\n');
  if (i < 0) return { head: t, body: null };
  const body = t.slice(i + 1).trim();
  return { head: t.slice(0, i).trim(), body: body || null };
}

/** What a drive asks to do, in the words its card and its row use. */
export function driveVerb(cp) {
  switch (cp && cp.drive && cp.drive.action) {
    case 'close': return { action: 'close', wants: 'wants to close', once: 'Let it close', session: null, row: 'Wants to close' };
    case 'restart': return { action: 'restart', wants: 'wants to restart', once: 'Let it restart', session: 'Let it restart it when it needs to', row: 'Wants to restart' };
    case 'override': return { action: 'change', wants: 'wants to change', once: 'Let it change this', session: 'Let it change it when it needs to', row: 'Wants to change' };
    default: return { action: 'type', wants: 'wants to type', once: 'Let it type this', session: 'Let it use this pane', row: 'Wants to type in' };
  }
}

/** "Wants the mail service API key": the secret's name as the sidebar row says it. */
export function wantsLine(title) {
  const head = splitTitle(title).head;
  // A plain first word reads lower case mid-sentence; a name (GitHub,
  // OpenAI) or an acronym (AWS) keeps its case.
  const m = /^([A-Z][a-z]+)(\b.*)$/.exec(head);
  const name = m ? m[1].toLowerCase() + m[2] : head;
  return `Wants the ${name}`;
}

/**
 * The mark on a sidebar row: { kind, text, code }. A drive names the pane
 * it would act on (`paneName`, as the sidebar and the tabs name it).
 */
export function markOf(cp, paneName = null) {
  const k = kindOf(cp);
  if (k === 'approve') return { kind: k, text: String(cp.command || '').split('\n')[0], code: true };
  if (k === 'secret') return { kind: k, text: wantsLine(cp.title), code: false };
  if (k === 'pick') return { kind: k, text: `Pick one of ${(cp.variants && cp.variants.length) || 'the'}: ${splitTitle(cp.title).head}`, code: false };
  if (k === 'drive' && cp.drive) return { kind: k, text: `${driveVerb(cp).row} ${paneName || 'a pane'}`, code: false };
  return { kind: k, text: splitTitle(cp.title).head, code: false };
}
