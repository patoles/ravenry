// Where new projects go (docs/design/ProjectsRoot.dc.html): the folder a
// brand-new project's own folder is made in. A project started in a folder
// that is already there (New project, Existing) can live anywhere, and
// nothing on the board ever moves when this changes.
//
// Which folder wins, in order:
//   1. MC_PROJECTS_ROOT, read when the board started. The Settings row shows
//      it with a lock and no live Change.
//   2. settings.projectsRoot in projects.json, written by Change, by the
//      first-run question, or by step 3.
//   3. The folder most registered projects share (the parent of their
//      folders), saved as the setting the first time the board sees it, so
//      it never drifts as projects come and go.
//   4. Asking once: with nothing to go on, the Mac shows "Where do your
//      projects live?" with a suggestion (the first of ~/Developer,
//      ~/Projects, ~/Code, ~/dev or ~/src that exists, else ~/Projects,
//      made when the first project needs it). Until it is answered the
//      suggestion is used.
//
// `projectsRootFrom` beside the setting says which of these wrote it, so the
// line under the row can say where the folder came from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkExistingFolder } from './create.mjs';
import { RAVENRY_HOME, SCRATCH_DATA, inRepoTmp } from './home.mjs';
import * as registry from './registry.mjs';

const ENV_ROOT = process.env.MC_PROJECTS_ROOT || '';
const SUGGEST = ['Developer', 'Projects', 'Code', 'dev', 'src'];
export const FROM = ['shared', 'chosen', 'first-run'];

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function shortIn(home) {
  return (p) => (p && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p);
}

// The projects that count: on the board (not hidden) and with a folder.
function withFolders(projects) {
  return (projects || []).filter((p) => p && !p.hidden && p.folder);
}

// The parent folder most registered projects share, among those the board
// would accept as a projects root, with how many of them live there.
export function sharedParent(projects, { home = os.homedir(), dataHome = RAVENRY_HOME, scratch = SCRATCH_DATA } = {}) {
  const ps = withFolders(projects).filter((p) => scratch || !inRepoTmp(p.folder));
  const by = new Map();
  for (const p of ps) {
    const parent = path.dirname(realOr(p.folder));
    const e = by.get(parent) || { n: 0, spelled: path.dirname(p.folder) };
    e.n++;
    by.set(parent, e);
  }
  const ranked = [...by.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  for (const [real, e] of ranked) {
    if (!checkExistingFolder(real, { home, dataHome }).ok) continue;
    return { path: e.spelled, real, count: e.n, total: ps.length };
  }
  return null;
}

// How many of the board's projects live directly in `root`.
export function countIn(root, projects) {
  const r = realOr(root);
  const ps = withFolders(projects);
  return { count: ps.filter((p) => path.dirname(realOr(p.folder)) === r).length, total: ps.length };
}

// The first-run suggestion: the first of the usual folders that exists, else
// ~/Projects, which is made when the first project needs it.
export function suggestion({ home = os.homedir() } = {}) {
  for (const n of SUGGEST) {
    const p = path.join(home, n);
    if (isDir(p)) return { path: p, exists: true };
  }
  return { path: path.join(home, 'Projects'), exists: false };
}

// The folder that wins and where it came from:
// { path, source: 'env' | 'setting' | 'shared' | 'ask', from, count, total, suggestion }
// A real board (its data folder outside the repo's .tmp) never takes a
// folder inside the repo's .tmp as its projects root, from MC_PROJECTS_ROOT
// or from the setting: on 2026-11-03 a test's registry carried its scratch
// root into the user's projects.json and their board adopted it.
const tmpRootRefused = new Set();
function scratchRoot(p, scratch) {
  if (scratch || !inRepoTmp(p)) return false;
  if (!tmpRootRefused.has(p)) { tmpRootRefused.add(p); console.error(`projects root: ignored ${p}, a test's scratch folder; this board's data is not a test's`); }
  return true;
}

export function resolve(reg, { env = ENV_ROOT, home = os.homedir(), dataHome = RAVENRY_HOME, scratch = SCRATCH_DATA } = {}) {
  const settings = (reg && reg.settings) || {};
  const projects = (reg && reg.projects) || [];
  if (env && !scratchRoot(path.resolve(env), scratch)) return { path: path.resolve(env), source: 'env', from: null, ...countIn(env, projects) };
  if (typeof settings.projectsRoot === 'string' && settings.projectsRoot.trim() && !scratchRoot(settings.projectsRoot.trim(), scratch)) {
    const p = settings.projectsRoot.trim();
    const abs = p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
    return { path: abs, source: 'setting', from: FROM.includes(settings.projectsRootFrom) ? settings.projectsRootFrom : null, ...countIn(abs, projects) };
  }
  const sh = sharedParent(projects, { home, dataHome, scratch });
  if (sh) return { path: sh.path, source: 'shared', from: 'shared', count: sh.count, total: sh.total };
  const s = suggestion({ home });
  return { path: s.path, source: 'ask', from: null, count: 0, total: withFolders(projects).length, suggestion: s };
}

// A folder the board may make new projects in: the same guards as an
// existing project folder (inside the home folder, not the home folder
// itself, not ~/Library, not the board's own data folder, a real directory).
// The first-run suggestion ~/Projects may be missing: it is made on first use.
export function checkRoot(input, { home = os.homedir(), dataHome = RAVENRY_HOME, scratch = SCRATCH_DATA } = {}) {
  const raw = String(input ?? '').trim();
  if (!scratch && inRepoTmp(raw)) return { ok: false, error: 'That folder is a test\'s scratch folder inside Ravenry\'s .tmp. Pick where your projects live.' };
  const sug = suggestion({ home });
  const abs = raw === '~' || raw.startsWith('~/') ? path.join(home, raw.slice(1)) : raw;
  if (!sug.exists && abs.replace(/\/+$/, '') === sug.path && !fs.existsSync(sug.path)) return { ok: true, folder: sug.path, missing: true };
  const chk = checkExistingFolder(raw, { home, dataHome });
  if (!chk.ok) return chk;
  return { ok: true, folder: chk.folder };
}

// What the page shows: the Settings row and, while nothing is set, the
// first-run question.
export function view(reg, opts = {}) {
  const r = resolve(reg, opts);
  const short = shortIn(opts.home || os.homedir());
  return {
    path: short(r.path),
    source: r.source,
    from: r.from,
    locked: r.source === 'env',
    count: r.count,
    total: r.total,
    ask: r.source === 'ask',
    suggestion: r.suggestion ? { path: short(r.suggestion.path), exists: r.suggestion.exists } : null,
  };
}

// Change, or the first-run answer: checked with the guards, then written
// through the registry's settings path (with its backup). Refused while
// MC_PROJECTS_ROOT holds the value.
export function save(input, from, { env = ENV_ROOT, home = os.homedir(), dataHome = RAVENRY_HOME } = {}) {
  if (env) return { ok: false, status: 409, error: 'MC_PROJECTS_ROOT sets this folder, so it cannot be changed here. Change it where the board is started.' };
  if (!FROM.includes(from)) return { ok: false, status: 400, error: 'Say where the folder came from.' };
  const chk = checkRoot(input, { home, dataHome });
  if (!chk.ok) return { ok: false, status: 400, error: chk.error };
  const w = registry.writeSettings({ projectsRoot: chk.folder, projectsRootFrom: from });
  if (!w.ok) return w;
  return { ok: true, reg: w.reg, backup: w.backup, folder: chk.folder };
}

// The first time the board has registered projects and no setting, the
// folder most of them share becomes the setting, so the answer stays put.
// Returns the new registry when it wrote one, else null.
export function adopt(reg, { env = ENV_ROOT, home = os.homedir(), dataHome = RAVENRY_HOME } = {}) {
  if (env || !reg) return null;
  const s = reg.settings || {};
  if (typeof s.projectsRoot === 'string' && s.projectsRoot.trim()) return null;
  const sh = sharedParent(reg.projects, { home, dataHome });
  if (!sh) return null;
  const w = registry.writeSettings({ projectsRoot: sh.path, projectsRootFrom: 'shared' });
  if (!w.ok) { console.error('projects root:', w.error); return null; }
  console.log(`projects root: ${sh.path} (where ${sh.count} of ${sh.total} projects live), saved as the setting`);
  return w.reg;
}
