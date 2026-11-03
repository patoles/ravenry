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

import fs from 'node:fs';

const TAIL = 512 * 1024;   // the first read of a transcript: its recent part only
const KEEP = 60;           // recent text blocks kept per transcript
const CTX = 16;            // letters of context either side of a span
const PROBE = 16;          // length of each sampled piece of an entry
const AL = /[\p{L}\p{N}]/u;

// ------------------------------------------------------------ spans in markdown

// The code spans of one markdown text, in order: { t: text, a, b } where a, b
// are its place in the source. Inline spans follow CommonMark backtick runs
// (a run of N backticks closes on the next run of exactly N); every
// non-blank line of a fenced block is a span of its own.
export function spansOf(md) {
  const out = [];
  const lines = md.split('\n');
  let pos = 0;
  let fence = null;
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
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
      else if (line.trim()) {
        const lead = line.length - line.trimStart().length;
        const t = line.trim();
        out.push({ t, a: pos + lead, b: pos + lead + t.length, fenced: true });
      }
    } else if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      flush();
      fence = m[1];
    } else if (!line.trim()) flush();
    else para.push({ text: line, at: pos });
    pos += line.length + 1;
  }
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
  const spans = spansOf(text).map((x) => ({ t: x.t, a: idx(x.a), b: idx(x.b) })).filter((x) => x.b > x.a);
  return { s: L.s, spans };
}

// ------------------------------------------------------------ the transcript

const files = new Map(); // path -> { ino, offset, msgs, gen }

function textBlocks(rec) {
  if (rec.type !== 'assistant' || rec.isSidechain || !rec.message || !Array.isArray(rec.message.content)) return [];
  return rec.message.content.filter((c) => c && c.type === 'text' && c.text && c.text.trim()).map((c) => c.text);
}

// The recent Claude text blocks of a transcript, read from where the last
// call stopped. `gen` changes only when a text block arrives (or the file
// is replaced), so callers can cache on it.
export function recentMessages(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = files.get(file);
  if (!c || st.ino !== c.ino || st.size < c.offset) {
    c = { ino: st.ino, offset: Math.max(0, st.size - TAIL), cut: st.size > TAIL, msgs: [], gen: (c ? c.gen : 0) + 1 };
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
        for (const t of textBlocks(rec)) { c.msgs.push({ id: (rec.uuid || '') + ':' + c.msgs.length, ...prepare(t) }); added++; }
      }
      if (c.msgs.length > KEEP) c.msgs = c.msgs.slice(-KEEP);
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
    if (sp.t.startsWith('! ')) x.cmd = true;
    out.push(x);
  }
  // In reading order, so the page can lay them out line by line.
  out.sort((x, y) => x.r[0][0] - y.r[0][0] || x.r[0][1] - y.r[0][1]);
  return out;
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

// The generation of a transcript's text blocks, for the Live screen's version.
export function spansGen(file) {
  const c = file ? recentMessages(file) : null;
  return c ? c.gen : 0;
}
