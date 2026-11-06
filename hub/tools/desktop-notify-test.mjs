// Mac notifications, the bell (server/desktop.mjs), proved without putting a
// notification on the screen: cmux is tools/fake-cmux.mjs (it records each
// `notify`) and osascript is tools/stub-osascript.mjs (it logs its args).
//
// 1. In process, with crafted projects: on by default with nothing set up;
//    exactly one notification per transition, with the phone alerts'
//    wording and dedupe (no alert at start, a blip is not alerted twice, the
//    10-minute cooldown, nothing for mc-test workspaces), each distinct plan
//    gate once; no session text in any argument; `--workspace` is the
//    session's workspace; the osascript fallback for a project with no
//    workspace and for a cmux that refuses; the phone's own trigger is
//    separate (phone off still notifies the Mac, the Mac off still alerts
//    the phone); the bell off sends nothing and is saved.
// 2. The guard: a test board never runs the real cmux or osascript.
// 3. A test board on :4674: the bell's route, saved in alerts.json and still
//    off after a restart, and in the snapshot.
// Touches only .tmp/.
//
// Usage: node tools/desktop-notify-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'desktop-notify');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'unit'), { recursive: true });
const FAKE = path.join(T, 'fake-cmux.json');
const OSA_LOG = path.join(T, 'osascript.log');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
process.env.RAVENRY_HOME = path.join(T, 'unit');
process.env.CMUX_BIN = path.join(ROOT, 'tools/fake-cmux.mjs');
process.env.FAKE_CMUX_STATE = FAKE;
process.env.MC_OSASCRIPT_BIN = path.join(ROOT, 'tools/stub-osascript.mjs');
process.env.STUB_OSASCRIPT_LOG = OSA_LOG;
process.env.MC_ALERT_PRIME_MS = '0';
process.env.MC_TELEGRAM_API = 'http://127.0.0.1:9/tg';
delete process.env.MC_DESKTOP_REAL;
// As on the real board, which runs in a cmux terminal: these name the
// board's own tab and must not reach `cmux notify`.
process.env.CMUX_SURFACE_ID = 'BOARD-TAB-SURFACE';
process.env.CMUX_WORKSPACE_ID = 'BOARD-TAB-WORKSPACE';
delete process.env.MC_ALERT_ALLOW_TEST;

const al = await import('../server/alerts.mjs');
const desktop = await import('../server/desktop.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = () => (fs.existsSync(FAKE + '.notify.log') ? fs.readFileSync(FAKE + '.notify.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const osa = () => (fs.existsSync(OSA_LOG) ? fs.readFileSync(OSA_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const fixture = (patch) => { const st = JSON.parse(fs.readFileSync(FAKE, 'utf8')); fs.writeFileSync(FAKE, JSON.stringify({ ...st, ...patch })); };
async function settle(nNotes, nOsa, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (notes().length >= nNotes && osa().length >= nOsa) break; await sleep(40); }
  await sleep(250); // and nothing more arrives
}
const AF = path.join(process.env.RAVENRY_HOME, 'alerts.json');
const fileJson = () => JSON.parse(fs.readFileSync(AF, 'utf8'));

// ------------------------------------------------------------ 1. in process
const SECRET = 'SESSIONTEXT-do-not-leak';
const sess = (sid, state, extra = {}) => ({ surfaceId: 'sf-' + sid, sessionId: sid, workspaceId: extra.wsId === undefined ? 'ws-' + sid : extra.wsId, state, since: extra.since || '2026-11-03T10:00:00.000Z', notificationType: extra.nt || null, words: { headline: `${SECRET} ${extra.headline || ''}`, dialog: extra.dialog || null, line: SECRET } });
const proj = (id, state, s, extra = {}) => ({ id, name: extra.name || id.toUpperCase(), state, primary: s ? s.surfaceId : null, sessions: s ? [s] : [], workspaces: extra.noWs ? [] : [{ id: 'ws-' + id, title: extra.ws || id, open: true }], line: SECRET, headline: SECRET, ...(extra.gate || {}) });
const T0 = Date.parse('2026-11-03T10:00:00Z');
const obs = (ps, min) => al.observe(ps, { now: T0 + min * 60000, boardUrl: 'http://192.168.1.50:4600/' });

check('default: no alerts.json, Mac notifications are on and the phone is not set up', al.status().desktop.enabled === true && al.status().configured === false && !fs.existsSync(AF), JSON.stringify(al.status()));

let out = obs([proj('a', 'you', sess('sa', 'handback')), proj('b', 'work', sess('sb', 'working')), proj('t', 'work', sess('st', 'working'), { ws: 'mc-test-desk' })], 0);
check('start: nothing for a project already in Needs you', out.desktop.length === 0 && out.length === 0);
out = obs([proj('a', 'you', sess('sa', 'handback')), proj('b', 'you', sess('sb', 'asked')), proj('t', 'you', sess('st', 'handback'), { ws: 'mc-test-desk' })], 1);
await settle(1, 0);
let n = notes();
check('question: exactly one Mac notification, though the phone is not set up', out.desktop.length === 1 && out.length === 0 && n.length === 1, JSON.stringify(out.desktop));
check('question: cmux notify --title "B needs you" --body "Asked you a question" --workspace <its session\'s workspace>', n[0] && n[0].title === 'B needs you' && n[0].body === 'Asked you a question' && n[0].workspace === 'ws-sb', JSON.stringify(n[0]));
check('no session text in any argument', !JSON.stringify(n).includes(SECRET));
check("the board's own CMUX_SURFACE_ID and CMUX_WORKSPACE_ID are left out of the call", n[0] && n[0].envSurface === null && n[0].envWorkspace === null, JSON.stringify(n[0] && [n[0].envSurface, n[0].envWorkspace]));
check('nothing for the board\'s own mc-test workspaces', !n.some((x) => /^T /.test(x.title)));
check('the status records it, shown by cmux', al.status().desktop.last && al.status().desktop.last.ok && al.status().desktop.last.via === 'cmux', JSON.stringify(al.status().desktop));

obs([proj('b', 'work', sess('sb', 'working'))], 20);
out = obs([proj('b', 'you', sess('sb', 'asked'))], 21);
check('dedupe: the same session, kind and moment again is not notified twice', out.desktop.length === 0);
obs([proj('b', 'work', sess('sb', 'working'))], 22);
out = obs([proj('b', 'you', sess('sb', 'asked', { since: '2026-11-03T10:22:30.000Z' }))], 22.5);
check('a new question 21 min on is a new moment: notified', out.desktop.length === 1);
obs([proj('b', 'work', sess('sb', 'working'))], 23);
out = obs([proj('b', 'you', sess('sb', 'handback', { since: '2026-11-03T10:24:00.000Z' }))], 24);
check('cooldown: another move 1.5 min later is not notified', out.desktop.length === 0);
obs([proj('c', 'work', sess('sc', 'working')), proj('d', 'work', sess('sd', 'working'))], 30);
out = obs([proj('c', 'you', sess('sc', 'dialog', { nt: 'permission_prompt' })), proj('d', 'you', sess('sd', 'draft'))], 31);
check('permission: "Waiting for permission"; a half-typed reply sends nothing', out.desktop.length === 1 && out.desktop[0].body === 'Waiting for permission');
await settle(3, 0);
check('one notify per transition so far (3)', notes().length === 3, String(notes().length));
// A session whose tab is a real cmux surface UUID: --surface names it too.
const TAB = '0C0C0C0C-0000-4000-8000-000000000C0C';
const tabSess = (state) => ({ ...sess('su', state === 'you' ? 'asked' : 'working'), surfaceId: TAB });
const tabProj = (state) => ({ ...proj('u', state, tabSess(state)), primary: TAB });
obs([tabProj('work')], 35);
out = obs([tabProj('you')], 36);
await settle(4, 0);
const nu = notes().find((x) => x.title === 'U needs you');
check('a session tab with a cmux surface id: --workspace and --surface both name it', nu && nu.workspace === 'ws-su' && nu.argv.includes('--surface') && nu.argv[nu.argv.indexOf('--surface') + 1] === TAB, JSON.stringify(nu && nu.argv));

// Gates: each distinct gate once.
const G = (n_, q) => ({ plan: { title: 'Long notes', started: '2026-11-03 09:00' }, planGate: { n: n_, question: q, short: q.toLowerCase(), choices: ['Go ahead', 'Not yet'] } });
obs([proj('g', 'work', sess('sg', 'working'))], 40);
out = obs([proj('g', 'you', sess('sg', 'idle'), { gate: G(2, 'Show me a picture?') })], 41);
check('gate: "Plan gate: <short question>"', out.desktop.length === 1 && out.desktop[0].body === 'Plan gate: show me a picture?', JSON.stringify(out.desktop));
obs([proj('g', 'work', sess('sg', 'working'))], 41.5);
out = obs([proj('g', 'you', sess('sg', 'idle'), { gate: G(4, 'Install it?') })], 42);
check('gate: a second gate a minute later is notified too (no cooldown for gates)', out.desktop.length === 1);
obs([proj('g', 'work', sess('sg', 'working'))], 43);
out = obs([proj('g', 'you', sess('sg', 'idle'), { gate: G(4, 'Install it?') })], 60);
check('gate: the same gate again is not notified twice', out.desktop.length === 0);
await settle(6, 0);
const gn = notes().filter((x) => /^Plan gate: /.test(x.body));
check('gate: two notify calls, one per gate, the gate\'s short question and nothing else', gn.length === 2 && gn.every((x) => x.title === 'G needs you' && !x.body.includes(SECRET)), JSON.stringify(gn.map((x) => x.body)));

// Fallbacks.
obs([proj('h', 'work', sess('sh', 'working', { wsId: null }), { noWs: true })], 70);
out = obs([proj('h', 'you', sess('sh', 'asked', { wsId: null }), { noWs: true })], 71);
await settle(6, 1);
let o = osa();
check('fallback: a project with no workspace goes to osascript, not cmux', out.desktop.length === 1 && notes().length === 6 && o.length === 1, JSON.stringify(o));
check('fallback: display notification "<kind>" with title "<Project> needs you"', o[0] && o[0][0] === '-e' && o[0][1] === 'display notification "Asked you a question" with title "H needs you"', JSON.stringify(o[0]));
fixture({ notifyFail: true });
obs([proj('i', 'work', sess('si', 'working'))], 80);
obs([proj('i', 'you', sess('si', 'handback'))], 81);
await settle(6, 2);
o = osa();
check('fallback: cmux refusing falls back to osascript', o.length === 2 && /with title "I needs you"/.test(o[1][1]) && al.status().desktop.last.via === 'osascript', JSON.stringify(al.status().desktop.last));
fixture({ notifyFail: false });
check('fallback: AppleScript strings are escaped', desktop.appleString('Say "hi" \\ there\nnow') === '"Say \\"hi\\" \\\\ there now"', desktop.appleString('Say "hi" \\ there\nnow'));

// Separate channels: the phone on and the Mac off, then the reverse.
fs.writeFileSync(AF, JSON.stringify({ ...fileJson(), enabled: true, channel: 'webhook', webhook: { url: 'https://discord.com/api/webhooks/1/stub' } }), { mode: 0o600 });
al.setDesktop(false);
check('bell off: saved in alerts.json as desktop.enabled false', fileJson().desktop.enabled === false && al.status().desktop.enabled === false);
const before = notes().length + osa().length;
obs([proj('j', 'work', sess('sj', 'working'))], 90);
out = obs([proj('j', 'you', sess('sj', 'asked'))], 91);
await sleep(400);
check('bell off: no Mac notification, while the phone alert still goes', out.desktop.length === 0 && out.length === 1 && notes().length + osa().length === before, `${out.length} phone, ${out.desktop.length} desktop`);
al.setDesktop(true);
out = obs([proj('j', 'you', sess('sj', 'asked'))], 92);
check('bell on again: a state already in Needs you sends nothing', out.desktop.length === 0);
fs.writeFileSync(AF, JSON.stringify({ ...fileJson(), enabled: false }), { mode: 0o600 });
obs([proj('k', 'work', sess('sk', 'working'))], 100);
out = obs([proj('k', 'you', sess('sk', 'asked'))], 101);
check('phone off: the Mac still gets its one notification', out.length === 0 && out.desktop.length === 1);
await settle(7, 2);

// ------------------------------------------------------------ 2. the guard
// A test board with the real binaries: nothing may run.
const guard = execFileSync(process.execPath, ['--input-type=module', '-e', `
  const d = await import(${JSON.stringify(path.join(ROOT, 'server/desktop.mjs'))});
  const r1 = await d.send({ title: 'Ravenry test', body: 'never shown', workspaceId: 'ws-x' });
  const r2 = await d.send({ title: 'Ravenry test', body: 'never shown', workspaceId: null });
  console.log(JSON.stringify([r1, r2]));
`], { env: { ...process.env, RAVENRY_HOME: path.join(T, 'guard'), CMUX_BIN: '', MC_OSASCRIPT_BIN: '' }, encoding: 'utf8' });
const gr = JSON.parse(guard.trim().split('\n').pop());
check('guard: a test board never runs the real cmux or osascript', gr.every((x) => !x.ok && /test board does not run the real osascript/.test(x.error)) && /real cmux/.test(gr[0].error), guard.trim());

// ------------------------------------------------------------ 3. a test board
const PORT = 4674;
const BASE = `http://localhost:${PORT}`;
const MC = path.join(T, 'mc');
fs.mkdirSync(path.join(T, 'p1'), { recursive: true });
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: T }, projects: [{ id: 'p1', name: 'P1', folder: path.join(T, 'p1'), workspaces: [], brief: null }] }, null, 2));
const env = { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0' };
let server = null;
let log = '';
async function start() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch { /* */ } await sleep(250); }
  await sleep(500);
}
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const post = async (p, body, headers = {}) => { const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1', ...headers }, body: JSON.stringify(body) }); return { status: res.status, j: await res.json() }; };
try {
  await start();
  let st = await (await fetch(BASE + '/api/state')).json();
  check('board: the snapshot says the bell is on by default', st.alerts.desktop && st.alerts.desktop.enabled === true, JSON.stringify(st.alerts.desktop));
  let y = await post('/api/alerts/desktop', { enabled: false });
  check('board: the bell turns off through its route', y.status === 200 && y.j.desktop.enabled === false);
  const saved = JSON.parse(fs.readFileSync(path.join(MC, 'alerts.json'), 'utf8'));
  check('board: saved server-side in alerts.json, mode 0600', saved.desktop.enabled === false && (fs.statSync(path.join(MC, 'alerts.json')).mode & 0o777) === 0o600);
  y = await post('/api/alerts/desktop', { enabled: false }, { 'X-Ravenry': '0' });
  check('board: the write guard holds for the bell too', y.status === 403 || y.status === 400, String(y.status));
  await stop();
  await start();
  st = await (await fetch(BASE + '/api/state')).json();
  check('board: still off after a restart', st.alerts.desktop.enabled === false);
  y = await post('/api/alerts/desktop', { enabled: true });
  await sleep(300);
  st = await (await fetch(BASE + '/api/state')).json();
  check('board: back on, and the snapshot follows', y.status === 200 && st.alerts.desktop.enabled === true);
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  if (server) server.kill();
}
if (fails) console.log(log.split('\n').slice(-15).join('\n'));
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
