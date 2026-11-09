// A release build takes no test hook from whoever launches it
// (src/main/gate.ts): which variables and switches count, that a release
// removes them and a test build keeps them, and that build.mjs --release
// leaves the driver out of the bundle while a development build keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyGate, controlSwitches, isControlVar, TEST_HOOKS } from '../src/main/gate.ts';
import { cleanEnv } from '../src/main/relaunch.ts';
import { serviceSpec } from '../src/main/install.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What an agent could launch the app with, outside every pane: `env -i ... open -a Ravenry`.
const LAUNCH = {
  HOME: '/Users/you', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
  RAVENRY_DRIVER: '/tmp/x.cjs', RAVENRY_DRIVE: '/tmp/plan.json', RAVENRY_DRIVE_LOG: '1', RAVENRYD: '/tmp/evil-ravenryd',
  RAVENRY_LAUNCHCTL: '/tmp/evil-launchctl', RAVENRY_NEW_SHELL: '/tmp/evil-shell', RAVENRY_TEST_CLIPBOARD: 'rm -rf ~\r', RAVENRY_SETTINGS_IMPORT: '/tmp/t.itermcolors', RAVENRY_TEST_FOLDER: '/tmp/folder',
  MC_PS_BIN: '/tmp/evil-ps', MC_OPEN_COMMAND: '["/tmp/evil"]', STUB_PS_STATE: '/tmp/s.json', FAKE_CMUX_STATE: '/tmp/f.json', CMUX_BIN: '/tmp/evil-cmux', TEST_RAVENRY: '1',
  NODE_OPTIONS: '--require /tmp/x.cjs', NODE_PATH: '/tmp/mods',
  // Settings: where things are and how the window looks.
  RAVENRY_DESKTOP_DATA: '/tmp/data', RAVENRY_RUNTIME_DIR: '/tmp/run', RAVENRY_STATE_DIR: '/tmp/state', RAVENRY_HOME: '/tmp/rh', RAVENRY_HUB_URL: 'http://127.0.0.1:9',
  RAVENRY_SERVICE: 'dry-run', RAVENRY_SERVICE_LABEL: 'dev.ravenry.hub.test-abcd', RAVENRY_UPDATES: '0', RAVENRY_OFFSCREEN: '1', RAVENRY_OPEN_LOG: '/tmp/open.jsonl',
  RAVENRY_THEME: 'dark', RAVENRY_WIDTH: '800', RAVENRY_HEIGHT: '600', ELECTRON_ENABLE_LOGGING: '1', PORT: '4700',
};
const CONTROL = ['CMUX_BIN', 'FAKE_CMUX_STATE', 'MC_OPEN_COMMAND', 'MC_PS_BIN', 'NODE_OPTIONS', 'NODE_PATH', 'RAVENRYD', 'RAVENRY_DRIVE', 'RAVENRY_DRIVER', 'RAVENRY_DRIVE_LOG', 'RAVENRY_LAUNCHCTL', 'RAVENRY_NEW_SHELL', 'RAVENRY_SETTINGS_IMPORT', 'RAVENRY_TEST_CLIPBOARD', 'RAVENRY_TEST_FOLDER', 'STUB_PS_STATE', 'TEST_RAVENRY'];

test('outside a build, the gate is shut: no test hooks', () => {
  assert.equal(TEST_HOOKS, false);
});

test('a release removes every control variable from the environment and keeps the settings', () => {
  const env: Record<string, string | undefined> = { ...LAUNCH };
  const g = applyGate(env, ['/Applications/Ravenry.app/Contents/MacOS/Ravenry'], false);
  assert.deepEqual(g.ignored, CONTROL);
  for (const k of CONTROL) assert.equal(env[k], undefined, k);
  for (const k of Object.keys(LAUNCH).filter((k) => !CONTROL.includes(k))) assert.equal(env[k], LAUNCH[k as keyof typeof LAUNCH], k);
  assert.deepEqual(g.switches, []);
  assert.equal(g.hooks, false);
});

test('a test build keeps everything', () => {
  const env: Record<string, string | undefined> = { ...LAUNCH };
  const g = applyGate(env, ['x', '--remote-debugging-port=9222'], true);
  assert.deepEqual(g, { hooks: true, ignored: [], switches: [] });
  assert.deepEqual(env, LAUNCH);
});

test('what counts as a control variable', () => {
  for (const k of CONTROL) assert.ok(isControlVar(k), k);
  for (const k of ['RAVENRY_DESKTOP_DATA', 'RAVENRY_HUB_URL', 'RAVENRY_SERVICE_LABEL', 'RAVENRY_OFFSCREEN', 'RAVENRY_PANE', 'HOME', 'PATH', 'ELECTRON_RUN_AS_NODE', 'CMUX_SURFACE_ID', 'RAVENRY_DRIVERS']) assert.ok(!isControlVar(k), k);
});

test('debugging and launcher switches, as Chromium reads them', () => {
  assert.deepEqual(controlSwitches(['exe', '--remote-debugging-port=0']), ['remote-debugging-port']);
  assert.deepEqual(controlSwitches(['exe', '-remote-debugging-port=9222', '--inspect', '--inspect-brk=1', '--js-flags=--x']), ['inspect', 'inspect-brk', 'js-flags', 'remote-debugging-port']);
  assert.deepEqual(controlSwitches(['exe', '--Remote-Debugging-Pipe']), ['remote-debugging-pipe']);
  assert.deepEqual(controlSwitches(['exe', '--gpu-launcher=/tmp/x', '--renderer-cmd-prefix=/tmp/y', '--utility-cmd-prefix=/tmp/z', '--browser-subprocess-path=/tmp/w']), ['browser-subprocess-path', 'gpu-launcher', 'renderer-cmd-prefix', 'utility-cmd-prefix']);
  // The executable itself is not a switch; nothing after a bare --.
  assert.deepEqual(controlSwitches(['--inspect']), []);
  assert.deepEqual(controlSwitches(['exe', '--', '--inspect']), []);
  // What a person's start carries, or an AppImage's launcher adds.
  assert.deepEqual(controlSwitches(['exe']), []);
  assert.deepEqual(controlSwitches(['exe', '--no-sandbox', '-psn_0_12345', '/some/file', '--inspector-theme']), []);
  const g = applyGate({}, ['exe', '--inspect=9229'], false);
  assert.deepEqual(g.switches, ['inspect']);
});

test('the relaunch from a pane still names the driver it drops (it reads the launch as it came)', () => {
  const launch = { HOME: '/h', RAVENRY_PANE: 'p1', RAVENRY_SOCKET: '/s', RAVENRY_DRIVER: '/tmp/x.cjs' };
  const env: Record<string, string | undefined> = { ...launch };
  applyGate(env, ['exe'], false);
  const r = cleanEnv(launch);
  assert.ok(r.dropped.includes('RAVENRY_DRIVER'));
  assert.equal(r.env.RAVENRY_DRIVER, undefined);
});

test('after the gate, a test label\'s hub service gets none of the stand-ins', () => {
  const env: Record<string, string | undefined> = { ...LAUNCH };
  applyGate(env, ['exe'], false);
  const staged = { version: '9.9.9', dir: '/d/versions/9.9.9', ravenryd: '/d/versions/9.9.9/ravenryd', hubEntry: '/d/versions/9.9.9/hub/server/index.mjs', link: '/d/bin/ravenryd', build: 'b' };
  const spec = serviceSpec({ execPath: '/A/Ravenry', staged: staged as Parameters<typeof serviceSpec>[0]['staged'], env, platform: 'darwin', home: '/h' });
  for (const k of Object.keys(spec.env)) assert.ok(!isControlVar(k), k);
});

test('build.mjs --release leaves the driver out of main.cjs; a development build keeps it', { timeout: 120000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-gate-build-'));
  const tmp = path.join(root, 'apps', 'desktop');
  try {
    // A copy of the app's sources, so the repository's dist/ is left alone;
    // what they import from beside the app is linked.
    for (const f of ['build.mjs', 'package.json', 'src']) fs.cpSync(path.join(APP, f), path.join(tmp, f), { recursive: true });
    for (const f of ['node_modules', 'hub', 'packages', 'shared']) fs.symlinkSync(path.join(APP, '..', '..', f), path.join(root, f));
    const main = (args: string[]) => { execFileSync(process.execPath, ['build.mjs', ...args], { cwd: tmp, stdio: 'ignore' }); return { js: fs.readFileSync(path.join(tmp, 'dist', 'main.cjs'), 'utf8'), kind: fs.readFileSync(path.join(tmp, '.build-kind'), 'utf8').trim() }; };
    const rel = main(['--release']);
    assert.equal(rel.kind, 'release');
    assert.ok(!rel.js.includes('require(process.env'), 'no require of a path from the environment');
    assert.ok(!rel.js.includes('its test hooks on'));
    assert.ok(rel.js.includes('a release build takes no test hooks'));
    // No package from outside the bundle but electron (NODE_PATH finds nothing to load).
    const bare = [...new Set([...rel.js.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))].filter((m) => !m.startsWith('node:') && !['electron', 'assert', 'buffer', 'child_process', 'constants', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'stream', 'tls', 'tty', 'url', 'util', 'zlib'].includes(m));
    assert.deepEqual(bare, []);
    const dev = main([]);
    assert.equal(dev.kind, 'test-hooks');
    assert.ok(dev.js.includes('require(process.env.RAVENRY_DRIVER)'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
