// The hand-off card's line (2026-11-12, the user: "The hand-off card is a wall
// of text, not really useful" ... "will every llm write in the good
// format?"). A brief's Hand-off bullet is whatever the session wrote: one
// short line, or 1700 characters of commits, counts and ids. Every client
// draws the card from the line this gives (the state's timeline `text`), at
// most two lines; the whole entry stays in the brief, where its page shows
// it, and in the timeline's `full`.
//
// The line: the entry's first useful sentence, cut at a word with "…" past
// MAX characters. A sentence ends at . ! or ? followed by a space and a
// capital or a digit, outside brackets ("0.1.37", "(see a.md. Then b)" and
// "e.g. Foo" are not ends). A sentence that only names a session (its id,
// its name, "Session 25204b9f (ravenry-1d) is main.") is skipped for the
// next one: session names and ids are never shown to the person (an entry
// of nothing else gives no line). No sentence end at all: the entry itself,
// cut the same way.
// Pure functions, tested in hub/tools/handoffline-test.mjs.

/** The longest line the hub sends; the clients cap the card at two lines on top. */
export const MAX = 120;

const ABBR = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.$/i;

/** The entry split at each sentence end outside brackets, each sentence trimmed. */
export function sentencesOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if (depth === 0 && (c === '.' || c === '!' || c === '?') && s[i + 1] === ' ' && /[A-Z0-9"'`*]/.test(s[i + 2] || '')) {
      if (c === '.' && ABBR.test(s.slice(start, i + 1))) continue;
      out.push(s.slice(start, i + 1).trim());
      start = i + 2;
    }
  }
  const rest = s.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// A short id: hex with a digit and a letter ("25204b9f"), 6 to 12 long.
const SHORT_ID = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,12}$/i;
// A session's name as Claude Code gives it: words with dashes, the last part
// a short counter with a digit ("ravenry-1d", "garden-planner-8e", "ravenry-19").
const NAME = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*-(?=[a-z0-9]{0,3}\d)[a-z0-9]{1,4}$/;
// What a sentence about a session says around its name or id.
const FILLER = new Set(('session sessions chat conversation agent claude codex is was are be been being the this that a an now here and or of from to by in on for as at with it its ' +
  'main primary current previous prior old new fresh last next same this one id name named called continued continues continuing continue resumed resumes resuming resume ' +
  'took takes take over picked picks pick up handed hands hand off hand-off handoff me i we our my you your still running runs ran started starts start ' +
  'writing wrote written reading read reads tab pane window').split(' '));

/** Whether a sentence only names a session: an id or a name, and nothing but the words around one. */
export function onlyNamesASession(sentence, names = null) {
  const words = String(sentence || '').split(/\s+/).map((w) => w.replace(/^[("'`[{<*]+|[)"'`\]}>*.,;:!?]+$/g, '')).filter(Boolean);
  let refs = 0;
  for (const w of words) {
    if (UUID.test(w) || SHORT_ID.test(w) || NAME.test(w) || (names && names.has(w))) { refs++; continue; }
    if (/^session[:=#]?/i.test(w) && w.length > 8 && (UUID.test(w.replace(/^session[:=#]?/i, '')) || SHORT_ID.test(w.replace(/^session[:=#]?/i, '')))) { refs++; continue; }
    if (!FILLER.has(w.toLowerCase())) return false;
  }
  return refs > 0;
}

/** A line cut at a word to at most `max` characters, "…" at the cut. */
export function cutAtWord(s, max = MAX) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max - 1);
  const sp = room.lastIndexOf(' ');
  const head = sp > max / 3 ? room.slice(0, sp) : room;
  return head.replace(/[\s,;:(\-–[{]+$/, '') + '…';
}

/**
 * The card's line for a Hand-off entry (plain text, as the timeline holds it):
 * its first sentence that says more than a session's name, cut at a word.
 * `names`: the session names the board knows (a Set), skipped as ids are.
 */
export function handoffLine(text, { max = MAX, names = null } = {}) {
  const all = sentencesOf(text);
  if (!all.length) return '';
  const first = all.find((x) => !onlyNamesASession(x, names));
  // Only a session's name and id: nothing to show (the card keeps its title and time).
  return first ? cutAtWord(first, max) : '';
}
