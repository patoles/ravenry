// Claude Code's suggested reply, told apart from text the user typed.
//
// After a turn ends, Claude Code (setting `promptSuggestionEnabled`, on by
// default) shows a dim grey suggested reply after the `❯` in its prompt box,
// a few seconds after the done line. A plain read of the screen (`cmux
// read-screen`, iTerm2's AppleScript `contents`) has no styles, so
// parseScreen (server/screen.mjs) reads that suggestion as a half-typed
// reply in `draft`. This module is the ONE place that decides which one a
// prompt holds; every consumer of `screen.draft` gets a screen it has
// judged (`withPrompt`). The rules are written up in docs/STATE-RULES.md,
// "The suggested reply"; keep the two in step.
//
// Three signals, strongest first:
// 1. The styled read (cmux only): `cmux rpc terminal.replay` returns the
//    render grid with a style per span. The suggestion's spans are `faint`;
//    typed text is not. Measured on Claude Code 2.1.318 in cmux 0.64.20.
//    Definitive (`sure`), costs about as much as a read-screen (30 ms).
// 2. The history of reads (any terminal, no keystrokes): a suggestion
//    appears on its own a few seconds after a turn ends and does not change
//    until the user types. Not definitive.
// 3. The probe (only on a path that types into the prompt anyway): type one
//    character and read the prompt again. Over a suggestion the prompt then
//    holds just that character (a typed character, a paste, and a typed "!"
//    all replace the suggestion); over typed text it holds the old text plus
//    the character. Backspace then puts the prompt back as it was (over a
//    suggestion, Backspace to an empty prompt brings the suggestion back).
//    Definitive.

// A suggestion counts only when it showed up this soon after the turn
// ended (measured: 2 to 6 s after the done line).
export const SUGGEST_WINDOW_MS = 30000;
// The probe's character: a digit, which the prompt inserts as typed. ("?"
// opens the shortcuts help instead, "/" and "@" open menus, and in vim
// mode's NORMAL state a letter such as "x" is a command that edits the
// text, while a digit is only a count.)
export const PROBE_CHAR = '1';

const RULE_ROW = /^\s*─{8,}\s*$/;
const MARKER = /^\s*([❯!])[\s ]?/;

// Text compared without its whitespace: the prompt wraps at the terminal's
// width, and one more character can move the wrap.
const bare = (s) => String(s || '').replace(/[\s ]+/g, '');

// ------------------------------------------------------------ 1. styled read

// The prompt box of a cmux render grid (`terminal.replay`, format
// cmux.render-grid.v1): { marker: '❯' | '!', text, ghost } for the box
// nearest the bottom, where ghost means every visible character after the
// marker is faint (Claude Code's suggestion or its `Try "..."` placeholder).
// null when the grid shows no prompt box.
export function gridPrompt(grid) {
  const g = grid && (grid.render_grid || grid);
  if (!g || !Array.isArray(g.row_spans)) return null;
  const faint = new Map((g.styles || []).map((s) => [s.id, !!s.faint]));
  const rows = new Map();
  for (const sp of g.row_spans) {
    if (!rows.has(sp.row)) rows.set(sp.row, []);
    rows.get(sp.row).push(sp);
  }
  const textOf = (spans) => {
    let line = '';
    for (const sp of [...spans].sort((a, b) => a.column - b.column)) {
      if (sp.column > line.length) line += ' '.repeat(sp.column - line.length);
      line += sp.text;
    }
    return line;
  };
  const order = [...rows.keys()].sort((a, b) => a - b);
  const isRule = (r) => rows.has(r) && RULE_ROW.test(textOf(rows.get(r)));
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k];
    const spans = [...rows.get(r)].sort((a, b) => a.column - b.column);
    const line = textOf(spans);
    const m = MARKER.exec(line);
    if (!m || !isRule(r - 1)) continue;
    // The marker row and the rows under it up to the box's bottom rule.
    const body = [r];
    for (let j = r + 1; j < r + 12 && !isRule(j); j++) body.push(j);
    if (!isRule(body[body.length - 1] + 1)) continue;
    let ghost = 0;
    let typed = 0;
    const lines = [];
    for (const row of body) {
      const sps = [...(rows.get(row) || [])].sort((a, b) => a.column - b.column);
      let skip = row === r ? m[0].length : 0;
      for (const sp of sps) {
        let t = sp.text;
        if (skip > 0) { const cut = Math.min(skip, t.length); t = t.slice(cut); skip -= cut; }
        const n = bare(t).length;
        if (faint.get(sp.style_id)) ghost += n; else typed += n;
      }
      lines.push(textOf(sps));
    }
    const text = [lines[0].slice(m[0].length), ...lines.slice(1).map((l) => l.replace(/^\s{2}/, ''))].join('\n').trim();
    return { marker: m[1], text, ghost: ghost > 0 && typed === 0 };
  }
  return null;
}

// ------------------------------------------------------------ 2. history

// Per tab, what its prompt held over the board's reads. `see` takes each
// fresh read of a tab (a parseScreen result) and returns the verdict on the
// text in its prompt: 'empty', 'suggestion', 'draft', or 'unknown' when the
// board never saw this turn end (it started while the session was at rest).
//
// A turn is seen ending when a read shows the session working and a later
// one at rest, or when the done line changes (a turn shorter than the 2 s
// between reads). Then the prompt text is a suggestion when it was not in
// the prompt while the turn ran, first showed up within SUGGEST_WINDOW_MS of
// the turn's end, and has not changed since. Any other change makes it typed
// text. A suggestion that comes back after the user typed and deleted their
// text is recognised by its text.
export function createTracker({ windowMs = SUGGEST_WINDOW_MS } = {}) {
  const tabs = new Map();
  const fresh = () => ({ working: false, known: false, restAt: null, doneKey: null, workTexts: new Set(), first: null, changed: false, suggestion: null });
  function judge(r, text) {
    if (!text) return 'empty';
    if (r.working || r.workTexts.has(text)) return 'draft';
    if (r.suggestion === text) return 'suggestion';
    if (!r.known) return 'unknown';
    if (r.first && r.first.text === text && !r.changed && r.first.at - r.restAt <= windowMs) {
      r.suggestion = text;
      return 'suggestion';
    }
    return 'draft';
  }
  return {
    see(id, screen, at = Date.now()) {
      if (!screen || !screen.readable) return tabs.has(id) ? judge(tabs.get(id), screen && screen.draft) : 'unknown';
      if (!screen.claudeLive) { tabs.delete(id); return 'empty'; }
      let r = tabs.get(id);
      const doneKey = screen.done ? JSON.stringify(screen.done) : null;
      if (!r) { r = fresh(); r.doneKey = doneKey; tabs.set(id, r); }
      const text = screen.draft || '';
      if (screen.dialog) return judge(r, text);
      if (screen.working || screen.agentsRunning > 0) {
        if (!r.working) { const keep = r.doneKey; Object.assign(r, fresh(), { doneKey: keep }); }
        r.working = true;
        if (text) r.workTexts.add(text);
        return 'draft';
      }
      // At rest. A turn that ended since the last read starts a new rest.
      const ended = r.working || (doneKey && doneKey !== r.doneKey);
      if (ended) {
        const work = r.working ? r.workTexts : new Set();
        Object.assign(r, fresh(), { known: true, restAt: at, workTexts: work });
      } else if (r.restAt == null) {
        r.restAt = at;
      }
      r.doneKey = doneKey;
      if (text) {
        if (!r.first) r.first = { text, at };
        else if (text !== r.first.text && text !== r.suggestion) r.changed = true;
      }
      return judge(r, text);
    },
    forget(id) { tabs.delete(id); },
    has(id) { return tabs.has(id); },
  };
}

// ------------------------------------------------------------ the verdict

// What the prompt of a parsed screen holds: { kind, sure, by }.
// kind: 'empty' | 'suggestion' | 'draft' | 'unknown'. `styled` is
// gridPrompt's result from a read of the same moment (or null), `history`
// the tracker's verdict (or null).
export function judgePrompt({ text, styled = null, history = null }) {
  if (!text) return { kind: 'empty', sure: true, by: 'screen' };
  if (styled && styled.marker === '❯' && bare(styled.text) === bare(text)) {
    return { kind: styled.ghost ? 'suggestion' : 'draft', sure: true, by: 'style' };
  }
  if (history && history !== 'empty') return { kind: history, sure: false, by: 'history' };
  return { kind: 'unknown', sure: false, by: 'none' };
}

// The parsed screen with `draft` holding only text the user typed. A
// suggestion moves to `suggestion`. 'unknown' (no style, no history: the
// board started while the session sat at rest) shows as NOT a draft: almost
// every session at rest holds a suggestion, so calling them all half typed
// would flag most of the board after a restart; every path that types into
// a prompt or closes a tab still makes sure first (the styled read or the
// probe). `prompt` keeps the verdict.
export function withPrompt(screen, verdict) {
  if (!screen || !screen.draft) return screen ? { ...screen, suggestion: null, prompt: { kind: 'empty', sure: true, by: 'screen' } } : screen;
  const v = verdict || { kind: 'unknown', sure: false, by: 'none' };
  if (v.kind === 'draft') return { ...screen, suggestion: null, prompt: v };
  return { ...screen, draft: '', suggestion: screen.draft, prompt: v };
}

// ------------------------------------------------------------ 3. the probe

// The prompt box of a plain read: { marker: '❯' | '!', text } nearest the
// bottom, or null. Like parseScreen's box, and it also takes the "!" that
// marks Claude Code's bash mode (parseScreen sees no prompt there).
export function promptBox(screenText) {
  const lines = String(screenText || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  for (let b = lines.length - 1; b > 0; b--) {
    if (!RULE_ROW.test(lines[b])) continue;
    for (let a = b - 1; a >= 0 && b - a <= 12; a--) {
      if (!RULE_ROW.test(lines[a])) continue;
      const inner = lines.slice(a + 1, b);
      const m = inner.length ? MARKER.exec(inner[0]) : null;
      if (!m) break;
      const text = [inner[0].slice(m[0].length), ...inner.slice(1).map((l) => l.replace(/^\s{2}/, ''))].join('\n').trim();
      return { marker: m[1], text };
    }
  }
  return null;
}

// `inserted(now, old, c)`: `now` is `old` with one `c` put in somewhere
// (where the cursor was), whitespace aside.
function inserted(now, old, c) {
  const n = bare(now);
  const o = bare(old);
  if (n.length !== o.length + 1) return false;
  for (let i = 0; i < n.length; i++) if (n[i] === c && n.slice(0, i) + n.slice(i + 1) === o) return true;
  return false;
}

// Types one character into a prompt that shows `old` and reads what became
// of it. read() returns the screen text; type(c) and key(name) send to the
// tab. `bang`: the character is the "!" that starts a "! command" (bash
// mode), and over a suggestion it stays typed. Otherwise PROBE_CHAR is typed
// and always taken back with Backspace.
// Returns { kind: 'suggestion' | 'draft' | 'unknown', keys, error?, bash? }:
// 'suggestion' leaves the prompt as it was (or in bash mode, for `bang`);
// 'draft' leaves the user's text exactly as it was; 'unknown' means the
// board could not tell, and it pressed nothing it could not account for.
export async function probePrompt({ read, type, key, old, bang = false, wait = 150, tries = 6 }) {
  const keys = [];
  const c = bang ? '!' : PROBE_CHAR;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = promptBox(await read());
  if (!before || before.marker !== '❯' || bare(before.text) !== bare(old)) return { kind: 'unknown', keys, error: 'its prompt changed while the board looked' };
  const t = await type(c);
  keys.push('text:' + c);
  if (!t || !t.ok) return { kind: 'unknown', keys, error: (t && t.err) || 'the terminal refused the text' };
  let box = null;
  for (let k = 0; k < tries; k++) {
    await sleep(wait);
    box = promptBox(await read());
    if (box && !(box.marker === '❯' && bare(box.text) === bare(old))) break;
  }
  const back = async () => { const b = await key('backspace'); keys.push('backspace'); return b && b.ok; };
  if (!box) return { kind: 'unknown', keys, error: 'the board could not read its prompt after typing' };
  // Over a suggestion: the character alone (or, for "!", bash mode empty).
  if (bang ? box.marker === '!' && box.text === '' : box.marker === '❯' && box.text === c) {
    if (!bang) await back();
    return { kind: 'suggestion', keys, bash: bang };
  }
  // Over typed text: the old text with the character in it.
  if (box.marker === '❯' && inserted(box.text, old, c)) {
    if (!(await back())) return { kind: 'draft', keys, error: `the board typed "${c}" to look and could not take it back` };
    return { kind: 'draft', keys };
  }
  return { kind: 'unknown', keys, error: box.marker === '❯' && bare(box.text) === bare(old) ? `its prompt did not take the "${c}" the board typed to look` : 'its prompt changed while the board looked' };
}
