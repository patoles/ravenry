// Plan files as objectives: the PLAN*.md, ROADMAP and TODO files a project
// already keeps, read for their markdown checkboxes. Each file with at least
// one `- [ ]` / `- [x]` is one count-only objective: its first heading, done
// of total, and how long ago it changed. The counts are shown as the file
// states them; a file whose boxes were never ticked says 0 of N, with its
// age, and the board never "corrects" it.
//
// Plan files belong to a FOLDER, not to a project. In a folder that several
// projects share, a file goes to the project its name names (PLAN-PORCH.md
// to Porch), else to the project marked "main": true in the registry, else
// to nobody, so a file is never shown twice.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { slug } from './registry.mjs';

// Root files: PLAN.md, PLAN-TV.md, REVIEW-PLAN.md, ROADMAP.md, TODO.md, TASKS.md.
const ROOT_FILE = /^(?:[\w-]*plan[\w-]*|roadmap[\w-]*|todo[\w-]*|tasks?[\w-]*)\.md$/i;
// Under docs/: any file whose name says plan, roadmap or todo.
const DOCS_FILE = /(plan|roadmap|todo)[\w-]*\.md$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', 'Library', 'shots']);
const CHECK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/;
const FENCE = /^\s*(```|~~~)/;
const RESCAN_MS = 60 * 1000;   // how often a folder's file list is looked at again
const GIT_MS = 10 * 60 * 1000; // a file's commit time is asked again at most this often

const files = new Map();   // abs path -> { mtimeMs, size, count, title, commitAt, dirty, gitAt }
const folders = new Map(); // folder -> { at, list }

export function countBoxes(md) {
  let done = 0;
  let total = 0;
  let fenced = false;
  for (const l of String(md).split('\n')) {
    if (FENCE.test(l)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = l.match(CHECK);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

// "# Implementation Plan: the TV room and the phone app ("PLAN-TV")"
//   -> "The TV room and the phone app"
export function planTitle(md, file) {
  const stem = path.basename(file, path.extname(file));
  const h = String(md).split('\n').find((l) => /^#{1,6}\s+\S/.test(l));
  let t = h ? h.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') : stem;
  t = t.replace(/[*_`]/g, '').trim();
  t = t.replace(new RegExp(`\\s*\\(["“']?${stem.replace(/[-]/g, '[- ]')}["”']?\\)\\s*$`, 'i'), '');
  t = t.replace(/^implementation plan\s*(?:[:\u2014\u2013-]|,)\s*/i, '');
  t = t.trim() || stem;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function walk(dir, depth, out) {
  if (depth > 4 || out.length > 200) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, depth + 1, out); }
    else if (e.isFile() && DOCS_FILE.test(e.name)) out.push(p);
  }
}

function candidates(folder) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(folder, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) if (e.isFile() && ROOT_FILE.test(e.name)) out.push(path.join(folder, e.name));
  walk(path.join(folder, 'docs'), 0, out);
  return out;
}

// git, never on the board's main thread: two synchronous git runs per plan
// file held the hub's first tick for 49 s on a real set of projects
// (2026-11-07, the 0.1.11 update that rolled back). A few at a time, in the
// background; the file's modified time stands in until they answer, and
// `onGit` hears when one did (the board builds its state again).
let onGit = () => {};
export function onGitAnswer(fn) { onGit = fn; }
const gitQueue = [];
let gitRunning = 0;
const GIT_AT_ONCE = 3;
function git(folder, args) {
  return new Promise((resolve) => {
    gitQueue.push(() => new Promise((finished) => execFile('git', ['-C', folder, ...args], { encoding: 'utf8', timeout: 4000 }, (err, out) => { resolve(err ? null : String(out).trim()); finished(); })));
    pump();
  });
}
function pump() {
  while (gitRunning < GIT_AT_ONCE && gitQueue.length) {
    const run = gitQueue.shift();
    gitRunning++;
    run().catch(() => {}).then(() => { gitRunning--; pump(); });
  }
}

// A folder's git facts for its plan files, three runs for all of them
// (never two per file: thousands of spawns on a big set of projects):
// each file's last commit time, and which ones changed or are new.
const folderGit = new Map(); // folder -> { at, asking, key, commit: Map(rel -> ms), dirty: Set(rel) }
function gitFacts(folder, rels, now) {
  let g = folderGit.get(folder);
  if (!g) { g = { at: 0, asking: false, key: '', commit: new Map(), dirty: new Set() }; folderGit.set(folder, g); }
  const key = rels.join('\n');
  if (rels.length && !g.asking && (!g.at || now - g.at > GIT_MS || g.key !== key)) {
    g.asking = true;
    g.key = key;
    Promise.all([
      git(folder, ['log', '--format=%x01%ct', '--name-only', '--relative', '-n', '500', '--', ...rels]),
      git(folder, ['diff', '--name-only', '--relative', 'HEAD', '--', ...rels]),
      git(folder, ['ls-files', '-o', '--exclude-standard', '--', ...rels]),
    ]).then(([log, changed, untracked]) => {
      const commit = new Map();
      let t = null;
      for (const line of String(log || '').split('\n')) {
        if (line.startsWith('\x01')) t = Number(line.slice(1)) * 1000;
        else if (line && t && !commit.has(line)) commit.set(line, t);
      }
      g.commit = commit;
      // No HEAD yet (or git failed): every file counts as changed.
      g.dirty = changed == null ? new Set(rels) : new Set([...changed.split('\n'), ...String(untracked || '').split('\n')].filter(Boolean));
      g.at = Date.now();
      g.asking = false;
      onGit();
    });
  }
  return g;
}

// Committed and unchanged: the last commit's time. Changed, never
// committed, or git not answered yet: the file's own modified time.
function updatedAt(folder, f, st, g) {
  const rel = path.relative(folder, f);
  // Changed since git looked: the file's time, whatever git said then.
  const commitAt = g && g.at && st.mtimeMs <= g.at ? g.commit.get(rel) : null;
  const at = commitAt && !g.dirty.has(rel) ? commitAt : st.mtimeMs;
  return new Date(at).toISOString();
}

function readPlan(folder, f, g) {
  let st;
  try { st = fs.statSync(f); } catch { files.delete(f); return null; }
  let e = files.get(f);
  if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
    let md = '';
    try { md = fs.readFileSync(f, 'utf8'); } catch { return null; }
    const prev = e;
    e = { mtimeMs: st.mtimeMs, size: st.size, count: countBoxes(md), title: planTitle(md, f) };
    void prev;
    files.set(f, e);
  }
  if (!e.count.total) return null;
  return { file: f, source: path.relative(folder, f), title: e.title, done: e.count.done, total: e.count.total, updatedAt: updatedAt(folder, f, st, g) };
}

export function folderPlans(folder, now = Date.now()) {
  if (!folder) return [];
  let c = folders.get(folder);
  if (!c || now - c.at > RESCAN_MS) {
    c = { at: now, list: candidates(folder) };
    folders.set(folder, c);
  }
  const g = gitFacts(folder, c.list.map((f) => path.relative(folder, f)), now);
  return c.list.map((f) => readPlan(folder, f, g)).filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// Does this file's name name the project? PLAN-PORCH.md names "porch".
function names(file, project) {
  const words = path.basename(file, '.md').toLowerCase().split(/[-_.\s]+/).filter((w) => w && !/^(plan|roadmap|todo|tasks?|docs?)$/.test(w));
  const stem = words.join('-');
  const ids = [project.id, slug(project.name)].filter(Boolean);
  return ids.some((id) => stem === id || words.includes(id) || stem.startsWith(id + '-') || stem.endsWith('-' + id));
}

// The plan files this project shows: its folder's, minus any file that is a
// project's brief, assigned as the header explains.
export function plansFor(project, projects, now = Date.now()) {
  if (!project.folder || project.plans === false) return [];
  const live = projects.filter((p) => !p.hidden && p.folder && path.resolve(p.folder) === path.resolve(project.folder));
  const briefs = new Set(projects.map((p) => p.brief && p.folder ? path.resolve(p.folder, p.brief) : null).filter(Boolean));
  const main = live.find((p) => p.main) || (live.length === 1 ? live[0] : null);
  return folderPlans(project.folder, now).filter((pl) => {
    if (briefs.has(path.resolve(pl.file)) || /^(BRIEF|HANDOFF)/i.test(path.basename(pl.file))) return false;
    const named = live.filter((p) => names(pl.file, p));
    const owner = named.length === 1 ? named[0] : main;
    return owner && owner.id === project.id;
  }).map(({ file, ...rest }) => rest);
}
