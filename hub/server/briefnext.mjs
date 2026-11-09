// A brief's Next step split into what the clients draw (docs/BRIEF-FORMAT.md
// asks for at most three short bullets): the panel card's items and the
// page's dated entries. Sent with the brief as `nextParts`, in each
// project's `brief` in the state and in GET /api/brief. Pure functions,
// tested in hub/tools/briefnext-test.mjs.
//
//   nextParts: {
//     items: string[],     // at most 3 one-line items for the card, plain text
//     older: number,       // dated entries older than the one the items come from
//     entries: [{          // an older brief's dated entries, newest first;
//       date: 'YYYY-MM-DD',//   empty unless it has two or more
//       text: string,      // the entry on one line, its Markdown as written
//       sentences: string[],  // the same text split at each sentence end
//     }],
//   }
//
// An older Next step is a paragraph that grew a dated entry per session
// ("2026-11-06: Released 0.3.0. ... Next: the header, then pricing, then
// ship 0.3.1. 2026-11-05: ..."): it is split at each date, newest first, and
// the card's items come from the newest entry's "Next:", else its
// sentences. A list gives its first three bullets; anything else its
// "Next:" or its sentences.

/** Where a dated entry starts: a date at a line's start or after a sentence, then ":" or ")". */
const DATE_AT = /(^|\n|(?<=[.!?]\s))\s*[-*]?\s*(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?\s*[:)–-]\s*/g;

// A sentence ends at . ! or ? followed by a space ("0.3.0" and "lumen.app" are not ends).
export const sentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** A Next step split at each date, newest first; none when it has fewer than two. */
export function datedEntries(next) {
  const s = String(next || '');
  const marks = [...s.matchAll(DATE_AT)];
  if (marks.length < 2) return [];
  const out = [];
  marks.forEach((m, i) => {
    const start = (m.index || 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index || s.length : s.length;
    const text = s.slice(start, end).replace(/\s+/g, ' ').trim();
    if (text) out.push({ date: m[2], text });
  });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Markdown's marks off a line: what a person reads. */
export function plain(s) {
  return String(s || '').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\[[ xX>?~-]\]\s+/, '').trim();
}

const tidy = (s) => { const t = plain(s).replace(/[.;,]\s*$/, '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The items after "Next:" in a text: "a, then b, then c" is three. */
function nextList(t) {
  const m = /\bNext(?: step)?:\s*(.+)$/i.exec(t);
  if (!m) return null;
  return m[1].split(/,?\s+(?:and\s+)?then\s+|;\s+/i).map(tidy).filter(Boolean);
}

/** The panel card's Next: at most three one-line items, and how many older dated entries the brief holds. */
export function nextItems(next) {
  const text = String(next || '').trim();
  if (!text) return { items: [], older: 0 };
  const entries = datedEntries(text);
  if (entries.length) {
    const top = entries[0].text;
    return { items: (nextList(top) || sentences(top).map(tidy)).slice(0, 3), older: entries.length - 1 };
  }
  const bullets = text.split('\n').filter((l) => /^[-*+]\s+/.test(l)).map((l) => tidy(l.replace(/^[-*+]\s+/, '')));
  if (bullets.length) return { items: bullets.slice(0, 3), older: 0 };
  const one = text.replace(/\s+/g, ' ');
  return { items: (nextList(one) || sentences(one).map(tidy)).slice(0, 3), older: 0 };
}

/** Everything the clients draw of a Next step (the shape at the top). */
export function nextParts(next) {
  const { items, older } = nextItems(next);
  return { items, older, entries: datedEntries(String(next || '').trim()).map((e) => ({ ...e, sentences: sentences(e.text) })) };
}
