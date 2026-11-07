#!/usr/bin/env node
// The release check: the packaged app run as a Mac runs it, before any build
// is called ready. On 2026-11-07 three builds passed CI and failed at once
// on the person's Mac: "You should have tested those before telling me its
// ready".
//
//   node tools/release-check.mjs APP [--driven TWIN] [--prev OLD_APP_OR_ZIP] [OUT]
//
// APP is the new Ravenry.app (release/mac-arm64/Ravenry.app); OLD is the
// build before it (an .app, or its release zip), for the update step.
//
// A release build takes no driver (src/main/gate.ts): nothing outside it
// can script its window. So the release itself is checked as it is, with
// no driver (step 0, tools/package-check.mjs, and steps 12 and 13), and the
// steps that look into the window and click in it run on its test twin,
// TWIN (default: release-test/mac-arm64/Ravenry.app beside release/, which
// `npm run pack` makes): the same stage, the same build.json, ravenryd and
// hub, with the test hooks on. Step 0 checks that it is that twin.
// Everything runs in throwaway HOMEs under the system's temporary folder
// (outside ~/Documents, which macOS guards), on spare ports, offscreen; the
// daemons' folder has a space in its path, as ~/Library/Application
// Support/Ravenry/run has. The app's hub service is loaded into the REAL
// launchd under a label of the check's own, dev.ravenry.hub.test-<random>
// (never dev.ravenry.hub), and booted out at the end, whatever happens.
// ps, lsof, cmux and `open` are stand-ins, and `claude` is a stand-in in
// the throwaway HOME's ~/.local/bin.
//
// Each step asserts on what the window shows:
//   0 release       tools/package-check.mjs on APP: a release build, its
//                   fuses, its own ravenryd started and a shell opened in
//                   it with no driver; it runs nothing an agent's launch
//                   names (RAVENRY_DRIVER, RAVENRYD, RAVENRY_LAUNCHCTL,
//                   NODE_OPTIONS) and quits on --remote-debugging-port and
//                   --inspect; DYLD_INSERT_LIBRARIES loads nothing; its
//                   hub answers as its service says, and SIGUSR1 opens
//                   no inspector in it. And
//                   TWIN is APP's twin (same build.json, ravenryd, hub)
//   1-11            on TWIN, as the window shows them:
//   1 cold launch   the service is installed and loaded, its hub answers,
//                   the daemon runs; a shell prompt is in the window within
//                   2 s; `echo ok` typed in it reads back
//   2 new session   New session starts the stand-in Claude in a pane, and
//                   the window shows it
//   3 outside       a session in cmux (the stand-in) shows live; its process
//                   ends there; Move here resumes it in a pane and the
//                   window shows `claude --resume <id>` running
//   4 reopen        quit and reopen: the shells come back with what they
//                   showed, and a prompt is in the window within 2 s
//   5 update        the build before runs as the service; the new app
//                   launched leaves exactly one hub, answering, on the new
//                   version; the old folder is kept until it answers; a
//                   prompt is in the window within 2 s
//   7 old panes     (in 5) a session in a pane of the build before's daemon,
//                   also running in cmux: one row, its pane opens on a
//                   click, and it says Also open in cmux
//   6 npm switch    tools/npm-switch-test.mjs: from the npm board 0.4.0 and
//                   the way back
//   8 hooks         (in 5) the hooks of a session started on the build
//                   before still run after the update removed its folder
//   9 move here     stand-in Claudes with real pids and real hooks: still
//                   open in cmux and idle, Move here ends it and resumes it
//                   here; mid-turn, it waits for the turn to end; a pane
//                   whose conversation went on in cmux, Move here resumes
//                   the latest in the same pane; open in both, Keep it in
//                   cmux ends the Ravenry copy. Each time exactly one
//                   process remains and the pane shows the latest turn.
//                   Each state shot dark and light.
//   10 strip        (in 9) two sessions and two shells are tabs, an agent's
//                   pane a split beside its shell (0.1.18); before, it was
//                   tabs, the agent's right after the shell it came from;
//                   clicking through each keeps every tab, in order, and
//                   the row, the panel and the tab agree; shot dark, light
//   11 keys         tools/keys-test.mjs on the packaged app: every row of
//                   the keys table arrives as its exact bytes
//   12 startup      hub/tools/startup-load-test.mjs on the packaged hub: on
//                   a big made-up set of projects and sessions, its first
//                   answer within 1 s of its listen line, no answer over 1 s
//                   in its first 30 s; with a 70 MB transcript of 200 task
//                   launches and 761 hook reports for it in the daemon's
//                   ring, its first state within 3 s, its main thread never
//                   held over 200 ms, that session's running tasks right
//   13 pane start   tools/relaunch-check.mjs on a copy: started with a
//                   pane's variables it relaunches clean; opened with
//                   open -n -a in the foreground, exactly one instance is
//                   left, with none of RAVENRY_PANE, RAVENRY_SOCKET,
//                   TERM_PROGRAM
//   14 basics       tools/basics-test.mjs on the test twin, a row each: the
//                   scroll position kept across tab switches, Cmd+click on
//                   links (OSC 8 and plain URLs, http, https and file only),
//                   terminal-only zoom kept across a relaunch, a dropped
//                   file's quoted path, the window's size kept, Cmd+Home/End
//   16 splits       tools/split-test.mjs on the test twin, a row each: split,
//                   focus, resize, zoom, close, drag to split, an agent's
//                   pane split without the keyboard, back after a relaunch
//                   (an update relaunches with the same window.json)
//   17 features     tools/features-test.mjs on the test twin, a row each:
//                   Find, the right-click menu, closing a busy shell, the
//                   bells, new windows, the settings applied
//   15 brief        tools/brief-test.mjs on the test twin, a row each: the
//                   panel's Brief card (goal on one line, Next as 3 items,
//                   the older entries counted) and the Brief page (the
//                   dated entries newest first, the plan, Edit, links)
//   env             every app the check launched ran with a clean environment
// Writes OUT/release-check.json (each step, pass or fail, its times) and
// pictures of each step.
import { guardSpawns, withStubMachine, reapStarted } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, appEnvs } from './run-app.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', '..', '..', 'hub');
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const PREV = flag('--prev');
const DRIVEN_ARG = flag('--driven');
const NO_NPM = argv.includes('--no-npm') ? (argv.splice(argv.indexOf('--no-npm'), 1), true) : false;
// --only 9,5: just those steps (a quick run while working on them; never the release gate).
const ONLY = argv.includes('--only') ? argv.splice(argv.indexOf('--only'), 2)[1].split(',') : null;
const APP_PATH = argv[0] && path.resolve(argv[0]);
if (!APP_PATH || !fs.existsSync(path.join(APP_PATH, 'Contents', 'MacOS', 'Ravenry'))) { console.error('usage: node tools/release-check.mjs APP [--prev OLD_APP_OR_ZIP] [--no-npm] [OUT]'); process.exit(2); }
if (process.platform !== 'darwin') { console.error('release-check: macOS only (launchd)'); process.exit(2); }
const OUT = path.resolve(argv[1] || path.join(HERE, '..', '.tmp', 'release-check'));
fs.mkdirSync(OUT, { recursive: true });
const BUILD = JSON.parse(fs.readFileSync(path.join(APP_PATH, 'Contents', 'Resources', 'build.json'), 'utf8'));
// The test twin the window steps drive (scripts/pack.mjs, release-test/).
const DRIVEN = path.resolve(DRIVEN_ARG || APP_PATH.replace(`${path.sep}release${path.sep}`, `${path.sep}release-test${path.sep}`));
const UID = process.getuid();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = 'window.__ravenry';
const results = { app: APP_PATH, driven: DRIVEN, build: BUILD, at: new Date().toISOString(), steps: [] };
const labels = [];

// A throwaway Mac account: its own HOME, data folder, runtime folder (with
// a space), port, launchd label, and the stand-ins.
async function account(name, source = DRIVEN) {
  // A short folder name: a daemon's socket path has 103 bytes at most on
  // macOS, and "<tmp>/rvrc-update-XXXXXX/App Support/run/ravenryd-0.1.10.sock"
  // was 105.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rvc${name[0]}-`));
  const home = path.join(root, 'h');
  const data = path.join(home, 'Library', 'Application Support', 'Ravenry');
  const rt = path.join(root, 'App Support', 'run');
  for (const d of [data, rt, path.join(home, '.ravenry', 'events'), path.join(home, '.local', 'bin'), path.join(home, 'Projects')]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(rt, 0o700);
  // The app copied out of the build folder, as it sits in /Applications:
  // run from inside ~/Documents, the service would wait for macOS's
  // privacy answer to read its own files.
  const app = path.join(root, 'Applications', 'Ravenry.app');
  execFileSync('/usr/bin/ditto', [source, app]);
  const label = `dev.ravenry.hub.test-${crypto.randomBytes(5).toString('hex')}`;
  labels.push(label);
  const port = await freePort();
  // The stand-in Claude (tools/stand-in-claude.mjs): a real process that
  // says how it was started, lists itself in the stub process list, runs
  // the account's hooks and writes its transcript.
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), `#!${process.execPath}\n` + fs.readFileSync(path.join(HERE, 'stand-in-claude.mjs'), 'utf8'), { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'you@example.com' } }));
  // The stand-ins copied out of the repository: a service launchd starts
  // that ran a script inside ~/Documents would wait for macOS's privacy
  // answer (and ask on the person's screen).
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const f of ['stub-ps.mjs', 'fake-cmux.mjs', 'stub-open.mjs']) { fs.copyFileSync(path.join(HUB, 'tools', f), path.join(bin, f)); fs.chmodSync(path.join(bin, f), 0o755); }
  const ps = path.join(root, 'stub-ps.json');
  fs.writeFileSync(ps, '[]');
  const fake = path.join(root, 'fake-cmux.json');
  fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
  const env = withStubMachine({
    HOME: home, PATH: `${path.dirname(process.execPath)}:${path.join(home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: data, RAVENRY_HUB_URL: `http://127.0.0.1:${port}`, PORT: String(port), RAVENRY_PHONE_PORT: String(await freePort()),
    RAVENRY_SERVICE: 'install', RAVENRY_SERVICE_LABEL: label, RAVENRY_UPDATES: '0',
    MC_PS_BIN: path.join(bin, 'stub-ps.mjs'), MC_LSOF_BIN: path.join(bin, 'stub-ps.mjs'), STUB_PS_STATE: ps,
    CMUX_BIN: path.join(bin, 'fake-cmux.mjs'), FAKE_CMUX_STATE: fake, MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(bin, 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(root, 'open.jsonl'),
    MC_CODEX: '0', MC_PHONE_LAN: 'none', MC_REPEATS_AUTO: '0',
  });
  return { name, root, home, data, rt, label, port, ps, fake, env, exe: path.join(app, 'Contents', 'MacOS', 'Ravenry'), work: path.join(root, 'work') };
}

const launchctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const loaded = (label) => launchctl('print', `gui/${UID}/${label}`).status === 0;
const plistOf = (a) => path.join(a.home, 'Library', 'LaunchAgents', `${a.label}.plist`);
async function hubAnswers(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return await r.json(); } catch { /* not yet */ } await sleep(200); }
  return null;
}
const listeners = (port) => { try { return execFileSync('/usr/sbin/lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); } catch { return []; } };
const programOf = (label) => (launchctl('print', `gui/${UID}/${label}`).stdout.match(/^\s*program = (.*)$/m) || [])[1] || '';
const argsOf = (label) => launchctl('print', `gui/${UID}/${label}`).stdout;

// One run of the app: the steps given, then quit. Returns the window's marks.
async function launch(a, name, steps, more = {}) {
  fs.mkdirSync(a.work, { recursive: true });
  const marks = path.join(a.work, `${name}-marks.json`);
  const t0 = Date.now();
  await runApp({ name, work: a.work, rt: a.rt, exe: a.exe, home: a.home, hubUrl: a.env.RAVENRY_HUB_URL, timeoutMs: 240000, env: { ...a.env, ...more }, steps: [
    { js: '(window.__marks = window.__marks || {}, true)' },
    ...steps,
    { save: { expr: 'window.__marks', out: marks } },
  ] });
  const m = JSON.parse(fs.readFileSync(marks, 'utf8'));
  return { ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' && v > 1e12 ? v - t0 : v])), t0 };
}
const mark = (k) => ({ js: `window.__marks[${JSON.stringify(k)}] = Date.now()` });
const save = (k, expr) => ({ js: `window.__marks[${JSON.stringify(k)}] = (${expr})` });
const shot = (f) => ({ shot: path.join(OUT, f), settle: 300 });
// A shell's prompt in the window, attached to the tab in front, and no
// toast saying it failed.
const PROMPT = `${R}.term().ready && ${R}.term().attached && ${R}.S.tabs.some((t) => t.kind === 'shell') && /[%$#] *$/m.test(${R}.text())`;
// The highlighted row, the panel and the tab in front name the same thing
// (a plain shell in front: no row highlighted). Checked after every step.
const AGREE = `(() => { const on = document.querySelector('#tabs .tab.on'); const sel = document.querySelector('#side .ss.sel'); const p = document.getElementById('panel'); const front = on ? on.dataset.key : null; const row = sel ? sel.dataset.key : null; const panel = p.hidden ? null : p.dataset.key; const session = !!front && !front.startsWith('tab:') && !front.startsWith('pane:'); return (session ? row === front || (row === null && ![...document.querySelectorAll('#side .ss')].some((e) => e.dataset.key === front)) : row === null) && (panel === null || (panel === front && (!session || ['session', 'off-board'].includes(p.dataset.shows)))); })()`;
const agree = (k) => [{ until: AGREE, timeout: 8000 }, mark(`agree_${k}`)];
const NO_FAIL_TOAST = `(document.getElementById('toast').hidden || !/Could not|no running daemon|no daemon answered/.test(document.getElementById('toast').textContent))`;

function step(name, ok, detail = {}) {
  results.steps.push({ name, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
}
async function guarded(name, fn) {
  if (ONLY && !ONLY.some((n) => name.startsWith(n + ' '))) return;
  try { await fn(); } catch (e) {
    const lines = String(e.message || e).split('\n');
    step(name, false, { error: [lines[0], ...lines.filter((l) => /driver: |Error/.test(l)).slice(0, 4), ...lines.filter((l) => l.startsWith('window:')).slice(-8)].join(' | ') });
  }
}

// The made-up session in cmux the outside step shows.
const SID = '5e55107e-0000-4000-8000-0000000000aa';
const WS = 'AAAA1111-0000-4000-8000-0000000000AA';
const SF = 'BBBB2222-0000-4000-8000-0000000000BB';
function outsideSession(a) {
  const proj = path.join(a.home, 'Projects', 'kite');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'BRIEF.md'), '# Kite\n\nGoal: A kite that flies itself.\n\n## Next step\nMake the tail flutter.\n');
  // A project is a git repository (a second session there gets a worktree).
  const git = (...g) => execFileSync('/usr/bin/git', ['-C', proj, '-c', 'user.name=Check', '-c', 'user.email=check@example.com', ...g], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Start');
  fs.writeFileSync(path.join(a.home, '.ravenry', 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: proj, workspaces: [WS], brief: 'BRIEF.md' }] }, null, 2));
  const at = (m) => new Date(Date.now() - m * 60000).toISOString();
  const TR = path.join(a.home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9-]/g, '-'), SID + '.jsonl');
  fs.mkdirSync(path.dirname(TR), { recursive: true });
  const rec = (type, extra, t) => JSON.stringify({ type, cwd: proj, sessionId: SID, timestamp: t, ...extra });
  fs.writeFileSync(TR, [rec('user', { message: { role: 'user', content: 'Should the tail flutter too?' } }, at(3)), rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'It can. Keep it subtle, or make it lively?' }], usage: { input_tokens: 5, cache_read_input_tokens: 40000, output_tokens: 100 } } }, at(2)), rec('system', { subtype: 'turn_duration' }, at(2))].join('\n') + '\n');
  const ev = (event, m, extra = {}) => JSON.stringify({ at: at(m), event, session_id: SID, assistant: 'claude', cwd: proj, transcript_path: TR, workspace_id: WS, surface_id: SF, claude_pid: 7101, terminal: 'cmux', ...extra });
  fs.writeFileSync(path.join(a.home, '.ravenry', 'events', SID + '.jsonl'), [ev('SessionStart', 10), ev('UserPromptSubmit', 3), ev('Stop', 2, { ends_on_question: true, question: 'Keep it subtle, or make it lively?' })].join('\n') + '\n');
  fs.writeFileSync(a.fake, JSON.stringify({ workspaces: [{ id: WS, ref: 'workspace:1', title: 'kite', cwd: proj, surfaces: [{ id: SF, ref: 'surface:1', title: '✳ Kite tail' }] }], screens: { [SF]: `❯ Should the tail flutter too?\n\n⏺ It can. Keep it subtle, or make it lively?\n\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ? for shortcuts\n` } }));
  fs.writeFileSync(a.ps, JSON.stringify([{ pid: 7101, ppid: 7100, rssKb: 300000, startedAt: at(10), command: `claude --session-id ${SID}`, cwd: proj, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF}` }]));
}

// The stub process list, edited under the lock the stand-in Claudes take
// (tools/stand-in-claude.mjs), so no edit drops another's entry.
async function editPs(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 500; i++) { try { fs.mkdirSync(lock); break; } catch { await sleep(20); } }
  try { let l = []; try { l = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ } fs.writeFileSync(`${file}.rc.tmp`, JSON.stringify(fn(l))); fs.renameSync(`${file}.rc.tmp`, file); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}

const sigFile = (a, n) => path.join(a.work, `${n}.signal`);
const goFile = (a, n) => path.join(a.work, `${n}.go`);
const pause = (a, n) => [{ signal: sigFile(a, n) }, { wait: goFile(a, n), timeout: 60000 }];
async function at(a, n) { for (let i = 0; i < 2400 && !fs.existsSync(sigFile(a, n)); i++) await sleep(50); }

try {
  // ------------------------------------------------------------ 0, the release as it is
  await guarded('0 release', async () => {
    const r = spawnSync(process.execPath, [path.join(HERE, 'package-check.mjs'), APP_PATH, path.join(OUT, 'package-check')], { encoding: 'utf8', timeout: 300000 });
    const oks = (r.stdout || '').split('\n').filter((l) => l.startsWith('check: ok'));
    const want = ['a release build: no driver', 'fuses', 'with no driver, opened a shell', 'it loaded and ran none of', '--remote-debugging-port', '--inspect', 'run as Node', 'the hub runs as the service says', 'SIGUSR1'];
    const missing = want.filter((w) => !oks.some((l) => l.includes(w)));
    step(`0 release: the release itself, with no driver (tools/package-check.mjs, ${oks.length} checks): no test hooks, fuses, its own daemon and a shell in it, nothing an agent's launch names runs, debugging switches refused, its hub answers`, r.status === 0 && !missing.length, { exit: r.status, missing, tail: ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-6) });
    // The twin: the same build, with the test hooks on.
    const res = (a, f) => path.join(a, 'Contents', 'Resources', f);
    const same = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(res(APP_PATH, f))).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(res(DRIVEN, f))).digest('hex'); } catch { return false; } };
    let twinBuild = null;
    try { twinBuild = JSON.parse(fs.readFileSync(res(DRIVEN, 'build.json'), 'utf8')); } catch { /* below */ }
    const twinHooks = (() => { try { return fs.readFileSync(res(DRIVEN, 'app.asar')).includes(Buffer.from('require(process.env.RAVENRY_DRIVER)')); } catch { return false; } })();
    step(`0 release: the window steps run on its test twin (${DRIVEN}): the same build ${BUILD.id}, ravenryd and hub, with the test hooks on`, !!twinBuild && twinBuild.id === BUILD.id && same('ravenryd') && same(path.join('hub', 'server', 'index.mjs')) && same(path.join('remote', 'builds.json')) && twinHooks, { twinBuild: twinBuild && twinBuild.id, ravenryd: same('ravenryd'), hub: same(path.join('hub', 'server', 'index.mjs')), twinHooks, hint: twinBuild ? undefined : 'npm run pack makes it in release-test/' });
  });

  // ------------------------------------------------------------ 1-4, one account
  const a = await account('main');
  outsideSession(a);
  await guarded('1 cold launch', async () => {
    let m = null;
    const feed = (async () => {
      await at(a, 'closed');
      await editPs(a.ps, (l) => l.filter((p) => p.pid !== 7101)); // its process ended in cmux
      fs.writeFileSync(goFile(a, 'closed'), '1');
    })();
    const run = launch(a, 'cold', [
      { ready: true, timeout: 30000 }, mark('ready'),
      { until: PROMPT, timeout: 20000 }, mark('prompt'), shot('1-cold-prompt.png'), ...agree('launch'),
      { type: 'echo ok-$((40+2))\r' },
      { until: `${R}.text().includes('ok-42') && ${NO_FAIL_TOAST}`, timeout: 10000 }, mark('echo'),
      // The hub (the service) answers in the window.
      { until: `${R}.S.hubStatus && ${R}.S.hubStatus.reachable && ${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length === 1`, timeout: 30000 }, mark('hub'),
      // 2: New session with the stand-in Claude.
      { js: `document.querySelector('#side .brand .icon-btn[aria-label="New session"]').click()` }, // New session, as a person opens it
      { until: `!document.getElementById('start').hidden && document.querySelector('#start .fl-go .btn.pri') && /^Start Claude in /.test(document.querySelector('#start .fl-go .btn.pri').textContent)`, timeout: 20000 },
      { js: `new Promise((r) => { const t0 = Date.now(); const f = () => { const b = document.querySelector('#start .fl-hooks .btn.pri'); if (b) { b.click(); r(true); } else if (Date.now() - t0 > 8000) r(false); else setTimeout(f, 50); }; f(); })` },
      { js: `document.querySelector('#start .fl-go .btn.pri').click()` }, mark('sessionClick'),
      { until: `${R}.term().ready && ${R}.text().includes('fake claude ready') && ${NO_FAIL_TOAST}`, timeout: 20000 }, mark('session'), shot('2-new-session.png'), ...agree('session'),
      // 3: the session in cmux, shown live.
      { until: `[...document.querySelectorAll('#side .ss')].some((e) => e.textContent.includes('Kite tail'))`, timeout: 20000 },
      { click: `[...document.querySelectorAll('#side .ss')].find((e) => e.textContent.includes('Kite tail'))`, clickJs: true },
      { until: `!document.getElementById('elsewhere').hidden && document.getElementById('elsewhere').textContent.includes('make it lively') && document.getElementById('elsewhere').textContent.includes('Move here ends it in cmux')`, timeout: 20000 }, mark('outside'), shot('3-outside-open.png'), ...agree('outside'),
      ...pause(a, 'closed'),
      { until: `document.querySelector('#elsewhere .else-acts .btn.pri') && /^Move here$/.test(document.querySelector('#elsewhere .else-acts .btn.pri').textContent) && /picks up this conversation/.test(document.getElementById('elsewhere').textContent) && !document.querySelector('#elsewhere .else-acts .btn.pri').disabled`, timeout: 20000 }, shot('3-outside-closed.png'),
      { js: `document.querySelector('#elsewhere .else-acts .btn.pri').click()` }, mark('continueClick'),
      { until: `document.getElementById('elsewhere').hidden && ${R}.term().ready && ${R}.text().includes('fake claude ready (args: --resume ${SID})') && ${NO_FAIL_TOAST}`, timeout: 20000 }, mark('continued'), shot('3-continued.png'), ...agree('continued'),
      save('tabs', `${R}.S.tabs.length`), save('shells', `${R}.S.tabs.filter((t) => t.kind === 'shell').length`),
      // Back to the first shell, so the reopen shows it.
      { js: `${R}.setView({ kind: 'tab', id: ${R}.S.tabs.find((t) => t.kind === 'shell').id })` }, { sleep: 400 },
    ]);
    m = await Promise.all([run, feed]).then(([x]) => x);
    const plist = fs.existsSync(plistOf(a)) ? fs.readFileSync(plistOf(a), 'utf8') : '';
    const st = await hubAnswers(a.port, 5000);
    const sock = fs.readdirSync(a.rt).filter((n) => n === `ravenryd-${BUILD.version}.sock`);
    step('1 cold launch: the service is installed under the test label and loaded, its hub answers, the daemon runs', !!plist && plist.includes(`versions/${BUILD.version}/hub`) && loaded(a.label) && !!st && sock.length === 1, { loaded: loaded(a.label), hub: !!st, daemonSocket: sock[0] || null });
    // The first launch of a freshly installed copy pays macOS's first check
    // of an ad hoc signed app once: measured and said, a budget of 3.5 s,
    // not a gate until the app is signed (the launches after it gate at 2 s).
    step('1 cold launch (first launch of a fresh copy): a shell prompt in the window, budget 3.5 s, reported only', true, { promptMs: m.prompt, windowReadyMs: m.ready, withinBudget: m.prompt <= 3500 });
    step('1 cold launch: `echo ok` typed in it reads back', m.echo > 0, { echoMs: m.echo });
    step('1-3: after launch and each step, the highlighted row, the panel and the tab in front agree', ['launch', 'session', 'outside', 'continued'].every((k) => m[`agree_${k}`] > 0));
    const hubLog = fs.existsSync(path.join(a.home, 'Library', 'Logs', 'Ravenry', 'hub.log')) ? fs.readFileSync(path.join(a.home, 'Library', 'Logs', 'Ravenry', 'hub.log'), 'utf8') : '';
    const started = (hubLog.match(/^sessions: started .*$/m) || [''])[0];
    step('2 New session: the stand-in Claude runs in a pane, shown in the window, within 2 s of the click', m.session > 0 && m.session - m.sessionClick <= 2000, { msFromClick: m.session - m.sessionClick, hub: started });
    step('3 outside: the session in cmux is shown live, then continued in Ravenry and shown running `claude --resume <id>`', m.outside > 0 && m.continued > 0, { msFromClick: m.continued - m.continueClick });
    results.tabsBefore = { tabs: m.tabs, shells: m.shells };
  });

  await guarded('4 reopen', async () => {
    const before = results.tabsBefore || { shells: 0 };
    const m = await launch(a, 'reopen', [
      { ready: true, timeout: 30000 }, mark('ready'),
      { until: PROMPT, timeout: 20000 }, mark('prompt'),
      { until: `${R}.S.tabs.filter((t) => t.kind === 'shell').length === ${before.shells} && ${R}.text().includes('ok-42')`, timeout: 10000 }, mark('restored'), shot('4-reopen.png'), ...agree('reopen'),
      save('shells', `${R}.S.tabs.filter((t) => t.kind === 'shell').length`),
    ]);
    step('4 reopen: the shells come back with what they showed', m.restored > 0 && m.shells === before.shells, { shells: m.shells, before: before.shells });
    step('4 reopen: the highlighted row, the panel and the tab in front agree', m.agree_reopen > 0);
    step('4 reopen: a shell prompt in the window within 2 s', m.prompt <= 2000, { promptMs: m.prompt, windowReadyMs: m.ready });
  });

  // ------------------------------------------------------------ 5, the update
  await guarded('5 update', async () => {
    if (!PREV) { step('5 update: skipped (no --prev build given)', false); return; }
    const b = await account('update');
    // The build before, as its service runs it: staged and loaded under the
    // check's label (its own app could only write dev.ravenry.hub).
    let prevApp = path.resolve(PREV);
    if (prevApp.endsWith('.zip')) {
      const into = path.join(b.root, 'prev');
      fs.mkdirSync(into);
      execFileSync('/usr/bin/ditto', ['-x', '-k', prevApp, into]);
      prevApp = path.join(into, fs.readdirSync(into).find((n) => n.endsWith('.app')));
    }
    const prevBuild = JSON.parse(fs.readFileSync(path.join(prevApp, 'Contents', 'Resources', 'build.json'), 'utf8'));
    const oldDir = path.join(b.data, 'versions', prevBuild.version);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.copyFileSync(path.join(prevApp, 'Contents', 'Resources', 'ravenryd'), path.join(oldDir, 'ravenryd'));
    fs.chmodSync(path.join(oldDir, 'ravenryd'), 0o755);
    fs.cpSync(path.join(prevApp, 'Contents', 'Resources', 'hub'), path.join(oldDir, 'hub'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, '.build.json'), JSON.stringify(prevBuild) + '\n');
    // The hooks the build before wrote: they name its version folder. A
    // Claude Code started then keeps these commands until it exits (it
    // reads its hooks once), whatever the settings say later.
    const oldHook = (script) => `ELECTRON_RUN_AS_NODE=1 '${b.exe}' '${path.join(oldDir, 'hub', 'hooks', script)}' --ravenryd`;
    const snapshot = { events: oldHook('events.mjs'), stop: oldHook('handoff-stop.mjs') };
    fs.mkdirSync(path.join(b.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop'].map((ev) => [ev, [{ hooks: [{ type: 'command', command: snapshot.events, timeout: 5 }, ...(ev === 'Stop' ? [{ type: 'command', command: snapshot.stop, timeout: 10 }] : [])] }]])) }, null, 2) + '\n');
    const envXml = Object.entries({ ELECTRON_RUN_AS_NODE: '1', RAVENRY_TERMINAL: 'ravenry', RAVENRY_HUB_SERVICE: '1', RAVENRY_APP_VERSION: prevBuild.version, RAVENRY_DAEMON_BIN: path.join(oldDir, 'ravenryd'), ...Object.fromEntries(Object.entries(b.env).filter(([k]) => /^(HOME|PATH|PORT|RAVENRY_RUNTIME_DIR|RAVENRY_STATE_DIR|RAVENRY_PHONE_PORT|MC_|STUB_|FAKE_|CMUX_BIN)/.test(k))) })
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('\n');
    fs.mkdirSync(path.dirname(plistOf(b)), { recursive: true });
    fs.mkdirSync(path.join(b.home, 'Library', 'Logs', 'Ravenry'), { recursive: true });
    fs.writeFileSync(plistOf(b), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${b.label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${path.join(prevApp, 'Contents', 'MacOS', 'Ravenry')}</string>\n    <string>${path.join(oldDir, 'hub', 'server', 'index.mjs')}</string>\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${path.join(oldDir, 'hub')}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${path.join(b.home, 'Library', 'Logs', 'Ravenry', 'hub.log')}</string>\n  <key>StandardErrorPath</key>\n  <string>${path.join(b.home, 'Library', 'Logs', 'Ravenry', 'hub.log')}</string>\n</dict>\n</plist>\n`);
    const boot = launchctl('bootstrap', `gui/${UID}`, plistOf(b));
    const oldUp = await hubAnswers(b.port, 30000);
    step(`5 update: the build before (${prevBuild.version}) runs as the service and answers`, boot.status === 0 && !!oldUp, { bootstrap: boot.status, out: boot.stderr.trim().slice(0, 200) });
    if (!oldUp) return;
    // 7: before the update, a session continued in a pane of the build
    // before's daemon, while its process in cmux runs on (cmux's restore
    // started it again). That daemon was started from a cmux tab, so its
    // panes inherited the tab's variables, as on 2026-11-07.
    outsideSession(b);
    // ... and from inside a Claude Code session: its panes carry CLAUDECODE
    // and CLAUDE_CODE_CHILD_SESSION, as a live 0.1.3 pane did on 2026-11-07.
    const oldEnv = { HOME: b.home, PATH: b.env.PATH, LANG: 'en_US.UTF-8', SHELL: '/bin/zsh', RAVENRY_RUNTIME_DIR: b.rt, RAVENRY_STATE_DIR: b.data, CMUX_SURFACE_ID: SF, CMUX_WORKSPACE_ID: WS, TERM_PROGRAM: 'ghostty', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' };
    execFileSync(path.join(oldDir, 'ravenryd'), ['serve', '--detach'], { env: oldEnv });
    const { connectSocket } = await import(path.join(HUB, '..', 'packages', 'node-client', 'index.mjs'));
    const oldSock = path.join(b.rt, `ravenryd-${prevBuild.version}.sock`);
    for (let i = 0; i < 100 && !fs.existsSync(oldSock); i++) await sleep(50);
    const oc = await connectSocket(oldSock, { name: 'release-check' });
    // A long session: 5000 lines of scrollback before its prompt.
    const { pane: oldPane } = await oc.request('pane.new', { cols: 100, rows: 30, cwd: path.join(b.home, 'Projects', 'kite'), command: ['/bin/sh', '-c', `seq 1 5000; exec '${path.join(b.home, '.local', 'bin', 'claude')}' --resume ${SID}`], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
    oc.close();
    // The live order of 2026-11-07: a newer daemon starts beside the old
    // one, and the old one logs that it is draining, all before the click.
    const newEnv = { ...oldEnv };
    for (const k of ['CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID']) delete newEnv[k];
    execFileSync(path.join(path.dirname(b.exe), '..', 'Resources', 'ravenryd'), ['serve', '--detach'], { env: newEnv });
    const oldLog = path.join(b.data, `ravenryd-${prevBuild.version}.log`);
    let drained = false;
    for (let i = 0; i < 100 && !drained; i++) { drained = fs.existsSync(oldLog) && /runs beside this one: draining/.test(fs.readFileSync(oldLog, 'utf8')); if (!drained) await sleep(100); }
    step(`7 update: the build before's daemon logs that it is draining before the app opens`, drained);
    await editPs(b.ps, (procs) => [...procs, { pid: 7201, ppid: 7200, rssKb: 300000, startedAt: new Date(Date.now() - 60000).toISOString(), command: `claude --resume ${SID}`, cwd: path.join(b.home, 'Projects', 'kite'), env: `CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF} TERM_PROGRAM=ravenry RAVENRY_PANE=${oldPane.id}` }]);
    const rowsOf = `[...document.querySelectorAll('#side .ss')].filter((e) => /ravenry:${oldPane.id}|${SID}|${SF}/.test(e.dataset.key || ''))`;
    const m = await launch(b, 'update', [
      { ready: true, timeout: 30000 }, mark('ready'),
      { until: PROMPT, timeout: 20000 }, mark('prompt'), shot('5-update-prompt.png'), ...agree('update'),
      { until: `${R}.S.hubStatus && ${R}.S.hubStatus.reachable && ${R}.S.hub && Array.isArray(${R}.S.hub.projects)`, timeout: 60000 }, mark('hub'),
      { until: `${rowsOf}.length === 1 && ${rowsOf}[0].dataset.key.endsWith('/ravenry:${oldPane.id}')`, timeout: 30000 }, mark('oneRow'),
      { click: `${rowsOf}[0]`, clickJs: true, hold: 300 }, mark('click'),
      { until: `document.getElementById('elsewhere').hidden && ${R}.term().ready && ${R}.term().attached && ${R}.term().attached.pane === '${oldPane.id}' && ${R}.text().includes('fake claude ready (args: --resume ${SID})') && document.querySelector('#tabs .tab.on') && ${NO_FAIL_TOAST}`, timeout: 20000 }, mark('opened'), shot('7-old-pane-open.png'),
      { until: `document.querySelector('#panel .sec.twin') && /Also open in cmux/.test(document.querySelector('#panel .sec.twin').textContent)`, timeout: 20000 }, mark('twin'), shot('7-old-pane-also-cmux.png'), ...agree('oldPane'),
      // Move here on that old pane: it resumes in a new pane of the new
      // daemon, never in the old pane's shell with what it inherited.
      { until: `!document.getElementById('movebar').hidden`, timeout: 20000 },
      { click: '#movebar .btn.pri' }, mark('moveOld'),
      { until: `${R}.term().ready && ${R}.term().attached && ${R}.term().attached.pane !== '${oldPane.id}' && ${R}.text().includes('fake claude ready (args: --resume ${SID})')`, timeout: 30000 }, mark('movedOld'),
      save('newPane', `${R}.term().attached.pane`), shot('7-old-pane-moved.png'),
      { sleep: 3000 },
    ]);
    step(`7 update: a session in a pane of the build before's daemon (${prevBuild.version}) is listed after the update, as one row`, m.oneRow > 0, { msFromStart: m.oneRow });
    step('7 update: clicking that row opens its pane in the middle', m.opened > 0, { msFromClick: m.opened - m.click });
    step('7 update: with its process in cmux too, the session says "Also open in cmux"', m.twin > 0);
    step('5/7 update: after the relaunch and the click, the highlighted row, the panel and the tab in front agree', m.agree_update > 0 && m.agree_oldPane > 0);
    {
      let l = []; try { l = JSON.parse(fs.readFileSync(b.ps, 'utf8')); } catch { /* none */ }
      const on = l.filter((p) => p.command.includes(SID)).filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
      const oldLeft = (() => { try { return JSON.parse(execFileSync(path.join(oldDir, 'ravenryd'), ['ls', '--json', '--no-start'], { env: oldEnv, encoding: 'utf8' })).some((p) => p.id === oldPane.id); } catch { return null; } })();
      step('7 update: Move here on the leaky old pane resumes in a new pane, its Claude clean (no CLAUDECODE, CLAUDE_CODE_*, CMUX_*), and the old pane closes', m.movedOld > 0 && on.length === 1 && on[0].env.includes(`RAVENRY_PANE=${m.newPane}`) && !/(^|\s)(CLAUDE|CMUX_)/.test(on[0].env) && oldLeft === false, { msFromClick: m.movedOld - m.moveOld, left: on.map((p) => ({ pid: p.pid, env: p.env })), oldPaneLeft: oldLeft });
    }
    const newUp = await hubAnswers(b.port, 30000);
    const prog = argsOf(b.label);
    const hubs = listeners(b.port);
    const log = fs.existsSync(path.join(b.home, 'Library', 'Logs', 'Ravenry', 'app.log')) ? fs.readFileSync(path.join(b.home, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8') : '';
    const updated = log.indexOf('service: updated');
    const removed = log.indexOf('install: removed versions');
    step(`5 update: exactly one hub, answering, on ${BUILD.version}`, !!newUp && loaded(b.label) && prog.includes(`versions/${BUILD.version}/hub`) && hubs.length === 1, { hubs: hubs.length, program: (prog.match(/versions\/[^/]+\/hub/) || [])[0] || null });
    step('5 update: the old version\'s folder is kept until the new hub answered', updated >= 0 && (removed < 0 || removed > updated), { log: log.trim().split('\n').slice(-4) });
    step('5 update (first launch of the new copy): a shell prompt in the window, budget 3.5 s, reported only', true, { promptMs: m.prompt, windowReadyMs: m.ready, withinBudget: m.prompt <= 3500 });
    const answeredAt = Date.parse((log.match(/^(\S+) service: updated/m) || [])[1] || '');
    const rowAfter = answeredAt ? m.t0 + m.oneRow - answeredAt : null;
    step('7 update: the old pane\'s session row within 3 s of the new hub answering', rowAfter != null && rowAfter <= 3000, { msAfterHubAnswered: rowAfter });

    // 8: the hooks of a session started on the build before, after the
    // update and the old folder's removal (2026-11-07: "UserPromptSubmit
    // hook error" at every turn). The old daemon ends, the app opens again
    // and removes what nothing runs from; then the old hook commands run as
    // that session's Claude Code would run them.
    try { for (const d of JSON.parse(execFileSync(path.join(oldDir, 'ravenryd'), ['daemons', '--json', '--no-start'], { env: oldEnv, encoding: 'utf8' }))) if (d.version === prevBuild.version) process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 100 && fs.existsSync(oldSock); i++) await sleep(100);
    await launch(b, 'prune', [{ ready: true, timeout: 30000 }, { until: `${R}.S.hubStatus && ${R}.S.hubStatus.reachable`, timeout: 60000 }, { sleep: 4000 }]);
    const settings = fs.readFileSync(path.join(b.home, '.claude', 'settings.json'), 'utf8');
    const current = (() => { try { return fs.realpathSync(path.join(b.data, 'current')); } catch { return null; } })();
    step('8 hooks: the settings name the stable folder (current), never a version folder', settings.includes('/current/hub/hooks/events.mjs') && !/\/versions\//.test(settings) && current === fs.realpathSync(path.join(b.data, 'versions', BUILD.version)), { current, versionsNamed: (settings.match(/versions\/[^/]+/g) || []).slice(0, 3) });
    step(`8 hooks: the build before's folder is removed, its hook scripts left as stubs`, !fs.existsSync(path.join(oldDir, 'hub', 'server')) && fs.existsSync(path.join(oldDir, 'REMOVED')) && fs.existsSync(path.join(oldDir, 'hub', 'hooks', 'events.mjs')), { left: fs.existsSync(oldDir) ? fs.readdirSync(oldDir) : null });
    const hookSid = '5e55107e-0000-4000-8000-0000000000bb';
    const runHook = (cmd, ev) => spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ session_id: hookSid, hook_event_name: ev, cwd: path.join(b.home, 'Projects', 'kite'), prompt: 'and now?', transcript_path: path.join(b.home, '.claude', 'projects', 'x', `${hookSid}.jsonl`) }), env: { HOME: b.home, PATH: b.env.PATH, LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 20000 });
    const evFile = path.join(b.home, '.ravenry', 'events', `${hookSid}.jsonl`);
    const r1 = runHook(snapshot.events, 'UserPromptSubmit');
    const lines1 = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').trim().split('\n').length : 0;
    const r2 = runHook(snapshot.stop, 'Stop');
    step('8 hooks: a session started on the build before runs its old hook commands after the update with no error, and its event reaches the board', r1.status === 0 && !r1.stderr.trim() && r2.status === 0 && !r2.stderr.trim() && lines1 >= 1, { exit: [r1.status, r2.status], stderr: (r1.stderr + r2.stderr).trim().slice(0, 300), events: lines1 });
    const nowCmd = (JSON.parse(settings).hooks.UserPromptSubmit || []).flatMap((e) => e.hooks).map((h) => h.command).find((c) => c.includes('events.mjs'));
    const r3 = nowCmd ? runHook(nowCmd, 'UserPromptSubmit') : { status: -1, stderr: 'no command' };
    const lines3 = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').trim().split('\n').length : 0;
    step('8 hooks: the hook commands written now run with no error', r3.status === 0 && !String(r3.stderr).trim() && lines3 > lines1, { exit: r3.status, stderr: String(r3.stderr).trim().slice(0, 300) });
    launchctl('bootout', `gui/${UID}/${b.label}`);
  });

  // ------------------------------------------------------------ 6, the npm switch
  await guarded('6 npm switch', async () => {
    if (NO_NPM) { step('6 npm switch: skipped (--no-npm)', false); return; }
    const r = spawnSync(process.execPath, [path.join(HERE, 'npm-switch-test.mjs'), DRIVEN, path.join(OUT, 'npm-switch')], { encoding: 'utf8', timeout: 900000 });
    const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    step('6 npm switch: from the npm board 0.4.0 and the way back (tools/npm-switch-test.mjs)', r.status === 0 && !fails.length, { exit: r.status, fails: fails.slice(0, 5), tail: (r.stderr || r.stdout || '').trim().split('\n').slice(-3) });
  });
  // ------------------------------------------------------------ 9, Move here
  await guarded('9 move here', async () => {
    const m = await account('move');
    const proj = path.join(m.home, 'Projects', 'kite');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'BRIEF.md'), '# Kite\n\nGoal: A kite that flies itself.\n');
    execFileSync('/usr/bin/git', ['-C', proj, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(m.home, '.ravenry', 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: proj, workspaces: [WS], brief: 'BRIEF.md' }] }, null, 2));
    const SA = '5e55107e-0000-4000-8000-0000000000a1';
    const SB = '5e55107e-0000-4000-8000-0000000000b2';
    const SFA = 'BBBB2222-0000-4000-8000-0000000000A1';
    const SFB = 'BBBB2222-0000-4000-8000-0000000000B2';
    fs.writeFileSync(m.fake, JSON.stringify({ workspaces: [{ id: WS, ref: 'workspace:1', title: 'kite', cwd: proj, surfaces: [{ id: SFA, ref: 'surface:1', title: 'Tail' }, { id: SFB, ref: 'surface:2', title: 'Plan' }] }], screens: {} }));
    // A stand-in Claude in a cmux tab: a real process, with its own hooks.
    const kids = [];
    function outside(sf, args) {
      const c = spawn(path.join(m.home, '.local', 'bin', 'claude'), args, { cwd: proj, env: { HOME: m.home, PATH: m.env.PATH, LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty', CMUX_WORKSPACE_ID: WS, CMUX_SURFACE_ID: sf }, stdio: ['pipe', 'pipe', 'pipe'] });
      const o = { c, out: '', exited: null };
      c.stdout.on('data', (d) => { o.out += d; });
      c.stderr.on('data', (d) => { o.out += d; });
      c.on('exit', (code, sig) => { o.exited = { code, sig, at: Date.now() }; });
      o.until = async (re, ms = 20000) => { for (let i = 0; i < ms / 50 && !re.test(o.out); i++) await sleep(50); if (!re.test(o.out)) throw new Error(`stand-in never said ${re}: ${o.out.slice(-300)}`); };
      kids.push(o);
      return o;
    }
    // The processes on a session id that are alive, from the stub list.
    const onSession = (sid) => { let l = []; try { l = JSON.parse(fs.readFileSync(m.ps, 'utf8')); } catch { /* none */ } return l.filter((p) => p.command.includes(sid)).filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } }); };
    const res = {};
    const feed = (async () => {
      await at(m, 'hooks');
      const r = await fetch(`http://127.0.0.1:${m.port}/api/setup/hooks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ ravenryd: path.join(m.data, 'bin', 'ravenryd') }) });
      res.hooks = r.status;
      if (r.status !== 200) throw new Error(`hook setup: ${r.status} ${await r.text()}`);
      // A: open in cmux, idle after one turn.
      const o1 = outside(SFA, ['--session-id', SA]);
      await o1.until(/fake claude ready/);
      o1.c.stdin.write('make the tail flutter\n');
      await o1.until(/answered: make the tail flutter/);
      fs.writeFileSync(goFile(m, 'hooks'), '1');
      await at(m, 'checkA');
      res.a = { o1Exit: o1.exited, left: onSession(SA).map((p) => ({ pid: p.pid, env: p.env })) };
      // B: open in cmux, mid-turn when Move here is pressed.
      const o2 = outside(SFB, ['--session-id', SB]);
      await o2.until(/fake claude ready/);
      o2.c.stdin.write('a slow plan\n');
      await o2.until(/thinking: a slow plan/);
      fs.writeFileSync(goFile(m, 'checkA'), '1');
      await at(m, 'checkB');
      res.b = { o2Exit: o2.exited, answeredBeforeEnd: /answered: a slow plan/.test(o2.out), left: onSession(SB).map((p) => ({ pid: p.pid, env: p.env })) };
      // C: A runs in a Ravenry pane; it goes on in cmux, then that one exits.
      const o3 = outside(SFA, ['--resume', SA]);
      await o3.until(/fake claude ready/);
      o3.c.stdin.write('it went on elsewhere\n');
      await o3.until(/answered: it went on elsewhere/);
      o3.c.stdin.end();
      for (let i = 0; i < 100 && !o3.exited; i++) await sleep(100);
      fs.writeFileSync(goFile(m, 'checkB'), '1');
      await at(m, 'checkC');
      await sleep(2500); // the old pane closes 2 s after the move
      const panes = (() => { try { return JSON.parse(execFileSync(path.join(m.data, 'bin', 'ravenryd'), ['ls', '--json', '--no-start'], { env: { HOME: m.home, PATH: '/usr/bin:/bin', RAVENRY_RUNTIME_DIR: m.rt, RAVENRY_STATE_DIR: m.data }, encoding: 'utf8' })).map((p) => p.id); } catch { return null; } })();
      res.c = { left: onSession(SA).map((p) => ({ pid: p.pid, env: p.env })), panes };
      // D: open in both: A in the pane, and again in cmux.
      const o4 = outside(SFA, ['--resume', SA]);
      await o4.until(/fake claude ready/);
      fs.writeFileSync(goFile(m, 'checkC'), '1');
      await at(m, 'checkD');
      res.d = { o4Alive: !o4.exited, left: onSession(SA).map((p) => ({ pid: p.pid, env: p.env })) };
      fs.writeFileSync(goFile(m, 'checkD'), '1');
    })();
    const rowOf = (sf, sid) => `[...document.querySelectorAll('#side .ss')].find((e) => (e.dataset.key || '').includes('${sf}') || (e.dataset.key || '').includes('${sid}'))`;
    const both = (name) => [shot(`9-${name}-dark.png`), { theme: 'light' }, shot(`9-${name}-light.png`), { theme: 'dark' }];
    const paneText = (t) => `${R}.term().ready && ${R}.term().attached && ${R}.text().includes(${JSON.stringify(t)})`;
    const run = launch(m, 'move', [
      { ready: true, timeout: 30000 },
      { until: `${R}.S.hubStatus && ${R}.S.hubStatus.reachable && ${R}.S.hub && Array.isArray(${R}.S.hub.projects)`, timeout: 60000 },
      ...pause(m, 'hooks'),
      // A
      { until: `${rowOf(SFA, SA)}`, timeout: 30000 },
      { click: rowOf(SFA, SA), clickJs: true },
      { until: `!document.getElementById('elsewhere').hidden && /Move here ends it in cmux/.test(document.getElementById('elsewhere').textContent) && document.querySelector('#elsewhere .else-acts .btn.pri') && !document.querySelector('#elsewhere .else-acts .btn.pri').disabled`, timeout: 30000 },
      // Its screen in cmux is empty here: the transcript fills the middle.
      { until: `/From its transcript/.test(document.querySelector('#elsewhere .else-disc').textContent) && /answer to: make the tail flutter/.test(document.querySelector('#elsewhere .else-disc').textContent)`, timeout: 15000 }, mark('transcriptA'),
      save('toastsA', `[...document.querySelectorAll('#toast .ti')].map((e) => e.textContent)`),
      ...both('A-open-in-cmux-idle'),
      { click: '#elsewhere .else-acts .btn.pri' }, mark('clickA'),
      { until: `${paneText('last turn: answer to: make the tail flutter')} && ${AGREE}`, timeout: 30000 }, mark('movedA'),
      save('paneA', `${R}.term().attached.pane`),
      { js: `window.__paneA = ${R}.term().attached.pane` },
      ...pause(m, 'checkA'),
      // B
      { until: `${rowOf(SFB, SB)}`, timeout: 30000 },
      { click: rowOf(SFB, SB), clickJs: true },
      { until: `!document.getElementById('elsewhere').hidden && document.querySelector('#elsewhere .else-acts .btn.pri') && /^Move here$/.test(document.querySelector('#elsewhere .else-acts .btn.pri').textContent)`, timeout: 30000 },
      { click: '#elsewhere .else-acts .btn.pri' }, mark('clickB'),
      { until: `[...document.querySelectorAll('#elsewhere button')].some((b) => /^Waiting for Claude to finish in cmux$/.test(b.textContent))`, timeout: 10000 }, mark('waitingB'),
      ...both('B-mid-turn-waiting'),
      { until: `${paneText('last turn: answer to: a slow plan')}`, timeout: 40000 }, mark('movedB'),
      ...pause(m, 'checkB'),
      // C: A's row is its pane's now.
      { until: `[...document.querySelectorAll('#side .ss')].some((e) => (e.dataset.key || '').endsWith('ravenry:' + window.__paneA))`, timeout: 30000 },
      { click: `[...document.querySelectorAll('#side .ss')].find((e) => (e.dataset.key || '').endsWith('ravenry:' + window.__paneA))`, clickJs: true },
      { until: `${R}.term().attached && ${R}.term().attached.pane === window.__paneA && !document.getElementById('movebar').hidden && /This conversation went on in cmux\./.test(document.getElementById('movebar').textContent)`, timeout: 30000 }, mark('staleC'),
      ...both('C-went-on-in-cmux'),
      { click: '#movebar .btn.pri' }, mark('clickC'),
      { until: `${paneText('last turn: answer to: it went on elsewhere')} && document.getElementById('movebar').hidden && ${R}.term().attached.pane !== window.__paneA`, timeout: 30000 }, mark('movedC'),
      save('paneC', `${R}.term().attached.pane`),
      ...pause(m, 'checkC'),
      // D
      { until: `!document.getElementById('movebar').hidden && /Also open in cmux\./.test(document.getElementById('movebar').textContent) && document.querySelector('#panel .sec.twin')`, timeout: 30000 }, mark('doubleD'),
      save('toastsD', `[...document.querySelectorAll('#toast .ti')].map((e) => e.textContent)`),
      ...both('D-open-in-both'),
      { click: `[...document.querySelectorAll('#movebar button')].find((b) => b.textContent === 'Keep it in cmux')`, clickJs: true }, mark('clickD'),
      { until: `document.getElementById('movebar').hidden && !document.getElementById('elsewhere').hidden`, timeout: 30000 }, mark('keptD'),
      ...pause(m, 'checkD'),
      // 10, the strip: two sessions, a shell, and a pane an agent made from
      // that shell are tabs; clicking through them brings each to the front
      // and never removes or moves one; row, panel and tab agree each time.
      { click: `[...document.querySelectorAll('#side .ss')].find((e) => /a slow plan/.test(e.textContent))`, clickJs: true },
      { until: AGREE, timeout: 8000 },
      { js: `${R}.onCommand('new-shell')` },
      { until: `${R}.S.tabs.filter((t) => t.kind === 'shell' && !t.owner).length >= 2 && ${R}.term().ready`, timeout: 15000 }, { sleep: 800 },
      { js: `${R}.term().focus()` },
      { type: `'${path.join(m.data, 'bin', 'ravenryd')}' new --name 'dev server' -- /bin/sh -c 'echo serving on :5173; exec sleep 600'\r`, after: 300 },
      { until: `${R}.S.tabs.some((t) => t.owner)`, timeout: 15000 }, mark('agentTab'),
      // 0.1.18: an agent's pane opens as a split beside the tab it came from (B1).
      save('agentAfterOwner', `(() => { const g = ${R}.S.tabs.find((t) => t.owner); const h = g && ${R}.S.tabs.find((t) => t.id === g.host); return !!h && h.kind === 'shell' && h.pane === g.owner && !!h.split && h.split.guest === g.id; })()`),
      save('agentNotFront', `(() => { const t = ${R}.S.view.kind === 'tab' && ${R}.S.tabs.find((x) => x.id === ${R}.S.view.id); return !!t && !t.owner && !!t.split && t.split.focus === 0; })()`),
      { until: `[...document.querySelectorAll('#side .ss')].some((e) => /went on elsewhere/.test(e.textContent))`, timeout: 20000 },
      { click: `[...document.querySelectorAll('#side .ss')].find((e) => /went on elsewhere/.test(e.textContent))`, clickJs: true },
      { until: AGREE, timeout: 8000 },
      save('strip0', `${R}.S.tabs.map((t) => t.id)`),
      { js: `window.__stripOk = true; window.__stripN = document.querySelectorAll('#tabs .tabrow > .tab').length` },
      ...Array.from({ length: 8 }, (_, i) => [
        { js: `window.__i = ${i}` },
        { click: `document.querySelectorAll('#tabs .tabrow > .tab')[Math.min(${i}, window.__stripN - 1)]`, clickJs: true, hold: 120 },
        { until: `document.querySelectorAll('#tabs .tabrow > .tab')[Math.min(${i}, window.__stripN - 1)].classList.contains('on') && ${AGREE}`, timeout: 8000 },
        { js: `if (JSON.stringify(${R}.S.tabs.map((t) => t.id)) !== JSON.stringify(window.__marks.strip0)) window.__stripOk = false` },
      ]).flat(),
      save('stripOk', `window.__stripOk`), save('stripN', `window.__stripN`),
      { click: `[...document.querySelectorAll('#tabs .tabrow > .tab')].find((e) => /a slow plan|kite/.test(e.textContent))`, clickJs: true }, { sleep: 600 },
      shot('10-strip-dark.png'), { theme: 'light' }, shot('10-strip-light.png'), { theme: 'dark' },
    ]);
    feed.catch((e) => { fs.writeFileSync(path.join(m.work, 'feed-error.txt'), String(e.stack || e)); for (const n of ['hooks', 'checkA', 'checkB', 'checkC', 'checkD']) try { fs.writeFileSync(goFile(m, n), '1'); } catch { /* */ } });
    const mk = await Promise.all([run, feed]).then(([x]) => x);
    // What the hub says of A at the end, and why (kept beside the shots).
    try {
      const st = await (await fetch(`http://127.0.0.1:${m.port}/api/state`)).json();
      const a = (st.projects || []).flatMap((pr) => pr.sessions.map((x) => ({ project: pr.id, ...x }))).filter((x) => x.sessionId === SA);
      const sp = await (await fetch(`http://127.0.0.1:${m.port}/api/sessions`).catch(() => null))?.json?.().catch(() => null);
      fs.writeFileSync(path.join(OUT, '9-session-a.json'), JSON.stringify({ onBoard: a.map((x) => ({ surfaceId: x.surfaceId, state: x.state, term: x.term })), ps: JSON.parse(fs.readFileSync(m.ps, 'utf8')), rows: sp && sp.rows ? sp.rows.filter((r) => r.sessionId === SA) : null }, null, 2));
      // Keep it in cmux ended the Ravenry copy of A; its cmux copy runs on,
      // so A stays on the board, in cmux (hub/server/events.mjs outlivedEnds).
      const aLive = JSON.parse(fs.readFileSync(m.ps, 'utf8')).some((p) => new RegExp(`--resume ${SA}`).test(p.command) && /CMUX_SURFACE_ID=/.test(p.env || ''));
      step('9 move: a session whose Ravenry copy ended while its cmux copy runs on stays on the board, in cmux', aLive && a.length >= 1 && a.some((x) => x.term === 'cmux' || (x.surfaceId && !/^ravenry:/.test(x.surfaceId))), { aLive, onBoard: a.map((x) => ({ surfaceId: x.surfaceId, state: x.state, term: x.term })) });
    } catch (e) { fs.writeFileSync(path.join(OUT, '9-session-a.json'), String(e)); step('9 move: session A read from the hub at the end', false, { error: String(e) }); }
    const logOf = (f) => { const p = path.join(m.home, 'Library', 'Logs', 'Ravenry', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
    const appLog = logOf('app.log');
    const hubLog = logOf('hub.log');
    // The hub's own words on the sessions (why one left the board, or came back), beside the shots.
    try { fs.writeFileSync(path.join(OUT, '9-hub-sessions.log'), hubLog.split('\n').filter((l) => /^sessions: /.test(l)).join('\n') + '\n'); } catch { /* none */ }
    const errs = kids.map((k) => (k.out.match(/hook error.*/g) || [])).flat();
    step('9 move: hooks set up through the stable folder, and no stand-in saw a hook error', res.hooks === 200 && !errs.length, { setup: res.hooks, errors: errs.slice(0, 3) });
    const clean = (l) => (l || []).every((p) => !/(^|\s)(CLAUDE|CMUX_)/.test(p.env));
    step('9 move A: open in cmux and idle, Move here ends it there and resumes it here with its last turn; one process left, in the pane, its environment clean', mk.movedA > 0 && !!res.a?.o1Exit && res.a.left.length === 1 && /RAVENRY_PANE=/.test(res.a.left[0].env) && clean(res.a.left), { msFromClick: mk.movedA - mk.clickA, o1: res.a?.o1Exit, left: res.a?.left });
    step('9 move B: mid-turn, the button waits for the turn to end, then moves it; the turn finished first; one process left, in a pane', mk.waitingB > 0 && mk.movedB > 0 && !!res.b?.answeredBeforeEnd && !!res.b.o2Exit && res.b.left.length === 1 && /RAVENRY_PANE=/.test(res.b.left[0].env) && clean(res.b.left), { waitedMs: mk.movedB - mk.clickB, left: res.b?.left });
    step('9 move C: a pane whose conversation went on in cmux says so; Move here resumes the latest in a new pane, its environment clean, and the old pane closes; one process left', mk.staleC > 0 && mk.movedC > 0 && !!mk.paneA && !!mk.paneC && mk.paneC !== mk.paneA && res.c?.left.length === 1 && res.c.left[0].env.includes(`RAVENRY_PANE=${mk.paneC}`) && clean(res.c.left) && res.c.panes && !res.c.panes.includes(mk.paneA), { paneA: mk.paneA, paneC: mk.paneC, left: res.c?.left, panes: res.c?.panes });
    step('9 move D: open in both, Keep it in cmux ends the Ravenry copy; only the cmux one is left', mk.doubleD > 0 && mk.keptD > 0 && !!res.d?.o4Alive && res.d.left.length === 1 && !/RAVENRY_PANE=/.test(res.d.left[0].env), { left: res.d?.left });
    const frontToast = (list, line) => (list || []).some((t) => t.includes(line));
    const dupes = (list) => new Set(list || []).size !== (list || []).length;
    step('9 move: no toast about the session in front, and no two toasts alike; an empty cmux screen shows the transcript instead', mk.transcriptA > 0 && !frontToast(mk.toastsA, 'make the tail flutter') && !frontToast(mk.toastsD, 'it went on elsewhere') && !dupes(mk.toastsA) && !dupes(mk.toastsD), { toastsA: mk.toastsA, toastsD: mk.toastsD });
    step('10 strip: two sessions and two shells are tabs, and an agent\'s pane opens as a split beside the shell it came from, without the keyboard; clicking through each tab, every tab stays, in order, and row, panel and tab agree', mk.agentTab > 0 && mk.agentAfterOwner === true && mk.agentNotFront === true && mk.stripN >= 4 && mk.stripOk === true, { tabs: mk.strip0, n: mk.stripN });
    step('9 move: every move is in app.log with each process it ended, and in the hub\'s log', /window: move .*: ended \d+ in cmux \(SIGTERM/.test(appLog) && /after its turn: ended/.test(appLog) && /kept in the other terminal/.test(appLog) && /sessions: move .*: ended \d+ in cmux with SIGTERM/.test(hubLog), { app: appLog.split('\n').filter((l) => / move /.test(l)).slice(-8) });
    for (const k of kids) if (!k.exited) k.c.kill('SIGTERM');
    launchctl('bootout', `gui/${UID}/${m.label}`);
  });
  // ------------------------------------------------------------ 11, keys
  await guarded('11 keys', async () => {
    // The test twin, copied out as it sits in /Applications.
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'rvck-'));
    const app = path.join(k, 'Ravenry.app');
    execFileSync('/usr/bin/ditto', [DRIVEN, app]);
    const r = spawnSync(process.execPath, [path.join(HERE, 'keys-test.mjs'), path.join(OUT, 'keys'), '--exe', path.join(app, 'Contents', 'MacOS', 'Ravenry')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, RAVENRYD: path.join(app, 'Contents', 'Resources', 'ravenryd') } });
    const lines = (r.stdout || '').split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
    step(`11 keys: every row of the keys table arrives as its exact bytes in a pane (${lines.filter((l) => l.startsWith('PASS')).length} of ${lines.length}), tools/keys-test.mjs`, r.status === 0 && lines.length > 20 && !lines.some((l) => l.startsWith('FAIL')), { fails: lines.filter((l) => l.startsWith('FAIL')).slice(0, 5), tail: (r.stderr || '').trim().split('\n').slice(-2) });
    fs.rmSync(k, { recursive: true, force: true });
  });
  // ------------------------------------------------------------ 12, a big set of projects
  await guarded('12 startup', async () => {
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'rvcs-'));
    const app = path.join(k, 'Ravenry.app');
    execFileSync('/usr/bin/ditto', [APP_PATH, app]);
    const r = spawnSync(process.execPath, [path.join(HUB, 'tools', 'startup-load-test.mjs'), '--exe', path.join(app, 'Contents', 'MacOS', 'Ravenry'), '--hub', path.join(app, 'Contents', 'Resources', 'hub'), '--ravenryd', path.join(app, 'Contents', 'Resources', 'ravenryd')], { encoding: 'utf8', timeout: 600000 });
    const m = (r.stdout || '').match(/MEASURE startup-load firstAnswerMs=(\d+) slowestMs=(\d+) stateReadyMs=(\d+|null)/);
    const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    step('12 startup: on 23 projects of 240,000 files, 1,840 plan files and 20 sessions of 20 MB, beside 4 busy panes and a daemon whose report ring is full, with a 70 MB session of 200 task launches and 761 hook reports for it in that ring, the packaged hub answers within 1 s of its listen line, never takes over 1 s to answer in its first 30 s, has its first state within 3 s, never holds its main thread over 200 ms, and counts that session\'s running tasks right', r.status === 0 && !fails.length, { firstAnswerMs: m ? Number(m[1]) : null, slowestMs: m ? Number(m[2]) : null, stateReadyMs: m ? Number(m[3]) : null, fails: fails.slice(0, 3) });
    fs.rmSync(k, { recursive: true, force: true });
  });
  // ------------------------------------------------------------ 13, opened from a pane
  // On 2026-11-07 the app, opened with `open -a` by an agent in a Ravenry
  // pane, inherited RAVENRY_PANE and RAVENRY_SOCKET, and the daemon took
  // its whole window for that pane. The packaged app now relaunches itself
  // clean (src/main/relaunch.ts); tools/relaunch-check.mjs proves it on a
  // copy, last in the foreground (open -n -a, no -g) as the person's start.
  await guarded('13 opened from a pane', async () => {
    const k = fs.mkdtempSync(path.join(os.tmpdir(), 'rvcr-'));
    const app = path.join(k, 'Ravenry.app');
    execFileSync('/usr/bin/ditto', [APP_PATH, app]);
    const r = spawnSync(process.execPath, [path.join(HERE, 'relaunch-check.mjs'), app, path.join(OUT, 'relaunch')], { encoding: 'utf8', timeout: 180000 });
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'relaunch', 'relaunch-check.json'), 'utf8')); } catch { /* below */ }
    const rows = j ? j.steps : [];
    const fg = rows.filter((x) => x.name.startsWith('3 '));
    step(`13 opened from a pane: started with RAVENRY_PANE and RAVENRY_SOCKET, it relaunches clean (${rows.filter((x) => x.ok).length} of ${rows.length} rows, tools/relaunch-check.mjs)`, r.status === 0 && rows.length > 0 && rows.every((x) => x.ok), { failed: rows.filter((x) => !x.ok), out: (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-500) });
    step('13 opened from a pane in the foreground (open -n -a, no -g): once it settles, exactly one instance runs, with none of RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM', fg.length >= 3 && fg.every((x) => x.ok), { rows: fg });
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]);
    fs.rmSync(k, { recursive: true, force: true });
  });
  // ------------------------------------------------------------ 14 and 15: the window's own tests, on the twin
  for (const [n, label, tool] of [[14, 'basics', 'basics-test.mjs'], [15, 'brief', 'brief-test.mjs'], [16, 'splits', 'split-test.mjs'], [17, 'features', 'features-test.mjs']]) {
    await guarded(`${n} ${label}`, async () => {
      const k = fs.mkdtempSync(path.join(os.tmpdir(), 'rvcb-'));
      const app = path.join(k, 'Ravenry.app');
      execFileSync('/usr/bin/ditto', [DRIVEN, app]);
      const r = spawnSync(process.execPath, [path.join(HERE, tool), path.join(OUT, label), '--exe', path.join(app, 'Contents', 'MacOS', 'Ravenry')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, RAVENRYD: path.join(app, 'Contents', 'Resources', 'ravenryd') } });
      const lines = (r.stdout || '').split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
      if (!lines.length) step(`${n} ${label}: tools/${tool} ran`, false, { status: r.status, tail: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-8) });
      for (const l of lines) {
        const ok = l.startsWith('PASS');
        const [name, ...rest] = l.slice(6).split('  ');
        step(`${n} ${label}: ${name.trim()}`, ok, ok ? {} : { detail: rest.join('  ').slice(0, 1500) });
      }
      spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]);
      fs.rmSync(k, { recursive: true, force: true });
    });
  }
  // ------------------------------------------------------------ the app's environment
  // On 2026-11-07 an app opened from inside a Ravenry pane inherited the
  // pane's variables, and the daemon took the whole window for that pane.
  // Every app this check launched (tools/run-app.mjs reads what the app
  // really ran with) had none of a terminal pane's variables
  // (RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM, CMUX_*...) and no Ravenry
  // variable but the test settings the check named itself.
  if (!ONLY || appEnvs.length) step('env: every app the check launched ran with a clean environment: no RAVENRY_* but the test\'s own settings, no TERM_PROGRAM or other terminal pane variable', appEnvs.length > 0 && appEnvs.every((e) => !e.bad.length), { launched: appEnvs.length, bad: appEnvs.filter((e) => e.bad.length) });
} finally {
  // Every test label out of launchd, whatever happened.
  for (const l of labels) if (loaded(l)) launchctl('bootout', `gui/${UID}/${l}`);
  // launchd lets go of a job a moment after bootout returns.
  for (let i = 0; i < 50 && labels.some(loaded); i++) await sleep(200);
  results.labelsLeft = labels.filter(loaded);
  reapStarted();
  fs.writeFileSync(path.join(OUT, 'release-check.json'), JSON.stringify(results, null, 2) + '\n');
}
const failed = results.steps.filter((s) => !s.ok);
if (results.labelsLeft.length) console.log(`release-check: test launchd label(s) still loaded: ${results.labelsLeft.join(', ')}`);
console.log(failed.length ? `\nrelease-check: ${failed.length} step(s) FAILED (${OUT}/release-check.json)` : `\nrelease-check: every step passed for ${BUILD.id} (${OUT}/release-check.json)`);
process.exit(failed.length || results.labelsLeft.length ? 1 : 0);
