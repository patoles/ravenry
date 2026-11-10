// Proves what the hub works out for a worktree session's review and a
// project's files (server/reviewview.mjs): a diff split into each file's
// lines with their numbers, how Merge goes, which file two sessions
// changed, and the grid of who changed what. Pure, no board.
//   node tools/reviewview-test.mjs
import './test-guard.mjs';
import { parseDiff, mergeMode, withClashes } from '../server/reviewview.mjs';

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const DIFF = [
  'diff --git a/app/sync.js b/app/sync.js',
  'index 1111111..2222222 100644',
  '--- a/app/sync.js',
  '+++ b/app/sync.js',
  '@@ -1,4 +1,5 @@ export function sync() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a + b;',
  '',
  'diff --git a/app/new.md b/app/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/app/new.md',
  '@@ -0,0 +1,2 @@',
  '+# Notes',
  '+Sync every minute.',
  '',
].join('\n');
const p = parseDiff(DIFF);
check('parse: each file', Object.keys(p).join(',') === 'app/sync.js,app/new.md', Object.keys(p).join(','));
const s = p['app/sync.js'] || [];
check('parse: the hunk line', s[0] && s[0].kind === 'hunk' && s[0].text === '@@ export function sync() { @@', JSON.stringify(s[0]));
check('parse: numbers on each side', s[1].kind === 'ctx' && s[1].oldNo === 1 && s[1].newNo === 1 && s[2].kind === 'del' && s[2].oldNo === 2 && s[2].newNo === null && s[3].kind === 'add' && s[3].newNo === 2 && s[4].newNo === 3 && s[5].oldNo === 3 && s[5].newNo === 4, JSON.stringify(s));
check('parse: no trailing empty line', s.length === 6, String(s.length));
check('parse: a new file', p['app/new.md'].filter((l) => l.kind === 'add').length === 2 && p['app/new.md'][1].newNo === 1);
check('parse: nothing', Object.keys(parseDiff('')).length === 0);
check('merge: fast-forward when the base did not move', mergeMode({ clean: true, moved: 0 }) === 'ff' && mergeMode(null) === 'ff');
check('merge: a merge commit once it moved', mergeMode({ clean: true, moved: 2 }) === 'merge');

const files = withClashes({
  ok: true, project: 'notes-app', sessions: [
    { surfaceId: 'a', topic: 'Sync settings', assistant: 'claude', worktree: false, files: [{ path: 'app/sync.js', added: 2, removed: 1, at: '2026-11-10T10:00:00Z' }, { path: 'README.md', added: 0, removed: 0, read: true }] },
    { surfaceId: 'b', topic: 'Offline mode', assistant: 'codex', worktree: true, files: [{ path: 'app/sync.js', added: 5, removed: 0, at: '2026-11-10T10:05:00Z' }, { path: 'app/offline.js', added: 30, removed: 0 }] },
    { surfaceId: 'c', topic: 'Idle', assistant: 'claude', worktree: false, files: [] },
  ], you: [{ path: 'notes.txt', added: 1, removed: 0 }],
});
const fa = files.sessions[0].files[0];
check('clash: the other session that changed it', fa.clash && fa.clash.surfaceId === 'b' && fa.clash.topic === 'Offline mode' && fa.clash.assistant === 'codex' && fa.clash.at === '2026-11-10T10:05:00Z' && fa.clash.worktree === true && fa.clash.same === false, JSON.stringify(fa.clash));
check('clash: a read file has none', !files.sessions[0].files[1].clash);
check('clash: a file only one changed has none', !files.sessions[1].files[1].clash);
check('grid: the sessions that changed files, then you', files.grid.cols.map((c) => c.surfaceId).join(',') === 'a,b' && files.grid.you === true);
check('grid: the file two changed first', files.grid.rows[0].path === 'app/sync.js' && files.grid.rows[0].clash === true && files.grid.rows[0].cells[0].added === 2 && files.grid.rows[0].cells[1].added === 5 && files.grid.rows[0].cells[2] === null, JSON.stringify(files.grid.rows[0]));
check('grid: read, and yours', files.grid.rows.some((r) => r.path === 'README.md' && r.cells[0].read) && files.grid.rows.some((r) => r.path === 'notes.txt' && r.cells[2].added === 1 && !r.clash));
check('clash: same folder', withClashes({ sessions: [{ surfaceId: 'a', files: [{ path: 'x', added: 1, removed: 0 }] }, { surfaceId: 'b', files: [{ path: 'x', added: 1, removed: 0 }] }], you: [] }).sessions[0].files[0].clash.same === true);

console.log(fails ? `reviewview-test: ${fails} failed` : 'reviewview-test: all passed');
process.exit(fails ? 1 : 0);
