// The sidebar pages as files (packages/page-format, docs/PAGES.md): the
// hub reads every page file, resolves which one is used, reads its items
// and serves both to the app and the phone; it makes every write to an
// item file; it keeps the person's trust in project pages and their
// approvals of background asks.
//
// Where pages come from, nearest first (resolvePages):
//   project   <project folder>/.ravenry/pages/<id>.page.yaml
//   global    <RAVENRY_HOME>/pages/<id>.page.yaml (~/.ravenry/pages)
//   default   the shipped ones, pages/defaults/ in this package
// Global pages and the defaults make the sidebar's rows: the shipped five
// in their order (a copy keeps its default's place), then added pages in
// the order their files were made. A project's own pages come last, each
// with its project's name. A default page's folder is in ~/.ravenry/pages/.
//
// Reading is cheap and repeated: refresh() looks at the folders and reads
// again only the files whose size or time changed. fs.watch calls it at
// once, and the board's tick every 2 s, so a change made by an agent, an
// editor or a pull shows within a moment either way.
//
// A page file that does not check keeps its last good version (kept in
// <RAVENRY_HOME>/pages.json, so a restart keeps it too), shown under its
// problem.
//
// Writes to item files are field by field, against the hash the screen was
// drawn from (patchItem, toggle), never rewriting the file: a temp file in
// the same folder, then a rename. A conflict is answered with what is in
// the file now. The app never writes a page file, except Customize, which
// makes a new copy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as pf from './vendor/page-format.mjs';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';
import { itemsOf } from './providers.mjs';
import { drawPage, changedLines } from './pagedraw.mjs';
import { sayPath } from '../public/homepath.mjs';
import { sayFolder } from './homes.mjs';

const HUB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
export const RAVENRY_VERSION = PKG.version;
export const PAGES_DIR = path.join(RAVENRY_HOME, 'pages');
// A test points this at its own defaults (a newer revision, for "changed
// since your copy"); a real board uses the shipped ones.
export const DEFAULTS_DIR = process.env.RAVENRY_PAGE_DEFAULTS || path.join(HUB, 'pages', 'defaults');
export const DOCS_FILE = path.join(HUB, 'pages', 'pages.md');
export const STATE_FILE = path.join(RAVENRY_HOME, 'pages.json');
const HISTORY_DIR = path.join(path.dirname(DEFAULTS_DIR), 'history');

const HOME = os.homedir();
const short = (p) => sayPath(p, HOME);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
const MAX_ITEMS = 2000;
const MAX_ITEM_BYTES = 1 << 20;

const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function fail(message, status = 400, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------- the hub's record

// { version, trust: TrustRecord[], approvals: [{ path, hash, at }],
//   dismissed: [{ path, from, to }], good: { path: text } }. Only person
// routes change trust, approvals and dismissed.
let record = null;
function rec() {
  if (record) return record;
  try { record = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { record = {}; }
  record = { version: 1, trust: [], approvals: [], dismissed: [], good: {}, ...record };
  return record;
}
function saveRecord() {
  assertDataWrite(STATE_FILE);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------- files

// Writes a file inside `dir` through a temp file next to it and a rename.
// `fresh`: the file must not exist yet (create, archive).
export function writeAtomic(file, text, { fresh = false } = {}) {
  assertDataWrite(file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    if (fresh) {
      // link fails when the name is taken: no file is ever replaced.
      fs.linkSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    } else {
      fs.renameSync(tmp, file);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const textCache = new Map(); // abs path -> { key, text, created }
function readText(file) {
  let st;
  try { st = fs.statSync(file); } catch { textCache.delete(file); return null; }
  if (!st.isFile()) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const c = textCache.get(file);
  if (c && c.key === key) return c;
  if (st.size > pf.MAX_BYTES * 4) return { key, text: '', created: st.birthtime.toISOString(), tooBig: true };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const v = { key, text, created: (st.birthtimeMs ? st.birthtime : st.mtime).toISOString(), mtime: st.mtime.toISOString() };
  textCache.set(file, v);
  return v;
}

// The shipped pages, in the sidebar's order; any other shipped one after them.
export const SHIPPED = ['objectives', 'plans', 'ideas', 'rules', 'ship'];
const shippedRank = (f) => { const i = SHIPPED.indexOf(path.basename(f).replace(/\.page\.yaml$/, '')); return i < 0 ? SHIPPED.length : i; };

function pageFilesIn(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.page.yaml') && !n.startsWith('.')).sort().map((n) => path.join(dir, n));
}

// ---------------------------------------------------------------- context

// What the providers read: set by the board each tick (index.mjs).
let ctxFn = () => ({ projects: [], regProjects: [] });
export function setContext(fn) { ctxFn = fn; }
// Adds what Ravenry's own pieces need to a folder's items (the Ideas page's
// mockup rounds and threads, by the idea's id), under $ravenry.
let decorate = null;
export function setDecorate(fn) { decorate = fn; }

// ---------------------------------------------------------------- resolving

let state = { pages: [], byKey: new Map(), at: 0 };
let listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function projectsWithPages(regProjects) {
  return (regProjects || []).filter((p) => p && !p.hidden && !p.machine && p.folder && path.isAbsolute(p.folder));
}

// Reads every page file and resolves them. Returns true when anything
// the sidebar shows changed.
export function refresh() {
  const ctx = ctxFn();
  const files = [];
  const add = (origin, file, project = null) => {
    const t = readText(file);
    if (!t) return;
    files.push({ origin, path: file, text: t.tooBig ? '' : t.text, created: t.created, project });
  };
  for (const f of pageFilesIn(DEFAULTS_DIR).sort((a, b) => shippedRank(a) - shippedRank(b))) add('default', f);
  for (const f of pageFilesIn(PAGES_DIR)) add('global', f);
  const projFiles = new Map();
  for (const p of projectsWithPages(ctx.regProjects)) {
    for (const f of pageFilesIn(path.join(p.folder, '.ravenry', 'pages'))) {
      const t = readText(f);
      if (!t) continue;
      if (!projFiles.has(p.id)) projFiles.set(p.id, { project: p, files: [] });
      projFiles.get(p.id).files.push({ origin: 'project', path: f, text: t.text, created: t.created, project: p });
    }
  }
  const opts = { ravenryVersion: RAVENRY_VERSION };
  const base = files.filter((f) => f.origin !== 'project');
  const out = [];
  for (const r of pf.resolvePages(base, opts)) out.push(entry(r, null));
  for (const { project, files: pfiles } of projFiles.values()) {
    for (const r of pf.resolvePages([...pfiles, ...base], opts)) if (r.origin === 'project') out.push(entry(r, project));
  }
  const byKey = new Map(out.map((e) => [e.key, e]));
  const sig = JSON.stringify(out.map((e) => [e.key, e.hash, e.ok, e.trust && e.trust.state, e.defaultChanged]));
  const changed = sig !== state.sig;
  state = { pages: out, byKey, at: Date.now(), sig };
  if (changed) for (const fn of listeners) { try { fn(); } catch { /* a listener */ } }
  return changed;
}

function entry(r, project) {
  const R = rec();
  const key = project ? `${project.id}/${r.id}` : r.id;
  const dir = r.origin === 'default' ? PAGES_DIR : path.dirname(r.path);
  const fileName = path.basename(r.path);
  let page = r.result.ok ? r.result.page : null;
  let goodText = r.result.ok ? r.text : null;
  if (r.result.ok && r.origin !== 'default' && R.good[r.path] !== r.text) {
    R.good[r.path] = r.text;
    try { saveRecord(); } catch (e) { console.error('pages: record:', e.message); }
  }
  if (!r.result.ok && R.good[r.path]) {
    const g = pf.checkPage(R.good[r.path], { fileName, ravenryVersion: RAVENRY_VERSION });
    if (g.ok) { page = g.page; goodText = R.good[r.path]; }
  }
  const lines = r.text.split('\n');
  const problems = r.result.problems.map((p) => ({
    severity: p.severity, code: p.code, line: p.line, column: p.column, message: p.message, hint: p.hint || null,
    text: pf.formatProblem(fileName, p), lineText: lines[p.line - 1] ?? null,
  }));
  let trust = null;
  if (r.origin === 'project') {
    const st = pf.trustState(r.path, r.text, R.trust || []);
    trust = { state: st };
  }
  let defaultChanged = null;
  if (r.defaultChanged && page && page.from) {
    const def = pf.checkPage(readText(path.join(DEFAULTS_DIR, `${r.id}.page.yaml`))?.text || '', { fileName: `${r.id}.page.yaml` });
    const to = def.page ? def.page.revision : null;
    const gone = (R.dismissed || []).some((d) => d.path === r.path && d.from === page.from.revision && d.to === to);
    if (!gone) defaultChanged = { from: page.from.revision, to };
  }
  return {
    key, id: r.id, origin: r.origin, path: r.path, dir, project: project ? { id: project.id, name: project.name, folder: project.folder } : null,
    text: r.text, hash: sha(r.text), ok: r.result.ok, page, goodText, stale: !r.result.ok && !!page, problems,
    slot: r.slot, created: (r.origin === 'default' ? null : readText(r.path)?.created) || null, trust, defaultChanged,
    replaces: r.replaces.map((x) => ({ origin: x.origin, path: short(x.path) })),
  };
}

export function list() { return state.pages; }
export function get(key) { return state.byKey.get(key) || null; }

// ---------------------------------------------------------------- items

const itemCache = new Map(); // abs file -> { key, value }

// The items of a folder source: one per *.md file at its top (dot files and
// .archive/ left out), newest change first.
function folderItems(e, src) {
  const dir = path.resolve(e.dir, src.folder);
  if (!inside(dir, e.dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.md') || n.startsWith('.')) continue;
    if (out.length >= MAX_ITEMS) break;
    const file = path.join(dir, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size > MAX_ITEM_BYTES) continue;
    const key = `${st.size}:${st.mtimeMs}:${JSON.stringify(src.fields)}`;
    const c = itemCache.get(file);
    if (c && c.key === key) { out.push(c.value); continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const created = (st.birthtimeMs ? st.birthtime : st.mtime).toISOString();
    const r = pf.readItem(text, { file: n, created, modified: st.mtime.toISOString(), fields: src.fields });
    const value = { ...r.item, $hash: r.hash, $base: path.relative(e.dir, dir).split(path.sep).join('/') + '/', $problems: r.problems.map((p) => p.message), $boxes: pf.checklist(text).map((b) => ({ line: b.line, text: b.text, done: b.done })) };
    itemCache.set(file, { key, value });
    out.push(value);
  }
  return out.sort((a, b) => String(b.modified).localeCompare(String(a.modified)) || String(a.file).localeCompare(String(b.file)));
}

// A glob inside a folder: * within a name, ** across folders, ? one character.
export function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', '.tmp']);
function filesItems(e, src) {
  const root = e.project ? e.project.folder : e.dir;
  const re = globRegex(src.files);
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 6 || out.length >= 300) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), r, depth + 1); continue; }
      if (!d.isFile() || !re.test(r)) continue;
      const file = path.join(dir, d.name);
      let text, st;
      try { st = fs.statSync(file); if (st.size > MAX_ITEM_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const c = pf.boxCounts(text);
      out.push({ title: pf.firstHeading(text) || d.name.replace(/\.md$/i, ''), body: text, file: r, done: c.done, total: c.total, modified: st.mtime.toISOString(), $boxes: pf.checklist(text).map((b) => ({ line: b.line, text: b.text, done: b.done })) });
    }
  };
  walk(root, '', 0);
  return out;
}

function sourceItems(e, src, ctx) {
  if (!src) return [];
  if (src.kind === 'folder') {
    const items = folderItems(e, src);
    if (!decorate) return items;
    try { return decorate(e, src, items) || items; } catch { return items; }
  }
  if (src.kind === 'files') return filesItems(e, src);
  if (src.kind === 'provider' && !src.plugin) {
    let items = itemsOf(src.provider, ctx) || [];
    // A project's page sees its own project's data.
    if (e.project) items = items.filter((it) => [it.project, it.id].includes(e.project.id) || src.provider === 'rule-files' || src.provider === 'repeats');
    return items;
  }
  return [];
}

// Every section's items, and the page source's, for the last good model.
export function itemsFor(e, ctx = ctxFn()) {
  if (!e.page) return { page: [], sections: [] };
  const cache = new Map();
  const of = (src) => {
    if (!src) return [];
    const k = JSON.stringify(src);
    if (!cache.has(k)) cache.set(k, sourceItems(e, src, ctx));
    return cache.get(k);
  };
  return { page: of(e.page.source), sections: e.page.tabs.map((t) => t.sections.map((s) => of(s.source))) };
}

// ---------------------------------------------------------------- the sidebar

// One row per page, for the snapshot: what the sidebar draws and enough
// to know when to read the page again (rev).
export function navRows() {
  const ctx = ctxFn();
  return state.pages.map((e) => {
    const nav = e.page ? e.page.nav : null;
    let number = null;
    let changed = null;
    // What the page draws: its file, its items, its trust and notices.
    let rev = sha(e.hash + JSON.stringify([e.ok, e.trust, e.defaultChanged]));
    if (e.page) {
      const items = itemsFor(e, ctx);
      number = pf.navNumber(items.page, nav);
      rev = sha(rev + JSON.stringify(items));
      changed = lastChange(e, items);
    }
    return {
      key: e.key, id: e.id, label: nav ? nav.label : e.id, icon: nav ? nav.icon : 'page', number, countLabel: nav ? nav.countLabel : null,
      route: nav ? nav.route : e.id, origin: e.origin, slot: e.slot, project: e.project ? e.project.name : null, projectId: e.project ? e.project.id : null,
      error: !e.ok, trust: e.trust ? e.trust.state : null, defaultChanged: !!e.defaultChanged, created: e.created, rev: rev.slice(0, 16), changed,
    };
  });
}

// When a page last changed, for the phone's list of pages: the newest time
// its sections' items carry (their `time` field), else null.
function lastChange(e, items) {
  let best = 0;
  e.page.tabs.forEach((t, ti) => t.sections.forEach((sec, si) => {
    const f = sec.item && sec.item.time;
    if (!f) return;
    for (const it of (items.sections[ti] && items.sections[ti][si]) || []) {
      const v = String(f).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), it);
      const ms = v == null ? NaN : typeof v === 'number' ? v : Date.parse(String(v));
      if (Number.isFinite(ms) && ms > best) best = ms;
    }
  }));
  return best ? new Date(best).toISOString() : null;
}

// ---------------------------------------------------------------- one page

function explain(e) {
  if (!e.page) return [];
  const root = e.project ? sayFolder(e.project.folder, e.project.machine) : short(e.dir);
  return pf.explainActions(e.page, root);
}

/** The page as the app draws it: its last good model, its problems, its
 * trust, every section's items as read, and `drawn` (pagedraw.mjs): the
 * tab asked for with its rows filtered, sorted, grouped and counted. */
export function view(key, { tab = 0 } = {}) {
  const e = get(key);
  if (!e) return null;
  const items = itemsFor(e);
  const defText = e.origin !== 'default' ? readText(path.join(DEFAULTS_DIR, `${e.id}.page.yaml`))?.text || null : null;
  const historyText = e.defaultChanged ? readText(path.join(HISTORY_DIR, `${e.id}-r${e.defaultChanged.from}.page.yaml`))?.text || null : null;
  return {
    key: e.key, id: e.id, origin: e.origin, path: short(e.path), file: e.path, dir: short(e.dir), project: e.project ? { id: e.project.id, name: e.project.name, folder: sayFolder(e.project.folder, e.project.machine) } : null,
    ok: e.ok, stale: e.stale, model: e.page, problems: e.problems,
    trust: e.trust ? { state: e.trust.state, actions: explain(e) } : null,
    defaultChanged: e.defaultChanged,
    // For Customize and See what changed.
    text: e.text, defaultText: defText, defaultPath: defText ? path.join(DEFAULTS_DIR, `${e.id}.page.yaml`) : null,
    historyText,
    // See what changed, as a client shows it (pagedraw.mjs changedLines).
    changed: e.defaultChanged ? changedLines(historyText || e.text, defText || '') : null,
    replaces: e.replaces,
    items,
    drawn: drawPage(e.page, items, tab),
  };
}

// ---------------------------------------------------------------- pictures

/** A picture inside the page's folder, for <img>: its file and type, or null. */
export function picture(key, rel) {
  const e = get(key);
  if (!e || typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-z]+:/i.test(rel)) return null;
  const abs = path.resolve(e.dir, rel);
  const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (!type || !inside(abs, e.dir) || !inside(realOr(abs), realOr(e.dir))) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return { file: abs, type };
}

// ---------------------------------------------------------------- writes

// The folder a write goes to: the section's own source (at: [tab, section])
// or the page's, which must be a folder; the page must be usable as it is
// (not only its last good version), and a project page must be trusted.
// A page of the person's own with a mistake keeps the buttons of its last
// good version, as it keeps its look; a project page's trust is for the file
// as it is now, so a changed one is read-only.
function usable(e) {
  if (!e.page) throw fail(`${path.basename(e.path)} has a problem: ${e.problems.find((p) => p.severity === 'error')?.text || 'it does not check'}. Its buttons are off until it is fixed.`, 409);
  if (e.trust && e.trust.state !== 'trusted') throw fail('This page came with its project, and its buttons stay off until you trust it.', 403, { trust: e.trust.state });
}

function writable(key, at) {
  const e = get(key);
  if (!e) throw fail('No such page.', 404);
  usable(e);
  let src = e.page.source;
  if (Array.isArray(at) && at.length === 2) {
    const s = e.page.tabs[at[0]] && e.page.tabs[at[0]].sections[at[1]];
    if (!s) throw fail('No such section.', 404);
    src = s.source;
  }
  if (!src || src.kind !== 'folder') throw fail('This page reads its items from Ravenry, so they cannot be changed here.', 409);
  const dir = path.resolve(e.dir, src.folder);
  if (!inside(dir, e.dir)) throw fail('The page\'s folder is outside it.', 409);
  return { e, src, dir };
}

function itemFile(dir, file) {
  if (typeof file !== 'string' || !/^[^/\\\0]+\.md$/i.test(file) || file.startsWith('.')) throw fail('Name an item file of the page\'s folder.', 400);
  return path.join(dir, file);
}

function readItemNow(abs, src, file) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { throw fail('That item is gone: moved, archived or deleted.', 404); }
  const st = fs.statSync(abs);
  const r = pf.readItem(text, { file, created: (st.birthtimeMs ? st.birthtime : st.mtime).toISOString(), modified: st.mtime.toISOString(), fields: src.fields });
  return { text, item: { ...r.item, $hash: r.hash } };
}

// Checks a patch against the folder's fields: only declared fields (and
// title) with values of their type, and an enum only to one of its values.
function checkPatch(src, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw fail('Say which fields to change.', 400);
  for (const [k, v] of Object.entries(patch)) {
    const spec = src.fields[k];
    if (!spec || !spec.writable) throw fail(`${k} is not a field this page can change.`, 400);
    if (v === null || v === undefined || v === '') { if (spec.required) throw fail(`${spec.label} is needed.`, 400); continue; }
    const why = pf.valueProblem(spec, v);
    if (why) throw fail(`${spec.label} should be ${why}.`, 400);
  }
}

function afterWrite() { refresh(); }

/** Changes fields of an item, against what the screen showed. */
export function setFields(key, { at = null, file, hash, fields = null, patch }) {
  const { src, dir } = writable(key, at);
  checkPatch(src, patch);
  const abs = itemFile(dir, file);
  const cur = readItemNow(abs, src, file);
  const r = pf.patchItem(cur.text, patch, { hash: String(hash || ''), fields: fields || undefined });
  if (!r.ok) {
    if (r.conflict) throw fail(`It changed since you saw it: ${r.conflict.map((c) => c.field).join(', ')} ${r.conflict.length > 1 ? 'are' : 'is'} different now. Nothing was written.`, 409, { conflict: r.conflict, item: cur.item });
    throw fail(`Its frontmatter cannot be read: ${r.problems[0].message}`, 409, { item: cur.item });
  }
  writeAtomic(abs, r.text);
  afterWrite();
  return { item: readItemNow(abs, src, file).item, rebased: r.rebased };
}

/** Ticks or unticks one box of an item's text. */
export function toggleBox(key, { at = null, file, line, text, done }) {
  const { src, dir } = writable(key, at);
  const abs = itemFile(dir, file);
  const cur = readItemNow(abs, src, file);
  const r = pf.toggle(cur.text, { line: Number(line), text: String(text || ''), ...(typeof done === 'boolean' ? { done } : {}) });
  if (!r.ok) throw fail('That box changed since you saw it, or is there more than once. Nothing was written.', 409, { boxes: r.boxes, item: cur.item });
  writeAtomic(abs, r.text);
  afterWrite();
  return { item: readItemNow(abs, src, file).item, line: r.line, done: r.done, moved: r.moved };
}

/** A new item file: the create button's own values (action: its address,
 * as for ask and run), then the form's fields (checked), and its text. */
export function createItem(key, { at = null, action = null, fields = {}, body = '' }) {
  const { e, src, dir } = writable(key, at);
  let given = {};
  if (action) {
    const act = actionAt(e, action);
    if (!act || act.kind !== 'create') throw fail('That button does not make an item.', 400);
    given = act.create || {};
  }
  const f = { ...given, ...(fields && typeof fields === 'object' ? fields : {}) };
  for (const [k, spec] of Object.entries(src.fields)) if (f[k] === undefined && spec.default !== undefined && !spec.builtin) f[k] = spec.default;
  const title = String(f.title || '').replace(/\s+/g, ' ').trim();
  if (!title) throw fail('Give it a title first.', 400);
  f.title = title;
  for (const [k, v] of Object.entries(f)) {
    const spec = src.fields[k];
    if (!spec || !spec.writable) throw fail(`${k} is not a field of this page.`, 400);
    if (v === null || v === undefined || v === '') { delete f[k]; continue; }
    const why = pf.valueProblem(spec, v);
    if (why) throw fail(`${spec.label} should be ${why}.`, 400);
  }
  for (const [k, spec] of Object.entries(src.fields)) if (spec.required && !spec.builtin && (f[k] === undefined || f[k] === '')) throw fail(`${spec.label} is needed.`, 400);
  if (typeof body !== 'string' || body.length > 256 * 1024) throw fail('The text is too long.', 400);
  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set(fs.readdirSync(dir));
  const order = Object.keys(src.fields).filter((k) => !src.fields[k].builtin);
  for (let n = 0; n < 5; n++) {
    const name = pf.fileNameFor(title, taken);
    try {
      writeAtomic(path.join(dir, name), pf.makeItem(f, body, order), { fresh: true });
      afterWrite();
      return { file: name, item: readItemNow(path.join(dir, name), src, name).item };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      taken.add(name);
    }
  }
  throw fail('Could not find a free file name.', 409);
}

/** Moves an item's file into .archive/ (undo: restore). */
export function archive(key, { at = null, file, hash }) {
  const { src, dir } = writable(key, at);
  const abs = itemFile(dir, file);
  const cur = readItemNow(abs, src, file);
  if (hash && cur.item.$hash !== hash) throw fail('It changed since you saw it. Look again, then archive it.', 409, { item: cur.item });
  const to = path.join(dir, pf.archivePath(file));
  assertDataWrite(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) throw fail(`.archive/${file} exists already, so nothing was moved.`, 409);
  fs.renameSync(abs, to);
  afterWrite();
  return { file, archived: pf.archivePath(file) };
}

export function restore(key, { at = null, file }) {
  const { dir } = writable(key, at);
  const abs = itemFile(dir, file);
  const from = path.join(dir, pf.archivePath(file));
  if (!fs.existsSync(from)) throw fail('It is not in .archive/ any more.', 404);
  if (fs.existsSync(abs)) throw fail(`${file} exists again, so nothing was moved back.`, 409);
  assertDataWrite(abs);
  fs.renameSync(from, abs);
  afterWrite();
  return { file };
}

// ---------------------------------------------------------------- trust, approvals, notices

/** The person trusts this exact project page file. */
export function trust(key, { hash }) {
  const e = get(key);
  if (!e || !e.trust) throw fail('Only a page that came with a project needs trust.', 404);
  if (hash && hash !== e.hash) throw fail('The file changed since you read it. Read it again, then trust it.', 409);
  const R = rec();
  R.trust = pf.addTrust(R.trust || [], pf.trustRecord(e.path, e.text));
  saveRecord();
  refresh();
  return { state: 'trusted' };
}

function approved(e) {
  return (rec().approvals || []).some((a) => a.path === e.path && a.hash === e.hash);
}

/** The person lets this page's background asks run, for this version of the file. */
export function approve(key, { hash }) {
  const e = get(key);
  if (!e) throw fail('No such page.', 404);
  if (hash && hash !== e.hash) throw fail('The file changed since you read it. Look again, then allow it.', 409);
  const R = rec();
  R.approvals = [...(R.approvals || []).filter((a) => a.path !== e.path), { path: e.path, hash: e.hash, at: new Date().toISOString() }];
  saveRecord();
  return { ok: true };
}

/** Hides "Default page, changed since your copy" until the next revision. */
export function dismiss(key) {
  const e = get(key);
  if (!e || !e.defaultChanged) throw fail('There is nothing to hide.', 404);
  const R = rec();
  R.dismissed = [...(R.dismissed || []).filter((d) => d.path !== e.path), { path: e.path, from: e.defaultChanged.from, to: e.defaultChanged.to }];
  saveRecord();
  refresh();
  return { ok: true };
}

/** Customize: the default copied to ~/.ravenry/pages/<id>.page.yaml, stamped. */
export function customize(key) {
  const e = get(key);
  if (!e || e.origin !== 'default') throw fail('Only a shipped page is customized; this one is a file already.', 409);
  const to = path.join(PAGES_DIR, `${e.id}.page.yaml`);
  const text = pf.customize(e.text);
  try { writeAtomic(to, text, { fresh: true }); } catch (err) {
    if (err.code === 'EEXIST') throw fail(`${short(to)} exists already.`, 409);
    throw err;
  }
  refresh();
  return { path: short(to), file: to };
}

// ---------------------------------------------------------------- buttons

// The action at an address, from the page's current model: at is
// { scope: 'page' } or { scope: 'section', tab, section } or
// { scope: 'item', tab, section }, and index its place in that list.
export function actionAt(e, a) {
  if (!e.page || !a) return null;
  const s = a.scope === 'page' ? null : e.page.tabs[a.tab] && e.page.tabs[a.tab].sections[a.section];
  const list = a.scope === 'page' ? e.page.actions : !s ? null : a.scope === 'section' ? s.actions : s.kind === 'core' ? s.item.actions : null;
  let act = list ? list[a.index] : null;
  // A plugin action this hub has no code for runs its fallback, as drawn.
  return act || null;
}

// The item an action works on, as the page reads it now, found by its key
// field (a provider's) or its file (a folder's).
function findItem(e, a, ref) {
  if (!ref || a.scope !== 'item') return null;
  const items = itemsFor(e);
  const list = (items.sections[a.tab] || [])[a.section] || [];
  return list.find((it) => (ref.file && it.file === ref.file && it.$hash) || (ref.id != null && (it.id === ref.id || it.path === ref.id))) || null;
}

// Single-quoting for the shell, for argv words the page itself fixed.
const word = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'\\''`)}'`);

/** What a run button would run: the command line (the page's own argv,
 * never item data), its folder, and the item's values as variables. */
export function runPlan(key, a, ref) {
  const e = get(key);
  if (!e) throw fail('No such page.', 404);
  usable(e);
  const act = actionAt(e, a);
  if (!act || act.kind !== 'run') throw fail('That button does not run a command.', 400);
  const item = findItem(e, a, ref);
  if (a.scope === 'item' && !item) throw fail('That item is not on the page any more.', 404);
  if (act.when && item && !pf.matches(act.when, item)) throw fail('That button is not for this item.', 409);
  const root = e.project ? e.project.folder : e.dir;
  const cwd = act.cwd ? path.resolve(root, act.cwd) : root;
  if (!inside(cwd, root)) throw fail('The button\'s folder is outside the page\'s.', 409);
  const env = {};
  for (const [k, field] of Object.entries(act.env || {})) {
    const v = item ? pf.valueText(pf.getField(item, field)) : '';
    if (v.length > 1000 || /[\0\r\n]/.test(v)) throw fail(`The item's ${field} cannot go into ${k}: at most 1000 characters on one line.`, 400);
    env[k] = v;
  }
  return { page: e, action: act, command: act.argv.map(word).join(' '), cwd, env, title: `${e.page.title}: ${act.label}` };
}

/** An ask button: which project's session, and the text, filled from the
 * item's own fields as data. */
export function askPlan(key, a, ref) {
  const e = get(key);
  if (!e) throw fail('No such page.', 404);
  usable(e);
  const act = actionAt(e, a);
  if (!act || act.kind !== 'ask') throw fail('That button does not ask anything.', 400);
  const item = findItem(e, a, ref) || {};
  if (a.scope === 'item' && !item.title && !item.id) throw fail('That item is not on the page any more.', 404);
  const text = pf.fillText(act.text, item);
  const session = act.session ? pf.fillText(act.session, item) : String(item.project || item.id || (e.project && e.project.id) || '');
  const root = e.project ? sayFolder(e.project.folder, e.project.machine) : short(e.dir);
  return { page: e, action: act, text, session, background: !!act.background, approved: approved(e), does: pf.explainAction(act, root) };
}

// ---------------------------------------------------------------- check

/** `ravenry page check`: a file's text checked, with its items read from
 * beside it when `file` is given, as one line per problem and a summary. */
export function check(text, file = null) {
  const fileName = file ? path.basename(file) : 'page.page.yaml';
  const r = pf.checkPage(String(text || ''), { fileName, ravenryVersion: RAVENRY_VERSION });
  const out = { ok: r.ok, problems: r.problems.map((p) => ({ severity: p.severity, code: p.code, line: p.line, column: p.column, message: p.message, hint: p.hint || null, text: pf.formatProblem(fileName, p) })), summary: null };
  if (r.ok) {
    const groups = [];
    for (const t of r.page.tabs) for (const s of t.sections) {
      if (s.kind !== 'core' || !s.groupBy || !s.source || s.source.kind !== 'folder' || !file) { groups.push(null); continue; }
      const e = { dir: path.dirname(file), project: null };
      const items = folderItems(e, s.source).filter((it) => pf.matches(s.where, it));
      groups.push(pf.groupItems(items, s.groupBy, s.source.fields[s.groupBy] || null).map((g) => ({ value: g.value, count: g.items.length })));
    }
    out.summary = pf.describePage(r.page, groups);
  }
  return out;
}

export function docs(topic) {
  const text = fs.readFileSync(DOCS_FILE, 'utf8');
  return pf.docsTopic(text, topic || undefined);
}

// ---------------------------------------------------------------- watching

let watchers = [];
let soon = null;
// Watches the pages folder (items too) and the defaults: a change is read
// at once, and `onPoke` hears of it (the board sends its state again).
export function watch(onPoke = () => {}) {
  const poke = () => { if (soon) return; soon = setTimeout(() => { soon = null; try { refresh(); } catch { /* the tick reads it */ } onPoke(); }, 120); };
  for (const w of watchers) { try { w.close(); } catch { /* gone */ } }
  watchers = [];
  for (const dir of [PAGES_DIR, DEFAULTS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      watchers.push(fs.watch(dir, { recursive: true }, poke));
    } catch {
      try { watchers.push(fs.watch(dir, poke)); } catch { /* the tick reads it */ }
    }
  }
  return () => { for (const w of watchers) { try { w.close(); } catch { /* gone */ } } };
}
