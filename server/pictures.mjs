// Each project's latest picture, shown after the brief's own "## Pictures",
// and the gallery behind it: the current session's last 6 pictures, each
// with its time, who made it (the tool call or command, when the transcript
// says), its pixel size and its path (docs/design/Gallery.dc.html, B).
//
// Source: the project's current session only (the one the board shows for
// the project, its primary), and only what its MAIN transcript showed the user:
// (a) the main session's own Read of an image file, or (b) an image path the
// main session wrote in its own text to the user (outside tool calls). Nothing
// else counts: never a subagent's transcript (its own verification shots),
// never a path in a tool call's input (a Bash command, a Write target, a
// script's arguments) or in tool output (files a command or a test script
// wrote), no older sessions, no scan of the project's folder: those
// were how stray images got into the gallery. When
// the current session showed no image, the project has no picture. When the
// current session changes (a hand-off's fresh session), the old pick is
// dropped at once and the new session shows nothing until it shows an
// image: only what the agent sent in the current session helps.
//
// Who made a picture (the gallery's caption) may still come from the main
// transcript's tool calls and their output: the call that wrote the file.
// That lookup only names an admitted picture's maker; it never admits one.
//
// Privacy (hard rule): a picture is used only when its real path (symlinks
// resolved) is inside the project's own folder, or inside the Claude
// scratchpad of the current session
// (/private/tmp/claude-<uid>/<cwd key>/<session id>/...). Never Downloads,
// Desktop, the rest of Documents or anything else. Files over 15 MB or older
// than 30 days are skipped. The picture route serves only the current pick
// and the gallery's other pictures, each re-checked on every request; every
// one of the 6 passes the same rule as the pick.
//
// Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = os.homedir();
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
export const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_IN = /\.(?:png|jpe?g|webp|gif)/i;

export const LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 3600 * 1000,
  refreshMs: 60 * 1000,                // one pick per project per minute at most (sooner when the session changes)
  tailBytes: 8 * 1024 * 1024,          // first read back from a transcript's end
  gallery: 6,                          // the pictures kept per project (the newest is the pick)
};

// MC_SCRATCH_ROOT points a test board at fake scratchpads.
export function scratchRoots() {
  const list = process.env.MC_SCRATCH_ROOT ? [process.env.MC_SCRATCH_ROOT] : [`/private/tmp/claude-${UID}`, `/tmp/claude-${UID}`];
  const out = new Set();
  for (const r of list) {
    try { out.add(fs.realpathSync(r)); } catch { /* not there */ }
  }
  return [...out];
}

// Never a picture source, whatever folder a project claims.
const DENY = ['Downloads', 'Desktop', 'Library', '.Trash', 'Pictures', 'Movies', '.ssh'].map((d) => path.join(HOME, d));
// Folders too broad to be a project's own: everything in them would pass.
const TOO_BROAD = new Set(['/', '/Users', '/private', '/tmp', '/private/tmp', HOME, path.join(HOME, 'Documents'), ...DENY]);

export function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// The roots a project's pictures may come from. `folder` is the project's
// folder, `sessionIds` the sessions whose scratchpads count (the current one).
export function rootsFor(folder, sessionIds = [], scratch = scratchRoots()) {
  const f = folder ? real(folder) : null;
  const ok = f && !TOO_BROAD.has(f) && !DENY.some((d) => inside(f, d)) && !inside(HOME, f);
  return { folder: ok ? f : null, sessionIds: new Set(sessionIds), scratch };
}

// The real path of `abs` when it may be shown for these roots, else null.
export function allowedPath(abs, roots) {
  if (!abs || typeof abs !== 'string' || !path.isAbsolute(abs) || !IMAGE.test(abs)) return null;
  const r = real(abs);
  if (!r || !IMAGE.test(r)) return null;
  if (DENY.some((d) => inside(r, d))) return null;
  if (roots.folder && inside(r, roots.folder)) return r;
  for (const t of roots.scratch) {
    if (!inside(r, t)) continue;
    // <scratch root>/<cwd key>/<session id>/... and only the project's own sessions.
    const parts = path.relative(t, r).split(path.sep);
    if (parts.length >= 3 && roots.sessionIds.has(parts[1])) return r;
  }
  return null;
}

// { abs, size, mtimeMs } when the file passes the root guard, the size and
// the age limit; else null.
export function checkFile(abs, roots, now = Date.now(), maxAgeMs = LIMITS.maxAgeMs) {
  const r = allowedPath(abs, roots);
  if (!r) return null;
  let st;
  try { st = fs.statSync(r); } catch { return null; }
  if (!st.isFile() || st.size <= 0 || st.size > LIMITS.maxBytes) return null;
  if (now - st.mtimeMs > maxAgeMs || st.mtimeMs - now > 24 * 3600 * 1000) return null;
  return { abs: r, size: st.size, mtimeMs: st.mtimeMs };
}

// ------------------------------------------------------------ transcripts

function expand(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/^file:\/\//, '');
  if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  if (!path.isAbsolute(s)) { if (!cwd) return null; s = path.join(cwd, s); }
  return path.normalize(s);
}

// Image paths written in a piece of text: quoted (spaces allowed), bare
// absolute or ~/ paths, and markdown links (relative ones against cwd).
export function pathsInText(text, cwd) {
  const out = [];
  if (!text || typeof text !== 'string' || !IMAGE_IN.test(text)) return out;
  let m;
  const quoted = /["'`]((?:~|\/)[^"'`\n]*?\.(?:png|jpe?g|webp|gif))["'`]/gi;
  while ((m = quoted.exec(text))) out.push(expand(m[1]));
  const bare = /(?:^|[\s(=:[,>])((?:~\/|\/|file:\/\/\/)[^\s"'`()<>[\],;|*?$]*\.(?:png|jpe?g|webp|gif))(?![\w/])/gim;
  while ((m = bare.exec(text))) out.push(expand(m[1]));
  const link = /\]\(([^)\s]+\.(?:png|jpe?g|webp|gif))\)/gi;
  while ((m = link.exec(text))) out.push(expand(m[1], cwd));
  return out.filter(Boolean);
}

function textsOf(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text' && c.text) out.push(c.text);
    if (c.type === 'tool_result') out.push(...textsOf(c.content));
  }
  return out;
}

const PATH_KEYS = ['file_path', 'path', 'filename', 'filePath', 'output', 'outputPath'];
const CODE_KEYS = ['command', 'code', 'function'];

// Calls fn(key, text) for each string in a tool call's input (nested a few
// levels deep).
function inputTexts(v, fn, k = '', depth = 0) {
  if (typeof v === 'string') { fn(k, v); return; }
  if (!v || typeof v !== 'object' || depth > 4) return;
  if (Array.isArray(v)) { for (const x of v) inputTexts(x, fn, k, depth + 1); return; }
  for (const [kk, x] of Object.entries(v)) inputTexts(x, fn, kk, depth + 1);
}

// ------------------------------------------------------------ who made it

const RUNNERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'npx', 'bunx', 'deno', 'bun', 'tsx', 'ts-node', 'ruby', 'perl', 'uv', 'pnpm', 'yarn', 'npm']);
const VERBS = new Set(['npm', 'pnpm', 'yarn', 'uv']);
const SKIP_HEAD = new Set(['cd', 'time', 'env', 'exec', 'sudo', 'nice', 'timeout']);
const lastTwo = (t) => t.replace(/^\.\//, '').split('/').filter(Boolean).slice(-2).join('/');

// A shell command as a short name for the caption: the script it runs
// ("tools/shoot.mjs" for "cd x && node tools/shoot.mjs --wave 3"), else its
// first word. A path keeps its last two parts only, never a home folder.
// `target`: the picture, so the part of a chain that names it is the one.
export function commandLabel(cmd, target = null) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const segs = cmd.split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  const base = target ? path.basename(target) : null;
  const notCd = (x) => !/^cd(\s|$)/.test(x);
  const seg = (base && segs.find((x) => x.includes(base) && notCd(x))) || segs.find(notCd) || segs[0];
  if (!seg) return null;
  const toks = seg.split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, '')).filter(Boolean);
  let i = 0;
  while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || SKIP_HEAD.has(toks[i]))) i++;
  if (i >= toks.length) return null;
  const head = path.basename(toks[i]);
  let label = toks[i].includes('/') ? lastTwo(toks[i]) : head;
  if (RUNNERS.has(head)) {
    let j = i + 1;
    // "npm run shoot", "uv run x.py": the verb goes with the name.
    const verb = VERBS.has(head) && toks[j] && /^(run|exec|x)$/.test(toks[j]);
    if (verb) j++;
    while (j < toks.length && toks[j].startsWith('-') && !/^-(e|c)$/.test(toks[j])) j++;
    if (toks[j] && /^-(e|c)$/.test(toks[j])) label = `${head} ${toks[j]}`;
    else if (toks[j] && toks[j].includes('/')) label = lastTwo(toks[j]);
    else if (toks[j]) label = verb || VERBS.has(head) ? `${head} ${toks.slice(i + 1, j + 1).join(' ')}` : toks[j];
  }
  label = label.replace(/["'`]/g, '');
  return label.length > 48 ? label.slice(0, 47) + '…' : label;
}

// Commands that only look at a file, list it or open it: they name a
// picture without making it, so they say nothing about who made it.
const LOOKS = new Set(['ls', 'cat', 'file', 'stat', 'du', 'find', 'open', 'echo', 'head', 'tail', 'wc', 'test', 'identify', 'sips', 'mdls', 'xattr', 'cp', 'mv', 'rm', 'git']);

// The name a tool call goes by in the caption; null when it only looked.
export function callLabel(part, target = null) {
  const name = String((part && part.name) || '');
  const input = (part && part.input) || {};
  if (name === 'Bash') { const l = commandLabel(input.command, target); return l && LOOKS.has(l) ? null : l || 'a shell command'; }
  if (/^(Agent|Task|SubagentHandback|SendMessage)$/.test(name)) return 'a subagent';
  const m = name.match(/^mcp__.+?__(.+)$/);
  if (m) return m[1];
  return name || null;
}

// The image paths one main-session transcript record names, with who named
// them. `shown` marks the two that admit a picture: the session's own Read
// of an image, and a path in its own text to the user. The rest (a path in a
// tool call's input, in a command or script, or printed back in tool output)
// only says who made a picture, for the caption. The user's own prompts are
// left out, and so is a sidechain (subagent) record. `calls` (tool_use id ->
// label) is filled from the calls and read for the results, so a path a
// script printed is made by that script. `made` is false for a Read: the
// session looked at the picture, which says nothing about who made it.
export function mentionsInRecord(rec, calls = null) {
  const out = [];
  if (!rec || rec.isSidechain) return out;
  const cwd = rec.cwd || null;
  const c = rec.message && rec.message.content;
  if (rec.type === 'assistant' && typeof c === 'string') {
    for (const p of pathsInText(c, cwd)) out.push({ p, by: null, made: false, shown: true });
  }
  if (rec.type === 'assistant' && Array.isArray(c)) {
    for (const part of c) {
      // The session's own words to the user (never its thinking).
      if (part && part.type === 'text' && typeof part.text === 'string') {
        for (const p of pathsInText(part.text, cwd)) out.push({ p, by: null, made: false, shown: true });
        continue;
      }
      if (!part || part.type !== 'tool_use' || !part.input || typeof part.input !== 'object') continue;
      const read = part.name === 'Read';
      const found = [];
      for (const k of PATH_KEYS) {
        const v = part.input[k];
        if (typeof v === 'string' && IMAGE.test(v)) { const e = expand(v, cwd); if (e) found.push(e); }
      }
      // Every other text the agent wrote in the call: a command or script,
      // a subagent's brief. Caption only.
      inputTexts(part.input, (k, v) => { if (!PATH_KEYS.includes(k)) found.push(...pathsInText(v, CODE_KEYS.includes(k) ? null : cwd)); });
      for (const p of found) out.push({ p, by: callLabel(part, p), made: !read, shown: read && expand(part.input.file_path, cwd) === p });
      if (calls && part.id) {
        calls.set(part.id, callLabel(part));
        if (calls.size > 2000) calls.delete(calls.keys().next().value);
      }
    }
  }
  if (rec.type === 'user' && Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
    for (const x of c) {
      if (!x || x.type !== 'tool_result') continue;
      const by = (calls && x.tool_use_id && calls.get(x.tool_use_id)) || null;
      for (const t of textsOf(x.content)) for (const p of pathsInText(t, cwd)) out.push({ p, by, made: true, shown: false });
    }
  }
  return out;
}

// The image paths one record shows the user (the ones that admit a picture).
export function pathsInRecord(rec) {
  return mentionsInRecord(rec).filter((m) => m.shown).map((m) => m.p);
}

const tcache = new Map(); // transcript path -> { offset, cands: Map<abs, { at, by, made, shown }>, calls }
const KEEP = 400;

// Who made a picture: the first call that made it wins; a Read only stands
// in while nothing has made it. A mention with no known call says nothing.
function merge(was, m) {
  const cand = { by: m.by || null, made: !!(m.made && m.by) };
  if (!was) return cand;
  if (was.made) return { by: was.by, made: true };
  if (cand.made || !was.by) return cand.by ? cand : { by: was.by, made: was.made };
  return { by: was.by, made: false };
}

// The newest mention moves the path to the end. Once shown, a path stays
// shown. Over the cap, the oldest path that was never shown goes first.
function remember(entry, m, at) {
  const was = entry.cands.get(m.p);
  entry.cands.delete(m.p);
  entry.cands.set(m.p, { at, ...merge(was, m), shown: !!((was && was.shown) || m.shown) });
  if (entry.cands.size > KEEP) {
    let drop = null;
    for (const [k, v] of entry.cands) if (!v.shown) { drop = k; break; }
    entry.cands.delete(drop != null ? drop : entry.cands.keys().next().value);
  }
}

// Image paths a transcript names (a Map in mention order, newest mention
// last, each with { at, by, made, shown }). Reads the tail once, then only
// the bytes added since.
export function transcriptMentions(file) {
  let st;
  try { st = fs.statSync(file); } catch { return new Map(); }
  let e = tcache.get(file);
  if (!e || st.size < e.offset) { e = { offset: Math.max(0, st.size - LIMITS.tailBytes), fresh: true, cands: new Map(), calls: new Map() }; tcache.set(file, e); }
  if (st.size > e.offset) {
    let start = e.offset;
    if (st.size - start > LIMITS.tailBytes) { start = st.size - LIMITS.tailBytes; e.fresh = true; }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const last = buf.lastIndexOf(0x0a);
      if (last >= 0) {
        let from = 0;
        // A read that starts mid-file drops its first, partial line.
        if (e.fresh && start > 0) from = buf.indexOf(0x0a) + 1;
        const text = buf.toString('utf8', from, last);
        for (const line of text.split('\n')) {
          if (!line) continue;
          const named = IMAGE_IN.test(line);
          // A call that names no image is still remembered by id when it
          // could print one (its result is matched to it by that id).
          if (!named && !line.includes('"tool_use"')) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          const at = Date.parse(rec.timestamp) || 0;
          for (const m of mentionsInRecord(rec, e.calls)) remember(e, m, at);
        }
        e.offset = start + last + 1;
        e.fresh = false;
      }
    } catch { /* unreadable this time */ } finally { if (fd != null) fs.closeSync(fd); }
  }
  return e.cands;
}

// Image paths a transcript showed the user (the ones that can be a picture),
// newest mention last.
export function transcriptImages(file) {
  return [...transcriptMentions(file)].filter(([, m]) => m.shown).map(([p]) => p);
}

// ------------------------------------------------------------ pixel size

const sizes = new Map(); // `${abs}|${mtimeMs}` -> { w, h } or null

// Width and height from the file's own header (PNG, GIF, JPEG, WebP), read
// once per file version; null when the header says nothing readable.
export function imageSize(abs, mtimeMs = 0) {
  const k = `${abs}|${mtimeMs}`;
  if (sizes.has(k)) return sizes.get(k);
  let out = null;
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    out = headerSize(buf.subarray(0, n));
  } catch { out = null; } finally { if (fd != null) fs.closeSync(fd); }
  sizes.set(k, out);
  if (sizes.size > 500) sizes.delete(sizes.keys().next().value);
  return out;
}

export function headerSize(b) {
  const ok = (w, h) => (w > 0 && h > 0 ? { w, h } : null);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return ok((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1); }
    if (kind === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; }
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      i += 2 + len;
    }
  }
  return null;
}

// ------------------------------------------------------------ the pick

// The allowed images these transcripts showed the user, newest file first, at
// most `n`. Only a shown mention admits a picture; any mention of an
// admitted one (a tool call that wrote it, a script that printed it) can
// still say who made it.
export function listFromTranscripts(files, roots, now = Date.now(), n = LIMITS.gallery) {
  const byReal = new Map(); // real path -> picture
  const realOf = new Map(); // mentioned path -> real path, or null when refused
  const fold = (x, m) => { const g = merge({ by: x.by, made: x.made }, m); x.by = g.by; x.made = g.made; };
  const all = files.map((f) => [f, transcriptMentions(f)]);
  for (const [f, mentions] of all) {
    for (const [p, m] of mentions) {
      if (!m.shown) continue;
      if (realOf.has(p)) {
        const r = realOf.get(p);
        if (r) fold(byReal.get(r), m);
        continue;
      }
      const c = checkFile(p, roots, now);
      realOf.set(p, c ? c.abs : null);
      if (!c) continue;
      const was = byReal.get(c.abs);
      if (was) { fold(was, m); continue; }
      byReal.set(c.abs, { ...c, from: 'session', transcript: f, by: m.by || null, made: !!(m.made && m.by) });
    }
  }
  // Who made each admitted picture, from the mentions that did not admit it.
  for (const [, mentions] of all) {
    for (const [p, m] of mentions) {
      if (m.shown) continue;
      let r = realOf.get(p);
      if (r === undefined) { r = real(p); realOf.set(p, r && byReal.has(r) ? r : null); r = realOf.get(p); }
      if (r) fold(byReal.get(r), m);
    }
  }
  return [...byReal.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n);
}

// The newest allowed image among these transcripts' mentions.
export function pickFromTranscripts(files, roots, now = Date.now()) {
  return listFromTranscripts(files, roots, now, 1)[0] || null;
}

// The transcripts a session's pictures come from: its main transcript only.
// Its subagents' transcripts (<session id>/subagents/*.jsonl) are never
// read: what a subagent shot for itself was not shown to the user.
export function sessionTranscripts(session) {
  if (!session || !session.sessionId || !session.path) return [];
  return [session.path];
}

const picks = new Map(); // project id -> { at, sessionId, pick, list, roots, ms, transcripts }

// A picture's key in the route: a hash of its real path, so two pictures
// with the same file name in different folders stay apart.
const keyOf = (abs) => crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);

function urlFor(id, pic) {
  return `/api/pic/${encodeURIComponent(id)}?auto=${encodeURIComponent(path.basename(pic.abs))}&k=${pic.key}&v=${Math.round(pic.mtimeMs)}`;
}

// The path the caption shows: relative to the project's folder, or to the
// session's own scratchpad folder (<scratch root>/<cwd key>/<session id>/).
function relFor(abs, roots) {
  if (roots.folder && inside(abs, roots.folder)) return path.relative(roots.folder, abs);
  for (const t of roots.scratch) {
    if (!inside(abs, t)) continue;
    const parts = path.relative(t, abs).split(path.sep);
    if (parts.length >= 3) return parts.slice(2).join('/');
  }
  return path.basename(abs);
}

const sidOf = (session) => (session && session.sessionId) || null;

// True when the project's pick should be worked out again: never worked out,
// a minute old, or the current session is not the one it was worked out for.
export function due(id, session, now = Date.now()) {
  const c = picks.get(id);
  return !c || c.sessionId !== sidOf(session) || now - c.at >= LIMITS.refreshMs;
}

// Works out a project's pictures now, from what its current session's main
// transcript showed the user: the last 6 (oldest first) and the pick, the
// newest of them.
// `session`: { sessionId, path } (path = its transcript), or null when the
// project has no current session (then no picture).
export function refresh(project, session, now = Date.now()) {
  const t0 = performance.now();
  const sid = sidOf(session);
  const roots = rootsFor(project.folder, sid ? [sid] : []);
  const files = sid ? sessionTranscripts(session) : [];
  const newest = files.length ? listFromTranscripts(files, roots, now) : [];
  const list = newest.slice().reverse();
  for (const pic of list) {
    pic.key = keyOf(pic.abs);
    pic.name = path.basename(pic.abs);
    pic.alt = `Latest picture: ${pic.name}`;
    pic.url = urlFor(project.id, pic);
    pic.rel = relFor(pic.abs, roots);
    const d = imageSize(pic.abs, pic.mtimeMs);
    pic.w = d ? d.w : null;
    pic.h = d ? d.h : null;
  }
  const pick = list.length ? list[list.length - 1] : null;
  const entry = { at: now, sessionId: sid, pick, list, roots, ms: performance.now() - t0, transcripts: files.length };
  picks.set(project.id, entry);
  return entry;
}

// The cached pick (no disk work), or null. A pick worked out for a session
// that is no longer the project's current one is dropped here, so a hand-off
// never shows the old session's picture, even before the next refresh.
export function current(id, session) {
  const c = picks.get(id);
  if (!c) return null;
  if (c.sessionId !== sidOf(session)) { picks.delete(id); return null; }
  return c.pick;
}

// The cached last 6, oldest first (no disk work); [] for none, or when the
// current session is not the one they were worked out for.
export function gallery(id, session) {
  const c = picks.get(id);
  if (!c) return [];
  if (c.sessionId !== sidOf(session)) { picks.delete(id); return []; }
  return c.list || [];
}

// The pictures as the page gets them: what the caption shows, never the
// roots. `short` turns the real path into the board's short form (~/...).
export function galleryJson(list, short = (p) => p) {
  return list.map((g) => ({ key: g.key, name: g.name, url: g.url, at: new Date(g.mtimeMs).toISOString(), by: g.by || null, made: !!g.made, w: g.w, h: g.h, rel: g.rel, path: short(g.abs) }));
}

// One of the project's current pictures, re-checked now: its real path, or
// null. `key` names one of the 6; with no key, only the pick (the card's
// picture, as before the gallery) answers to its file name.
function served(id, name, key, now) {
  const c = picks.get(id);
  if (!c || !c.pick) return null;
  let pic = null;
  if (key) pic = (c.list || []).find((x) => x.key === key) || null;
  else pic = c.pick;
  if (!pic || (name != null && name !== path.basename(pic.abs))) return null;
  const f = checkFile(pic.abs, c.roots, now);
  return f ? f.abs : null;
}

// The file to serve for /api/pic/<id>?auto=<name>[&k=<key>]: only one of
// the current 6 (the pick without a key), and only while it still passes
// every check.
export function serveable(id, name, key = null, now = Date.now()) {
  if (typeof name !== 'string') return null;
  return served(id, name, key || null, now);
}

// The file Show in Finder may reveal: only one of the current 6, by key,
// re-checked now; never a path from the page.
export function revealable(id, key, now = Date.now()) {
  if (typeof key !== 'string' || !/^[0-9a-f]{12}$/.test(key)) return null;
  return served(id, null, key, now);
}

export function forget(id) { picks.delete(id); }
