// Proves a git worktree per session and the review pane's API
// (server/worktrees.mjs, docs/SESSIONS.md, Worktrees), on scratch git
// repositories only:
//   - a worktree is a branch ravenry/<slug> in a sibling folder
//     <repo>-<slug>, from the repository's HEAD, and the session starts in
//     the same subfolder the project is in;
//   - its diff: committed and uncommitted work against its base, untracked
//     files included, with added and removed counts;
//   - merge: refused while the session has uncommitted changes (the files
//     named), on a conflict (the files named, nothing merged), and as a
//     fast-forward once the base branch moved (it says to merge instead);
//     a fast-forward and a merge commit go through, then the worktree is
//     gone and the branch kept; a merge is undone (the base branch back,
//     the worktree back on the branch) and the kept branch deleted; the
//     diff says whether it merges cleanly now; discard throws the work
//     away;
//   - the files each session changed (server/filesview.mjs): the files its
//     hooks named, with git's counts, and the person's own changes;
//   - with RAVENRYD_BIN, on a real board and daemon: POST
//     /api/sessions/start with worktree true starts the session in its
//     worktree, GET /api/sessions/<id>/diff shows its change, a comment
//     reaches the session's pane through the send path, tagged as the
//     person's review comment when the daemon tags input, the merge,
//     unmerge, delete-branch and discard routes work, GET
//     /api/projects/<id>/files names the files a session's hooks reported
//     with their counts, and a pane's filmstrip reaches the session as a
//     GIF in the project's inbox.
// A pane's caller gets 403 on comment, merge and discard:
// tools/person-routes-test.mjs proves every person row that way.
// Usage: node tools/worktree-test.mjs [RAVENRYD_BIN=../daemon/ravenryd]
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.tmp', 'worktree-')));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
for (const d of [MC, HOME]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = MC;
const W = await import('../server/worktrees.mjs');
const FV = await import('../server/filesview.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GENV = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: GENV, encoding: 'utf8' }).trim();

// A scratch repository with one commit on main, the project in a subfolder.
function repo(name) {
  const r = path.join(T, name);
  fs.mkdirSync(path.join(r, 'app'), { recursive: true });
  g(r, 'init', '-q', '-b', 'main');
  g(r, 'config', 'user.name', 'Ravenry Test');
  g(r, 'config', 'user.email', 'test@example.invalid');
  g(r, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(r, 'app', 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(r, 'shared.txt'), 'base\n');
  g(r, 'add', '-A');
  g(r, 'commit', '-q', '-m', 'first');
  return r;
}

// ------------------------------------------------------------ without a board
const R = repo('game');
const made = await W.create(path.join(R, 'app'), { name: 'Fix the HUD!' });
check('a worktree: branch ravenry/<slug>, a sibling folder, the same subfolder, from HEAD', made.ok && made.branch === 'ravenry/fix-the-hud' && made.folder === path.join(T, 'game-fix-the-hud') && made.cwd === path.join(T, 'game-fix-the-hud', 'app') && made.base === g(R, 'rev-parse', 'HEAD') && made.baseBranch === 'main' && made.repo === R && fs.existsSync(path.join(made.cwd, 'a.txt')), JSON.stringify(made));
const again = await W.create(R, { name: 'Fix the HUD!' });
check('a second one with the same name gets its own branch and folder', again.ok && again.branch === 'ravenry/fix-the-hud-2' && again.folder === path.join(T, 'game-fix-the-hud-2'), JSON.stringify(again));
const anon = await W.create(R);
check('without a name, a short id', anon.ok && /^ravenry\/session-[0-9a-f]{6}$/.test(anon.branch));
const before = execFileSync('git', ['-C', ROOT, 'worktree', 'list'], { encoding: 'utf8' });
const inSource = await W.create(HOME);
check('a folder of .tmp with no repository of its own is refused: a test never makes a worktree of this source tree', !inSource.ok && /scratch repositories only/.test(inSource.error) && execFileSync('git', ['-C', ROOT, 'worktree', 'list'], { encoding: 'utf8' }) === before, inSource.error);
const NOGIT = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-nogit-'));
const notGit = await W.create(NOGIT);
fs.rmSync(NOGIT, { recursive: true, force: true });
check('a folder outside git is refused', !notGit.ok && notGit.status === 409, notGit.error);

const w = W.remember(made, { surfaceId: 'ravenry:paaaaaaa', pane: 'paaaaaaa', projectId: 'game' });
check('the record keeps it', W.bySurface('ravenry:paaaaaaa').branch === 'ravenry/fix-the-hud' && W.folders().length === 1);
fs.writeFileSync(path.join(made.cwd, 'a.txt'), 'one\nTWO\nthree\nfour\n');
g(made.folder, 'commit', '-q', '-am', 'hud: two is louder');
fs.writeFileSync(path.join(made.cwd, 'new.txt'), 'brand new\nfile\n');
fs.writeFileSync(path.join(made.folder, 'shared.txt'), 'base\nuncommitted\n');
const d = await W.diff(w);
const f = (p) => d.files.find((x) => x.path === p);
check('the diff: committed, uncommitted and untracked, with counts', d.ok && f('app/a.txt') && f('app/a.txt').added === 2 && f('app/a.txt').removed === 1 && f('app/new.txt') && f('app/new.txt').added === 2 && f('app/new.txt').untracked && f('shared.txt') && /\+TWO/.test(d.diff) && /\+brand new/.test(d.diff) && /\+uncommitted/.test(d.diff) && d.uncommitted.length === 2, JSON.stringify(d.files));
const dirtyM = await W.merge(w, { mode: 'ff' });
check('merge is refused while the session has uncommitted changes, naming them', !dirtyM.ok && dirtyM.reason === 'uncommitted' && dirtyM.files.includes('shared.txt') && dirtyM.files.includes('app/new.txt'), JSON.stringify(dirtyM));
g(made.folder, 'add', '-A');
g(made.folder, 'commit', '-q', '-m', 'hud: the rest');
const dc0 = await W.diff(w);
check('the diff\'s check: clean, nothing moved, two commits ahead', dc0.ok && dc0.check && dc0.check.clean === true && dc0.check.conflicts.length === 0 && dc0.check.moved === 0 && dc0.check.ahead === 2, JSON.stringify(dc0.check));
const before0 = g(R, 'rev-parse', 'main');
const tip0 = g(R, 'rev-parse', 'ravenry/fix-the-hud');
const ff = await W.merge(w, { mode: 'ff' });
const rec = W.bySurface('ravenry:paaaaaaa');
check('a fast-forward goes through, the worktree is gone and the branch kept', ff.ok && ff.mode === 'ff' && g(R, 'rev-parse', 'main') === g(R, 'rev-parse', 'HEAD') && fs.readFileSync(path.join(R, 'app', 'new.txt'), 'utf8') === 'brand new\nfile\n' && !fs.existsSync(made.folder) && g(R, 'branch', '--list', 'ravenry/fix-the-hud').includes('fix-the-hud') && rec.state === 'merged' && rec.merged.before === before0 && rec.merged.tip === tip0 && rec.merged.commit === tip0 && ff.before === before0, JSON.stringify({ ff, merged: rec.merged }));
check('a merged one is not merged twice', (await W.merge(W.bySurface('ravenry:paaaaaaa'))).status === 409);
check('an open one cannot be unmerged, nor its branch deleted', (await W.unmerge(W.bySurface('ravenry:pbbbbbbb') || { state: 'open' })).status === 409);
const un = await W.unmerge(W.bySurface('ravenry:paaaaaaa'));
const rec2 = W.bySurface('ravenry:paaaaaaa');
check('unmerge: main back where it was, the worktree back on the branch, open again', un.ok && g(R, 'rev-parse', 'main') === before0 && !fs.existsSync(path.join(R, 'app', 'new.txt')) && fs.existsSync(path.join(made.folder, 'app', 'new.txt')) && g(made.folder, 'rev-parse', 'HEAD') === tip0 && rec2.state === 'open' && !!rec2.unmerged_at && g(R, 'status', '--porcelain') === '', JSON.stringify(un));
check('a branch of open work is not deleted', (await W.deleteBranch(rec2)).status === 409);
const ff2 = await W.merge(rec2, { mode: 'ff' });
check('and it merges again', ff2.ok && g(R, 'rev-parse', 'main') === tip0, JSON.stringify(ff2));
// Main moves on after the merge: undoing it would throw that away.
fs.writeFileSync(path.join(R, 'later.txt'), 'later\n');
g(R, 'add', '-A'); g(R, 'commit', '-q', '-m', 'later');
const late = await W.unmerge(W.bySurface('ravenry:paaaaaaa'));
check('unmerge is refused once the base branch moved on, and nothing changes', !late.ok && late.status === 409 && late.reason === 'moved' && /1 more commit/.test(late.error) && fs.existsSync(path.join(R, 'later.txt')) && !fs.existsSync(made.folder), JSON.stringify(late));
const del = await W.deleteBranch(W.bySurface('ravenry:paaaaaaa'));
check('delete-branch deletes the kept branch and says so in the record', del.ok && !g(R, 'branch', '--list', 'ravenry/fix-the-hud') && !!W.bySurface('ravenry:paaaaaaa').branch_deleted_at, JSON.stringify(del));
check('and not twice', (await W.deleteBranch(W.bySurface('ravenry:paaaaaaa'))).status === 409);

// Two sessions on the same line: the first lands, the second conflicts.
const w2 = W.remember(again, { surfaceId: 'ravenry:pbbbbbbb', pane: 'pbbbbbbb', projectId: 'game' });
fs.writeFileSync(path.join(again.folder, 'shared.txt'), 'theirs\n');
g(again.folder, 'commit', '-q', '-am', 'shared: theirs');
fs.writeFileSync(path.join(R, 'shared.txt'), 'ours\n');
g(R, 'commit', '-q', '-am', 'shared: ours');
const head0 = g(R, 'rev-parse', 'HEAD');
const dc1 = await W.diff(w2);
check('the diff\'s check names the conflict and how far the base moved', dc1.ok && dc1.check.clean === false && dc1.check.conflicts.join() === 'shared.txt' && dc1.check.moved >= 1 && dc1.check.ahead === 1, JSON.stringify(dc1.check));
const conflict = await W.merge(w2, { mode: 'merge' });
check('a conflict is refused with the files listed, and nothing is merged', !conflict.ok && conflict.reason === 'conflict' && conflict.files.join() === 'shared.txt' && g(R, 'rev-parse', 'HEAD') === head0 && g(R, 'status', '--porcelain') === '' && fs.existsSync(again.folder), JSON.stringify(conflict));
// Resolved in the session: it takes ours, then adds a file.
fs.writeFileSync(path.join(again.folder, 'shared.txt'), 'base\n');
fs.writeFileSync(path.join(again.folder, 'other.txt'), 'x\n');
g(again.folder, 'add', '-A');
g(again.folder, 'commit', '-q', '-m', 'other');
const moved = await W.merge(w2, { mode: 'ff' });
check('a fast-forward after the base branch moved is refused, and says to merge', !moved.ok && moved.reason === 'moved' && /merge commit/.test(moved.error), JSON.stringify(moved));
const mc = await W.merge(w2, { mode: 'merge', message: 'Merge the second session' });
check('a merge commit goes through, then the worktree is gone and the branch kept', mc.ok && g(R, 'log', '-1', '--format=%s') === 'Merge the second session' && g(R, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length === 3 && fs.existsSync(path.join(R, 'other.txt')) && !fs.existsSync(again.folder) && g(R, 'branch', '--list', 'ravenry/fix-the-hud-2').includes('fix-the-hud-2'), JSON.stringify(mc));
const un2 = await W.unmerge(W.bySurface('ravenry:pbbbbbbb'));
check('a merge commit is undone too', un2.ok && g(R, 'rev-parse', 'main') === mc.before && !fs.existsSync(path.join(R, 'other.txt')) && fs.existsSync(path.join(again.folder, 'other.txt')), JSON.stringify(un2));
await W.discard(W.bySurface('ravenry:pbbbbbbb'));
const w3 = W.remember(anon, { surfaceId: 'ravenry:pccccccc', pane: 'pccccccc', projectId: 'game' });
fs.writeFileSync(path.join(anon.folder, 'scratch.txt'), 'throw me away\n');
const empty = await W.merge(w3, { mode: 'ff' });
check('merge is refused with uncommitted work, and with no commit at all', !empty.ok && empty.reason === 'uncommitted');
const disc = await W.discard(w3);
check('discard throws the worktree and the branch away, uncommitted changes included', disc.ok && !fs.existsSync(anon.folder) && !g(R, 'branch', '--list', anon.branch) && W.bySurface('ravenry:pccccccc').state === 'discarded', JSON.stringify(disc));
check('the main work tree is clean after all of it', g(R, 'status', '--porcelain') === '');
// The files each session changed: two sessions in the work tree, one in a
// worktree, and the person's own change.
{
  const F = repo('files');
  fs.writeFileSync(path.join(F, 'app', 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(F, 'app', 'b.txt'), 'new\nfile\nhere\n');
  fs.writeFileSync(path.join(F, 'shared.txt'), 'base\nmine\n');
  const wm = await W.create(F, { name: 'side' });
  const wr = W.remember(wm, { surfaceId: 'ravenry:peeeeeee', pane: 'peeeeeee', projectId: 'files' });
  fs.writeFileSync(path.join(wm.folder, 'app', 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  g(wm.folder, 'commit', '-q', '-am', 'side');
  const touches = {
    pdddddd1: [{ path: path.join(F, 'app', 'a.txt'), sources: ['hook'], tool: 'Edit', count: 1, at: '2026-11-07T10:00:00Z' }, { path: '/elsewhere/x.txt', sources: ['hook'] }, { path: path.join(F, 'shared.txt'), sources: ['git'] }],
    pdddddd2: [{ path: path.join(F, 'app', 'b.txt'), sources: ['hook', 'git'], tool: 'Write', count: 1, at: '2026-11-07T10:01:00Z' }],
    peeeeeee: [{ path: path.join(wm.folder, 'app', 'a.txt'), sources: ['hook'], tool: 'Edit', count: 2, at: '2026-11-07T10:02:00Z' }],
  };
  const pf = await FV.projectFiles({
    projectId: 'files', folder: path.join(F, 'app'), filesOf: async (p) => touches[p] || null,
    sessions: [
      { surfaceId: 'ravenry:pdddddd1', topic: 'One', assistant: 'claude', pane: 'pdddddd1', worktree: null },
      { surfaceId: 'ravenry:pdddddd2', topic: 'Two', assistant: 'codex', pane: 'pdddddd2', worktree: null },
      { surfaceId: 'ravenry:peeeeeee', topic: 'Side', assistant: 'codex', pane: 'peeeeeee', worktree: wr },
      { surfaceId: 'ravenry:pfffffff', topic: 'Far', assistant: 'claude', pane: 'pfffffff', machine: 'devbox', worktree: null },
    ],
  });
  const S = (t) => pf.sessions.find((x) => x.topic === t);
  check('files: a session\'s hooks name its files, relative to the repository, with git\'s counts; outside ones and git-only ones left out', pf.ok && pf.root === F && S('One').files.length === 1 && S('One').files[0].path === 'app/a.txt' && S('One').files[0].added === 1 && S('One').files[0].removed === 1 && S('One').files[0].at === '2026-11-07T10:00:00Z', JSON.stringify(pf.sessions));
  check('files: an untracked new file counts its lines', S('Two').files[0].path === 'app/b.txt' && S('Two').files[0].added === 3 && S('Two').files[0].removed === 0);
  check('files: a worktree session counts against its own base', S('Side').worktree === true && S('Side').folder === wm.folder && S('Side').files[0].path === 'app/a.txt' && S('Side').files[0].added === 2 && S('Side').files[0].removed === 0);
  check('files: a session on another machine lists none', S('Far').files.length === 0);
  check('files: you is what no session\'s hooks named', pf.you.length === 1 && pf.you[0].path === 'shared.txt' && pf.you[0].added === 1, JSON.stringify(pf.you));
  await W.discard(wr);
}
check('a comment\'s words', W.commentText({ file: 'app/a.txt', line: 2, text: 'Keep it lowercase.\nLike the rest.' }) === 'Review comment on app/a.txt line 2: Keep it lowercase. Like the rest.' && /the old side/.test(W.commentText({ file: 'x', line: 1, text: 'y', side: 'old' })));

// ------------------------------------------------------------ on a real board and daemon
const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  the board part: set RAVENRYD_BIN to a ravenryd binary');
  console.log(fails ? `\n${fails} failed` : `\nall passed  (scratch: ${T})`);
  process.exit(fails ? 1 : 0);
}
const P = repo('proj');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: path.join(P, 'app'), workspaces: [], brief: null, sendToAnySurface: true }] }, null, 2));
const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'rvw-'));
const RUN = path.join(DD, 'run');
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(DD, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
const PORT = 4797;
let boardLog = '';
const SETTINGS = path.join(T, 'settings.json');
fs.writeFileSync(SETTINGS, '{}');
// A stand-in claude, first on the board's PATH, that only echoes what it is
// sent: never the real assistant.
const FAKEBIN = path.join(T, 'fakebin');
fs.mkdirSync(FAKEBIN);
fs.writeFileSync(path.join(FAKEBIN, 'claude'), '#!/bin/sh\necho stand-in claude ready\nexec cat\n', { mode: 0o755 });
const env = {
  ...DENV, PATH: `${FAKEBIN}:${process.env.PATH}`, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  GIT_CONFIG_NOSYSTEM: '1',
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (x) => { boardLog += x; });
board.stderr.on('data', (x) => { boardLog += x; });
process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(DD, { recursive: true, force: true }); } catch { /* gone */ } });
const base = `http://localhost:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: j, text: t }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } return { status: r.status, body: j, text: t }; };
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const x = await fn().catch(() => null); if (x || Date.now() > end) return x; await sleep(100); } }
check('the board answers', !!(await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r : null; }, 20000)), boardLog.slice(-600));

check('worktree needs a project', (await post('/api/sessions/start', { folder: P, worktree: true })).status === 400);
const st = await post('/api/sessions/start', { projectId: 'proj', assistant: 'claude', worktree: true, name: 'Menu polish' });
const WT = path.join(T, 'proj-menu-polish');
check('start with worktree true: the session runs in its worktree, on its branch', st.status === 200 && st.body.worktree.branch === 'ravenry/menu-polish' && st.body.worktree.folder === WT && st.body.pane.cwd === path.join(WT, 'app') && st.body.pane.labels['ravenry.worktree'] === 'ravenry/menu-polish' && /git worktree/.test(st.body.command) && g(P, 'branch', '--list', 'ravenry/menu-polish').includes('menu-polish'), st.text);
const SID = st.body && st.body.surfaceId;
const sid = encodeURIComponent(SID || '');
fs.writeFileSync(path.join(WT, 'app', 'a.txt'), 'one\ntwo\nthree\nmenu\n');
const df = await get(`/api/sessions/${sid}/diff`);
check('GET /api/sessions/<id>/diff shows its change', df.status === 200 && df.body.files.some((x) => x.path === 'app/a.txt' && x.added === 1) && /\+menu/.test(df.body.diff) && df.body.worktree.branch === 'ravenry/menu-polish', df.text);
check('a session without a worktree has no diff', (await get(`/api/sessions/${encodeURIComponent('ravenry:pzzzzzzz')}/diff`)).status === 404);
const { connectSocket } = await import('../../packages/node-client/index.mjs');
const SOCK = fs.readdirSync(RUN).filter((n) => n.endsWith('.sock')).map((n) => path.join(RUN, n))[0];
const dc = await connectSocket(SOCK, { name: 'worktree-test' });
const PANE = st.body.pane.id;
await dc.request('pane.wait', { pane: PANE, text: 'stand-in claude ready', since: 0, timeout_ms: 8000 });
const mark = (await dc.request('pane.list', { hidden: true })).panes.find((x) => x.id === PANE).mark;
const cm = await post(`/api/sessions/${sid}/comment`, { file: 'app/a.txt', line: 4, text: 'Call it Menu.' });
check('a comment on a line goes to the session through the send path', cm.status === 200 && cm.body.sent === 'Review comment on app/a.txt line 4: Call it Menu.', cm.text);
const w4 = await dc.request('pane.wait', { pane: PANE, text: 'Review comment on app/a.txt line 4', since: mark, timeout_ms: 5000 });
check('and reaches its pane', w4.condition === 'text', JSON.stringify(w4.condition) + ' ' + JSON.stringify((await dc.request('pane.capture', { pane: PANE })).lines.map((l) => l.text).filter(Boolean)));
if (dc.has('pane.inputs')) {
  const ins = await dc.request('pane.inputs', { pane: PANE });
  const rec = (ins.inputs || []).find((x) => /Review comment/.test(x.text || ''));
  check('tagged as the person\'s review comment in the pane\'s input log', !!rec && rec.source && rec.source.kind === 'person' && rec.source.by === 'review', JSON.stringify(rec));
} else console.log('SKIP  input tags: this ravenryd has no pane.inputs yet');
check('a comment needs its words', (await post(`/api/sessions/${sid}/comment`, { file: 'app/a.txt', line: 4 })).status === 400);
// The files its hooks named, as Claude Code's PostToolUse reports them.
await dc.request('agent.report', { pane: PANE, assistant: 'claude', event: 'PostToolUse', cwd: path.join(WT, 'app'), data: { hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: path.join(WT, 'app'), tool_files: [path.join(WT, 'app', 'a.txt')] } });
fs.writeFileSync(path.join(P, 'app', 'mine.txt'), 'the person\'s own\n');
const pf = await until(async () => { const r = await get('/api/projects/proj/files'); const s0 = r.body && r.body.sessions && r.body.sessions.find((x) => x.surfaceId === SID); return s0 && s0.files.length ? r : null; });
const pfs = pf && pf.body.sessions.find((x) => x.surfaceId === SID);
check('GET /api/projects/<id>/files: the file its hooks named, with its counts, in its worktree; the person\'s own change under you', !!pfs && pfs.worktree === true && pfs.pane === PANE && pfs.files[0].path === 'app/a.txt' && pfs.files[0].added === 1 && pf.body.you.some((x) => x.path === 'app/mine.txt'), pf ? pf.text : 'no answer');
fs.rmSync(path.join(P, 'app', 'mine.txt'));
check('an unknown project has no files', (await get('/api/projects/nope/files')).status === 404);
// A pane's last seconds, sent to the session as a GIF in the inbox.
const mark2 = (await dc.request('pane.list', { hidden: true })).panes.find((x) => x.id === PANE).mark;
const fsr = await post(`/api/sessions/${sid}/filmstrip`, { pane: PANE, last_ms: 20000 });
const gif = fsr.body && fsr.body.path && fs.existsSync(fsr.body.path) ? fs.readFileSync(fsr.body.path) : null;
check('a filmstrip goes to the session: a GIF in the project\'s inbox, its path typed', fsr.status === 200 && !!gif && gif.slice(0, 3).toString() === 'GIF' && fsr.body.path.startsWith(path.join(P, 'app', '.inbox')) && /last \d+ seconds, as an animation: /.test(fsr.body.sent), fsr.text);
const w5 = await dc.request('pane.wait', { pane: PANE, text: 'as an animation', since: mark2, timeout_ms: 5000 });
check('and reaches its pane', w5.condition === 'text');
check('a filmstrip needs a pane', (await post(`/api/sessions/${sid}/filmstrip`, {})).status === 400);
check('the diff route carries the merge check', (await get(`/api/sessions/${sid}/diff`)).body.check.clean === true);
const dirty = await post(`/api/sessions/${sid}/merge`, { mode: 'ff' });
check('merge refused while uncommitted, with the files', dirty.status === 409 && dirty.body.files.includes('app/a.txt'), dirty.text);
g(WT, 'commit', '-q', '-am', 'menu');
const mg = await post(`/api/sessions/${sid}/merge`, { mode: 'ff' });
check('merge (fast-forward) through the API, then the worktree is gone', mg.status === 200 && mg.body.ok && fs.readFileSync(path.join(P, 'app', 'a.txt'), 'utf8').endsWith('menu\n') && !fs.existsSync(WT), mg.text);
const um = await post(`/api/sessions/${sid}/unmerge`, {});
check('unmerge through the API: main back, the worktree back', um.status === 200 && !fs.readFileSync(path.join(P, 'app', 'a.txt'), 'utf8').endsWith('menu\n') && fs.existsSync(path.join(WT, 'app', 'a.txt')), um.text);
check('delete-branch is refused while the work is open', (await post(`/api/sessions/${sid}/delete-branch`, {})).status === 409);
const mg2 = await post(`/api/sessions/${sid}/merge`, { mode: 'ff' });
const db = await post(`/api/sessions/${sid}/delete-branch`, {});
check('merged again, then the kept branch deleted through the API', mg2.status === 200 && db.status === 200 && !g(P, 'branch', '--list', 'ravenry/menu-polish'), db.text);
const st2 = await post('/api/sessions/start', { projectId: 'proj', assistant: 'claude', worktree: true, name: 'Throwaway' });
const sid2 = encodeURIComponent(st2.body && st2.body.surfaceId || '');
const ds = await post(`/api/sessions/${sid2}/discard`, {});
check('discard through the API', st2.status === 200 && ds.status === 200 && !fs.existsSync(path.join(T, 'proj-throwaway')), ds.text);
for (const p of (await dc.request('pane.list', { hidden: true })).panes) await dc.request('pane.close', { pane: p.id }).catch(() => {});
dc.close();

console.log(fails ? `\n${fails} failed\n${boardLog.slice(-2000)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
