#!/usr/bin/env node
// The onboarding marks kept by the hub (server/onboarding.mjs): hints
// dismissed, Learn ticks, step 2 answered.
//   1. in process: the union of every mark sent, never taken back; what is
//      not `true` or not a short lowercase name left out; a broken file is
//      no marks; written only when a mark is new.
//   2. a test board (fake cmux, no daemon): POST /api/onboarding from one
//      client, GET from another sees it; a board started again keeps it.
// Touches only .tmp/.
// Usage: node tools/onboarding-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'onboarding');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'unit-mc');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });

const ob = await import('../server/onboarding.mjs');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. in process
check('no file: no marks', JSON.stringify(ob.view()) === '{"hints":{},"learn":{},"setup":{}}' && !fs.existsSync(ob.FILE));
ob.mark({ hints: { 'needs-you': true }, learn: { film: true } });
let v = ob.mark({ hints: { pick: true, 'needs-you': false }, setup: { claude: true } });
check('the union of the marks sent; false takes nothing back', v.hints['needs-you'] && v.hints.pick && v.learn.film && v.setup.claude && Object.keys(v.hints).length === 2, JSON.stringify(v));
const file = JSON.parse(fs.readFileSync(ob.FILE, 'utf8'));
check('kept in <RAVENRY_HOME>/onboarding.json', ob.FILE === path.join(process.env.RAVENRY_HOME, 'onboarding.json') && file.version === 1 && file.hints.pick === true && file.setup.claude === true);
v = ob.mark({ hints: { 'Bad Name': true, '../x': true, ok: 'yes' }, learn: ['panes'], other: { x: true } });
check('names that are not short lowercase words, values that are not true, and other groups are left out', !('Bad Name' in v.hints) && !('../x' in v.hints) && !('ok' in v.hints) && !Object.keys(v.learn).includes('0') && !('other' in v), JSON.stringify(v));
const t0 = fs.statSync(ob.FILE).mtimeMs;
await sleep(20);
ob.mark({ hints: { pick: true } });
check('nothing new: the file is not written again', fs.statSync(ob.FILE).mtimeMs === t0);
const big = {};
for (let i = 0; i < 200; i++) big[`h${i}`] = true;
v = ob.mark({ hints: big });
check('at most 64 names a group', Object.keys(v.hints).length === 64, String(Object.keys(v.hints).length));

// ------------------------------------------------------------ 2. a test board
const PORT = 4675;
const mc = path.join(T, 'board', 'mc');
fs.mkdirSync(mc, { recursive: true });
fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [] }, null, 2));
fs.writeFileSync(path.join(mc, 'onboarding.json'), '{ broken');
const fake = path.join(T, 'board', 'fake-cmux.json');
fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
const env = {
  ...process.env, RAVENRY_HOME: mc, PORT: String(PORT), RAVENRY_PHONE_PORT: String(PORT + 1000), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0',
  CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: fake,
};
delete env.RAVENRY_DAEMON_BIN;
const base = `http://localhost:${PORT}`;
let srv = null;
let log = '';
async function startBoard() {
  srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withTestHome(env, T), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/state')).ok) return; } catch { /* not yet */ } await sleep(250); }
}
async function stopBoard() { if (!srv) return; const done = new Promise((r) => srv.on('exit', r)); srv.kill('SIGTERM'); await done; srv = null; }
process.on('exit', () => { if (srv) srv.kill('SIGTERM'); });
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, j: await r.json() }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };

try {
  await startBoard();
  const g0 = await get('/api/onboarding');
  check('GET /api/onboarding: a broken file is no marks', g0.status === 200 && g0.j.ok && JSON.stringify([g0.j.hints, g0.j.learn, g0.j.setup]) === '[{},{},{}]', JSON.stringify(g0) + log.slice(-400));
  // The desktop's first launch after the move: what its store held, sent once.
  const p1 = await post('/api/onboarding', { hints: { 'needs-you': true, 'agent-pane': true }, learn: { decisions: true }, setup: { claude: true } });
  check('POST /api/onboarding: the marks taken, the union answered', p1.status === 200 && p1.j.hints['needs-you'] && p1.j.hints['agent-pane'] && p1.j.learn.decisions && p1.j.setup.claude, JSON.stringify(p1));
  const p2 = await post('/api/onboarding', { hints: { pick: true } });
  const g1 = await get('/api/onboarding');
  check('a second client reads every mark, its own added', p2.status === 200 && g1.j.hints.pick && g1.j.hints['needs-you'] && g1.j.learn.decisions && g1.j.setup.claude, JSON.stringify(g1.j));
  const bad = await fetch(base + '/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: '{nope' });
  check('POST /api/onboarding: not JSON is a 400', bad.status === 400);
  await stopBoard();
  await startBoard();
  const g2 = await get('/api/onboarding');
  check('the board started again keeps them', g2.j.hints.pick && g2.j.hints['needs-you'] && g2.j.setup.claude, JSON.stringify(g2.j));
} finally {
  await stopBoard();
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
