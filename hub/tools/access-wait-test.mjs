// The hub answers while macOS asks whether it may read a protected folder
// (server/access.mjs). On 2026-11-07 the app's hub sat in a synchronous read
// of a brief in ~/Documents while macOS's dialog waited: it listened and
// answered nothing. Here a FIFO stands for that read (opening it waits
// until a writer comes) and an unreadable file for a refusal:
//
//   - while the read waits, every request gets 503 at once: the state and
//     the stream as JSON naming the folder, with the words the window
//     shows; the page as a short HTML page; a write too, and nothing of the
//     projects is read;
//   - when the read returns, the board starts by itself: the state has its
//     projects and the stream answers;
//   - a refused folder does not stop it: the state lists it.
//
// Usage: node tools/access-wait-test.mjs
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'access-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const DOCS = path.join(HOME, 'Documents');
const DESK = path.join(HOME, 'Desktop');
for (const d of [MC, path.join(DOCS, 'kite'), path.join(DESK, 'boat')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'kite', 'BRIEF.md'), '# Kite\n\nGoal: A kite that flies itself.\n');
const FIFO = path.join(T, 'documents-read');
execFileSync('mkfifo', [FIFO]);
const LOCKED = path.join(T, 'desktop-read');
fs.writeFileSync(LOCKED, 'x');
fs.chmodSync(LOCKED, 0o000);
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [
  { id: 'kite', name: 'kite', folder: path.join(DOCS, 'kite'), workspaces: [], brief: 'BRIEF.md' },
  { id: 'boat', name: 'boat', folder: path.join(DESK, 'boat'), workspaces: [], brief: 'BRIEF.md' },
] }, null, 2));

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 600) : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
let log = '';
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'ravenry',
  MC_ACCESS_PROBE: JSON.stringify({ [DOCS]: FIFO, [DESK]: LOCKED }), MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CLAUDE_SETTINGS: path.join(HOME, '.claude', 'settings.json'), MC_PHONE_LAN: 'none',
});
const board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
let writer = null;
process.on('exit', () => { board.kill('SIGTERM'); if (writer !== null) { try { fs.closeSync(writer); } catch { /* closed */ } } });

async function timed(p, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(base + p, { ...opts, signal: AbortSignal.timeout(3000) });
  return { status: r.status, ms: Date.now() - t0, type: r.headers.get('content-type') || '', text: await r.text() };
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// The board listens; the read of ~/Documents has not returned.
let st = null;
for (let i = 0; i < 100 && !st; i++) { try { st = await timed('/api/state'); } catch { await sleep(100); } }
check('while macOS asks: the state answers at once with 503', st && st.status === 503 && st.ms < 1000, JSON.stringify(st) + log.slice(-400));
const b = st ? json(st) : null;
check('and names the folder, with the words the window shows', !!b && b.starting === true && b.waitingFor === '~/Documents' && b.folder === 'Documents' && b.error === 'macOS is asking whether Ravenry may read ~/Documents. Click Allow in the dialog. If the dialog is gone: System Settings > Privacy & Security > Files & Folders > Ravenry, turn on Documents.', st && st.text);
const page = await timed('/');
check('the page: a short HTML page that says so', page.status === 503 && /text\/html/.test(page.type) && page.text.includes('Click Allow in the dialog') && page.ms < 1000, page.text.slice(0, 300));
const ev = await timed('/api/events');
check('the stream: 503 with the same JSON', ev.status === 503 && json(ev) && json(ev).waitingFor === '~/Documents');
const w = await timed('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ projectId: 'kite', surfaceId: 'x', text: 'hi' }) });
check('a write: 503, nothing done', w.status === 503);
await sleep(2500);
const again = await timed('/api/state');
check('still waiting after a few seconds, still answering at once', again.status === 503 && again.ms < 1000);
check('nothing of the projects was read meanwhile (no plan gate record yet)', !fs.existsSync(path.join(MC, 'plan-gates.json')) && !/plan gates:/.test(log), log.slice(-300));

// The person answers: the read returns.
writer = fs.openSync(FIFO, 'w');
fs.closeSync(writer);
writer = null;
let ok = null;
for (let i = 0; i < 60 && !ok; i++) { const r = await timed('/api/state').catch(() => null); if (r && r.status === 200 && json(r) && json(r).generatedAt) ok = json(r); else await sleep(100); }
check('answered: the board starts by itself and the state has its projects', !!ok && ok.projects.some((p) => p.id === 'kite'), log.slice(-500));
check('a refused folder does not stop it, and the state says so', !!ok && ok.access && ok.access.waiting === null && ok.access.denied.some((d) => d.folder === '~/Desktop' && d.name === 'Desktop'), JSON.stringify(ok && ok.access));
const stream = await fetch(base + '/api/events', { signal: AbortSignal.timeout(3000) }).catch((e) => ({ status: String(e) }));
check('the stream answers', stream.status === 200, String(stream.status));
try { await stream.body?.cancel(); } catch { /* closed */ }

board.kill('SIGTERM');
fs.chmodSync(LOCKED, 0o600);
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
