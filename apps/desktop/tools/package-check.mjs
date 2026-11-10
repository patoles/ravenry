#!/usr/bin/env node
// Checks a packaged app: what is inside it, and, when it runs on this
// machine, the app itself. Never on screen, never the user's own files:
// a throwaway HOME, app data folder and daemon runtime folder, and the hub
// service written in dry-run mode into the throwaway HOME only (no launchd
// or systemd command runs).
//
//   node tools/package-check.mjs APP [OUT] [--old-ravenryd BIN] [--contents-only]
//                                [--all-builds]
//
// APP is Ravenry.app, a .dmg (mounted with hdiutil, never in Finder), a
// .zip, a linux-unpacked folder, a .deb (unpacked with dpkg-deb) or an
// AppImage (run with APPIMAGE_EXTRACT_AND_RUN=1, so no FUSE is needed).
// --contents-only checks what is inside only; so does an app for another
// platform or architecture than this machine's.
//
// 1. Contents: ravenryd (its version, platform and architecture match the
//    app's; static on Linux), the builds it installs on other machines
//    (remote/builds.json, each binary's SHA-256; --all-builds wants all
//    four), the hub and its node client, build.json, app-update.yml; on
//    macOS the code signature.
//    A release build: its main.cjs has no test hooks (src/main/gate.ts),
//    and its executable's fuses turn NODE_OPTIONS and --inspect off and
//    keep ELECTRON_RUN_AS_NODE (the hub service runs on it); on macOS the
//    hardened runtime, ad hoc too, so DYLD_ variables load nothing.
// 2. The app, offscreen, as it is (a release takes no driver): it must
//    copy its own ravenryd out of the app and start it, and its window
//    must open a shell there (the daemon's pane list says so). It is
//    started with what an agent could add (RAVENRY_DRIVER, RAVENRYD,
//    RAVENRY_LAUNCHCTL, NODE_OPTIONS), and none of it may run; started
//    with --remote-debugging-port or --inspect, it must quit at once with
//    no port open. With --old-ravenryd, an older ravenryd runs first with
//    a pane in it, as after an update: the app's ravenryd must start
//    beside it, and the old one must keep its pane. (The window's steps,
//    typing, paste, tabs, run on a test build: tools/smoke.mjs, and
//    tools/release-check.mjs on the test twin.)
// 3. The hub service file the app wrote, then the hub run exactly as it
//    says (the app's executable as Node, with --disable-sigusr1), on a
//    spare port: it must answer, open no inspector on SIGUSR1, stop
//    cleanly on SIGTERM, and leave every daemon running.
import { guardSpawns, isTestPath, withStubMachine } from '../../../tools/test-env.mjs';
import { track, release, removeTree, checkLeft } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { stopDaemons } from './run-app.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const OLD = opt('--old-ravenryd');
const CONTENTS_ONLY = argv.includes('--contents-only');
const ALL_BUILDS = argv.includes('--all-builds');
const pos = argv.filter((a) => !a.startsWith('--'));
if (!pos[0]) { console.error('usage: package-check.mjs APP [OUT] [--old-ravenryd BIN] [--contents-only]'); process.exit(2); }
const APP_PATH = path.resolve(pos[0]);
const OUT = path.resolve(pos[1] || path.join(os.tmpdir(), 'ravenry-package-check'));
// (The app copy a run before left in it out of LaunchServices' list first.)
removeTree(OUT);
fs.mkdirSync(OUT, { recursive: true });

guardSpawns();
// Every folder a ravenryd, hub or app of this check uses is a test's
// (tools/test-env.mjs): OUT when it is one (a test root, a .tmp of the
// repository, or outside the user's folders), else a fresh folder in the
// system's temporary folder. OUT keeps the results and logs either way. A
// CI runner's own temp folder sits inside its home, so OUT there is not one
// unless RAVENRY_TEST_ROOT names it.
const SCRATCH = isTestPath(OUT) ? OUT : fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'ravenry-check-'));
if (!isTestPath(SCRATCH)) { console.error(`check: no test folder for ravenryd: ${OUT} and ${SCRATCH} are both in the user's own folders; set RAVENRY_TEST_ROOT`); process.exit(1); }
if (SCRATCH !== OUT) fs.writeFileSync(path.join(OUT, 'scratch.txt'), `ravenryd, the hub and the app ran in ${SCRATCH}\n`);
// What the checks before the app run (extracting an AppImage, ravenryd
// version) run with: throwaway folders, never the real user's.
const PRE = path.join(SCRATCH, '.pre');
const preEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(PRE, 'home'), LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: path.join(PRE, 'run'), RAVENRY_STATE_DIR: path.join(PRE, 'state'), RAVENRY_DESKTOP_DATA: path.join(PRE, 'data') };

const results = [];
const cleanups = [];
// The copy this check makes of a .dmg's or .zip's app (it runs it), taken
// out of LaunchServices' list before it is unmounted or removed, whatever
// happens (tools/launchservices.mjs).
let copied = null;
const ok = (what) => { results.push(`ok    ${what}`); console.log(`check: ok    ${what}`); };
const fail = (what) => { throw new Error(what); };
// A failure outside the app run (the contents) still unmounts and says why.
process.on('uncaughtException', (e) => { console.error('check: FAILED\n' + (e.stack || e)); finish(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goarch = (a) => (a === 'x64' ? 'amd64' : a);

// ------------------------------------------------------------- the layout

const X = path.join(OUT, '.extract');
fs.mkdirSync(X, { recursive: true });
let target = APP_PATH;
if (APP_PATH.endsWith('.dmg')) {
  const mnt = path.join(OUT, '.mnt');
  fs.mkdirSync(mnt, { recursive: true });
  copied = track(mnt);
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, APP_PATH], { stdio: 'ignore' });
  cleanups.push(() => spawnSync('hdiutil', ['detach', mnt, '-quiet']));
  target = path.join(mnt, 'Ravenry.app');
  ok(`${path.basename(APP_PATH)} mounted (hdiutil, no Finder window)`);
} else if (APP_PATH.endsWith('.zip')) {
  copied = track(X);
  execFileSync('ditto', ['-x', '-k', APP_PATH, X]);
  target = path.join(X, 'Ravenry.app');
} else if (APP_PATH.endsWith('.deb')) {
  execFileSync('dpkg-deb', ['-x', APP_PATH, X]);
  target = path.join(X, 'opt', 'Ravenry');
  const info = execFileSync('dpkg-deb', ['-f', APP_PATH, 'Package', 'Version', 'Architecture'], { encoding: 'utf8' }).trim().replace(/\n/g, ', ');
  ok(`${path.basename(APP_PATH)}: ${info}`);
}
const isAppImage = target.endsWith('.AppImage');
let resources, exe, platform;
if (target.endsWith('.app')) {
  platform = 'darwin';
  resources = path.join(target, 'Contents', 'Resources');
  exe = path.join(target, 'Contents', 'MacOS', 'Ravenry');
} else if (isAppImage) {
  platform = 'linux';
  fs.chmodSync(target, 0o755);
  // Only an AppImage of this machine's architecture extracts itself.
  const r = spawnSync(target, ['--appimage-extract'], { cwd: X, stdio: 'ignore', env: { ...preEnv, APPIMAGE_EXTRACT_AND_RUN: '' } });
  if (r.status !== 0) fail(`${path.basename(target)} did not extract itself on this machine (${process.arch})`);
  resources = path.join(X, 'squashfs-root', 'resources');
  exe = target;
} else {
  platform = 'linux';
  resources = path.join(target, 'resources');
  exe = path.join(target, 'ravenry');
}
if (!fs.existsSync(exe)) fail(`no executable at ${exe}`);

// ------------------------------------------------------------- 1. contents

const build = JSON.parse(fs.readFileSync(path.join(resources, 'build.json'), 'utf8'));
ok(`build.json: ${build.id}`);
// The app's id, the same on every platform (Android's applicationId too).
const APP_ID = 'dev.ravenry.app';
if (platform === 'darwin') {
  const id = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(target, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (id !== APP_ID) fail(`the bundle id is ${id}, not ${APP_ID}`);
  ok(`bundle id ${id}`);
} else {
  const desktop = APP_PATH.endsWith('.deb')
    ? path.join(X, 'usr', 'share', 'applications', `${APP_ID}.desktop`)
    : isAppImage ? path.join(X, 'squashfs-root', `${APP_ID}.desktop`) : null;
  if (desktop) {
    if (!fs.existsSync(desktop)) fail(`no ${APP_ID}.desktop in the package`);
    const t = fs.readFileSync(desktop, 'utf8');
    if (!new RegExp(`^StartupWMClass=${APP_ID.replace(/\./g, '\\.')}$`, 'm').test(t)) fail(`${APP_ID}.desktop does not say StartupWMClass=${APP_ID}`);
    ok(`desktop id ${APP_ID} (${path.basename(desktop)}, StartupWMClass=${APP_ID})`);
  }
}
const bundled = path.join(resources, 'ravenryd');
if (!fs.existsSync(bundled)) fail(`no ravenryd in ${resources}`);
fs.accessSync(bundled, fs.constants.X_OK);
const fileType = execFileSync('file', ['-b', bundled], { encoding: 'utf8' }).trim();
let bundledArch = null;
if (platform === 'linux') {
  if (!/statically linked|static-pie linked/.test(fileType)) fail(`ravenryd is not static: ${fileType}`);
  bundledArch = /x86-64/.test(fileType) ? 'x64' : /aarch64|ARM aarch64/.test(fileType) ? 'arm64' : null;
} else {
  bundledArch = /arm64/.test(fileType) ? 'arm64' : /x86_64/.test(fileType) ? 'x64' : null;
}
ok(`ravenryd: ${fileType}`);
const runsHere = process.platform === platform && bundledArch === process.arch;
if (runsHere) {
  const v = JSON.parse(execFileSync(bundled, ['version', '--json'], { env: preEnv, encoding: 'utf8' }));
  if (v.version !== build.version || v.os !== platform || v.arch !== goarch(bundledArch)) fail(`ravenryd ${JSON.stringify(v)} does not match the app ${build.version} ${platform}/${bundledArch}`);
  ok(`ravenryd version ${v.version} ${v.os}/${v.arch}, libghostty-vt ${v.libghostty_vt}`);
}
{
  // The builds for other machines: the app's version, each one whole.
  let rb = null;
  try { rb = JSON.parse(fs.readFileSync(path.join(resources, 'remote', 'builds.json'), 'utf8')); } catch (e) { fail(`no remote/builds.json in the app: ${e.message}`); }
  if (rb.version !== build.version) fail(`remote/builds.json is ${rb.version}; the app is ${build.version}`);
  const keys = Object.keys(rb.builds || {}).sort();
  for (const k of keys) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(resources, 'remote', rb.builds[k].file)));
    if (crypto.createHash('sha256').update(raw).digest('hex') !== rb.builds[k].sha256 || raw.length !== rb.builds[k].size) fail(`remote/${rb.builds[k].file} does not match its SHA-256 or size`);
  }
  if (bundledArch && !keys.includes(`${platform}-${bundledArch}`)) fail(`remote/builds.json has no ${platform}-${bundledArch}: ${keys.join(', ')}`);
  if (ALL_BUILDS && keys.join(',') !== 'darwin-arm64,darwin-x64,linux-arm64,linux-x64') fail(`remote/builds.json has ${keys.join(', ')}, not all four`);
  ok(`builds for other machines: ${keys.join(', ')} (${rb.version}), each matching its SHA-256`);
}
for (const f of ['hub/server/index.mjs', 'hub/hooks/events.mjs', 'hub/public/index.html', 'hub/package.json', 'hub/node_modules/@ravenry/node-client/index.mjs', 'hub/server/vendor/page-format.mjs', 'hub/pages/defaults/objectives.page.yaml']) {
  if (!fs.existsSync(path.join(resources, f))) fail(`no ${f} in the app`);
}
ok('the hub, with @ravenry/node-client');
const upd = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
if (!/^provider: github$/m.test(upd) || !/^owner: \S+$/m.test(upd) || !/^repo: \S+$/m.test(upd)) fail(`app-update.yml: ${upd}`);
ok(`app-update.yml: ${upd.split('\n').filter((l) => /^(provider|owner|repo):/.test(l)).join(', ')}`);
if (platform === 'darwin') {
  const sig = spawnSync('codesign', ['-dv', target], { encoding: 'utf8' }).stderr;
  const authority = (sig.match(/^Authority=(.*)$/m) || [])[1];
  const adhoc = /Signature=adhoc/.test(sig);
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', target], { encoding: 'utf8' });
  if (verify.status !== 0) fail(`codesign --verify: ${verify.stderr}`);
  ok(`signature valid: ${adhoc ? 'ad hoc (UNSIGNED build)' : authority}`);
  // The hardened runtime, ad hoc too: dyld ignores DYLD_INSERT_LIBRARIES
  // and the other DYLD_ variables whoever starts the app sets.
  const flags = parseInt((sig.match(/flags=0x([0-9a-f]+)/) || [])[1] || '0', 16);
  const ents = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', target], { encoding: 'utf8' }).stdout || '';
  if (!(flags & 0x10000)) fail(`not signed with the hardened runtime (flags 0x${flags.toString(16)}): DYLD_ variables would load code into the app`);
  if (ents.includes('allow-dyld-environment-variables')) fail('its entitlements allow DYLD_ variables');
  ok(`hardened runtime (flags 0x${flags.toString(16)}), no DYLD_ variables allowed`);
  // What the hardened runtime would refuse without asking: a program in a
  // pane wanting the microphone or the camera (macOS asks on the app's
  // behalf), and the hub's osascript (iTerm2, cmux, notifications). Each
  // needs its entitlement and, to be asked at all, its words in Info.plist.
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(target, 'Contents', 'Info.plist')], { encoding: 'utf8' }));
  const needs = [
    ['com.apple.security.automation.apple-events', 'NSAppleEventsUsageDescription'],
    ['com.apple.security.device.audio-input', 'NSMicrophoneUsageDescription'],
    ['com.apple.security.device.camera', 'NSCameraUsageDescription'],
    ['com.apple.security.personal-information.location', 'NSLocationUsageDescription'],
    ['com.apple.security.personal-information.addressbook', 'NSContactsUsageDescription'],
    ['com.apple.security.personal-information.calendars', 'NSCalendarsUsageDescription'],
    ['com.apple.security.personal-information.photos-library', 'NSPhotoLibraryUsageDescription'],
  ];
  const entTrue = (k) => new RegExp(`<key>${k.replace(/\./g, '\\.')}</key>\\s*<true/>`).test(ents);
  const missing = needs.filter(([e, k]) => !entTrue(e) || !(typeof info[k] === 'string' && info[k].length > 10)).map(([e, k]) => `${e} / ${k}`);
  if (missing.length) fail(`a hardened app refuses these without asking (entitlement / Info.plist words): ${missing.join(', ')}`);
  ok(`the microphone, the camera, Apple events (osascript) and the rest can be asked for: ${needs.length} entitlements, each with its words in Info.plist`);
  // The hub (the app's executable run as Node, hardened) still runs
  // osascript, which its iTerm2 adapter and its notifications use. A script
  // that sends no Apple event, so nothing on the machine is asked.
  const osa = spawnSync(exe, ['-e', "const r = require('child_process').spawnSync('/usr/bin/osascript', ['-e', 'return 2 + 2'], { encoding: 'utf8' }); process.stdout.write(String(r.status) + ' ' + r.stdout.trim())"], { env: { HOME: os.tmpdir(), PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 });
  if ((osa.stdout || '').trim() !== '0 4') fail(`the hardened hub could not run osascript: ${osa.stdout} ${osa.stderr}`);
  ok('the hardened hub runs osascript (iTerm2, notifications)');
}

{
  // A release build: no test hooks in the app's code (src/main/gate.ts).
  // app.asar keeps each file whole, so its bytes are searched as they are.
  const asar = fs.readFileSync(path.join(resources, 'app.asar'));
  const has = (t) => asar.includes(Buffer.from(t));
  if (has('require(process.env.RAVENRY_DRIVER)') || has('its test hooks on')) fail('app.asar is a test build: it loads RAVENRY_DRIVER (a release is packed with build.mjs --release; the test twin is in release-test/)');
  if (!has('a release build takes no test hooks')) fail('app.asar has no release gate (src/main/gate.ts)');
  ok('a release build: no driver and no test hooks in app.asar');
  // Electron's fuses (electron-builder.config.mjs), read from the binary
  // that holds them: each copy (both halves of a universal binary).
  const fuseBin = platform === 'darwin' ? path.join(target, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework') : isAppImage ? path.join(X, 'squashfs-root', 'ravenry') : exe;
  const fuses = readFuses(fs.readFileSync(fuseBin));
  if (!fuses.length) fail(`no Electron fuses in ${fuseBin}`);
  for (const f of fuses) {
    if (f.runAsNode !== '1') fail(`the RunAsNode fuse is ${f.runAsNode}: the hub service runs the app's executable as Node`);
    if (f.nodeOptions !== '0') fail(`the NODE_OPTIONS fuse is ${f.nodeOptions}, not off`);
    if (f.inspect !== '0') fail(`the --inspect fuse is ${f.inspect}, not off`);
  }
  ok(`fuses (${fuses.length} cop${fuses.length === 1 ? 'y' : 'ies'}): ELECTRON_RUN_AS_NODE on, NODE_OPTIONS off, --inspect off`);
}

// Electron's fuse wire: a sentinel, a version byte (1), a length, then one
// byte per fuse ('0' off, '1' on, 'r' removed) in FuseV1Options order.
function readFuses(buf) {
  const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const out = [];
  for (let i = buf.indexOf(SENTINEL); i >= 0; i = buf.indexOf(SENTINEL, i + 1)) {
    const at = i + SENTINEL.length;
    if (buf[at] !== 1) continue;
    const n = buf[at + 1];
    const v = (k) => (k < n ? String.fromCharCode(buf[at + 2 + k]) : 'missing');
    out.push({ runAsNode: v(0), nodeOptions: v(2), inspect: v(3) });
  }
  return out;
}

if (CONTENTS_ONLY || !runsHere) {
  if (!CONTENTS_ONLY) console.log(`check: the app does not run on this machine (${process.platform}/${process.arch}); contents only`);
  finish(0);
}

// ------------------------------------------------------------- 2. the app

const WORK = path.join(SCRATCH, '.work');
const HOME = path.join(WORK, 'home');
const DATA = path.join(WORK, 'app-package');
fs.mkdirSync(HOME, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvp-'));
fs.chmodSync(RT, 0o700);
const daemonsEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME, LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
const LINK = path.join(DATA, 'bin', 'ravenryd');
const STAGED = path.join(DATA, 'versions', build.version, 'ravenryd');
const daemons = (bin = LINK) => JSON.parse(execFileSync(bin, ['daemons', '--json'], { env: daemonsEnv, encoding: 'utf8' }));
const exeOf = (pid) => {
  if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/exe`);
  return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
};

let hub = null;
let failed = false;
try {
  let oldPane = null;
  let oldVersion = null;
  if (OLD) {
    oldVersion = JSON.parse(execFileSync(OLD, ['version', '--json'], { env: daemonsEnv, encoding: 'utf8' })).version;
    execFileSync(OLD, ['serve', '--detach'], { env: daemonsEnv, stdio: 'ignore' });
    oldPane = JSON.parse(execFileSync(OLD, ['new', '--hidden', '--json', '--name', 'old-session', '--', '/bin/sh', '-c', 'echo old-session-alive; exec sleep 600'], { env: daemonsEnv, encoding: 'utf8' }));
    oldPane = oldPane.pane?.id || oldPane.id;
    ok(`an older ravenryd ${oldVersion} runs, with pane ${oldPane}`);
  }

  // What an agent could launch the app with: a module to load, programs
  // to run in place of its own, Node's options. Each writes a file if it
  // ever runs.
  const TRAP = path.join(WORK, 'trap');
  fs.mkdirSync(TRAP, { recursive: true });
  const ran = (what) => path.join(TRAP, `${what}.ran`);
  const trapModule = (what) => { const f = path.join(TRAP, `${what}.cjs`); fs.writeFileSync(f, `require('node:fs').writeFileSync(${JSON.stringify(ran(what))}, String(process.pid)); module.exports = async () => {};\n`); return f; };
  const trapProgram = (what) => { const f = path.join(TRAP, what); fs.writeFileSync(f, `#!/bin/sh\necho "$$" > '${ran(what)}'\nexit 1\n`, { mode: 0o755 }); return f; };
  const traps = {
    RAVENRY_DRIVER: trapModule('driver'), RAVENRY_DRIVE: path.join(TRAP, 'plan.json'),
    RAVENRYD: trapProgram('ravenryd'), RAVENRY_LAUNCHCTL: trapProgram('launchctl'), RAVENRY_NEW_SHELL: trapProgram('shell'),
    NODE_OPTIONS: `--require ${trapModule('node-options')}`,
  };
  const appEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/sh',
    RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state'), RAVENRY_HUB_URL: 'http://127.0.0.1:9', RAVENRY_DESKTOP_DATA: DATA,
    RAVENRY_SERVICE: 'dry-run', RAVENRY_OFFSCREEN: '1', RAVENRY_UPDATES: '0', RAVENRY_THEME: 'dark',
    ...(isAppImage ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
    ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    ...traps,
  };
  const noSandbox = platform === 'linux' ? ['--no-sandbox'] : [];
  const appRun = spawn(exe, noSandbox, { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  appRun.stdout.on('data', (d) => { log += d; });
  appRun.stderr.on('data', (d) => { log += d; });
  const appExit = new Promise((r) => appRun.on('exit', (c, sig) => r(c ?? sig)));
  cleanups.push(() => { try { appRun.kill('SIGKILL'); } catch { /* gone */ } });
  // Up: this version's daemon runs from the app's copy, its window opened a
  // shell there, and the service line is said.
  let pane = null;
  const tUp = Date.now();
  while (Date.now() - tUp < 60000 && appRun.exitCode === null) {
    try {
      const mine = JSON.parse(execFileSync(fs.existsSync(LINK) ? LINK : bundled, ['daemons', '--json', '--no-start'], { env: daemonsEnv, encoding: 'utf8' })).find((d) => d.version === build.version);
      if (mine) {
        const panes = JSON.parse(execFileSync(LINK, ['ls', '--json', '--no-start', '--socket', mine.socket], { env: daemonsEnv, encoding: 'utf8' }));
        pane = (Array.isArray(panes) ? panes : panes.panes || []).find((p) => p.state === 'running') || null;
      }
    } catch { /* not yet */ }
    if (pane && /^service: /m.test(log)) break;
    await sleep(250);
  }
  if (!pane) fail(`the app's window opened no shell in its daemon within 60 s (exit ${appRun.exitCode})\n${log.slice(-3000)}`);
  ok(`the packaged app, offscreen and with no driver, opened a shell in its daemon (pane ${pane.id}, ${(pane.command || []).join(' ')}) in ${Date.now() - tUp} ms`);
  const gateLine = log.split('\n').find((l) => l.startsWith('launch: a release build takes no test hooks')) || '';
  // (NODE_OPTIONS never reaches the app's code: the fuse takes it out first.)
  for (const k of Object.keys(traps).filter((k) => k !== 'NODE_OPTIONS')) if (!gateLine.includes(k)) fail(`the app did not say it ignored ${k}: ${gateLine || '(no gate line)'}`);
  const sprung = fs.readdirSync(TRAP).filter((f) => f.endsWith('.ran'));
  if (sprung.length) fail(`what the launch named ran in or through the app: ${sprung.join(', ')}`);
  ok(`it loaded and ran none of ${Object.keys(traps).join(', ')}; it says: ${gateLine}`);
  appRun.kill('SIGTERM');
  const appCode = await Promise.race([appExit, sleep(15000).then(() => 'still running')]);
  if (appCode !== 0) fail(`the app did not quit cleanly on SIGTERM: ${appCode}\n${log.slice(-2000)}`);
  fs.writeFileSync(path.join(OUT, 'app.log'), log);
  // Every way the app ends says why (src/main/main.ts exitWith, quitting).
  if (!/quit: asked to \([^)]*SIGTERM\)/.test(log) || !/quit: done \(exit 0\)/.test(log)) fail(`the app quit on SIGTERM without saying why in its log\n${log.slice(-1500)}`);
  ok('it quit on SIGTERM, and its log says why');

  // Started with a debugging switch: it quits at once, with no port open.
  for (const sw of ['--remote-debugging-port', '--inspect']) {
    const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const c = spawn(exe, [...noSandbox, `${sw}=${port}`], { env: { ...appEnv, ...Object.fromEntries(Object.keys(traps).map((k) => [k, undefined])) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    let open = false;
    const until = Date.now() + 15000;
    const exited = new Promise((r) => c.on('exit', (code, sig) => r(code ?? sig)));
    let code = null;
    exited.then((v) => { code = v; });
    while (code === null && Date.now() < until) {
      open = open || await new Promise((r) => { const k = net.connect(port, '127.0.0.1'); k.once('connect', () => { k.destroy(); r(true); }); k.once('error', () => r(false)); });
      await sleep(100);
    }
    if (code === null) { c.kill('SIGKILL'); fail(`started with ${sw}, the app kept running\n${out.slice(-1500)}`); }
    if (open) fail(`started with ${sw}=${port}, the app opened that port`);
    if (code !== 1 || !/which a release build refuses: quitting/.test(out)) fail(`started with ${sw}, the app exited with ${code} without saying it refuses it\n${out.slice(-1500)}`);
    ok(`started with ${sw}=${port}: it quits at once (exit ${code}), the port never opened`);
  }

  // The executable run as Node (as the hub service runs it): NODE_OPTIONS
  // does nothing there either (the fuse).
  {
    const nodeExe = isAppImage ? path.join(X, 'squashfs-root', 'ravenry') : exe;
    const r = spawnSync(nodeExe, ['-e', 'console.log("as-node " + process.versions.node)'], { env: { ...preEnv, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require ${trapModule('as-node-options')}` }, encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || !/^as-node /m.test(r.stdout)) fail(`the app's executable did not run as Node: ${r.status} ${r.stderr}`);
    if (fs.existsSync(ran('as-node-options'))) fail('run as Node, the app\'s executable loaded the module NODE_OPTIONS named');
    // (Its --inspect argument is Node's own here: whoever runs it as Node
    // runs a script of their choosing anyway. What matters is the running
    // hub: SIGUSR1, below.)
    ok(`run as Node (${r.stdout.trim()}): NODE_OPTIONS loads nothing`);
    // DYLD_INSERT_LIBRARIES: a library that writes a file when loaded.
    if (platform === 'darwin' && fs.existsSync('/usr/bin/clang')) {
      const src = path.join(TRAP, 'inject.c');
      const lib = path.join(TRAP, 'inject.dylib');
      fs.writeFileSync(src, `#include <stdio.h>\n__attribute__((constructor)) static void f(void) { FILE *x = fopen("${ran('dyld')}", "w"); if (x) { fputs("loaded", x); fclose(x); } }\n`);
      const cc = spawnSync('/usr/bin/clang', ['-dynamiclib', '-o', lib, src], { encoding: 'utf8' });
      if (cc.status === 0 && spawnSync('codesign', ['-s', '-', '-f', lib]).status === 0) {
        const d = spawnSync(exe, ['-e', '1'], { env: { ...preEnv, ELECTRON_RUN_AS_NODE: '1', DYLD_INSERT_LIBRARIES: lib }, encoding: 'utf8', timeout: 20000 });
        if (fs.existsSync(ran('dyld'))) fail('DYLD_INSERT_LIBRARIES loaded a library into the app\'s executable');
        ok(`DYLD_INSERT_LIBRARIES loads nothing into the app's executable (exit ${d.status})`);
      }
    }
  }

  if (fs.readlinkSync(LINK) !== path.relative(path.dirname(LINK), STAGED)) fail(`${LINK} does not point at ${STAGED}`);
  const ds = daemons();
  const mine = ds.find((d) => d.version === build.version);
  if (!mine) fail(`no ravenryd ${build.version} runs: ${JSON.stringify(ds)}`);
  const mineExe = exeOf(mine.pid);
  if (fs.realpathSync(mineExe) !== fs.realpathSync(STAGED)) fail(`the daemon runs ${mineExe}, not the app's copy ${STAGED}`);
  ok(`the app started its own ravenryd ${build.version} from its copy ${path.relative(WORK, STAGED)} (pid ${mine.pid})`);
  if (!fs.existsSync(path.join(path.dirname(STAGED), 'remote', 'builds.json'))) fail(`the app did not copy its builds for other machines beside ${STAGED}`);
  ok('the builds for other machines were copied beside it, where the hub finds them');
  if (OLD) {
    const old = ds.find((d) => d.version === oldVersion);
    if (!old) fail(`the older ravenryd ${oldVersion} is gone: ${JSON.stringify(ds)}`);
    const panes = JSON.parse(execFileSync(OLD, ['ls', '--all', '--json', '--no-start', '--socket', old.socket], { env: daemonsEnv, encoding: 'utf8' }));
    const list = Array.isArray(panes) ? panes : panes.panes || [];
    const p = list.find((x) => x.id === oldPane);
    if (!p || p.state === 'exited') fail(`the old daemon's pane ${oldPane} did not survive: ${JSON.stringify(list)}`);
    ok(`the older ravenryd ${oldVersion} still runs beside it (draining: ${old.draining}), its pane ${oldPane} alive; new panes went to ${build.version} (${mine.panes} pane left there)`);
  }

  // ----------------------------------------------------------- 3. the hub
  const line = log.split('\n').find((l) => l.startsWith('service: ')) || '';
  if (!/^service: installed /.test(line)) fail(`the app did not write its service: ${line || '(no service line)'}`);
  ok(line.replace(/^service: /, 'service (dry run): '));
  let svcExe, svcArgs, svcEnv;
  if (platform === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'dev.ravenry.hub.plist');
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    if (lint.status !== 0) fail(`plutil: ${lint.stdout}${lint.stderr}`);
    const j = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    [svcExe, ...svcArgs] = j.ProgramArguments;
    svcEnv = j.EnvironmentVariables;
    fs.copyFileSync(plist, path.join(OUT, 'dev.ravenry.hub.plist'));
    ok(`launchd agent written to the throwaway HOME and valid (plutil -lint): ${svcExe} ${svcArgs.join(' ')}`);
  } else {
    const unit = path.join(HOME, '.config', 'systemd', 'user', 'dev.ravenry.hub.service');
    const t = fs.readFileSync(unit, 'utf8');
    fs.copyFileSync(unit, path.join(OUT, 'dev.ravenry.hub.service'));
    const unq = (s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\$\$/g, '$').replace(/%%/g, '%');
    const exec = /^ExecStart=(.*)$/m.exec(t)[1].match(/"(?:\\.|[^"\\])*"/g).map(unq);
    [svcExe, ...svcArgs] = exec;
    svcEnv = Object.fromEntries([...t.matchAll(/^Environment=(".*")$/gm)].map((m) => { const kv = unq(m[1]); const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    const v = spawnSync('systemd-analyze', ['--user', 'verify', unit], { encoding: 'utf8' });
    if (v.error) ok(`systemd unit written to the throwaway HOME (systemd-analyze not here): ${svcExe} ${svcArgs.join(' ')}`);
    else if (v.status !== 0 && !/Failed to (connect|initialize)|bus/i.test(v.stderr)) fail(`systemd-analyze verify: ${v.stderr}`);
    else ok(`systemd unit written to the throwaway HOME${v.status === 0 ? ' and verified (systemd-analyze)' : ''}: ${svcExe} ${svcArgs.join(' ')}`);
  }
  if (svcEnv.ELECTRON_RUN_AS_NODE !== '1') fail('the service does not run the app as Node');
  // An AppImage's hub runs the runtime copied into the version folder, never the AppImage (whose launcher adds --no-sandbox).
  if (isAppImage && !svcExe.startsWith(path.join(DATA, 'versions', build.version, 'runtime') + path.sep)) fail(`the AppImage's service runs ${svcExe}, not the runtime copied into its version folder`);
  if (svcEnv.RAVENRY_DAEMON_BIN !== LINK) fail(`the service's RAVENRY_DAEMON_BIN is ${svcEnv.RAVENRY_DAEMON_BIN}, not ${LINK}`);

  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  if (port === 4600) fail('refusing to use :4600');
  // The stand-in ps too: never this machine's own processes (tools/test-env.mjs).
  const hubEnv = withStubMachine({
    ...svcEnv,
    // A throwaway home and data folder, and a plain PATH: nothing of this
    // machine's own (no assistants, no board data).
    HOME, RAVENRY_HOME: path.join(HOME, '.ravenry'), PORT: String(port), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state'), MC_NO_EVENTS: '1', RAVENRY_NO_OPEN: '1',
  });
  let hubLog = '';
  // Node's arguments come before the hub's script: no inspector on SIGUSR1.
  const entry = svcArgs.find((a) => a.endsWith('.mjs'));
  if (!svcArgs.slice(0, svcArgs.indexOf(entry)).includes('--disable-sigusr1')) fail(`the service runs the hub without --disable-sigusr1: ${svcArgs.join(' ')}`);
  hub = spawn(svcExe, svcArgs, { env: hubEnv, cwd: path.dirname(path.dirname(entry)), stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stdout.on('data', (d) => { hubLog += d; });
  hub.stderr.on('data', (d) => { hubLog += d; });
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 30000 && hub.exitCode === null) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { state = await r.json(); break; }
    } catch { /* not yet */ }
    await sleep(250);
  }
  if (!state) fail(`the hub did not answer on :${port} within 30 s\n${hubLog.slice(-3000)}`);
  ok(`the hub runs as the service says (${svcExe === exe ? "the app's executable" : `the runtime copied to ${path.relative(WORK, svcExe)}`} as Node) and answers /api/state on :${port} in ${Date.now() - t0} ms`);
  // SIGUSR1, which any program of the user's can send it, opens no
  // inspector (checked when Node's port, 9229, is free here).
  const inspectorOpen = () => new Promise((r) => { const k = net.connect(9229, '127.0.0.1'); k.once('connect', () => { k.destroy(); r(true); }); k.once('error', () => r(false)); });
  if (!(await inspectorOpen())) {
    hub.kill('SIGUSR1');
    await sleep(1500);
    if (await inspectorOpen()) fail('SIGUSR1 opened Node\'s inspector in the hub on 127.0.0.1:9229');
    if (hub.exitCode !== null) fail(`SIGUSR1 ended the hub: ${hub.exitCode}`);
    ok('SIGUSR1 to the hub opens no inspector (127.0.0.1:9229 stays closed) and the hub runs on');
  } else ok('SIGUSR1: not checked, something else listens on 127.0.0.1:9229 here');
  const before = daemons().map((d) => d.pid).sort();
  hub.kill('SIGTERM');
  const code = await Promise.race([new Promise((r) => hub.on('exit', (c, s) => r(c ?? s))), sleep(10000).then(() => 'timeout')]);
  fs.writeFileSync(path.join(OUT, 'hub.log'), hubLog);
  hub = null;
  if (code !== 0) fail(`the hub did not stop cleanly on SIGTERM: ${code}\n${hubLog.slice(-2000)}`);
  const after = daemons().map((d) => d.pid).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) fail(`stopping the hub changed the daemons: ${before} -> ${after}`);
  ok(`the hub stopped cleanly on SIGTERM (as on an update) and every daemon kept running (${after.length})`);
} catch (e) {
  failed = true;
  console.error('check: FAILED\n' + (e.stack || e));
} finally {
  if (hub) hub.kill('SIGKILL');
  for (const bin of [LINK, OLD].filter(Boolean)) { try { stopDaemons(bin, RT); } catch { /* none */ } }
  fs.rmSync(RT, { recursive: true, force: true });
}
finish(failed ? 1 : 0);

function finish(code) {
  if (copied) release(copied);
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
  // The guard: the copy is not left in LaunchServices' list.
  if (copied && checkLeft('check').length && !code) code = 1;
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + '\n');
  if (!code) console.log(`check: all ${results.length} checks passed (${OUT}/results.txt)`);
  process.exit(code);
}
