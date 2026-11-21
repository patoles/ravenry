// The hyperlinks (OSC 8) a pane's read carried, put on the Live screen's
// entries (GET /api/live), so a phone opens or copies their targets as the
// Mac does (docs/FEATURES.md TERM-021).
//
// A read's links are [{ t: the text the program linked, u: its URI, line:
// the screen line it is on, soft wraps joined }] (server/ravenryd.mjs,
// joinLinks). The trimmed entries keep each screen line's text, without
// its glyph and indent, so a link goes on an entry line that has its text
// and is part of the link's own screen line: a word linked once is not
// linked everywhere it appears. Only http, https and file links, as on the
// Mac.

const SCHEMES = /^(?:https?|file):/i;

/** Only the links a client may open or copy: http, https and file. */
export const usableLinks = (links) => (Array.isArray(links) ? links : []).filter((k) => k && typeof k.t === 'string' && k.t && typeof k.u === 'string' && SCHEMES.test(k.u));

/**
 * Entries with `lk`: [{ i: the entry's line, t, u }] for each link on one
 * of its lines. Entries with no link come back as they were.
 */
export function linkEntries(entries, links) {
  const ks = usableLinks(links);
  if (!ks.length) return entries;
  return entries.map((e) => {
    if (!Array.isArray(e.l)) return e;
    const lk = [];
    e.l.forEach((x, i) => {
      const own = String(x || '').trim();
      if (!own) return;
      for (const k of ks) {
        if (!own.includes(k.t) || !String(k.line || '').includes(own)) continue;
        if (!lk.some((y) => y.i === i && y.t === k.t)) lk.push({ i, t: k.t, u: k.u });
      }
    });
    return lk.length ? { ...e, lk } : e;
  });
}
