// The Rex adapter (docs/TERMINALS.md), with tools/fake-rex.mjs standing in
// for Rex's `rex` command and tools/fake-cmux.mjs for cmux, so nothing here
// reaches a real terminal.
//
// 1. Which terminal a session runs in, from the hook's environment (Rex's
//    REX_BLOCK and REX_SESSION, also when Rex's server inherited iTerm2's
//    variables), the board's own terminal (Rex mode), where the rex command
//    is found, a claude process's REX_BLOCK, and the hook's lines.
// 2. server/rex.mjs against the fake: the 7 operations (list with titles,
//    read, text with a line break as one bracketed paste, Enter and the
//    arrows, focus with Remote Control off and on, a new tab in the old
//    pane's session or a new session, close), --autostart=false on every
//    call, and watch only with no rex command, no server, an unknown API
//    revision.
// 3. A test board on :4671 (cmux mode, RAVENRY_HOME under .tmp/rex-test):
//    a Rex session reported by the real hook shows as a terminal session
//    with its title and screen; the Live screen, a one-line and a
//    multi-line message, a menu choice, Open in Rex refused and then shown,
//    a written hand-off opening a new tab in the old Rex session, Close
//    idle closing the Rex pane, and Reopen in a new Rex tab. The page,
//    headless: "Open in Rex".
// 4. A test board on :4672 whose Rex is down, then speaks API revision 12,
//    and one on :4678 with no rex command: the session is watch only and
//    says why.
// 5. A test board on :4673 in Rex mode with a cmux tripwire: no cmux call,
//    New project opens a Rex session named after the project, Revive a tab
//    in the project's Rex session, and the page says Rex.
//
// Usage: node tools/rex-test.mjs [shotsDir]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'rex-test');
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const FAKE = path.join(T, 'fake-rex.json');
const FAKE_CMUX = path.join(T, 'fake-cmux.json');
const FAKE_BIN = path.join(ROOT, 'tools', 'fake-rex.mjs');
const PS = path.join(T, 'ps.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const fst = (f = FAKE) => JSON.parse(fs.readFileSync(f, 'utf8'));
const setFake = (x, f = FAKE) => fs.writeFileSync(f, JSON.stringify(x));

process.env.RAVENRY_REX_BIN = FAKE_BIN;
process.env.FAKE_REX_STATE = FAKE;
const { terminalOf } = await import('../server/termenv.mjs');
const rex = await import('../server/rex.mjs');
const term = await import('../server/terminal.mjs');
const sess = await import('../server/sessions.mjs');
const { parseScreen } = await import('../server/screen.mjs');

// ------------------------------------------------------------ 1. detection

const SA = 'session:5a5a5a5a-0000-7000-8000-00000000005a';
const BA = 'block:ba0ba0ba-0000-7000-8000-0000000000ba';
const BC = 'block:bc0bc0bc-0000-7000-8000-0000000000bc';
const BS = 'block:b5b5b5b5-0000-7000-8000-0000000000b5';
const WA = 'window:a0a0a0a0-0000-7000-8000-0000000000a0';
const IT = 'C1C1C1C1-0000-4000-8000-00000000C1C1';
const cases = [
  ['a Rex pane: its block and session', { REX_BLOCK: BA, REX_SESSION: SA, TERM_PROGRAM: 'rex' }, { terminal: 'rex', terminal_id: BA, terminal_session: SA }],
  ['a Rex pane whose server inherited iTerm2\'s variables is Rex', { REX_BLOCK: BA, REX_SESSION: SA, TERM_PROGRAM: 'rex', ITERM_SESSION_ID: 'w0t0p0:' + IT }, { terminal: 'rex', terminal_id: BA, terminal_session: SA }],
  ['an iTerm2 tab that inherited Rex\'s variables is iTerm2', { REX_BLOCK: BA, REX_SESSION: SA, TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0:' + IT }, { terminal: 'iterm', terminal_id: 'w0t0p0:' + IT }],
  ['cmux first, even with Rex variables inherited', { CMUX_SURFACE_ID: 'x', REX_BLOCK: BA, TERM_PROGRAM: 'rex' }, { terminal: 'cmux' }],
  ['tmux inside Rex is tmux (watch only)', { TMUX: '/tmp/tmux-501/default,1,0', REX_BLOCK: BA, TERM_PROGRAM: 'rex' }, { terminal: 'tmux' }],
  ['TERM_PROGRAM=rex alone is Rex with no pane id', { TERM_PROGRAM: 'rex' }, { terminal: 'rex' }],
];
for (const [name, env, want] of cases) {
  const got = terminalOf(env);
  check(`detect: ${name}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
check('names: Rex, and its tab ids rex:<uuid>', term.nameOf('rex') === 'Rex' && term.kindOf('rex:ba0ba0ba-0000-7000-8000-0000000000ba') === 'rex' && term.tabIdFor('rex', BA) === 'rex:ba0ba0ba-0000-7000-8000-0000000000ba' && term.kindOf('iterm:' + IT) === 'iterm' && term.kindOf('8F1C0000-0000-4000-8000-000000000000') === 'cmux');
check('adapters: cmux, iTerm2 and Rex drive; Terminal, VS Code and tmux are watch only', term.canDrive('rex') && term.canDrive('iterm') && term.canDrive('cmux') && !term.canDrive('vscode') && !term.canDrive('tmux'));
const yes = () => true;
const no = () => false;
const apps = () => ['Rex Beta.app', 'Safari.app'];
const only = (...ps) => (p) => ps.includes(p);
const helper = '/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex';
check('board terminal: started in a Rex pane is Rex mode', term.boardKind({ REX_SESSION: SA, REX_BLOCK: BA, TERM_PROGRAM: 'rex' }, no) === 'rex');
check('board terminal: a Rex pane whose server inherited ITERM_SESSION_ID is still Rex mode', term.boardKind({ REX_SESSION: SA, TERM_PROGRAM: 'rex', ITERM_SESSION_ID: 'w0t0p0:' + IT }, no) === 'rex');
check('board terminal: an iTerm2 tab that inherited Rex\'s variables is iTerm2 mode', term.boardKind({ REX_SESSION: SA, TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0:' + IT }, no) === 'iterm');
check('board terminal: RAVENRY_TERMINAL=rex wins; cmux wins inside cmux', term.boardKind({ RAVENRY_TERMINAL: 'rex', CMUX_SURFACE_ID: 'x' }, yes) === 'rex' && term.boardKind({ CMUX_SURFACE_ID: 'x', REX_SESSION: SA }, yes) === 'cmux');
check('board terminal: anywhere else stays as before (cmux when installed, else iTerm2)', term.boardKind({ TERM_PROGRAM: 'vscode' }, yes) === 'cmux' && term.boardKind({ TERM_PROGRAM: 'vscode' }, no) === 'iterm' && term.boardKind({ HOME: '/x' }, only('/Applications/iTerm.app', helper)) === 'iterm');
check('board terminal: anywhere else on a Mac with Rex and no cmux or iTerm2: Rex mode', term.boardKind({ HOME: '/x', PATH: '/opt/rex/bin' }, only('/opt/rex/bin/rex')) === 'rex' && term.boardKind({ HOME: '/x', MC_APPS: 'rex' }, no) === 'rex' && term.boardKind({ HOME: '/x', MC_APPS: 'none' }, yes) === 'cmux');
// Where the rex command is.
check('rex command: the PATH first', rex.findBin({ PATH: '/opt/x/bin:/usr/bin', REX_BIN_DIR: '/rexdir' }, only('/opt/x/bin/rex', '/rexdir/rex', helper), apps) === '/opt/x/bin/rex');
check('rex command: then REX_BIN_DIR', rex.findBin({ PATH: '/usr/bin', REX_BIN_DIR: '/rexdir' }, only('/rexdir/rex', helper), apps) === '/rexdir/rex');
check('rex command: then the app\'s helper in /Applications', rex.findBin({ PATH: '/usr/bin' }, only(helper), apps) === helper);
check('rex command: none on a Mac without Rex', rex.findBin({ PATH: '/usr/bin' }, no, () => []) === null && rex.findBin({ RAVENRY_REX_BIN: 'none' }, yes, apps) === null);
check('rex installed: the app counts as installed when its command is found', term.appInstalled('rex', { PATH: '/usr/bin' }, only(helper)) === (rex.findBin({ PATH: '/usr/bin' }, only(helper)) !== null));
// A claude process's REX_BLOCK (the Sessions page, Close idle).
const envs = sess.parseEnv([
  `201 /x/claude TERM=xterm REX_SESSION=${SA} REX_BLOCK=${BA} TERM_PROGRAM=rex HOME=/x`,
  `202 /x/claude ITERM_SESSION_ID=w0t0p0:${IT} REX_BLOCK=${BA} TERM_PROGRAM=iTerm.app`,
  `203 /x/claude REX_BLOCK=${BA} TMUX=/tmp/tmux,1,0`,
  `204 /x/claude ITERM_SESSION_ID=w0t0p0:${IT} REX_BLOCK=${BA} TERM_PROGRAM=rex`,
].join('\n'));
check('processes: REX_BLOCK names a claude process\'s Rex pane', envs.get(201).rexId === BA.slice(6) && !envs.get(201).itermId, JSON.stringify(envs.get(201)));
check('processes: an iTerm2 tab with Rex\'s variables inherited stays iTerm2; tmux is neither', envs.get(202).itermId === IT && !envs.get(202).rexId && !envs.get(203).rexId && envs.get(204).rexId && !envs.get(204).itermId, JSON.stringify([envs.get(202), envs.get(203), envs.get(204)]));

// The hook records it.
const HOOK_HOME = path.join(T, 'hook-home');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX_|ITERM_|REX_|TERM_PROGRAM|TERM_SESSION_ID|TMUX|WEZTERM_|KITTY_|RAVENRY_|MC_|PORT$)/.test(k)));
function hook(input, env, home = HOOK_HOME, board = 'http://127.0.0.1:9') {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...cleanEnv, TEST_RAVENRY: '1', RAVENRY_HOME: home, MC_BOARD_URL: board, ...env } });
    c.on('close', (code) => resolve(code));
    c.stdin.end(JSON.stringify(input));
  });
}
const lastEvent = (home, sid) => { const l = fs.readFileSync(path.join(home, 'events', sid + '.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };
const REXENV = (b = BA, s = SA) => ({ REX_BLOCK: b, REX_SESSION: s, REX_SERVER: 'unix:///fake/rex.sock', REX_BIN_DIR: '/fake/rex/bin', TERM_PROGRAM: 'rex' });
await hook({ hook_event_name: 'SessionStart', session_id: 'hk-rex-0001', cwd: T, source: 'startup' }, REXENV());
let e = lastEvent(HOOK_HOME, 'hk-rex-0001');
check('hook: a Rex session records terminal "rex", REX_BLOCK and REX_SESSION', e.terminal === 'rex' && e.terminal_id === BA && e.terminal_session === SA && !e.surface_id, JSON.stringify({ terminal: e.terminal, terminal_id: e.terminal_id, terminal_session: e.terminal_session }));

// ------------------------------------------------------------ 2. the adapter

const W = 100;
const RULE = '─'.repeat(W);
const atRest = (topic) => `\n⏺ ${topic}\n\n✻ Worked for 2m 3s · done 9:41 PM\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
const fx = (n) => fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'menus', n + '.txt'), 'utf8');
const SB = 'session:bbbbbbbb-0000-7000-8000-0000000000bb';
const BB = 'block:b1b1b1b1-0000-7000-8000-0000000000b1';
setFake({
  running: true, apiRevision: 11,
  sessions: [{ id: SA, label: 'work', windows: [{ id: WA, label: 'Claude', blocks: [BA] }] }, { id: SB, label: 'other', windows: [{ id: 'window:b2b2b2b2-0000-7000-8000-0000000000b2', label: 'zsh', blocks: [BB] }] }],
  blocks: { [BA]: { title: '✳ Rex work', screen: atRest('Done.') }, [BB]: { title: 'user@mac:~', screen: '➜  ~' } },
});
const tabs = await rex.listTabs();
const ta = tabs.find((t) => t.blockId === BA);
check('adapter: lists every pane of every session as rex:<uuid>, with its title, session and window', tabs.length === 2 && ta && ta.id === 'rex:' + BA.slice(6) && ta.title === '✳ Rex work' && ta.sessionId === SA && ta.windowId === WA, JSON.stringify(ta));
const RA = 'rex:' + BA.slice(6);
const scr = await rex.readScreen(RA, 40);
check('adapter: reads the screen with trailing blank rows trimmed, like read-screen', scr === atRest('Done.').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') + '\n' && parseScreen(scr).claudeLive, JSON.stringify(scr.slice(-60)));
check('adapter: the last n lines only', (await rex.readScreen(RA, 3)).split('\n').length === 4);
check('adapter: a closed pane reads as null', (await rex.readScreen('rex:deaddead-0000-7000-8000-000000000000', 40)) === null);
await rex.pasteText(RA, 'one line');
await rex.pasteText(RA, 'two\nlines');
let k = fst().keys[BA];
check('adapter: one line goes as typed, a line break as one bracketed paste, no Enter', k[0] === 'text:one line' && k[1] === 'text:\x1b[200~two\nlines\x1b[201~' && k.length === 2, JSON.stringify(k));
await rex.pasteText(RA, '-x starts with a dash');
check('adapter: text starting with a dash is still text (after --)', fst().keys[BA][2] === 'text:-x starts with a dash', JSON.stringify(fst().keys[BA][2]));
for (const key of ['enter', 'down', 'up', 'backspace']) await rex.pressKey(RA, key);
k = fst().keys[BA];
check('adapter: Enter, Down, Up and Backspace through rex send-key', k.slice(3).join(' ') === 'key:enter key:down key:up key:backspace', k.slice(3).join(' '));
let r = await rex.pressKey(RA, 'tab');
check('adapter: any other key is refused', !r.ok && /does not send the tab key/.test(r.err));
r = await rex.focus(RA);
let st = fst();
check('adapter: focus selects the pane on the server, then Rex refuses to show it: Remote Control words', !r.ok && r.err === "Turn on Remote Control in Rex's Settings so the board can show sessions in Rex." && st.focused[0].session === SA && st.focused[0].target === BA && !(st.selected || []).length, r.err);
setFake({ ...fst(), remoteControl: true });
r = await rex.focus(RA);
st = fst();
check('adapter: with Remote Control on, the app shows that session and window (session.select)', r.ok && st.selected[0].session_id === SA && st.selected[0].window_id === WA, JSON.stringify(st.selected));
r = await rex.openTab({ near: RA, cwd: T, label: 'rex-test' });
st = fst();
check('adapter: a new tab opens in the Rex session of the pane named, in the folder, not focused', r.ok && /^rex:[0-9a-f-]{36}$/.test(r.surfaceId) && st.opened[0].session === SA && st.opened[0].cwd === T && st.opened[0].label === 'rex-test' && st.opened[0].focus === 'false' && r.surfaceRef === 'Rex tab', JSON.stringify({ r, o: st.opened[0] }));
const made = r.surfaceId;
r = await rex.openTab({ near: 'rex:deaddead-0000-7000-8000-000000000000', session: SB, cwd: T, label: 'x' });
st = fst();
check('adapter: its pane gone, the tab opens in the Rex session named instead', r.ok && st.opened[1].session === SB, JSON.stringify(st.opened[1]));
r = await rex.openTab({ near: null, session: 'session:deaddead-0000-7000-8000-000000000000', cwd: T, label: 'Fresh project' });
st = fst();
check('adapter: no session to go to, a NEW Rex session named after the project, in the folder', r.ok && st.created[0].label === 'Fresh project' && st.created[0].cwd === T && r.surfaceRef === 'Rex session', JSON.stringify(st.created));
r = await rex.close(made);
st = fst();
check('adapter: close closes only the pane named', r.ok && st.closed[0] === 'block:' + made.slice(4) && !!st.blocks[BA] && !!st.blocks[BB]);
r = await rex.close('nope');
check('adapter: close with no id closes nothing', !r.ok && fst().closed.length === 1);
const calls = fs.readFileSync(FAKE + '.calls', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('adapter: every rex call passed --autostart=false (never starts a server)', calls.length > 10 && calls.every((a) => a[0] === '--autostart=false'), `${calls.length} calls`);
// Watch only: no server, an unknown API revision.
setFake({ ...fst(), running: false });
let c = await rex.check({ fresh: true });
let threw = null;
try { await rex.listTabs(); } catch (x) { threw = x.message; }
r = await rex.pasteText(RA, 'x');
check('adapter: no Rex server, nothing is listed or typed, and it says so', !c.ok && /Rex is not running/.test(c.error) && /Rex is not running/.test(threw || '') && !r.ok && /Rex is not running/.test(r.err), `${c.error} | ${threw} | ${r.err}`);
setFake({ ...fst(), running: true, apiRevision: 12 });
c = await rex.check({ fresh: true });
r = await rex.pressKey(RA, 'enter');
check('adapter: an unknown API revision, Rex is not driven, and it says which', !c.ok && /API revision 12/.test(c.error) && /revision 11/.test(c.error) && !r.ok, c.error);
setFake({ ...fst(), apiRevision: 11 });
c = await rex.check({ fresh: true });
check('adapter: back to revision 11, Rex answers again', c.ok && c.revision === 11);
// No rex command at all: a separate process, since the command is found when the module loads.
const nobin = execFileSync(process.execPath, ['--input-type=module', '-e', `import('${path.join(ROOT, 'server', 'rex.mjs')}').then(async (m) => { const s = await m.check(); let t = null; try { await m.listTabs(); } catch (e) { t = e.message; } console.log(JSON.stringify({ bin: m.REX_BIN, s, t })); })`], { env: { ...cleanEnv, TEST_RAVENRY: '1', RAVENRY_HOME: path.join(T, 'guard'), RAVENRY_REX_BIN: 'none' }, encoding: 'utf8' });
const nb = JSON.parse(nobin.trim().split('\n').pop());
check('adapter: no rex command, Rex sessions are watch only and say so', nb.bin === null && !nb.s.ok && /rex command is not on this Mac/.test(nb.s.error) && /not on this Mac/.test(nb.t || ''), nobin.trim());

// ------------------------------------------------------------ 3. the board

const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const CLAUDE = path.join(T, 'claude-projects');
for (const d of [MC, PROJ, CLAUDE, path.join(T, 'root')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Rex test\n\nGoal: Prove the Rex adapter.\nKind: Test\nStage: Build\n\n## Hand-off\n- 2026-11-06 10:00 First.\n');
const git = (...a) => execFileSync('git', ['-C', PROJ, '-c', 'user.name=mc-test', '-c', 'user.email=mc-test@localhost', ...a], { encoding: 'utf8' });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Scratch project for the Rex test');
const regFile = (dir, projects, extra = {}) => fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false, handoffCommand: 'claude', idleHours: 0.0001, ...extra },
  projects,
}, null, 2));
regFile(MC, [{ id: 'rexproj', name: 'Rex Test', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }]);
fs.writeFileSync(FAKE_CMUX, JSON.stringify({ workspaces: [], screens: {} }));

const permAfter = `\n⏺ Bash(mkdir -p zz-made && echo made)\n  ⎿  made\n\n✶ Moseying… (12s · ↓ 92 tokens)\n\n${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on · esc to interrupt\n`;
setFake({
  running: true, apiRevision: 11, remoteControl: false,
  sessions: [{ id: SA, label: 'work', windows: [{ id: WA, label: 'Claude', blocks: [BA, BC] }, { id: 'window:a5a5a5a5-0000-7000-8000-0000000000a5', label: 'idle', blocks: [BS] }] }],
  blocks: { [BA]: { title: '✳ Rex work', screen: atRest('Wrote the adapter.') }, [BC]: { title: '✳ Menu', screen: fx('permission') }, [BS]: { title: '✳ Idle one', screen: atRest('All done here.') } },
  menus: { [BC]: { after: permAfter } },
});
const SID_A = 'a1a1a1a1-0000-4000-8000-0000000000a1'; // Rex pane BA, at rest
const SID_C = 'c3c3c3c3-0000-4000-8000-0000000000c3'; // Rex pane BC, a menu open
const SID_S = 'e5e5e5e5-0000-4000-8000-0000000000e5'; // Rex pane BS, idle, closed by Close idle
const longAgo = new Date(Date.now() - 3 * 3600e3).toISOString();
setFake([{ pid: 70001, ppid: 1, rssKb: 300000, startedAt: longAgo, command: `claude --resume ${SID_S}`, cwd: PROJ, env: `REX_SESSION=${SA} REX_BLOCK=${BS} TERM_PROGRAM=rex` }], PS);

const PORT = 4671;
const BASE = `http://127.0.0.1:${PORT}`;
const boardEnv = (mc, port, extra = {}) => ({
  ...cleanEnv, TEST_RAVENRY: '1', RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE_CMUX, MC_CLAUDE_PROJECTS: CLAUDE,
  RAVENRY_REX_BIN: FAKE_BIN, FAKE_REX_STATE: FAKE, FAKE_REX_PS: PS, MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), MC_CLOSE_ALLOW: SID_S,
  ...extra,
});
function startBoard(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  return p;
}
const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
const postTo = (base) => async (p, body) => { const res = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); let j = null; try { j = await res.json(); } catch { /* none */ } return { status: res.status, j }; };
const stateOf = (base) => async () => (await fetch(base + '/api/state')).json();
async function untilOn(base, cond, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const s = await stateOf(base)(); if (s && cond(s)) return s; } catch { /* starting */ }
    await sleep(100);
  }
  return null;
}
const post = postTo(BASE);
const proj = (s) => s && s.projects.find((p) => p.id === 'rexproj');

let server = startBoard(boardEnv(MC, PORT));
let browser = null;
try {
  const start = (sid, envx, home = MC, base = BASE) => hook({ hook_event_name: 'SessionStart', session_id: sid, cwd: PROJ, source: 'startup' }, envx, home, base);
  const stop = (sid, envx, home = MC, base = BASE) => hook({ hook_event_name: 'Stop', session_id: sid, cwd: PROJ, last_assistant_message: 'Done.' }, envx, home, base);
  await untilOn(BASE, () => true, 15000);
  for (const [sid, b] of [[SID_A, BA], [SID_C, BC], [SID_S, BS]]) {
    await start(sid, REXENV(b));
    await stop(sid, REXENV(b));
  }
  let s = await untilOn(BASE, (x) => proj(x) && proj(x).sessions.length >= 3 && proj(x).sessions.some((y) => y.surfaceId === 'rex:' + BC.slice(6) && y.dialog));
  const by = (sid) => proj(s) && proj(s).sessions.find((y) => y.sessionId === sid);
  const sa = by(SID_A);
  check('board: a Rex session shows as a terminal session with its pane id and title as topic', sa && sa.terminal && sa.term === 'rex' && sa.termName === 'Rex' && sa.surfaceId === RA && sa.live && sa.topic === 'Rex work' && !sa.cannot, sa ? JSON.stringify({ terminal: sa.terminal, term: sa.term, surfaceId: sa.surfaceId, live: sa.live, topic: sa.topic, method: sa.method }) : (proj(s) ? JSON.stringify(proj(s).sessions.map((y) => y.surfaceId)) : server.log.slice(-600)));
  const sc = by(SID_C);
  check('board: its screen is read by the screen rules: the menu shows as a dialog', sc && sc.dialog && sc.state === 'dialog', sc ? `${sc.state} ${sc.reasons.join('; ')}` : '');

  const lv = await (await fetch(`${BASE}/api/live?surface=${encodeURIComponent(RA)}`)).json();
  check('board: the Live screen reads the Rex pane', lv.ok && JSON.stringify(lv.entries || []).includes('Wrote the adapter.'), JSON.stringify(lv).slice(0, 200));

  const k0 = (fst().keys || {})[BA] || [];
  let res = await post('/api/send', { projectId: 'rexproj', surfaceId: RA, text: 'One line from the board' });
  res = await post('/api/send', { projectId: 'rexproj', surfaceId: RA, text: 'First line\nsecond line' });
  let k2 = (fst().keys[BA] || []).slice(k0.length);
  check('board: a one-line message, then a multi-line one as one bracketed paste, each followed by Enter', res.status === 200 && k2.join('|') === 'text:One line from the board|key:enter|text:\x1b[200~First line\nsecond line\x1b[201~|key:enter', `${res.status} ${JSON.stringify(res.j)} ${JSON.stringify(k2)}`);

  res = await post('/api/send', { projectId: 'rexproj', surfaceId: 'rex:' + BC.slice(6), choice: 4 });
  k2 = fst().keys[BC] || [];
  check('board: menu option 4 ("No") taken with three Downs and Enter, read back after each', res.status === 200 && res.j.sent === 'No' && k2.join(' ') === 'key:down key:down key:down key:enter', `${res.status} ${JSON.stringify(res.j)} ${k2.join(' ')}`);
  check('board: the menu is gone from the screen after Enter', !parseScreen(fst().blocks[BC].screen).dialog);

  res = await post('/api/open', { projectId: 'rexproj', surfaceId: RA });
  check('board: Open in Rex with Remote Control off says to turn it on, in plain words', res.status === 500 && res.j.error === "Turn on Remote Control in Rex's Settings so the board can show sessions in Rex.", `${res.status} ${JSON.stringify(res.j)}`);
  setFake({ ...fst(), remoteControl: true });
  res = await post('/api/open', { projectId: 'rexproj', surfaceId: RA });
  st = fst();
  check('board: Open in Rex with Remote Control on shows that session in the app', res.status === 200 && res.j.where === 'Rex' && st.selected.some((x) => x.session_id === SA && x.window_id === WA), `${res.status} ${JSON.stringify(res.j)}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/#rexproj`);
  await page.waitForSelector('#d-strip [data-act="open"]', { timeout: 15000 });
  await page.click(`[data-act="session"][data-surface="${RA}"]`);
  await page.waitForFunction(() => /Open in Rex/.test(document.querySelector('#d-strip [data-act="open"]').textContent), null, { timeout: 5000 }).catch(() => {});
  const btn = await page.textContent('#d-strip [data-act="open"]');
  const off = await page.$eval('#d-strip [data-act="open"]', (b) => b.disabled);
  check('page: the Rex session\'s strip says "Open in Rex", enabled', btn.trim() === 'Open in Rex' && !off, `${btn} disabled=${off}`);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'rex-session.png') }); }
  await page.close();

  // A written hand-off: the fresh session opens in a new tab in the old Rex session.
  const keysBefore = (fst().keys[BA] || []).length;
  const opened0 = (fst().opened || []).length;
  const hand = path.join(MC, 'handoffs');
  fs.mkdirSync(hand, { recursive: true });
  fs.writeFileSync(path.join(hand, SID_A + '.json'), JSON.stringify({ sessionId: SID_A, state: 'written', writtenAt: new Date().toISOString(), handoffFile: path.join(PROJ, 'BRIEF.md'), cwd: PROJ, folder: PROJ, projectId: 'rexproj' }));
  let m = null;
  for (let i = 0; i < 60; i++) { await sleep(150); try { m = JSON.parse(fs.readFileSync(path.join(hand, SID_A + '.json'), 'utf8')); } catch { /* writing */ } if (m && (m.state === 'resumed' || m.resumeError)) break; }
  st = fst();
  const ho = (st.opened || [])[opened0];
  const hk = ho ? st.keys[ho.block] || [] : [];
  check('board: the hand-off\'s fresh session opens in a new tab in the old Rex session, in the folder', m && m.state === 'resumed' && ho && ho.session === SA && ho.cwd === PROJ && m.resumeSurfaceId === 'rex:' + ho.block.slice(6), m ? JSON.stringify({ state: m.state, err: m.resumeError, ho }) : 'no marker');
  check('board: it runs cd <folder> && claude \'<prompt>\', then Enter', hk.length === 2 && hk[0] === `text:cd '${PROJ}' && claude 'Read the Hand-off section of BRIEF.md and continue from it.'` && hk[1] === 'key:enter', JSON.stringify(hk));
  check('board: the old pane got nothing from the hand-off', (fst().keys[BA] || []).length === keysBefore);

  // Close idle: the idle Claude in pane BS (its process names REX_BLOCK).
  s = await untilOn(BASE, (x) => x.sessions && x.sessions.rows.some((rw) => rw.sessionId === SID_S && rw.closable), 70000);
  const row = s && s.sessions.rows.find((rw) => rw.sessionId === SID_S);
  check('Sessions: the idle Rex session is listed in its Rex tab and can be closed', row && row.surfaceId === 'rex:' + BS.slice(6) && row.closable, row ? JSON.stringify({ surfaceId: row.surfaceId, group: row.group, blocked: row.blocked }) : 'no row');
  res = await post('/api/sessions/close', { ids: [SID_S] });
  st = fst();
  check('Close idle: closes exactly that Rex pane', res.status === 200 && res.j.closed === 1 && st.closed.includes(BS) && !!st.blocks[BA], `${res.status} ${JSON.stringify(res.j)}`);
  const rec = JSON.parse(fs.readFileSync(path.join(MC, 'closed', SID_S + '.json'), 'utf8'));
  check('Close idle: the record names Rex and its Rex session, for Reopen', rec.term === 'rex' && rec.termSession === SA, JSON.stringify({ term: rec.term, termSession: rec.termSession }));
  const op1 = (fst().opened || []).length;
  res = await post('/api/sessions/reopen', { id: SID_S });
  st = fst();
  const ro = (st.opened || [])[op1];
  check('Reopen: a new tab in the closed pane\'s Rex session runs cd <folder> && claude --resume <id>', res.status === 200 && ro && ro.session === SA && JSON.stringify(st.keys[ro.block]) === JSON.stringify([`text:cd '${PROJ}' && claude --resume ${SID_S}`, 'key:enter']), `${res.status} ${JSON.stringify(res.j)} ${ro ? JSON.stringify(st.keys[ro.block]) : 'no tab'}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

// ------------------------------------------------------------ 4. watch only

const MC2 = path.join(T, 'mc2');
const FAKE2 = path.join(T, 'fake-rex-2.json');
fs.mkdirSync(MC2, { recursive: true });
regFile(MC2, [{ id: 'rexproj', name: 'Rex Test', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }]);
setFake({ running: false, sessions: [{ id: SA, label: 'work', windows: [{ id: WA, label: 'Claude', blocks: [BA] }] }], blocks: { [BA]: { title: '✳ Rex work', screen: atRest('Done.') } } }, FAKE2);
const PORT2 = 4672;
const BASE2 = `http://127.0.0.1:${PORT2}`;
server = startBoard(boardEnv(MC2, PORT2, { FAKE_REX_STATE: FAKE2 }));
try {
  await untilOn(BASE2, () => true, 15000);
  await hook({ hook_event_name: 'SessionStart', session_id: SID_A, cwd: PROJ, source: 'startup' }, REXENV(), MC2, BASE2);
  await hook({ hook_event_name: 'Stop', session_id: SID_A, cwd: PROJ, last_assistant_message: 'Done.' }, REXENV(), MC2, BASE2);
  const one = (x) => proj(x) && proj(x).sessions.find((y) => y.sessionId === SID_A);
  let s = await untilOn(BASE2, (x) => one(x) && /not running/.test(one(x).cannot || ''), 10000);
  let x = one(s);
  check('watch only: Rex not running, the session shows from its events and says why', x && !x.terminal && x.term === 'rex' && /^The board could not reach Rex: Rex is not running \(no Rex server answered\)\. Until it can, it only shows what this session's hook events say\.$/.test(x.cannot) && /cannot reach Rex now/.test(x.cannotType || ''), x ? `${x.cannot} | ${x.cannotType}` : JSON.stringify(s && proj(s)));
  const r2 = await postTo(BASE2)('/api/send', { projectId: 'rexproj', surfaceId: 'ev:' + SID_A, text: 'hello' });
  check('watch only: nothing is typed into it', r2.status >= 400 && !(fst(FAKE2).keys), `${r2.status} ${JSON.stringify(r2.j)}`);
  setFake({ ...fst(FAKE2), running: true, apiRevision: 12 }, FAKE2);
  s = await untilOn(BASE2, (y) => one(y) && /API revision 12/.test(one(y).cannot || ''), 12000);
  x = one(s);
  check('watch only: Rex speaking API revision 12, the session says the board was built for 11', x && !x.terminal && /Rex's server speaks API revision 12, and this board was built for revision 11/.test(x.cannot), x ? x.cannot : 'not seen');
  setFake({ ...fst(FAKE2), apiRevision: 11 }, FAKE2);
  s = await untilOn(BASE2, (y) => one(y) && one(y).terminal && one(y).surfaceId === RA, 12000);
  check('watch only: back to revision 11, the board drives the session again', !!s);
} finally {
  server.kill();
}
const MC3 = path.join(T, 'mc3');
fs.mkdirSync(MC3, { recursive: true });
regFile(MC3, [{ id: 'rexproj', name: 'Rex Test', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }]);
const PORT3 = 4678;
const BASE3 = `http://127.0.0.1:${PORT3}`;
server = startBoard(boardEnv(MC3, PORT3, { RAVENRY_REX_BIN: 'none' }));
try {
  await untilOn(BASE3, () => true, 15000);
  await hook({ hook_event_name: 'SessionStart', session_id: SID_A, cwd: PROJ, source: 'startup' }, REXENV(), MC3, BASE3);
  await hook({ hook_event_name: 'Stop', session_id: SID_A, cwd: PROJ, last_assistant_message: 'Done.' }, REXENV(), MC3, BASE3);
  const s = await untilOn(BASE3, (x) => proj(x) && proj(x).sessions.some((y) => y.sessionId === SID_A && y.cannot), 10000);
  const x = s && proj(s).sessions.find((y) => y.sessionId === SID_A);
  check('watch only: no rex command on this Mac, the session says so', x && !x.terminal && /could not reach Rex: Rex's rex command is not on this Mac/.test(x.cannot), x ? x.cannot : 'not seen');
} finally {
  server.kill();
}

// ------------------------------------------------------------ 5. Rex mode

const MC4 = path.join(T, 'mc4');
const ROOT4 = path.join(T, 'root4');
const FAKE4 = path.join(T, 'fake-rex-4.json');
const TRIP = path.join(T, 'cmux-tripwire.mjs');
const TRIP_LOG = path.join(T, 'cmux-calls.log');
for (const d of [MC4, ROOT4]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(TRIP, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(TRIP_LOG)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
regFile(MC4, [{ id: 'rexproj', name: 'Rex Test', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }], { projectsRoot: ROOT4 });
setFake({ running: true, sessions: [{ id: SA, label: 'Rex Test', windows: [{ id: WA, label: 'Claude', blocks: [BA] }] }], blocks: { [BA]: { title: '✳ Rex work', screen: atRest('Done.') } } }, FAKE4);
const PORT4 = 4673;
const BASE4 = `http://127.0.0.1:${PORT4}`;
const post4 = postTo(BASE4);
server = startBoard(boardEnv(MC4, PORT4, { RAVENRY_TERMINAL: 'rex', CMUX_BIN: TRIP, FAKE_REX_STATE: FAKE4, MC_PROJECTS_ROOT: ROOT4 }));
try {
  let s = await untilOn(BASE4, (x) => x.generatedAt, 15000);
  check('Rex mode: the snapshot says the board runs in Rex', s && s.board && s.board.kind === 'rex' && s.board.name === 'Rex' && !s.error, JSON.stringify(s && { board: s.board, error: s.error }));
  await hook({ hook_event_name: 'SessionStart', session_id: SID_A, cwd: PROJ, source: 'startup' }, REXENV(), MC4, BASE4);
  await hook({ hook_event_name: 'Stop', session_id: SID_A, cwd: PROJ, last_assistant_message: 'Done.' }, REXENV(), MC4, BASE4);
  s = await untilOn(BASE4, (x) => proj(x) && proj(x).sessions.some((y) => y.sessionId === SID_A && y.terminal), 10000);
  check('Rex mode: the project\'s Rex session is driven', !!s);

  let r = await post4('/api/project/new', { name: 'Fresh One', goal: 'Prove Rex mode.' });
  let st4 = fst(FAKE4);
  const FRESH = path.join(ROOT4, 'fresh-one');
  const nc = (st4.created || [])[0];
  check('New project: a NEW Rex session named after the project, in its folder, and it says so', r.status === 200 && nc && nc.label === 'Fresh One' && nc.cwd === FRESH && /new Rex session/.test(r.j.message || ''), JSON.stringify({ j: r.j, nc }));
  check('New project: the new session got cd <folder> && claude <prompt>, then Enter', nc && JSON.stringify(st4.keys[nc.block]) === JSON.stringify([`text:cd '${FRESH}' && claude 'Read BRIEF.md and start on the first milestone.'`, 'key:enter']), nc ? JSON.stringify(st4.keys[nc.block]) : 'none');
  r = await post4('/api/project/revive', { projectId: 'rexproj' });
  st4 = fst(FAKE4);
  const rt = (st4.opened || [])[0];
  check('Revive: a new tab in the project\'s own Rex session, in its folder', r.status === 200 && rt && rt.session === SA && rt.cwd === PROJ && /New Rex tab for Rex Test/.test(r.j.message || ''), JSON.stringify({ j: r.j, rt }));
  check('Revive: it runs cd <folder> && claude \'Read BRIEF.md (Hand-off section first) and continue.\'', rt && (st4.keys[rt.block] || [])[0] === `text:cd '${PROJ}' && claude 'Read BRIEF.md (Hand-off section first) and continue.'`, rt ? JSON.stringify(st4.keys[rt.block]) : 'none');
  const fresh = (await stateOf(BASE4)()).projects.find((p) => p.folder === FRESH);
  r = await post4('/api/open', { projectId: fresh.id, surfaceId: null });
  check('Open: a project with no Rex tab says so in Rex\'s words', r.status === 409 && /no open Rex tab/.test(r.j.error) && !/cmux/.test(r.j.error), r.j.error);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE4 + '/#rexproj');
  await page.waitForSelector('[data-act="open"]', { timeout: 10000 });
  const ob = await page.textContent('[data-act="open"]');
  check('page: the session strip says "Open in Rex"', /Open in Rex/.test(ob), ob);
  await page.click('#new-project');
  await page.waitForSelector('#modal-form');
  const foot = await page.textContent('#m-foot');
  const go = await page.textContent('#m-go');
  check('page: New project says it opens a new Rex session, and its button "Start in Rex"', /opens a new Rex session/.test(foot) && /Start in Rex/.test(go) && !/cmux/.test(foot + go), `${foot} | ${go}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'rex-mode-new-project.png') });

  const calls = fs.existsSync(TRIP_LOG) ? fs.readFileSync(TRIP_LOG, 'utf8').trim() : '';
  check('Rex mode: cmux was never run, not once', calls === '', calls.split('\n').slice(0, 3).join(' | '));
  check('Rex mode: no cmux error in its output', !/cmux/i.test(server.log), server.log.split('\n').filter((l) => /cmux/i.test(l)).slice(0, 2).join(' | '));
} finally {
  if (browser) await browser.close();
  server.kill();
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
