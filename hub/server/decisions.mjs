// The decision ledger: the person's directions, kept verbatim with their
// time and project, so hand-offs, new sessions and agents read what was
// settled instead of asking again (hub/docs/DECISIONS.md).
//
// Ravenry never reads prompts to find decisions: hook reports drop prompt
// text on purpose (PROTOCOL.md section 4, agent.report). An entry comes
// only by explicit capture:
//
//   - an agent records the person's words verbatim with `ravenry decide`
//     (POST /api/decisions/record, an open row). It counts at once, marked
//     with who recorded it (the pane the caller runs in, as `ravenryd peer`
//     judges it, and that pane's assistant session), and the person gets
//     "Saved your decision: ..." with Undo for a minute;
//   - the person adds, edits, undoes or removes one (person rows).
//
// <RAVENRY_HOME>/decisions.json, mode 0600, written atomically:
//
//   { "version": 1, "decisions": [ Entry, ... ] }     oldest first
//
//   Entry: {
//     id:            "d" and 7 characters of a-z and 2-7
//     quote:         the person's words, verbatim (1 to 4000 bytes)
//     at:            when it was recorded (RFC 3339, UTC)
//     project:       the registry project's id, or null (a direction for
//                    every project)
//     scope:         optional, what it covers ("the phone board", "tests")
//     overrides:     ids of the entries this one replaces ([] when none)
//     overridden_by: set on an entry a later one replaced; such an entry is
//                    left out of the default (active) view
//     by:            "person" (added by the person), "agent" (recorded by
//                    an agent from inside a pane) or "client" (recorded
//                    through /record by a program outside every pane)
//     recorded_by:   with by "agent": { pane, session?, assistant?,
//                    machine? }, the pane the caller runs in and its
//                    assistant session
//     edited_at:     when the person last edited it
//     reads:         { "YYYY-MM-DD": n }, how often agents read it each day
//                    (the last 30 days), and last_read_at
//   }
//
// The project is the registry's id, not its name: a project can be renamed
// and two can share a name, while the id never changes. Readers may name a
// project by id, by name, or by a folder inside it (resolveProject), so an
// agent can pass its own working folder.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'decisions.json');
export const MAX_QUOTE = 4000;
export const MAX_SCOPE = 200;
export const MAX_OVERRIDES = 16;
// How long the person can undo an entry an agent recorded.
export const UNDO_MS = 60 * 1000;
const KEEP_READ_DAYS = 30;
const ID = /^d[a-z2-7]{7}$/;

function newId() {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  const b = crypto.randomBytes(7);
  return 'd' + [...b].map((x) => a[x & 31]).join('');
}

export function load(file = FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.decisions) ? j.decisions.filter((d) => d && ID.test(d.id) && typeof d.quote === 'string') : [];
  } catch { return []; }
}

function save(list, file = FILE) {
  assertDataWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, decisions: list }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const inside = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The project a reader names: its id, its name (any case), or a folder
// inside it (the deepest project folder that holds it). `extra` maps more
// folders to projects (a session's worktree, server/worktrees.mjs:
// [{ folder, projectId }]). Returns the project or null.
export function resolveProject(name, projects, extra = []) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  const live = (projects || []).filter((p) => p && !p.hidden);
  const byId = live.find((p) => p.id === s);
  if (byId) return byId;
  const byName = live.filter((p) => String(p.name || '').toLowerCase() === s.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (!path.isAbsolute(s)) return null;
  const at = real(s);
  for (const w of extra) {
    if (w && w.folder && w.projectId && inside(real(w.folder), at)) {
      const p = live.find((x) => x.id === w.projectId);
      if (p) return p;
    }
  }
  const near = live.filter((p) => p.folder && inside(real(p.folder), at)).sort((a, b) => b.folder.length - a.folder.length);
  return near[0] || null;
}

function cleanQuote(q) {
  if (typeof q !== 'string') return null;
  const t = q.replace(/\r\n?/g, '\n').trim();
  if (!t || Buffer.byteLength(t) > MAX_QUOTE) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) return null;
  return t;
}

function cleanScope(s) {
  if (s == null || s === '') return { ok: true, value: null };
  if (typeof s !== 'string' || Buffer.byteLength(s.trim()) > MAX_SCOPE || /[\r\n]/.test(s)) return { ok: false };
  return { ok: true, value: s.trim() || null };
}

// Adds an entry. `projectId` is the resolved project's id or null. Returns
// { ok, entry } or { ok: false, status, error }.
export function add({ quote, projectId = null, scope = null, overrides = [], by = 'person', recordedBy = null, at = null }, { file = FILE } = {}) {
  const q = cleanQuote(quote);
  if (!q) return { ok: false, status: 400, error: `The quote is the person's words: 1 to ${MAX_QUOTE} bytes of text.` };
  const sc = cleanScope(scope);
  if (!sc.ok) return { ok: false, status: 400, error: `The scope is one line of at most ${MAX_SCOPE} bytes.` };
  const ov = overrides == null ? [] : overrides;
  if (!Array.isArray(ov) || ov.length > MAX_OVERRIDES || !ov.every((x) => typeof x === 'string' && ID.test(x))) return { ok: false, status: 400, error: `overrides is a list of at most ${MAX_OVERRIDES} decision ids.` };
  const list = load(file);
  const missing = ov.filter((id) => !list.some((d) => d.id === id));
  if (missing.length) return { ok: false, status: 404, error: `No decision ${missing.join(', ')} on record.` };
  let id = newId();
  while (list.some((d) => d.id === id)) id = newId();
  const entry = {
    id, quote: q, at: at || new Date().toISOString(), project: projectId || null,
    ...(sc.value ? { scope: sc.value } : {}),
    overrides: [...new Set(ov)],
    by: by === 'agent' || by === 'client' ? by : 'person',
    ...(recordedBy ? { recorded_by: cleanRecorder(recordedBy) } : {}),
  };
  for (const d of list) if (entry.overrides.includes(d.id)) d.overridden_by = id;
  list.push(entry);
  save(list, file);
  return { ok: true, entry };
}

// Removes an entry recorded by mistake. The entries it overrode become
// active again, unless another entry overrides them too.
export function remove(id, { file = FILE } = {}) {
  const list = load(file);
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return { ok: false, status: 404, error: 'No such decision.' };
  const [gone] = list.splice(i, 1);
  for (const d of list) {
    if (d.overridden_by !== id) continue;
    const other = list.find((x) => x.overrides.includes(d.id));
    if (other) d.overridden_by = other.id; else delete d.overridden_by;
  }
  for (const d of list) d.overrides = d.overrides.filter((x) => x !== id);
  save(list, file);
  return { ok: true, removed: gone };
}

// The entries a reader asks for, newest first. `projectId`: that project's
// and the ones for every project (project null); undefined: all. `search`:
// every word must appear in the quote or the scope, any case. `all`: the
// overridden ones too.
export function query({ projectId, search = '', all = false } = {}, { file = FILE } = {}) {
  const words = String(search || '').toLowerCase().split(/\s+/).filter(Boolean);
  return load(file)
    .filter((d) => all || !d.overridden_by)
    .filter((d) => projectId === undefined || d.project === projectId || d.project == null)
    .filter((d) => { const t = `${d.quote}\n${d.scope || ''}`.toLowerCase(); return words.every((w) => t.includes(w)); })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function cleanRecorder(r) {
  const out = {};
  for (const k of ['pane', 'session', 'assistant', 'machine']) if (typeof r[k] === 'string' && r[k]) out[k] = r[k].slice(0, 200);
  return out;
}

// The person edits an entry: its quote, project (an id, or null for every
// project) or scope. Returns { ok, entry } or { ok: false, status, error }.
export function edit(id, patch, { file = FILE } = {}) {
  const list = load(file);
  const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, status: 404, error: 'No such decision.' };
  if (patch.quote !== undefined) {
    const q = cleanQuote(patch.quote);
    if (!q) return { ok: false, status: 400, error: `The quote is the person's words: 1 to ${MAX_QUOTE} bytes of text.` };
    d.quote = q;
  }
  if (patch.scope !== undefined) {
    const sc = cleanScope(patch.scope);
    if (!sc.ok) return { ok: false, status: 400, error: `The scope is one line of at most ${MAX_SCOPE} bytes.` };
    if (sc.value) d.scope = sc.value; else delete d.scope;
  }
  if (patch.projectId !== undefined) d.project = patch.projectId || null;
  d.edited_at = new Date().toISOString();
  save(list, file);
  return { ok: true, entry: d };
}

// Undo: the person takes back an entry within a minute of its recording.
export function undo(id, { file = FILE, now = Date.now() } = {}) {
  const d = load(file).find((x) => x.id === id);
  if (!d) return { ok: false, status: 404, error: 'No such decision.' };
  if (now - Date.parse(d.at) > UNDO_MS) return { ok: false, status: 409, error: 'Undo lasts a minute after it was saved. Remove it instead.' };
  return remove(id, { file });
}

const today = (t = new Date()) => t.toISOString().slice(0, 10);

// An agent read these entries: one read each, counted per day.
export function countReads(ids, { file = FILE, now = new Date() } = {}) {
  if (!ids.length) return;
  const list = load(file);
  const want = new Set(ids);
  const day = today(now);
  const oldest = today(new Date(now.getTime() - KEEP_READ_DAYS * 86400000));
  for (const d of list) {
    if (!want.has(d.id)) continue;
    const r = d.reads && typeof d.reads === 'object' ? d.reads : {};
    r[day] = (r[day] || 0) + 1;
    for (const k of Object.keys(r)) if (k < oldest) delete r[k];
    d.reads = r;
    d.last_read_at = now.toISOString();
  }
  save(list, file);
}

// An entry as GET /api/decisions gives it: with reads_today and
// reads_total (over the days kept), and undo_until while Undo lasts.
export function view(d, { now = new Date() } = {}) {
  const r = d.reads || {};
  const until = Date.parse(d.at) + UNDO_MS;
  return { ...d, reads_today: r[today(now)] || 0, reads_total: Object.values(r).reduce((a, b) => a + b, 0), ...(until > now.getTime() ? { undo_until: new Date(until).toISOString() } : {}) };
}

// The lines a hand-off gives the next session: the project's active
// decisions, newest first, verbatim, at most `max` of them and about
// `budget` bytes. Empty when there are none.
export function promptBlock(projectId, { max = 10, budget = 3000, file = FILE } = {}) {
  const list = query({ projectId }, { file });
  if (!list.length) return '';
  const out = [`The user's decisions on record for this project (newest first, verbatim; \`ravenry decisions${projectId ? ` --project ${projectId}` : ''}\` lists them). Follow them, and do not ask the user again about what they settle:`];
  let used = out[0].length;
  let shown = 0;
  for (const d of list.slice(0, max)) {
    const line = `- ${d.at.slice(0, 16).replace('T', ' ')}${d.scope ? ` (${d.scope})` : ''}: "${d.quote.replace(/\s*\n\s*/g, ' ')}"`;
    if (shown && used + line.length > budget) break;
    out.push(line);
    used += line.length;
    shown++;
  }
  if (list.length > shown) out.push(`- and ${list.length - shown} more: run the command above.`);
  return out.join('\n');
}

// One line for the first prompt of a new session (typed on a shell's
// command line, so it stays one line): where the decisions are.
export function promptLine(projectId, { file = FILE } = {}) {
  const n = query({ projectId }, { file }).length;
  if (!n) return '';
  return `Before you ask the user anything, check their ${n === 1 ? 'decision' : `${n} decisions`} on record: ravenry decisions${projectId ? ` --project ${projectId}` : ''}.`;
}
