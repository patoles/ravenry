// iTerm2 mode (docs/TERMINALS.md, The board's terminal) and the Ravenry tab
// in iTerm2 (tools/open-in-iterm.mjs), with tools/fake-iterm.mjs standing in
// for iTerm2 and a tripwire standing in for cmux, so nothing here reaches a
// real terminal and any cmux call is caught.
//
// 1. Which terminal the board itself drives, from where it was started.
// 2. tools/open-in-iterm.mjs against the fake: the start command, the page
//    profile, a new tab (page above, terminal below, both tagged), reuse
//    (focus, and the start command again when the board is down), only the
//    page when a board already answers, the default browser when iTerm2's
//    Browser Plugin is missing, --close, and an untagged tab left alone.
// 3. A test board on :4682 started with RAVENRY_TERMINAL=iterm: it says so
//    in its snapshot, never runs cmux, New project and Revive open iTerm2
//    tabs that cd to the folder and run claude, Open answers in iTerm2's
//    words, an iTerm2 session in a folder no project holds becomes a
//    project, a cmux session is watch only with the reason, and the page
//    says iTerm2 where it said cmux.
//
// 4. A second board on :4684 (HOME a scratch folder): which project a
//    session goes to (a workspace a project lists wins; never a project
//    whose folder is the projects root or a mere parent of the cwd), a
//    session in the projects root with no repo on a card of its own, a
//    project with no folder, and the Live card of a watch-only session
//    ("Watch only", never "Not read yet") on desktop and phone.
//
// Usage: node tools/iterm-mode-test.mjs [shotsDir]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'iterm-mode-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const FAKE_IT = path.join(T, 'fake-iterm.json');
const FAKE_BIN = path.join(ROOT, 'tools', 'fake-iterm.mjs');
const TRIP = path.join(T, 'cmux-tripwire.mjs');
const TRIP_LOG = path.join(T, 'cmux-calls.log');
const OPEN_LOG = path.join(T, 'open.log');
const PROFILES = path.join(T, 'DynamicProfiles');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const fst = () => JSON.parse(fs.readFileSync(FAKE_IT, 'utf8'));
const setFake = (x) => fs.writeFileSync(FAKE_IT, JSON.stringify(x));
const opens = () => (fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : []);
fs.writeFileSync(TRIP, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(TRIP_LOG)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
// stub-open.mjs is run through node: a shim, since the tool execs its `open` directly.
const OPEN_SHIM = path.join(T, 'open-shim.sh');
fs.writeFileSync(OPEN_SHIM, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'tools', 'stub-open.mjs'))} "$@"\n`, { mode: 0o755 });
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|TMUX|WEZTERM_|KITTY_|RAVENRY_|MC_|PORT$)/.test(k)));

// ------------------------------------------------------------ 1. the board's terminal

const term = await import('../server/terminal.mjs');
const yes = () => true;
const none = () => false;
const only = (p) => (x) => x === p;
const cases = [
  ['RAVENRY_TERMINAL=iterm wins inside cmux', { RAVENRY_TERMINAL: 'iterm', CMUX_SURFACE_ID: 'x' }, yes, 'iterm'],
  ['RAVENRY_TERMINAL=iTerm2 is iterm too', { RAVENRY_TERMINAL: 'iTerm2' }, yes, 'iterm'],
  ['RAVENRY_TERMINAL=cmux wins inside iTerm2', { RAVENRY_TERMINAL: 'cmux', ITERM_SESSION_ID: 'w0t0p0:x' }, yes, 'cmux'],
  ['started in a cmux tab: cmux, even with iTerm2 variables inherited', { CMUX_SURFACE_ID: 'x', ITERM_SESSION_ID: 'w0t0p0:x' }, yes, 'cmux'],
  ['started in an iTerm2 tab: iterm, even with cmux installed', { ITERM_SESSION_ID: 'w0t0p0:x', TERM_PROGRAM: 'iTerm.app' }, yes, 'iterm'],
  ['TERM_PROGRAM=iTerm.app alone: iterm', { TERM_PROGRAM: 'iTerm.app' }, yes, 'iterm'],
  ['launchd with cmux installed: cmux, as before', { HOME: '/x' }, yes, 'cmux'],
  ['launchd with only iTerm2 installed: iterm', { HOME: '/x' }, only('/Applications/iTerm.app'), 'iterm'],
  ['nothing installed: iterm, the mode that never needs its app (every session watch only)', { HOME: '/x' }, none, 'iterm'],
];
check('app: cmux installed when its CLI is there', term.appInstalled('cmux', { HOME: '/x' }, yes) === true && term.appInstalled('cmux', { HOME: '/x' }, none) === false);
check('app: iTerm2 installed when /Applications/iTerm.app is there', term.appInstalled('iterm', { HOME: '/x' }, only('/Applications/iTerm.app')) === true && term.appInstalled('iterm', { HOME: '/x' }, none) === false);
for (const [name, env, has, want] of cases) check(`mode: ${name}`, term.boardKind(env, has) === want, term.boardKind(env, has));
check('mode: this test process (inside cmux) is a cmux board, so the other suites are unchanged', term.BOARD === 'cmux' || !process.env.CMUX_SURFACE_ID);

// ------------------------------------------------------------ 2. the Ravenry tab

const TOOL_PORT = 4683; // a stand-in board listens here only once the fake terminal "starts" it
Object.assign(process.env, {
  ITERM_OSASCRIPT_BIN: FAKE_BIN, FAKE_ITERM_STATE: FAKE_IT, RAVENRY_ITERM_PROFILES: PROFILES, RAVENRY_OPEN_BIN: OPEN_SHIM, RAVENRY_ITERM_PYTHON: FAKE_BIN,
  STUB_OPEN_LOG: OPEN_LOG, RAVENRY_ITERM_WAIT_MS: '4000', PORT: String(TOOL_PORT), RAVENRY_HOME: path.join(T, 'scratch home'), RAVENRY_ITERM_BROWSER: '1', RAVENRY_ITERM_API: '1',
});
const tool = await import('./open-in-iterm.mjs');
const http = await import('node:http');
let stand = null;
const standUp = () => new Promise((r) => { stand = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"projects":[]}'); }).listen(TOOL_PORT, '::', r); });
const standDown = () => new Promise((r) => { if (!stand) return r(); stand.close(() => r()); stand.closeAllConnections(); stand = null; });
// Plays the board starting in the fake terminal: up once a start command was typed.
const typedStarts = () => Object.values(fst().keys || {}).flat().filter((x) => x.includes('npm start')).length;
async function boardStartsWhenTyped() {
  const before = typedStarts();
  for (let i = 0; i < 100; i++) {
    if (typedStarts() > before) { await standUp(); return; }
    await sleep(50);
  }
}
const OTHER = 'AAAAAAAA-1111-4222-8333-444444444444';
setFake({ running: true, profiles: [tool.pageName(TOOL_PORT)], sessions: [{ uuid: OTHER, windowId: '7', tab: 1, title: '✳ Someone else' }], screens: {} });
const cmd = tool.startCommand();
check('tab: the start command goes to this repo with PORT and the RAVENRY_/MC_ variables, quoted, test hooks left out', cmd === `cd '${ROOT}' && PORT='${TOOL_PORT}' RAVENRY_HOME='${path.join(T, 'scratch home')}' RAVENRY_ITERM_PYTHON='${FAKE_BIN}' npm start`, cmd);
check('tab: the page profile is named for the port', tool.pageName(4600) === 'Ravenry board' && tool.pageName(4602) === 'Ravenry board :4602');
let out = [];
const say = (s) => out.push(s);
let [code] = await Promise.all([tool.main([], say), boardStartsWhenTyped()]);
let st = fst();
const tagged = () => fst().sessions.filter((s) => s.vars);
const server = tagged().find((s) => s.vars['user.ravenryBoard'] === `${TOOL_PORT}:server`);
const pg = tagged().find((s) => s.vars['user.ravenryBoard'] === `${TOOL_PORT}:page`);
const prof = JSON.parse(fs.readFileSync(path.join(PROFILES, 'ravenry.json'), 'utf8'));
check('tab: a new tab whose terminal runs the start command, tagged for the port', code === 0 && st.boardOpened.length === 1 && st.boardOpened[0].page === '' && server && JSON.stringify(st.keys[server.uuid]) === JSON.stringify(['text:' + cmd, 'osa:enter']), out.join(' | '));
check('tab: once the board answers, the page goes above the terminal (Python API), same tab, terminal 8 rows', pg && pg.above === true && pg.tab === server.tab && pg.windowId === server.windowId && pg.profile === tool.pageName(TOOL_PORT) && server.rows === 8);
check('tab: the page profile is a Web Browser profile whose first page is the board', prof.Profiles.length === 1 && prof.Profiles[0]['Custom Command'] === 'Browser' && prof.Profiles[0]['Initial URL'] === `http://localhost:${TOOL_PORT}/` && prof.Profiles[0].Name === tool.pageName(TOOL_PORT));
check('tab: the page profile shows the Perch mark as its tab icon, and the image is there', prof.Profiles[0].Icon === 2 && prof.Profiles[0]['Custom Icon Path'] === tool.TAB_ICON && fs.existsSync(tool.TAB_ICON), JSON.stringify([prof.Profiles[0].Icon, prof.Profiles[0]['Custom Icon Path']]));
out = [];
code = await tool.main([], say);
st = fst();
check('tab: run again with the board up, the same tab comes forward, nothing new opens or is typed', code === 0 && st.boardOpened.length === 1 && tagged().length === 2 && st.focused.some((f) => f.startsWith('board:')) && st.keys[server.uuid].length === 2, out.join(' | '));
await standDown();
out = [];
code = await tool.main([], say);
st = fst();
check('tab: its board is down, so the start command is typed into its terminal again', code === 0 && st.boardOpened.length === 1 && st.keys[server.uuid].filter((k) => k === 'text:' + cmd).length === 2 && /started the board again/.test(out.join(' ')), out.join(' | '));
out = [];
code = await tool.main(['--close'], say);
st = fst();
check('tab: --close closes the two tagged sessions, and only them', code === 0 && st.closed.length === 2 && st.sessions.length === 1 && st.sessions[0].uuid === OTHER, out.join(' | '));
check('tab: --close takes the page profile out again', !fs.existsSync(path.join(PROFILES, 'ravenry.json')));
check('tab: the untagged tab was never focused, typed into or closed', !(st.keys || {})[OTHER] && !st.focused.includes(OTHER) && !st.closed.includes(OTHER));
// The Python API off: the page goes below, through AppleScript.
process.env.RAVENRY_ITERM_API = '0';
out = [];
[code] = await Promise.all([tool.main([], say), boardStartsWhenTyped()]);
const pg2 = tagged().find((s) => s.vars['user.ravenryBoard'] === `${TOOL_PORT}:page`);
check('tab: without the Python API the page goes below the terminal, and it says how to have it above', code === 0 && pg2 && pg2.above === false && /turn on the Python API/.test(out.join(' ')), out.join(' | '));
await tool.main(['--close'], () => {});
// A board already up (started in cmux, by launchd): only the page.
process.env.RAVENRY_ITERM_API = '1';
out = [];
code = await tool.main([], say);
st = fst();
const last = st.boardOpened[st.boardOpened.length - 1];
check('tab: a board already running gets only the page, nothing typed', code === 0 && last.page === tool.pageName(TOOL_PORT) && last.cmd === '' && tagged().length === 1 && /already running/.test(out.join(' ')), out.join(' | '));
await tool.main(['--close'], () => {});
await standDown();
// Without iTerm2's Browser Plugin: the terminal in iTerm2, the page in the default browser.
process.env.RAVENRY_ITERM_BROWSER = '0';
out = [];
[code] = await Promise.all([tool.main([], say), boardStartsWhenTyped()]);
st = fst();
check('tab: no Browser Plugin, so iTerm2 gets only the terminal (never a web page it would stop on)', code === 0 && tagged().length === 1 && tagged()[0].vars['user.ravenryBoard'].endsWith(':server') && !st.sessions.some((s) => s.profile));
check('tab: ...the page opens in the default browser, and it says why', opens().some((a) => a[0] === `http://localhost:${TOOL_PORT}/`) && out.some((l) => /Browser Plugin/.test(l) && /default browser/.test(l)), out.join(' | '));
await tool.main(['--close'], () => {});
await standDown();
process.env.RAVENRY_ITERM_BROWSER = '1';

// ------------------------------------------------------------ 3. a board in iTerm2 mode

const PORT = 4682;
const BASE = `http://127.0.0.1:${PORT}`;
const MC = path.join(T, 'mc');
const ROOTDIR = path.join(T, 'root');
const OTHERDIR = path.join(T, 'other-repo');
const CLAUDE = path.join(T, 'claude-projects');
for (const d of [MC, ROOTDIR, OTHERDIR, CLAUDE]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', OTHERDIR]);
fs.writeFileSync(path.join(OTHERDIR, 'BRIEF.md'), '# other-repo\n\nGoal: Be found.\n\n## Hand-off\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: ROOTDIR, repeatsAuto: false },
  projects: [],
}, null, 2));
const A = 'C1C1C1C1-0000-4000-8000-00000000C1C1';
const W = 100;
const RULE = '─'.repeat(W);
const atRest = `\n⏺ Done.\n\n✻ Worked for 2m 3s\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
setFake({ running: true, sessions: [{ uuid: A, windowId: '7', tty: '/dev/ttys009', title: '✳ Found work' }], screens: { [A]: atRest } });

const env = {
  ...cleanEnv, RAVENRY_TERMINAL: 'iterm', RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: TRIP, MC_CLAUDE_PROJECTS: CLAUDE, ITERM_OSASCRIPT_BIN: FAKE_BIN, RAVENRY_ITERM_PYTHON: FAKE_BIN, FAKE_ITERM_STATE: FAKE_IT,
  MC_PROJECTS_ROOT: ROOTDIR, MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'),
};
const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
const post = async (p, body) => { const res = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); let j = null; try { j = await res.json(); } catch { /* none */ } return { status: res.status, j }; };
const state = async () => (await fetch(BASE + '/api/state')).json();
async function until(cond, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const s = await state(); if (cond(s)) return s; } catch { /* starting */ }
    await sleep(100);
  }
  return null;
}
function hook(input, envx) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...cleanEnv, RAVENRY_HOME: MC, MC_BOARD_URL: BASE, ...envx } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify(input));
  });
}
const reg = () => JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));

let browser = null;
try {
  let s = await until((x) => x.generatedAt, 15000);
  check('board: the snapshot says it runs in iTerm2 mode', s && s.board && s.board.kind === 'iterm' && s.board.name === 'iTerm2' && !s.error, JSON.stringify(s && { board: s.board, error: s.error }));

  // A Claude session in an iTerm2 tab, in a folder no project holds.
  const SF = 'f1f1f1f1-0000-4000-8000-0000000000f1';
  const ienv = { ITERM_SESSION_ID: 'w0t0p0:' + A, TERM_PROGRAM: 'iTerm.app' };
  await hook({ hook_event_name: 'SessionStart', session_id: SF, cwd: OTHERDIR, source: 'startup' }, ienv);
  await hook({ hook_event_name: 'Stop', session_id: SF, cwd: OTHERDIR, last_assistant_message: 'Done.' }, ienv);
  s = await until((x) => x.projects.some((p) => p.folder === OTHERDIR && p.sessions.some((y) => y.sessionId === SF)), 10000);
  const other = s && s.projects.find((p) => p.folder === OTHERDIR);
  const os1 = other && other.sessions.find((y) => y.sessionId === SF);
  check('board: an iTerm2 session in a folder no project holds becomes a project of that folder', !!other && other.name === 'other-repo' && reg().projects.some((p) => p.folder === OTHERDIR && p.workspaces.length === 0), other ? other.id : 'none');
  check('board: ...shown as its iTerm2 tab, driven (not watch only)', os1 && os1.terminal === true && os1.term === 'iterm' && os1.surfaceId === 'iterm:' + A, JSON.stringify(os1 && { terminal: os1.terminal, term: os1.term, cannot: os1.cannot }));

  // New project: a new iTerm2 tab that goes to the folder and runs claude.
  const opened0 = (fst().opened || []).length;
  let r = await post('/api/project/new', { name: 'Fresh One', goal: 'Prove iTerm2 mode.' });
  st = fst();
  const nt = (st.opened || [])[opened0];
  const FRESH = path.join(ROOTDIR, 'fresh-one');
  check('New project: ok, and says it opened a new iTerm2 tab', r.status === 200 && /new iTerm2 tab/.test(r.j.message || ''), JSON.stringify(r.j));
  check('New project: one new iTerm2 tab, which got cd <folder> && claude <prompt>, then Enter', !!nt && JSON.stringify(st.keys[nt.uuid]) === JSON.stringify([`text:cd '${FRESH}' && claude 'Read BRIEF.md and start on the first milestone.'`, 'osa:enter']), nt ? JSON.stringify(st.keys[nt.uuid]) : 'no tab');
  check('New project: folder, brief and a registry entry with no cmux workspace', fs.existsSync(path.join(FRESH, 'BRIEF.md')) && reg().projects.some((p) => p.folder === FRESH && p.workspaces.length === 0));

  // Revive: a new tab in the window of the project's own iTerm2 session.
  r = await post('/api/project/revive', { projectId: other.id });
  st = fst();
  const rt = st.opened[st.opened.length - 1];
  check('Revive: a new iTerm2 tab in the window of the project\'s session', r.status === 200 && rt.near === A && rt.windowId === '7' && /New iTerm2 tab for other-repo/.test(r.j.message || ''), JSON.stringify({ r: r.j, rt }));
  check('Revive: it runs cd <folder> && claude \'Read BRIEF.md (Hand-off section first) and continue.\'', (st.keys[rt.uuid] || [])[0] === `text:cd '${OTHERDIR}' && claude 'Read BRIEF.md (Hand-off section first) and continue.'`, JSON.stringify(st.keys[rt.uuid]));

  // Open with no session: iTerm2's words, not cmux's.
  const fresh = (await state()).projects.find((p) => p.folder === FRESH);
  r = await post('/api/open', { projectId: fresh.id, surfaceId: null });
  check('Open: a project with no iTerm2 tab says so in iTerm2\'s words', r.status === 409 && /no open iTerm2 tab/.test(r.j.error) && !/cmux/.test(r.j.error), r.j.error);
  r = await post('/api/open', { projectId: other.id, surfaceId: 'iterm:' + A });
  check('Open: the project\'s iTerm2 tab comes forward', r.status === 200 && fst().focused.includes(A));

  // A session that runs in cmux: watch only, and why.
  const SX = 'c9c9c9c9-0000-4000-8000-0000000000c9';
  const cenv = { CMUX_SURFACE_ID: 'D1D1D1D1-0000-4000-8000-0000000000d1', CMUX_WORKSPACE_ID: 'E1E1E1E1-0000-4000-8000-0000000000e1' };
  await hook({ hook_event_name: 'SessionStart', session_id: SX, cwd: FRESH, source: 'startup' }, cenv);
  await hook({ hook_event_name: 'Stop', session_id: SX, cwd: FRESH, last_assistant_message: 'Done.' }, cenv);
  s = await until((x) => x.projects.some((p) => p.folder === FRESH && p.sessions.some((y) => y.sessionId === SX)), 10000);
  const cx = s && s.projects.find((p) => p.folder === FRESH).sessions.find((y) => y.sessionId === SX);
  check('board: a session in cmux is watch only, and says the board runs in iTerm2', cx && cx.terminal === false && /runs in cmux, and this board runs in iTerm2/.test(cx.cannot || '') && /Answer it in cmux/.test(cx.cannotType || ''), JSON.stringify(cx && { cannot: cx.cannot, cannotType: cx.cannotType }));

  // The page: iTerm2's name where it said cmux.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + '/#' + encodeURIComponent(other.id));
  await page.waitForSelector('[data-act="open"]', { timeout: 10000 });
  const ob = await page.textContent('[data-act="open"]');
  check('page: the session strip says "Open in iTerm2"', /Open in iTerm2/.test(ob), ob);
  await page.click('#new-project');
  await page.waitForSelector('#modal-form');
  const foot = await page.textContent('#m-foot');
  const go = await page.textContent('#m-go');
  check('page: New project says it opens a new iTerm2 tab, and its button "Start in iTerm2"', /a new iTerm2 tab/.test(foot) && /Start in iTerm2/.test(go) && !/cmux/.test(foot + go), `${foot} | ${go}`);

  const calls = fs.existsSync(TRIP_LOG) ? fs.readFileSync(TRIP_LOG, 'utf8').trim() : '';
  check('board: cmux was never run, not once', calls === '', calls.split('\n').slice(0, 3).join(' | '));
  check('board: no cmux error in its output', !/cmux/i.test(log), log.split('\n').filter((l) => /cmux/i.test(l)).slice(0, 2).join(' | '));
} finally {
  if (browser) await browser.close();
  srv.kill();
}

// ------------------------------------------------------------ 4. which project, and the Live card of a watch-only session

// A real board in iTerm2 mode put an Arcade session (cwd arcade-sdk, in
// the Arcade cmux workspace, its tool calls mostly in a second repo) under
// "Sandbox", a project whose folder was the projects root, and the Live
// card of every cmux session said "Not read yet". A second board on :4684
// with HOME set to a scratch folder, so the projects root is in no git repo
// as on the Mac (the repo this test runs in would otherwise hold it).
const PORT2 = 4684;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const HOME2 = path.join(T, 'home');
const ROOT2 = path.join(HOME2, 'projects');
const ANT = path.join(ROOT2, 'arcade-sdk');
const SIDE = path.join(ROOT2, 'side-repo');
const MC2 = path.join(T, 'mc2');
const CLAUDE2 = path.join(T, 'claude-projects-2');
const FAKE2 = path.join(T, 'fake-iterm-2.json');
for (const d of [ROOT2, MC2, path.join(MC2, 'briefs'), CLAUDE2]) fs.mkdirSync(d, { recursive: true });
for (const d of [ANT, SIDE]) execFileSync('git', ['init', '-q', d]);
const WS_A = 'A0A0A0A0-0000-4000-8000-0000000000a0';
const WS_L = 'B0B0B0B0-0000-4000-8000-0000000000b0';
const brief = (name) => `# ${name}\n\nGoal: Be shown in the right place.\n\n## Hand-off\n`;
for (const id of ['arcade', 'sandbox', 'idea']) fs.writeFileSync(path.join(MC2, 'briefs', id + '.md'), brief(id));
const reg2 = {
  version: 1,
  settings: { ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: ROOT2, repeatsAuto: false },
  projects: [
    { id: 'arcade', name: 'Arcade', folder: ANT, workspaces: [WS_A], brief: path.join(MC2, 'briefs', 'arcade.md'), waitingOn: null, main: true },
    // As on that Mac: imported from a cmux workspace that sat in the projects root.
    { id: 'sandbox', name: 'Sandbox', folder: ROOT2, workspaces: [WS_L], brief: path.join(MC2, 'briefs', 'sandbox.md'), waitingOn: null },
    // An idea with no repo: no folder at all.
    { id: 'idea', name: 'Idea', folder: null, workspaces: [], brief: path.join(MC2, 'briefs', 'idea.md'), waitingOn: null },
  ],
};
fs.writeFileSync(path.join(MC2, 'projects.json'), JSON.stringify(reg2, null, 2));
const reg2Now = () => JSON.parse(fs.readFileSync(path.join(MC2, 'projects.json'), 'utf8'));
// A transcript whose tool calls work mostly in `mostly`, a little in `also`.
function transcript(name, mostly, also) {
  const f = path.join(CLAUDE2, name + '.jsonl');
  const call = (file, k) => JSON.stringify({ type: 'assistant', cwd: ANT, message: { content: [{ type: 'tool_use', id: 't' + k, name: 'Read', input: { file_path: file } }] } });
  const lines = [];
  for (let k = 0; k < 9; k++) lines.push(call(path.join(mostly, `f${k}.js`), k));
  for (let k = 0; k < 2; k++) lines.push(call(path.join(also, `g${k}.js`), 20 + k));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}
const L = 'D2D2D2D2-0000-4000-8000-0000000000D2'; // an iTerm2 tab in the projects root
const M = 'D3D3D3D3-0000-4000-8000-0000000000D3'; // an iTerm2 tab in the projects root, working in side-repo
fs.writeFileSync(FAKE2, JSON.stringify({ running: true, sessions: [{ uuid: L, windowId: '9', tty: '/dev/ttys011', title: '✳ Broad topic' }, { uuid: M, windowId: '9', tty: '/dev/ttys012', title: '✳ Side work' }], screens: { [L]: atRest, [M]: atRest } }));
const env2 = {
  ...env, HOME: HOME2, GIT_CEILING_DIRECTORIES: HOME2, PORT: String(PORT2), RAVENRY_HOME: MC2, MC_CLAUDE_PROJECTS: CLAUDE2, FAKE_ITERM_STATE: FAKE2, MC_PROJECTS_ROOT: ROOT2,
};
const srv2 = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
let log2 = '';
srv2.stdout.on('data', (d) => { log2 += d; });
srv2.stderr.on('data', (d) => { log2 += d; });
const state2 = async () => (await fetch(BASE2 + '/api/state')).json();
async function until2(cond, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const x = await state2(); if (cond(x)) return x; } catch { /* starting */ }
    await sleep(100);
  }
  try { return await state2(); } catch { return null; }
}
function hook2(input, envx) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...cleanEnv, HOME: HOME2, RAVENRY_HOME: MC2, MC_BOARD_URL: BASE2, ...envx } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify(input));
  });
}
async function cmuxSession(sid, cwd, workspaceId, tp) {
  const e = { CMUX_SURFACE_ID: 'C' + sid.slice(1, 8) + '-0000-4000-8000-000000000000', CMUX_WORKSPACE_ID: workspaceId };
  await hook2({ hook_event_name: 'SessionStart', session_id: sid, cwd, source: 'startup', ...(tp ? { transcript_path: tp } : {}) }, e);
  await hook2({ hook_event_name: 'Stop', session_id: sid, cwd, last_assistant_message: 'Done.', ...(tp ? { transcript_path: tp } : {}) }, e);
}
const whereIs = (x, sid) => (x ? x.projects.filter((p) => p.sessions.some((y) => y.sessionId === sid)).map((p) => p.id) : []);
const shotsDir = process.argv[2] || null;
let browser2 = null;
try {
  await until2((x) => x.generatedAt, 15000);
  const S1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
  const S2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';
  const S3 = 'a3a3a3a3-0000-4000-8000-0000000000a3';
  const S4 = 'a4a4a4a4-0000-4000-8000-0000000000a4';
  const S5 = 'a5a5a5a5-0000-4000-8000-0000000000a5';
  const S6 = 'a6a6a6a6-0000-4000-8000-0000000000a6';
  const S7 = 'a7a7a7a7-0000-4000-8000-0000000000a7';
  const UNKNOWN_WS = 'F0F0F0F0-0000-4000-8000-0000000000f0';
  // Started in arcade-sdk, in the Arcade workspace, working mostly in a second repo no project holds.
  await cmuxSession(S1, ANT, WS_A, transcript('s1', SIDE, ANT));
  // The same, in a workspace no project lists: the cwd's own project still wins.
  await cmuxSession(S2, ANT, UNKNOWN_WS, transcript('s2', SIDE, ANT));
  // Started in the projects root, in the Arcade workspace: the workspace wins.
  await cmuxSession(S3, ROOT2, WS_A, null);
  // Started in the projects root, in Sandbox' own workspace: Sandbox, through its workspace.
  await cmuxSession(S4, ROOT2, WS_L, null);
  // Working in side-repo, in no known workspace: no project holds side-repo, and Sandbox' folder is only its parent.
  await cmuxSession(S5, SIDE, UNKNOWN_WS, transcript('s5', SIDE, SIDE));
  // iTerm2 tabs in the projects root: one working in no repo, one working in side-repo.
  await hook2({ hook_event_name: 'SessionStart', session_id: S6, cwd: ROOT2, source: 'startup' }, { ITERM_SESSION_ID: 'w0t0p0:' + L, TERM_PROGRAM: 'iTerm.app' });
  await hook2({ hook_event_name: 'Stop', session_id: S6, cwd: ROOT2, last_assistant_message: 'Done.' }, { ITERM_SESSION_ID: 'w0t0p0:' + L, TERM_PROGRAM: 'iTerm.app' });
  const t7 = transcript('s7', SIDE, SIDE);
  await hook2({ hook_event_name: 'SessionStart', session_id: S7, cwd: ROOT2, source: 'startup', transcript_path: t7 }, { ITERM_SESSION_ID: 'w0t0p0:' + M, TERM_PROGRAM: 'iTerm.app' });
  await hook2({ hook_event_name: 'Stop', session_id: S7, cwd: ROOT2, last_assistant_message: 'Done.', transcript_path: t7 }, { ITERM_SESSION_ID: 'w0t0p0:' + M, TERM_PROGRAM: 'iTerm.app' });
  const x = await until2((y) => [S1, S2, S3, S4, S6, S7].every((sid) => whereIs(y, sid).length), 12000);
  check('owner: cwd is Arcade\' exact folder, in the Arcade workspace, tool calls mostly in a second repo: Arcade', JSON.stringify(whereIs(x, S1)) === '["arcade"]', JSON.stringify(whereIs(x, S1)));
  check('owner: ...the same in a workspace no project lists: still Arcade, never the projects-root project', JSON.stringify(whereIs(x, S2)) === '["arcade"]', JSON.stringify(whereIs(x, S2)));
  check('owner: started in the projects root, in the Arcade workspace: the workspace mapping wins (Arcade)', JSON.stringify(whereIs(x, S3)) === '["arcade"]', JSON.stringify(whereIs(x, S3)));
  const s3 = x && x.projects.find((p) => p.id === 'arcade').sessions.find((y) => y.sessionId === S3);
  check('owner: ...and that session is never named after the projects root', s3 && s3.topic !== 'projects' && s3.topic === 'arcade-sdk', s3 && s3.topic);
  check('owner: a project whose folder is the projects root still gets its own workspace\'s sessions', JSON.stringify(whereIs(x, S4)) === '["sandbox"]', JSON.stringify(whereIs(x, S4)));
  check('owner: a session in a repo no project holds is never given to the parent-folder project', !whereIs(x, S5).includes('sandbox'), JSON.stringify(whereIs(x, S5)));
  const lem = x && x.projects.find((p) => p.id === 'sandbox');
  check('owner: the parent-folder project holds only its workspace\'s session', lem && lem.sessions.map((y) => y.sessionId).join() === S4, JSON.stringify(lem && lem.sessions.map((y) => y.sessionId)));
  // An iTerm2 session started in the projects root, working in no repo: a card of its own, named from its topic.
  const own6 = x && x.projects.find((p) => p.sessions.some((y) => y.sessionId === S6));
  check('loose: an iTerm2 session in the projects root with no repo gets a card named from its topic, with no folder', own6 && own6.loose === true && own6.name === 'Broad topic' && own6.folder === null, JSON.stringify(own6 && { id: own6.id, name: own6.name, folder: own6.folder, loose: own6.loose }));
  check('loose: ...shown as its iTerm2 tab, driven', own6 && own6.sessions[0].terminal === true && own6.sessions[0].surfaceId === 'iterm:' + L, JSON.stringify(own6 && own6.sessions.map((y) => ({ sid: y.sessionId, surfaceId: y.surfaceId, terminal: y.terminal, cannot: y.cannot }))));
  const own7 = whereIs(x, S7);
  const r2 = reg2Now();
  check('loose: an iTerm2 session in the projects root working in side-repo becomes a project of side-repo', own7.length === 1 && r2.projects.some((p) => p.id === own7[0] && p.folder === SIDE), JSON.stringify(own7));
  check('registry: no project was added for the projects root (no "projects" project), and nothing holds a too-broad folder new', !r2.projects.some((p) => p.folder === ROOT2 && p.id !== 'sandbox') && !r2.projects.some((p) => p.name === 'projects') && !r2.projects.some((p) => p.folder === HOME2), JSON.stringify(r2.projects.map((p) => [p.id, p.folder])));
  // The page can act on the loose card: Open brings its tab forward.
  const fs2 = () => JSON.parse(fs.readFileSync(FAKE2, 'utf8'));
  const ro = await fetch(BASE2 + '/api/open', { method: 'POST', headers: H, body: JSON.stringify({ projectId: own6 && own6.id, surfaceId: 'iterm:' + L }) });
  check('loose: Open on its card brings its iTerm2 tab forward', ro.status === 200 && (fs2().focused || []).includes(L), String(ro.status));
  // An idea with no folder: its brief still shows, and Open folder and Revive say why not.
  const idea = x && x.projects.find((p) => p.id === 'idea');
  check('no folder: a project with folder null keeps its brief (an absolute path) on the board', idea && idea.brief && idea.brief.goal === 'Be shown in the right place.' && idea.folder === null, JSON.stringify(idea && idea.brief && idea.brief.goal));
  let rr = await fetch(BASE2 + '/api/project/open-folder', { method: 'POST', headers: H, body: JSON.stringify({ projectId: 'idea' }) });
  let rj = await rr.json().catch(() => ({}));
  check('no folder: Open folder answers "Idea has no folder."', rr.status === 409 && rj.error === 'Idea has no folder.', `${rr.status} ${JSON.stringify(rj)}`);
  rr = await fetch(BASE2 + '/api/project/revive', { method: 'POST', headers: H, body: JSON.stringify({ projectId: 'idea' }) });
  rj = await rr.json().catch(() => ({}));
  check('no folder: Revive in iTerm2 mode says there is nowhere to start its session, and opens nothing', rr.status === 409 && /has no folder/.test(rj.error || '') && !(fs2().opened || []).length, `${rr.status} ${JSON.stringify(rj)}`);

  // The Live card of a watch-only session (Arcade' cmux sessions): "Watch only", never "Not read yet".
  browser2 = await chromium.launch();
  const looks = [];
  for (const [form, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser2.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: form === 'phone', hasTouch: form === 'phone', colorScheme: scheme });
      const page = await ctx.newPage();
      // Straight onto the project: the card is built on a watch-only session.
      await page.goto(`${BASE2}/?theme=${scheme}#arcade`);
      await page.waitForSelector('#lv-card [data-fresh="card"]', { state: 'attached', timeout: 10000 });
      await page.waitForTimeout(1500);
      const card = await page.evaluate(() => {
        const f = document.querySelector('#lv-card [data-fresh="card"]');
        return { fresh: f.textContent.trim(), shown: !f.hidden && getComputedStyle(f).display !== 'none', body: document.querySelector('#lv-lines').textContent.trim(), all: document.querySelector('#lv-card').textContent };
      });
      looks.push(`${form}/${scheme}: ${card.fresh}`);
      check(`live (${form}, ${scheme}): a watch-only session's card says "Watch only"`, card.fresh === 'Watch only' && card.shown, JSON.stringify(card.fresh));
      check(`live (${form}, ${scheme}): ...and its body says why, never "Not read yet" or "No read"`, /runs in cmux, and this board runs in iTerm2/.test(card.body) && !/Not read yet|No read/.test(card.all), card.body.slice(0, 120));
      if (shotsDir) {
        fs.mkdirSync(shotsDir, { recursive: true });
        await page.evaluate(() => document.querySelector('#lv-card').scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(shotsDir, `live-watch-${form}-${scheme}.png`) });
      }
      if (form === 'phone') {
        await page.click('#lv-tap');
        await page.waitForSelector('#lv-fs-bar [data-fresh="bar"]', { timeout: 5000 });
        await page.waitForTimeout(300);
        const bar = await page.evaluate(() => { const f = document.querySelector('#lv-fs-bar [data-fresh="bar"]'); return { t: f.textContent.trim(), shown: !f.hidden && getComputedStyle(f).display !== 'none', all: document.querySelector('#lv-fs').textContent }; });
        check(`live (phone full screen, ${scheme}): the bar says "Watch only", never "No read"`, bar.t === 'Watch only' && bar.shown && !/Not read yet|No read/.test(bar.all), JSON.stringify(bar.t));
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `live-watch-phone-full-${scheme}.png`) });
      }
      await ctx.close();
    }
  }
  // From a project with no session to a watch-only one and back: the card follows.
  const page = await browser2.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE2}/#idea`);
  await page.waitForSelector('#lv-card', { timeout: 10000 });
  await page.waitForTimeout(800);
  const a1 = await page.evaluate(() => ({ body: document.querySelector('#lv-lines').textContent.trim(), fresh: document.querySelector('#lv-card [data-fresh="card"]').hidden }));
  await page.evaluate(() => { location.hash = '#arcade'; });
  await page.waitForTimeout(1200);
  const a2 = await page.evaluate(() => ({ body: document.querySelector('#lv-lines').textContent.trim(), fresh: document.querySelector('#lv-card [data-fresh="card"]').textContent.trim() }));
  check('live: no session says so with no freshness line; then a watch-only session says why and "Watch only"', a1.body === 'No live session in this project.' && a1.fresh === true && /runs in cmux/.test(a2.body) && a2.fresh === 'Watch only', JSON.stringify({ a1, a2 }));

  // Unit checks of the folder rules, in a child process whose HOME is the
  // scratch home, so the projects root is in no git repo (as on the Mac).
  const unit = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const folders = await import(${JSON.stringify(path.join(ROOT, 'server', 'folders.mjs'))});
    const handoff = await import(${JSON.stringify(path.join(ROOT, 'server', 'handoff.mjs'))});
    const os = await import('node:os');
    const path = await import('node:path');
    const reg = JSON.parse(process.env.REG2);
    const R = process.env.ROOT2, H = os.homedir();
    console.log(JSON.stringify({
      home: folders.isBroadFolder(H) && folders.isBroadFolder(path.join(H, 'Documents')) && folders.isBroadFolder('/Users'),
      root: folders.isBroadFolder(R, reg.projects, R),
      holds: folders.isBroadFolder(R, reg.projects, null),
      repo: folders.isBroadFolder(process.env.ANT, reg.projects, R),
      ht: handoff.resolveHandoffFile({ cwd: R, projects: reg.projects, root: R }),
      hi: handoff.resolveHandoffFile({ projectId: 'idea', projects: reg.projects }),
    }));
  `], { env: { ...cleanEnv, HOME: HOME2, GIT_CEILING_DIRECTORIES: HOME2, RAVENRY_HOME: MC2, REG2: JSON.stringify(reg2), ROOT2, ANT }, encoding: 'utf8' }).trim().split('\n').pop());
  check('broad: home, ~/Documents, /Users and the projects root are too broad; a repo is not', unit.home && unit.root && !unit.repo, JSON.stringify(unit));
  check('broad: a folder in no repo that holds other projects\' folders is too broad, without the root being named', unit.holds);
  check('hand-off: a session in the projects root with no project writes no HANDOFF.md there', unit.ht.file === null && unit.ht.projectId === null, JSON.stringify(unit.ht));
  check('hand-off: a project with no folder hands off into its absolute brief', unit.hi.file === path.join(MC2, 'briefs', 'idea.md'), JSON.stringify(unit.hi));
  // In this process home.mjs settled when section 1 imported terminal.mjs,
  // before RAVENRY_HOME was set: on test-guard.mjs's guard home in .tmp. On
  // 2026-11-03, before that guard, it settled on the real ~/.ravenry and this
  // importWorkspaces wrote board 2's registry over the user's projects.json.
  const registry = await import('../server/registry.mjs');
  check('registry: this process writes inside .tmp only', registry.REGISTRY_PATH.startsWith(path.join(ROOT, '.tmp') + path.sep), registry.REGISTRY_PATH);
  const imp = registry.importWorkspaces({ version: 1, settings: { projectsRoot: ROOT2, autoImport: true }, projects: reg2.projects.map((p) => ({ ...p })) }, [{ id: 'E9E9E9E9-0000-4000-8000-0000000000e9', ref: 'workspace:9', title: '', surfaces: [] }], () => ROOT2);
  check('registry: a cmux workspace sitting in the projects root is imported with no folder (never the root)', imp.added.length === 1 && imp.added[0].folder === null && imp.added[0].brief === null, JSON.stringify(imp.added));
  check('board 2: no cmux call', !fs.existsSync(TRIP_LOG) || fs.readFileSync(TRIP_LOG, 'utf8').trim() === '');
  if (looks.length) console.log('looks:', looks.join(' | '));
} finally {
  if (browser2) await browser2.close();
  srv2.kill();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
