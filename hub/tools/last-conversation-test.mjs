// An idle project's last conversation (GET /api/project/last), which its
// page in the desktop app continues, and the resume of a conversation the
// board has no events for. tools/stub-ps.mjs stands in for ps; nothing here
// reaches this Mac's own sessions.
//
// 1. By its last turn, never a file's time: an older conversation whose
//    file was written last loses to the newer one.
// 2. Two projects share a folder: the conversation the board gives the
//    other one (its events name the other's workspace) is left out.
// 3. The sessions the board gives the project come first, ended ones too.
// 4. Codex: a rollout of the folder (its first line runs past 20 KB, as
//    Codex writes it), continued with `codex resume <id>`.
// 5. Still open in cmux: openIn says so; Continue is refused while it is.
// 6. No conversation: last is null.
// 7. Continue on a conversation found by its transcript only: a Ravenry
//    pane runs `<claude> --resume <id>` in the folder (with RAVENRYD_BIN);
//    another project's id is refused.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/last-conversation-test.mjs
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'lastconv-'));
const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const CLAUDE = path.join(HOME, '.claude', 'projects');
const CODEX = path.join(HOME, '.codex');
const P = (n) => path.join(HOME, 'Projects', n);
for (const d of [path.join(MC, 'events'), CLAUDE, path.join(T, 'bin'), ...['lantern', 'moss', 'attic', 'quill', 'reed'].map(P)]) fs.mkdirSync(d, { recursive: true });
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const S1 = '1a5c0001-0000-4000-8000-000000000001'; // lantern, older, its file written last
const S2 = '1a5c0002-0000-4000-8000-000000000002'; // lantern, newer
const S3 = '1a5c0003-0000-4000-8000-000000000003'; // newest in lantern's folder, the board gives lantern-tools
const S4 = '1a5c0004-0000-4000-8000-000000000004'; // moss, still open in cmux
const S5 = '1a5c0005-0000-4000-8000-000000000005'; // quill, Codex
const S6 = '1a5c0006-0000-4000-8000-000000000006'; // reed, ended, on the board
const S7 = '1a5c0007-0000-4000-8000-000000000007'; // reed, newer, no events
const WS2 = 'CCCC3333-0000-4000-8000-0000000000CC';
const WS6 = 'EEEE6666-0000-4000-8000-0000000000EE';

const transcript = (folder, sid, title, ask, answer, minAgo) => {
  const f = path.join(CLAUDE, folder.replace(/[^A-Za-z0-9-]/g, '-'), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rec = (type, extra, at) => JSON.stringify({ type, cwd: folder, sessionId: sid, timestamp: at, ...extra });
  fs.writeFileSync(f, [
    rec('ai-title', { aiTitle: title }, iso(minAgo + 2)),
    rec('user', { message: { role: 'user', content: ask } }, iso(minAgo + 1)),
    rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], usage: { input_tokens: 5, cache_read_input_tokens: 30000, output_tokens: 80 } } }, iso(minAgo)),
    rec('system', { subtype: 'turn_duration' }, iso(minAgo)),
  ].join('\n') + '\n');
  return f;
};
const events = (sid, folder, tp, lines, extra = {}) => fs.writeFileSync(path.join(MC, 'events', `${sid}.jsonl`), lines.map(([event, m]) => JSON.stringify({ at: iso(m), event, session_id: sid, assistant: 'claude', cwd: folder, transcript_path: tp, ...extra })).join('\n') + '\n');

const f1 = transcript(P('lantern'), S1, 'Wick length', 'How long should the wick be?', 'Two centimetres; longer smokes.', 60 * 48);
transcript(P('lantern'), S2, 'Glass for the lantern', 'Clear glass or frosted?', 'Frosted: it spreads the light and hides the wick.', 60 * 24);
const f3 = transcript(P('lantern'), S3, 'Tools rack', 'Where do the tools go?', 'On the rack by the door.', 120);
fs.utimesSync(f1, new Date(), new Date()); // Claude Code writes into old transcripts: the oldest has the newest time
events(S3, P('lantern'), f3, [['SessionStart', 200], ['SessionEnd', 110]], { workspace_id: WS2 });
transcript(P('moss'), S4, 'Moss on the north wall', 'Will it spread?', 'Slowly, only where it stays damp.', 300);
const f6 = transcript(P('reed'), S6, 'Reed bed layout', 'Two rows or three?', 'Three, a hand apart.', 60 * 30);
events(S6, P('reed'), f6, [['SessionStart', 60 * 31], ['SessionEnd', 60 * 30]], { workspace_id: WS6 });
transcript(P('reed'), S7, 'Not the board one', 'And the edges?', 'Stone.', 30);
// Codex: its rollout, whose first line carries the instructions (past 20 KB).
const rdir = path.join(CODEX, 'sessions', '2026', '11', '07');
fs.mkdirSync(rdir, { recursive: true });
const cx = (type, payload, m) => JSON.stringify({ timestamp: iso(m), type, payload });
fs.writeFileSync(path.join(rdir, `rollout-2026-11-07T10-00-00-${S5}.jsonl`), [
  cx('session_meta', { id: S5, timestamp: iso(90), cwd: P('quill'), originator: 'codex_cli_rs', base_instructions: { text: 'x'.repeat(30000) } }, 90),
  cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sharpen the nib?' }] }, 89),
  cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A fine nib, cut at an angle.' }] }, 88),
  cx('event_msg', { type: 'task_complete' }, 88),
].join('\n') + '\n');

fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, launchCommand: path.join(T, 'bin', 'fake-claude') }, projects: [
  { id: 'lantern', name: 'lantern', folder: P('lantern') },
  { id: 'lantern-tools', name: 'lantern-tools', folder: P('lantern'), workspaces: [WS2] },
  { id: 'moss', name: 'moss', folder: P('moss') },
  { id: 'attic', name: 'attic', folder: P('attic') },
  { id: 'quill', name: 'quill', folder: P('quill') },
  { id: 'reed', name: 'reed', folder: P('reed'), workspaces: [WS6] },
] }, null, 2));
// S4's process, still running in cmux: one this test started, so nothing real is ever touched.
const holder = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
const PS = path.join(T, 'stub-ps.json');
fs.writeFileSync(PS, JSON.stringify([{ pid: holder.pid, ppid: process.pid, rssKb: 200000, startedAt: iso(300), command: `claude --resume ${S4}`, cwd: P('moss'), env: 'TERM_PROGRAM=ghostty CMUX_SURFACE_ID=DDDD4444-0000-4000-8000-0000000000DD' }]));
const LOG = path.join(T, 'fake-claude.log');
fs.writeFileSync(path.join(T, 'bin', 'fake-claude'), `#!/bin/sh\necho "$PWD|$*" >> '${LOG}'\nexec sleep 300\n`, { mode: 0o755 });

const PORT = await freePort();
const D = BIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'rvl-')) : null;
const RUN = D ? path.join(D, 'run') : null;
let boardLog = '';
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'), MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: path.join(T, 'claude-settings.json'), MC_CODEX_HOME: CODEX, MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'cmux,ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  ...(BIN ? { RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') } : {}),
});
fs.writeFileSync(path.join(T, 'fake-cmux.json'), JSON.stringify({ workspaces: [], screens: {} }));
fs.writeFileSync(env.MC_CLAUDE_SETTINGS, '{}');
const daemon = BIN ? spawn(BIN, ['serve'], { env: { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') }, stdio: 'ignore' }) : null;
const board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => { board.kill('SIGTERM'); holder.kill('SIGKILL'); if (daemon) daemon.kill('SIGTERM'); if (D) { try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } } });

const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => { try { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; } catch { return { status: 0, body: null }; } };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
// Once a tick has read the events (S3 is lantern-tools', S6 is reed's).
for (let i = 0; i < 200; i++) {
  const st = await get('/api/state');
  if (st.status === 200 && (st.body.projects || []).length >= 6) break;
  await sleep(100);
}
await sleep(1500);
const last = async (id) => (await get(`/api/project/last?projectId=${id}`)).body || {};

const L = (await last('lantern')).last;
check('by its last turn: the newer conversation, not the older one whose file was written last', !!L && L.sessionId === S2, JSON.stringify(L && { sessionId: L.sessionId, stoppedAt: L.stoppedAt }) + boardLog.slice(-400));
check('another project\'s conversation in the same folder is left out', !!L && L.sessionId !== S3);
check('what it says: title, Claude, when it stopped, your last message and the answer, the command, in its folder', !!L && L.title === 'Glass for the lantern' && L.assistant === 'claude' && Math.abs(Date.parse(L.stoppedAt) - (now - 60 * 24 * 60000)) < 5000 && L.lastPrompt === 'Clear glass or frosted?' && /^Frosted/.test(L.lastText) && L.command === `claude --resume ${S2}` && L.folder === P('lantern') && L.openIn === null, JSON.stringify(L));
const LT = (await last('lantern-tools')).last;
check('the other project gets its own', !!LT && LT.sessionId === S3, JSON.stringify(LT && LT.sessionId));
const R6 = (await last('reed')).last;
check('the sessions the board gives the project come first, an ended one too', !!R6 && R6.sessionId === S6, JSON.stringify(R6 && R6.sessionId));
const Q = (await last('quill')).last;
check('Codex: the folder\'s rollout (a first line past 20 KB), continued with `codex resume <id>`', !!Q && Q.sessionId === S5 && Q.assistant === 'codex' && Q.command === `codex resume ${S5}` && Q.lastPrompt === 'Sharpen the nib?' && /fine nib/.test(Q.lastText || ''), JSON.stringify(Q));
const M = (await last('moss')).last;
check('still open in cmux: it says where', !!M && M.sessionId === S4 && M.openIn && M.openIn.ravenry === false && M.openIn.name === 'cmux', JSON.stringify(M && M.openIn));
const A = await last('attic');
check('no conversation in the folder: none', A.ok === true && A.last === null, JSON.stringify(A));
const rm = await post('/api/sessions/resume', { projectId: 'moss', sessionId: S4 });
check('Continue while it is still open in cmux: refused, nothing started', rm.status === 409 && rm.body && rm.body.open === true && !fs.existsSync(LOG), rm.text);
const rx = await post('/api/sessions/resume', { projectId: 'lantern', sessionId: S7 });
check('Continue with another folder\'s conversation: refused', rx.status === 404, rx.text);
if (BIN) {
  const r = await post('/api/sessions/resume', { projectId: 'lantern', sessionId: S2, cols: 100, rows: 30 });
  check('Continue on a conversation found by its transcript: a Ravenry pane for the project', r.status === 200 && r.body.ok && /^ravenry:p/.test(r.body.surfaceId) && r.body.pane && r.body.pane.labels['ravenry.project'] === 'lantern', r.text);
  let ran = null;
  for (let i = 0; i < 100 && !ran; i++) { ran = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim() : null; if (!ran) await sleep(100); }
  check('it runs `<claude> --resume <id>` in the project\'s folder', ran === `${fs.realpathSync(P('lantern'))}|--resume ${S2}` || ran === `${P('lantern')}|--resume ${S2}`, ran);
  // Move here on the one still open in cmux: its process (this test's own) ends, and it continues here.
  const mv = await post('/api/sessions/move', { projectId: 'moss', sessionId: S4, keep: 'ravenry', cols: 100, rows: 30 });
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) { try { process.kill(holder.pid, 0); await sleep(100); } catch { gone = true; } }
  check('Move here on a conversation found by its transcript, still open in cmux: its process ends and a Ravenry pane continues it', mv.status === 200 && mv.body && mv.body.ok && /^ravenry:p/.test(mv.body.surfaceId || '') && gone, mv.text);
  let ran2 = '';
  for (let i = 0; i < 100 && !ran2.includes(S4); i++) { ran2 = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''; if (!ran2.includes(S4)) await sleep(100); }
  check('it runs `<claude> --resume <id>` in its folder', ran2.split('\n').some((l) => l.endsWith(`|--resume ${S4}`) && l.startsWith(fs.realpathSync(P('moss')))), ran2);
} else {
  console.log('SKIP  Continue in a real pane: set RAVENRYD_BIN to a ravenryd binary');
}

board.kill('SIGTERM');
if (fails) console.log(boardLog.slice(-1500));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
