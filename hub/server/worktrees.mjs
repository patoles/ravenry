// A git worktree per session (POST /api/sessions/start with worktree:
// true), and what the review pane reads and does with it: the session's
// diff, and the merge back (hub/docs/SESSIONS.md, Worktrees).
//
// A session started this way works on its own branch, ravenry/<slug>, in a
// sibling folder of the repository, <parent>/<repo folder>-<slug>, so
// parallel sessions of one project never write the same files. The record
// of each one is <RAVENRY_HOME>/worktrees.json:
//
//   { "version": 1, "worktrees": [ {
//       surfaceId, pane, machine (null: this computer), projectId,
//       repo (the main work tree's top folder), folder (the worktree's),
//       cwd (where the session started: the same subfolder of the
//       worktree as the project folder is of the repository),
//       branch, base (the commit it started from), baseBranch (the branch
//       the repository had checked out, or null when detached),
//       name, created_at, state ("open", "merged" or "discarded"),
//       merged? { mode, commit, before, tip, at } (before: the base
//       branch's commit before the merge, tip: the session branch's),
//       unmerged_at?, branch_deleted_at?
//   } ] }
//
// Every git command runs with execFile (no shell), with a timeout.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { RAVENRY_HOME, assertDataWrite, isTestEnv, inRepoTmp } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'worktrees.json');
const GIT_MS = 15000;
export const MAX_DIFF = 2 * 1024 * 1024;
const MAX_FILES = 500;

export function git(cwd, args, { timeout = GIT_MS, maxBuffer = 16 * 1024 * 1024, okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ ok: okCodes.includes(code), code, out: String(stdout || ''), err: String(stderr || (err && err.killed ? 'git took too long' : '') || (err && typeof err.code !== 'number' ? err.message : '')).trim() });
    });
  });
}

// ------------------------------------------------------------ the record

export function load(file = FILE) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.worktrees) ? j.worktrees : []; } catch { return []; }
}
function save(list, file = FILE) {
  assertDataWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, worktrees: list }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function bySurface(surfaceId, file = FILE) { return load(file).find((w) => w.surfaceId === surfaceId) || null; }
export function record(w, file = FILE) { const list = load(file).filter((x) => x.surfaceId !== w.surfaceId); list.push(w); save(list, file); return w; }
function update(surfaceId, patch, file = FILE) {
  const list = load(file);
  const w = list.find((x) => x.surfaceId === surfaceId);
  if (!w) return null;
  Object.assign(w, patch);
  save(list, file);
  return w;
}
// [{ folder, projectId }] of the open worktrees, for decisions.resolveProject.
export const folders = (file = FILE) => load(file).filter((w) => w.state === 'open' && w.projectId).map((w) => ({ folder: w.folder, projectId: w.projectId }));

// ------------------------------------------------------------ making one

export function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function testRepo(repo) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const r = real(repo);
  const under = (dir) => { const x = path.relative(real(dir), r); return !!x && !x.startsWith('..') && !path.isAbsolute(x); };
  return inRepoTmp(r) || under(os.tmpdir()) || under('/tmp') || under('/private/tmp');
}

// Makes the branch and its worktree for a session in `folder` (a git work
// tree). `name` names the session (else a short id). Returns { ok, repo,
// folder, cwd, branch, base, baseBranch, name } or { ok: false, status, error }.
export async function create(folder, { name = null } = {}) {
  if (!folder || !path.isAbsolute(folder) || !fs.existsSync(folder)) return { ok: false, status: 400, error: 'The session\'s folder does not exist here.' };
  const top = await git(folder, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, status: 409, error: `${folder} is not in a git repository, so it cannot have a worktree.` };
  // The main work tree, even when the folder is itself a linked worktree.
  const common = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repo = common.ok && path.basename(common.out.trim()) === '.git' ? path.dirname(common.out.trim()) : top.out.trim();
  // A test only ever makes a worktree of a scratch repository: inside a
  // .tmp test folder whose repository is that folder's own, or in the
  // system's temporary folders. On 2026-11-07 a test asked for one in a
  // folder of .tmp that had no repository of its own, and git found this
  // source tree's, so the worktree landed beside the real checkout.
  if (isTestEnv() && !testRepo(repo)) return { ok: false, status: 409, error: `A test makes worktrees of scratch repositories only, not of ${repo}.` };
  const head = await git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { ok: false, status: 409, error: 'The repository has no commit yet, so there is nothing to branch from.' };
  const br = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] });
  const baseBranch = br.code === 0 ? br.out.trim() : null;
  const base = head.out.trim();
  const id = crypto.randomBytes(3).toString('hex');
  let s = slug(name) || `session-${id}`;
  const parent = path.dirname(repo);
  const repoName = path.basename(repo);
  for (let n = 1; ; n++) {
    const cand = n === 1 ? s : `${s}-${n}`;
    const exists = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/ravenry/${cand}`], { okCodes: [0, 1] });
    if (exists.code === 1 && !fs.existsSync(path.join(parent, `${repoName}-${cand}`))) { s = cand; break; }
    if (n > 50) return { ok: false, status: 409, error: 'Too many worktrees with that name already.' };
  }
  const branch = `ravenry/${s}`;
  const wt = path.join(parent, `${repoName}-${s}`);
  const add = await git(repo, ['worktree', 'add', '-b', branch, wt, base], { timeout: 60000 });
  if (!add.ok) return { ok: false, status: 500, error: `git could not make the worktree: ${add.err || add.out}` };
  const rel = path.relative(top.out.trim(), folder);
  const cwd = rel && !rel.startsWith('..') && fs.existsSync(path.join(wt, rel)) ? path.join(wt, rel) : wt;
  return { ok: true, repo, folder: wt, cwd, branch, base, baseBranch, name: s };
}

// Takes a worktree and its branch away (a start that failed, a discard).
// `force` also throws away uncommitted changes and an unmerged branch;
// `keepBranch` (after a merge) leaves the branch.
export async function removeTree(w, { force = false, keepBranch = false } = {}) {
  const out = [];
  if (fs.existsSync(w.folder)) {
    const r = await git(w.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), w.folder], { timeout: 60000 });
    if (!r.ok) return { ok: false, error: `git could not remove the worktree: ${r.err}` };
    out.push('worktree');
  } else {
    await git(w.repo, ['worktree', 'prune']);
  }
  if (keepBranch) return { ok: true, removed: out };
  const d = await git(w.repo, ['branch', force ? '-D' : '-d', w.branch]);
  if (d.ok) out.push('branch');
  else if (!/not found/.test(d.err)) return { ok: false, error: `git kept the branch ${w.branch}: ${d.err}` };
  return { ok: true, removed: out };
}

// ------------------------------------------------------------ the diff

// The uncommitted files of a work tree ("M path", "?? path", ...).
async function dirty(folder) {
  const r = await git(folder, ['status', '--porcelain=v1', '-uall']);
  return r.ok ? r.out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })) : null;
}

// Where the session's work starts: the merge base with the branch it came
// from (what merging brings), else the commit it started on.
export async function diffBase(w) {
  if (w.baseBranch) {
    const mb = await git(w.repo, ['merge-base', w.baseBranch, w.branch]);
    if (mb.ok && mb.out.trim()) return mb.out.trim();
  }
  return w.base;
}

// The session's work against its base, committed and not: { ok, base,
// head, files: [{ path, added, removed, status, binary? }], diff (unified
// text), truncated, uncommitted: [paths] }.
export async function diff(w, { max = MAX_DIFF } = {}) {
  if (!fs.existsSync(w.folder)) return { ok: false, status: 410, error: 'Its worktree is gone.' };
  const base = await diffBase(w);
  const head = (await git(w.folder, ['rev-parse', 'HEAD'])).out.trim();
  const ns = await git(w.folder, ['diff', '--numstat', '-M', base]);
  const ds = await git(w.folder, ['diff', '--name-status', '-M', base]);
  if (!ns.ok || !ds.ok) return { ok: false, status: 500, error: `git diff failed: ${ns.err || ds.err}` };
  const status = new Map(ds.out.split('\n').filter(Boolean).map((l) => { const p = l.split('\t'); return [p[p.length - 1], p[0][0]]; }));
  const files = ns.out.split('\n').filter(Boolean).map((l) => {
    const [a, r, ...rest] = l.split('\t');
    const p = rest.join('\t');
    const name = p.includes(' => ') ? (status.has(p) ? p : [...status.keys()].find((k) => p.endsWith(k.split('/').pop())) || p) : p;
    return { path: name, added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r), status: status.get(name) || 'M', ...(a === '-' ? { binary: true } : {}) };
  });
  let text = (await git(w.folder, ['diff', '-M', base], { maxBuffer: max * 2 + 1024 })).out;
  const st = await dirty(w.folder) || [];
  const untracked = st.filter((x) => x.status === '??').map((x) => x.path);
  for (const f of untracked.slice(0, MAX_FILES)) {
    const u = await git(w.folder, ['diff', '--no-index', '--', '/dev/null', f], { okCodes: [0, 1] });
    const lines = u.out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    files.push({ path: f, added: lines, removed: 0, status: 'A', untracked: true, ...(/^Binary files/m.test(u.out) ? { binary: true } : {}) });
    if (text.length < max) text += u.out;
  }
  const truncated = text.length > max || files.length > MAX_FILES;
  return { ok: true, base, head, branch: w.branch, files: files.slice(0, MAX_FILES), diff: text.length > max ? text.slice(0, max) : text, truncated, uncommitted: st.map((x) => x.path), check: await mergeCheck(w, base) };
}

// Whether the session's branch merges cleanly into the branch it came
// from now (git merge-tree, which touches no work tree): { clean,
// conflicts, moved (commits on the base branch since the merge base),
// ahead (the session's commits past it) }, or null without a base branch.
export async function mergeCheck(w, mergeBase = null) {
  if (!w.baseBranch) return null;
  const mb = mergeBase || await diffBase(w);
  const count = async (range) => { const r = await git(w.repo, ['rev-list', '--count', range]); return r.ok ? Number(r.out.trim()) || 0 : 0; };
  const mt = await git(w.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', w.baseBranch, w.branch], { okCodes: [0, 1] });
  const conflicts = mt.code === 1 ? mt.out.split('\n').slice(1).map((x) => x.trim()).filter(Boolean) : [];
  return { clean: mt.code === 0, conflicts, moved: await count(`${mb}..${w.baseBranch}`), ahead: await count(`${mb}..${w.branch}`) };
}

// ------------------------------------------------------------ merging

// Merges the session's branch into the branch it came from, in the
// repository's main work tree, then takes the worktree away and keeps the
// branch (the person deletes it, or undoes the merge with it). mode "ff": only when the base branch has not moved since (else
// it says so); "merge": a merge commit. Never a squash: the agent's own
// commits stay in the history either way. Refused, with the files named,
// when the session's worktree has uncommitted changes, when the two
// branches conflict (checked first with `git merge-tree --write-tree`,
// which touches no work tree), or when the main work tree is not on the
// base branch or has changes of its own in the way.
export async function merge(w, { mode = 'ff', message = null } = {}) {
  if (w.state !== 'open') return { ok: false, status: 409, error: `This session's work was ${w.state} already.` };
  if (mode !== 'ff' && mode !== 'merge') return { ok: false, status: 400, error: 'mode is ff or merge.' };
  if (!w.baseBranch) return { ok: false, status: 409, error: 'The repository was on no branch (a detached HEAD) when the session started, so there is no branch to merge into. Merge it by hand.' };
  if (!fs.existsSync(w.folder)) return { ok: false, status: 410, error: 'Its worktree is gone.' };
  const wd = await dirty(w.folder);
  if (wd === null) return { ok: false, status: 500, error: 'git status failed in the worktree.' };
  if (wd.length) return { ok: false, status: 409, error: `The session has uncommitted changes in ${wd.length} file${wd.length > 1 ? 's' : ''}. Ask it to commit them first.`, files: wd.map((x) => x.path), reason: 'uncommitted' };
  const cur = await git(w.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] });
  if (cur.out.trim() !== w.baseBranch) return { ok: false, status: 409, error: `The repository has ${cur.code === 0 ? cur.out.trim() : 'no branch'} checked out, not ${w.baseBranch}. Check out ${w.baseBranch} there first.`, reason: 'branch' };
  const tip = (await git(w.repo, ['rev-parse', w.branch])).out.trim();
  const baseTip = (await git(w.repo, ['rev-parse', w.baseBranch])).out.trim();
  const ahead = await git(w.repo, ['rev-list', '--count', `${w.baseBranch}..${w.branch}`]);
  if (ahead.ok && Number(ahead.out.trim()) === 0) return { ok: false, status: 409, error: 'The session made no commit, so there is nothing to merge.', reason: 'empty' };
  const mt = await git(w.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', w.baseBranch, w.branch], { okCodes: [0, 1] });
  if (mt.code === 1) {
    const files = mt.out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
    return { ok: false, status: 409, error: `Merging would conflict in ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}. Nothing was merged.`, files, reason: 'conflict' };
  }
  if (!mt.ok) return { ok: false, status: 500, error: `git merge-tree failed: ${mt.err}` };
  const isAnc = await git(w.repo, ['merge-base', '--is-ancestor', baseTip, tip], { okCodes: [0, 1] });
  const canFf = isAnc.code === 0;
  if (mode === 'ff' && !canFf) return { ok: false, status: 409, error: `${w.baseBranch} moved on since the session started, so it cannot fast-forward. Merge with a merge commit instead.`, reason: 'moved' };
  const args = mode === 'ff'
    ? ['merge', '--ff-only', w.branch]
    : ['merge', '--no-ff', '--no-edit', '-m', String(message || `Merge ${w.branch} (Ravenry session ${w.name})`).slice(0, 2000), w.branch];
  const m = await git(w.repo, args, { timeout: 60000 });
  if (!m.ok) {
    // Changes of the main work tree in the way: git refused before touching
    // anything, and says which files.
    const files = [...m.err.matchAll(/^\t(.+)$/gm)].map((x) => x[1].trim());
    await git(w.repo, ['merge', '--abort'], { okCodes: [0, 128] });
    return { ok: false, status: 409, error: `git did not merge: ${m.err.split('\n')[0]}${files.length ? ` (${files.join(', ')})` : ''}. Nothing was merged.`, files, reason: 'refused' };
  }
  const commit = (await git(w.repo, ['rev-parse', 'HEAD'])).out.trim();
  const rm = await removeTree(w, { keepBranch: true });
  const at = new Date().toISOString();
  update(w.surfaceId, { state: 'merged', merged: { mode, commit, before: baseTip, tip, at } });
  return { ok: true, mode, commit, before: baseTip, branch: w.branch, cleanup: rm.ok ? rm.removed : [], ...(rm.ok ? {} : { cleanupError: rm.error }) };
}

// Undoes a merge: the base branch goes back to where it was before it
// (git reset --keep, which keeps the main work tree's own changes and
// refuses when they are in the way), only while it still points at the
// merge and is checked out there; then the worktree comes back on the
// kept branch (made again at its tip when it was deleted), in the same
// folder, and the session's work is open again.
export async function unmerge(w) {
  if (w.state !== 'merged' || !w.merged || !w.merged.before) return { ok: false, status: 409, error: 'This session\'s work is not merged, or was merged before Ravenry could undo a merge.' };
  const m = w.merged;
  const cur = await git(w.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] });
  if (cur.out.trim() !== w.baseBranch) return { ok: false, status: 409, error: `The repository has ${cur.code === 0 ? cur.out.trim() : 'no branch'} checked out, not ${w.baseBranch}. Check out ${w.baseBranch} there first.`, reason: 'branch' };
  const now = (await git(w.repo, ['rev-parse', w.baseBranch])).out.trim();
  if (now !== m.commit) {
    const n = await git(w.repo, ['rev-list', '--count', `${m.commit}..${w.baseBranch}`]);
    return { ok: false, status: 409, error: `${w.baseBranch} moved on since the merge${n.ok && Number(n.out.trim()) ? ` (${n.out.trim()} more commit${n.out.trim() === '1' ? '' : 's'})` : ''}, so undoing it would throw that away. Revert the merge by hand instead.`, reason: 'moved' };
  }
  if (fs.existsSync(w.folder)) return { ok: false, status: 409, error: `${w.folder} exists, so the worktree cannot come back there.`, reason: 'folder' };
  const reset = await git(w.repo, ['reset', '--keep', m.before], { timeout: 60000 });
  if (!reset.ok) return { ok: false, status: 409, error: `git did not undo the merge: ${reset.err.split('\n')[0]}. Nothing changed.`, reason: 'refused' };
  const has = await git(w.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${w.branch}`], { okCodes: [0, 1] });
  if (has.code === 1 && m.tip) await git(w.repo, ['branch', w.branch, m.tip]);
  const add = await git(w.repo, ['worktree', 'add', w.folder, w.branch], { timeout: 60000 });
  if (!add.ok) return { ok: false, status: 500, error: `The merge is undone, but git could not make the worktree again: ${add.err}`, before: m.before };
  update(w.surfaceId, { state: 'open', unmerged_at: new Date().toISOString(), branch_deleted_at: null });
  return { ok: true, before: m.before };
}

// Deletes a merged session's kept branch (git branch -d: refused while it
// holds work the base branch does not have).
export async function deleteBranch(w) {
  if (w.state !== 'merged') return { ok: false, status: 409, error: w.state === 'open' ? 'Its work is not merged yet; discard it instead to throw it away.' : `This session's work was ${w.state}.` };
  if (w.branch_deleted_at) return { ok: false, status: 409, error: `${w.branch} was deleted already.` };
  const d = await git(w.repo, ['branch', '-d', w.branch]);
  if (!d.ok && !/not found/.test(d.err)) return { ok: false, status: 409, error: `git kept ${w.branch}: ${d.err.split('\n')[0]}` };
  update(w.surfaceId, { branch_deleted_at: new Date().toISOString() });
  return { ok: true };
}

// Throws the session's work away: its worktree (uncommitted changes
// included) and its branch.
export async function discard(w) {
  if (w.state !== 'open') return { ok: false, status: 409, error: `This session's work was ${w.state} already.` };
  const rm = await removeTree(w, { force: true });
  if (!rm.ok) return { ok: false, status: 500, error: rm.error };
  update(w.surfaceId, { state: 'discarded', discarded_at: new Date().toISOString() });
  return { ok: true, removed: rm.removed };
}

// Records a session's worktree once its pane is known.
export function remember(made, { surfaceId, pane, projectId, machine = null }) {
  return record({ surfaceId, pane, machine, projectId: projectId || null, repo: made.repo, folder: made.folder, cwd: made.cwd, branch: made.branch, base: made.base, baseBranch: made.baseBranch, name: made.name, created_at: new Date().toISOString(), state: 'open' });
}

// The words a review comment reaches the session with.
export function commentText({ file, line, text, side = null }) {
  const where = `${file}${line ? ` line ${line}` : ''}${side === 'old' ? ' (the old side of the diff)' : ''}`;
  return `Review comment on ${where}: ${String(text).replace(/\s*\n\s*/g, ' ').trim()}`;
}
