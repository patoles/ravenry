#!/usr/bin/env node
// The message box's New session switch (docs/design/NewSession.dc.html,
// variant D). A test board on :4686 with the fake cmux, whose project "Paper
// Boat" has one Claude session at its prompt and whose workspace opens new
// tabs ("newSurfaces"), driven headless in Chromium:
//
// - the switch sits right after Attach, off on every project opened;
// - off, Send types into the running session and opens nothing;
// - on, the box gets the blue ring, Send reads Start session, and Start
//   session goes through Revive (POST /api/project/revive): a new tab in the
//   project's workspace and folder whose command is `claude '<the words>'`,
//   attached files' paths appended exactly as Send appends them;
// - after starting: the switch is off, the box and its chips empty, the
//   toast says so, the selection stays on the session being watched, and the
//   new session shows in the Sessions card as Starting until its first hook
//   event; empty, it reads the brief like Revive;
// - the words reach Claude exactly (an apostrophe, a dollar sign, a leading
//   dash), a project with no brief can start one with words, and Revive with
//   no words is unchanged.
//
// A second board on :4687 in iTerm2 mode (tools/fake-iterm.mjs, a cmux
// tripwire): Start session opens a new iTerm2 tab that runs
// `cd <folder> && claude '<the words>'`.
//
// --shots <dir>: the box at 1440x900 and 390x844, dark and light, with the
// switch off, on with words, on with file chips, and after starting.
//
// --real <scratch folder>: a throwaway cmux workspace mc-test-newsession-*
// (never focused) running a real `claude` in a new folder under the scratch
// folder; its trust prompt answered through a test board on :4688's choice
// route; then the page's real Start session with "Say hi in one word", and
// the new tab's screen read back; then the workspace is closed. Only that
// workspace is read or typed into.
//
// Usage: node tools/new-session-test.mjs [--shots <dir>] [--real <scratch folder>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'new-session');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|TMUX|RAVENRY_|MC_|PORT$)/.test(k)));
// Boards keep cmux's own variables (a real board must run inside cmux);
// hooks get none, so a hook never names the tab this test runs in.
const boardEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|PORT$)/.test(k)));
const servers = [];

function registry(mc, projects) {
  fs.mkdirSync(mc, { recursive: true });
  fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({
    version: 1,
    settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'projects'), repeatsAuto: false, launchCommand: 'claude' },
    projects,
  }, null, 2));
}

async function startBoard({ port, mc, env }) {
  const e = {
    ...boardEnv, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
    MC_CLAUDE_PROJECTS: path.join(T, 'claude-' + port), MC_PROJECTS_ROOT: path.join(T, 'projects'),
    MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), ...env,
  };
  for (const [k, v] of Object.entries(e)) if (v === null) delete e[k];
  fs.mkdirSync(e.MC_CLAUDE_PROJECTS, { recursive: true });
  const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(board);
  const b = { board, base: `http://localhost:${port}`, log: '' };
  board.stdout.on('data', (d) => { b.log += d; });
  board.stderr.on('data', (d) => { b.log += d; });
  b.state = async () => (await fetch(b.base + '/api/state')).json();
  b.post = async (p, body) => { const r = await fetch(b.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  for (let i = 0; i < 60; i++) { try { const s = await b.state(); if (s.generatedAt) break; } catch { /* starting */ } await sleep(250); }
  return b;
}

fs.writeFileSync(path.join(T, 'CLAUDE.md'), '# Rules\n');
const BRIEF = '# Paper Boat\n\n## Goal\nA paper boat that floats.\n\n## Next step\nTilt the hull.\n\n## Hand-off\n';

// ------------------------------------------------------------ 1. the board on the fake cmux

const BOAT = path.join(T, 'projects', 'paper-boat');
const OTHER = path.join(T, 'projects', 'kite');
const BARE = path.join(T, 'projects', 'bare');
for (const d of [BOAT, OTHER, BARE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BOAT, 'BRIEF.md'), BRIEF);
fs.writeFileSync(path.join(OTHER, 'BRIEF.md'), BRIEF.replace(/Paper Boat/g, 'Kite'));
const MC = path.join(T, 'mc');
registry(MC, [
  { id: 'paper-boat', name: 'Paper Boat', folder: BOAT, workspaces: ['ws-boat'], brief: 'BRIEF.md' },
  { id: 'kite', name: 'Kite', folder: OTHER, workspaces: [], brief: 'BRIEF.md' },
  { id: 'bare', name: 'Bare', folder: BARE, workspaces: ['ws-bare'], brief: null },
]);
const FAKE = path.join(T, 'fake-cmux.json');
const S1 = 'AAAAAAAA-0000-4000-8000-0000000000A1';
const BODY = '\n⏺ Tilted the hull 4 degrees and ran the float test again: it holds for 40 s.\n\n✻ Worked for 1m 12s\n';
const resetFake = () => fs.writeFileSync(FAKE, JSON.stringify({
  newSurfaces: true,
  workspaces: [
    { id: 'ws-boat', ref: 'workspace:1', title: 'Paper Boat', cwd: BOAT, surfaces: [{ id: S1, ref: 'surface:1', title: '✳ Tilting the hull' }] },
    { id: 'ws-bare', ref: 'workspace:2', title: 'Bare', cwd: BARE, surfaces: [{ id: 'BBBBBBBB-0000-4000-8000-0000000000B1', ref: 'surface:2', title: '✳ Bare' }] },
  ],
  screens: {},
  prompts: { [S1]: { body: BODY }, 'BBBBBBBB-0000-4000-8000-0000000000B1': { body: BODY } },
}));
resetFake();
const fst = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
const newTabs = () => { try { return fs.readFileSync(FAKE + '.new-surface.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv); } catch { return []; } };
const optOf = (argv, k) => argv[argv.indexOf(k) + 1];
const sentIn = (id) => ((fst().prompts || {})[id] || {}).sent || [];

function hook(base, input, envx) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...cleanEnv, RAVENRY_HOME: MC, MC_BOARD_URL: base, ...envx } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify(input));
  });
}

const b = await startBoard({ port: 4686, mc: MC, env: { CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE } });
let browser = null;
try {
  let s = await b.state();
  const boat = s.projects.find((p) => p.id === 'paper-boat');
  const s1 = boat && boat.sessions.find((x) => x.surfaceId === S1);
  check('board: Paper Boat has its one Claude session, live at its prompt', !!s1 && s1.live && !s1.draft && !s1.dialog, JSON.stringify(s1 && { live: s1.live, state: s1.state }));

  // ---- the route: words and files as the first prompt, exactly
  const PNG = path.join(BOAT, '.inbox', 'end screen phone.png');
  let r = await b.post('/api/project/revive', { projectId: 'paper-boat', text: 'Fix the end screen on small phones', paths: [PNG] });
  let tabs = newTabs();
  let nt = tabs[tabs.length - 1];
  check('route: words and a file open a new tab in the project\'s workspace and folder', r.status === 200 && r.j.where === 'tab' && !!r.j.surfaceId && nt && optOf(nt, '--workspace') === 'ws-boat' && optOf(nt, '--working-directory') === BOAT && optOf(nt, '--focus') === 'false', `${r.status} ${JSON.stringify(r.j)} ${JSON.stringify(nt)}`);
  check('route: the tab runs claude with the words and the path Send would type', sentIn(r.j.surfaceId)[0] === `claude 'Fix the end screen on small phones ${PNG.replace(/ /g, '\\ ')}'`, JSON.stringify(sentIn(r.j.surfaceId)));
  check('route: the running session is not touched', !sentIn(S1).length && !(fst().keys || {})[S1], JSON.stringify((fst().keys || {})[S1]));
  const tricky = "Don't touch $HOME, it's `fine`!";
  r = await b.post('/api/project/revive', { projectId: 'paper-boat', text: tricky });
  check('route: an apostrophe, a dollar sign and backticks reach the shell as one exact word', r.status === 200 && sentIn(r.j.surfaceId)[0] === `claude 'Don'\\''t touch $HOME, it'\\''s \`fine\`!'`, JSON.stringify(sentIn(r.j.surfaceId)));
  const shell = (line) => execFileSync('/bin/sh', ['-c', line.replace(/^claude /, 'printf %s ')], { encoding: 'utf8' });
  check('route: ...and the shell gives Claude the words unchanged', shell(sentIn(r.j.surfaceId)[0]) === tricky, shell(sentIn(r.j.surfaceId)[0]));
  r = await b.post('/api/project/revive', { projectId: 'paper-boat', text: '- one\n- two' });
  check('route: words that start with a dash come after --, not read as a flag', r.status === 200 && sentIn(r.j.surfaceId)[0] === "claude -- '- one\n- two'", JSON.stringify(sentIn(r.j.surfaceId)));
  r = await b.post('/api/project/revive', { projectId: 'paper-boat' });
  check('route: no words is Revive as before: it reads the brief, Hand-off first', r.status === 200 && sentIn(r.j.surfaceId)[0] === "claude 'Read BRIEF.md (Hand-off section first) and continue.'", JSON.stringify(sentIn(r.j.surfaceId)));
  r = await b.post('/api/project/revive', { projectId: 'bare', text: 'Look around' });
  check('route: a project with no brief starts a session with words', r.status === 200 && sentIn(r.j.surfaceId)[0] === "claude 'Look around'", `${r.status} ${JSON.stringify(r.j)}`);
  const before = newTabs().length;
  r = await b.post('/api/project/revive', { projectId: 'bare' });
  check('route: ...and without words still asks for the brief first, opening nothing', r.status === 409 && /no brief yet/.test(r.j.error) && newTabs().length === before, `${r.status} ${JSON.stringify(r.j)}`);
  resetFake();

  // ---- the page
  browser = await chromium.launch({ headless: true });
  const open = async (vp, theme, hash = 'paper-boat') => {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${b.base}/?theme=${theme}#${hash}`);
    await pg.waitForSelector('#ns');
    await pg.waitForFunction(() => !document.querySelector('#send').disabled);
    return { ctx, pg, errs };
  };
  const box = (pg) => pg.evaluate(() => {
    const ns = document.querySelector('#ns');
    return {
      afterAttach: document.querySelector('#composer .attach').nextElementSibling === ns,
      role: ns.getAttribute('role'), checked: ns.getAttribute('aria-checked'), on: ns.classList.contains('on'),
      ring: document.querySelector('#composer').classList.contains('ns-mode'),
      send: document.querySelector('#send').textContent, ph: document.querySelector('#compose').placeholder,
      text: document.querySelector('#compose').value, chips: document.querySelectorAll('#chips .chip').length,
      sel: (document.querySelector('#d-sessions .sess.sel') || {}).dataset?.surface || null,
      rows: [...document.querySelectorAll('#d-sessions .sess')].map((x) => ({ surface: x.dataset.surface || null, text: x.textContent.replace(/\s+/g, ' ').trim(), button: x.tagName === 'BUTTON' })),
      dashed: [...document.querySelectorAll('#d-sessions .sess circle')].some((c) => c.getAttribute('stroke-dasharray') === '2.2 2'),
      toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent,
    };
  });

  {
    const { ctx, pg, errs } = await open({ width: 1440, height: 900 }, 'dark');
    let x = await box(pg);
    check('page: the switch sits right after Attach, a switch, off', x.afterAttach && x.role === 'switch' && x.checked === 'false' && !x.on && !x.ring && x.send === 'Send', JSON.stringify(x));
    // Off: Send goes to the running session.
    await pg.fill('#compose', 'hello from the board');
    await pg.click('#send');
    await pg.waitForFunction(() => !document.querySelector('#toast').hidden);
    await sleep(300);
    check('page: switch off, Send types into the running session and opens no tab', sentIn(S1)[0] === 'hello from the board' && newTabs().length === before, JSON.stringify({ sent: sentIn(S1), tabs: newTabs().length - before }));
    await sleep(1200);
    // On: the ring, Start session, the placeholder.
    await pg.click('#ns');
    x = await box(pg);
    check('page: switch on, the box gets the blue ring and Send reads Start session', x.checked === 'true' && x.on && x.ring && x.send === 'Start session' && x.ph === 'First message of the new session, optional', JSON.stringify(x));
    // Files go with the first message.
    const f1 = path.join(T, 'end-screen-phone.png');
    const f2 = path.join(T, 'end screen small.png');
    fs.writeFileSync(f1, 'not really a png\n');
    fs.writeFileSync(f2, 'not really a png either\n');
    await pg.setInputFiles('#pick', [f1, f2]);
    await pg.waitForFunction(() => document.querySelectorAll('#chips .chip').length === 2 && !/Saving/.test(document.querySelector('#chips').textContent));
    const paths = await pg.evaluate(() => [...document.querySelectorAll('#chips .chip')].map((c) => c.firstChild.textContent));
    await pg.fill('#compose', 'Fix the end screen on small phones');
    const n0 = newTabs().length;
    await pg.click('#send');
    await pg.waitForFunction(() => /Started a new session/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden);
    x = await box(pg);
    const tab = newTabs()[n0];
    const newId = fst().workspaces[0].surfaces[1] && fst().workspaces[0].surfaces[1].id;
    const abs = (p) => p.replace(/^~(?=\/)/, os.homedir());
    const want = `claude 'Fix the end screen on small phones ${paths.map((p) => abs(p).replace(/ /g, '\\ ')).join(' ')}'`;
    check('page: switch on, Start session opens one new tab in the project\'s workspace and folder', newTabs().length === n0 + 1 && optOf(tab, '--workspace') === 'ws-boat' && optOf(tab, '--working-directory') === BOAT && !!newId, JSON.stringify(tab));
    check('page: the files go with the first message, the paths Send would type', newId && sentIn(newId)[0] === want, JSON.stringify({ got: newId && sentIn(newId), want }));
    check('page: ...and nothing was sent to the running session', sentIn(S1).length === 1, JSON.stringify(sentIn(S1)));
    check('page: after starting, the toast says so with the first message', x.toast === 'Started a new session in Paper Boat with your first message', x.toast);
    check('page: after starting, the switch is off, the box and its chips are empty', x.checked === 'false' && !x.on && !x.ring && x.send === 'Send' && x.text === '' && x.chips === 0, JSON.stringify(x));
    await pg.waitForFunction(() => document.querySelectorAll('#d-sessions .sess').length === 2, null, { timeout: 8000 }).catch(() => {});
    x = await box(pg);
    check('page: the new session shows in the Sessions card as Starting, a dashed blue ring', x.rows.length === 2 && x.rows.some((y) => /Fix the end screen on small phones\s*Starting/.test(y.text)) && x.dashed, JSON.stringify(x.rows));
    check('page: the selection stays on the session being watched', x.sel === S1, x.sel);
    // Its first hook event: the row reads like any other.
    await hook(b.base, { hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-555555555555', cwd: BOAT, source: 'startup' }, { CMUX_WORKSPACE_ID: 'ws-boat', CMUX_SURFACE_ID: newId });
    await hook(b.base, { hook_event_name: 'UserPromptSubmit', session_id: '11111111-2222-4333-8444-555555555555', cwd: BOAT, prompt: 'Fix the end screen on small phones' }, { CMUX_WORKSPACE_ID: 'ws-boat', CMUX_SURFACE_ID: newId });
    await pg.waitForFunction((id) => { const r = document.querySelector(`#d-sessions .sess[data-surface="${id}"]`); return r && !/Starting/.test(r.textContent); }, newId, { timeout: 10000 }).catch(() => {});
    x = await box(pg);
    const row = x.rows.find((y) => y.surface === newId);
    check('page: after its first hook event the new row is a session like any other, still not selected', !!row && row.button && !/Starting/.test(row.text) && x.sel === S1, JSON.stringify(x.rows));
    // Empty: it reads the brief.
    await sleep(3400);
    await pg.click('#ns');
    const n1 = newTabs().length;
    await pg.click('#send');
    await pg.waitForFunction(() => /reading the brief/.test(document.querySelector('#toast').textContent));
    x = await box(pg);
    const id2 = fst().workspaces[0].surfaces[2] && fst().workspaces[0].surfaces[2].id;
    check('page: empty, Start session starts the way Revive does', newTabs().length === n1 + 1 && id2 && sentIn(id2)[0] === "claude 'Read BRIEF.md (Hand-off section first) and continue.'" && x.toast === 'Started a new session in Paper Boat reading the brief' && x.checked === 'false', JSON.stringify({ sent: id2 && sentIn(id2), toast: x.toast }));
    // Never persists: on, open another project, come back.
    await pg.click('#ns');
    await pg.evaluate(() => { location.hash = '#kite'; });
    await pg.waitForFunction(() => /Kite/.test(document.querySelector('#d-head').textContent));
    let k = await box(pg);
    await pg.evaluate(() => { location.hash = '#paper-boat'; });
    await pg.waitForFunction(() => /Paper Boat/.test(document.querySelector('#d-head').textContent));
    x = await box(pg);
    check('page: the switch is off on every project opened, never kept', k.checked === 'false' && x.checked === 'false' && !x.ring && x.send === 'Send', JSON.stringify({ kite: k.checked, boat: x.checked }));
    await ctx.close();
    const { ctx: c2, pg: p2 } = await open({ width: 1440, height: 900 }, 'dark');
    k = await box(p2);
    check('page: a reload starts with the switch off', k.checked === 'false', k.checked);
    await c2.close();
    check('page: no page errors', !errs.length, errs.join(' | '));
  }

  // ---- phone: Attach and the switch on the first row, Add as note and Send on the second, at the right
  {
    resetFake();
    await sleep(2500);
    const { ctx, pg } = await open({ width: 390, height: 844 }, 'dark');
    const geo = await pg.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const c = r('#composer');
      return { attach: r('#composer .attach'), ns: r('#ns'), note: r('#note'), send: r('#send'), right: c.right, sw: document.documentElement.scrollWidth, w: innerWidth };
    });
    const row1 = Math.abs(geo.attach.top - geo.ns.top) < 4;
    const row2 = Math.abs(geo.note.top - geo.send.top) < 4 && geo.note.top > geo.ns.bottom - 2;
    check('phone: Attach and the switch share the first row', row1, JSON.stringify({ attach: geo.attach.top, ns: geo.ns.top }));
    check('phone: Add as note and Send wrap to a second row, at the right', row2 && geo.send.right > geo.right - 16 && geo.note.left > geo.ns.left, JSON.stringify({ note: [geo.note.left, geo.note.top], send: [geo.send.right, geo.send.top], right: geo.right }));
    check('phone: nothing scrolls sideways', geo.sw <= geo.w, `${geo.sw} > ${geo.w}`);
    await pg.click('#ns');
    const geo2 = await pg.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { ns: r('#ns').top, note: r('#note').top, send: r('#send').top, sendText: document.querySelector('#send').textContent }; });
    check('phone: on, the rows hold and Send reads Start session', geo2.sendText === 'Start session' && Math.abs(geo2.note - geo2.send) < 4 && geo2.note > geo2.ns, JSON.stringify(geo2));
    await ctx.close();
  }

  // ---- shots
  if (SHOTS) {
    const f1 = path.join(T, 'end-screen-phone.png');
    const f2 = path.join(T, 'end-screen-small.png');
    fs.writeFileSync(f2, 'x\n');
    for (const [tag, vp, off] of [['desk', { width: 1440, height: 900 }, 12], ['phone', { width: 390, height: 844 }, 70]]) {
      for (const theme of ['dark', 'light']) {
        resetFake();
        await sleep(2600);
        const { ctx, pg } = await open(vp, theme);
        // Unfocused, as the mockup's frames are.
        const at = async () => { await pg.evaluate((o) => { if (document.activeElement) document.activeElement.blur(); const el = document.querySelector('#d-ask'); scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - o)); }, tag === 'desk' ? 0 : off); await sleep(150); };
        await at();
        await pg.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-1-off.png`) });
        await pg.click('#ns');
        await pg.fill('#compose', 'Fix the end screen on small phones');
        await pg.mouse.move(0, 0);
        await at();
        await pg.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-2-on.png`) });
        await pg.setInputFiles('#pick', [f1, f2]);
        await pg.waitForFunction(() => document.querySelectorAll('#chips .chip').length === 2 && !/Saving/.test(document.querySelector('#chips').textContent));
        await at();
        await pg.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-2b-files.png`) });
        await pg.click('#send');
        await pg.waitForFunction(() => /Started a new session/.test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden);
        await pg.waitForFunction(() => document.querySelectorAll('#d-sessions .sess').length === 2, null, { timeout: 8000 }).catch(() => {});
        await pg.mouse.move(0, 0);
        await pg.evaluate((o) => { const el = document.querySelector('#d-ask'); scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - o)); }, off);
        await sleep(150);
        await pg.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-3-started.png`) });
        await ctx.close();
      }
    }
    // The mockup's D frames, for comparing.
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
      const pg = await ctx.newPage();
      await pg.goto(`file://${path.join(ROOT, 'docs/design/NewSession.dc.html')}?theme=${theme}`);
      await sleep(1200);
      const sec = await pg.$('#vD');
      if (sec) await sec.screenshot({ path: path.join(SHOTS, `mockup-D-${theme}.png`) });
      await ctx.close();
    }
    console.log('shots in', SHOTS);
  }
} catch (err) {
  console.error(err);
  fails++;
} finally {
  if (browser) await browser.close();
  b.board.kill();
}

// ------------------------------------------------------------ 2. a board in iTerm2 mode

{
  const FAKE_IT = path.join(T, 'fake-iterm.json');
  const FAKE_BIN = path.join(ROOT, 'tools', 'fake-iterm.mjs');
  const TRIP = path.join(T, 'cmux-tripwire.mjs');
  const TRIP_LOG = path.join(T, 'cmux-calls.log');
  fs.writeFileSync(TRIP, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(TRIP_LOG)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
  fs.writeFileSync(FAKE_IT, JSON.stringify({ running: true, sessions: [], screens: {} }));
  const MI = path.join(T, 'mc-iterm');
  registry(MI, [{ id: 'paper-boat', name: 'Paper Boat', folder: BOAT, workspaces: [], brief: 'BRIEF.md' }]);
  const bi = await startBoard({ port: 4687, mc: MI, env: { RAVENRY_TERMINAL: 'iterm', CMUX_BIN: TRIP, ITERM_OSASCRIPT_BIN: FAKE_BIN, RAVENRY_ITERM_PYTHON: FAKE_BIN, FAKE_ITERM_STATE: FAKE_IT, MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs') } });
  try {
    const r = await bi.post('/api/project/revive', { projectId: 'paper-boat', text: "Say hi, it's a test", paths: ['/tmp/a b.png'] });
    const st = JSON.parse(fs.readFileSync(FAKE_IT, 'utf8'));
    const t = (st.opened || [])[0];
    check('iTerm2: Start session opens a new iTerm2 tab that goes to the folder and runs claude with the words and the path', r.status === 200 && !!t && (st.keys[t.uuid] || [])[0] === `text:cd '${BOAT}' && claude 'Say hi, it'\\''s a test /tmp/a\\ b.png'`, JSON.stringify({ r: r.j, keys: t && st.keys[t.uuid] }));
    check('iTerm2: cmux is never asked', !fs.existsSync(TRIP_LOG), fs.existsSync(TRIP_LOG) ? fs.readFileSync(TRIP_LOG, 'utf8') : '');
  } catch (err) {
    console.error(err);
    fails++;
  } finally {
    bi.board.kill();
  }
}

// ------------------------------------------------------------ 3. a real Claude Code

const ri = process.argv.indexOf('--real');
if (ri >= 0) {
  const { parseScreen } = await import('../server/screen.mjs');
  const { readMenu } = await import('../server/choose.mjs');
  const CMUX = process.env.CMUX_BIN_REAL || '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cm = (args, json) => {
    const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...args] : args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
    return json ? JSON.parse(out) : out;
  };
  const tree = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const name = 'mc-test-newsession-' + stamp;
  const dir = path.join(path.resolve(process.argv[ri + 1] || '.'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), '# Scratch\n\n## Goal\nA throwaway folder for the New session check.\n\n## Hand-off\n');
  let ws = null;
  let rb = null;
  let rbrowser = null;
  try {
    cm(['new-workspace', '--name', name, '--focus', 'false', '--cwd', dir, '--command', 'claude']);
    for (let k = 0; k < 40 && !ws; k++) { await sleep(250); ws = tree().find((w) => w.title === name) || null; }
    if (!ws) throw new Error('the scratch workspace did not appear');
    const sf = ws.panes.flatMap((p) => p.surfaces)[0];
    const read = (id) => cm(['read-screen', '--workspace', ws.id, '--surface', id, '--lines', '40']);
    let menu = null;
    for (let k = 0; k < 60 && !menu; k++) { await sleep(500); menu = readMenu(read(sf.id)); }
    const RMC = path.join(T, 'mc-real');
    registry(RMC, [{ id: name, name: 'Scratch', folder: dir, workspaces: [ws.id], brief: 'BRIEF.md' }]);
    rb = await startBoard({ port: 4688, mc: RMC, env: { MC_NO_EVENTS: null } });
    if (menu) {
      const k = menu.options.findIndex((o) => /Yes, I trust/.test(o.label));
      const res = await rb.post('/api/send', { projectId: name, surfaceId: sf.id, choice: k + 1 });
      check('real: the first tab\'s folder-trust prompt answered through the board', res.status === 200, `${res.status} ${JSON.stringify(res.j)}`);
    }
    let live = false;
    for (let k = 0; k < 40 && !live; k++) { await sleep(500); const ps = parseScreen(read(sf.id)); live = ps.claudeLive && !ps.dialog; }
    check('real: the first tab is a live Claude session at its prompt', live);
    for (let k = 0; k < 20; k++) { const st = await rb.state(); const p = st.projects.find((x) => x.id === name); if (p && p.sessions.some((x) => x.surfaceId === sf.id && x.live)) break; await sleep(500); }
    // The page's real Start session.
    rbrowser = await chromium.launch({ headless: true });
    const pg = await (await rbrowser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await pg.goto(`${rb.base}/#${name}`);
    await pg.waitForSelector('#ns');
    await pg.click('#ns');
    await pg.fill('#compose', 'Say hi in one word');
    await pg.click('#send');
    await pg.waitForFunction(() => /Started a new session|could not|did not/i.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
    const toastText = await pg.textContent('#toast');
    check('real: the toast says the session started with the first message', toastText === 'Started a new session in Scratch with your first message', toastText);
    const after = tree().find((w) => w.id === ws.id);
    const tabs = after.panes.flatMap((p) => p.surfaces).filter((x) => x.id !== sf.id);
    check('real: one new tab in the scratch workspace', tabs.length === 1, JSON.stringify(tabs.map((x) => x.ref)));
    let scr = '';
    for (let k = 0; k < 60; k++) { await sleep(1000); scr = read(tabs[0].id); if (/❯ Say hi in one word/.test(scr) && /⏺ /.test(scr.split('❯ Say hi in one word').pop())) break; }
    fs.writeFileSync(path.join(T, 'real-new-tab.txt'), scr);
    const sid = (await rb.state()).projects.find((x) => x.id === name).sessions.find((x) => x.surfaceId === tabs[0].id);
    check('real: the new tab runs in the scratch folder', /mc-test-newsession-/.test(scr) || (sid && sid.workFolder && sid.workFolder.includes(name)), sid ? sid.workFolder : 'no session');
    check('real: Claude received the message exactly and answered', /❯ Say hi in one word\s*$/m.test(scr) && /⏺ /.test(scr.split('❯ Say hi in one word').pop()), scr.split('\n').filter((l) => l.trim()).slice(-8).join(' / '));
    check('real: the first session was not typed into', !/Say hi in one word/.test(read(sf.id)));
    console.log('\n--- the new tab ---\n' + scr.split('\n').filter((l) => l.trim()).slice(-14).join('\n') + '\n');
  } catch (err) {
    console.error(err);
    fails++;
  } finally {
    if (rbrowser) await rbrowser.close();
    if (rb) rb.board.kill();
    if (ws) { try { cm(['close-workspace', '--workspace', ws.id]); console.log('closed scratch workspace', ws.id); } catch (e) { console.log('could not close', ws.id, e.message); } }
    check('real: the scratch workspace is closed', ws && !tree().some((w) => w.id === ws.id));
  }
}

for (const s of servers) { try { s.kill(); } catch { /* gone */ } }
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
