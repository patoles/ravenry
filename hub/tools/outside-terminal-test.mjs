// A session in an outside terminal, as the desktop app's hub sees it: a
// board in Ravenry mode (RAVENRY_TERMINAL=ravenry, as the app's service
// runs it) with a Claude Code session running in cmux. tools/fake-cmux.mjs
// stands in for cmux and tools/stub-ps.mjs for ps and lsof, so nothing here
// reaches a real terminal or this Mac's own sessions.
//
// 1. cmux answers: the session is tied to its cmux tab (its surface, not
//    "ev:<id>"), its screen is read, the Sessions page says inCmux; it is a
//    read-only mirror (nothing is ever typed into cmux, a send is refused);
//    Open focuses its tab; it says its process is still open, and Continue
//    in Ravenry is refused while it is.
// 2. cmux refuses the board (its socket answers only programs cmux
//    started): the session still shows, with one line that says why the
//    screen is not shown, and its conversation from the transcript; Open
//    brings the cmux app forward instead.
// 3. Its process ends in cmux: the session says so within a few seconds
//    and Continue in Ravenry resumes it in a Ravenry pane (a real ravenryd,
//    RAVENRYD_BIN) in its folder, as `<claude> --resume <id>`; asked again,
//    it answers with the same pane and starts no second process.
// 4. The resume command for each assistant (server/sessionstart.mjs).
// 5. A hand-off's fresh session of a cmux session goes to the board's own
//    terminal when cmux is not one the board can open tabs in.
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/outside-terminal-test.mjs
// Without RAVENRYD_BIN, part 3's resume is skipped.
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'outside-'));
const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ------------------------------------------------------------ 4. the resume command (pure)
const sessionstart = await import('../server/sessionstart.mjs');
const SID = '5e55107e-0000-4000-8000-00000000c3c3';
const launch = (proj, kind) => ({ kind: kind || 'claude', command: kind === 'codex' ? 'codex -m gpt-5.5' : 'claude' });
const pc = sessionstart.plan({ folder: '/x/proj', assistant: 'claude', resume: SID }, { launch, briefPath: () => '/x/proj/BRIEF.md', briefExists: () => true });
check('resume: Claude Code resumes with --resume <id>, no prompt', pc.ok && pc.line === `claude --resume ${SID}`, pc.line);
const px = sessionstart.plan({ folder: '/x/proj', assistant: 'codex', resume: SID }, { launch });
check('resume: Codex resumes with `resume <id>` after its options', px.ok && px.line === `codex -m gpt-5.5 resume ${SID}`, px.line);
const pbad = sessionstart.plan({ folder: '/x/proj', assistant: 'claude', resume: 'not-an-id' }, { launch });
check('resume: a session id that is not one is refused', !pbad.ok && pbad.status === 400, JSON.stringify(pbad));

// ------------------------------------------------------------ the board
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'kite');
const CLAUDE = path.join(HOME, '.claude', 'projects');
for (const d of [path.join(MC, 'events'), PROJ, CLAUDE, path.join(T, 'bin')]) fs.mkdirSync(d, { recursive: true });
const WS = 'AAAA1111-0000-4000-8000-00000000AAAA';
const SF = 'BBBB2222-0000-4000-8000-00000000BBBB';
const PID = 5101;
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const TR = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'), SID + '.jsonl');
fs.mkdirSync(path.dirname(TR), { recursive: true });
const rec = (type, extra, at) => JSON.stringify({ type, cwd: PROJ, sessionId: SID, timestamp: at, ...extra });
fs.writeFileSync(TR, [
  rec('user', { message: { role: 'user', content: 'Make the kite string sway in the wind' } }, iso(9)),
  rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The string now bends with the wind speed, eased over half a second.' }], usage: { input_tokens: 5, cache_read_input_tokens: 40000, output_tokens: 200 } } }, iso(8)),
  rec('system', { subtype: 'turn_duration' }, iso(8)),
  rec('user', { message: { role: 'user', content: 'Should the tail flutter too?' } }, iso(3)),
  rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'It can: a small sine on each bow. Keep it subtle, or make it lively?' }], usage: { input_tokens: 5, cache_read_input_tokens: 41000, output_tokens: 120 } } }, iso(2)),
  rec('system', { subtype: 'turn_duration' }, iso(2)),
].join('\n') + '\n');
const ev = (event, minAgo, extra = {}) => JSON.stringify({ at: iso(minAgo), event, session_id: SID, assistant: 'claude', cwd: PROJ, transcript_path: TR, workspace_id: WS, surface_id: SF, claude_pid: PID, terminal: 'cmux', ...extra });
const EVF = path.join(MC, 'events', SID + '.jsonl');
fs.writeFileSync(EVF, [ev('SessionStart', 12, { source: 'startup' }), ev('UserPromptSubmit', 3), ev('Stop', 2, { ends_on_question: true, question: 'Keep it subtle, or make it lively?', background_tasks: 0 })].join('\n') + '\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, launchCommand: path.join(T, 'bin', 'fake-claude') }, projects: [{ id: 'kite', name: 'kite', folder: PROJ, workspaces: [WS], brief: null }] }, null, 2));
const FAKE = path.join(T, 'fake-cmux.json');
const SCREEN = '❯ Should the tail flutter too?\n\n⏺ It can: a small sine on each bow. Keep it subtle, or make it lively?\n\n' + '─'.repeat(60) + '\n❯ \n' + '─'.repeat(60) + '\n  ? for shortcuts\n';
const fixture = (extra = {}) => fs.writeFileSync(FAKE, JSON.stringify({ logCalls: true, focusLog: true, workspaces: [{ id: WS, ref: 'workspace:1', title: 'kite', cwd: PROJ, surfaces: [{ id: SF, ref: 'surface:1', title: '✳ Kite tail' }] }], screens: { [SF]: SCREEN }, ...extra }));
fixture();
const PS = path.join(T, 'stub-ps.json');
const procs = (list) => fs.writeFileSync(PS, JSON.stringify(list));
procs([{ pid: PID, ppid: 5100, rssKb: 400000, startedAt: iso(12), command: `claude --session-id ${SID}`, cwd: PROJ, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF}` }]);
const FAKE_CLAUDE_LOG = path.join(T, 'fake-claude.log');
fs.writeFileSync(path.join(T, 'bin', 'fake-claude'), `#!/bin/sh\necho "$PWD|$*" >> '${FAKE_CLAUDE_LOG}'\nexec sleep 300\n`, { mode: 0o755 });
const OPEN_LOG = path.join(T, 'open.jsonl');

const PORT = await freePort();
const D = BIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'rvo-')) : null;
const RUN = D ? path.join(D, 'run') : null;
let boardLog = '';
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: path.join(T, 'claude-settings.json'), MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: OPEN_LOG,
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'cmux,ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  ...(BIN ? { RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') } : {}),
});
fs.writeFileSync(env.MC_CLAUDE_SETTINGS, '{}');
const daemon = BIN ? spawn(BIN, ['serve'], { env: { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') }, stdio: 'ignore' }) : null;
const board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => { board.kill('SIGTERM'); if (daemon) daemon.kill('SIGTERM'); if (D) { try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } } });

const base = `http://127.0.0.1:${PORT}`;
const state = async () => (await fetch(base + '/api/state')).json();
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const sessionOf = (st) => { const p = (st.projects || []).find((x) => x.id === 'kite'); return p ? p.sessions.find((s) => s.sessionId === SID) || null : null; };
const calls = () => (fs.existsSync(FAKE + '.calls.log') ? fs.readFileSync(FAKE + '.calls.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const WRITES = new Set(['send', 'send-key', 'send-panel', 'send-key-panel', 'paste-buffer', 'set-buffer', 'close-surface', 'close-workspace', 'new-surface', 'new-workspace', 'notify']);

// ------------------------------------------------------------ 1. cmux answers
const st1 = await until(async () => { const st = await state(); const s = sessionOf(st); return s && s.terminal && s.screen && s.screen.length ? st : null; }, 20000);
const s1 = st1 ? sessionOf(st1) : sessionOf(await state());
check('mapped: the session is tied to its cmux tab, not to its events alone', !!s1 && s1.surfaceId === SF && s1.terminal === true && s1.term === 'cmux', JSON.stringify(s1 && { surfaceId: s1.surfaceId, terminal: s1.terminal, method: s1.method }) + boardLog.slice(-600));
check('mapped: its screen is read from cmux', !!s1 && (s1.screen || []).join('\n').includes('Keep it subtle, or make it lively?'), JSON.stringify(s1 && s1.screen));
check('mapped: a read-only mirror: no reason it cannot be shown, and a reason it cannot be typed into', !!s1 && !s1.cannot && /cmux/.test(s1.cannotType || ''), JSON.stringify(s1 && { cannot: s1.cannot, cannotType: s1.cannotType }));
check('mapped: its process is still open there, so it is not offered to resume', !!s1 && s1.outside && s1.outside.open === true && s1.outside.name === 'cmux', JSON.stringify(s1 && s1.outside));
const rows = await until(async () => { const st = await state(); const r = (st.sessions.rows || []).find((x) => x.pid === PID); return r && r.inCmux ? r : null; }, 8000) || ((await state()).sessions.rows || []).find((x) => x.pid === PID);
check('Sessions page: the process is in its cmux tab (inCmux, its surface)', !!rows && rows.inCmux === true && rows.surfaceId === SF && rows.sessionId === SID, JSON.stringify(rows));
check('Sessions page: Close idle leaves a cmux tab to cmux', !!rows && rows.closable === false, JSON.stringify(rows && rows.blocked));
const live = await (await fetch(`${base}/api/live?surface=${SF}`)).json();
check('Live screen: read from cmux', live && live.ok && JSON.stringify(live.entries || []).includes('lively'), JSON.stringify(live).slice(0, 300));
const send = await post('/api/send', { projectId: 'kite', surfaceId: SF, text: 'lively' });
check('send: refused, nothing typed into cmux', send.status >= 400 && /cmux/.test(send.body && send.body.error || ''), send.text);
const open1 = await post('/api/open', { projectId: 'kite', surfaceId: SF });
const focus = fs.existsSync(FAKE + '.focus.log') ? fs.readFileSync(FAKE + '.focus.log', 'utf8') : '';
check('Open in cmux: its workspace, then its tab', open1.status === 200 && focus.includes('select-workspace') && focus.includes(WS) && focus.includes('focus-panel') && focus.includes(SF), open1.text + ' ' + focus);
const r1 = await post('/api/sessions/resume', { projectId: 'kite', sessionId: SID });
check('Continue in Ravenry: refused while it is still open in cmux, and says so', r1.status === 409 && /still open in cmux/i.test(r1.body && r1.body.error || '') && r1.body.open === true, r1.text);
check('nothing was ever written to cmux', !calls().some((c) => WRITES.has(c[0])), JSON.stringify(calls().filter((c) => WRITES.has(c[0]))));

// ------------------------------------------------------------ 2. cmux refuses the board
fixture({ denied: true });
const s2 = await until(async () => { const s = sessionOf(await state()); return s && s.cannot && /only/.test(s.cannot) ? s : null; }, 10000) || sessionOf(await state());
check('refused: the session still shows, from its events', !!s2 && s2.sessionId === SID, JSON.stringify(s2 && s2.surfaceId));
check('refused: one line says why its screen is not shown', !!s2 && /cmux/.test(s2.cannot || '') && /only/.test(s2.cannot || '') && !/\n/.test(s2.cannot || ''), s2 && s2.cannot);
check('refused: the conversation from its transcript, oldest first, with what was asked', !!s2 && Array.isArray(s2.conversation) && s2.conversation.length === 2 && s2.conversation[1].ask === 'Should the tail flutter too?' && /lively/.test(s2.conversation[1].text), JSON.stringify(s2 && s2.conversation));
check('refused: still open in cmux', !!s2 && s2.outside && s2.outside.open === true, JSON.stringify(s2 && s2.outside));
const open2 = await post('/api/open', { projectId: 'kite', surfaceId: s2 ? s2.surfaceId : SF });
const opens = fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8') : '';
check('refused: Open in cmux brings the cmux app forward instead', open2.status === 200 && opens.includes('com.cmuxterm.app'), open2.text + ' ' + opens);
fixture();

// ------------------------------------------------------------ 3. its process ends in cmux
procs([]);
const s3 = await until(async () => { const s = sessionOf(await state()); return s && s.outside && s.outside.open === false ? s : null; }, 8000);
check('closed: within seconds the session says its process ended there', !!s3 && s3.outside.open === false && s3.outside.resumable === true, JSON.stringify(s3 && s3.outside));
if (BIN) {
  const r3 = await post('/api/sessions/resume', { projectId: 'kite', sessionId: SID, cols: 100, rows: 30 });
  check('Continue in Ravenry: a Ravenry pane, labelled for the project', r3.status === 200 && r3.body.ok && /^ravenry:p/.test(r3.body.surfaceId) && r3.body.pane && r3.body.pane.labels['ravenry.project'] === 'kite', r3.text);
  const ran = await until(async () => (fs.existsSync(FAKE_CLAUDE_LOG) ? fs.readFileSync(FAKE_CLAUDE_LOG, 'utf8').trim() : null), 10000);
  check('Continue in Ravenry: runs `<claude> --resume <id>` in its folder', ran === `${PROJ}|--resume ${SID}`, ran);
  const r4 = await post('/api/sessions/resume', { projectId: 'kite', sessionId: SID });
  const runs = fs.existsSync(FAKE_CLAUDE_LOG) ? fs.readFileSync(FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').length : 0;
  check('asked again: the same pane, no second process on that session id', r4.status === 200 && r4.body.surfaceId === r3.body.surfaceId && r4.body.already === true && runs === 1, r4.text + ` runs=${runs}`);
  // cmux's restore starts the same session again in its own tab: the
  // session in its Ravenry pane says so, and the board ends neither.
  const PANE = r3.body && r3.body.pane ? r3.body.pane.id : null;
  // As on 2026-11-07: the cmux process wrote the last events, and the pane
  // inherited cmux's variables from a daemon started in a cmux tab.
  fs.appendFileSync(EVF, ev('SessionStart', 0.4, { terminal: 'ravenry', terminal_id: PANE, claude_pid: 6101, surface_id: undefined, workspace_id: undefined, source: 'resume' }) + '\n');
  fs.appendFileSync(EVF, ev('UserPromptSubmit', 0.1, { claude_pid: 6202 }) + '\n' + ev('Stop', 0, { claude_pid: 6202 }) + '\n');
  procs([
    { pid: 6101, ppid: 6100, rssKb: 300000, startedAt: iso(0.5), command: `claude --resume ${SID}`, cwd: PROJ, env: `CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF} TERM_PROGRAM=ravenry RAVENRY_PANE=${PANE}` },
    { pid: 6202, ppid: 6200, rssKb: 300000, startedAt: iso(0.2), command: `claude --resume ${SID}`, cwd: PROJ, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF}` },
  ]);
  await post('/api/sessions/resume', { projectId: 'kite', sessionId: SID }); // reads the processes again
  // cmux refused the board a moment ago (part 2): it is asked again within 30 s.
  const twin = await until(async () => { const s = sessionOf(await state()); return s && s.alsoOpen && s.alsoOpen.surfaceId ? s : null; }, 40000);
  const st7 = await state();
  const rowsFor = (st7.projects.find((p) => p.id === 'kite') || { sessions: [] }).sessions.filter((x) => x.sessionId === SID);
  check('one session, one row: its Ravenry pane first, though cmux\'s process wrote its last events', rowsFor.length === 1 && rowsFor[0].surfaceId === `ravenry:${PANE}`, JSON.stringify(rowsFor.map((x) => x.surfaceId)));
  check('also open in cmux: the session in its Ravenry pane says another process holds it there', !!twin && twin.surfaceId === `ravenry:${PANE}` && twin.alsoOpen.name === 'cmux' && twin.alsoOpen.surfaceId === SF, JSON.stringify(twin && { surfaceId: twin.surfaceId, alsoOpen: twin.alsoOpen }));
  const twinOpen = await post('/api/open', { projectId: 'kite', surfaceId: SF });
  check('also open in cmux: Open in cmux focuses that tab', twinOpen.status === 200, twinOpen.text);
  // The copy in cmux exits (its SessionEnd): the session stays on the board
  // in its Ravenry pane, which says the conversation went on in cmux.
  fs.appendFileSync(EVF, ev('SessionEnd', 0, { claude_pid: 6202, reason: 'exit' }) + '\n');
  procs([{ pid: 6101, ppid: 6100, rssKb: 300000, startedAt: iso(0.5), command: `claude --resume ${SID}`, cwd: PROJ, env: `TERM_PROGRAM=ravenry RAVENRY_PANE=${PANE}` }]);
  await post('/api/sessions/resume', { projectId: 'kite', sessionId: SID }); // reads the processes again
  const stale = await until(async () => { const s = sessionOf(await state()); return s && !s.alsoOpen && s.movedOn ? s : null; }, 15000);
  check('the copy in cmux exits: the session stays in its Ravenry pane, and says it went on in cmux', !!stale && stale.surfaceId === `ravenry:${PANE}` && stale.movedOn.name === 'cmux', JSON.stringify(stale && { surfaceId: stale.surfaceId, movedOn: stale.movedOn, alsoOpen: stale.alsoOpen }) || 'gone from the board');
} else {
  console.log('SKIP  Continue in Ravenry in a real pane: set RAVENRYD_BIN to a ravenryd binary');
}
// ------------------------------------------------------------ 4. Move here
// Real processes stand in for two Claudes in cmux: one on SID2, mid-turn,
// and one on another session, which a move must never touch. Move here
// waits for the turn to end (its hook state), then ends SID2's process
// with SIGTERM; the other runs on.
{
  const SID2 = '5e55107e-0000-4000-8000-00000000c4c4';
  const SID3 = '5e55107e-0000-4000-8000-00000000c5c5';
  const kid = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const a = kid();
  const b = kid();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const at = () => new Date().toISOString();
  const ev2 = (event, extra = {}) => JSON.stringify({ at: at(), event, session_id: SID2, assistant: 'claude', cwd: PROJ, workspace_id: WS, surface_id: 'CCCC3333-0000-4000-8000-0000000000C4', claude_pid: a.pid, terminal: 'cmux', ...extra });
  const EV2 = path.join(MC, 'events', SID2 + '.jsonl');
  fs.writeFileSync(EV2, [ev2('SessionStart'), ev2('UserPromptSubmit')].join('\n') + '\n');
  procs([
    { pid: a.pid, ppid: process.pid, rssKb: 300000, startedAt: iso(0), command: `claude --session-id ${SID2}`, cwd: PROJ, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=CCCC3333-0000-4000-8000-0000000000C4` },
    { pid: b.pid, ppid: process.pid, rssKb: 300000, startedAt: iso(0), command: `claude --session-id ${SID3}`, cwd: PROJ, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS}` },
  ]);
  // Once a tick has read its events (the board knows the session).
  const m1 = await until(async () => { const r = await post('/api/sessions/move', { projectId: 'kite', sessionId: SID2, keep: 'ravenry' }); return r.status === 404 ? null : r; }, 30000) || { status: 0, body: {}, text: 'never known' };
  check('Move here mid-turn: it waits for the turn to end, and nothing is ended yet', m1.status === 200 && m1.body.waiting === true && alive(a.pid) && alive(b.pid), m1.text);
  const s4 = await until(async () => { const st = await state(); const pr = st.projects.find((x) => x.id === 'kite'); const x = pr && pr.sessions.find((y) => y.sessionId === SID2); return x && x.moving ? x : null; }, 5000);
  check('Move here mid-turn: the session says it is waiting', !!s4 && s4.moving.waiting === true && s4.moving.keep === 'ravenry', JSON.stringify(s4 && s4.moving));
  fs.appendFileSync(EV2, ev2('Stop') + '\n');
  const gone = await until(async () => !alive(a.pid), 15000);
  check('the turn ended: its process is ended (SIGTERM), the other session\'s process runs on', !!gone && alive(b.pid));
  const moved = await until(async () => { const st = await state(); const pr = st.projects.find((x) => x.id === 'kite'); const x = pr && pr.sessions.find((y) => y.sessionId === SID2); return x && x.moved ? x.moved : null; }, 8000);
  check('the move says which process it ended, and how', !!moved && moved.ended.length === 1 && moved.ended[0].pid === a.pid && moved.ended[0].signal === 'SIGTERM', JSON.stringify(moved));
  const m2 = await post('/api/sessions/move', { projectId: 'kite', sessionId: SID3, keep: 'outside' });
  check('a move for a session the board does not know is refused, and its process is untouched', m2.status === 404 && alive(b.pid), m2.text);
  b.kill();
}

check('nothing was ever written to cmux, all along', !calls().some((c) => WRITES.has(c[0])), JSON.stringify(calls().filter((c) => WRITES.has(c[0]))));

// ------------------------------------------------------------ 5. a hand-off's fresh session
const terminal = await import('../server/terminal.mjs');
check('hand-off: a cmux session hands off to the board\'s own terminal when it cannot open cmux tabs', terminal.freshTerminal({ kind: 'cmux', near: null }, 'ravenry') .kind === 'ravenry' && terminal.freshTerminal({ kind: 'cmux', near: null }, 'cmux').kind === 'cmux');

board.kill('SIGTERM');
if (fails) console.log(boardLog.slice(-1500));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
