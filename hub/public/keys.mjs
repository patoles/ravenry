// How Ravenry shows what an agent would type or typed, everywhere it shows
// it (the desktop app's drive card, its input log and its terminal marks,
// the phone board, the phone's alerts, the hub's alert text): the input
// log's text ("<Ctrl+C>npm run dev<Enter>", PROTOCOL.md section 4) as text
// and named keys in order, a key said as people read it ("Ctrl C"), never
// as its token.
//
// Plain JavaScript with no import, as homepath.mjs, so the hub, the web
// board and the apps all load this one file.

/**
 * A key token as people read it: "<Ctrl+C>" is "Ctrl C".
 * @param {string} token
 * @returns {string}
 */
export function keyLabel(token) {
  return String(token).replace(/^</, '').replace(/>$/, '').replace(/\+/g, ' ');
}

/**
 * What an input types, in order: text, and keys to show as chips.
 * @param {string | null | undefined} text
 * @returns {{ kind: 'text' | 'key', text: string }[]}
 */
export function keyParts(text) {
  const out = [];
  const t = String(text ?? '');
  const re = /<([A-Za-z0-9+/]+)>/g;
  let at = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > at) out.push({ kind: 'text', text: t.slice(at, m.index) });
    out.push({ kind: 'key', text: keyLabel(m[0]) });
    at = m.index + m[0].length;
  }
  if (at < t.length) out.push({ kind: 'text', text: t.slice(at) });
  return out;
}

/**
 * The same as one line of plain text, for where nothing can be drawn as a
 * chip: each key in brackets ("[Ctrl C] npm run dev [Enter]").
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function keyLine(text) {
  return keyParts(text).map((p) => (p.kind === 'key' ? `[${p.text}]` : p.text.trim())).filter(Boolean).join(' ');
}
