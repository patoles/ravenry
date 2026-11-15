#!/usr/bin/env node
// An answer the person gives on a card always reaches the agent that asked
// (server/cardanswer.mjs). 2026-11-15: the person answered "Publish now" on a
// card an agent had sent with `ravenry ask --no-wait`, and the agent did
// nothing: nothing was waiting on the answer.
//
// A real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd) and a board in
// Ravenry mode on 127.0.0.1, on scratch data, with its phone port on
// 127.0.0.1 and a paired phone's token. Three panes, each running
// tools/fake-agent.mjs (a stand-in that logs every line typed into it and
// records it in its transcript, never a real assistant): A and G as Claude
// Code sessions, C as a Codex one.
//
//   - a --no-wait ask answered on the board: the exact line typed once
//     into A, the card's record says delivered;
//   - the same session's other open card stays open (the typed line is
//     not the person writing: no withdrawal), also with the line queued;
//   - an ask that waits, answered: nothing typed, the ask prints it;
//   - answered through the phone's alert (the phone port, with the
//     device's token, as the app's Alerts.kt posts it): typed once;
//   - answered at the daemon, as the Mac app's panel does: typed once;
//   - a pick with a note; an approve declined with a reason (Codex);
//     a Codex ask;
//   - a secret: only "is ready" typed, its value nowhere (the panes'
//     logs, the transcripts, the hub's log and files);
//   - a session that is gone: nothing typed, its record and the board's
//     words say nothing was delivered;
//   - a wait after the typed answer still gets it.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/card-answer-test.mjs
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  card-answer-test: no ravenryd at ${BIN} (set RAVENRYD_BIN)`); process.exit(0); }

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'card-answer-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE = path.join(HOME, '.claude', 'projects');
const CODEX = path.join(HOME, '.codex');
for (const d of [path.join(MC, 'events'), PROJ, CLAUDE, path.join(CODEX, 'sessions', '2026', '11', '15')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const PS = path.join(T, 'stub-ps.json');
fs.writeFileSync(PS, '[]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500)}`); if (!ok) fails++; };
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

// ------------------------------------------------------------ a paired phone

const PTOKEN = crypto.randomBytes(32).toString('base64url');
const b64u = (b) => Buffer.from(b).toString('base64url');
fs.writeFileSync(path.join(MC, 'phone.json'), JSON.stringify({
  key: b64u(crypto.randomBytes(32)), access: true, away: false,
  tokens: [{ hash: crypto.createHash('sha256').update(PTOKEN).digest('hex'), id: 'dpixel01', name: 'Pixel', platform: 'android', app: '0.1.0', created: new Date().toISOString(), lastSeen: new Date().toISOString(), push: null }],
}), { mode: 0o600 });

// ------------------------------------------------------------ the daemon, its panes

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvca-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const DENV = { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let board = null;
let boardLog = '';
const kids = [];
process.on('exit', () => {
  for (const k of kids) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
});
process.on('SIGINT', () => process.exit(130));

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the daemon is up', !!sock);
if (!sock) process.exit(1);
const dc = await connectSocket(sock, { name: 'card-answer-test' });

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();
const SA = '7e57ca00-0000-4000-8000-0000000000a1';
const SG = '7e57ca00-0000-4000-8000-0000000000b2';
const SC = '7e57ca00-0000-4000-8000-0000000000c3';
const slug = PROJ.replace(/[^A-Za-z0-9-]/g, '-');
fs.mkdirSync(path.join(CLAUDE, slug), { recursive: true });
const tA = path.join(CLAUDE, slug, `${SA}.jsonl`);
const tG = path.join(CLAUDE, slug, `${SG}.jsonl`);
const tC = path.join(CODEX, 'sessions', '2026', '11', '15', `rollout-2026-11-15T10-00-00-${SC}.jsonl`);
const claudePrompt = (sid, at, text) => JSON.stringify({ type: 'user', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'user', content: text } }) + '\n';
const claudeSaid = (sid, at, text) => JSON.stringify({ type: 'assistant', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';
const claudeTurnEnd = (sid, at) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: iso(at) }) + '\n';
const claudeQueued = (sid, at, text) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: iso(at), content: text }) + '\n';
const codexLine = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload }) + '\n';
const codexPrompt = (at, text) => codexLine(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
for (const [f, sid] of [[tA, SA], [tG, SG]]) fs.writeFileSync(f, claudePrompt(sid, T0 - 120000, 'Get the release ready') + claudeSaid(sid, T0 - 100000, 'Ready. I asked on your board.') + claudeTurnEnd(sid, T0 - 99000));
fs.writeFileSync(tC, codexLine(T0 - 130000, 'session_meta', { id: SC, cwd: PROJ }) + codexLine(T0 - 130000, 'turn_context', { cwd: PROJ, model: 'gpt-x' }) + codexPrompt(T0 - 120000, 'Publish the docs')
  + codexLine(T0 - 100000, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The docs are ready to publish.' }] }) + codexLine(T0 - 99000, 'event_msg', { type: 'task_complete' }));

const logA = path.join(T, 'typed-a.jsonl'), logG = path.join(T, 'typed-g.jsonl'), logC = path.join(T, 'typed-c.jsonl');
const AGENT = path.join(ROOT, 'tools', 'fake-agent.mjs');
const newPane = async (kind, log, transcript, sid) => (await dc.request('pane.new', {
  cwd: PROJ, cols: 120, rows: 30,
  command: [process.execPath, AGENT],
  env: { FAKE_AGENT: kind, FAKE_AGENT_LOG: log, FAKE_AGENT_TRANSCRIPT: transcript, FAKE_AGENT_SESSION: sid, FAKE_AGENT_CWD: PROJ },
})).pane.id;
const paneA = await newPane('claude', logA, tA, SA), paneG = await newPane('claude', logG, tG, SG), paneC = await newPane('codex', logC, tC, SC);
const typed = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).line); } catch { return []; } };

const event = (sid, assistant, pane, transcript, ev, at) => fs.appendFileSync(path.join(MC, 'events', `${sid}.jsonl`), JSON.stringify({ at: iso(at), event: ev, session_id: sid, assistant, cwd: PROJ, terminal: 'ravenry', terminal_id: pane, pane, transcript_path: transcript }) + '\n');
for (const [sid, a, pane, t] of [[SA, 'claude', paneA, tA], [SG, 'claude', paneG, tG], [SC, 'codex', paneC, tC]]) {
  event(sid, a, pane, t, 'SessionStart', T0 - 130000);
  event(sid, a, pane, t, 'UserPromptSubmit', T0 - 120000);
  event(sid, a, pane, t, 'Stop', T0 - 99000);
}

// ------------------------------------------------------------ the board

const PORT = await freePort();
const PPORT = await freePort();
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  RAVENRY_PHONE_PORT: String(PPORT), RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_HUB_BIND: '127.0.0.1',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: SETTINGS, MC_CODEX: '0', MC_CODEX_HOME: CODEX, MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_ALERT_PRIME_MS: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
});
fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [] }));
board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => (await fetch(base + p)).json();
const rows = async () => ((await get('/api/state')).projects || []).find((p) => p.id === 'kite')?.sessions || [];
const seen = await until(async () => { const r = await rows(); return [paneA, paneG, paneC].every((p) => r.some((s) => s.surfaceId === `ravenry:${p}`)) ? r : null; }, 20000);
check('the three sessions are rows of kite, each in its pane', !!seen && seen.find((s) => s.surfaceId === `ravenry:${paneA}`).sessionId === SA && seen.find((s) => s.surfaceId === `ravenry:${paneC}`).assistant === 'codex',
  JSON.stringify((seen || await rows()).map((s) => ({ surfaceId: s.surfaceId, sessionId: s.sessionId, assistant: s.assistant }))) + '\n' + boardLog.slice(-1500));

// The person's answers: the board's (the Mac, as the board page posts them)
// and the phone's (its port, TLS, with the device's token, as Alerts.kt).
const answerOnBoard = async (body) => { const r = await fetch(base + '/api/checkpoints/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const answerOnPhone = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const q = https.request({ host: '127.0.0.1', port: PPORT, method: 'POST', path: '/api/checkpoints/answer', rejectUnauthorized: false, agent: false,
    headers: { Host: `10.0.2.2:${PPORT}`, Authorization: `Bearer ${PTOKEN}`, 'Content-Type': 'application/json', 'X-Ravenry': '1', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: j, text: b }); });
  });
  q.on('error', reject);
  q.end(data);
});

const ravenry = (pane, args) => new Promise((resolve) => {
  const k = spawn(BIN, args, { env: { ...DENV, RAVENRY_PANE: pane } });
  kids.push(k);
  let out = '', err = '';
  k.stdout.on('data', (d) => { out += d; });
  k.stderr.on('data', (d) => { err += d; });
  k.on('exit', (code) => resolve({ code, out, err }));
});
const idOf = async (pane, [cmd, ...rest]) => { const r = await ravenry(pane, [cmd, '--no-wait', ...rest]); return r.out.trim().split('\n').pop(); };
const all = async () => (await get('/api/checkpoints?all')).checkpoints;
const rec = async (id) => (await all()).find((c) => c.id === id) || null;
const openOnHub = (id) => until(async () => (await get('/api/checkpoints')).checkpoints.some((c) => c.id === id && c.state === 'open'), 10000);
// Typed lines that arrive within `ms`, after `n` were there; then a moment more, so a second copy would show.
const newLines = async (f, n, want = 1, ms = 15000) => { await until(async () => typed(f).length >= n + want, ms); await sleep(2500); return typed(f).slice(n); };

// ------------------------------------------------------------ a --no-wait ask, answered on the board

const other = await idOf(paneA, ['ask', 'Bump the version too?', '--option', 'Yes', '--option', 'No']);
const ask1 = await idOf(paneA, ['ask', 'Publish 0.1.53 now?', '--option', 'Publish now', '--option', 'Wait']);
check('A\'s two cards are open on the hub', !!(await openOnHub(ask1)) && !!(await openOnHub(other)));
let n = typed(logA).length;
let r = await answerOnBoard({ id: ask1, choice: 0 });
check('the board takes the answer', r.status === 200, r);
let got = await newLines(logA, n);
const LINE1 = 'Answer to your card "Publish 0.1.53 now?": Publish now';
check('--no-wait ask answered on the board: the exact line typed once into A', got.length === 1 && got[0] === LINE1, got);
check('its record says delivered to its session', (await until(async () => (await rec(ask1))?.delivered === 'session', 5000)) === true, await rec(ask1));
check('the line is in A\'s transcript, as the session recorded it', fs.readFileSync(tA, 'utf8').includes(JSON.stringify(LINE1)));
await sleep(6000);
let o = await rec(other);
check('A\'s other open card stays open (the typed line is not the person writing)', !!o && o.state === 'open', o);
check('the hub withdrew nothing', !/checkpoints: withdrew/.test(boardLog), boardLog.slice(-600));
// Claude Code queues a line typed while it works: the same line, queued, is not the person either.
fs.appendFileSync(tA, claudeQueued(SA, Date.now(), LINE1));
await sleep(5000);
o = await rec(other);
check('the line queued (typed mid-turn) does not withdraw it either', !!o && o.state === 'open', o);

// A wait after the typed delivery still gets the answer.
const late = await ravenry(paneA, ['checkpoint', ask1, '--wait']);
check('a wait after the typed delivery still gets the answer', late.code === 0 && late.out.trim() === 'Publish now', late);

// ------------------------------------------------------------ an ask that waits

n = typed(logA).length;
const waiting = ravenry(paneA, ['ask', 'Tag the release?', '--option', 'Tag it', '--option', 'Not yet']);
const waitCp = await until(async () => (await get('/api/checkpoints')).checkpoints.find((c) => c.title === 'Tag the release?' && c.state === 'open'), 10000);
await sleep(500);
r = await answerOnBoard({ id: waitCp && waitCp.id, choice: 0 });
const w = await Promise.race([waiting, sleep(10000).then(() => null)]);
check('an ask that waits prints the answer and exits 0', r.status === 200 && !!w && w.code === 0 && w.out.trim() === 'Tag it', { r, w });
await sleep(6000);
check('and nothing is typed into A', typed(logA).length === n, typed(logA).slice(n));
check('its record has no delivery', !(await rec(waitCp.id))?.delivered);

// ------------------------------------------------------------ the phone's alert

const ask2 = await idOf(paneA, ['ask', 'Send the testers a note?', '--option', 'Send it', '--option', 'Skip']);
await openOnHub(ask2);
n = typed(logA).length;
r = await answerOnPhone({ id: ask2, choice: 0, by: 'phone' });
check('the phone\'s alert answer (phone port, the device\'s token) is taken', r.status === 200, r);
got = await newLines(logA, n);
check('answered through the phone: typed once into A', got.length === 1 && got[0] === 'Answer to your card "Send the testers a note?": Send it', got);

// At the daemon itself, as the Mac app's panel answers (through the daemon that holds it).
const ask3 = await idOf(paneA, ['ask', 'Write the release notes?', '--option', 'Write them', '--option', 'Skip']);
await openOnHub(ask3);
n = typed(logA).length;
const direct = await dc.request('checkpoint.answer', { checkpoint: ask3, choice: 0, by: 'mac' }).catch((e) => ({ error: e.message }));
got = await newLines(logA, n);
check('answered at the daemon (the Mac app\'s path): typed once into A', !!direct.checkpoint && direct.checkpoint.nobody_waiting === true && got.length === 1 && got[0] === 'Answer to your card "Write the release notes?": Write them', { direct, got });

// ------------------------------------------------------------ a pick with a note

const pngA = path.join(T, 'a.png'), pngB = path.join(T, 'b.png');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(pngA, PNG); fs.writeFileSync(pngB, PNG);
const pick = await idOf(paneA, ['pick', 'Which header?', '--variant', `A=${pngA}`, '--variant', `B=${pngB}`]);
await openOnHub(pick);
n = typed(logA).length;
r = await answerOnBoard({ id: pick, pick: { label: 'B', note: 'make it darker' } });
got = await newLines(logA, n);
check('a pick with a note: the variant and the note, typed once', r.status === 200 && got.length === 1 && got[0] === 'Answer to your card "Which header?": B. Their note: make it darker', { r, got });

// ------------------------------------------------------------ a secret

const SECRET = 'hunter2-' + crypto.randomBytes(6).toString('hex');
const secret = await idOf(paneA, ['secret', 'Deploy token', '--', 'sh', '-c', 'read x; echo got it']);
await openOnHub(secret);
n = typed(logA).length;
r = await answerOnBoard({ id: secret, secret: SECRET });
got = await newLines(logA, n);
check('a secret: only the "is ready" line typed, once', r.status === 200 && got.length === 1 && got[0] === `Your secret for "Deploy token" is ready: run ravenry checkpoint ${secret} --wait to read it.`, { r, got });

// ------------------------------------------------------------ Codex

const other2 = await idOf(paneC, ['ask', 'Also post it?', '--option', 'Yes']);
const askC = await idOf(paneC, ['ask', 'Publish the docs now?', '--option', 'Publish', '--option', 'Wait']);
await openOnHub(askC);
n = typed(logC).length;
r = await answerOnBoard({ id: askC, choice: 0 });
got = await newLines(logC, n);
check('Codex: a --no-wait ask answered, typed once into C', r.status === 200 && got.length === 1 && got[0] === 'Answer to your card "Publish the docs now?": Publish', { r, got });
check('Codex: the line is in C\'s rollout', fs.readFileSync(tC, 'utf8').includes(JSON.stringify('Answer to your card "Publish the docs now?": Publish')));
const approveC = await idOf(paneC, ['approve', 'touch published', '--cwd', T, '--why', 'Publish the docs']);
await openOnHub(approveC);
n = typed(logC).length;
r = await answerOnBoard({ id: approveC, decline: true, reason: 'fix the links first' });
got = await newLines(logC, n);
check('Codex: an approve declined with a reason, typed once', r.status === 200 && got.length === 1 && got[0] === 'Answer to your card "Run touch published": declined. Their reason: fix the links first', { r, got });
await sleep(5000);
o = await rec(other2);
check('Codex: C\'s other open card stays open', !!o && o.state === 'open', o);

// ------------------------------------------------------------ a session that is gone

const askG = await idOf(paneG, ['ask', 'Clean the old builds?', '--option', 'Clean', '--option', 'Keep']);
await openOnHub(askG);
await dc.request('pane.close', { pane: paneG, grace_ms: 200 }).catch((e) => ({ error: e.message }));
await sleep(3000);
r = await answerOnBoard({ id: askG, choice: 0 });
const gone = await until(async () => { const c = await rec(askG); return c && c.delivered ? c : null; }, 15000);
check('a session that is gone: the answer is kept, not delivered', r.status === 200 && !!gone && gone.state === 'answered' && gone.delivered === 'ended', { r, gone });
check('the board\'s words say nothing was delivered', !!gone && gone.words.after.text === `You answered {where}. Its session had ended, so nothing was delivered: ${gone.words.whoMid} was not told.`, gone && gone.words.after);
check('nothing was typed into G', typed(logG).length === 0, typed(logG));

// ------------------------------------------------------------ the secret's value, nowhere

await sleep(1000);
const hubFiles = fs.readdirSync(MC, { recursive: true }).map((f) => path.join(MC, f)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
const where = [logA, logC, logG, tA, tC, tG, ...hubFiles].filter((f) => { try { return fs.readFileSync(f, 'utf8').includes(SECRET); } catch { return false; } });
check('the secret\'s value is in no pane\'s typed lines, transcript or hub file', where.length === 0, where);
check('nor in the hub\'s log', !boardLog.includes(SECRET));
check('the hub logged each delivery without the answer', /checkpoints: \S+ \(ask\) closed with nobody waiting: its answer was typed into its session/.test(boardLog) && /not delivered \(ended/.test(boardLog), boardLog.slice(-1200));

for (const id of [other, other2]) { try { await dc.request('checkpoint.cancel', { checkpoint: id }); } catch { /* closed */ } }
dc.close();
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
