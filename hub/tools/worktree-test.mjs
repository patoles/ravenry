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
//     a fast-forward and a merge commit go through, then the worktree and
//     the branch are gone; discard throws the work away;
//   - with RAVENRYD_BIN, on a real board and daemon: POST
//     /api/sessions/start with worktree true starts the session in its
//     worktree, GET /api/sessions/<id>/diff shows its change, a comment
//     reaches the session's pane through the send path, tagged as the
//     person's review comment when the daemon tags input, and the merge
//     and discard routes work.
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
const ff = await W.merge(w, { mode: 'ff' });
check('a fast-forward goes through, and the worktree and branch are gone', ff.ok && ff.mode === 'ff' && g(R, 'rev-parse', 'main') === g(R, 'rev-parse', 'HEAD') && fs.readFileSync(path.join(R, 'app', 'new.txt'), 'utf8') === 'brand new\nfile\n' && !fs.existsSync(made.folder) && !g(R, 'branch', '--list', 'ravenry/fix-the-hud') && W.bySurface('ravenry:paaaaaaa').state === 'merged', JSON.stringify(ff));
check('a merged one is not merged twice', (await W.merge(W.bySurface('ravenry:paaaaaaa'))).status === 409);

// Two sessions on the same line: the first lands, the second conflicts.
const w2 = W.remember(again, { surfaceId: 'ravenry:pbbbbbbb', pane: 'pbbbbbbb', projectId: 'game' });
fs.writeFileSync(path.join(again.folder, 'shared.txt'), 'theirs\n');
g(again.folder, 'commit', '-q', '-am', 'shared: theirs');
fs.writeFileSync(path.join(R, 'shared.txt'), 'ours\n');
g(R, 'commit', '-q', '-am', 'shared: ours');
const head0 = g(R, 'rev-parse', 'HEAD');
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
check('a merge commit goes through, then the worktree and branch are gone', mc.ok && g(R, 'log', '-1', '--format=%s') === 'Merge the second session' && g(R, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length === 3 && fs.existsSync(path.join(R, 'other.txt')) && !fs.existsSync(again.folder) && !g(R, 'branch', '--list', 'ravenry/fix-the-hud-2'), JSON.stringify(mc));
const w3 = W.remember(anon, { surfaceId: 'ravenry:pccccccc', pane: 'pccccccc', projectId: 'game' });
fs.writeFileSync(path.join(anon.folder, 'scratch.txt'), 'throw me away\n');
const empty = await W.merge(w3, { mode: 'ff' });
check('merge is refused with uncommitted work, and with no commit at all', !empty.ok && empty.reason === 'uncommitted');
const disc = await W.discard(w3);
check('discard throws the worktree and the branch away, uncommitted changes included', disc.ok && !fs.existsSync(anon.folder) && !g(R, 'branch', '--list', anon.branch) && W.bySurface('ravenry:pccccccc').state === 'discarded', JSON.stringify(disc));
check('the main work tree is clean after all of it', g(R, 'status', '--porcelain') === '');
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
const dirty = await post(`/api/sessions/${sid}/merge`, { mode: 'ff' });
check('merge refused while uncommitted, with the files', dirty.status === 409 && dirty.body.files.includes('app/a.txt'), dirty.text);
g(WT, 'commit', '-q', '-am', 'menu');
const mg = await post(`/api/sessions/${sid}/merge`, { mode: 'ff' });
check('merge (fast-forward) through the API, then the worktree is gone', mg.status === 200 && mg.body.ok && fs.readFileSync(path.join(P, 'app', 'a.txt'), 'utf8').endsWith('menu\n') && !fs.existsSync(WT), mg.text);
const st2 = await post('/api/sessions/start', { projectId: 'proj', assistant: 'claude', worktree: true, name: 'Throwaway' });
const sid2 = encodeURIComponent(st2.body && st2.body.surfaceId || '');
const ds = await post(`/api/sessions/${sid2}/discard`, {});
check('discard through the API', st2.status === 200 && ds.status === 200 && !fs.existsSync(path.join(T, 'proj-throwaway')), ds.text);
for (const p of (await dc.request('pane.list', { hidden: true })).panes) await dc.request('pane.close', { pane: p.id }).catch(() => {});
dc.close();

console.log(fails ? `\n${fails} failed\n${boardLog.slice(-2000)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
