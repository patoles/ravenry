// Proves server/ravenryd.mjs, the Ravenry terminal adapter, against a real
// ravenryd (RAVENRYD_BIN, which CI builds): the seven terminal operations,
// the agent status channel (a pane's `ravenryd hook` reaching the board as
// hook records), and the hub deciding a Stop through the daemon, with the
// hand-off's own rules, and letting it go when the hub is gone. Prints the
// measured round trip of a hook decision.
//
// The daemon runs with a throwaway HOME, runtime and state folder and
// /bin/sh as its shell; the board's data is a scratch RAVENRY_HOME in .tmp.
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/ravenryd-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN;
if (!BIN) {
  console.log('SKIP  ravenryd-test: set RAVENRYD_BIN to a ravenryd binary');
  process.exit(0);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'ravenryd-test-'));
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const TR = path.join(T, 'transcripts');
for (const d of [MC, PROJ, TR]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', PROJ]);
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Test\n\nGoal: Prove the adapter.\n\n## Hand-off\n- 2026-11-01 10:00 Older hand-off.\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
// The daemon's folders: short, outside the repo (a unix socket path is
// limited to about 100 bytes).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-'));
const DHOME = path.join(D, 'home');
fs.mkdirSync(DHOME);
const RUN = path.join(D, 'run');
process.env.RAVENRY_HOME = MC;
process.env.RAVENRY_RUNTIME_DIR = RUN;
process.env.RAVENRY_STATE_DIR = path.join(D, 'state');
process.env.RAVENRY_DAEMON_BIN = BIN;
const DENV = { HOME: DHOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: process.env.RAVENRY_STATE_DIR };

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(25);
  }
}

const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: ['ignore', 'ignore', 'pipe'] });
let dlog = '';
daemon.stderr.on('data', (d) => { dlog += d; });
const cleanup = () => { daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

const rv = await import('../server/ravenryd.mjs');
const term = await import('../server/terminal.mjs');
const events = await import('../server/events.mjs');
const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');

const up = await until(async () => (await rv.check()).ok, 5000);
check('the adapter finds the daemon in the runtime folder', !!up, up ? '' : dlog);
const SOCK = daemonSockets(RUN)[0].socket;

// ------------------------------------------------------------ the interface
check('terminal.mjs: kind, id, name, drivable', term.kindOf('ravenry:pabcdefg') === 'ravenry' && term.tabIdFor('ravenry', 'pabcdefg') === 'ravenry:pabcdefg' && term.nameOf('ravenry') === 'Ravenry' && term.canDrive('ravenry') && term.OTHER_KINDS.includes('ravenry'));
check('the board runs in Ravenry mode in a ravenryd pane, or when asked', term.boardKind({ RAVENRY_PANE: 'pabcdefg', TERM_PROGRAM: 'ravenry' }, () => false) === 'ravenry' && term.boardKind({ RAVENRY_TERMINAL: 'ravenry' }, () => false) === 'ravenry' && term.boardKind({ RAVENRY_PANE: 'pabcdefg', TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0:x' }, () => false) === 'iterm');

// Open tab
const made = await term.openTab('ravenry', { cwd: PROJ, label: 'proj' });
const ID = made.surfaceId;
const PANE = rv.paneOf(ID);
check('open tab: a new pane in the folder, named', made.ok && /^ravenry:p[a-z2-7]{7}$/.test(ID) && made.surfaceRef === 'Ravenry tab', JSON.stringify(made));
const tab = { kind: 'ravenry', surfaceId: ID };

// List tabs
const tabs = await term.listTabs('ravenry');
const mine = tabs.find((t) => t.id === ID);
check('list tabs: the pane, its name and folder', !!mine && mine.name === 'proj' && fs.realpathSync(mine.cwd) === fs.realpathSync(PROJ), JSON.stringify(mine));

// Send text, keys, read screen
let r = await term.pasteText(tab, 'echo pasted-$((1+2))');
r = r.ok ? await term.pressKey(tab, 'enter') : r;
let screen = await until(async () => { const s = await term.readScreen(tab, 40); return s && s.includes('pasted-3') ? s : null; });
check('send text and Enter, read the screen', r.ok && !!screen, JSON.stringify(screen));
r = await term.typeText(tab, 'echo typed-$((2+2))');
r = r.ok ? await term.pressKey(tab, 'enter') : r;
screen = await until(async () => { const s = await term.readScreen(tab, 40); return s && s.includes('typed-4') ? s : null; });
check('typed text, read the screen', r.ok && !!screen);
check('read screen: trimmed, ends in a newline, last lines only', screen.endsWith('\n') && !/\n\n$/.test(screen) && (await term.readScreen(tab, 2)).split('\n').length === 3);
check('keys: up is sent, an unknown key is refused', (await term.pressKey(tab, 'up')).ok && !(await term.pressKey(tab, 'f13')).ok);
// Up brought the last command back: Enter runs it again, so the prompt is
// empty for what follows.
await term.pressKey(tab, 'enter');
await until(async () => ((await term.readScreen(tab, 40)) || '').split('typed-4').length > 2);

// Focus: nobody shows panes, then a window that does.
r = await term.focus(tab);
check('focus with no window: says the app is not open', !r.ok && /not open/.test(r.err));
const win = await connectSocket(SOCK, { name: 'window' });
await win.request('events.subscribe', { display: true });
const shown = new Promise((res) => win.on('event', (e) => { if (e.event === 'pane.focus') res(e.pane.id); }));
r = await term.focus(tab);
check('focus: the window is asked to show the pane', r.ok && (await Promise.race([shown, sleep(2000).then(() => null)])) === PANE);
win.close();

// ------------------------------------------------------------ the status channel
const records = [];
let changes = 0;
const decided = [];
rv.startStatus({
  everyMs: 500,
  onRecord: (rec) => { records.push(rec); events.ingestDaemon(rec); },
  onChange: () => { changes++; },
  decide: async (rep) => { const reply = await rv.handoffDecider(rep); decided.push({ rep, reply }); return reply; },
});
await until(() => changes > 0, 3000);

function hook(input, extraEnv = {}, assistant = 'claude') {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(BIN, ['hook', '--assistant', assistant], { env: { ...DENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: SOCK, ...extraEnv } });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    c.stdin.end(JSON.stringify(input));
  });
}

const SID = 'sess-ravenryd-0001';
const low = path.join(TR, 'low.jsonl');
const high = path.join(TR, 'high.jsonl');
const transcript = (p, tokens) => fs.writeFileSync(p, [
  { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: '2026-11-06T20:00:00Z' },
  { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: tokens - 2006, output_tokens: 300 } }, timestamp: '2026-11-06T20:01:00Z' },
].map((x) => JSON.stringify(x)).join('\n') + '\n');
transcript(low, 180000);
transcript(high, 523000);

r = await hook({ session_id: SID, hook_event_name: 'UserPromptSubmit', cwd: PROJ, transcript_path: low, prompt: 'go' });
const rec = await until(() => records.find((x) => x.session_id === SID && x.event === 'UserPromptSubmit'));
check('a hook in a pane reaches the board as its record', r.code === 0 && r.out === '' && !!rec && rec.terminal === 'ravenry' && rec.terminal_id === PANE && rec.assistant === 'claude' && rec.cwd === PROJ && !('prompt' in rec), JSON.stringify(rec));
const sum = events.scan().get(SID);
check('the board reads the session from the daemon: running in its Ravenry tab', !!sum && sum.terminal === 'ravenry' && term.tabIdFor(sum.terminal, sum.terminalId) === ID && sum.last && sum.last.event === 'UserPromptSubmit');

// A Codex approval: the daemon passes on no tool input, and the board's
// record still names what it asks, from the hook's own line.
await hook({ session_id: 'sess-ravenryd-codex1', hook_event_name: 'PermissionRequest', cwd: PROJ, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, {}, 'codex');
const appr = await until(() => records.find((x) => x.session_id === 'sess-ravenryd-codex1'));
check('a Codex approval reaches the board with what it asks', !!appr && appr.event === 'Notification' && appr.notification_type === 'permission_prompt' && appr.message === 'Run rm -rf build' && appr.title === 'Bash', JSON.stringify(appr));

// A Stop below the hand-off line: the hub passes, the session goes on.
const stop = (tp, extra = {}) => ({ session_id: SID, hook_event_name: 'Stop', cwd: PROJ, transcript_path: tp, stop_hook_active: false, last_assistant_message: 'Done. Shall I push it?', ...extra });
r = await hook(stop(low));
check('Stop below the line: the hub passes, the hook prints nothing', r.code === 0 && r.out === '' && decided.length === 1 && decided[0].reply === null, `${r.ms.toFixed(1)} ms`);
const stopRec = await until(() => records.find((x) => x.session_id === SID && x.event === 'Stop'));
check('the Stop record carries the question it ended on', !!stopRec && stopRec.ends_on_question === true && /push it/.test(stopRec.question || ''));

// Past the line: the hub holds the session for the hand-off.
r = await hook(stop(high));
let out = null;
try { out = JSON.parse(r.out); } catch { /* not JSON */ }
check('Stop past the line: the hub blocks it with the hand-off reason', r.code === 0 && out && out.decision === 'block' && /past the 50% hand-off line/.test(out.reason) && out.reason.includes(path.join(PROJ, 'BRIEF.md')), r.out.slice(0, 200));
const mk = JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', SID + '.json'), 'utf8'));
check('the hand-off marker names the Ravenry tab', mk.state === 'requested' && mk.surfaceId === ID, JSON.stringify({ state: mk.state, surfaceId: mk.surfaceId }));

// The measured round trip: the hook process through the daemon to the
// hub's decider (the hand-off rules on a real transcript) and back.
const times = [];
for (let i = 0; i < 20; i++) times.push((await hook(stop(low, { session_id: `sess-ravenryd-1${String(i).padStart(3, '0')}` }))).ms);
times.sort((a, b) => a - b);
console.log(`MEASURE hook decision round trip through the hub (ravenryd hook process start to exit, daemon, hub decider with the hand-off rules, back): median ${times[10].toFixed(1)} ms, p95 ${times[18].toFixed(1)} ms, max ${times[19].toFixed(1)} ms over 20`);

// The hub goes away: the session goes on at once.
rv.stopStatus();
await sleep(100);
r = await hook(stop(high, { session_id: 'sess-ravenryd-0002' }));
check('hub down: Stop goes on at once, nothing printed', r.code === 0 && r.out === '' && r.ms < 1000, `${r.ms.toFixed(1)} ms`);

// The board catches up on what it missed, then sees the agent go.
records.length = 0;
rv.startStatus({ everyMs: 500, onRecord: (x) => { records.push(x); events.ingestDaemon(x); }, decide: rv.handoffDecider });
const missed = await until(() => records.find((x) => x.session_id === 'sess-ravenryd-0002'));
check('a hub that comes back reads what it missed from the daemon', !!missed && missed.event === 'Stop');
await hook({ session_id: SID, hook_event_name: 'UserPromptSubmit', cwd: PROJ, transcript_path: low, prompt: 'more' });
await term.pasteText(tab, 'exit');
await term.pressKey(tab, 'enter');
const ended = await until(() => records.find((x) => x.session_id === SID && x.event === 'SessionEnd'));
check('the pane exits while the agent works: the board gets its SessionEnd', !!ended && ended.reason === 'pane_exited' && ended.terminal_id === PANE, JSON.stringify(ended));

// Close
const c2 = await term.openTab('ravenry', { cwd: PROJ, label: 'second' });
r = await term.close({ kind: 'ravenry', surfaceId: c2.surfaceId });
check('close: the pane is gone', r.ok && !(await term.listTabs('ravenry')).some((t) => t.id === c2.surfaceId));
check('a closed pane: the operations say the tab is closed', (await term.pasteText({ kind: 'ravenry', surfaceId: c2.surfaceId }, 'x')).err === 'That Ravenry tab is closed.' && (await term.readScreen({ kind: 'ravenry', surfaceId: c2.surfaceId }, 5)) === null);

// The Node hooks, when their command carries --ravenryd, stand down in a
// ravenryd pane (ravenryd hook reports there) and nowhere else.
const { spawnSync } = await import('node:child_process');
const nodeHook = (script, input, paneEnv) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', script), '--ravenryd'], { input: JSON.stringify(input), env: { ...process.env, RAVENRY_HOME: MC, MC_BOARD_URL: 'http://127.0.0.1:4619', ...paneEnv }, encoding: 'utf8' });
const inPane = { RAVENRY_PANE: PANE, RAVENRY_SOCKET: SOCK, TERM_PROGRAM: 'ravenry' };
const evFile = (sid) => path.join(MC, 'events', sid + '.jsonl');
nodeHook('events.mjs', { session_id: 'sess-node-pane-1', hook_event_name: 'UserPromptSubmit', cwd: PROJ }, inPane);
nodeHook('events.mjs', { session_id: 'sess-node-else-1', hook_event_name: 'UserPromptSubmit', cwd: PROJ }, {});
check('events.mjs --ravenryd: silent in a ravenryd pane, records elsewhere', !fs.existsSync(evFile('sess-node-pane-1')) && fs.existsSync(evFile('sess-node-else-1')));
const held = nodeHook('handoff-stop.mjs', stop(high, { session_id: 'sess-node-pane-2' }), inPane);
const elsewhere = nodeHook('handoff-stop.mjs', stop(high, { session_id: 'sess-node-else-2' }), {});
check('handoff-stop.mjs --ravenryd: never holds in a ravenryd pane, holds elsewhere', held.status === 0 && held.stdout === '' && /"decision":"block"/.test(elsewhere.stdout));

rv.stopStatus();
console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
