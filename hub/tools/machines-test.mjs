// Proves remote machines (server/machines.mjs, server/ravenryd.mjs) against
// a real ravenryd (RAVENRYD_BIN): a second daemon with its own runtime and
// state folders and HOME stands for the remote machine, reached through a
// fake `ssh` on the PATH that runs `ravenryd proxy` locally with that
// machine's environment (so `proxy` also starts the remote daemon, as it
// would over real ssh). It checks:
//   - adding a machine connects it, and its panes list beside the local
//     ones with `machine` set;
//   - a session started through the hub on it (server/sessionstart.mjs);
//   - its hook reaches the board as a record tagged with the machine, and
//     a Stop past the hand-off line is decided by the hub with the
//     transcript and brief read through the remote daemon (file.read);
//   - a checkpoint asked there reaches the hub, which answers it; a secret
//     typed for a command there is masked and never in the hub's files;
//   - the connection dropping and coming back (and ssh failing meanwhile);
//   - removing the machine.
// With RAVENRY_TEST_SSH=<host> it also tries real ssh to that host, only
// if `ssh -o BatchMode=yes <host> true` works without asking anything.
//
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/machines-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  machines-test: set RAVENRYD_BIN to a ravenryd binary');
  process.exit(0);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'machines-test-'));
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { handoffThreshold: 50, contextWindow: 1000000 }, projects: [] }, null, 2));
// Short folders outside the repo (unix socket paths are short).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-'));
const R = { home: path.join(D, 'rhome'), run: path.join(D, 'rrun'), state: path.join(D, 'rstate') };
fs.mkdirSync(R.home);
const FAKE = path.join(D, 'fakebin');
fs.mkdirSync(FAKE);
fs.symlinkSync(BIN, path.join(FAKE, 'ravenryd'));
const DOWN = path.join(D, 'ssh-down');
const PIDS = path.join(D, 'ssh-pids');
const LOG = path.join(D, 'ssh-log');
// The fake ssh: drops its options, records the host and argv, and runs
// the remote command line here through sh (as sshd runs it through the
// login shell), with the "remote" machine's environment, which says it
// runs in an ssh session as sshd's would (SSH_CONNECTION).
fs.writeFileSync(path.join(FAKE, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) host=$1; shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
echo "$host $*" >> '${LOG}'
if [ -f '${DOWN}' ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
echo $$ >> '${PIDS}'
exec env -i HOME='${R.home}' PATH='${FAKE}:/usr/bin:/bin' SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR='${R.run}' RAVENRY_STATE_DIR='${R.state}' SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"
`, { mode: 0o755 });

process.env.RAVENRY_HOME = MC;
process.env.RAVENRY_RUNTIME_DIR = path.join(D, 'lrun'); // no local daemon in this test
process.env.RAVENRY_STATE_DIR = path.join(D, 'lstate');
process.env.RAVENRY_DAEMON_BIN = 'none';
process.env.RAVENRY_SSH = path.join(FAKE, 'ssh');
process.env.RAVENRY_MACHINE_RETRY_MS = '300';

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}
const REMOTE_ENV = { HOME: R.home, PATH: `${FAKE}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: R.run, RAVENRY_STATE_DIR: R.state };
function cleanup() {
  try {
    const ds = JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: REMOTE_ENV, encoding: 'utf8' }) || '[]');
    for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const rv = await import('../server/ravenryd.mjs');
const machines = await import('../server/machines.mjs');
const cps = await import('../server/checkpoints.mjs');
const { plan } = await import('../server/sessionstart.mjs');
const events = await import('../server/events.mjs');

const records = [];
const seenCps = [];
rv.startStatus({
  onRecord: (rec) => { records.push(rec); events.ingestDaemon(rec); },
  onCheckpoint: (cp, where) => { seenCps.push({ cp, where }); cps.take(cp, where); },
  onLost: (daemon) => cps.dropDaemon(daemon),
  decide: (rep, where) => rv.handoffDecider(rep, where),
  everyMs: 500,
});

// ------------------------------------------------------------ add
check('a machine is checked before it is added', !!machines.checkMachine({ host: '-oProxyCommand=x' }) && !!machines.checkMachine({ host: 'devbox', name: 'bad name' }) && machines.checkMachine({ host: 'you@devbox' }) === null);
const added = machines.add({ name: 'devbox', host: 'devbox' });
check('add: written to the registry', added.ok && JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8')).settings.machines[0].host === 'devbox', JSON.stringify(added));
const up = await until(() => machines.status().find((m) => m.name === 'devbox' && m.state === 'connected'), 10000);
check('it connects through `ssh devbox ravenryd proxy`, which starts the daemon there', !!up && fs.readFileSync(LOG, 'utf8').includes('devbox ravenryd proxy'), JSON.stringify(machines.status()));
const version = /ravenryd (\S+)/.exec(execFileSync(BIN, ['version'], { env: REMOTE_ENV, encoding: 'utf8' }))[1];
const RSOCK = path.join(R.run, `ravenryd-${version}.sock`);

// ------------------------------------------------------------ a session there
const RPROJ = path.join(R.home, 'proj');
fs.mkdirSync(path.join(RPROJ, '.git'), { recursive: true });
fs.writeFileSync(path.join(RPROJ, 'BRIEF.md'), '# Remote\n\nGoal: Prove it.\n\n## Hand-off\n- 2026-11-01 10:00 Older.\n');
const pl = plan({ folder: RPROJ, machine: 'devbox', text: 'hello there' }, { launch: () => ({ kind: 'claude', command: 'echo started-$RAVENRY_PANE' }), machines: ['devbox'] });
check('session plan: the folder, the machine, the line, the labels', pl.ok && pl.machine === 'devbox' && pl.line === "echo started-$RAVENRY_PANE 'hello there'" && pl.labels['ravenry.session'] === 'claude', JSON.stringify(pl));
check('session plan: an unknown machine is refused', !plan({ folder: RPROJ, machine: 'nope' }, { launch: () => ({}), machines: ['devbox'] }).ok);
{
  // Here, an assistant found where its installer put it goes first on the pane's PATH; never on another machine, nor for a command the person set.
  const binPath = (n) => `/home/x/.local/bin:/usr/bin`;
  const here = plan({ folder: '/tmp', assistant: 'claude' }, { launch: () => ({ kind: 'claude', command: 'claude' }), binPath });
  const there = plan({ folder: RPROJ, machine: 'devbox', assistant: 'claude' }, { launch: () => ({ kind: 'claude', command: 'claude' }), machines: ['devbox'], binPath });
  const own = plan({ folder: '/tmp', assistant: 'claude' }, { launch: () => ({ kind: 'claude', command: '/opt/my/claude --x' }), binPath });
  check('session plan: the assistant\'s folder on the PATH here only, for the bare command only', here.env && here.env.PATH === binPath('claude') && !there.env && !own.env, JSON.stringify([here.env, there.env, own.env]));
}
const st = await rv.startSession(pl);
const PANE = st.ok ? rv.paneOf(st.surfaceId) : null;
check('a session starts in a pane on the machine', st.ok && st.machine === 'devbox' && st.pane && st.pane.labels['ravenry.session'] === 'claude', JSON.stringify(st));
const screen = await until(async () => { const s = await rv.readScreen(st.surfaceId, 10); return s && s.includes(`started-${PANE} hello there`) ? s : null; });
check('its line ran there', !!screen, JSON.stringify(await rv.readScreen(st.surfaceId, 10)));
const tabs = await rv.listTabs();
const mine = tabs.find((t) => t.paneId === PANE);
check('its pane lists with machine: devbox', !!mine && mine.machine === 'devbox' && rv.machineOfTab(st.surfaceId) === 'devbox', JSON.stringify(mine));

// ------------------------------------------------------------ its hook and the hand-off
const TR = path.join(R.home, 'transcript.jsonl');
const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 620000 };
fs.writeFileSync(TR, [
  JSON.stringify({ type: 'user', timestamp: '2026-11-06T10:00:00.000Z', message: { role: 'user', content: 'go' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-06T10:01:00.000Z', message: { model: 'claude-x', usage, content: [{ type: 'text', text: 'Done with the step.' }] } }),
].join('\n') + '\n');
// The hook runs as a child that is waited for without blocking: the hub
// in this same process must answer its decision meanwhile.
function hook(input, assistant = 'claude') {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(BIN, ['hook', '--assistant', assistant], { env: { ...REMOTE_ENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: RSOCK } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    c.stdin.end(JSON.stringify(input));
  });
}
await hook({ session_id: 'sess-remote-1', hook_event_name: 'UserPromptSubmit', cwd: RPROJ, transcript_path: TR, prompt: 'never forwarded' });
const rec = await until(() => records.find((r) => r.session_id === 'sess-remote-1'));
check('a hook there reaches the board tagged with the machine', !!rec && rec.machine === 'devbox' && rec.terminal_id === PANE && !JSON.stringify(rec).includes('never forwarded'), JSON.stringify(rec));
const reads0 = rv.remoteStats.reads;
const stop = await hook({ session_id: 'sess-remote-1', hook_event_name: 'Stop', cwd: RPROJ, transcript_path: TR, last_assistant_message: 'Done with the step.' });
let out = null;
try { out = JSON.parse(stop.out); } catch { /* none */ }
check('a Stop past the line there is held for the hand-off, decided by the hub', stop.code === 0 && out && out.decision === 'block' && /Hand-off/i.test(out.reason || ''), JSON.stringify(stop));
check('the transcript and the brief were read through the remote daemon', rv.remoteStats.reads > reads0, `${rv.remoteStats.reads - reads0} file.read`);
const marker = JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', 'sess-remote-1.json'), 'utf8'));
check('the hand-off marker names the brief on the machine, and the machine', marker.handoffFile === path.join(RPROJ, 'BRIEF.md') && marker.machine === 'devbox' && marker.state === 'requested', JSON.stringify({ f: marker.handoffFile, m: marker.machine, s: marker.state }));
console.log(`MEASURE remote hook decision (hook start to exit, through the remote daemon, ssh, the hub's hand-off with remote reads, back): ${stop.ms.toFixed(1)} ms`);
// The hand-off is written on the machine: the next Stop records it.
fs.appendFileSync(path.join(RPROJ, 'BRIEF.md'), '- 2026-11-06 11:00 The new hand-off.\n');
await hook({ session_id: 'sess-remote-1', hook_event_name: 'Stop', cwd: RPROJ, transcript_path: TR, last_assistant_message: 'Wrote it.' });
const m2 = JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', 'sess-remote-1.json'), 'utf8'));
check('the hand-off written on the machine is seen at the next Stop', m2.state === 'written', m2.state);

// ------------------------------------------------------------ checkpoints there
const ask = spawn(BIN, ['ask', '--wait', 'Remote question?', '--option', 'Yes', '--option', 'No'], { env: { ...REMOTE_ENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: RSOCK } });
let askOut = '';
ask.stdout.on('data', (d) => { askOut += d; });
const askDone = new Promise((r) => ask.on('exit', r));
const got = await until(() => seenCps.find((x) => x.cp.title === 'Remote question?'));
check('a checkpoint asked there reaches the hub, with its machine', !!got && got.where.machine === 'devbox' && got.cp.pane === PANE, JSON.stringify(got && got.where));
const ans = got ? await cps.answer({ id: got.cp.id, choice: 1, by: 'test' }, rv.answerCheckpoint) : null;
const askCode = await askDone;
check('the hub answers it, and the agent there goes on with the answer', !!ans && ans.ok && askCode === 0 && askOut.trim() === 'No', JSON.stringify({ ans, askCode, askOut }));

const TYPED = 'remote-k3y-55871';
const sec = spawn(BIN, ['secret', 'Remote API key', '--', 'sh', '-c', "printf 'key: '; read v; echo stored-$v"], { env: { ...REMOTE_ENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: RSOCK } });
let secOut = '';
sec.stdout.on('data', (d) => { secOut += d; });
const secDone = new Promise((r) => sec.on('exit', r));
const sgot = await until(() => seenCps.find((x) => x.cp.title === 'Remote API key'));
const sans = sgot ? await cps.answer({ id: sgot.cp.id, secret: TYPED }, rv.answerCheckpoint) : null;
const secCode = await secDone;
check('a secret typed for a command there: delivered, masked in its output', !!sans && sans.ok && secCode === 0 && secOut.includes('stored-****') && !secOut.includes(TYPED), JSON.stringify({ secCode, secOut }));
const hubFiles = spawnSync('grep', ['-rl', TYPED, MC], { encoding: 'utf8' }).stdout.trim();
check('the secret is in no file of the hub', !hubFiles, hubFiles);
check('the hub keeps the closed checkpoints, with no secret', JSON.stringify(cps.list({ all: true })).includes('"delivered":true') && !JSON.stringify(cps.list({ all: true })).includes(TYPED));

// ------------------------------------------------------------ who answers there
// Over ssh the remote daemon cannot see this machine: it takes answers
// only from the connection with the answer key it trusts, the first one
// it was given, which is the hub's (PROTOCOL.md section 4, Who acts as
// the person). Anything else that runs `ssh devbox ravenryd proxy` (an
// agent here) is refused, and the checkpoint stays open.
const { connect } = await import('../../packages/node-client/index.mjs');
const { Duplex } = await import('node:stream');
const { answerKey } = await import('../server/person.mjs');
check('the hub pairs with the machine: it takes the hub\'s answers', machines.status()[0].answers === true, JSON.stringify(machines.status()));
const keyFile = fs.readFileSync(path.join(R.state, 'answer-key'), 'utf8');
check('the machine keeps only a hash of the hub\'s key, mode 0600', keyFile.startsWith('sha256:') && !keyFile.includes(answerKey()) && (fs.statSync(path.join(R.state, 'answer-key')).mode & 0o777) === 0o600, keyFile);
async function viaSsh(key) {
  const child = spawn(path.join(FAKE, 'ssh'), ['-T', 'devbox', '--', 'ravenryd', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const c = await connect(Duplex.from({ readable: child.stdout, writable: child.stdin }), { name: 'not-the-hub', timeoutMs: 10000, ...(key ? { answerKey: key } : {}) });
  return { c, end: () => { c.close(); child.kill('SIGTERM'); } };
}
const appr = spawn(BIN, ['approve', '--no-wait', '--cwd', R.home, 'touch approved-there'], { env: { ...REMOTE_ENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: RSOCK } });
let apprId = '';
appr.stdout.on('data', (d) => { apprId += d; });
await new Promise((r) => appr.on('exit', r));
apprId = apprId.trim();
await until(() => seenCps.find((x) => x.cp.id === apprId));
for (const [name, key] of [['with no key', null], ['with another key', 'a'.repeat(43)]]) {
  const o = await viaSsh(key);
  let code = 'ok';
  try { await o.c.request('checkpoint.answer', { checkpoint: apprId, approve: true }); } catch (e) { code = e.code; }
  const list = await o.c.request('checkpoint.list', {});
  o.end();
  check(`another ssh connection ${name}: not the person, its answer refused, the checkpoint stays open`, o.c.hello.person === false && code === 'forbidden' && list.checkpoints.some((x) => x.id === apprId && x.state === 'open'), JSON.stringify({ person: o.c.hello.person, code }));
}
const apprAns = await cps.answer({ id: apprId, approve: true, by: 'test' }, rv.answerCheckpoint);
check('the hub\'s answer there takes, and the command runs', apprAns.ok && !!(await until(() => fs.existsSync(path.join(R.home, 'approved-there')))), JSON.stringify(apprAns));

// ------------------------------------------------------------ the connection drops
const pids = () => fs.readFileSync(PIDS, 'utf8').trim().split('\n').map(Number);
fs.writeFileSync(DOWN, '');
for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
const down = await until(() => machines.status().find((m) => m.name === 'devbox' && m.state === 'down' && /Connection refused/.test(m.error || '')), 8000);
check('a dropped connection shows down, with ssh\'s reason while it cannot reconnect', !!down, JSON.stringify(machines.status()));
check('meanwhile its panes are not listed', !(await rv.listTabs().catch(() => [])).some((t) => t.paneId === PANE));
fs.rmSync(DOWN);
const back = await until(() => machines.status().find((m) => m.name === 'devbox' && m.state === 'connected'), 10000);
check('it comes back by itself', !!back, JSON.stringify(machines.status()));
const again = await until(async () => (await rv.listTabs()).find((t) => t.paneId === PANE));
check('and its pane, which the daemon kept, lists again', !!again && again.machine === 'devbox');
const h2 = await hook({ session_id: 'sess-remote-2', hook_event_name: 'UserPromptSubmit', cwd: RPROJ });
check('its hooks reach the board again', h2.code === 0 && !!(await until(() => records.find((r) => r.session_id === 'sess-remote-2'))));

// ------------------------------------------------------------ remove
const rm = machines.remove('devbox');
check('remove: out of the registry and disconnected', rm.ok && !machines.status().length && !(await rv.listTabs().catch(() => [])).some((t) => t.paneId === PANE));

// ------------------------------------------------------------ real ssh (optional)
const host = process.env.RAVENRY_TEST_SSH;
if (host) {
  const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true'], { encoding: 'utf8' });
  if (probe.status !== 0) console.log(`SKIP  real ssh to ${host}: ${probe.stderr.trim().split('\n').pop()}`);
  else console.log(`NOTE  real ssh to ${host} answers; run the app against it by adding it as a machine`);
} else console.log('SKIP  real ssh (set RAVENRY_TEST_SSH=<host> to try it)');

rv.stopStatus();
console.log(fails ? `\n${fails} failed` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
