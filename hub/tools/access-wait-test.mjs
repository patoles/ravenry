// The hub never waits on a folder macOS protects (server/access.mjs). On
// 2026-11-07 the app's hub sat in a synchronous read of a brief in
// ~/Documents while macOS's dialog waited; on 2026-11-17 a hub whose Full
// Disk Access entry had gone stale answered nothing for minutes and the
// window was empty. Here a FIFO stands for a read macOS has not answered
// (opening it waits until a writer comes), "!EPERM" for a refusal and
// "!slow" for a folder macOS allows but checks file by file:
//
//   - the page and the state answer within 1 s the whole time, the folder
//     not answered or not;
//   - past the grace (3 s) the state has every project: one outside the
//     protected folders whole (its brief read), the ones inside marked as
//     waiting for access, the waiting folder named with the words the
//     window shows; nothing of theirs is read, and no plan gate record is
//     made while one is unanswered;
//   - when the read returns, the rest fills in by itself;
//   - a refused folder and a slow one stay out, with the words to remove
//     Ravenry from Full Disk Access and add it again, and the pane's URL;
//   - POST /api/access/retry asks again at once.
//
// The projects are made outside this repo (RAVENRY_TEST_SCRATCH, else the
// system's temporary folder); the board's data is in .tmp as every test's.
//
// Usage: node tools/access-wait-test.mjs
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'access-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const S = fs.mkdtempSync(path.join(process.env.RAVENRY_TEST_SCRATCH || os.tmpdir(), 'access-projects-'));
const DOCS = path.join(S, 'Documents');
const DESK = path.join(S, 'Desktop');
const DOWN = path.join(S, 'Downloads');
const CODE = path.join(S, 'code');
const brief = (dir, name, goal) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'BRIEF.md'), `# ${name}\n\nGoal: ${goal}\n`); };
fs.mkdirSync(MC, { recursive: true });
brief(path.join(DOCS, 'kite'), 'Kite', 'A kite that flies itself.');
brief(path.join(DESK, 'boat'), 'Boat', 'A boat that sails itself.');
brief(path.join(DOWN, 'cart'), 'Cart', 'A cart that rolls itself.');
brief(path.join(CODE, 'sail'), 'Sail', 'A sail that trims itself.');
const FIFO = path.join(S, 'documents-read');
execFileSync('mkfifo', [FIFO]);
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [
  { id: 'kite', name: 'kite', folder: path.join(DOCS, 'kite'), workspaces: [], brief: 'BRIEF.md' },
  { id: 'boat', name: 'boat', folder: path.join(DESK, 'boat'), workspaces: [], brief: 'BRIEF.md' },
  { id: 'cart', name: 'cart', folder: path.join(DOWN, 'cart'), workspaces: [], brief: 'BRIEF.md' },
  { id: 'sail', name: 'sail', folder: path.join(CODE, 'sail'), workspaces: [], brief: 'BRIEF.md' },
] }, null, 2));
const before = fs.readFileSync(path.join(MC, 'projects.json'), 'utf8');

let fails = 0;
let passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 700) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
let log = '';
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'ravenry',
  MC_ACCESS_PROBE: JSON.stringify({ [DOCS]: FIFO, [DESK]: '!EPERM', [DOWN]: '!slow' }), MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CLAUDE_SETTINGS: path.join(HOME, '.claude', 'settings.json'), MC_PHONE_LAN: 'none',
});
const board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
let writer = null;
const cleanup = () => { try { board.kill('SIGTERM'); } catch { /* gone */ } if (writer !== null) { try { fs.closeSync(writer); } catch { /* closed */ } } };
process.on('exit', cleanup);

async function timed(p, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + p, { ...opts, signal: AbortSignal.timeout(5000) });
    return { status: r.status, ms: Date.now() - t0, type: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 0, ms: Date.now() - t0, type: '', text: String(e) }; }
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
const proj = (st, id) => (st && st.projects || []).find((p) => p.id === id) || null;

// The board listens.
for (let i = 0; i < 100; i++) { const r = await timed('/api/whoami'); if (r.status) break; await sleep(100); }
const t0 = Date.now();

// GET / and /api/state every 200 ms for 6 s while the folder is not answered.
let worst = { ms: 0, path: '', status: 200 };
let firstState = null;
let first503 = null;
while (Date.now() - t0 < 6000) {
  for (const p of ['/', '/api/state']) {
    const r = await timed(p);
    if (r.ms > worst.ms || !r.status) worst = { ms: r.ms, path: p, status: r.status };
    if (p === '/api/state' && r.status === 503 && !first503) first503 = json(r);
    if (p === '/api/state' && r.status === 200 && !firstState) firstState = { at: Date.now() - t0, body: json(r) };
  }
  await sleep(200);
}
check('the page and the state answered within 1 s the whole time (6 s, the folder not answered)', worst.ms < 1000 && worst.status !== 0, JSON.stringify(worst) + log.slice(-400));
check('within the grace: 503 at once naming the folder, its path and the words', !first503 || (first503.waitingFor === DOCS && first503.folder === 'Documents' && first503.path === DOCS && /macOS is asking whether Ravenry may read/.test(first503.error)), JSON.stringify(first503));
check('past the grace (3 s) the board serves its state, not answered or not', !!firstState && firstState.at < 4500, JSON.stringify(firstState && firstState.at) + log.slice(-400));
const st = firstState && firstState.body;
const sail = proj(st, 'sail');
check('a project outside the protected folders is whole (its brief read)', !!sail && !!sail.brief && sail.brief.goal === 'A sail that trims itself.' && !sail.access, JSON.stringify(sail && { brief: sail.brief, access: sail.access }));
const kite = proj(st, 'kite');
check('a project in the folder not answered is listed, marked waiting, nothing of it read', !!kite && !kite.brief && kite.access && kite.access.state === 'waiting' && kite.access.name === 'Documents', JSON.stringify(kite && { brief: kite.brief, access: kite.access }));
check('the state names the waiting folder, with the words and the pane', !!st && st.access && st.access.waiting && st.access.waiting.path === DOCS && st.access.waiting.name === 'Documents' && st.access.blocked.some((b) => b.path === DOCS && b.state === 'waiting'), JSON.stringify(st && st.access));
const sideKite = st && st.sidebar && st.sidebar.sections.flatMap((s) => s.projects).find((p) => p.id === 'kite');
check('the sidebar marks it too', !!sideKite && sideKite.access && sideKite.access.state === 'waiting', JSON.stringify(sideKite));
const boat = proj(st, 'boat');
const cart = proj(st, 'cart');
check('a refused folder: its project listed, marked refused', !!boat && !boat.brief && boat.access && boat.access.state === 'denied', JSON.stringify(boat && boat.access));
check('a folder macOS checks file by file: marked slow, left alone', !!cart && !cart.brief && cart.access && cart.access.state === 'slow', JSON.stringify(cart && cart.access) + log.slice(-300));
check('nothing of the waiting folder was used: no plan gate record yet', !fs.existsSync(path.join(MC, 'plan-gates.json')) && !/plan gates:/.test(log), log.slice(-300));
const page = await timed('/');
check('the page is the board (no 503 page) past the grace', page.status === 200 && /text\/html/.test(page.type), page.status + ' ' + page.text.slice(0, 200));

// The person answers: the read returns.
writer = fs.openSync(FIFO, 'w');
fs.closeSync(writer);
writer = null;
let filled = null;
for (let i = 0; i < 60 && !filled; i++) { const r = await timed('/api/state'); const b = json(r); if (b && proj(b, 'kite') && proj(b, 'kite').brief) filled = b; else await sleep(100); }
const kite2 = proj(filled, 'kite');
check('answered: the rest fills in by itself (its brief read, no mark)', !!kite2 && kite2.brief.goal === 'A kite that flies itself.' && !kite2.access, JSON.stringify(kite2 && kite2.access) + log.slice(-500));
const a = filled && filled.access;
check('the refused and slow folders stay out, with the words to add Ravenry to Full Disk Access again', !!a && a.waiting === null && a.denied.some((d) => d.path === DESK && d.name === 'Desktop') && a.slow.some((d) => d.path === DOWN)
  && a.words === `Ravenry can't read ${DESK}, ${DOWN}. macOS stopped allowing it, which can happen after an update. In System Settings > Privacy & Security > Full Disk Access, select Ravenry, remove it with −, then add it again with +.`, JSON.stringify(a));
check('and the pane its button opens', !!a && a.settings === 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles', a && a.settings);
check('the plan gates start once every folder has its answer', fs.existsSync(path.join(MC, 'plan-gates.json')) || /plan gates:/.test(log), log.slice(-300));
const retry = await timed('/api/access/retry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: '{}' });
check('POST /api/access/retry asks again at once for the folders not allowed', retry.status === 200 && json(retry) && json(retry).asked.includes(DESK) && json(retry).asked.includes(DOWN), retry.text);
const stream = await fetch(base + '/api/events', { signal: AbortSignal.timeout(3000) }).catch((e) => ({ status: String(e) }));
check('the stream answers', stream.status === 200, String(stream.status));
try { await stream.body?.cancel(); } catch { /* closed */ }
check('the registry was not changed by any of it', fs.readFileSync(path.join(MC, 'projects.json'), 'utf8') === before);
check('the hub said how long macOS took, and that it went on without the folder', /access: macOS has not answered for .*Documents in 3000 ms/.test(log) && /access: macOS answered for .*Documents in \d+ ms \(allowed\)/.test(log), log.split('\n').filter((l) => l.startsWith('access')).join('\n'));

cleanup();
await sleep(200);
fs.rmSync(T, { recursive: true, force: true });
fs.rmSync(S, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
