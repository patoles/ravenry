#!/usr/bin/env node
// The npm package, proved the way a new user gets it: from the TARBALL, not
// this checkout (docs/PUBLISHING.md).
//
//   node tools/package-test.mjs [--shots <dir>] [--keep]
//
// 1. `npm pack --json`: the shape of its output (npm 11 prints an array of
//    one object; npm 12 changed it, so a mismatch prints the raw output and
//    fails rather than guessing), the file list against what may ship, no
//    personal path in a shipped file, and the tarball's size.
// 2. Installs the tarball with `npm i -g --prefix <scratch>` (never the real
//    global folder) and runs the installed `ravenry` with HOME set to a
//    scratch home whose ~/.claude/settings.json holds an unrelated hook that
//    must survive: --version, help, doctor before setup, setup --yes (twice:
//    the second changes nothing), doctor after.
// 3. Starts the installed board on a scratch port (never 4600), screenshots
//    the empty first-run state headless (desktop and 390 phone, light and
//    dark, and the watch-only line with no terminal app), fires a hook event
//    through the command setup wrote into settings.json and waits for its
//    session to show, then stops the board.
// 4. `ravenry uninstall --yes`: settings.json is back to its exact bytes.
// 5. Playwright absent: the scratch install sits outside this repo (whose
//    node_modules holds Playwright), the package resolves no Playwright, the
//    board ran without it, and a mockup round says how to install it.
//
// Scratch: a folder in the OS temp dir (outside the repo, for step 5). The
// real ~/.claude/settings.json and ~/.ravenry/projects.json are hashed
// before and after and must not change. No real osascript, browser or cmux
// is ever run: the board gets the repo's stubs (MC_OSASCRIPT_BIN,
// ITERM_OSASCRIPT_BIN, RAVENRY_OPEN_BIN) and a cmux path that is not there.

// First, like every test: marks this process (its children get an env of
// their own, without the marker, since they are a new user's installed copy).
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SHOTS = opt('--shots');
const KEEP = args.includes('--keep');
const PORT = 4697;
const MAX_TGZ = 512 * 1024;

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + String(info).slice(0, 400) : ''}`); return ok; };
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return 'missing:' + e.code; } };

// The real files this must never write, by the account's home (HOME may be anything).
const REAL_HOME = os.userInfo().homedir;
const REAL = [path.join(REAL_HOME, '.claude', 'settings.json'), path.join(REAL_HOME, '.ravenry', 'projects.json')];
const before = REAL.map(sha);

const W = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ravenry-pkg-'));
const PREFIX = path.join(W, 'prefix');
const HOME = path.join(W, 'home');
const STUBS = path.join(W, 'stubs');
for (const d of [PREFIX, HOME, STUBS]) fs.mkdirSync(d, { recursive: true });
if (path.relative(ROOT, W).split(path.sep)[0] !== '..' || HOME === REAL_HOME) { console.error(`Refused: scratch ${W} must be outside the repo and not the real home.`); process.exit(1); }

// ------------------------------------------------------------ 1. pack
const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', W], { cwd: ROOT, encoding: 'utf8' });
let info = null;
try {
  const j = JSON.parse(packed.stdout);
  if (Array.isArray(j) && j.length === 1 && j[0] && Array.isArray(j[0].files) && typeof j[0].size === 'number' && typeof j[0].filename === 'string') info = j[0];
} catch { /* below */ }
if (!check('npm pack --json: one object with files, size and filename (the npm 11 shape)', !!info)) {
  console.log('Raw npm pack output follows (npm 12 changed this shape):\n' + packed.stdout + packed.stderr);
  process.exit(1);
}
const TGZ = path.join(W, info.filename);
const files = info.files.map((f) => f.path).sort();
const allowed = (p) => /^(bin|server|hooks|public)\//.test(p) || /^brand\/ravenry\/[^/]+\.(png|svg)$/.test(p) || ['tools/open-in-iterm.mjs', 'tools/iterm-board-split.py', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'package.json'].includes(p);
const forbidden = (p) => /(^|\/)(\.tmp|docs|fixtures|candidates|shots)\//.test(p) || /-(test|e2e)\.mjs$/.test(p) || /(^|\/)(stub|fake)-/.test(p);
check('every shipped file is one that runs (bin, server, hooks, public, the iTerm2 opener, icons, README, LICENSE, NOTICE, CHANGELOG)', files.every(allowed), files.filter((p) => !allowed(p)).join(' '));
check('no test, fixture, docs, .tmp or brand candidate ships', !files.some(forbidden), files.filter(forbidden).join(' '));
check('the bin, the hooks, the board and its page are in', ['bin/ravenry.mjs', 'hooks/events.mjs', 'hooks/handoff-stop.mjs', 'server/index.mjs', 'server/hookinstall.mjs', 'public/index.html', 'public/app.js', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md'].every((f) => files.includes(f)));
check(`tarball under ${MAX_TGZ / 1024} KB`, info.size < MAX_TGZ, `${(info.size / 1024).toFixed(1)} KB packed, ${(info.unpackedSize / 1024).toFixed(1)} KB unpacked, ${files.length} files`);
const personal = [];
for (const f of files) {
  const t = fs.readFileSync(path.join(ROOT, f));
  if (/\.(png|ico)$/.test(f)) continue;
  if (t.includes(REAL_HOME + '/')) personal.push(`${f}: ${REAL_HOME}/`);
  for (const m of t.toString('utf8').matchAll(/\/Users\/(?!(?:x|old|you|me|example|Shared)\/)[A-Za-z0-9._-]+\//g)) personal.push(`${f}: ${m[0]}`);
}
check('no personal path (this home or any other /Users/<name>/) in a shipped file', !personal.length, personal.join('; '));
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('package.json: bin, os darwin, engines, Apache-2.0, no runtime dependencies', pkgJson.bin && pkgJson.bin.ravenry === 'bin/ravenry.mjs' && JSON.stringify(pkgJson.os) === '["darwin"]' && pkgJson.engines && pkgJson.engines.node && pkgJson.license === 'Apache-2.0' && !pkgJson.dependencies && !pkgJson.optionalDependencies);

// ------------------------------------------------------------ 2. install and setup
const STUB_OSA = path.join(ROOT, 'tools', 'stub-osascript.mjs');
const STUB_OPEN = path.join(ROOT, 'tools', 'stub-open.mjs');
fs.writeFileSync(path.join(STUBS, 'claude'), '#!/bin/sh\necho "stub claude: the package test never runs Claude" >&2\nexit 1\n', { mode: 0o755 });
const env = {
  HOME, USER: os.userInfo().username, LANG: 'en_US.UTF-8', TMPDIR: W + '/',
  PATH: [path.join(PREFIX, 'bin'), STUBS, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  // A plain terminal: not cmux, not iTerm2.
  TERM_PROGRAM: 'Apple_Terminal', TERM_SESSION_ID: 'pkg-test',
  PORT: String(PORT), npm_config_cache: path.join(W, 'npm-cache'), npm_config_update_notifier: 'false',
  CMUX_BIN: path.join(W, 'no-cmux'), MC_OSASCRIPT_BIN: STUB_OSA, ITERM_OSASCRIPT_BIN: STUB_OSA, STUB_OSASCRIPT_LOG: path.join(W, 'osascript.log'),
  RAVENRY_OPEN_BIN: STUB_OPEN, STUB_OPEN_LOG: path.join(W, 'open.log'), GIT_CEILING_DIRECTORIES: W,
};
const run = (cmd, a, extra = {}) => spawnSync(cmd, a, { cwd: HOME, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000 });

const inst = run('npm', ['i', '-g', '--prefix', PREFIX, '--offline', '--no-audit', '--no-fund', TGZ]);
const BIN = path.join(PREFIX, 'bin', 'ravenry');
const PKG_DIR = path.join(PREFIX, 'lib', 'node_modules', 'ravenry-app');
check('npm i -g --prefix <scratch> <tarball> installs the ravenry command', inst.status === 0 && fs.existsSync(BIN) && fs.existsSync(path.join(PKG_DIR, 'hooks', 'events.mjs')), inst.stderr.trim().split('\n').pop());

const SETTINGS = path.join(HOME, '.claude', 'settings.json');
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
const ORIGINAL = JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unrelated-hook' }] }], Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-tool stop' }] }] } }, null, 2) + '\n';
fs.writeFileSync(SETTINGS, ORIGINAL);

const out = {};
const rv = (name, a, extra) => { const r = run(BIN, a, extra); out[name] = (r.stdout || '') + (r.stderr || ''); return r; };
let r = rv('version', ['--version']);
check('ravenry --version', r.status === 0 && r.stdout.trim() === pkgJson.version, r.stdout.trim());
r = rv('help', ['help']);
check('ravenry help lists setup, doctor and uninstall', r.status === 0 && /ravenry setup/.test(r.stdout) && /ravenry doctor/.test(r.stdout) && /ravenry uninstall/.test(r.stdout));
r = rv('doctor-before', ['doctor']);
check('doctor before setup: says the hooks are not installed, exits 1', r.status === 1 && /Hooks: not installed/.test(r.stdout), r.stdout.split('\n').filter((l) => /fix/.test(l)).join(' | '));
r = rv('setup', ['setup', '--yes']);
const s1 = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const cmdsOf = (s, ev) => (s.hooks[ev] || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
const hookCmd = `${process.execPath} ${path.join(PKG_DIR, 'hooks', 'events.mjs')}`;
check('setup --yes: exits 0 and shows the entries before writing', r.status === 0 && /Setup adds only these entries/.test(r.stdout) && r.stdout.indexOf('"SessionStart"') < r.stdout.indexOf('Hooks installed'), r.stdout.split('\n').slice(-6).join(' | '));
check('setup: events hook on its five events and the hand-off hook on Stop, by absolute paths into the installed copy', ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop'].every((ev) => cmdsOf(s1, ev).some((c) => c.endsWith(path.join(PKG_DIR, 'hooks', 'events.mjs')) && path.isAbsolute(c.split(' ')[0]))) && cmdsOf(s1, 'Stop').some((c) => c.endsWith(path.join(PKG_DIR, 'hooks', 'handoff-stop.mjs'))), cmdsOf(s1, 'SessionStart').join(' '));
check('setup: the unrelated hooks and settings are untouched', s1.model === 'sonnet' && JSON.stringify(s1.hooks.PreToolUse) === JSON.stringify(JSON.parse(ORIGINAL).hooks.PreToolUse) && JSON.stringify(s1.hooks.Stop[0]) === JSON.stringify(JSON.parse(ORIGINAL).hooks.Stop[0]));
check('setup: a backup of the file as it was', fs.readdirSync(path.dirname(SETTINGS)).some((f) => f.startsWith('settings.json.bak-') && fs.readFileSync(path.join(path.dirname(SETTINGS), f), 'utf8') === ORIGINAL));
const setupRec = JSON.parse(fs.readFileSync(path.join(HOME, '.ravenry', 'setup.json'), 'utf8'));
check('setup: ~/.ravenry made, setup.json written, rule suggestions left off by --yes', setupRec.hooks === 'installed' && setupRec.rulesAuto === false && JSON.parse(fs.readFileSync(path.join(HOME, '.ravenry', 'projects.json'), 'utf8')).settings.repeatsAuto === false);
const afterFirst = fs.readFileSync(SETTINGS, 'utf8');
r = rv('setup-again', ['setup', '--yes']);
check('setup again: changes nothing', r.status === 0 && /Hooks: both are in/.test(r.stdout) && fs.readFileSync(SETTINGS, 'utf8') === afterFirst);
r = rv('doctor', ['doctor']);
check('doctor after setup: all good (exit 0), hooks ok, Playwright optional and absent', r.status === 0 && /Hooks: both in/.test(r.stdout) && /Playwright: not installed/.test(r.stdout), r.stdout.split('\n').filter((l) => /^\s+(fix|note)/.test(l)).join(' | '));

// A stale hook (a Node that is gone): doctor names it, setup fixes it.
const stale = JSON.parse(afterFirst);
for (const e of stale.hooks.Notification) for (const h of e.hooks) if (h.command.includes('events.mjs')) h.command = `/gone/node ${path.join(PKG_DIR, 'hooks', 'events.mjs')}`;
fs.writeFileSync(SETTINGS, JSON.stringify(stale, null, 2) + '\n');
r = rv('doctor-stale', ['doctor']);
check('doctor: a hook whose Node is gone is named as stale, exit 1', r.status === 1 && /events\.mjs on Notification is stale: its Node \(\/gone\/node\) is not there any more/.test(r.stdout));
r = rv('setup-fix', ['setup', '--yes']);
check('setup: points the stale hook at this Node again', r.status === 0 && fs.readFileSync(SETTINGS, 'utf8') === afterFirst);

// ------------------------------------------------------------ 3. the board
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function getState(port) { try { const x = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) }); return await x.json(); } catch { return null; } }
async function startBoard(port, extra = {}) {
  const log = fs.openSync(path.join(W, `board-${port}.log`), 'a');
  const child = spawn(BIN, ['--no-open'], { cwd: HOME, env: { ...env, PORT: String(port), ...extra }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 80; i++) { const s = await getState(port); if (s && s.generatedAt) return { child, s }; await sleep(250); }
  return { child, s: null };
}
async function stopBoard(b) { if (!b || !b.child) return; b.child.kill('SIGTERM'); for (let i = 0; i < 40 && b.child.exitCode == null && b.child.signalCode == null; i++) await sleep(100); }

const board = await startBoard(PORT);
check(`the installed board starts on :${PORT} (without Playwright) and answers`, !!board.s, fs.readFileSync(path.join(W, `board-${PORT}.log`), 'utf8').split('\n').slice(-4).join(' | '));
const s0 = board.s || {};
check('first run: no projects, iTerm2 mode outside cmux, hooks ok, no error', (s0.projects || []).length === 0 && s0.board && s0.board.kind === 'iterm' && s0.hooks === 'ok' && !s0.error, JSON.stringify({ n: (s0.projects || []).length, board: s0.board, hooks: s0.hooks, error: s0.error }));
check('board.json names the port, for the hook', JSON.parse(fs.readFileSync(path.join(HOME, '.ravenry', 'board.json'), 'utf8')).port === PORT);
const startLog = fs.readFileSync(path.join(W, `board-${PORT}.log`), 'utf8');
check('start printed where the board is and how to stop it', /Starting Ravenry on http:\/\/localhost:4697\//.test(startLog) && /Ctrl\+C stops it/.test(startLog));

let pw = null;
try { pw = await import('playwright'); } catch { /* shots need the repo's Playwright */ }
const shot = async (port, name, w, h, theme, mobile, wait) => {
  if (!SHOTS || !pw) return null;
  const ctx = await browserP.then((b) => b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: theme }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`);
  await page.waitForFunction(wait || (() => !!document.querySelector('#sheet .empty')), null, { timeout: 15000 }).catch(() => errs.push('wait timed out'));
  await page.waitForTimeout(500);
  const text = await page.evaluate(() => document.querySelector('#sheet').innerText);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const file = path.join(SHOTS, name + '.png');
  await page.screenshot({ path: file });
  await ctx.close();
  return { file, text, errs, wide };
};
let browserP = null;
if (SHOTS && pw) { fs.mkdirSync(SHOTS, { recursive: true }); browserP = pw.chromium.launch({ headless: true }); }
if (SHOTS && pw) {
  for (const [name, w, h, theme, mobile] of [['first-run-desktop-light', 1440, 900, 'light', false], ['first-run-desktop-dark', 1440, 900, 'dark', false], ['first-run-phone-light', 390, 844, 'light', true], ['first-run-phone-dark', 390, 844, 'dark', true]]) {
    const x = await shot(PORT, name, w, h, theme, mobile);
    check(`shot ${name}: the first-run empty state, no page error, no sideways scroll`, x && /No Claude Code sessions yet/.test(x.text) && !x.errs.length && !x.wide, x && (x.errs.join('; ') || x.file));
  }
}

// A hook event through the command setup wrote, as Claude Code runs it.
const PROJ = path.join(HOME, 'Projects', 'demo-app');
fs.mkdirSync(PROJ, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: PROJ, env });
const SID = 'pkgtest-0001-4a1b-8c2d-000000000001';
const TDIR = path.join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9-]/g, '-'));
fs.mkdirSync(TDIR, { recursive: true });
const TRANSCRIPT = path.join(TDIR, SID + '.jsonl');
fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, cwd: PROJ, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add a dark mode toggle to the settings page.' } }) + '\n');
const installed = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const fire = (ev, extra = {}) => {
  const c = cmdsOf(installed, ev).find((x) => x.endsWith(path.join(PKG_DIR, 'hooks', 'events.mjs')));
  const t0 = Date.now();
  const x = spawnSync('/bin/sh', ['-c', c], { cwd: PROJ, env, input: JSON.stringify({ hook_event_name: ev, session_id: SID, cwd: PROJ, transcript_path: TRANSCRIPT, ...extra }), encoding: 'utf8', timeout: 5000 });
  return { ...x, ms: Date.now() - t0 };
};
const f1 = fire('SessionStart', { source: 'startup' });
const f2 = fire('UserPromptSubmit', { prompt: 'Add a dark mode toggle to the settings page.' });
check('the installed hook command runs from sh, silent, exit 0', f1.status === 0 && f2.status === 0 && !f1.stdout && !f2.stdout, `${f1.ms} ms, ${f2.ms} ms`);
const evFile = path.join(HOME, '.ravenry', 'events', SID + '.jsonl');
check('the hook wrote its events into ~/.ravenry/events', fs.existsSync(evFile) && fs.readFileSync(evFile, 'utf8').trim().split('\n').length === 2);
let seen = null;
for (let i = 0; i < 40 && !seen; i++) {
  const s = await getState(PORT);
  const p = s && (s.projects || []).find((x) => (x.sessions || []).some((y) => y.sessionId === SID) || x.folder === PROJ);
  if (p) seen = p;
  else await sleep(500);
}
check('the session shows on the board, in a project of its folder', !!seen, seen ? `${seen.name}: ${seen.folder}` : 'not seen in 20 s');
if (SHOTS && pw) {
  const x = await shot(PORT, 'after-hook-desktop-light', 1440, 900, 'light', false, () => !!document.querySelector('#list .row'));
  check('shot after the hook event: the project in the list', x && !x.errs.length, x && (x.errs.join('; ') || x.file));
}
await stopBoard(board);
check('board.json is removed when the board stops', !fs.existsSync(path.join(HOME, '.ravenry', 'board.json')));
check('no real osascript or browser was asked: stub logs only', true, `osascript calls ${fs.existsSync(env.STUB_OSASCRIPT_LOG) ? fs.readFileSync(env.STUB_OSASCRIPT_LOG, 'utf8').trim().split('\n').length : 0}, open calls ${fs.existsSync(env.STUB_OPEN_LOG) ? fs.readFileSync(env.STUB_OPEN_LOG, 'utf8').trim().split('\n').length : 0}`);

// The same first run on a Mac with neither cmux nor iTerm2: watch only, one line.
const none = await startBoard(PORT + 1, { MC_APPS: 'none', HOME: path.join(W, 'home-none') }).catch(() => null);
if (none && none.s) {
  check('no terminal app: the board still runs, iTerm2 mode, marked not installed', none.s.board && none.s.board.installed === false);
  if (SHOTS && pw) {
    const x = await shot(PORT + 1, 'first-run-no-terminal-desktop-light', 1440, 900, 'light', false, () => /Get iTerm2/.test(document.querySelector('#sheet').innerText));
    check('shot with no terminal app: the one-line iTerm2 suggestion and the setup line', x && /Watch only: answering from the board needs iTerm2/.test(x.text) && /ravenry setup/.test(x.text), x && x.text.replace(/\s+/g, ' ').slice(0, 300));
    const y = await shot(PORT + 1, 'first-run-no-terminal-phone-dark', 390, 844, 'dark', true, () => /Get iTerm2/.test(document.querySelector('#sheet').innerText));
    check('shot with no terminal app at 390: no sideways scroll', y && !y.wide && !y.errs.length);
  }
}
await stopBoard(none);
if (browserP) await (await browserP).close();

// ------------------------------------------------------------ 4. uninstall
r = rv('uninstall', ['uninstall', '--yes']);
const back = fs.readFileSync(SETTINGS, 'utf8');
check('uninstall --yes: settings.json is back to its exact original bytes', r.status === 0 && back === ORIGINAL, r.stdout.split('\n')[0]);
check('uninstall: ~/.ravenry stays (no --purge)', fs.existsSync(path.join(HOME, '.ravenry', 'projects.json')) && /stays in/.test(r.stdout));
r = rv('uninstall-again', ['uninstall', '--yes']);
check('uninstall again: nothing to take out', r.status === 0 && /nothing to take out/.test(r.stdout) && fs.readFileSync(SETTINGS, 'utf8') === ORIGINAL);

// ------------------------------------------------------------ 5. Playwright absent
const res = run(process.execPath, ['--input-type=module', '-e', "try { await import('playwright'); console.log('found'); } catch { console.log('absent'); }"], {});
const resIn = spawnSync(process.execPath, ['--input-type=module', '-e', "try { await import('playwright'); console.log('found'); } catch { console.log('absent'); }"], { cwd: PKG_DIR, env, encoding: 'utf8' });
check('Playwright cannot be resolved from the installed package', resIn.stdout.trim() === 'absent' && res.stdout.trim() === 'absent', resIn.stdout.trim());
const mk = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${path.join(PKG_DIR, 'server', 'mockups.mjs')}').then((m) => m.render([])).then(() => console.log('rendered'), (e) => console.log(e.message))`], { cwd: PKG_DIR, env, encoding: 'utf8' });
check('a mockup round without Playwright says how to install it', /need Playwright.*npm i -g playwright/.test(mk.stdout), mk.stdout.trim());

// ------------------------------------------------------------ safety
const after = REAL.map(sha);
REAL.forEach((f, i) => check(`real ${f.replace(REAL_HOME, '~')} unchanged`, before[i] === after[i]));

console.log(`\ntarball: ${info.filename}, ${(info.size / 1024).toFixed(1)} KB packed, ${(info.unpackedSize / 1024).toFixed(1)} KB unpacked, ${files.length} files`);
fs.writeFileSync(path.join(W, 'outputs.json'), JSON.stringify(out, null, 2));
console.log(`outputs: ${path.join(W, 'outputs.json')}`);
if (!KEEP && !fails) fs.rmSync(W, { recursive: true, force: true });
else console.log(`scratch kept: ${W}`);
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
