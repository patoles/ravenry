// Suggested answers: when a message ends on a question that offers options
// (A/B/C, 1/2/3, "X or Y?", "B, C, or keep A?"), the options as buttons on
// the session's card and on the phone alert. Rules only: no model call, the
// message never leaves the Mac (HUB-013). A wrong read costs little, the
// reply box stays.
//
// suggestedAnswers(text, question) -> [{ label, text }], at most four:
// `label` on the button (the key and its short words from the message, cut
// at a word), `text` typed into the session as the reply ("B", "Keep A",
// "Yes"). `question` is the message's ending question (state.mjs
// endingQuestion), `text` the whole message it ends, or the question alone.

export const MAX_ANSWERS = 4;
export const LABEL_MAX = 26;

const KEY = '[A-H]|[1-9]';
const YESNO = /^(should|shall|do you want|want me|can i|could i|may i|is it ok|ok to|ready|go ahead|would you like|happy for me|all good|good to)/i;

export const isYesNo = (q) => YESNO.test(String(q || '').trim());

const plain = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** A button's words: whole when they fit, else cut at a word with "…", never inside an open bracket. */
export function cut(s, n = LABEL_MAX) {
  s = plain(s).replace(/[.:;,]+$/, '');
  if (s.length <= n) return s;
  let c = s.slice(0, n).replace(/\s+\S*$/, '');
  const open = c.lastIndexOf('(');
  if (open > 0 && c.indexOf(')', open) < 0) c = c.slice(0, open);
  return c.replace(/[\s,;:(-]+$/, '') + '…';
}

// What each key is called above the question: an inline list
// "(A today, B the app, C the app with ...)" first, else the last line that
// starts with it ("**B:** ...", "B) ...", "2. **A safety net** ...",
// "**Option A**: ...").
function definitions(text) {
  const defs = {};
  const body = String(text || '').replace(/```[\s\S]*?```/g, '\n');
  const line = new RegExp(`^\\s*(?:[-*]\\s+)?(?:#+\\s*)?(?:\\*\\*)?(?:Option\\s+)?(${KEY})(?:\\*\\*)?\\s*[:.)]\\s*(?:\\*\\*)?\\s*(.+)$`);
  for (const l of body.split('\n')) {
    const m = l.match(line);
    if (!m) continue;
    // The bold head of the line, else its first clause.
    const bold = m[2].match(/^\*\*(.+?)\*\*/) || m[2].match(/^(.+?)\*\*/);
    const words = plain(bold ? bold[1] : m[2].split(/[.:;]\s/)[0]);
    if (words) defs[m[1]] = words;
  }
  const inline = body.match(/\(([A-H]) ([^,()]+)(?:, ([A-H]) ([^,()]+))+\)/);
  if (inline) for (const part of inline[0].slice(1, -1).split(/,\s*/)) { const k = part.match(/^([A-H]) (.+)$/); if (k) defs[k[1]] = plain(k[2]); }
  return defs;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function suggestedAnswers(text, question) {
  const q = String(question || '').trim();
  if (!q) return [];
  const defs = definitions(text);
  // Keys asked between, joined by "or": "B, C, or keep A?", "1 or 2?".
  const named = [...q.matchAll(new RegExp(`(?:\\b(keep|go with|pick|try)\\s+)?(?<![\\w./-])(${KEY})(?![\\w/-]|\\.\\d)`, 'g'))].map((m) => ({ verb: m[1] || null, key: m[2] }))
    .filter((k, i, all) => all.findIndex((x) => x.key === k.key) === i);
  if (named.length >= 2 && /\bor\b/.test(q)) {
    // Keys with nothing said of them above: no guess.
    if (!named.every((k) => defs[k.key])) return [];
    const rec = (String(text || '').match(new RegExp(`I (?:recommend|would pick|'d pick|'d go with|suggest)\\s+(?:option\\s+)?\\**(${KEY})\\b`, 'i')) || [])[1] || null;
    let opts = named.map(({ verb, key }) => {
      const said = verb ? `${cap(verb)} ${key}` : key;
      return { label: cut(`${said}: ${defs[key]}`), text: said, key };
    });
    if (rec) opts = [...opts.filter((o) => o.key === rec), ...opts.filter((o) => o.key !== rec)];
    return opts.slice(0, MAX_ANSWERS).map(({ label, text: t }) => ({ label, text: t }));
  }
  if (isYesNo(q)) return [{ label: 'Yes', text: 'Yes' }, { label: 'No', text: 'No' }];
  // "X or Y?" with no keys: the two sides, each short, after a lead-in
  // ("Which, X or Y?").
  const sides = plain(q).replace(/\?+$/, '').split(/,?\s+or\s+/i);
  if (sides.length === 2 && named.length < 2) {
    const left = sides[0].split(/[,:]\s+/).pop();
    const both = [left, sides[1]].map((s) => s.trim());
    if (both.every((s) => s && s.split(/\s+/).length <= 7)) return both.map((s) => ({ label: cut(cap(s)), text: cap(s) }));
  }
  return [];
}
