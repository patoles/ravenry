#!/usr/bin/env node
// A card closes by itself when the person answers the agent in its terminal
// (server/terminalanswer.mjs). 2026-11-15: a question card stayed on the
// board and the phone after the person wrote "Ok you can do those fixes" to
// the session that asked, until they clicked an answer they had given.
//
// A real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd) and a board in
// Ravenry mode on 127.0.0.1, on scratch data: three panes, each a session
// the hook events place there (A and B Claude Code, C Codex), with fixture
// transcripts. Agents' cards: on A an ask (--no-wait), an ask that waits, a
// pick and a secret; on B an ask; on C an approve. A paired phone (a stub
// push endpoint here, no ntfy, no real phone) gets their alerts.
//
//   - a prompt older than the card (written after it, dated before) leaves
//     it open;
//   - a prompt in session B withdraws B's card and leaves A's open;
//   - the person's prompt in A: A's ask, the waiting ask and the pick leave
//     the state, the board (headless Chromium) and the phone (a `close` for
//     each alert); their record says "Answered in the terminal", with none
//     of the typed words in the hub's files; the waiting `ravenry ask` exits
//     123 and says to read their message; the secret stays open;
//   - a message typed while the agent works (Claude Code queues it) does too;
//   - Codex: a prompt in C's rollout withdraws C's approve, and its command
//     never runs.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/terminal-answer-test.mjs
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  terminal-answer-test: no ravenryd at ${BIN} (set RAVENRYD_BIN)`); process.exit(0); }

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'terminal-answer-'));
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

// Its push endpoint is a stub on 127.0.0.1; each body is decrypted as the
// app does (RFC 8291), so the test reads the messages the phone would get.
const b64u = (b) => Buffer.from(b).toString('base64url');
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const auth = crypto.randomBytes(16);
function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const rec = body.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prk0 = hmac(auth, ua.computeSecret(asPub));
  const ikm = hmac(prk0, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(rec.subarray(rec.length - 16));
  const out = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  return JSON.parse(out.subarray(0, end).toString('utf8'));
}
const pushed = [];
const stub = http.createServer((req, res) => { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => { try { pushed.push(decrypt(Buffer.concat(ch))); } catch (e) { pushed.push({ error: e.message }); } res.writeHead(201); res.end(); }); });
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(MC, 'phone.json'), JSON.stringify({
  key: b64u(crypto.randomBytes(32)), access: false, away: false,
  tokens: [{ hash: crypto.randomBytes(32).toString('hex'), id: 'dpixel01', name: 'Pixel', platform: 'android', app: '0.1.0', created: new Date().toISOString(), lastSeen: new Date().toISOString(),
    push: { kind: 'unifiedpush', endpoint: `http://127.0.0.1:${stub.address().port}/up/kite`, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth), at: new Date().toISOString() } }],
}), { mode: 0o600 });
const alertOf = (id) => pushed.find((m) => m.type === 'alert' && m.id === `cp:${id}`);
const closeOf = (id) => pushed.find((m) => m.type === 'close' && m.id === `cp:${id}`);

// ------------------------------------------------------------ the daemon, its panes

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvta-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const DENV = { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let board = null;
let browser = null;
let boardLog = '';
const kids = [];
process.on('exit', () => {
  for (const k of kids) { try { k.kill('SIGTERM'); } catch { /* gone */ } }
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  stub.close();
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
});
process.on('SIGINT', () => process.exit(130));

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the daemon is up', !!sock);
if (!sock) process.exit(1);
const dc = await connectSocket(sock, { name: 'terminal-answer-test' });
const newPane = async () => (await dc.request('pane.new', { cwd: PROJ, command: ['/bin/sh', '-c', 'exec sleep 600'] })).pane.id;
const paneA = await newPane(), paneB = await newPane(), paneC = await newPane();

// ------------------------------------------------------------ the sessions

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();
const SA = '7e57a000-0000-4000-8000-0000000000a1';
const SB = '7e57a000-0000-4000-8000-0000000000b2';
const SC = '7e57a000-0000-4000-8000-0000000000c3';
const slug = PROJ.replace(/[^A-Za-z0-9-]/g, '-');
fs.mkdirSync(path.join(CLAUDE, slug), { recursive: true });
const tA = path.join(CLAUDE, slug, `${SA}.jsonl`);
const tB = path.join(CLAUDE, slug, `${SB}.jsonl`);
const tC = path.join(CODEX, 'sessions', '2026', '11', '15', `rollout-2026-11-15T10-00-00-${SC}.jsonl`);
const claudePrompt = (sid, at, text) => JSON.stringify({ type: 'user', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'user', content: text } }) + '\n';
const claudeSaid = (sid, at, text) => JSON.stringify({ type: 'assistant', sessionId: sid, cwd: PROJ, timestamp: iso(at), uuid: crypto.randomUUID(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';
const claudeTurnEnd = (sid, at) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: iso(at) }) + '\n';
const claudeQueued = (sid, at, text) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: iso(at), content: text }) + '\n';
const codexLine = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload }) + '\n';
const codexPrompt = (at, text) => codexLine(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
for (const [f, sid] of [[tA, SA], [tB, SB]]) fs.writeFileSync(f, claudePrompt(sid, T0 - 120000, 'Fix the header on the pricing page') + claudeSaid(sid, T0 - 100000, 'I can fix it two ways. Build it or not?') + claudeTurnEnd(sid, T0 - 99000));
fs.writeFileSync(tC, codexLine(T0 - 130000, 'session_meta', { id: SC, cwd: PROJ }) + codexLine(T0 - 130000, 'turn_context', { cwd: PROJ, model: 'gpt-x' }) + codexPrompt(T0 - 120000, 'Publish the docs')
  + codexLine(T0 - 100000, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The docs are ready to publish.' }] }) + codexLine(T0 - 99000, 'event_msg', { type: 'task_complete' }));
const event = (sid, assistant, pane, transcript, ev, at) => fs.appendFileSync(path.join(MC, 'events', `${sid}.jsonl`), JSON.stringify({ at: iso(at), event: ev, session_id: sid, assistant, cwd: PROJ, terminal: 'ravenry', terminal_id: pane, pane, transcript_path: transcript }) + '\n');
for (const [sid, a, pane, t] of [[SA, 'claude', paneA, tA], [SB, 'claude', paneB, tB], [SC, 'codex', paneC, tC]]) {
  event(sid, a, pane, t, 'SessionStart', T0 - 130000);
  event(sid, a, pane, t, 'UserPromptSubmit', T0 - 120000);
  event(sid, a, pane, t, 'Stop', T0 - 99000);
}

// ------------------------------------------------------------ the board

const PORT = await freePort();
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
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
const seen = await until(async () => { const r = await rows(); return [paneA, paneB, paneC].every((p) => r.some((s) => s.surfaceId === `ravenry:${p}`)) ? r : null; }, 20000);
check('the three sessions are rows of kite, each in its pane', !!seen && seen.find((s) => s.surfaceId === `ravenry:${paneA}`).sessionId === SA && seen.find((s) => s.surfaceId === `ravenry:${paneC}`).assistant === 'codex',
  JSON.stringify((seen || await rows()).map((s) => ({ surfaceId: s.surfaceId, sessionId: s.sessionId, assistant: s.assistant }))) + '\n' + boardLog.slice(-1500));

// ------------------------------------------------------------ the cards

const ravenry = (pane, args) => new Promise((resolve) => {
  const k = spawn(BIN, args, { env: { ...DENV, RAVENRY_PANE: pane } });
  kids.push(k);
  let out = '';
  k.stdout.on('data', (d) => { out += d; });
  k.stderr.on('data', (d) => { out += d; });
  k.on('exit', (code) => resolve({ code, out }));
});
// --no-wait right after the command: anything after `--` is the program's.
const idOf = async (pane, [cmd, ...rest]) => { const r = await ravenry(pane, [cmd, '--no-wait', ...rest]); return r.out.trim().split('\n').pop(); };
const pngA = path.join(T, 'a.png'), pngB = path.join(T, 'b.png');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(pngA, PNG); fs.writeFileSync(pngB, PNG);
const askA = await idOf(paneA, ['ask', 'Build it or not?', '--option', 'Build it', '--option', 'Not yet']);
const waiting = ravenry(paneA, ['ask', 'Which header first?', '--option', 'Pricing', '--option', 'Docs']);
const pickA = await idOf(paneA, ['pick', 'Which header?', '--variant', `A=${pngA}`, '--variant', `B=${pngB}`]);
const secretA = await idOf(paneA, ['secret', 'Deploy token', '--', 'sh', '-c', 'read x']);
const askB = await idOf(paneB, ['ask', 'Ship the beta?', '--option', 'Ship it', '--option', 'Not yet']);
const ran = path.join(T, 'published');
const approveC = await idOf(paneC, ['approve', `touch '${ran}'`, '--why', 'Publish the docs']);
const open = async () => (await get('/api/checkpoints')).checkpoints;
const all = async () => (await get('/api/checkpoints?all')).checkpoints;
const cps = await until(async () => { const l = await open(); return l.filter((c) => c.state === 'open').length >= 6 ? l : null; }, 15000);
const waitId = (cps || []).find((c) => c.title === 'Which header first?')?.id;
check('the six cards are open on the hub, each with its project and session', !!cps && !!waitId && [askA, pickA, secretA, waitId].every((id) => cps.find((c) => c.id === id)?.surfaceId === `ravenry:${paneA}`) && cps.find((c) => c.id === askB)?.surfaceId === `ravenry:${paneB}` && cps.find((c) => c.id === approveC)?.projectId === 'kite',
  JSON.stringify((cps || await open()).map((c) => [c.id, c.kind, c.state, c.surfaceId])));
check('the phone got an alert for each', !!(await until(async () => [askA, pickA, askB, approveC, waitId].every((id) => alertOf(id)), 10000)), JSON.stringify(pushed.map((m) => [m.type, m.id])));

// The board, headless, on 127.0.0.1: A's card.
const { chromium } = await import('playwright');
browser = await chromium.launch();
const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const pageErrors = [];
pg.on('pageerror', (e) => pageErrors.push(e.message));
await pg.goto(`${base}/#kite`);
const onBoard = async (id) => pg.evaluate((x) => !!document.querySelector(`[data-cp="${x}"]`), id);
const boardShows = await until(async () => (await pg.evaluate(() => [...document.querySelectorAll('[data-cp]')].map((e) => e.dataset.cp))).length > 0, 15000);
const shownIds = await pg.evaluate(() => [...new Set([...document.querySelectorAll('[data-cp]')].map((e) => e.dataset.cp))]);
check('the board shows one of A\'s cards', !!boardShows && shownIds.some((id) => [askA, waitId, pickA, secretA].includes(id)), shownIds);

// ------------------------------------------------------------ a prompt older than the card

const cpA = (cps || []).find((c) => c.id === askA);
fs.appendFileSync(tA, claudePrompt(SA, Date.parse(cpA.created_at) - 5000, 'Older words, written late'));
await sleep(5000);
check('a prompt older than the card (written after it, dated before) leaves A\'s cards open', (await open()).filter((c) => [askA, waitId, pickA].includes(c.id) && c.state === 'open').length === 3);

// ------------------------------------------------------------ another session

const said = 'Ok you can do those fixes';
fs.appendFileSync(tB, claudePrompt(SB, Date.now(), 'Hold the beta for now'));
const bGone = await until(async () => !(await open()).some((c) => c.id === askB), 10000);
check('a prompt in session B withdraws B\'s card', !!bGone, JSON.stringify((await all()).find((c) => c.id === askB)));
check('and leaves A\'s open', (await open()).filter((c) => [askA, waitId, pickA, secretA].includes(c.id) && c.state === 'open').length === 4);

// ------------------------------------------------------------ the person answers A in the terminal

fs.appendFileSync(tA, claudePrompt(SA, Date.now(), said));
const aGone = await until(async () => { const l = await open(); return ![askA, waitId, pickA].some((id) => l.some((c) => c.id === id)) ? l : null; }, 10000);
check('the person\'s prompt in A: A\'s ask, the waiting ask and the pick leave the state', !!aGone, JSON.stringify((await open()).map((c) => [c.id, c.kind, c.state])));
const st = (await get('/api/state')).checkpoints || [];
check('none of them in /api/state', ![askA, waitId, pickA].some((id) => st.some((c) => c.id === id)));
check('the secret on A stays open', (await open()).some((c) => c.id === secretA && c.state === 'open'));
const closed = await all();
const rec = closed.find((c) => c.id === askA);
check('its record: cancelled, answered in the terminal, worded "Answered in the terminal", not as an option', !!rec && rec.state === 'cancelled' && rec.answered_in === 'terminal' && !rec.answer && rec.words.after.head === 'Answered in the terminal' && rec.words.after.text === `You answered ${rec.words.whoMid} in the terminal, so this card was withdrawn.` && rec.words.after.big === null, JSON.stringify(rec));
check('the pick and the waiting ask too', [pickA, waitId, askB].every((id) => { const c = closed.find((x) => x.id === id); return c && c.answered_in === 'terminal' && c.words.after.head === 'Answered in the terminal'; }), JSON.stringify(closed.filter((c) => [pickA, waitId, askB].includes(c.id)).map((c) => [c.id, c.state, c.answered_in])));
const files = ['checkpoints.json', 'decisions.json'].map((f) => { try { return fs.readFileSync(path.join(MC, f), 'utf8'); } catch { return ''; } }).join('\n');
check('none of the typed words in the hub\'s records (checkpoints.json, decisions.json)', !files.includes(said) && !files.includes('Hold the beta') && files.includes(askA), files.slice(0, 300));
const w = await Promise.race([waiting, sleep(10000).then(() => null)]);
check('the waiting ask exits 123 and says to read their message, not that they declined', !!w && w.code === 123 && /the person answered you in the terminal instead/.test(w.out) && /read their message/.test(w.out) && !/declined/.test(w.out), JSON.stringify(w));
check('the phone: each alert taken back (close)', !!(await until(async () => [askA, waitId, pickA, askB].every((id) => closeOf(id)), 10000)), JSON.stringify(pushed.map((m) => [m.type, m.id])));
check('the phone: the secret\'s alert stays', !closeOf(secretA));
const gone = await until(async () => !(await onBoard(askA)) && !(await onBoard(waitId)) && !(await onBoard(pickA)), 10000);
check('the board: A\'s withdrawn cards are gone (headless)', !!gone, await pg.evaluate(() => [...document.querySelectorAll('[data-cp]')].map((e) => e.dataset.cp)));
check('the board: no page error', pageErrors.length === 0, pageErrors);
check('the hub logged each withdrawal', [askA, waitId, pickA, askB].every((id) => boardLog.includes(`withdrew ${id}`)), boardLog.slice(-800));

// ------------------------------------------------------------ typed while the agent works (queued)

const askQ = await idOf(paneA, ['ask', 'Rename the page?', '--option', 'Yes', '--option', 'No']);
await until(async () => (await open()).some((c) => c.id === askQ), 10000);
await sleep(300);
fs.appendFileSync(tA, claudeQueued(SA, Date.now(), 'yes rename it'));
check('a message typed while the agent works (queued) withdraws the card', !!(await until(async () => (await all()).some((c) => c.id === askQ && c.answered_in === 'terminal'), 10000)));
const askN = await idOf(paneA, ['ask', 'Notify the testers?', '--option', 'Yes']);
await until(async () => (await open()).some((c) => c.id === askN), 10000);
await sleep(300);
fs.appendFileSync(tA, claudeQueued(SA, Date.now(), '<task-notification>\n<status>completed</status>\n</task-notification>'));
await sleep(5000);
check('a task\'s notification queued the same way does not', (await open()).some((c) => c.id === askN && c.state === 'open'));

// ------------------------------------------------------------ Codex

check('C\'s approve still open before its prompt', (await open()).some((c) => c.id === approveC && c.state === 'open'));
fs.appendFileSync(tC, codexPrompt(Date.now(), 'Do not publish yet, fix the links first'));
const cGone = await until(async () => (await all()).find((c) => c.id === approveC && c.state === 'cancelled'), 10000);
check('Codex: a prompt in C\'s rollout withdraws its approve, answered in the terminal', !!cGone && cGone.answered_in === 'terminal' && cGone.words.after.head === 'Answered in the terminal' && cGone.words.after.text === `You answered ${cGone.words.whoMid} in the terminal, so this card was withdrawn.` && cGone.words.after.command === cGone.command, JSON.stringify(cGone));
await sleep(500);
check('and its command never ran', !fs.existsSync(ran));

if (process.env.SHOTS) await pg.screenshot({ path: path.join(process.env.SHOTS, 'board-after-terminal-answer.png') });
await browser.close();
for (const id of [secretA, askN]) { try { await dc.request('checkpoint.cancel', { checkpoint: id }); } catch { /* closed */ } }
dc.close();
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
