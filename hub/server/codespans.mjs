// Code spans on the Live screen (docs/design/LiveCode.dc.html, C).
//
// Claude Code draws inline code in a colour and drops the backticks, so the
// screen alone cannot say which words were code. The transcript can: each
// Claude text block keeps its markdown. This module reads the recent text
// blocks of a session's transcript and marks, in each Claude ('c') entry of
// the trimmed screen, the text its own message had in backticks (and the
// lines of its fenced blocks). Only 'c' entries are marked; tool lines and
// the user's prompts never are.
//
// A fenced block comes out as one mark with `b` (a code block): its lines'
// pieces together, and as its text the block's own source (indentation and
// all) when every line of it is on screen, so the page draws it as one block
// with one Copy that copies the whole block, however the terminal wrapped it.
//
// Matching, in two steps, on the letters and digits alone (so markdown
// syntax, list bullets, box lines and the terminal's wrapping all drop out):
// 1. An entry belongs to the recent message whose text holds it: sampled
//    16-character pieces of the entry found in the message (60% or more,
//    the best one wins, the newest on a tie). A span from any other message
//    is never marked in this entry.
// 2. Each span of that message is placed where its letters appear in the
//    entry with the same letters around it as in the message (up to 16
//    either side), so a word that is code once and plain prose elsewhere is
//    marked only where it was code.
//
// Cheap per tick: the transcript is read incrementally from the last byte
// read (the first read takes its last 512 KB), each message's spans and
// letters are worked out once, and each entry's marks are cached by its text
// and the transcript generation.
//
// The same reading keeps the person's own messages on the Live screen
// (keepPersonTurns): the screen is the terminal's, and the terminal can lose
// rows (2026-11-14: in a Ravenry pane, the rows of a message the person
// sent from the phone, and the done line above it, were drawn over; the
// screen went on from the reply before it to the tools after it). The
// transcript keeps the order of the turns, so a message of the person's
// missing between two things the screen still shows goes back between them.

import fs from 'node:fs';

const TAIL = 512 * 1024;   // the first read of a transcript: its recent part only
const KEEP = 60;           // recent text blocks kept per transcript
const KEEP_TURNS = 400;    // recent turns (text blocks, tool calls, the person's messages) kept per transcript
const CTX = 16;            // letters of context either side of a span
const PROBE = 16;          // length of each sampled piece of an entry
const AL = /[\p{L}\p{N}]/u;

// ------------------------------------------------------------ spans in markdown

// The code spans of one markdown text, in order: { t: text, a, b } where a, b
// are its place in the source. Inline spans follow CommonMark backtick runs
// (a run of N backticks closes on the next run of exactly N); every
// non-blank line of a fenced block is a span of its own, with `blk` (the
// block's number in the message) and `bt` (the block's whole text).
export function spansOf(md) {
  const out = [];
  const lines = md.split('\n');
  let pos = 0;
  let fence = null;
  let blk = -1;     // the open block's number
  let body = [];    // its lines, as written
  let lead = 0;     // the fence's indent, taken off each line
  let first = 0;    // its first span in out
  const close = () => {
    while (body.length && !body[body.length - 1].trim()) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    const bt = body.join('\n');
    for (let k = first; k < out.length; k++) out[k].bt = bt;
    fence = null;
  };
  let para = []; // [{ text, at }] lines of prose, scanned together (a span may cross a soft break)
  const flush = () => {
    if (!para.length) return;
    const text = para.map((p) => p.text).join('\n');
    const at = (k) => { // source offset of index k in the joined text
      let n = 0;
      for (const p of para) { if (k <= n + p.text.length) return p.at + (k - n); n += p.text.length + 1; }
      return para[para.length - 1].at + para[para.length - 1].text.length;
    };
    for (const s of inlineSpans(text)) out.push({ t: s.t, a: at(s.a), b: at(s.b) });
    para = [];
  };
  for (const line of lines) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) close();
      else {
        body.push(line.slice(Math.min(lead, line.length - line.trimStart().length)));
        if (line.trim()) {
          const sp = line.length - line.trimStart().length;
          const t = line.trim();
          out.push({ t, a: pos + sp, b: pos + sp + t.length, fenced: true, blk });
        }
      }
    } else if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      flush();
      fence = m[1];
      blk++;
      body = [];
      lead = m[0].length - m[1].length;
      first = out.length;
    } else if (!line.trim()) flush();
    else para.push({ text: line, at: pos });
    pos += line.length + 1;
  }
  if (fence) close(); // a block still being written: what there is so far
  flush();
  return out;
}

function inlineSpans(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] !== '`') { i++; continue; }
    let n = 0;
    while (text[i + n] === '`') n++;
    const open = i + n;
    let j = open;
    let close = -1;
    while (j < text.length) {
      if (text[j] !== '`') { j++; continue; }
      let r = 0;
      while (text[j + r] === '`') r++;
      if (r === n) { close = j; break; }
      j += r;
    }
    if (close < 0) { i = open; continue; }
    let a = open; let b = close;
    let t = text.slice(a, b).replace(/\n/g, ' ');
    if (t.length > 1 && t[0] === ' ' && t[t.length - 1] === ' ' && t.trim()) { t = t.slice(1, -1); a++; b--; }
    if (t.trim()) out.push({ t, a, b });
    i = close + n;
  }
  return out;
}

// The letters and digits of a text, with where each came from.
function lettersOf(text) {
  let s = '';
  const at = [];
  let i = 0;
  for (const ch of text) {
    if (AL.test(ch)) { s += ch; for (let k = 0; k < ch.length; k++) at.push(i); }
    i += ch.length;
  }
  return { s, at };
}

function prepare(text) {
  // The fence lines themselves (and a language name on them) are not drawn.
  const L = lettersOf(text.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, (x) => ' '.repeat(x.length)));
  // A source offset to a letter index: the first letter at or after it.
  const idx = (off) => { let lo = 0, hi = L.at.length; while (lo < hi) { const m = (lo + hi) >> 1; if (L.at[m] < off) lo = m + 1; else hi = m; } return lo; };
  const all = spansOf(text);
  const spans = all.map((x) => ({ t: x.t, a: idx(x.a), b: idx(x.b), ...(x.fenced ? { blk: x.blk, bt: x.bt } : {}) })).filter((x) => x.b > x.a);
  // How many lines each block has, to tell a whole block on screen from part of one.
  const blkLines = {};
  for (const x of spans) if (x.blk != null) blkLines[x.blk] = (blkLines[x.blk] || 0) + 1;
  return { s: L.s, spans, blkLines };
}

// ------------------------------------------------------------ the transcript

const files = new Map(); // path -> { ino, offset, msgs, gen }

function textBlocks(rec) {
  if (rec.type !== 'assistant' || rec.isSidechain || !rec.message || !Array.isArray(rec.message.content)) return [];
  return rec.message.content.filter((c) => c && c.type === 'text' && c.text && c.text.trim()).map((c) => c.text);
}

// A message the person sent, as Claude Code records it, or null: a typed
// prompt (a `user` record whose content is the text, or text blocks beside
// pictures; never a tool's result), or one sent while Claude worked and
// handed over between two steps (an `attachment` of type `queued_command`
// from a human turn). Claude Code's own records of commands, shell input,
// notices and agents' reports start with "<", and an Esc is recorded as
// "[Request interrupted by user]": none of them are the person's words as
// typed.
export function personText(rec) {
  if (!rec || rec.isSidechain || rec.isMeta || rec.isCompactSummary) return null;
  let c;
  if (rec.type === 'user' && rec.message) c = rec.message.content;
  else if (rec.type === 'attachment' && rec.attachment && rec.attachment.type === 'queued_command') {
    const a = rec.attachment;
    if (!(a.humanTurn || (a.origin && a.origin.kind === 'human'))) return null;
    if (a.commandMode && a.commandMode !== 'prompt') return null;
    c = a.prompt;
  } else return null;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !/^\s*</.test(b.text)).map((b) => b.text).join('\n');
  }
  text = text == null ? '' : String(text).trim();
  // "[Request interrupted by user]": Claude Code's note of an Esc, drawn as "Interrupted" under the tool.
  if (!text || text.startsWith('<') || /^Caveat:/.test(text) || /^\[Request interrupted by user/.test(text)) return null;
  return text;
}

// One record's turns, in order: Claude's text blocks ('a', with the id of
// its message), its tool calls ('t') and the person's message ('p').
function addTurns(c, rec) {
  let added = 0;
  if (rec.type === 'assistant' && !rec.isSidechain && rec.message && Array.isArray(rec.message.content)) {
    for (const b of rec.message.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        const id = (rec.uuid || '') + ':' + c.seq++;
        c.msgs.push({ id, ...prepare(b.text) });
        c.turns.push({ k: 'a', id });
        added++;
      } else if (b.type === 'tool_use') { c.turns.push({ k: 't' }); added++; }
    }
    return added;
  }
  const text = personText(rec);
  if (text == null) return 0;
  // The same words recorded twice in a row (a queued message and its turn) are one.
  const last = c.turns[c.turns.length - 1];
  const s = lettersOf(text).s;
  if (last && last.k === 'p' && last.s === s) return 0;
  c.turns.push({ k: 'p', text, s });
  return 1;
}

// The recent Claude text blocks of a transcript, read from where the last
// call stopped. `gen` changes only when a text block arrives (or the file
// is replaced), so callers can cache on it.
export function recentMessages(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = files.get(file);
  if (!c || st.ino !== c.ino || st.size < c.offset) {
    c = { ino: st.ino, offset: Math.max(0, st.size - TAIL), cut: st.size > TAIL, msgs: [], turns: [], seq: 0, gen: (c ? c.gen : 0) + 1 };
    files.set(file, c);
  }
  if (st.size > c.offset || (c.mtimeMs !== st.mtimeMs && c.seen)) {
    // The bytes read last time must still be there: a file rewritten in
    // place (same inode) starts over instead of being read from the middle.
    const back = c.seen ? c.seen.length : 0;
    let buf;
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(st.size - c.offset + back);
      fs.readSync(fd, buf, 0, buf.length, c.offset - back);
    } finally { fs.closeSync(fd); }
    if (back && !buf.subarray(0, back).equals(c.seen)) {
      files.delete(file);
      const fresh = recentMessages(file);
      if (fresh) fresh.gen = Math.max(fresh.gen, c.gen + 1);
      return fresh;
    }
    buf = buf.subarray(back);
    let from = 0;
    if (c.cut) { // the first read starts mid-line: skip to the next whole line
      const nl = buf.indexOf(10);
      if (nl < 0) return c;
      from = nl + 1;
    }
    const end = buf.lastIndexOf(10) + 1; // whole lines only; a half-written one waits
    if (end > from) {
      let added = 0;
      for (const line of buf.subarray(from, end).toString('utf8').split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        added += addTurns(c, rec);
      }
      if (c.msgs.length > KEEP) c.msgs = c.msgs.slice(-KEEP);
      if (c.turns.length > KEEP_TURNS) c.turns = c.turns.slice(-KEEP_TURNS);
      if (added) c.gen++;
    }
    c.offset += Math.max(end, from);
    c.cut = false;
    // The last bytes read, kept to notice a rewrite.
    const keep = buf.subarray(0, Math.max(end, from));
    c.seen = Buffer.concat([c.seen || Buffer.alloc(0), keep]).subarray(-64);
  }
  c.mtimeMs = st.mtimeMs;
  return c;
}

// ------------------------------------------------------------ marking entries

// The message an entry shows, or null.
function messageFor(E, msgs) {
  if (E.length < 4) return null;
  let best = null; let bestScore = 0;
  if (E.length < PROBE * 2) {
    for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].s.includes(E)) return msgs[k];
    return null;
  }
  const n = Math.min(40, Math.floor(E.length / PROBE));
  const step = (E.length - PROBE) / Math.max(1, n - 1);
  const probes = [];
  for (let k = 0; k < n; k++) probes.push(E.slice(Math.round(k * step), Math.round(k * step) + PROBE));
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k];
    let hit = 0;
    for (const p of probes) if (m.s.includes(p)) hit++;
    const score = hit / probes.length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : null;
}

const same = (x, y) => x === y || (/\s/.test(x) && /\s/.test(y));

// Marks for one entry's lines: [{ t, cmd?, r: [[line, start, end], ...] }].
function marksFor(lines, msg) {
  const text = lines.join('\n');
  const L = lettersOf(text);
  const E = L.s;
  const M = msg.s;
  const used = [];
  const out = [];
  for (const sp of msg.spans) {
    const S = M.slice(sp.a, sp.b);
    let best = -1; let bestScore = -1;
    for (let p = E.indexOf(S); p >= 0; p = E.indexOf(S, p + 1)) {
      if (used.some(([a, b]) => p < b && p + S.length > a)) continue;
      let before = 0; while (before < CTX && p - before - 1 >= 0 && sp.a - before - 1 >= 0 && E[p - before - 1] === M[sp.a - before - 1]) before++;
      let after = 0; while (after < CTX && p + S.length + after < E.length && sp.b + after < M.length && E[p + S.length + after] === M[sp.b + after]) after++;
      const avail = Math.min(CTX, sp.a, p) + Math.min(CTX, M.length - sp.b, E.length - p - S.length);
      const score = before + after;
      if (score >= Math.min(8, avail) && score > bestScore) { best = p; bestScore = score; }
    }
    if (best < 0) continue;
    used.push([best, best + S.length]);
    // The span's characters on screen: from its first letter to its last,
    // then out over whatever the span has before and after them ("! ", "--").
    let s = L.at[best];
    let e = L.at[best + S.length - 1] + 1;
    while (e < text.length && /[\uDC00-\uDFFF]/.test(text[e])) e++;
    const first = sp.t.search(AL);
    let last = 0;
    for (const m of sp.t.matchAll(/[\p{L}\p{N}]/gu)) last = m.index + m[0].length;
    const pre = sp.t.slice(0, first);
    const post = sp.t.slice(last);
    for (let k = pre.length - 1; k >= 0 && s > 0; k--) {
      if (!same(pre[k], text[s - 1])) break;
      s--;
      if (/\s/.test(pre[k])) while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
    }
    for (let k = 0; k < post.length && e < text.length; k++) {
      if (!same(post[k], text[e])) break;
      e++;
      if (/\s/.test(post[k])) while (e < text.length && /[ \t]/.test(text[e])) e++;
    }
    // Per line: a span the terminal wrapped onto two lines is two pieces.
    const r = [];
    let li = 0; let off = 0;
    for (; li < lines.length && off + lines[li].length < s; li++) off += lines[li].length + 1;
    while (li < lines.length && off <= e) {
      const a = Math.max(s, off) - off;
      const b = Math.min(e, off + lines[li].length) - off;
      const piece = lines[li].slice(a, b);
      if (piece.trim()) {
        const lead = piece.length - piece.trimStart().length;
        r.push([li, a + lead, a + lead + piece.trim().length]);
      }
      off += lines[li].length + 1;
      li++;
    }
    if (!r.length) continue;
    const x = { t: sp.t, r };
    if (sp.blk != null) { x.blk = sp.blk; x.bt = sp.bt; }
    out.push(x);
  }
  // In reading order, so the page can lay them out line by line.
  out.sort((x, y) => x.r[0][0] - y.r[0][0] || x.r[0][1] - y.r[0][1]);
  // A fenced block's lines become one code block (`b`): its pieces
  // together, its text the block's source when all its lines are on screen
  // (`whole`), else the lines that are, one per line.
  const merged = [];
  for (const x of out) {
    const prev = merged[merged.length - 1];
    if (x.blk != null && prev && prev.blk === x.blk) {
      prev.r.push(...x.r);
      prev.lines.push(x.t);
      continue;
    }
    merged.push(x.blk != null ? { blk: x.blk, bt: x.bt, r: [...x.r], lines: [x.t] } : x);
  }
  for (const x of merged) {
    if (x.blk != null) {
      const whole = x.lines.length === msg.blkLines[x.blk];
      x.t = whole ? x.bt : x.lines.join('\n');
      x.b = true;
      if (whole) x.whole = true;
      delete x.blk; delete x.bt; delete x.lines;
    }
    if (x.t.startsWith('! ')) x.cmd = true;
  }
  return merged;
}

const entryCache = new Map(); // gen + entry text -> marks

// The entries with `cs` (code spans) on each Claude entry that has any.
// Entries are not changed; marked ones are copies.
export function markEntries(entries, file) {
  const c = file ? recentMessages(file) : null;
  if (!c || !c.msgs.length) return entries;
  return entries.map((e) => {
    if (e.k !== 'c' || !e.l || !e.l.length) return e;
    const key = file + '\u0000' + c.gen + '\u0000' + e.l.join('\n');
    let cs = entryCache.get(key);
    if (cs === undefined) {
      const msg = messageFor(lettersOf(e.l.join('\n')).s, c.msgs);
      cs = msg && msg.spans.length ? marksFor(e.l, msg) : [];
      if (entryCache.size > 600) entryCache.clear();
      entryCache.set(key, cs);
    }
    return cs.length ? { ...e, cs } : e;
  });
}

// ------------------------------------------------------------ the person's messages

// Whether a prompt on screen shows a message of the transcript: the same
// letters, or one holding the other's first 24 (a screen that cut a long
// message, a transcript that kept text the screen folds).
function sameWords(screen, said) {
  if (screen === said) return true;
  if (!screen || !said) return false;
  const n = Math.min(24, screen.length, said.length);
  return n >= 4 && (said.includes(screen.slice(0, n)) || screen.includes(said.slice(0, n)));
}

// Whether a reply on screen is the start of a message of the transcript:
// the entry's first letters (its ⏺ line, which a terminal that draws over
// rows keeps longest) found in the message.
function startsIn(E, msg) {
  if (!E || E.length < 2) return false;
  return msg.s.includes(E.slice(0, 32));
}

// The entries with the person's messages kept: a message of the person's
// that the screen lost goes back as a 'u' entry (with `kept`), where the
// transcript has it. The screen and the transcript are lined up from the
// newest end (each reply and prompt on screen to the latest turn before the
// last one lined up that it can be, at most 40 turns back), so a reply said
// twice ("Done.") or a copy the terminal left higher up never pulls the
// line-up into older turns. A message goes back only between two things the
// screen and the transcript both have (a reply of Claude's or another
// message of the person's) with nothing of Claude's lost between them, and
// no prompt between them on screen that could be it in another form (a
// paste Claude Code folds, a picture); otherwise the screen is left as it
// is. Its place: after the reply before it, the done line and
// anything else that ends that turn, and as many tool calls as the
// transcript has between that reply and it.
export function keepPersonTurns(entries, file) {
  const c = file ? recentMessages(file) : null;
  if (!c || !c.turns || !c.turns.some((t) => t.k === 'p')) return entries;
  const byId = new Map(c.msgs.map((m) => [m.id, m]));
  const line = new Map(); // entry index -> turn index
  let j = c.turns.length;
  for (let i = entries.length - 1; i >= 0 && j > 0; i--) {
    const e = entries[i];
    if ((e.k !== 'c' && e.k !== 'u') || !e.l || !e.l.length) continue;
    const E = lettersOf(e.l.join('\n')).s;
    for (let k = j - 1, n = 0; k >= 0 && n < 40; k--) {
      const t = c.turns[k];
      if (t.k === 't') continue;
      n++;
      const hit = e.k === 'u' ? t.k === 'p' && sameWords(E, t.s) : t.k === 'a' && byId.has(t.id) && startsIn(E, byId.get(t.id));
      if (hit) { line.set(i, k); j = k; break; }
    }
  }
  const adds = []; // { at: entry index to insert before, turn }
  // What the screen and the transcript both have, in screen order.
  const anchors = [...line].sort((x, y) => x[0] - y[0]);
  for (let n = 0; n + 1 < anchors.length; n++) {
    const [ae, at] = anchors[n];
    const [be, bt] = anchors[n + 1];
    if (bt <= at + 1) continue;
    // Only the person's messages (and tool calls) lost between them: a reply
    // of Claude's missing too means more of the screen went, left as it is.
    const said = [];
    let gap = true;
    for (let k = at + 1; k < bt; k++) {
      if (c.turns[k].k === 'a') gap = false;
      else if (c.turns[k].k === 'p') said.push(k);
    }
    if (!gap || !said.length) continue;
    // A prompt between them on screen that is no message of the transcript:
    // maybe one of these, drawn another way. Left as it is.
    let unknown = false;
    for (let i = ae + 1; i < be; i++) if (entries[i].k === 'u') unknown = true;
    if (unknown) continue;
    for (const t of said) {
      // After what the transcript has before it: the done line and notes
      // that end the turn above, and its tool calls up to this message.
      let tools = 0;
      for (let k = at + 1; k < t; k++) if (c.turns[k].k === 't') tools++;
      let pos = ae + 1;
      let afterTool = false;
      while (pos < be) {
        const e = entries[pos];
        if (e.k === 't' && !e.b) { if (tools > 0) { tools--; afterTool = true; pos++; continue; } break; }
        if (e.k === 'c' && e.orphan && afterTool) { pos++; continue; }
        if (e.k === 's' || e.k === 'r' || e.k === 'o' || (e.k === 't' && e.b)) { afterTool = false; pos++; continue; }
        break;
      }
      adds.push({ at: pos, turn: t });
    }
  }
  if (!adds.length) return entries;
  adds.sort((x, y) => x.at - y.at || x.turn - y.turn);
  const out = [];
  let k = 0;
  entries.forEach((e, i) => {
    while (k < adds.length && adds[k].at === i) out.push(personEntry(c.turns[adds[k++].turn].text));
    out.push(e);
  });
  while (k < adds.length) out.push(personEntry(c.turns[adds[k++].turn].text));
  return out;
}

// A message of the person's as a Live screen entry: its lines (at most 60).
function personEntry(text) {
  const l = String(text).replace(/\r/g, '').split('\n').map((x) => x.replace(/\s+$/, ''));
  return { k: 'u', l: l.length > 60 ? [...l.slice(0, 59), `… +${l.length - 59} lines`] : l, kept: true };
}

// The generation of a transcript's text blocks, for the Live screen's version.
export function spansGen(file) {
  const c = file ? recentMessages(file) : null;
  return c ? c.gen : 0;
}
