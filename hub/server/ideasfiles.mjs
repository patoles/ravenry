// Ideas as files: one markdown file per idea in <RAVENRY_HOME>/pages/ideas/
// (the folder the shipped Ideas page reads, defaults/ideas.page.yaml), and
// the one-time move off <RAVENRY_HOME>/ideas.json.
//
//   ideas/<name>.md              title, stage, pitch, status, picture, id:
//                                the idea itself, which you or an agent may
//                                edit like any page item
//   ideas/.archive/<name>.md     an idea dropped or turned into a project
//   ideas/pictures/              the pictures dropped or pasted on ideas
//   ideas/mockups/<id>/          each idea's mockup rounds (r1-a.png ...)
//   ideas/.ravenry/<id>.json     Ravenry's own record of an idea: its
//                                thread with the agent, its mockup rounds,
//                                a reply on its way
//   ideas/.ravenry/board.json    the brainstorm on its way, the last one
//
// Stages in the file are the page's words (spark, mockup, greenlit, parked);
// the hub's ideas code keeps its own (spark, mock, green, park).
//
// The board writes an idea file field by field (patchItem), never as a
// whole, so a comment or a field someone added stays. The migration copies
// everything and deletes nothing: ideas.json and ~/.ravenry/ideas/ stay
// where they are, a copy of both goes to backups/ideas-<when>/ first, and a
// marker (.ravenry/migrated.json) makes a second run do nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as pf from './vendor/page-format.mjs';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE_STAGE = { spark: 'spark', mock: 'mockup', green: 'greenlit', park: 'parked' };
export const HUB_STAGE = { spark: 'spark', mockup: 'mock', greenlit: 'green', parked: 'park' };

export function dirsOf(home = RAVENRY_HOME) {
  const dir = path.join(home, 'pages', 'ideas');
  return {
    home, dir, archive: path.join(dir, '.archive'), own: path.join(dir, '.ravenry'), pictures: path.join(dir, 'pictures'),
    mockups: path.join(dir, 'mockups'), board: path.join(dir, '.ravenry', 'board.json'), marker: path.join(dir, '.ravenry', 'migrated.json'),
    oldJson: path.join(home, 'ideas.json'), oldDir: path.join(home, 'ideas'),
  };
}

function write(file, text, { fresh = false } = {}) {
  assertDataWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    if (fresh) { fs.linkSync(tmp, file); fs.rmSync(tmp, { force: true }); } else fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// Where the hub's picture names point in the new folder: a dropped picture
// "<id>-<t>.png" is in pictures/, a mockup "<id>/mockups/r1-a.png" in
// mockups/<id>/r1-a.png.
export function picturePathOf(img) {
  if (!img) return null;
  const m = String(img).match(/^([\w-]+)\/mockups\/(r\d{1,3}-[abc]\.png)$/);
  if (m) return `mockups/${m[1]}/${m[2]}`;
  return `pictures/${path.basename(String(img))}`;
}
export function imgOf(picture) {
  if (!picture) return null;
  const s = String(picture);
  const m = s.match(/^mockups\/([\w-]+)\/(r\d{1,3}-[abc]\.png)$/);
  if (m) return `${m[1]}/mockups/${m[2]}`;
  if (s.startsWith('pictures/') && !s.slice(9).includes('/')) return s.slice(9);
  return null;
}

// The fields an idea's file holds, from the hub's idea.
export function fileFields(it) {
  return {
    title: it.name, stage: FILE_STAGE[it.stage] || 'spark', pitch: it.pitch || null, status: it.status || null,
    picture: it.img ? picturePathOf(it.img) : null, id: it.id,
  };
}

// Ravenry's own record of an idea: everything but the file's fields.
export function ownRecord(it) {
  const { name: _n, stage: _s, pitch: _p, status: _t, img: _i, id: _d, archived: _a, file: _f, hash: _h, fields: _x, ...rest } = it;
  return rest;
}

// ---------------------------------------------------------------- reading

/** Every idea in the folder (live, then archived), as the hub's ideas code
 * holds them: { id, name, stage, pitch, status, img, ..., archived, file,
 * hash, fields }. An idea file with no id takes its file name's. */
export function readAll(home = RAVENRY_HOME) {
  const d = dirsOf(home);
  const out = [];
  for (const [folder, archived] of [[d.dir, false], [d.archive, true]]) {
    let names = [];
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const n of names.sort()) {
      if (!n.toLowerCase().endsWith('.md') || n.startsWith('.')) continue;
      const file = path.join(folder, n);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const st = fs.statSync(file);
      const f = pf.parseItem(text);
      const fields = f.fields || {};
      const id = typeof fields.id === 'string' && /^[\w-]{1,64}$/.test(fields.id) ? fields.id : n.replace(/\.md$/i, '').replace(/[^\w-]/g, '-').slice(0, 64);
      const own = readJson(path.join(d.own, `${id}.json`), {}) || {};
      const title = typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : pf.firstHeading(f.body) || n.replace(/\.md$/i, '');
      out.push({
        thread: [], created: (st.birthtimeMs ? st.birthtime : st.mtime).toISOString(), updated: st.mtime.toISOString(),
        ...own,
        id, name: title, stage: HUB_STAGE[String(fields.stage || '')] || 'spark',
        pitch: typeof fields.pitch === 'string' ? fields.pitch : fields.pitch != null ? String(fields.pitch) : '',
        status: typeof fields.status === 'string' ? fields.status : fields.status != null ? String(fields.status) : '',
        img: imgOf(fields.picture) || own.img || null, archived: archived || undefined,
        file: path.relative(d.dir, file).split(path.sep).join('/'), hash: f.hash, fields,
      });
    }
  }
  return out;
}

/** The ideas folder's state, to know when to read it again. */
export function signature(home = RAVENRY_HOME) {
  const d = dirsOf(home);
  const parts = [];
  for (const folder of [d.dir, d.archive, d.own]) {
    let names = [];
    try { names = fs.readdirSync(folder); } catch { parts.push(`${folder}:-`); continue; }
    for (const n of names.sort()) {
      if (n.endsWith('.tmp')) continue;
      try { const st = fs.statSync(path.join(folder, n)); if (st.isFile()) parts.push(`${n}:${st.size}:${st.mtimeMs}`); } catch { /* gone */ }
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------- writing

/** Writes one idea: its file field by field (a new file when it has none),
 * moved in or out of .archive/ as it is archived, and its own record. */
export function saveIdea(it, home = RAVENRY_HOME) {
  const d = dirsOf(home);
  const want = fileFields(it);
  let rel = it.file || null;
  if (rel && !fs.existsSync(path.join(d.dir, rel))) rel = null;
  if (!rel) {
    // A new idea: a file named after it.
    fs.mkdirSync(d.dir, { recursive: true });
    const taken = new Set([...fs.readdirSync(d.dir), ...(fs.existsSync(d.archive) ? fs.readdirSync(d.archive) : [])]);
    const name = pf.fileNameFor(it.name || 'idea', taken);
    const text = pf.makeItem(Object.fromEntries(Object.entries(want).filter(([, v]) => v != null && v !== '')), '', ['stage', 'pitch', 'status', 'picture', 'id']);
    rel = it.archived ? `.archive/${name}` : name;
    write(path.join(d.dir, rel), text, { fresh: true });
  } else {
    const abs = path.join(d.dir, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const cur = pf.parseItem(text);
    const patch = {};
    for (const [k, v] of Object.entries(want)) {
      const now = cur.fields[k];
      const norm = (x) => (x == null || x === '' ? null : String(x));
      if (norm(now) !== norm(v)) patch[k] = v == null || v === '' ? null : v;
    }
    // A title the file takes from its heading stays there.
    if ('title' in patch && cur.fields.title === undefined && pf.firstHeading(cur.body) === want.title) delete patch.title;
    if (Object.keys(patch).length) {
      const r = pf.patchItem(text, patch, { hash: cur.hash });
      if (r.ok) write(abs, r.text);
      else console.error(`ideas: ${rel} not written: ${r.problems ? r.problems[0].message : 'conflict'}`);
    }
    const isArch = rel.startsWith('.archive/');
    if (!!it.archived !== isArch) {
      const to = it.archived ? `.archive/${path.basename(rel)}` : path.basename(rel);
      if (!fs.existsSync(path.join(d.dir, to))) {
        assertDataWrite(path.join(d.dir, to));
        fs.mkdirSync(path.dirname(path.join(d.dir, to)), { recursive: true });
        fs.renameSync(abs, path.join(d.dir, to));
        rel = to;
      }
    }
  }
  const own = ownRecord(it);
  const ownFile = path.join(d.own, `${it.id}.json`);
  const next = JSON.stringify(own, null, 2) + '\n';
  let had = null;
  try { had = fs.readFileSync(ownFile, 'utf8'); } catch { /* new */ }
  if (had !== next) write(ownFile, next);
  return rel;
}

export function readBoard(home = RAVENRY_HOME) { return readJson(dirsOf(home).board, {}) || {}; }
export function saveBoard(b, home = RAVENRY_HOME) {
  const f = dirsOf(home).board;
  const next = JSON.stringify(b, null, 2) + '\n';
  let had = null;
  try { had = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
  if (had !== next) write(f, next);
}

// ---------------------------------------------------------------- the move

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

function copyFile(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  assertDataWrite(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  return true;
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyTree(a, b);
    else if (e.isFile() && copyFile(a, b)) n++;
  }
  return n;
}

/**
 * Moves ideas.json to one file per idea, once. Returns { done: false,
 * why } when there is nothing to do (no ideas.json, or it ran already),
 * else { done: true, ideas, archived, pictures, backup }.
 */
export function migrate(home = RAVENRY_HOME, { now = new Date(), log = (s) => console.log(s) } = {}) {
  const d = dirsOf(home);
  if (fs.existsSync(d.marker)) return { done: false, why: 'ran already' };
  if (!fs.existsSync(d.oldJson)) return { done: false, why: 'no ideas.json' };
  let db;
  try { db = JSON.parse(fs.readFileSync(d.oldJson, 'utf8')); } catch (e) {
    return { done: false, why: `ideas.json cannot be read (${e.message}), so it was left as it is` };
  }
  const list = Array.isArray(db && db.ideas) ? db.ideas.filter((x) => x && x.id && /^[\w-]{1,64}$/.test(String(x.id))) : [];
  // A copy of both, first.
  const backup = path.join(home, 'backups', `ideas-${stamp(now)}`);
  copyFile(d.oldJson, path.join(backup, 'ideas.json'));
  const pics = copyTree(d.oldDir, path.join(backup, 'ideas'));
  // Into a folder of its own, renamed into place at the end, so a move that
  // stops half way leaves no half folder behind; into the existing folder
  // when there is one (ideas someone made by hand stay, the same id is
  // never written twice).
  const into = fs.existsSync(d.dir) ? d.dir : path.join(home, 'pages', `.ideas-moving-${stamp(now)}`);
  const D = { ...dirsOf(home), dir: into, archive: path.join(into, '.archive'), own: path.join(into, '.ravenry'), pictures: path.join(into, 'pictures'), mockups: path.join(into, 'mockups') };
  fs.mkdirSync(D.own, { recursive: true });
  const have = new Set(fs.existsSync(d.dir) ? readAll(home).map((x) => x.id) : []);
  let copied = 0;
  // Every picture the ideas name, and the mockup rounds, copied (never moved).
  for (const n of fs.existsSync(d.oldDir) ? fs.readdirSync(d.oldDir) : []) {
    const a = path.join(d.oldDir, n);
    let st;
    try { st = fs.statSync(a); } catch { continue; }
    if (st.isFile()) { if (copyFile(a, path.join(D.pictures, n))) copied++; }
    else if (st.isDirectory() && fs.existsSync(path.join(a, 'mockups'))) copied += copyTree(path.join(a, 'mockups'), path.join(D.mockups, n));
  }
  const homeWas = home;
  let ideas = 0, archived = 0;
  // The board's order: newest first, as ideas.json keeps it.
  const order = [];
  for (const raw of list) {
    if (have.has(String(raw.id))) continue;
    // Kept as it was, a reply or a round still running included: the board
    // that loads the folder says it restarted before the answer came, as
    // it always has.
    const it = { thread: [], ...raw, id: String(raw.id), name: String(raw.name || 'Idea').slice(0, 200), stage: FILE_STAGE[raw.stage] ? raw.stage : 'spark' };
    const taken = new Set([...fs.readdirSync(D.dir), ...(fs.existsSync(D.archive) ? fs.readdirSync(D.archive) : [])]);
    const name = pf.fileNameFor(it.name, taken);
    const fields = Object.fromEntries(Object.entries(fileFields(it)).filter(([, v]) => v != null && v !== ''));
    const rel = it.archived ? `.archive/${name}` : name;
    write(path.join(D.dir, rel), pf.makeItem(fields, '', ['stage', 'pitch', 'status', 'picture', 'id']), { fresh: true });
    write(path.join(D.own, `${it.id}.json`), JSON.stringify(ownRecord(it), null, 2) + '\n');
    order.push(it.id);
    if (it.archived) archived++; else ideas++;
  }
  const board = {};
  for (const k of ['brainstorm', 'brainstormError', 'lastBrainstorm', 'seededAt']) if (db[k]) board[k] = db[k];
  board.order = order;
  write(path.join(D.own, 'board.json'), JSON.stringify(board, null, 2) + '\n');
  const marker = { from: 'ideas.json', at: now.toISOString(), ideas, archived, pictures: copied, backup: path.relative(homeWas, backup) };
  write(path.join(D.own, 'migrated.json'), JSON.stringify(marker, null, 2) + '\n');
  if (into !== d.dir) {
    assertDataWrite(d.dir);
    fs.renameSync(into, d.dir);
  }
  log(`ideas: moved ${ideas} idea${ideas === 1 ? '' : 's'} (and ${archived} archived) from ideas.json to ${path.relative(homeWas, d.dir)}/, one file each; ${copied} picture${copied === 1 ? '' : 's'} copied; ideas.json and ideas/ are as they were, and a copy is in ${path.relative(homeWas, backup)} (${pics} file${pics === 1 ? '' : 's'})`);
  return { done: true, ideas, archived, pictures: copied, backup };
}
