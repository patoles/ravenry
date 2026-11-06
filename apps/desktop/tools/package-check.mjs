#!/usr/bin/env node
// Checks a packaged app: what is inside it, and, when it runs on this
// machine, the app itself. Never on screen, never the user's own files:
// a throwaway HOME, app data folder and daemon runtime folder, and the hub
// service written in dry-run mode into the throwaway HOME only (no launchd
// or systemd command runs).
//
//   node tools/package-check.mjs APP [OUT] [--old-ravenryd BIN] [--contents-only]
//
// APP is Ravenry.app, a .dmg (mounted with hdiutil, never in Finder), a
// .zip, a linux-unpacked folder, a .deb (unpacked with dpkg-deb) or an
// AppImage (run with APPIMAGE_EXTRACT_AND_RUN=1, so no FUSE is needed).
// --contents-only checks what is inside only; so does an app for another
// platform or architecture than this machine's.
//
// 1. Contents: ravenryd (its version, platform and architecture match the
//    app's; static on Linux), the hub and its node client, build.json,
//    app-update.yml; on macOS the code signature.
// 2. The app, offscreen, with the smoke test's steps (smoke-steps.mjs) and
//    no RAVENRYD: it must copy its own ravenryd out of the app and start it.
//    With --old-ravenryd, an older ravenryd runs first with a pane in it,
//    as after an update: the app's ravenryd must start beside it, and the
//    old one must keep its pane.
// 3. The hub service file the app wrote, then the hub run exactly as it
//    says (the app's executable as Node), on a spare port: it must answer,
//    stop cleanly on SIGTERM, and leave every daemon running.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { runApp, stopDaemons } from './run-app.mjs';
import { smokeSteps } from './smoke-steps.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const OLD = opt('--old-ravenryd');
const CONTENTS_ONLY = argv.includes('--contents-only');
const pos = argv.filter((a) => !a.startsWith('--'));
if (!pos[0]) { console.error('usage: package-check.mjs APP [OUT] [--old-ravenryd BIN] [--contents-only]'); process.exit(2); }
const APP_PATH = path.resolve(pos[0]);
const OUT = path.resolve(pos[1] || path.join(os.tmpdir(), 'ravenry-package-check'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

guardSpawns();
// What the checks before the app run (extracting an AppImage, ravenryd
// version) run with: throwaway folders, never the real user's.
const PRE = path.join(OUT, '.pre');
const preEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(PRE, 'home'), LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: path.join(PRE, 'run'), RAVENRY_STATE_DIR: path.join(PRE, 'state'), RAVENRY_DESKTOP_DATA: path.join(PRE, 'data') };

const results = [];
const cleanups = [];
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
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, APP_PATH], { stdio: 'ignore' });
  cleanups.push(() => spawnSync('hdiutil', ['detach', mnt, '-quiet']));
  target = path.join(mnt, 'Ravenry.app');
  ok(`${path.basename(APP_PATH)} mounted (hdiutil, no Finder window)`);
} else if (APP_PATH.endsWith('.zip')) {
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
for (const f of ['hub/server/index.mjs', 'hub/hooks/events.mjs', 'hub/public/index.html', 'hub/package.json', 'hub/node_modules/@ravenry/node-client/index.mjs']) {
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
}

if (CONTENTS_ONLY || !runsHere) {
  if (!CONTENTS_ONLY) console.log(`check: the app does not run on this machine (${process.platform}/${process.arch}); contents only`);
  finish(0);
}

// ------------------------------------------------------------- 2. the app

const WORK = path.join(OUT, '.work');
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

  const shell = fs.existsSync('/bin/bash') ? '/bin/bash --noprofile --norc' : '/bin/sh';
  const log = await runApp({
    name: 'package', work: WORK, rt: RT, home: HOME, hubUrl: 'http://127.0.0.1:9',
    exe, cli: LINK, steps: smokeSteps(OUT, WORK), shell, width: 1200, height: 760,
    env: {
      PS1: '$ ', RAVENRY_SERVICE: 'dry-run', RAVENRY_DESKTOP_DATA: DATA,
      ...(isAppImage ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
    },
  });
  fs.writeFileSync(path.join(OUT, 'app.log'), log);
  ok('the packaged app ran the smoke steps offscreen (shell, typing, paste, tabs, focus, agent status, close)');

  if (fs.readlinkSync(LINK) !== path.relative(path.dirname(LINK), STAGED)) fail(`${LINK} does not point at ${STAGED}`);
  const ds = daemons();
  const mine = ds.find((d) => d.version === build.version);
  if (!mine) fail(`no ravenryd ${build.version} runs: ${JSON.stringify(ds)}`);
  const mineExe = exeOf(mine.pid);
  if (fs.realpathSync(mineExe) !== fs.realpathSync(STAGED)) fail(`the daemon runs ${mineExe}, not the app's copy ${STAGED}`);
  ok(`the app started its own ravenryd ${build.version} from its copy ${path.relative(WORK, STAGED)} (pid ${mine.pid})`);
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
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'gg.ravenry.hub.plist');
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    if (lint.status !== 0) fail(`plutil: ${lint.stdout}${lint.stderr}`);
    const j = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    [svcExe, ...svcArgs] = j.ProgramArguments;
    svcEnv = j.EnvironmentVariables;
    fs.copyFileSync(plist, path.join(OUT, 'gg.ravenry.hub.plist'));
    ok(`launchd agent written to the throwaway HOME and valid (plutil -lint): ${svcExe} ${svcArgs.join(' ')}`);
  } else {
    const unit = path.join(HOME, '.config', 'systemd', 'user', 'ravenry-hub.service');
    const t = fs.readFileSync(unit, 'utf8');
    fs.copyFileSync(unit, path.join(OUT, 'ravenry-hub.service'));
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
  const hubEnv = {
    ...svcEnv,
    // A throwaway home and data folder, and a plain PATH: nothing of this
    // machine's own (no assistants, no board data).
    HOME, RAVENRY_HOME: path.join(HOME, '.ravenry'), PORT: String(port), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state'), MC_NO_EVENTS: '1', RAVENRY_NO_OPEN: '1',
  };
  let hubLog = '';
  hub = spawn(svcExe, svcArgs, { env: hubEnv, cwd: path.dirname(path.dirname(svcArgs[0])), stdio: ['ignore', 'pipe', 'pipe'] });
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
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + '\n');
  if (!code) console.log(`check: all ${results.length} checks passed (${OUT}/results.txt)`);
  process.exit(code);
}
