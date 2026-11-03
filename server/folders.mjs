// Where a Claude session really works. cmux reports the folder Claude was
// started in, and a session started in a projects folder (~/Projects)
// often works in one repo below it. The truth is in the transcript: the files its tool calls
// read and wrote, and the folders its shell commands cd'd into. Each of
// those is mapped to its git repo root; the repo that most of the recent
// calls touched is the session's real folder.
//
// Node built-ins only: the Stop hook uses this too.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const TAIL = 8 * 1024 * 1024;  // the first chunk read back from a transcript's end (then 4x, 20x)
const RECENT = 400;            // the last this many path hits decide
const MIN_HITS = 5;
const SHARE = 0.5;             // the top repo needs more than half of the hits

// Places a tool call touches that are never a project.
const IGNORE = [
  path.join(HOME, '.claude'), path.join(HOME, '.ravenry'), path.join(HOME, '.mission-control'), path.join(HOME, '.cache'),
  path.join(HOME, 'Library'), path.join(HOME, '.npm'), path.join(HOME, 'Downloads'),
  '/tmp', '/private', '/var', '/usr', '/opt', '/etc', '/bin', '/System', '/Applications',
];

const roots = new Map();     // dir -> git root or null
const sessions = new Map();  // transcript path -> { size, value }

function ignored(p) {
  return IGNORE.some((d) => p === d || p.startsWith(d + '/'));
}

// The git repo root that holds this path (walking up from the nearest folder
// that exists), or null when it is in no repo below HOME.
export function repoRoot(p) {
  let dir = path.resolve(p);
  const seen = [];
  while (dir && dir !== '/' && dir.startsWith(HOME) && dir !== HOME) {
    if (roots.has(dir)) { const r = roots.get(dir); for (const s of seen) roots.set(s, r); return r; }
    seen.push(dir);
    let root = null;
    try {
      const st = fs.statSync(path.join(dir, '.git'));
      root = dir;
      // A worktree (.claude/worktrees/agent-*, .local/wt-*) belongs to the
      // repo it was made from: its .git file says "gitdir: <repo>/.git/worktrees/<name>".
      if (st.isFile()) {
        const m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/gitdir:\s*(.+?)\/\.git\/worktrees\//);
        if (m) root = path.resolve(dir, m[1]);
      }
    } catch { /* not here */ }
    if (root) { for (const s of seen) roots.set(s, root); return root; }
    dir = path.dirname(dir);
  }
  for (const s of seen) roots.set(s, null);
  return null;
}

function expand(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  if (!path.isAbsolute(s)) { if (!cwd) return null; s = path.join(cwd, s); }
  return path.normalize(s);
}

// The paths one tool call names: file_path / path / notebook_path, and for a
// shell command the targets of its `cd` and `git -C`.
function pathsOf(input, cwd) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = expand(input[k], cwd);
    if (v) out.push(v);
  }
  if (typeof input.command === 'string') {
    const re = /(?:^|[;&|(]\s*|\s)(?:cd|git\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
    let m;
    while ((m = re.exec(input.command))) { const v = expand(m[1], cwd); if (v) out.push(v); }
  }
  return out;
}

function readRange(fd, start, end) {
  const buf = Buffer.alloc(end - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  return buf.toString('utf8');
}

// The repo roots the tool calls in these transcript lines touch, in order.
function hitsIn(lines) {
  const hits = [];
  for (const l of lines) {
    if (!l.includes('"tool_use"')) continue;
    let rec;
    try { rec = JSON.parse(l); } catch { continue; }
    if (rec.type !== 'assistant' || rec.isSidechain || !rec.message || !Array.isArray(rec.message.content)) continue;
    for (const part of rec.message.content) {
      if (!part || part.type !== 'tool_use') continue;
      const ps = pathsOf(part.input, rec.cwd);
      // A shell command with no path of its own still ran in the session's cwd.
      if (part.name === 'Bash' && !ps.length && rec.cwd) ps.push(rec.cwd);
      for (const p of ps) {
        if (ignored(p)) continue;
        const r = repoRoot(p);
        if (r) hits.push(r);
      }
    }
  }
  return hits;
}

// Reads back from the end in growing chunks until there are enough hits to
// decide (transcripts reach 100 MB), then only the bytes added since.
function scan(file, size, prev) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    if (prev && size >= prev.size) {
      const text = readRange(fd, prev.size, size);
      const cut = text.lastIndexOf('\n');
      if (cut < 0) return prev;
      const lines = text.slice(0, cut).split('\n');
      return { size: prev.size + Buffer.byteLength(text.slice(0, cut + 1)), hits: prev.hits.concat(hitsIn(lines)).slice(-RECENT) };
    }
    let hits = [];
    let upTo = size;
    for (const want of [TAIL, 4 * TAIL, 20 * TAIL]) {
      const start = Math.max(0, size - want);
      const lines = readRange(fd, start, size).split('\n');
      if (start > 0) lines.shift();
      // A half-written last line is read on the next scan.
      upTo = size - Buffer.byteLength(lines.pop() || '');
      hits = hitsIn(lines);
      if (hits.length >= RECENT / 4 || start === 0) break;
    }
    return { size: upTo, hits: hits.slice(-RECENT) };
  } finally { fs.closeSync(fd); }
}

// { folder, share, hits, repos: [[root, n], ...] } for a transcript. folder is
// null when no repo has more than half of the recent hits (or there are too
// few), and then the caller keeps the folder cmux reported.
export function sessionFolder(transcriptPath) {
  if (!transcriptPath) return null;
  let size;
  try { size = fs.statSync(transcriptPath).size; } catch { return null; }
  const c = sessions.get(transcriptPath);
  if (c && c.size === size) return c.value;
  const sc = scan(transcriptPath, size, c && size - c.size < 64 * 1024 * 1024 ? c : null);
  if (!sc) return null;
  const recent = sc.hits;
  const counts = new Map();
  for (const r of recent) counts.set(r, (counts.get(r) || 0) + 1);
  const repos = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = repos[0];
  const share = top ? top[1] / recent.length : 0;
  const value = { folder: top && recent.length >= MIN_HITS && share > SHARE ? top[0] : null, share, hits: recent.length, repos: repos.slice(0, 5) };
  sessions.set(transcriptPath, { size: sc.size, hits: sc.hits, value });
  return value;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Folders too broad to be one project's own, whatever a project claims:
// everything below them would be "in" that project.
const BROAD = new Set(['/', '/Users', '/Volumes', '/private', '/tmp', '/private/tmp', HOME,
  ...['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Developer', '.Trash'].map((d) => path.join(HOME, d))]);

// A folder that cannot hold a session by folder: one of the above, the
// home folder or any folder above it, the projects root (`root`, when
// known), or a folder in no git repo that holds other projects' folders
// (a projects folder held by an idea imported from a cmux workspace that
// sat there). A project with such a folder gets sessions only through
// its workspace ids, never by folder.
export function isBroadFolder(folder, projects = [], root = null) {
  if (!folder) return false;
  const f = path.resolve(folder);
  if (BROAD.has(f) || inside(HOME, f)) return true;
  if (root && f === path.resolve(String(root).replace(/^~(?=\/|$)/, HOME))) return true;
  const holds = (projects || []).some((p) => p && p.folder && path.resolve(p.folder) !== f && inside(path.resolve(p.folder), f));
  return holds && !repoRoot(f);
}

// Which of the projects that list this workspace owns this tab. In order:
// the project that names the surface in its "surfaces"; the project whose
// folder is the session's real folder (or the closest one around or inside
// it, never a too-broad one); the workspace's home project, the one that names none of this
// workspace's tabs (a project split off a workspace names its tabs, so a new
// tab with nothing to go on stays with the home project). `real` is
// sessionFolder()'s folder or null; `tabs` the workspace's surface ids, when
// known.
export function ownerOf(candidates, surfaceId, real, tabs = null, { projects = candidates, root = null } = {}) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const names = (p, id) => Array.isArray(p.surfaces) && p.surfaces.includes(id);
  const named = candidates.find((p) => names(p, surfaceId));
  if (named) return named;
  if (real) {
    // A too-broad folder (isBroadFolder) never wins by folder.
    const near = candidates.filter((p) => p.folder && !isBroadFolder(p.folder, projects, root) && (inside(p.folder, real) || inside(real, p.folder)))
      .sort((a, b) => b.folder.length - a.folder.length);
    if (near.length) return near[0];
  }
  const home = candidates.filter((p) => !(Array.isArray(p.surfaces) && p.surfaces.length) || (tabs && !tabs.some((id) => names(p, id))));
  return home[0] || candidates[0];
}
