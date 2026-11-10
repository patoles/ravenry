// What each session of a project changed (GET /api/projects/<id>/files),
// for "Files it changed" in a session's panel and the "Who changed what"
// grid. A session's files are the ones its pane's hooks named (ravenryd
// pane.files, PROTOCOL.md section 4, Files touched): the paths only, so
// the counts come from git here, in the folder the session works in (its
// worktree against its diff base, else the project's work tree against
// HEAD). "You" is what changed in the project's work tree that no
// session's hooks named. Nothing is cached; every git call has a short
// timeout (worktrees.mjs git()).

import fs from 'node:fs';
import path from 'node:path';
import { git, diffBase } from './worktrees.mjs';
import { withClashes } from './reviewview.mjs';

const GIT_MS = 5000;
const MAX_UNTRACKED = 200;

function real(p) {
  try { return fs.realpathSync(p); } catch {
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); }
  }
}

// The work tree's top folder, or null outside git.
export async function topOf(folder) {
  if (!folder || !fs.existsSync(folder)) return null;
  const r = await git(folder, ['rev-parse', '--show-toplevel'], { timeout: GIT_MS });
  return r.ok ? real(r.out.trim()) : null;
}

// { path (relative to the top), added, removed } of every change in a work
// tree against `base` (committed since, staged, unstaged and untracked).
export async function numstat(top, base = 'HEAD') {
  const out = new Map();
  const ns = await git(top, ['diff', '--numstat', '--no-renames', base], { timeout: GIT_MS });
  if (ns.ok) {
    for (const l of ns.out.split('\n').filter(Boolean)) {
      const [a, r, ...rest] = l.split('\t');
      const p = rest.join('\t');
      out.set(p, { path: p, added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) });
    }
  }
  const st = await git(top, ['ls-files', '--others', '--exclude-standard'], { timeout: GIT_MS });
  if (st.ok) {
    for (const p of st.out.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED)) {
      let lines = 0;
      try {
        const buf = fs.readFileSync(path.join(top, p));
        if (!buf.includes(0)) lines = buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0);
      } catch { /* gone, or a folder */ }
      out.set(p, { path: p, added: lines, removed: 0 });
    }
  }
  return out;
}

// The files a pane's hooks named, relative to `top`, newest first: those
// inside it only.
export function touchedIn(top, touches) {
  const out = [];
  const seen = new Set();
  for (const t of touches || []) {
    if (!t || !t.path || !(t.sources || []).includes('hook')) continue;
    const rel = path.relative(top, real(t.path));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push({ path: rel.split(path.sep).join('/'), at: t.at || null });
  }
  return out;
}

// The answer of GET /api/projects/<id>/files. `sessions`: [{ surfaceId,
// topic, assistant, pane, machine, worktree (its record or null), folder }],
// `filesOf(pane)` the pane's FileTouch list (pane.files) or null.
export async function projectFiles({ projectId, folder, sessions, filesOf }) {
  const root = await topOf(folder);
  const mainCounts = root ? await numstat(root) : new Map();
  const named = new Set();
  const out = [];
  for (const s of sessions) {
    const wt = s.worktree && s.worktree.state === 'open' && fs.existsSync(s.worktree.folder) ? s.worktree : null;
    const row = { surfaceId: s.surfaceId, topic: s.topic || null, assistant: s.assistant || null, pane: s.pane || null, worktree: !!wt, folder: wt ? wt.folder : root, files: [] };
    out.push(row);
    if (s.machine || !s.pane || !root) continue;
    const touches = await filesOf(s.pane);
    if (!touches) continue;
    const top = wt ? await topOf(wt.folder) : root;
    if (!top) continue;
    const counts = wt ? await numstat(top, await diffBase(wt)) : mainCounts;
    for (const f of touchedIn(top, touches)) {
      const c = counts.get(f.path);
      row.files.push({ path: f.path, added: c ? c.added : 0, removed: c ? c.removed : 0, at: f.at, ...(c ? {} : { unchanged: true }) });
      if (!wt) named.add(f.path);
    }
  }
  const you = [...mainCounts.values()].filter((c) => !named.has(c.path) && !c.path.startsWith('.inbox/'));
  // Which file another session changed too, and the grid of who changed what (reviewview.mjs).
  return withClashes({ ok: true, project: projectId, root, sessions: out, you });
}
