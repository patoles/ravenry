// Proves the hub's API for the app's slice 3 seams against a real board
// (server/index.mjs) and a real ravenryd (RAVENRYD_BIN), on scratch data:
//   - /api/state carries `machines`, `checkpoints`, and `machine` on every
//     project and session;
//   - POST /api/sessions/start starts a session in a labelled pane;
//   - a checkpoint an agent opens shows in /api/checkpoints and the state,
//     and POST /api/checkpoints/answer answers it (the agent goes on);
//   - a secret typed through the API reaches the program, masked, and is
//     in no response, no file of the hub and no line it logs;
//   - /api/machines refuses a bad host; /api/setup/hooks works on scratch
//     settings.
// HOME, the board's data, Claude's settings and the daemon's folders are
// all scratch; the board listens on its own port.
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/hub-api-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  hub-api-test: set RAVENRYD_BIN to a ravenryd binary');
  process.exit(0);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'hub-api-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
for (const d of [MC, HOME, PROJ, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rva-'));
const RUN = path.join(D, 'run');
const PORT = 4791;
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let boardLog = '';
const env = {
  ...DENV, PATH: process.env.PATH, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } });

const base = `http://localhost:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json(), text: '' }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};

const first = await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r.body : null; }, 20000);
check('the board answers', !!first, boardLog.slice(-800));
check('state: machines and checkpoints, machine on each project', !!first && Array.isArray(first.machines) && Array.isArray(first.checkpoints) && first.projects.every((p) => 'machine' in p), JSON.stringify(first && { m: first.machines, c: first.checkpoints }));

// ------------------------------------------------------------ start a session
const bad = await post('/api/sessions/start', { folder: 'relative' });
check('start: a relative folder is refused', bad.status === 400, bad.text);
const st = await post('/api/sessions/start', { projectId: 'proj', assistant: 'claude', text: 'hello' });
check('start: a session in a labelled pane in the project folder', st.status === 200 && st.body.ok && /^ravenry:p/.test(st.body.surfaceId) && st.body.pane.labels['ravenry.project'] === 'proj' && st.body.pane.cwd === PROJ && st.body.machine === null, st.text);
const PANE = st.body && st.body.pane ? st.body.pane.id : null;
const SOCK = fs.readdirSync(RUN).filter((n) => n.endsWith('.sock')).map((n) => path.join(RUN, n))[0];

// ------------------------------------------------------------ a checkpoint
const agentEnv = { ...DENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: SOCK };
const ask = spawn(BIN, ['ask', '--wait', 'Ship it?', '--option', 'Yes', '--option', 'Not yet'], { env: agentEnv });
let askOut = '';
ask.stdout.on('data', (d) => { askOut += d; });
const askDone = new Promise((r) => ask.on('exit', r));
const listed = await until(async () => { const r = await get('/api/checkpoints'); return r.body.checkpoints.find((c) => c.title === 'Ship it?'); });
check('the checkpoint shows in /api/checkpoints, with no daemon internals', !!listed && listed.state === 'open' && !('daemon' in listed) && listed.machine === null, JSON.stringify(listed));
const inState = await until(async () => (await get('/api/state')).body.checkpoints.find((c) => c.id === listed.id));
check('and in the state', !!inState);
const a = await post('/api/checkpoints/answer', { id: listed.id, choice: 1 });
check('answer: taken, by the desktop', a.status === 200 && a.body.checkpoint.state === 'answered' && a.body.checkpoint.answer.by === 'desktop', a.text);
check('the agent goes on with the answer', (await askDone) === 0 && askOut.trim() === 'Not yet', askOut);
const twice = await post('/api/checkpoints/answer', { id: listed.id, choice: 0 });
check('a second answer is refused', twice.status === 409, twice.text);

// ------------------------------------------------------------ a secret through the API
const TYPED = 'api-s3cret-90210';
const sec = spawn(BIN, ['secret', 'Deploy token', '--', 'sh', '-c', "printf 'token: '; read v; echo got-$v"], { env: agentEnv });
let secOut = '';
sec.stdout.on('data', (d) => { secOut += d; });
const secDone = new Promise((r) => sec.on('exit', r));
const scp = await until(async () => (await get('/api/checkpoints')).body.checkpoints.find((c) => c.title === 'Deploy token'));
const broken = await fetch(base + '/api/checkpoints/answer', { method: 'POST', headers: { 'X-Ravenry': '1' }, body: `{"id":"${scp.id}","secret":"${TYPED}` });
const brokenText = await broken.text();
check('a broken request does not echo the secret back', broken.status === 400 && !brokenText.includes(TYPED), brokenText);
const sa = await post('/api/checkpoints/answer', { id: scp.id, secret: TYPED });
check('the secret is delivered, and not in the answer', sa.status === 200 && sa.body.checkpoint.answer.delivered && !sa.text.includes(TYPED), sa.text);
check('the program got it; its output shows it masked', (await secDone) === 0 && secOut.includes('got-****') && !secOut.includes(TYPED), secOut);
await sleep(1200);
const state = JSON.stringify((await get('/api/state')).body) + JSON.stringify((await get('/api/checkpoints?all')).body);
check('the secret is not in the state or the checkpoints', !state.includes(TYPED));
const files = spawnSync('grep', ['-rl', TYPED, MC, HOME], { encoding: 'utf8' }).stdout.trim();
check('the secret is in no file of the hub or its home', !files, files);
check('the secret is in nothing the board logged', !boardLog.includes(TYPED));

// ------------------------------------------------------------ machines and hooks
const mbad = await post('/api/machines/add', { host: '-oProxyCommand=evil' });
check('machines: a host that is an ssh option is refused', mbad.status === 400, mbad.text);
const ms = await get('/api/machines');
check('machines: listed (none yet)', ms.status === 200 && Array.isArray(ms.body.machines) && ms.body.machines.length === 0);
const hdry = await post('/api/setup/hooks', { ravenryd: BIN, dry: true });
check('setup/hooks: a dry run on the scratch settings lists the changes', hdry.status === 200 && hdry.body.claude.changes.some((c) => /ravenryd hook/.test(c)) && fs.readFileSync(SETTINGS, 'utf8') === '{}', hdry.text);
const hst = await get('/api/setup/hooks');
check('setup/hooks: status', hst.status === 200 && hst.body.claude.ravenryd.state === 'missing', JSON.stringify(hst.body.claude && hst.body.claude.ravenryd));

console.log(fails ? `\n${fails} failed\n--- board log ---\n${boardLog.slice(-3000)}` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
