// Proves the hub's API for the app's slice 3 seams against a real board
// (server/index.mjs) and a real ravenryd (RAVENRYD_BIN), on scratch data:
//   - /api/state carries `machines`, `checkpoints`, and `machine` on every
//     project and session;
//   - POST /api/sessions/start starts a session in a labelled pane;
//   - a checkpoint an agent opens shows in /api/checkpoints and the state,
//     and POST /api/checkpoints/answer answers it (the agent goes on);
//   - an edited command runs instead of the proposed one through the hub,
//     a refusal carries its reason, and the agent's warning reaches it;
//   - only a person answers: from inside a real pane, the command line, a
//     raw call on the daemon's socket and curl to the API are refused and
//     the checkpoint stays open; from outside every pane it is taken;
//   - a secret typed through the API reaches the program, masked, and is
//     in no response, no file of the hub and no line it logs;
//   - /api/machines refuses a bad host; /api/setup/hooks works on scratch
//     settings.
// HOME, the board's data, Claude's settings and the daemon's folders are
// all scratch; the board listens on its own port.
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/hub-api-test.mjs
import { withStubMachine } from './test-guard.mjs';
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
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: null }, { id: 'docs', name: 'Docs', folder: path.join(T, 'docs'), workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
fs.mkdirSync(path.join(T, 'docs'), { recursive: true });
const BRIEF_TEXT = '# Docs\n\nGoal: Write the docs.\n\n## Next step\n- Write the intro\n';
fs.writeFileSync(path.join(T, 'docs', 'BRIEF.md'), BRIEF_TEXT);
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
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine(env), stdio: ['ignore', 'pipe', 'pipe'] });
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
// The app's Brief page reads a brief as written (GET /api/brief).
{
  const b = await get('/api/brief?project=docs');
  check('GET /api/brief: the brief as written, with its file and when it changed', b.status === 200 && b.body.text === BRIEF_TEXT && b.body.file === path.join(T, 'docs', 'BRIEF.md') && !isNaN(Date.parse(b.body.updatedAt)), JSON.stringify(b.body).slice(0, 300));
  const none = await get('/api/brief?project=proj');
  const bad = await get('/api/brief?project=nope');
  check('GET /api/brief: 404 for a project with no brief and for no such project', none.status === 404 && bad.status === 404, `${none.status} ${bad.status}`);
}
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

// ------------------------------------------------------------ only a person answers
// From inside a real pane (where an agent runs), an answer is refused
// however it is sent: the command line, a raw call on the daemon's
// socket, and curl to this API. The checkpoint stays open and its command
// does not run. The same answer from this test process, outside every
// pane (as the board page and the desktop app send it), is taken.
const { connectSocket } = await import('../../packages/node-client/index.mjs');
const ran = path.join(T, 'approved-ran');
const appr = spawnSync(BIN, ['approve', '--no-wait', '--cwd', T, `touch '${ran}'`], { env: agentEnv, encoding: 'utf8' });
const apprId = appr.stdout.trim();
await until(async () => (await get('/api/checkpoints')).body.checkpoints.find((c) => c.id === apprId));
const RAW = path.join(T, 'raw-answer.mjs');
fs.writeFileSync(RAW, `import { connectSocket } from ${JSON.stringify(path.resolve(ROOT, '../packages/node-client/index.mjs'))};
const c = await connectSocket(process.env.RAVENRY_SOCKET, { name: 'raw' });
let code = 'ok';
try { await c.request('checkpoint.answer', { checkpoint: process.argv[2], approve: true }); } catch (e) { code = e.code; }
console.log('raw=' + code + ' person=' + c.hello.person);
c.close();
`);
const script = [
  `'${BIN}' checkpoint ${apprId} --approve; echo "cli=$?"`,
  `'${process.execPath}' '${RAW}' ${apprId}`,
  `curl -s -o '${T}/curl.json' -w 'curl=%{http_code}\\n' -X POST -H 'Content-Type: application/json' -H 'X-Ravenry: 1' --data '{"id":"${apprId}","approve":true}' http://localhost:${PORT}/api/checkpoints/answer`,
  'echo all-tried', 'exec sleep 60',
].join('; ');
const dc = await connectSocket(SOCK, { name: 'hub-api-test' });
const inPane = (await dc.request('pane.new', { command: ['/bin/sh', '-c', script], cols: 300, rows: 20 })).pane;
await dc.request('pane.wait', { pane: inPane.id, text: 'all-tried', since: 0, timeout_ms: 20000 });
const screen = (await dc.request('pane.capture', { pane: inPane.id })).lines.map((l) => l.text).join('\n');
dc.request('pane.close', { pane: inPane.id }).catch(() => {});
const curlBody = (() => { try { return JSON.parse(fs.readFileSync(path.join(T, 'curl.json'), 'utf8')); } catch { return null; } })();
check('from a pane, the command line is refused with a plain message', /only a person can answer c\w+, in the Ravenry app or on the phone/.test(screen) && screen.includes('cli=1'), screen);
check('from a pane, a raw call on the daemon\'s socket is refused (forbidden)', screen.includes('raw=forbidden person=false'), screen);
check('from a pane, curl to the hub is refused (403, a plain message)', screen.includes('curl=403') && !!curlBody && /Only a person can answer a checkpoint/.test(curlBody.error) && /inside pane/.test(curlBody.error), JSON.stringify({ curlBody }));
const still = (await get('/api/checkpoints')).body.checkpoints.find((c) => c.id === apprId);
check('the checkpoint stays open and its command did not run', !!still && still.state === 'open' && !fs.existsSync(ran), JSON.stringify(still));
check('the board logged the refusal', /refused a checkpoint answer: process \d+ \(curl\) runs inside pane/.test(boardLog), boardLog.slice(-500));
const pa = await post('/api/checkpoints/answer', { id: apprId, approve: true });
check('the same answer from outside every pane is taken, and the command runs', pa.status === 200 && ['running', 'answered'].includes(pa.body.checkpoint.state) && !!(await until(async () => fs.existsSync(ran))), pa.text);
dc.close();

// ------------------------------------------------------------ edit then run, refuse with a reason, the agent's warning
// The person edits the command in the app: through the hub, the edited
// one runs and the proposed one never does, and the agent is told so with
// the final text. A refusal carries the person's reason to the agent. The
// agent's own warning reaches the board as its own field.
const proposedRan = path.join(T, 'proposed-ran');
const editedRan = path.join(T, 'edited-ran');
const edAgent = spawn(BIN, ['approve', '--cwd', T, '--warn', 'Publishing to npm can\'t be undone', `touch '${proposedRan}'`], { env: agentEnv });
let edOut = '';
edAgent.stdout.on('data', (d) => { edOut += d; });
edAgent.stderr.on('data', (d) => { edOut += d; });
const edDone = new Promise((r) => edAgent.on('exit', r));
const ecp = await until(async () => (await get('/api/checkpoints')).body.checkpoints.find((c) => c.command === `touch '${proposedRan}'` && c.state === 'open'));
check('the agent\'s warning reaches the board as its own field', !!ecp && ecp.warning === 'Publishing to npm can\'t be undone', JSON.stringify(ecp));
const wrongField = await post('/api/checkpoints/answer', { id: ecp.id, approve: true, edited: `touch '${editedRan}'` });
check('a field the board does not know is refused, not dropped', wrongField.status === 400 && /does not know edited/.test(wrongField.body.error), wrongField.text);
const cmdOnDecline = await post('/api/checkpoints/answer', { id: ecp.id, decline: true, command: 'true' });
check('an edited command with decline is refused', cmdOnDecline.status === 400, cmdOnDecline.text);
const edited = await post('/api/checkpoints/answer', { id: ecp.id, approve: true, command: `touch '${editedRan}' && echo edited-output` });
check('edit then run through the hub: taken, answer.command holds the edit', edited.status === 200 && edited.body.checkpoint.answer.command === `touch '${editedRan}' && echo edited-output`, edited.text);
check('the agent is told it was edited, with the final text, and gets its output', (await edDone) === 0 && edOut.includes(`a person edited the command before approving it; it ran as:\ntouch '${editedRan}' && echo edited-output`) && edOut.includes('edited-output'), edOut);
check('the edited command ran and the proposed one did not', fs.existsSync(editedRan) && !fs.existsSync(proposedRan));
const rfAgent = spawn(BIN, ['approve', '--cwd', T, `touch '${proposedRan}'`], { env: agentEnv });
let rfOut = '';
rfAgent.stderr.on('data', (d) => { rfOut += d; });
const rfDone = new Promise((r) => rfAgent.on('exit', r));
const rcp = await until(async () => (await get('/api/checkpoints')).body.checkpoints.find((c) => c.command === `touch '${proposedRan}'` && c.state === 'open'));
const refused = await post('/api/checkpoints/answer', { id: rcp.id, decline: true, reason: 'Run the tests first' });
check('refuse with a reason through the hub', refused.status === 200 && refused.body.checkpoint.state === 'declined' && refused.body.checkpoint.answer.reason === 'Run the tests first', refused.text);
check('the agent reads the reason', (await rfDone) === 125 && rfOut.includes('Run the tests first'), rfOut);
check('the refused command did not run', !fs.existsSync(proposedRan));

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
