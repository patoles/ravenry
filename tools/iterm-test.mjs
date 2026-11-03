// The terminal interface and the iTerm2 adapter (docs/TERMINALS.md), with
// tools/fake-iterm.mjs standing in for iTerm2's osascript and Python API and
// tools/fake-cmux.mjs for cmux, so nothing here reaches a real terminal.
//
// 1. Which terminal a session runs in, from the hook's environment
//    (server/termenv.mjs), and the hook recording it in its event lines.
// 2. server/iterm.mjs against the fake: list, read (trimmed like cmux's
//    read-screen), text (a line break goes as a bracketed paste), Enter
//    through AppleScript, the arrows through the Python API, focus, a new
//    tab in the old one's window, close, iTerm2 not running, Python API off.
// 3. A test board on :4680 (RAVENRY_HOME under .tmp/iterm-test): an iTerm2
//    session reported by the real hook shows as a terminal session with its
//    screen; a VS Code session and an iTerm2 session whose tab is gone are
//    watch only with a plain reason; the Live screen, a message with a line
//    break, a menu choice (arrows through Python, Enter through AppleScript),
//    "Open in iTerm2", and a written hand-off's fresh session opened in the
//    old tab's window with `cd <folder> && claude '<prompt>'`. The page,
//    headless: "Open in iTerm2" for the iTerm2 session, and the VS Code
//    session's composer saying why it is off.
//
// Usage: node tools/iterm-test.mjs [shotsDir]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'iterm-test');
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const FAKE_IT = path.join(T, 'fake-iterm.json');
const FAKE_CMUX = path.join(T, 'fake-cmux.json');
const FAKE_BIN = path.join(ROOT, 'tools', 'fake-iterm.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const fst = () => JSON.parse(fs.readFileSync(FAKE_IT, 'utf8'));
const setFake = (x) => fs.writeFileSync(FAKE_IT, JSON.stringify(x));

// The adapter reads its programs from the environment when it loads.
process.env.ITERM_OSASCRIPT_BIN = FAKE_BIN;
process.env.RAVENRY_ITERM_PYTHON = FAKE_BIN;
process.env.FAKE_ITERM_STATE = FAKE_IT;
const { terminalOf } = await import('../server/termenv.mjs');
const iterm = await import('../server/iterm.mjs');
const term = await import('../server/terminal.mjs');
const { parseScreen } = await import('../server/screen.mjs');

// ------------------------------------------------------------ 1. detection

const A = 'C1C1C1C1-0000-4000-8000-00000000C1C1';
const cases = [
  ['cmux first, even with iTerm2 variables inherited', { CMUX_SURFACE_ID: 'x', ITERM_SESSION_ID: 'w0t0p0:' + A, TERM_PROGRAM: 'iTerm.app' }, { terminal: 'cmux' }],
  ['tmux inside iTerm2 is tmux (watch only)', { TMUX: '/tmp/tmux-501/default,1,0', ITERM_SESSION_ID: 'w0t0p0:' + A }, { terminal: 'tmux' }],
  ['iTerm2 with its session id', { ITERM_SESSION_ID: 'w0t1p0:' + A, TERM_PROGRAM: 'iTerm.app' }, { terminal: 'iterm', terminal_id: 'w0t1p0:' + A }],
  ['Terminal.app with its session id', { TERM_PROGRAM: 'Apple_Terminal', TERM_SESSION_ID: 'B2F0-1' }, { terminal: 'apple-terminal', terminal_id: 'B2F0-1' }],
  ['VS Code by TERM_PROGRAM', { TERM_PROGRAM: 'vscode' }, { terminal: 'vscode' }],
  ['nothing known', { HOME: '/x' }, {}],
];
for (const [name, env, want] of cases) {
  const got = terminalOf(env);
  check(`detect: ${name}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
check('names: iTerm2, Terminal, VS Code, unknown', term.nameOf('iterm') === 'iTerm2' && term.nameOf('apple-terminal') === 'Terminal' && term.nameOf('vscode') === 'VS Code' && /unknown/.test(term.nameOf(null)));
check('adapters: cmux and iTerm2 drive, the rest are watch only', term.canDrive('cmux') && term.canDrive('iterm') && !term.canDrive('apple-terminal') && !term.canDrive('vscode') && !term.canDrive('tmux'));
check('watch only says why in plain words', /runs in VS Code\. The board cannot read or type into VS Code yet/.test(term.cannotDrive('vscode')) && /cannot find this session's iTerm2 tab/.test(term.cannotDrive('iterm', { open: false })) && term.cannotDrive('iterm') === null);

// The hook records it.
const HOOK_HOME = path.join(T, 'hook-home');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|TMUX|WEZTERM_|KITTY_)/.test(k)));
function hook(input, env, home = HOOK_HOME, board = 'http://127.0.0.1:9') {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...cleanEnv, RAVENRY_HOME: home, MC_BOARD_URL: board, ...env } });
    c.on('close', (code) => resolve(code));
    c.stdin.end(JSON.stringify(input));
  });
}
const lastEvent = (home, sid) => { const l = fs.readFileSync(path.join(home, 'events', sid + '.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };
await hook({ hook_event_name: 'SessionStart', session_id: 'hk-iterm-01', cwd: T, source: 'startup' }, { ITERM_SESSION_ID: 'w0t2p0:' + A, TERM_PROGRAM: 'iTerm.app' });
let e = lastEvent(HOOK_HOME, 'hk-iterm-01');
check('hook: an iTerm2 session records terminal "iterm" and its ITERM_SESSION_ID', e.terminal === 'iterm' && e.terminal_id === 'w0t2p0:' + A && !e.surface_id, JSON.stringify({ terminal: e.terminal, terminal_id: e.terminal_id }));
await hook({ hook_event_name: 'SessionStart', session_id: 'hk-vscode-01', cwd: T, source: 'startup' }, { TERM_PROGRAM: 'vscode' });
e = lastEvent(HOOK_HOME, 'hk-vscode-01');
check('hook: a VS Code session records terminal "vscode" and no id', e.terminal === 'vscode' && !e.terminal_id);
await hook({ hook_event_name: 'SessionStart', session_id: 'hk-cmux-001', cwd: T, source: 'startup' }, { CMUX_SURFACE_ID: 'sf-1', CMUX_WORKSPACE_ID: 'ws-1', ITERM_SESSION_ID: 'w0t0p0:' + A });
e = lastEvent(HOOK_HOME, 'hk-cmux-001');
check('hook: a cmux session records "cmux" with its surface, as before', e.terminal === 'cmux' && e.surface_id === 'sf-1' && e.workspace_id === 'ws-1' && !e.terminal_id);

// ------------------------------------------------------------ 2. the adapter

const B = '5A5A5A5A-0000-4000-8000-000000005A5A';
const W = 100;
const RULE = '─'.repeat(W);
const atRest = (topic) => `\n⏺ ${topic}\n\n✻ Worked for 2m 3s · done 9:41 PM\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
setFake({ running: true, sessions: [{ uuid: A, windowId: '7', tty: '/dev/ttys009', title: '✳ iTerm work' }, { uuid: B, windowId: '8', tty: '/dev/ttys010', title: '~ (-zsh)' }], screens: { [A]: atRest('Done.'), [B]: '➜  ~' } });
const tabs = await iterm.listTabs();
check('adapter: lists every session as iterm:<UUID> with its title', tabs.length === 2 && tabs[0].id === 'iterm:' + A && tabs[0].title === '✳ iTerm work' && tabs[0].windowId === '7', JSON.stringify(tabs[0]));
check('adapter: ids from ITERM_SESSION_ID, bare and prefixed', iterm.tabIdOf('w0t1p0:' + A.toLowerCase()) === 'iterm:' + A && iterm.uuidOf('iterm:' + A) === A && iterm.uuidOf('nope') === null);
const scr = await iterm.readScreen('iterm:' + A, 40);
check('adapter: reads the screen with trailing spaces and blank rows trimmed, like read-screen', scr === atRest('Done.').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') + '\n' && parseScreen(scr).claudeLive, JSON.stringify(scr.slice(-60)));
check('adapter: the last n lines only', (await iterm.readScreen('iterm:' + A, 3)).split('\n').length === 4);
check('adapter: a closed session reads as null', (await iterm.readScreen('iterm:' + 'DEADBEEF-0000-4000-8000-000000000000', 40)) === null);
let r = await iterm.pasteText('iterm:' + A, 'one line');
r = await iterm.pasteText('iterm:' + A, 'two\nlines');
let k = fst().keys[A];
check('adapter: one line goes as typed, a line break as a bracketed paste, no Enter', k[0] === 'text:one line' && k[1] === 'text:\x1b[200~two\nlines\x1b[201~' && k.length === 2, JSON.stringify(k));
await iterm.pressKey('iterm:' + A, 'enter');
await iterm.pressKey('iterm:' + A, 'down');
await iterm.pressKey('iterm:' + A, 'up');
k = fst().keys[A];
check('adapter: Enter through AppleScript, Down and Up through the Python API', k.slice(2).join(' ') === 'osa:enter py:down py:up', k.slice(2).join(' '));
r = await iterm.pressKey('iterm:' + A, 'tab');
check('adapter: any other key is refused', !r.ok && /does not send the tab key/.test(r.err));
r = await iterm.focus('iterm:' + A);
check('adapter: focus selects that session', r.ok && fst().focused[0] === A);
r = await iterm.openTab({ near: 'iterm:' + B });
let st = fst();
check('adapter: a new tab opens in the window of the session named', r.ok && /^iterm:[0-9A-F-]{36}$/.test(r.surfaceId) && st.opened[0].near === B && st.opened[0].windowId === '8', JSON.stringify(r));
const made = r.surfaceId;
r = await iterm.close(made);
check('adapter: close closes only the session named', r.ok && fst().closed[0] === iterm.uuidOf(made) && fst().sessions.length === 2);
r = await iterm.close('nope');
check('adapter: close with no id closes nothing', !r.ok && fst().closed.length === 1);
setFake({ ...fst(), noPython: true });
r = await iterm.pressKey('iterm:' + A, 'down');
check('adapter: Python API off, the arrow fails and says where to turn it on', !r.ok && /Python API/.test(r.err) && /Settings > General > Magic/.test(r.err), r.err);
setFake({ ...fst(), noPython: false, running: false });
check('adapter: iTerm2 not running lists no tabs (and never launches it)', (await iterm.listTabs()).length === 0);
r = await iterm.pasteText('iterm:' + A, 'x');
check('adapter: iTerm2 not running, a write fails plainly', !r.ok && /iTerm2 is not running/.test(r.err), r.err);

// ------------------------------------------------------------ 3. the board

const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const CLAUDE = path.join(T, 'claude-projects');
for (const d of [MC, PROJ, CLAUDE, path.join(T, 'root')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# iTerm test\n\nGoal: Prove the iTerm2 adapter.\nKind: Test\nStage: Build\n\n## Hand-off\n- 2026-11-03 10:00 First.\n');
const git = (...a) => execFileSync('git', ['-C', PROJ, '-c', 'user.name=mc-test', '-c', 'user.email=mc-test@localhost', ...a], { encoding: 'utf8' });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Scratch project for the iTerm2 test');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false, handoffCommand: 'claude' },
  projects: [{ id: 'itproj', name: 'iTerm Test', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }],
}, null, 2));
fs.writeFileSync(FAKE_CMUX, JSON.stringify({ workspaces: [], screens: {} }));

const C = 'B0B0B0B0-1111-4222-8333-444444444444'; // the menu tab
const GONE = 'DEADBEEF-0000-4000-8000-000000000000';
const fx = (n) => fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'menus', n + '.txt'), 'utf8');
const permAfter = `\n⏺ Bash(mkdir -p zz-made && echo made)\n  ⎿  made\n\n✶ Moseying… (12s · ↓ 92 tokens)\n\n${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on · esc to interrupt\n`;
setFake({
  running: true,
  sessions: [{ uuid: A, windowId: '7', tty: '/dev/ttys009', title: '✳ iTerm work' }, { uuid: C, windowId: '7', tty: '/dev/ttys011', title: '✳ Menu' }, { uuid: B, windowId: '8', tty: '/dev/ttys010', title: '~ (-zsh)' }],
  screens: { [A]: atRest('Wrote the adapter.'), [C]: fx('permission'), [B]: '➜  ~' },
  menus: { [C]: { after: permAfter } },
});

const PORT = 4680;
const BASE = `http://127.0.0.1:${PORT}`;
const SA = 'a1a1a1a1-0000-4000-8000-0000000000a1'; // iTerm2, tab A, at rest
const SC = 'c3c3c3c3-0000-4000-8000-0000000000c3'; // iTerm2, tab C, a menu open
const SV = 'v5v5v5v5-0000-4000-8000-0000000000v5'; // VS Code
const SG = 'g7g7g7g7-0000-4000-8000-0000000000g7'; // iTerm2, its tab is gone
const env = {
  ...cleanEnv, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE_CMUX, MC_CLAUDE_PROJECTS: CLAUDE,
  ITERM_OSASCRIPT_BIN: FAKE_BIN, RAVENRY_ITERM_PYTHON: FAKE_BIN, FAKE_ITERM_STATE: FAKE_IT,
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
};
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
const post = async (p, body) => { const res = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); let j = null; try { j = await res.json(); } catch { /* none */ } return { status: res.status, j }; };
const proj = async () => (await (await fetch(BASE + '/api/state')).json()).projects.find((p) => p.id === 'itproj');
async function until(cond, ms = 8000) {
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < ms) {
    try { p = await proj(); if (p && cond(p)) return p; } catch { /* starting */ }
    await sleep(100);
  }
  return null;
}

try {
  // The real hook reports the four sessions to the board.
  const start = (sid, envx) => hook({ hook_event_name: 'SessionStart', session_id: sid, cwd: PROJ, source: 'startup' }, envx, MC, BASE);
  const stop = (sid, envx) => hook({ hook_event_name: 'Stop', session_id: sid, cwd: PROJ, last_assistant_message: 'Done.' }, envx, MC, BASE);
  await until(() => true, 15000);
  for (const [sid, envx] of [[SA, { ITERM_SESSION_ID: 'w0t0p0:' + A, TERM_PROGRAM: 'iTerm.app' }], [SC, { ITERM_SESSION_ID: 'w0t1p0:' + C, TERM_PROGRAM: 'iTerm.app' }], [SV, { TERM_PROGRAM: 'vscode' }], [SG, { ITERM_SESSION_ID: 'w1t0p0:' + GONE, TERM_PROGRAM: 'iTerm.app' }]]) {
    await start(sid, envx);
    await stop(sid, envx);
  }
  const p = await until((x) => x.sessions.length >= 4 && x.sessions.some((s) => s.surfaceId === 'iterm:' + C && s.dialog));
  const by = (sid) => p && p.sessions.find((s) => s.sessionId === sid);
  const sa = by(SA);
  check('board: an iTerm2 session shows as a terminal session with its tab id and title', sa && sa.terminal && sa.term === 'iterm' && sa.termName === 'iTerm2' && sa.surfaceId === 'iterm:' + A && sa.live && sa.topic === 'iTerm work' && !sa.cannot, sa ? JSON.stringify({ terminal: sa.terminal, term: sa.term, surfaceId: sa.surfaceId, live: sa.live, topic: sa.topic, method: sa.method, state: sa.state }) : (p ? JSON.stringify(p.sessions.map((s) => s.surfaceId)) : log.slice(-600)));
  const sc = by(SC);
  check('board: its screen is read: the iTerm2 menu shows as a dialog with its options', sc && sc.dialog && sc.state === 'dialog', sc ? `${sc.state} ${sc.reasons.join('; ')}` : '');
  const sv = by(SV);
  check('board: a VS Code session is watch only and says why', sv && !sv.terminal && sv.term === 'vscode' && /runs in VS Code/.test(sv.cannot || ''), sv ? sv.cannot : '');
  const sg = by(SG);
  check('board: an iTerm2 session whose tab is gone is watch only and says so', sg && !sg.terminal && /cannot find this session's iTerm2 tab/.test(sg.cannot || ''), sg ? sg.cannot : '');

  // The Live screen.
  const lv = await (await fetch(`${BASE}/api/live?surface=${encodeURIComponent('iterm:' + A)}`)).json();
  check('board: the Live screen reads the iTerm2 tab', lv.ok && lv.entries && lv.entries.length > 0 && JSON.stringify(lv.entries).includes('Wrote the adapter.'), JSON.stringify(lv).slice(0, 200));

  // A message with a line break.
  let res = await post('/api/send', { projectId: 'itproj', surfaceId: 'iterm:' + A, text: 'First line\nsecond line' });
  let k2 = fst().keys[A] || [];
  check('board: a message goes into the iTerm2 tab as one paste, then Enter', res.status === 200 && k2.join('|') === 'text:\x1b[200~First line\nsecond line\x1b[201~|osa:enter', `${res.status} ${JSON.stringify(res.j)} ${JSON.stringify(k2)}`);
  res = await post('/api/send', { projectId: 'itproj', surfaceId: 'iterm:' + GONE, text: 'hello' });
  check('board: nothing is typed into a session the board shows watch only', res.status === 400 && !(fst().keys[GONE]), `${res.status} ${JSON.stringify(res.j)}`);

  // A menu choice: the arrows through Python, Enter through AppleScript.
  res = await post('/api/send', { projectId: 'itproj', surfaceId: 'iterm:' + C, choice: 4 });
  k2 = fst().keys[C] || [];
  check('board: menu option 4 ("No") taken with three Downs (Python API) and Enter', res.status === 200 && res.j.sent === 'No' && k2.join(' ') === 'py:down py:down py:down osa:enter', `${res.status} ${JSON.stringify(res.j)} ${k2.join(' ')}`);
  check('board: the menu is gone from the screen after Enter', !parseScreen(fst().screens[C]).dialog);

  // Open in iTerm2.
  res = await post('/api/open', { projectId: 'itproj', surfaceId: 'iterm:' + A });
  check('board: Open in iTerm2 brings that session forward', res.status === 200 && res.j.where === 'iTerm2' && (fst().focused || []).includes(A), `${res.status} ${JSON.stringify(res.j)}`);

  // The page: the iTerm2 session's button and the VS Code session's composer.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/#itproj`);
    await page.waitForSelector('#d-strip [data-act="open"]', { timeout: 15000 });
    await page.click(`[data-act="session"][data-surface="iterm:${C}"]`);
    await page.waitForFunction(() => /Open in iTerm2/.test(document.querySelector('#d-strip [data-act="open"]').textContent), null, { timeout: 5000 }).catch(() => {});
    const btn = await page.textContent('#d-strip [data-act="open"]');
    const off = await page.$eval('#d-strip [data-act="open"]', (b) => b.disabled);
    check('page: the iTerm2 session\'s strip says "Open in iTerm2", enabled', btn.trim() === 'Open in iTerm2' && !off, `${btn} disabled=${off}`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'iterm-session.png') }); }
    await page.click(`[data-act="session"][data-surface="ev:${SV}"]`);
    await page.waitForFunction(() => /VS Code/.test(document.querySelector('#compose').placeholder), null, { timeout: 5000 }).catch(() => {});
    const ph = await page.$eval('#compose', (t) => t.placeholder);
    const sendOff = await page.$eval('#send', (b) => b.disabled);
    check('page: the VS Code session\'s composer says why it is off, Send disabled', /^This session runs in VS Code, so the board cannot type into it\. Answer it in VS Code\.$/.test(ph) && sendOff, ph);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'vscode-session.png') });
  } finally {
    await browser.close();
  }

  // A written hand-off: the fresh session opens in a new tab in its window.
  const hand = path.join(MC, 'handoffs');
  fs.mkdirSync(hand, { recursive: true });
  fs.writeFileSync(path.join(hand, SA + '.json'), JSON.stringify({ sessionId: SA, state: 'written', writtenAt: new Date().toISOString(), handoffFile: path.join(PROJ, 'BRIEF.md'), cwd: PROJ, folder: PROJ, projectId: 'itproj' }));
  let m = null;
  for (let i = 0; i < 60; i++) { await sleep(150); try { m = JSON.parse(fs.readFileSync(path.join(hand, SA + '.json'), 'utf8')); } catch { /* writing */ } if (m && (m.state === 'resumed' || m.resumeError)) break; }
  const st2 = fst();
  const opened = (st2.opened || [])[0];
  const newKeys = opened ? st2.keys[opened.uuid] || [] : [];
  check('board: the fresh session opens in a new iTerm2 tab in the old tab\'s window', m && m.state === 'resumed' && opened && opened.near === A && opened.windowId === '7' && m.resumeSurfaceId === 'iterm:' + opened.uuid, m ? JSON.stringify({ state: m.state, err: m.resumeError, opened }) : 'no marker');
  check('board: it runs cd <folder> && claude \'<prompt>\', then Enter', newKeys.length === 2 && newKeys[0] === `text:cd '${PROJ}' && claude 'Read the Hand-off section of BRIEF.md and continue from it.'` && newKeys[1] === 'osa:enter', JSON.stringify(newKeys));
  check('board: the old tab got nothing from the hand-off', (fst().keys[A] || []).length === 2);
} finally {
  server.kill();
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
