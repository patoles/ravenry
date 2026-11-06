// Repeats: the corrections the user types again and again, across sessions.
// They feed the Rules view's Suggested tab (docs/design/Repeats.dc.html).
//
// Plain code reads the user's own typed messages from the transcripts of the
// projects in config.ruleSources (Claude Code's, and Codex's rollouts whose
// session worked in one of their folders), a few new bytes at a time (a
// per-file offset, size and inode), and keeps every kept message verbatim
// under <RAVENRY_HOME>/repeats/, because Claude Code deletes transcripts
// after 30 days. A Codex message is stored with assistant: 'codex'; one with
// none is Claude Code's. Accepting a suggestion writes to the rules file of
// each assistant whose sessions said it: CLAUDE.md for Claude Code's,
// AGENTS.md for Codex's (docs/ASSISTANTS.md, "Rules").
// A model call (claude -p, or codex exec when new sessions start with Codex:
// the Ideas thread's print mode) sorts each new
// message into a cluster, a new cluster, or "not a correction", and, when a
// cluster first reaches two sessions, drafts its rule line, matches it to an
// existing rule line and drafts the reword. Everything else is plain code:
// counts, dates, dedupe, the "was the rule in that session's scope" test,
// and quotes, which are always cut from the stored text, never taken from
// model output.
//
// Files in <RAVENRY_HOME>/repeats/:
//   state.json       offsets per transcript, the seed record, session names
//   messages.jsonl   every kept message, verbatim, appended once
//   verdicts.jsonl   one verdict per message (the last line for a key wins)
//   clusters.json    the clusters: rule, line to write, match, quote
//   runs.jsonl       one line per run: messages, calls, tokens, changes

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { RAVENRY_HOME } from './registry.mjs';
import * as registry from './registry.mjs';
import { claudeProjectDir } from './config.mjs';
import * as rules from './rules.mjs';
import * as asst from './assistant.mjs';

const HOME = os.homedir();
// The seed: clusters a first start begins from. None ships: a new board
// starts empty and its daily runs find the user's own. The first board was
// seeded from the approved mockup's data pass (tools/fixtures/repeats-seed.json,
// set with MC_REPEATS_SEED).
const SEED_PATH = process.env.MC_REPEATS_SEED || null;
const EMPTY_SEED = { cutoff: null, clusters: [] };
export const DIR = path.join(RAVENRY_HOME, 'repeats');
const F = {
  state: path.join(DIR, 'state.json'),
  messages: path.join(DIR, 'messages.jsonl'),
  verdicts: path.join(DIR, 'verdicts.jsonl'),
  clusters: path.join(DIR, 'clusters.json'),
  runs: path.join(DIR, 'runs.jsonl'),
};
const DAY = 86400e3;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Bounds on model use per run.
const BATCH_MESSAGES = 120;
const BATCH_CHARS = 60000;
const MAX_CLASSIFY_CALLS = 3;
const MAX_DRAFTS = 10;
const MSG_CHARS = 1200;

export const short = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const dayWord = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MON[d.getMonth()]}`; };

// ------------------------------------------------------------ the prefilter

const PASTE = /<pasted_content[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g;
const SYSR = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TAGS = /<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)[^>]*>[\s\S]*?<\/\1>/g;

// The text the user typed in one transcript record, or null for anything else:
// sidechains (subagents), meta records, tool results, task notifications,
// compact summaries, pasted content, system reminders, harness lines and the
// board's own hand-off prompts.
export function typedText(d) {
  if (!d || d.type !== 'user') return null;
  if (d.isSidechain || d.isMeta) return null;
  if (d.toolUseResult != null || d.sourceToolAssistantUUID) return null;
  if (d.isCompactSummary || d.isVisibleInTranscriptOnly) return null;
  const o = d.origin;
  if (o && o.kind != null && o.kind !== 'human') return null;
  const c = d.message && d.message.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  } else return null;
  return cleanTyped(text);
}

// What both assistants' typed text goes through: pastes, reminders and
// harness tags out; the board's hand-off prompts and harness lines dropped.
function cleanTyped(raw) {
  const text = String(raw).replace(PASTE, '[pasted]').replace(SYSR, '').replace(TAGS, '').trim();
  if (!text) return null;
  if (/^\[(ravenry|mission-control) hand-off\]/.test(text) || /^\[Request interrupted/.test(text) || /^Caveat:/.test(text) || /^This session is being continued/.test(text)) return null;
  if (/^<[a-z-]+>/.test(text)) return null;
  return text;
}

// The text the user typed in one Codex rollout record (server/
// codexrollout.mjs has the format), or null: a user message that is not
// Codex's own (<environment_context>, a Stop hook's <hook_prompt>,
// <turn_aborted>) nor another agent's ("<task>", which Claude Code's Codex
// plugin sends). Codex's VS Code extension puts the editor's context first
// ("# Context from my IDE setup:", open tabs, the active file) and the
// request after "## My request for Codex:"; only the request is kept.
const IDE_HEAD = /^\s*# Context from my IDE setup:/;
const IDE_ASK = '## My request for Codex:';
export function codexTypedText(d) {
  if (!d || d.type !== 'response_item') return null;
  const p = d.payload || {};
  if (p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return null;
  let text = p.content.filter((b) => b && b.type === 'input_text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (/^\s*</.test(text)) return null;
  if (IDE_HEAD.test(text)) {
    const i = text.indexOf(IDE_ASK);
    if (i < 0) return null;
    text = text.slice(i + IDE_ASK.length);
  }
  return cleanTyped(text);
}

// A rollout's first record (session_meta): its session id and folder, and
// why it is not the user's own typing, when it is not: a session another
// program drove (Claude Code's Codex plugin is its originator; codex exec,
// Codex as an MCP server, a subagent). null while the line is not written.
export function codexMeta(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const CH = 256 * 1024;
    const buf = Buffer.allocUnsafe(CH);
    let head = Buffer.alloc(0);
    let pos = 0;
    let nl = -1;
    while (nl < 0 && head.length < 8 * CH) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (n <= 0) break;
      pos += n;
      head = Buffer.concat([head, buf.subarray(0, n)]);
      nl = head.indexOf(10);
    }
    if (nl < 0) return null;
    let d;
    try { d = JSON.parse(head.subarray(0, nl).toString('utf8')); } catch { return { session: null, cwd: null, skip: 'unreadable' }; }
    const p = (d && d.payload) || {};
    if (d.type !== 'session_meta' || !p.id) return { session: null, cwd: null, skip: 'no session_meta' };
    const src = p.source;
    const skip = /claude/i.test(String(p.originator || '')) ? 'started by Claude Code'
      : src != null && typeof src !== 'string' ? 'a subagent'
        : ['exec', 'mcp'].includes(src) || p.originator === 'codex_exec' ? `codex ${src || 'exec'}` : null;
    return { session: p.id, cwd: p.cwd || null, skip };
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------ incremental reads

const USER = Buffer.from('"type":"user"');
const CODEX_USER = Buffer.from('"role":"user"');

// Claude Code's transcript line as a message, or null.
const claudeLine = (d) => {
  const text = typedText(d);
  return text ? { uuid: d.uuid || null, session: d.sessionId, ts: d.timestamp, src: d.promptSource || null, text } : null;
};
// A Codex rollout's line, for the session its session_meta names.
const codexLine = (session) => (d) => {
  const text = codexTypedText(d);
  return text ? { uuid: null, session, ts: d.timestamp, src: null, text } : null;
};

// Reads one transcript from where the last read stopped to its last complete
// line. A new inode, or a file now shorter than what was read, means it was
// replaced or truncated: read it again from 0 (stored keys keep that from
// counting anything twice). Calls onText for each typed message. `marker`
// and `read` say which lines are worth parsing and how one becomes a
// message: Claude Code's transcript by default, a Codex rollout with
// { marker: CODEX_USER, read: codexLine(session) }.
export async function scanFile(file, prev, onText, { marker = USER, read = claudeLine } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const same = prev && prev.ino === st.ino && st.size >= prev.offset && st.size >= (prev.size || 0);
  const start = same ? prev.offset : 0;
  const reset = !!(prev && !same);
  if (st.size <= start) return { next: { offset: start, size: st.size, ino: st.ino }, reset, bytes: 0 };
  const fd = fs.openSync(file, 'r');
  const CH = 8 << 20;
  const buf = Buffer.allocUnsafe(CH);
  let pos = start;
  let carry = null;
  let consumed = start;
  try {
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      let nl;
      while ((nl = data.indexOf(10, from)) !== -1) {
        const line = data.subarray(from, nl);
        if (line.indexOf(marker) !== -1) {
          let d = null;
          try { d = JSON.parse(line.toString('utf8')); } catch { /* a torn or foreign line */ }
          const x = d && read(d);
          if (x) onText(x);
        }
        from = nl + 1;
      }
      consumed = pos - (data.length - from);
      carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { next: { offset: consumed, size: st.size, ino: st.ino }, reset, bytes: consumed - start };
}

export function sources(cfg) {
  return (cfg.ruleSources || [])
    .map((s) => ({ ...s, transcripts: s.transcripts || (s.folder ? claudeProjectDir(s.folder) : null) }))
    .filter((s) => s.transcripts);
}

const keyOf = (m) => m.uuid || `${m.session}|${m.ts}`;

// Codex's rollouts: <codexSessions>/YYYY/MM/DD/rollout-*.jsonl.
export function rolloutFiles(root) {
  if (!root) return [];
  const out = [];
  const list = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  for (const y of list(root)) for (const mo of list(path.join(root, y))) for (const d of list(path.join(root, y, mo))) {
    for (const f of list(path.join(root, y, mo, d))) if (/^rollout-.*\.jsonl$/.test(f)) out.push(path.join(root, y, mo, d, f));
  }
  return out;
}

// The source a Codex session belongs to, by the folder it worked in: the
// source with that folder, else the deepest one holding it (a session in a
// project's subfolder still reads that project's AGENTS.md), except the
// projects root, which takes only sessions started in it, as Claude Code's
// transcripts of it hold only those.
export function sourceFor(cfg, cwd) {
  if (!cwd) return null;
  let best = null;
  for (const s of cfg.ruleSources || []) {
    if (!s || !s.folder) continue;
    if (cwd === s.folder) return s;
    if (s.folder === cfg.projectsRoot) continue;
    if (cwd.startsWith(s.folder + path.sep) && (!best || s.folder.length > best.folder.length)) best = s;
  }
  return best;
}

// ------------------------------------------------------------ the store

let mem = null;

function readJson(file, d) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return d; } }
function readLines(file) {
  let s = '';
  try { s = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of s.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
  return out;
}
function writeJson(file, obj) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, file);
}
function appendLines(file, list) {
  if (!list.length) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(file, list.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

export function load() {
  if (mem) return mem;
  const state = readJson(F.state, null) || { version: 1, offsets: {}, names: {}, tries: {}, seeded: null, lastRun: null };
  state.offsets = state.offsets || {};
  state.codex = state.codex || {};
  state.names = state.names || {};
  state.tries = state.tries || {};
  const messages = new Map();
  for (const m of readLines(F.messages)) messages.set(m.key, m);
  const verdicts = new Map();
  for (const v of readLines(F.verdicts)) verdicts.set(v.key, v);
  const clusters = (readJson(F.clusters, null) || {}).clusters || {};
  mem = { state, messages, verdicts, clusters };
  return mem;
}

// Tests and the run tool point RAVENRY_HOME at a scratch folder; this drops the
// in-memory copy so the next load reads the files again.
export function reset() { mem = null; viewCache = null; }

function saveState() { writeJson(F.state, load().state); }
function saveClusters() { writeJson(F.clusters, { version: 1, clusters: load().clusters }); viewCache = null; }
function addVerdicts(list) {
  const m = load();
  for (const v of list) m.verdicts.set(v.key, v);
  appendLines(F.verdicts, list);
  viewCache = null;
}

// Reads every source's transcripts from their offsets and stores the new
// typed messages. Returns them.
export async function ingest(cfg) {
  const m = load();
  const fresh = [];
  let bytes = 0;
  let files = 0;
  const resets = [];
  for (const src of sources(cfg)) {
    let names = [];
    try { names = fs.readdirSync(src.transcripts).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of names.sort()) {
      const file = path.join(src.transcripts, f);
      const got = [];
      const r = await scanFile(file, m.state.offsets[file], (x) => got.push(x));
      if (!r) continue;
      files++;
      bytes += r.bytes;
      if (r.reset) resets.push(file);
      const add = [];
      for (const x of got) {
        if (!x.session || !x.ts) continue;
        const rec = { key: keyOf(x), session: x.session, ts: x.ts, project: src.label, folder: src.folder || null, dir: src.transcripts, src: x.src, text: x.text };
        if (m.messages.has(rec.key)) continue;
        m.messages.set(rec.key, rec);
        add.push(rec);
      }
      // Messages first, then the offset: a crash in between only re-reads.
      appendLines(F.messages, add);
      fresh.push(...add);
      m.state.offsets[file] = r.next;
    }
  }
  // Codex keeps every project's rollouts in one folder: each goes to the
  // source its session worked in, read the same way, its messages marked
  // assistant: 'codex'. A rollout no source takes is looked at again next
  // run (its project may be on the board by then).
  for (const file of rolloutFiles(cfg.codexSessions)) {
    let meta = m.state.codex[file];
    if (!meta) {
      meta = codexMeta(file);
      if (!meta) continue;
      m.state.codex[file] = meta;
    }
    if (meta.skip || !meta.session) continue;
    const src = sourceFor(cfg, meta.cwd);
    if (!src) continue;
    const got = [];
    const r = await scanFile(file, m.state.offsets[file], (x) => got.push(x), { marker: CODEX_USER, read: codexLine(meta.session) });
    if (!r) continue;
    files++;
    bytes += r.bytes;
    if (r.reset) resets.push(file);
    const add = [];
    for (const x of got) {
      if (!x.ts) continue;
      const rec = { key: keyOf(x), session: x.session, ts: x.ts, project: src.label, folder: src.folder || null, dir: null, src: null, text: x.text, assistant: 'codex' };
      if (m.messages.has(rec.key)) continue;
      m.messages.set(rec.key, rec);
      add.push(rec);
    }
    appendLines(F.messages, add);
    fresh.push(...add);
    m.state.offsets[file] = r.next;
  }
  saveState();
  viewCache = null;
  return { fresh, bytes, files, resets };
}

// ------------------------------------------------------------ rule lines

// A CLAUDE.md rule line is a "- " bullet plus the indented lines that
// continue it. start and end are character offsets of its exact text.
export function parseBlocks(md) {
  const lines = String(md || '').split('\n');
  const off = [];
  let o = 0;
  for (const l of lines) { off.push(o); o += l.length + 1; }
  const out = [];
  let heading = null;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (/^##\s+/.test(l)) { heading = l.replace(/^##\s+/, '').trim(); continue; }
    if (!l.startsWith('- ')) continue;
    let j = k + 1;
    while (j < lines.length && /^ {2,}\S/.test(lines[j])) j++;
    const start = off[k];
    const end = off[j - 1] + lines[j - 1].length;
    const text = lines.slice(k, j).map((x, i) => (i ? x.trim() : x.slice(2).trim())).join(' ');
    out.push({ heading, start, end, raw: String(md).slice(start, end), text });
    k = j - 1;
  }
  return out;
}

// The memory-name citation at the end of a rule, "(a-name, other-name)".
// The board hides it when showing a rule; a written line always keeps it.
const CITE = /\s*\(([^()]*)\)\s*$/;
export function splitCite(text) {
  const t = String(text || '').trim();
  const m = t.match(CITE);
  if (m && /[a-z0-9]+-[a-z0-9-]+/.test(m[1]) && !/[A-Z]{2}|\?/.test(m[1])) return { body: t.slice(0, m.index).trim(), cite: m[1].trim() };
  return { body: t, cite: '' };
}
const citeNames = (cite) => String(cite || '').split(/[,;\s]+/).map((w) => w.replace(/\.md$/, '')).filter((w) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(w) && !/^\d{4}-\d{2}-\d{2}$/.test(w));

// The line to write: the new text without any citation of its own, then the
// old citation as it was, with every new name merged in after it.
export function mergeCite(newText, oldCite, extra = []) {
  const n = splitCite(String(newText || '').replace(/^-\s+/, ''));
  const have = new Set(citeNames(oldCite));
  const add = [];
  for (const w of [...citeNames(n.cite), ...extra]) if (w && !have.has(w)) { have.add(w); add.push(w); }
  const cite = [String(oldCite || '').trim(), ...add].filter(Boolean).join(', ');
  return cite ? `${n.body} (${cite})` : n.body;
}

// Wraps a rule the way the global CLAUDE.md is written: 80 columns, two-space
// continuation.
export function wrapRule(text, width = 80) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '- ';
  for (const w of words) {
    const lead = lines.length ? '  ' : '- ';
    if (cur.length > lead.length && cur.length + 1 + w.length > width) { lines.push(cur); cur = '  ' + w; }
    else cur += (cur.length > lead.length ? ' ' : '') + w;
  }
  lines.push(cur);
  return lines.join('\n');
}

function readMd(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

function memoryDescription(file) {
  const fm = rules.frontmatter(readMd(file));
  return fm.description || null;
}

// The global CLAUDE.md as the Your rules tab shows it.
export function mine(cfg) {
  const groups = [];
  for (const b of parseBlocks(readMd(cfg.globalClaudeMd))) {
    if (!b.heading) continue;
    let g = groups[groups.length - 1];
    if (!g || g.heading !== b.heading) { g = { heading: b.heading, rules: [] }; groups.push(g); }
    g.rules.push(rules.plainRule(splitCite(b.text).body));
  }
  return { path: short(cfg.globalClaudeMd), groups, count: groups.reduce((n, g) => n + g.rules.length, 0) };
}

// ------------------------------------------------------------ counting

// One message re-sent with an addition (same session, one text a prefix of
// the other) counts once; so does the same text sent twice.
export function dedupe(msgs) {
  const out = [];
  const seen = new Map();
  for (const m of [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    const n = norm(m.text).toLowerCase();
    const list = seen.get(m.session) || [];
    const dup = list.find((p) => p.n === n || (Math.min(p.n.length, n.length) >= 12 && (n.startsWith(p.n) || p.n.startsWith(n))));
    if (dup) { if (n.length > dup.n.length) dup.n = n; continue; }
    list.push({ n });
    seen.set(m.session, list);
    out.push(m);
  }
  return out;
}

function clusterMessages() {
  const m = load();
  const by = new Map();
  for (const v of m.verdicts.values()) {
    if (v.v !== 'cluster') continue;
    const msg = m.messages.get(v.key);
    if (!msg) continue;
    // One message can repeat two things at once.
    for (const id of new Set(v.clusters || [v.cluster])) {
      if (!id) continue;
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(msg);
    }
  }
  return by;
}

// When a rule became visible to sessions: a memory note from its file times
// (the earlier of birth and modification, so a copy made with cp -p keeps its
// age), a CLAUDE.md line from when the board first saw it.
function since(match, state) {
  if (!match) return null;
  if (match.source === 'memory') {
    try { const st = fs.statSync(match.file); return new Date(Math.min(st.birthtimeMs || Infinity, st.mtimeMs)).toISOString(); } catch { return null; }
  }
  return (state.lineSeen || {})[match.text] || match.seenAt || null;
}

// Was the rule in that session's scope? A global line reaches every
// session; a project CLAUDE.md reaches sessions in its folder or below; a
// memory note reaches only sessions of the project whose folder holds it.
// The scope is the same for both assistants: a Codex session in a project
// is in that project's scope (its own rules file there is AGENTS.md, which
// the write below covers), and a memory note's project is its folder.
export function inScope(match, msg) {
  if (!match) return false;
  if (match.source === 'global') return true;
  if (match.source === 'project') {
    const f = match.folder || path.dirname(match.file);
    return !!msg.folder && (msg.folder === f || msg.folder.startsWith(f + path.sep));
  }
  if (match.source === 'memory') return msg.assistant === 'codex' ? !!match.folder && msg.folder === match.folder : !!match.dir && msg.dir === match.dir;
  return false;
}

// ------------------------------------------------------------ where a rule is written

const KINDS = ['claude', 'codex'];
const RULES_NAME = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
export const assistantOf = (msg) => (msg && msg.assistant === 'codex' ? 'codex' : 'claude');
// The assistants whose sessions said it, Claude Code first.
export function assistantsOf(kept) {
  const have = new Set(kept.map(assistantOf));
  return KINDS.filter((k) => have.has(k));
}
// A matched line's assistant: an AGENTS.md line is Codex's, a CLAUDE.md
// line or a memory note Claude Code's.
const matchAssistant = (match) => (match && match.assistant === 'codex' ? 'codex' : 'claude');

// Codex reads AGENTS.override.md instead of AGENTS.md in a folder that has
// one (its own resolution, globally and per folder), so a rule goes there.
// An empty one is passed over, as Codex and Your rules pass it over
// (server/rulefiles.mjs): writing to it would hide the AGENTS.md beside it.
export function agentsTarget(file) {
  if (!file || path.basename(file) !== 'AGENTS.md') return file || null;
  const o = path.join(path.dirname(file), 'AGENTS.override.md');
  let md = null;
  try { md = fs.readFileSync(o, 'utf8'); } catch {}
  return md != null && md.trim() ? o : file;
}

function globalFile(cfg, a) {
  return a === 'codex' ? agentsTarget(cfg.globalAgentsMd || null) : cfg.globalClaudeMd;
}

function projectFile(cfg, a, folder) {
  if (!folder) return null;
  const src = (cfg.ruleSources || []).find((x) => x && x.folder === folder) || {};
  return a === 'codex' ? agentsTarget(src.agentsMd || path.join(folder, 'AGENTS.md')) : src.claudeMd || path.join(folder, 'CLAUDE.md');
}

// What accepting a row writes, one entry per assistant whose sessions said
// it, in the same scope: a Reword replaces the matched line in its own
// file (and the same line in the other assistant's file of that scope,
// when it was copied there) and adds the reworded line to the other's; a
// memory reword adds it to the project's CLAUDE.md and AGENTS.md; Add rule
// and Add to every project add it to the global CLAUDE.md and AGENTS.md.
// A cluster only Claude Code's sessions said writes exactly what it wrote
// before there were two assistants.
export function opsFor(c, kind, kept, cfg) {
  const ops = [];
  const ma = c.match ? matchAssistant(c.match) : null;
  for (const a of assistantsOf(kept)) {
    if (kind === 'reword' && c.match.source !== 'memory') {
      if (a === ma) { ops.push({ assistant: a, op: 'replace', file: c.match.file, scope: c.match.source }); continue; }
      const folder = c.match.source === 'project' ? c.match.folder || path.dirname(c.match.file) : null;
      const file = c.match.source === 'global' ? globalFile(cfg, a) : projectFile(cfg, a, folder);
      const same = !!file && parseBlocks(readMd(file)).some((b) => b.raw === c.match.text);
      ops.push({ assistant: a, op: same ? 'replace' : 'append', file, scope: c.match.source, folder, label: c.match.label });
    } else if (kind === 'reword') {
      ops.push({ assistant: a, op: 'append', file: a === 'claude' ? c.match.claudeMd || null : projectFile(cfg, a, c.match.folder), scope: 'project', folder: c.match.folder || null, label: c.match.label });
    } else {
      ops.push({ assistant: a, op: 'append', file: globalFile(cfg, a), scope: 'global' });
    }
  }
  return ops;
}

// The row's "Rewords this line in ..." sentence, in parts: { text } and
// { file } (the page shows a file in mono). lead, file and after are the
// same sentence for one file, as the page read it before.
function previewOf(c, kind, ops) {
  const rep = ops.filter((o) => o.op === 'replace');
  const app = ops.filter((o) => o.op === 'append');
  const name = (o) => (o.file ? short(o.file) : RULES_NAME[o.assistant]);
  const parts = [];
  const files = (list) => list.forEach((o, k) => { if (k) parts.push({ text: ' and ' }); parts.push({ file: name(o) }); });
  if (rep.length) {
    parts.push({ text: 'Rewords this line in ' });
    files(rep);
    if (app.length) { parts.push({ text: ' and adds it to ' }); files(app); }
  } else {
    parts.push({ text: kind === 'reword' ? 'Adds the reworded line to ' : 'Adds this line to ' });
    files(app);
  }
  let tail = '.';
  if (kind === 'reword' && c.match.source === 'memory') tail += ` ${c.match.label} memory stays as it is.`;
  tail += ops.length > 1 ? ' A backup of each is made first.' : ' A backup is made first.';
  parts.push({ text: tail });
  const preview = { lead: parts[0].text.trim(), file: parts[1] ? parts[1].file : '', after: parts.slice(2).map((x) => x.text || x.file).join(''), parts };
  if (kind === 'reword' && c.match.source !== 'memory') {
    const own = rep.some((o) => o.assistant === matchAssistant(c.match));
    const line = rules.plainRule(splitCite(norm(c.match.text.replace(/^-\s+/, ''))).body);
    Object.assign(preview, { nowLabel: 'Now', now: own ? line : `${RULES_NAME[matchAssistant(c.match)]}: ${line}`, nextLabel: 'Reworded' });
  } else if (kind === 'reword') {
    Object.assign(preview, { nowLabel: 'Now', now: `${c.match.label} memory: ${rules.plainRule(c.match.text)}`, nextLabel: 'Reworded' });
  } else {
    preview.nextLabel = 'Adds';
  }
  return preview;
}

const SESSIONS_OF = { claude: 'Claude Code', codex: 'Codex' };
// "3 Claude Code sessions", "2 Codex sessions", "4 sessions (Claude Code and Codex)".
export function sessionsText(n, who) {
  return who.length === 1 ? `${n} ${SESSIONS_OF[who[0]]} sessions` : `${n} sessions (${who.map((k) => SESSIONS_OF[k]).join(' and ')})`;
}

// Reword when the rule could already be seen everywhere the user repeated it
// after it existed; Add to every project when it lives in one project's
// memory or CLAUDE.md and they said it somewhere it does not reach; Add rule
// when nothing covers it.
export function kindOf(c, kept, state = load().state) {
  if (!c.match) return 'add';
  if (c.match.source === 'global') return 'reword';
  const t = since(c.match, state);
  const after = kept.filter((m) => !t || m.ts >= t);
  return after.some((m) => !inScope(c.match, m)) ? 'every' : 'reword';
}

const LABEL = { reword: 'Reword rule', every: 'Add to every project', add: 'Add rule' };

// ------------------------------------------------------------ the view

let viewCache = null;

function sessionName(session, msg) {
  const m = load();
  if (m.state.names[session]) return m.state.names[session];
  try {
    const first = fs.readFileSync(path.join(RAVENRY_HOME, 'events', session + '.jsonl'), 'utf8').split('\n')[0];
    const e = JSON.parse(first);
    const reg = registry.load();
    const ps = reg ? reg.projects.filter((p) => (p.workspaces || []).includes(e.workspace_id)) : [];
    const p = ps.find((x) => x.folder === e.cwd) || ps[0];
    if (p) { m.state.names[session] = p.name; return p.name; }
  } catch { /* no events for it */ }
  return msg ? msg.project : '';
}

export function quoteOf(c) {
  const m = load();
  const q = c.quote;
  const msg = q && m.messages.get(q.key);
  if (!msg) return null;
  const text = msg.text;
  const end = Math.min(q.end, text.length);
  const body = norm(text.slice(q.start, end));
  const pre = norm(text.slice(0, q.start)) ? '... ' : '';
  const post = norm(text.slice(end)) ? ' ...' : '';
  return { text: pre + body + post, project: sessionName(msg.session, msg), date: dayWord(msg.ts) };
}

function rowOf(c, kept, cfg, state) {
  const kind = kindOf(c, kept, state);
  const last = kept.reduce((a, x) => (x.ts > a ? x.ts : a), '');
  const sessions = new Set(kept.map((x) => x.session)).size;
  const label = c.match && c.match.label;
  const tail = kind === 'add' ? 'No rule says this yet.'
    : kind === 'every' ? `Only ${label} knows this one.`
      : c.match.source === 'memory' ? `${label} has it in memory and you still said it.` : '';
  const ops = opsFor(c, kind, kept, cfg);
  const preview = previewOf(c, kind, ops);
  preview.next = rules.plainRule(splitCite(c.line).body);
  const who = assistantsOf(kept);
  return {
    id: c.id, rule: rules.plainRule(c.rule), kind, button: LABEL[kind],
    messages: kept.length, sessions, lastTs: last, last: dayWord(last), tail,
    // Which assistant's sessions said it, and the files accepting writes.
    assistants: who, sessionsText: sessionsText(sessions, who), targets: ops.map((o) => (o.file ? short(o.file) : RULES_NAME[o.assistant])),
    quote: quoteOf(c), preview,
  };
}

export function view(cfg) {
  if (viewCache && Date.now() - viewCache.at < 60000) return viewCache.value;
  const m = load();
  if (!m.state.seeded) return { seeded: false, seeding: !!seeding, rows: [], count: 0 };
  const dec = rules.readDecisions().repeats || {};
  const by = clusterMessages();
  const rows = [];
  for (const c of Object.values(m.clusters)) {
    if (!c.rule || !c.line) continue;
    const kept = dedupe(by.get(c.id) || []);
    if (new Set(kept.map((x) => x.session)).size < 2) continue;
    const r = rowOf(c, kept, cfg, m.state);
    const d = dec[c.id];
    if (d && !(r.lastTs > d.at)) continue;
    rows.push(r);
  }
  rows.sort((a, b) => b.messages - a.messages || b.sessions - a.sessions || a.id.localeCompare(b.id));
  const value = {
    seeded: true, rows, count: rows.length,
    sessions: new Set([...m.messages.values()].map((x) => x.session)).size,
    scope: cfg.rulesScopeName,
    // The daily runs: off on a new board until `ravenry setup` turns them on.
    auto: !!cfg.repeatsAuto,
    lastRun: m.state.lastRun,
  };
  viewCache = { at: Date.now(), value };
  return value;
}

export function visibleCount(cfg) {
  try { return view(cfg).count; } catch { return 0; }
}

// ------------------------------------------------------------ quotes

// Where an excerpt sits in a stored message, whitespace-insensitive.
export function locate(text, excerpt) {
  const words = norm(excerpt).split(' ').filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

// A short excerpt of a stored message: sentence `k` (0-based), extended
// with the next ones while it stays short. Offsets into the stored text.
export function excerpt(text, k = 0, max = 140) {
  const spans = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m.index + (m[0].length - m[0].trimStart().length);
    const e = m.index + m[0].trimEnd().length;
    if (e > s) spans.push([s, e]);
    if (m[0].length === 0) re.lastIndex++;
  }
  if (!spans.length) return { start: 0, end: text.length };
  const i = Math.max(0, Math.min(spans.length - 1, Number(k) || 0));
  let [start, end] = spans[i];
  for (let j = i + 1; j < spans.length && end - start < 60 && spans[j][1] - start <= max; j++) end = spans[j][1];
  if (end - start > max) {
    const cut = text.lastIndexOf(' ', start + max);
    end = cut > start + 40 ? cut : start + max;
  }
  return { start, end };
}

// ------------------------------------------------------------ the seed

let seeding = null;

function resolveSeedMatch(sm, cfg) {
  if (!sm) return null;
  if (sm.source === 'global') {
    const b = parseBlocks(readMd(cfg.globalClaudeMd)).find((x) => x.raw.startsWith(sm.find));
    return b ? { source: 'global', file: cfg.globalClaudeMd, text: b.raw } : null;
  }
  if (sm.source === 'memory') {
    const src = sources(cfg).find((s) => s.label === sm.label) || (cfg.ruleSources || []).find((s) => s.label === sm.label);
    if (!src) return null;
    const file = path.join(src.memory, sm.memory + '.md');
    const desc = memoryDescription(file);
    return desc ? { source: 'memory', file, text: desc, label: src.label, memory: sm.memory, claudeMd: src.claudeMd || null, dir: src.transcripts || null, folder: src.folder || null } : null;
  }
  return null;
}

// First start: read every transcript to its end and store every typed
// message, with no model call. Messages up to the data pass's last one take
// the data pass's verdicts (its clusters, or "backlog" for the rest, which
// is never sent to the model); anything typed after it waits for the next
// run. The 12 clusters of the approved mockup start from the seed.
export function ensureSeed(cfg) {
  const m = load();
  if (m.state.seeded) return Promise.resolve(false);
  if (seeding) return seeding;
  seeding = (async () => {
    const seed = SEED_PATH ? JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) : EMPTY_SEED;
    const t0 = Date.now();
    const r = await ingest(cfg);
    const refs = new Map();
    for (const c of seed.clusters) for (const [s, ts] of c.refs) refs.set(`${s}|${ts}`, [...(refs.get(`${s}|${ts}`) || []), c.id]);
    const at = new Date().toISOString();
    const vs = [];
    let backlog = 0;
    let pending = 0;
    for (const msg of m.messages.values()) {
      if (m.verdicts.has(msg.key)) continue;
      const ids = refs.get(`${msg.session}|${msg.ts}`);
      if (ids) vs.push({ key: msg.key, v: 'cluster', clusters: ids, by: 'seed', at });
      else if (seed.cutoff && msg.ts <= seed.cutoff) { vs.push({ key: msg.key, v: 'backlog', by: 'seed', at }); backlog++; } else pending++;
    }
    addVerdicts(vs);
    const lineSeen = m.state.lineSeen || (m.state.lineSeen = {});
    for (const c of seed.clusters) {
      if (m.clusters[c.id]) continue;
      const match = resolveSeedMatch(c.match, cfg);
      if (match && match.source === 'global' && !lineSeen[match.text]) lineSeen[match.text] = at;
      const sc = splitCite(c.line.replace(/^-\s+/, ''));
      const qmsg = [...m.messages.values()].find((x) => x.session.startsWith(c.quote.session) && locate(x.text, c.quote.excerpt));
      const loc = qmsg && locate(qmsg.text, c.quote.excerpt);
      if (qmsg && c.quote.name) m.state.names[qmsg.session] = c.quote.name;
      m.clusters[c.id] = {
        id: c.id, rule: c.rule, line: sc.body, cite: citeNames(sc.cite), match,
        quote: loc ? { key: qmsg.key, ...loc } : null,
        seed: true, createdAt: at, drafted: { at, by: 'seed' },
      };
    }
    saveClusters();
    m.state.seeded = { at, cutoff: seed.cutoff, files: r.files, bytes: r.bytes, messages: m.messages.size, seededVerdicts: vs.length - backlog, backlog, pending, ms: Date.now() - t0 };
    saveState();
    return true;
  })().finally(() => { seeding = null; });
  return seeding;
}

export function isSeeding() { return !!seeding; }

// ------------------------------------------------------------ model calls

// claude -p with a JSON schema, prompt on stdin. Bounded by a timeout;
// returns the structured answer and the usage the CLI reports.
export function callClaude(cfg, system, prompt, schema) {
  return new Promise((resolve) => {
    const [cmd, ...base] = cfg.repeatsCommand;
    const args = [...base, '--system-prompt', system, '--json-schema', JSON.stringify(schema)];
    fs.mkdirSync(DIR, { recursive: true });
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(cmd, args, { cwd: DIR, env: { ...process.env, MC_REPEATS_JOB: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      finish({ ok: false, error: `no answer after ${Math.round(cfg.repeatsTimeoutMs / 1000)} s` });
    }, cfg.repeatsTimeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `could not run ${path.basename(cmd)}: ${e.message}` }));
    child.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch { /* not json */ }
      if (!j) return finish({ ok: false, error: `exit ${code}: ${(err || out).trim().slice(-200)}` });
      const u = j.usage || {};
      const usage = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0, cost: j.total_cost_usd || 0 };
      let data = j.structured_output;
      if (!data && typeof j.result === 'string') { try { data = JSON.parse(j.result); } catch { /* prose */ } }
      if (j.is_error || !data) return finish({ ok: false, usage, error: `no structured answer (${j.subtype || 'exit ' + code})` });
      finish({ ok: true, data, usage });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Codex's structured output takes a strict schema: every property listed
// in required, no others allowed. Optional fields then come back empty
// ("" or []), which the run reads as absent.
export function strictSchema(x) {
  if (!x || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(strictSchema);
  const o = {};
  for (const [k, v] of Object.entries(x)) o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, d]) => [p, strictSchema(d)])) : strictSchema(v);
  if (o.type === 'object' && o.properties) { o.required = Object.keys(o.properties); o.additionalProperties = false; }
  return o;
}

// The same call through `codex exec` (server/codexexec.mjs), when new
// sessions start with Codex (cfg.printAssistant): the system words first in
// the prompt (exec has no system prompt), the schema as --output-schema, no
// tools, low effort, in the same folder. Tokens only: Codex reports no cost.
async function callCodex(cfg, system, prompt, schema) {
  const r = await asst.runCodex({
    prompt: `${system}\n\n${prompt}`, schema: strictSchema(schema), cwd: DIR, timeoutMs: cfg.repeatsTimeoutMs,
    settings: cfg.printSettings || {}, envExtra: { MC_REPEATS_JOB: '1' }, what: 'repeats call', effort: 'low',
  });
  const usage = r.usage ? { in: r.usage.in, out: r.usage.out, cost: 0 } : null;
  if (r.timedOut) return { ok: false, usage, error: `no answer after ${Math.round(cfg.repeatsTimeoutMs / 1000)} s` };
  if (!r.ok) return { ok: false, usage, error: `Codex: ${String(r.error || 'no answer').slice(0, 200)}` };
  let data = null;
  try { data = JSON.parse(String(r.text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* prose */ }
  if (!data) return { ok: false, usage, error: 'no structured answer (Codex did not answer in JSON)' };
  return { ok: true, data, usage };
}

// The board's own model call for a run: claude -p as before, or codex exec.
export function callModel(cfg, system, prompt, schema) {
  return cfg.printAssistant === 'codex' ? callCodex(cfg, system, prompt, schema) : callClaude(cfg, system, prompt, schema);
}

const SYSTEM = 'You read messages the user typed to their AI coding agents and find the corrections they make again and again. Answer only through the structured output.';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { k: { type: 'integer' }, v: { type: 'string', enum: ['none', 'existing', 'new'] }, cluster: { type: 'string' }, gist: { type: 'string' }, also: { type: 'array', items: { type: 'string' } } },
        required: ['k', 'v'],
      },
    },
  },
  required: ['items'],
};

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, rule: { type: 'string' }, match: { type: 'string' }, line: { type: 'string' },
          quote: { type: 'object', properties: { k: { type: 'integer' }, sentence: { type: 'integer' } }, required: ['k'] },
        },
        required: ['id', 'rule', 'match', 'line', 'quote'],
      },
    },
  },
  required: ['drafts'],
};

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' [...]' : s);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function classifyPrompt(batch, clusters) {
  const list = Object.values(clusters).map((c) => `${c.id}: ${rules.plainRule(c.rule)}`).join('\n') || '(none yet)';
  const agents = batch.some((x) => x.assistant === 'codex') ? (batch.every((x) => x.assistant === 'codex') ? 'Codex' : 'Claude Code and Codex') : 'Claude Code';
  return `The user works with ${agents} agents. Below are messages they typed to them, and the clusters of corrections found so far.

A correction is a message where they tell the agent how to work, or that it did something the wrong way: process, behaviour, verification, pace, asking them things, taste, writing style. A bug report about the thing being built ("the ball goes through the wall") is not a correction, unless it also says how the agent should work ("stop running tests for hours"). Questions, new tasks, approvals and plain answers are not corrections.

For each message, give k and:
- v "none" when it is not a correction;
- v "existing" and cluster = the id of the cluster it repeats, when it asks for the same thing as that cluster, in any wording;
- v "new", cluster = a short kebab-case id you make up (2 to 5 words), and gist = the instruction in their own words, one short sentence. Messages in this batch that ask for the same new thing share one id.
- also: the ids of other existing clusters the same message repeats too, only when it clearly asks for two things at once (usually empty).

Clusters so far:
${list}

Messages:
${batch.map((x, k) => `[${k}] (${x.project}, ${x.ts.slice(0, 10)}) ${clip(x.text, MSG_CHARS)}`).join('\n\n')}`;
}

// The rule lines a draft may match. With Codex sessions in the store, the
// AGENTS.md lines too (A = the global one, Q = a project's), so a rule Codex
// already reads is reworded rather than added again; a board with only
// Claude Code's sessions asks exactly as before.
function candidates(cfg, { codex = false } = {}) {
  const out = [];
  let g = 0;
  for (const b of parseBlocks(readMd(cfg.globalClaudeMd))) out.push({ id: `G${++g}`, source: 'global', file: cfg.globalClaudeMd, text: b.raw, show: b.text });
  if (codex) {
    const ga = globalFile(cfg, 'codex');
    let a = 0;
    if (ga) for (const b of parseBlocks(readMd(ga))) out.push({ id: `A${++a}`, source: 'global', assistant: 'codex', file: ga, text: b.raw, show: `global AGENTS.md: ${b.text}` });
    let q = 0;
    const seenA = new Set();
    for (const s of cfg.ruleSources || []) {
      const file = s && s.folder ? projectFile(cfg, 'codex', s.folder) : null;
      if (!file || seenA.has(file)) continue;
      seenA.add(file);
      for (const b of parseBlocks(readMd(file))) out.push({ id: `Q${++q}`, source: 'project', assistant: 'codex', file, label: s.label, folder: s.folder || null, text: b.raw, show: `${s.label} AGENTS.md: ${b.text}` });
    }
  }
  let p = 0;
  const seenMd = new Set();
  const srcs = sources(cfg);
  const srcOf = (label) => srcs.find((x) => x.label === label) || (cfg.ruleSources || []).find((x) => x.label === label) || {};
  for (const s of cfg.ruleSources || []) {
    if (!s.claudeMd || seenMd.has(s.claudeMd)) continue;
    seenMd.add(s.claudeMd);
    for (const b of parseBlocks(readMd(s.claudeMd))) out.push({ id: `P${++p}`, source: 'project', file: s.claudeMd, label: s.label, folder: s.folder || null, text: b.raw, show: `${s.label} CLAUDE.md: ${b.text}` });
  }
  let k = 0;
  for (const r of rules.scan(cfg)) {
    const s = r.sources[0];
    const src = srcOf(s.label);
    const desc = memoryDescription(s.file);
    if (!desc) continue;
    out.push({ id: `M${++k}`, source: 'memory', file: s.file, dir: src.transcripts || null, folder: src.folder || null, label: s.label, memory: r.id, claudeMd: s.claudeMd || null, text: desc, show: `${s.label} memory ${r.id}: ${rules.plainRule(desc)}` });
  }
  return out;
}

function draftPrompt(list, cands) {
  const ids = cands.some((x) => x.assistant === 'codex') ? 'G = their global CLAUDE.md, P = a project CLAUDE.md, M = a project memory note, A = their global AGENTS.md, Q = a project AGENTS.md' : 'G = their global CLAUDE.md, P = a project CLAUDE.md, M = a project memory note';
  return `The user said each thing below in two or more sessions with their AI coding agents. For each cluster, write:
- rule: the instruction as one short line in their own words and vocabulary, as they would say it to the agent (for example "Show me a mockup first; don't build before I've seen the picture."). No em dashes.
- match: the id of the existing rule line below that already says this (${ids}), or "" when none does.
- line: the CLAUDE.md line to write, starting with "- ". With a match, reword the matched line so that an agent reading it would not need to be told again: keep what it says that still matters and make the part they keep repeating impossible to miss. Without a match, a new line. Write about the user in the third person, like the existing lines. No citations in parentheses, no em dashes.
- quote: the message (k) that says it most plainly, and which sentence of it (0-based).

Existing rule lines:
${cands.map((c) => `${c.id}: ${clip(norm(c.show), 400)}`).join('\n')}

Clusters:
${list.map(({ c, msgs }) => `## ${c.id} (gist so far: ${rules.plainRule(c.rule)})\n${msgs.map((x, k) => `[${k}] (${x.project}, ${x.ts.slice(0, 10)}) ${clip(x.text, 600)}`).join('\n')}`).join('\n\n')}`;
}

// ------------------------------------------------------------ a run

let running = null;
export function isRunning() { return !!running; }

export function run(cfg, { reason = 'manual', log = (s) => console.log(s) } = {}) {
  if (running) return running;
  running = doRun(cfg, reason, log).finally(() => { running = null; });
  return running;
}

async function doRun(cfg, reason, log) {
  const t0 = Date.now();
  await ensureSeed(cfg);
  const m = load();
  const rec = { at: new Date().toISOString(), reason, read: 0, bytes: 0, classified: 0, corrections: 0, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, newClusters: [], reached: [], drafted: [], moved: [], errors: [] };
  const usage = (r) => { rec.calls++; if (r.usage) { rec.tokensIn += r.usage.in; rec.tokensOut += r.usage.out; rec.costUsd += r.usage.cost; } };
  const ing = await ingest(cfg);
  rec.read = ing.fresh.length;
  rec.bytes = ing.bytes;
  if (ing.resets.length) rec.resets = ing.resets.map(short);

  const sessionsOf = () => { const by = clusterMessages(); const o = {}; for (const [id, list] of by) o[id] = new Set(dedupe(list).map((x) => x.session)).size; return o; };
  const before = sessionsOf();

  // 1. Classify every message still without a verdict, in bounded batches.
  const pending = [...m.messages.values()].filter((x) => !m.verdicts.has(x.key)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let i = 0;
  while (i < pending.length && rec.calls < MAX_CLASSIFY_CALLS) {
    const batch = [];
    let chars = 0;
    while (i < pending.length && batch.length < BATCH_MESSAGES && (chars < BATCH_CHARS || !batch.length)) { const x = pending[i++]; batch.push(x); chars += Math.min(x.text.length, MSG_CHARS); }
    const r = await callModel(cfg, SYSTEM, classifyPrompt(batch, m.clusters), CLASSIFY_SCHEMA);
    usage(r);
    if (!r.ok) { rec.errors.push('classify: ' + r.error); break; }
    const at = new Date().toISOString();
    const answered = new Map();
    for (const it of r.data.items || []) if (Number.isInteger(it.k) && it.k >= 0 && it.k < batch.length && !answered.has(it.k)) answered.set(it.k, it);
    const vs = [];
    batch.forEach((x, k) => {
      const it = answered.get(k);
      if (!it) {
        const n = (m.state.tries[x.key] || 0) + 1;
        m.state.tries[x.key] = n;
        if (n >= 2) vs.push({ key: x.key, v: 'none', by: 'unanswered', at });
        return;
      }
      delete m.state.tries[x.key];
      if (it.v === 'none') { vs.push({ key: x.key, v: 'none', by: 'model', at }); return; }
      let id = it.v === 'existing' && m.clusters[it.cluster] ? it.cluster : slug(it.cluster);
      if (!id) id = slug(it.gist) || 'repeat';
      if (!m.clusters[id]) {
        m.clusters[id] = { id, rule: rules.plainRule(it.gist || norm(x.text).slice(0, 120)), line: null, cite: [], match: null, quote: null, createdAt: at, drafted: null };
        rec.newClusters.push(id);
      }
      const ids = [id, ...(Array.isArray(it.also) ? it.also : []).filter((a) => a && m.clusters[a] && a !== id)];
      vs.push({ key: x.key, v: 'cluster', clusters: ids, gist: it.gist ? rules.plainRule(it.gist) : undefined, by: 'model', at });
      rec.corrections++;
    });
    addVerdicts(vs);
    rec.classified += vs.length;
    saveClusters();
  }
  if (i < pending.length) rec.leftOver = pending.length - i;

  // 2. Draft the clusters that just reached two sessions, came back after
  //    an accept, or whose matched line changed under them.
  const after = sessionsOf();
  for (const [id, n] of Object.entries(after)) if (n >= 2 && (before[id] || 0) < 2) rec.reached.push(id);
  const dec = rules.readDecisions().repeats || {};
  const by = clusterMessages();
  const lastOf = (id) => (by.get(id) || []).reduce((a, x) => (x.ts > a ? x.ts : a), '');
  const stale = (c) => c.match && c.match.source !== 'memory' && !parseBlocks(readMd(c.match.file)).some((b) => b.raw === c.match.text);
  const want = Object.values(m.clusters).filter((c) => {
    if ((after[c.id] || 0) < 2) return false;
    if (!c.drafted || c.needsDraft || stale(c)) return true;
    const d = dec[c.id];
    return d && d.action !== 'notnow' && d.at > c.drafted.at && lastOf(c.id) > d.at;
  }).sort((a, b) => (after[b.id] || 0) - (after[a.id] || 0)).slice(0, MAX_DRAFTS);
  if (want.length) {
    const cands = candidates(cfg, { codex: [...m.messages.values()].some((x) => x.assistant === 'codex') });
    const list = want.map((c) => ({ c, msgs: dedupe(by.get(c.id) || []).slice(-10) }));
    const r = await callModel(cfg, SYSTEM, draftPrompt(list, cands), DRAFT_SCHEMA);
    usage(r);
    if (!r.ok) rec.errors.push('draft: ' + r.error);
    else {
      const at = new Date().toISOString();
      for (const d of r.data.drafts || []) {
        const item = list.find((x) => x.c.id === d.id);
        if (!item) continue;
        const c = item.c;
        const cand = cands.find((x) => x.id === String(d.match || '').trim());
        const match = cand ? { source: cand.source, file: cand.file, text: cand.text, label: cand.label, dir: cand.dir, folder: cand.folder, memory: cand.memory, claudeMd: cand.claudeMd, ...(cand.assistant ? { assistant: cand.assistant } : {}) } : null;
        if (match && match.source !== 'memory') {
          const ls = m.state.lineSeen || (m.state.lineSeen = {});
          if (!ls[match.text]) ls[match.text] = at;
        }
        const sc = splitCite(String(d.line || '').replace(/^-\s+/, ''));
        const line = rules.plainRule(sc.body);
        if (!line) continue;
        // Citation names from the model count only when they name a real
        // memory note; the matched note is always cited.
        const known = new Set(cands.filter((x) => x.memory).map((x) => x.memory));
        const cite = [...new Set([...citeNames(sc.cite).filter((w) => known.has(w)), ...(match && match.memory ? [match.memory] : [])])];
        const q = d.quote || {};
        const qm = item.msgs[Math.max(0, Math.min(item.msgs.length - 1, Number(q.k) || 0))];
        const span = excerpt(qm.text, q.sentence);
        const was = c.match ? c.match.source : 'none';
        Object.assign(c, { rule: rules.plainRule(d.rule) || c.rule, line, cite, match, quote: { key: qm.key, ...span }, drafted: { at, by: 'model' }, needsDraft: false });
        rec.drafted.push(c.id);
        if (was !== (match ? match.source : 'none')) rec.moved.push(`${c.id}: ${was} -> ${match ? match.source : 'none'}`);
      }
      saveClusters();
    }
  }
  m.state.lastRun = { at: rec.at, ok: !rec.errors.length, read: rec.read, calls: rec.calls, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut };
  saveState();
  rec.ms = Date.now() - t0;
  appendLines(F.runs, [rec]);
  viewCache = null;
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  log(`repeats: ${reason} run read ${rec.read} new messages, classified ${rec.classified} (${rec.corrections} corrections), ${rec.calls} model calls, about ${k(rec.tokensIn)} tokens in and ${k(rec.tokensOut)} out${rec.newClusters.length ? `, new clusters ${rec.newClusters.join(', ')}` : ''}${rec.reached.length ? `, reached 2 sessions ${rec.reached.join(', ')}` : ''}${rec.errors.length ? `, errors: ${rec.errors.join('; ')}` : ''}`);
  return rec;
}

// Once a day while the board is up, and at start when the last run is more
// than 24 h old. A failed run is tried again after 6 h.
export function schedule(getCfg, log = (s) => console.log(s)) {
  const check = () => {
    const cfg = getCfg();
    if (!cfg.repeatsAuto || running) return;
    const last = load().state.lastRun;
    const wait = last && !last.ok ? 6 * 3600e3 : DAY;
    if (last && Date.now() - Date.parse(last.at) < wait) return;
    run(cfg, { reason: last ? 'daily' : 'first', log }).catch((e) => log('repeats: run failed: ' + e.message));
  };
  setTimeout(check, 20000);
  return setInterval(check, 3600e3);
}

// ------------------------------------------------------------ writes

function fail(status, msg) { const e = new Error(msg); e.status = status; return e; }

// Writes a whole file through its real path (a symlinked CLAUDE.md stays a
// symlink), via a temp file and a rename, keeping its mode.
function writeThrough(file, text) {
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* new file */ }
  let mode = 0o644;
  try { mode = fs.statSync(real).mode & 0o777; } catch { /* new file */ }
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.board-${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, real);
}

// Replaces exactly one rule line: the one whose full text is `oldRaw`.
// Refuses when that text is not in the file exactly once.
export function replaceLine(file, oldRaw, newRaw) {
  const md = readMd(file);
  const hits = parseBlocks(md).filter((b) => b.raw === oldRaw);
  if (hits.length !== 1) return { ok: false, found: hits.length };
  const b = hits[0];
  const next = md.slice(0, b.start) + newRaw + md.slice(b.end);
  // Checked again right before writing, so an edit in between is not lost.
  if (readMd(file) !== md) return { ok: false, found: -1 };
  writeThrough(file, next);
  return { ok: readMd(file) === next, before: md, after: next };
}

const tagOf = (label) => String(label || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function decide(id, action, cfg) {
  const m = load();
  const c = m.clusters[id];
  if (!c) throw fail(404, 'That suggestion is gone.');
  const d = rules.readDecisions();
  d.repeats = d.repeats || {};
  const at = new Date().toISOString();
  if (action === 'notnow') {
    d.repeats[id] = { action: 'notnow', at };
    rules.writeDecisions(d);
    viewCache = null;
    return { action, target: [], backup: [] };
  }
  const row = view(cfg).rows.find((r) => r.id === id) || (viewCache = null, view(cfg).rows.find((r) => r.id === id));
  if (!row) throw fail(409, 'That suggestion is not waiting any more.');
  if (action !== row.kind) throw fail(400, `This suggestion is "${row.button}", not ${action}.`);
  const kept = dedupe(clusterMessages().get(id) || []);
  const ops = opsFor(c, action, kept, cfg);
  const memoryReword = action === 'reword' && c.match.source === 'memory';
  // Every check before any write: the matched line or memory note still
  // reads as it did, and every file to write is known.
  if (memoryReword) {
    const cur = memoryDescription(c.match.file);
    if (cur !== c.match.text) {
      c.needsDraft = true;
      saveClusters();
      throw fail(409, `That memory (${c.match.memory}) changed since this was suggested, so nothing was written. The next run drafts it again.`);
    }
  }
  const blocks = new Map();
  for (const op of ops) {
    if (!op.file) throw fail(409, op.scope === 'global' ? `No global ${RULES_NAME[op.assistant]} is known on this Mac, so nothing was written.` : `No ${RULES_NAME[op.assistant]} is known for ${op.label || 'that project'}.`);
    if (op.op !== 'replace') continue;
    const b = parseBlocks(readMd(op.file)).find((x) => x.raw === c.match.text);
    if (!b) {
      c.needsDraft = true;
      saveClusters();
      throw fail(409, `That line in ${short(op.file)} changed since this was suggested, so nothing was written. The next run drafts the reword again.`);
    }
    blocks.set(op, b);
  }
  // The reworded text keeps the matched line's citation; a new line cites
  // the memory notes it came from.
  const matchCite = c.match && c.match.source !== 'memory' ? splitCite((parseBlocks(readMd(c.match.file)).find((x) => x.raw === c.match.text) || { text: c.match.text.replace(/^-\s+/, '') }).text).cite : '';
  const names = memoryReword ? [...(c.cite || []), c.match.memory].filter(Boolean) : [...(c.cite || []), ...(c.match && c.match.memory ? [c.match.memory] : [])];
  const appendLine = '- ' + (action === 'reword' && !memoryReword ? mergeCite(c.line, matchCite, c.cite || []) : mergeCite(c.line, '', names));
  const target = [];
  const backup = [];
  const written = [];
  let already = true;
  for (const op of ops) {
    const tag = op.scope === 'global' ? 'global' : tagOf(op.label);
    if (op.op === 'replace') {
      const b = blocks.get(op);
      const text = mergeCite(c.line, splitCite(b.text).cite, c.cite || []);
      const raw = b.raw.includes('\n') ? wrapRule(text) : '- ' + text;
      const bk = rules.backup(op.file, cfg, tag, RULES_NAME[op.assistant].replace(/\.md$/, ''));
      const r = replaceLine(op.file, c.match.text, raw);
      if (!r.ok) throw fail(409, `That line in ${short(op.file)} changed while saving, so nothing was written${written.length ? ` there (${written.map((w) => short(w.file)).join(' and ')} already has it)` : ''}.`);
      target.push(op.file); backup.push(bk); written.push({ op, line: raw });
      already = false;
    } else {
      const bk = rules.backup(op.file, cfg, tag, RULES_NAME[op.assistant].replace(/\.md$/, ''));
      const r = rules.appendRule(op.file, appendLine);
      target.push(op.file); backup.push(bk); written.push({ op, line: appendLine });
      if (!r.already) already = false;
    }
  }
  // The cluster now matches the line written (Claude Code's when it wrote
  // one), so a repeat of it after this is a Reword of that line.
  const main = written.find((w) => w.op.assistant === 'claude') || written[0];
  const ls = m.state.lineSeen || (m.state.lineSeen = {});
  for (const w of written) ls[w.line] = at;
  const o = main.op;
  c.match = o.op === 'replace' && o.assistant === matchAssistant(c.match)
    ? { ...c.match, text: main.line }
    : { source: o.scope === 'global' ? 'global' : 'project', file: o.file, text: main.line, ...(o.scope === 'global' ? {} : { label: o.label, folder: o.folder }), ...(o.assistant === 'codex' ? { assistant: 'codex' } : {}) };
  const rec = { action, at, target, backup, line: main.line, ...(written.some((w) => w.op.op === 'append') ? { already } : {}) };
  saveClusters();
  saveState();
  d.repeats[id] = rec;
  rules.writeDecisions(d);
  rules.invalidate();
  viewCache = null;
  return rec;
}
