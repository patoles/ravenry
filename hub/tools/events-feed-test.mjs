#!/usr/bin/env node
// `ravenry events` against a board: the board's own events reach the feed
// (GET /api/feed, server/feed.mjs), each once, and a card is said once
// although both the daemon and the board know it.
//
// A real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd) on its own
// socket, a second one as another machine behind a stand-in ssh (as
// tools/machines-test.mjs), and a board in Ravenry mode on 127.0.0.1 on
// scratch data. Two panes run tools/fake-agent.mjs as Claude Code sessions
// (never a real assistant). `ravenryd events --json` runs as an agent
// would, and its raw output is read:
//
//   - a session that came on the board while it ran: session.started once;
//   - a session whose turn ended (Stop): session.needs_you once;
//   - a card asked, answered on the board: checkpoint.opened and
//     checkpoint.answered, once each (the board knows it too and does not
//     say it again);
//   - a card cancelled: checkpoint.cancelled once;
//   - a secret answered on the board: its value nowhere in the output;
//   - the other machine: its pane's pane.created once, with its name as
//     machine; its connection dropping: daemon.down for it;
//   - the feed refused on the phone port, given only on 127.0.0.1.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/events-feed-test.mjs
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  events-feed-test: no ravenryd at ${BIN} (set RAVENRYD_BIN)`); process.exit(0); }

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'events-feed-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE = path.join(HOME, '.claude', 'projects');
for (const d of [path.join(MC, 'events'), PROJ, CLAUDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, machines: [{ name: 'devbox', host: 'devbox' }] }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const PS = path.join(T, 'stub-ps.json');
fs.writeFileSync(PS, '[]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2500)}`); if (!ok) fails++; };
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

// ------------------------------------------------------------ a paired phone (to be refused the feed)

const PTOKEN = crypto.randomBytes(32).toString('base64url');
const b64u = (b) => Buffer.from(b).toString('base64url');
fs.writeFileSync(path.join(MC, 'phone.json'), JSON.stringify({
  key: b64u(crypto.randomBytes(32)), access: true, away: false,
  tokens: [{ hash: crypto.createHash('sha256').update(PTOKEN).digest('hex'), id: 'dpixel01', name: 'Pixel', platform: 'android', app: '0.1.0', created: new Date().toISOString(), lastSeen: new Date().toISOString(), push: null }],
}), { mode: 0o600 });

// ------------------------------------------------------------ this machine's daemon, and another machine's

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvef-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const DENV = { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
const R = { home: path.join(D, 'rhome'), run: path.join(D, 'rrun'), state: path.join(D, 'rstate') };
fs.mkdirSync(R.home);
const FAKE = path.join(D, 'fakebin');
fs.mkdirSync(FAKE);
fs.symlinkSync(BIN, path.join(FAKE, 'ravenryd'));
const DOWN = path.join(D, 'ssh-down');
const PIDS = path.join(D, 'ssh-pids');
// The stand-in ssh: runs the remote command line here, as the other
// machine (its own HOME and runtime folder), in an "ssh session".
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
if [ -f '${DOWN}' ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
echo $$ >> '${PIDS}'
exec env -i HOME='${R.home}' PATH='${FAKE}:/usr/bin:/bin' SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR='${R.run}' RAVENRY_STATE_DIR='${R.state}' SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"
`, { mode: 0o755 });
const REMOTE_ENV = { HOME: R.home, PATH: `${FAKE}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: R.run, RAVENRY_STATE_DIR: R.state };

const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let board = null;
let boardLog = '';
const kids = [];
process.on('exit', () => {
  for (const k of kids) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  try {
    const ds = JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: REMOTE_ENV, encoding: 'utf8' }) || '[]');
    for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  try { for (const pid of fs.readFileSync(PIDS, 'utf8').split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGTERM'); } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
});
process.on('SIGINT', () => process.exit(130));

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the daemon is up', !!sock);
if (!sock) process.exit(1);
const dc = await connectSocket(sock, { name: 'events-feed-test' });

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();
const SA = '7e57fe00-0000-4000-8000-0000000000a1';
const SB = '7e57fe00-0000-4000-8000-0000000000b2';
const slug = PROJ.replace(/[^A-Za-z0-9-]/g, '-');
fs.mkdirSync(path.join(CLAUDE, slug), { recursive: true });
const tA = path.join(CLAUDE, slug, `${SA}.jsonl`);
const tB = path.join(CLAUDE, slug, `${SB}.jsonl`);
const claudePrompt = (sid, at, text) => JSON.stringify({ type: 'user', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'user', content: text } }) + '\n';
const claudeSaid = (sid, at, text) => JSON.stringify({ type: 'assistant', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';
const claudeTurnEnd = (sid, at) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: iso(at) }) + '\n';

const AGENT = path.join(ROOT, 'tools', 'fake-agent.mjs');
const newPane = async (log, transcript, sid) => (await dc.request('pane.new', {
  cwd: PROJ, cols: 120, rows: 30,
  command: [process.execPath, AGENT],
  env: { FAKE_AGENT: 'claude', FAKE_AGENT_LOG: log, FAKE_AGENT_TRANSCRIPT: transcript, FAKE_AGENT_SESSION: sid, FAKE_AGENT_CWD: PROJ },
})).pane.id;
// A: a session in its pane (a prompt, no Stop yet).
fs.writeFileSync(tA, claudePrompt(SA, T0 - 20000, 'Get the release ready'));
const paneA = await newPane(path.join(T, 'typed-a.jsonl'), tA, SA);
const event = (sid, pane, transcript, ev, at) => fs.appendFileSync(path.join(MC, 'events', `${sid}.jsonl`), JSON.stringify({ at: iso(at), event: ev, session_id: sid, assistant: 'claude', cwd: PROJ, terminal: 'ravenry', terminal_id: pane, pane, transcript_path: transcript }) + '\n');
event(SA, paneA, tA, 'SessionStart', T0 - 30000);
event(SA, paneA, tA, 'UserPromptSubmit', T0 - 20000);

// ------------------------------------------------------------ the board

const PORT = await freePort();
const PPORT = await freePort();
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  RAVENRY_PHONE_PORT: String(PPORT), RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_HUB_BIND: '127.0.0.1',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: SETTINGS, MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_ALERT_PRIME_MS: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
  RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_MACHINE_RETRY_MS: '300',
});
fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [] }));
board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => (await fetch(base + p)).json();
const rows = async () => ((await get('/api/state')).projects || []).find((p) => p.id === 'kite')?.sessions || [];
const rowOf = async (pane) => (await rows()).find((s) => s.surfaceId === `ravenry:${pane}`) || null;
const rowA = await until(async () => rowOf(paneA), 20000);
check('session A is a row of kite', !!rowA && rowA.sessionId === SA, JSON.stringify(await rowOf(paneA)) + '\n' + boardLog.slice(-1500));
const remoteUp = await until(async () => fs.existsSync(R.run) && fs.readdirSync(R.run).some((f) => f.endsWith('.sock')), 15000);
check('the other machine\'s daemon runs (started by the board over the stand-in ssh)', !!remoteUp);
await sleep(1500);

// ------------------------------------------------------------ ravenry events, as an agent runs it

// A prompt just now: A works until its Stop below (a screen at rest more
// than 20 s after a prompt reads as a turn that ended without one).
event(SA, paneA, tA, 'UserPromptSubmit', Date.now());
fs.appendFileSync(tA, claudePrompt(SA, Date.now(), 'Now the changelog'));
check('A works', !!(await until(async () => { const r = await rowOf(paneA); return r && r.state === 'working' ? r : null; }, 10000)), JSON.stringify(await rowOf(paneA)));

const FEED_ENV = { HOME, PATH: DENV.PATH, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE, RAVENRY_HUB_URL: base };
let raw = '';
let errText = '';
const feedProc = spawn(BIN, ['events', '--json'], { env: FEED_ENV });
kids.push(feedProc);
feedProc.stdout.on('data', (d) => { raw += d; });
feedProc.stderr.on('data', (d) => { errText += d; });
const following = await until(async () => (/^ravenry events: following/m.test(errText) ? errText : null), 15000);
check('ravenry events follows the daemon and the board', !!following && following.includes(`the board at ${base}`) && following.includes('1 daemon on this machine'), errText);
const evs = () => raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
const count = (fn) => evs().filter(fn).length;
const waitFor = (what, fn, ms = 15000) => until(async () => evs().find(fn) || null, ms);

// ------------------------------------------------------------ a session turns needs-you

fs.appendFileSync(tA, claudeSaid(SA, Date.now() - 500, 'The release is ready. Ship it now?') + claudeTurnEnd(SA, Date.now() - 400));
event(SA, paneA, tA, 'Stop', Date.now());
const needs = await waitFor('session.needs_you', (e) => e.event === 'session.needs_you' && e.pane === paneA, 20000);
check('session.needs_you when A\'s turn ended', !!needs && needs.session === SA && needs.project_name === 'kite' && !!needs.why && needs.machine === 'local', needs || (JSON.stringify(await rowOf(paneA)) + '\n' + raw.slice(-2000)));
await sleep(3000);
check('session.needs_you said once', count((e) => e.event === 'session.needs_you' && e.pane === paneA) === 1, raw);

// ------------------------------------------------------------ a session comes on the board

fs.writeFileSync(tB, claudePrompt(SB, Date.now() - 5000, 'Write the notes') + claudeSaid(SB, Date.now() - 3000, 'Writing them.'));
const paneB = await newPane(path.join(T, 'typed-b.jsonl'), tB, SB);
event(SB, paneB, tB, 'SessionStart', Date.now() - 6000);
event(SB, paneB, tB, 'UserPromptSubmit', Date.now() - 5000);
const startedB = await waitFor('session.started', (e) => e.event === 'session.started' && e.pane === paneB, 20000);
check('session.started for the session that came on the board', !!startedB && startedB.session === SB && startedB.project === 'kite' && startedB.machine === 'local', startedB || raw.slice(-2000));

await sleep(2000);
check('session.started said once', count((e) => e.event === 'session.started' && e.pane === paneB) === 1, raw);

// ------------------------------------------------------------ cards

const answerOnBoard = async (body) => { const r = await fetch(base + '/api/checkpoints/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const ravenry = (pane, args) => new Promise((resolve) => {
  const k = spawn(BIN, args, { env: { ...DENV, RAVENRY_PANE: pane, RAVENRY_SOCKET: sock } });
  kids.push(k);
  let out = '', err = '';
  k.stdout.on('data', (d) => { out += d; });
  k.stderr.on('data', (d) => { err += d; });
  k.on('exit', (code) => resolve({ code, out, err }));
});
const openOnHub = (id) => until(async () => (await get('/api/checkpoints')).checkpoints.some((c) => c.id === id && c.state === 'open'), 10000);
const cpIs = (name, id) => (e) => e.event === name && e.checkpoint && e.checkpoint.id === id;

// An ask that waits (so nothing is typed into A), answered on the board.
const waiting = ravenry(paneA, ['ask', 'Ship 0.1.53?', '--option', 'Ship it', '--option', 'Wait']);
const opened = await waitFor('checkpoint.opened', (e) => e.event === 'checkpoint.opened' && e.checkpoint && e.checkpoint.title === 'Ship 0.1.53?');
const askId = opened && opened.checkpoint.id;
check('checkpoint.opened, from the daemon', !!opened && opened.pane === paneA && opened.machine === 'local' && opened.checkpoint.kind === 'ask', opened || raw.slice(-1500));
await openOnHub(askId);
let r = await answerOnBoard({ id: askId, choice: 0 });
const w = await Promise.race([waiting, sleep(10000).then(() => null)]);
check('the ask is answered on the board', r.status === 200 && !!w && w.code === 0 && w.out.trim() === 'Ship it', { r, w });
const answered = await waitFor('checkpoint.answered', cpIs('checkpoint.answered', askId));
check('checkpoint.answered, without the answer (this feed runs in no pane: not the asker)', !!answered && answered.answer === undefined, answered);

// A card cancelled.
const can = await ravenry(paneA, ['ask', '--no-wait', 'Tag it too?', '--option', 'Yes']);
const canId = can.out.trim();
await openOnHub(canId);
await dc.request('checkpoint.cancel', { checkpoint: canId, reason: 'not needed now' });
const cancelled = await waitFor('checkpoint.cancelled', cpIs('checkpoint.cancelled', canId));
check('checkpoint.cancelled', !!cancelled && cancelled.checkpoint.reason === 'not needed now', cancelled);

// A secret, answered on the board.
const SECRET = 'hunter2-' + crypto.randomBytes(6).toString('hex');
const sec = await ravenry(paneA, ['secret', '--no-wait', 'Deploy token', '--', 'sh', '-c', "printf 'Token: '; read v; echo stored"]);
const secId = sec.out.trim();
await openOnHub(secId);
r = await answerOnBoard({ id: secId, secret: SECRET });
const secDone = await waitFor('checkpoint.answered (secret)', cpIs('checkpoint.answered', secId));
check('the secret answered on the board, its card answered in the feed', r.status === 200 && !!secDone, { r, secDone });

await sleep(4000);
for (const [name, id] of [['checkpoint.opened', askId], ['checkpoint.answered', askId], ['checkpoint.opened', canId], ['checkpoint.cancelled', canId], ['checkpoint.opened', secId], ['checkpoint.answered', secId]]) {
  check(`${name} ${id === askId ? '(ask)' : id === canId ? '(cancelled)' : '(secret)'} said once, though the board knows it too`, count(cpIs(name, id)) === 1, raw);
}

// ------------------------------------------------------------ the other machine

const rid = execFileSync(BIN, ['new', '--name', 'remote-build', '--', '/bin/sh', '-c', 'exec cat'], { env: REMOTE_ENV, encoding: 'utf8' }).trim();
const rp = await waitFor('the other machine\'s pane.created', (e) => e.event === 'pane.created' && e.pane === rid, 15000);
check('another machine\'s pane: pane.created with its machine\'s name', !!rp && rp.machine === 'devbox' && rp.name === 'remote-build' && !!rp.daemon, rp || raw.slice(-1500) + '\n' + boardLog.slice(-1500));
await sleep(2000);
check('its pane.created said once (the board relays it, nobody else does)', count((e) => e.event === 'pane.created' && e.pane === rid) === 1, raw);
check('no event of this machine relayed by the board as another machine\'s', !evs().some((e) => e.machine === 'devbox' && (e.pane === paneA || e.pane === paneB)), raw);

fs.writeFileSync(DOWN, '');
try { for (const pid of fs.readFileSync(PIDS, 'utf8').split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ }
const down = await waitFor('daemon.down (devbox)', (e) => e.event === 'daemon.down' && e.machine === 'devbox', 15000);
check('its connection dropping: daemon.down for devbox', !!down, raw.slice(-1500));
fs.rmSync(DOWN, { force: true });
const back = await waitFor('daemon.up (devbox)', (e) => e.event === 'daemon.up' && e.machine === 'devbox', 15000);
check('and back: daemon.up for devbox', !!back, raw.slice(-1500));

// ------------------------------------------------------------ who may read the feed

const onPhonePort = await new Promise((resolve) => {
  const q = https.request({ host: '127.0.0.1', port: PPORT, method: 'GET', path: '/api/feed', rejectUnauthorized: false, agent: false, headers: { Host: `10.0.2.2:${PPORT}`, Authorization: `Bearer ${PTOKEN}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  q.on('error', (e) => resolve(e.message));
  q.end();
});
check('the feed is refused on the phone port, even with a paired phone\'s token', onPhonePort === 403, String(onPhonePort));

// ------------------------------------------------------------ the board's diff, on its own

// What the e2e above does not reach in a few seconds: a session that stops
// needing you, ends, writes its hand-off, or is replaced in its tab (/clear).
const feed = await import('../server/feed.mjs');
const proj = (sessions) => [{ id: 'kite', name: 'kite', machine: null, sessions }];
const sess = (o) => ({ surfaceId: 'ravenry:paaaaaaa', sessionId: 's-1', topic: 'kite', assistant: 'claude', state: 'working', words: {}, handoff: { state: 'none' }, ...o });
const d = (a, b, marks = new Map()) => feed.diff(feed.sessionsOf(proj(a)), feed.sessionsOf(proj(b), marks), 'T').map((e) => `${e.event}${e.why ? ':' + e.why : ''}${e.session ? '@' + e.session : ''}`);
check('diff: working to asked is needs_you (why asked)', JSON.stringify(d([sess()], [sess({ state: 'asked', words: { question: 'Ship it?' } })])) === '["session.needs_you:asked@s-1"]');
check('diff: asked to working is needs_you_cleared', JSON.stringify(d([sess({ state: 'asked' })], [sess()])) === '["session.needs_you_cleared@s-1"]');
check('diff: an open card\'s mark makes a working session need you', JSON.stringify(d([sess()], [sess()], new Map([['kite/ravenry:paaaaaaa', { kind: 'ask', text: 'Ship it?' }]]))) === '["session.needs_you:ask@s-1"]');
check('diff: a hand-off written is handoff.ready', JSON.stringify(d([sess({ state: 'handback' })], [sess({ state: 'handback', handoff: { state: 'written', file: '~/x/BRIEF.md' } })])) === '["handoff.ready@s-1"]');
check('diff: a session that needs you and leaves: cleared, then ended', JSON.stringify(d([sess({ state: 'dialog' })], [])) === '["session.needs_you_cleared@s-1","session.ended@s-1"]');
check('diff: a new session in the same tab (/clear): the old one ended, the new one started', JSON.stringify(d([sess()], [sess({ sessionId: 's-2' })])) === '["session.ended@s-1","session.started@s-2"]');
check('diff: a session id learnt later is the same session', JSON.stringify(d([sess({ sessionId: null })], [sess()])) === '[]');
check('diff: a handed session does not need you', JSON.stringify(d([sess()], [sess({ state: 'handback', handed: true })])) === '[]');

// ------------------------------------------------------------ the secret's value, nowhere

check('every line of the output is one JSON object', !evs().some((e) => e.bad), raw);
check('the secret\'s value is nowhere in the feed\'s output', !raw.includes(SECRET) && !errText.includes(SECRET));
check('no em dash in the output', !raw.includes('\u2014'));

feedProc.kill('SIGTERM');
dc.close();
console.log(`events: ${evs().length} lines, ${[...new Set(evs().map((e) => e.event))].join(', ')}`);
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
