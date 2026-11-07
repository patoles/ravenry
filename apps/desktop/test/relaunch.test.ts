// The packaged app started from inside a pane relaunches itself clean
// (src/main/relaunch.ts): which starts do, what the new app's environment
// is, and the loop guard. The helper script runs for real against a stand-in
// open, in a throwaway folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bundleOf, cleanEnv, helperArgs, MARKER_MS, paneVars, readMarker, relaunchPlan, SYSTEM_PATH } from '../src/main/relaunch.ts';

const EXE = '/Applications/Ravenry.app/Contents/MacOS/Ravenry';
// What an agent in a pane has when it runs `open -a Ravenry` (2026-11-07).
const PANE_ENV = {
  HOME: '/Users/you', USER: 'you', LOGNAME: 'you', SHELL: '/bin/zsh', TMPDIR: '/var/folders/x/T/', LANG: 'fr_FR.UTF-8', LC_CTYPE: 'UTF-8',
  __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x1', SSH_AUTH_SOCK: '/private/tmp/launchd/Listeners', TZ: 'Europe/Paris',
  PATH: '/Users/you/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  RAVENRY_PANE: 'pkxhevl6', RAVENRY_SOCKET: '/Users/you/Library/Application Support/Ravenry/run/ravenryd-0.1.14-1.sock',
  TERM_PROGRAM: 'ravenry', TERM_PROGRAM_VERSION: '0.1.14', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  RAVENRY_DRIVER: '/tmp/evil.cjs', RAVENRY_HUB_URL: 'http://127.0.0.1:1', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1',
  NODE_OPTIONS: '--require /tmp/evil.cjs', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', SSH_CONNECTION: '1 2 3 4',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', CMUX_SURFACE_ID: 'x', PWD: '/Users/you/code',
};
const plan = (env: Record<string, string | undefined>, more: Partial<Parameters<typeof relaunchPlan>[0]> = {}) =>
  relaunchPlan({ env, packaged: true, platform: 'darwin', execPath: EXE, marker: null, ...more });

test('a pane variable, either one, is what triggers it', () => {
  assert.deepEqual(paneVars(PANE_ENV), ['RAVENRY_PANE', 'RAVENRY_SOCKET']);
  assert.deepEqual(paneVars({ RAVENRY_SOCKET: '/s' }), ['RAVENRY_SOCKET']);
  assert.deepEqual(paneVars({ RAVENRY_PANE: 'p1' }), ['RAVENRY_PANE']);
  assert.deepEqual(paneVars({ RAVENRY_PANE: '', TERM_PROGRAM: 'ravenry' }), []);
  assert.equal(plan({ RAVENRY_PANE: 'p1' }).relaunch, true);
  assert.equal(plan({ RAVENRY_SOCKET: '/s' }).relaunch, true);
  // TERM_PROGRAM=ravenry alone is not a pane (a terminal's own child may carry it).
  assert.deepEqual(plan({ HOME: '/h', TERM_PROGRAM: 'ravenry' }), { relaunch: false, why: 'clean' });
});

test('only the packaged Mac app, never offscreen or in a test run', () => {
  assert.deepEqual(plan(PANE_ENV, { packaged: false }), { relaunch: false, why: 'not-packaged' });
  assert.deepEqual(plan(PANE_ENV, { platform: 'linux' }), { relaunch: false, why: 'not-macos' });
  assert.deepEqual(plan({ ...PANE_ENV, RAVENRY_OFFSCREEN: '1' }), { relaunch: false, why: 'offscreen' });
  assert.deepEqual(plan({ ...PANE_ENV, RAVENRY_DESKTOP_DATA: '/t/data' }), { relaunch: false, why: 'test-run' });
  assert.deepEqual(plan({ ...PANE_ENV, RAVENRY_SERVICE_LABEL: 'dev.ravenry.hub.test-abcd' }), { relaunch: false, why: 'test-run' });
  assert.deepEqual(plan(PANE_ENV, { execPath: '/usr/local/bin/electron' }), { relaunch: false, why: 'no-bundle' });
});

test('the new app keeps the account variables only, with the system PATH', () => {
  const p = plan(PANE_ENV);
  assert.equal(p.relaunch, true);
  if (!p.relaunch) return;
  assert.equal(p.bundle, '/Applications/Ravenry.app');
  assert.equal(p.background, false);
  assert.deepEqual(p.env, {
    HOME: '/Users/you', USER: 'you', LOGNAME: 'you', SHELL: '/bin/zsh', TMPDIR: '/var/folders/x/T/', LANG: 'fr_FR.UTF-8', LC_CTYPE: 'UTF-8',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x1', SSH_AUTH_SOCK: '/private/tmp/launchd/Listeners', TZ: 'Europe/Paris', PATH: SYSTEM_PATH,
  });
  for (const k of Object.keys(p.env)) assert.doesNotMatch(k, /^(RAVENRY_|ELECTRON_|NODE_|TERM|CLAUDE|SSH_CONNECTION|DYLD_|CMUX_)/);
  assert.deepEqual(p.dropped, [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CMUX_SURFACE_ID', 'COLORTERM', 'DYLD_INSERT_LIBRARIES', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS', 'PWD', 'RAVENRY_DRIVER', 'RAVENRY_HUB_URL', 'RAVENRY_PANE', 'RAVENRY_SOCKET', 'SSH_CONNECTION', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  ]);
  // No variable at all still gets a PATH.
  assert.deepEqual(cleanEnv({}).env, { PATH: SYSTEM_PATH });
});

test('the test opt-in needs the three test folders, keeps only them and the switches that keep it quiet', () => {
  const t = { ...PANE_ENV, RAVENRY_RELAUNCH_TEST: '1', RAVENRY_DESKTOP_DATA: '/t/data', RAVENRY_RUNTIME_DIR: '/t/run', RAVENRY_STATE_DIR: '/t/state', RAVENRY_HUB_URL: 'http://127.0.0.1:9', RAVENRY_SERVICE: 'off', RAVENRY_SERVICE_LABEL: 'dev.ravenry.hub.test-abcd', RAVENRY_UPDATES: '0', RAVENRY_OFFSCREEN: '1' };
  const p = plan(t);
  assert.equal(p.relaunch, true);
  if (!p.relaunch) return;
  assert.equal(p.background, true);
  assert.deepEqual(Object.keys(p.env).filter((k) => k.startsWith('RAVENRY_')).sort(), ['RAVENRY_DESKTOP_DATA', 'RAVENRY_HUB_URL', 'RAVENRY_OFFSCREEN', 'RAVENRY_RUNTIME_DIR', 'RAVENRY_SERVICE', 'RAVENRY_SERVICE_LABEL', 'RAVENRY_STATE_DIR', 'RAVENRY_UPDATES']);
  for (const k of ['RAVENRY_RELAUNCH_TEST', 'RAVENRY_PANE', 'RAVENRY_SOCKET', 'RAVENRY_DRIVER', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.ok(p.dropped.includes(k), k);
  // Without all three folders it is no opt-in: an offscreen test run, which stays.
  assert.deepEqual(plan({ ...t, RAVENRY_STATE_DIR: undefined }), { relaunch: false, why: 'offscreen' });
  assert.deepEqual(plan({ ...t, RAVENRY_STATE_DIR: undefined, RAVENRY_OFFSCREEN: undefined }), { relaunch: false, why: 'test-run' });
  // And without it, those variables go like any other.
  const prod = plan({ ...PANE_ENV, RAVENRY_RUNTIME_DIR: '/t/run', RAVENRY_STATE_DIR: '/t/state' });
  assert.ok(prod.relaunch && !Object.keys(prod.env).some((k) => k.startsWith('RAVENRY_')));
});

test('the loop guard: a relaunch that still has pane variables stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-relaunch-'));
  const file = path.join(dir, 'relaunched-from-pane.json');
  const now = Date.now();
  assert.equal(readMarker(file, now), null);
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: now - 2000, dropped: ['RAVENRY_PANE', 'TERM_PROGRAM'] }));
  const m = readMarker(file, now);
  assert.deepEqual(m, { pid: 4242, at: now - 2000, dropped: ['RAVENRY_PANE', 'TERM_PROGRAM'] });
  assert.deepEqual(plan(PANE_ENV, { marker: m }), { relaunch: false, why: 'loop' });
  // The clean relaunch it was meant for: clean (main.ts logs it with the marker's names).
  assert.deepEqual(plan({ HOME: '/h' }, { marker: m }), { relaunch: false, why: 'clean' });
  // An old marker is a leftover: a later start from a pane relaunches again.
  assert.equal(readMarker(file, now + MARKER_MS + 3000), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(readMarker(file, now), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the bundle comes from the executable path', () => {
  assert.equal(bundleOf('/Users/you/Apps/My Ravenry.app/Contents/MacOS/Ravenry'), '/Users/you/Apps/My Ravenry.app');
  assert.equal(bundleOf('/opt/Ravenry/ravenry'), null);
  assert.equal(bundleOf('/x/Ravenry/Contents/MacOS/Ravenry'), null);
});

test('the helper waits for the old process to be gone, then opens the bundle with no arguments', { skip: process.platform !== 'darwin' && process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-relaunch-'));
  // A stand-in for /usr/bin/open: the script is the helper's own, with open replaced.
  const fakeOpen = path.join(dir, 'open');
  const record = path.join(dir, 'opened.json');
  fs.writeFileSync(fakeOpen, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}.args"\n/usr/bin/env > "${record}.env"\n/bin/date +%s > "${record}.at"\nexit "\${FAKE_OPEN_EXIT:-0}"\n`, { mode: 0o755 });
  const old = spawn('/bin/sleep', ['0.6']);
  const t0 = Date.now();
  const args = helperArgs(old.pid!, '/Apps/Rav en.app', path.join(dir, 'app.log'));
  assert.match(args[1], /\/usr\/bin\/open -n -a "\$2"/);
  args[1] = args[1].replace('/usr/bin/open', fakeOpen);
  const r = spawnSync('/bin/sh', args, { env: { PATH: SYSTEM_PATH, HOME: dir }, encoding: 'utf8' });
  const took = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(took >= 500, `opened ${took} ms in, before the old process was gone`);
  assert.deepEqual(fs.readFileSync(`${record}.args`, 'utf8').trim().split('\n'), ['-n', '-a', '/Apps/Rav en.app']);
  assert.doesNotMatch(fs.readFileSync(`${record}.env`, 'utf8'), /RAVENRY_/);
  // A background (test) relaunch adds -g; a failed open is said in app.log.
  assert.match(helperArgs(1, '/A.app', '/l', true)[1], /open -n -g -a/);
  const failing = helperArgs(999999, '/Apps/R.app', path.join(dir, 'app.log'));
  failing[1] = failing[1].replace('/usr/bin/open', fakeOpen);
  spawnSync('/bin/sh', failing, { env: { PATH: SYSTEM_PATH, FAKE_OPEN_EXIT: '1' } });
  assert.match(fs.readFileSync(path.join(dir, 'app.log'), 'utf8'), /launch: relaunching clean failed: open -a \/Apps\/R.app said no/);
  old.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
