#!/usr/bin/env node
// The packaged Mac app started from inside a pane relaunches itself clean
// (src/main/relaunch.ts), checked on a real build:
//
//   node tools/relaunch-check.mjs APP [OUT]
//
// APP is a built Ravenry.app (npm run pack -- --dir). It is copied to a
// throwaway folder, never /Applications, and started as an agent in a pane
// would start it: RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM=ravenry, a
// RAVENRY_DRIVER and a --remote-debugging-port argument. Then:
//
//   1. that process exits, and a second one, started by launchd through
//      LaunchServices, runs with no pane variable, no driver, no argument,
//      and app.log says it relaunched clean and what it dropped;
//   2. the loop guard: with the marker a relaunch leaves, a start that
//      still has pane variables stays up and says so;
//   3. as the person's start would be: `open -n -a` (in the foreground, no
//      -g) with RAVENRY_PANE and RAVENRY_SOCKET set, the relaunch also
//      without -g (RAVENRY_RELAUNCH_TEST=foreground): once it settles,
//      exactly one instance of the copy runs, with none of the pane's
//      variables. Its window is offscreen; the app comes to the front.
//
// Everything runs in a throwaway HOME, data, runtime and state folder,
// offscreen, with no hub service, no updates and a hub URL nobody answers
// (RAVENRY_RELAUNCH_TEST=1 keeps those for the new app). The relaunch opens
// in the background (open -g), so the person's focus stays where it is.
// Whatever it started is stopped at the end, and the copy is taken out of
// LaunchServices' list. macOS only. Writes OUT/relaunch-check.json.
import { guardSpawns, allowPaneLaunch } from '../../../tools/test-env.mjs';
import { track, release, removeTree, checkLeft } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

guardSpawns();
// This tool starts the app with a pane's variables on purpose.
allowPaneLaunch();

if (process.platform !== 'darwin') { console.log('relaunch-check: macOS only'); process.exit(0); }
const APP = process.argv[2] && path.resolve(process.argv[2]);
if (!APP || !fs.existsSync(path.join(APP, 'Contents', 'MacOS', 'Ravenry'))) { console.error('usage: node tools/relaunch-check.mjs APP [OUT]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-relaunch-'))));
const OUT = path.resolve(process.argv[3] || path.join(root, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const app = path.join(root, 'Applications', 'Ravenry.app');
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync('/usr/bin/ditto', [APP, app]);
const exe = path.join(app, 'Contents', 'MacOS', 'Ravenry');
const home = path.join(root, 'h');
const data = path.join(root, 'data');
const rt = path.join(root, 'run');
const state = path.join(root, 'state');
for (const d of [home, data, rt, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const appLog = path.join(home, 'Library', 'Logs', 'Ravenry', 'app.log');
const marker = path.join(data, 'relaunched-from-pane.json');
// A driver an agent would set: it writes a file if the app ever loads it.
const loaded = path.join(root, 'driver-loaded');
const driver = path.join(root, 'driver.cjs');
fs.writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, String(process.pid)); module.exports = async () => {};\n`);

const env = {
  HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/zsh', TMPDIR: os.tmpdir() + '/', LANG: 'en_US.UTF-8',
  PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state, RAVENRY_HUB_URL: 'http://127.0.0.1:9',
  RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OFFSCREEN: '1', RAVENRY_RELAUNCH_TEST: '1',
  // What a pane gives the agent, and what an agent could add.
  RAVENRY_PANE: 'ptest001', RAVENRY_SOCKET: path.join(rt, 'ravenryd-0.0.0-1.sock'), TERM_PROGRAM: 'ravenry', TERM_PROGRAM_VERSION: '0.1.14', TERM: 'xterm-256color',
  RAVENRY_DRIVER: driver, ELECTRON_ENABLE_LOGGING: '1', CLAUDECODE: '1',
};
const ARGS = ['--remote-debugging-port=0'];

const results = [];
let failed = 0;
function step(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${JSON.stringify(detail)}`}`);
}
const alive = (pid) => spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).status === 0;
const ppidOf = (pid) => Number(spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || 0;
const commandEnv = (pid) => spawnSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
// The main process of this copy (not its helpers, which run from Frameworks).
function mains() {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').map((l) => l.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === exe || m[2].startsWith(exe + ' '))).map((m) => Number(m[1]));
}
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(100); } }
const logText = () => { try { return fs.readFileSync(appLog, 'utf8'); } catch { return ''; } };
const others = new Set();

try {
  // 1. Started from a pane: it goes, and a clean one comes.
  const first = spawn(exe, ARGS, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let firstOut = '';
  first.stdout.on('data', (d) => { firstOut += d; });
  first.stderr.on('data', (d) => { firstOut += d; });
  const pid1 = first.pid;
  const t0 = Date.now();
  const code = await Promise.race([new Promise((r) => first.on('exit', (c, s) => r(c ?? s))), sleep(15000).then(() => 'still running')]);
  const exitedMs = Date.now() - t0;
  step('1 started with pane variables: that process exits by itself, with 0', code === 0, { pid: pid1, code, exitedMs, out: firstOut.slice(-2000) });
  const pid2 = await until(() => mains().find((p) => p !== pid1), 15000);
  if (pid2) others.add(pid2);
  const seen = pid2 ? commandEnv(pid2) : '';
  fs.writeFileSync(path.join(OUT, 'relaunched-ps-eww.txt'), seen + '\n');
  step('1 a second process of this copy runs, started by launchd (LaunchServices), not by the first', !!pid2 && ppidOf(pid2) === 1, { pid2, ppid: pid2 ? ppidOf(pid2) : null, msFromStart: Date.now() - t0 });
  step('1 the first process is gone', !alive(pid1), { pid1 });
  const cmdline = seen.split(' ').filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  step('1 the second one has no RAVENRY_PANE, RAVENRY_SOCKET, RAVENRY_DRIVER, TERM_PROGRAM, ELECTRON_*, CLAUDECODE', !!seen && !/(^|\s)(RAVENRY_PANE|RAVENRY_SOCKET|RAVENRY_DRIVER|RAVENRY_RELAUNCH_TEST|TERM_PROGRAM|TERM_PROGRAM_VERSION|ELECTRON_[A-Z_]*|CLAUDECODE)=/.test(seen), { ravenryVars: (seen.match(/(^|\s)RAVENRY_[A-Z_]+=/g) || []).map((s) => s.trim()) });
  step('1 the second one got no argument from the caller (no --remote-debugging-port)', !seen.includes('--remote-debugging-port'), { argsSeen: cmdline.slice(0, 1).concat(cmdline.filter((w) => w.startsWith('--'))) });
  const line = await until(() => logText().split('\n').find((l) => l.includes('launch: relaunched clean')), 10000);
  step('1 app.log says it relaunched clean and names what it dropped', !!line && /pid \d+/.test(line) && /RAVENRY_PANE/.test(line) && /RAVENRY_DRIVER/.test(line) && /TERM_PROGRAM/.test(line), { line });
  step('1 the driver was never loaded, in either process', !fs.existsSync(loaded));
  step('1 the marker is consumed', !fs.existsSync(marker));
  if (pid2) { try { process.kill(pid2, 'SIGTERM'); } catch { /* gone */ } await until(() => !alive(pid2), 10000); }
  step('1 the relaunched app quits on SIGTERM', !pid2 || !alive(pid2));

  // 2. The loop guard: a relaunch that still has pane variables stays.
  fs.writeFileSync(marker, JSON.stringify({ pid: 1, at: Date.now(), dropped: ['RAVENRY_PANE'] }));
  // (No driver here: this start runs on, and a driver would quit it.)
  const loop = spawn(exe, [], { env: { ...env, RAVENRY_DRIVER: undefined }, stdio: 'ignore' });
  others.add(loop.pid);
  await sleep(6000);
  const extra = mains().filter((p) => p !== loop.pid);
  step('2 loop guard: with a fresh marker and pane variables, it stays up and starts no other copy', alive(loop.pid) && extra.length === 0, { pid: loop.pid, extra });
  const loopLine = logText().split('\n').find((l) => l.includes('after relaunching clean; staying'));
  step('2 loop guard: app.log says it stays', !!loopLine, { line: loopLine });
  loop.kill('SIGTERM');
  await until(() => !alive(loop.pid), 10000);

  // 3. In the foreground, as an agent's `open -a` started it on 2026-11-07.
  try { fs.rmSync(marker, { force: true }); } catch { /* none */ }
  await until(() => mains().length === 0, 10000);
  const fgEnv = { ...env, RAVENRY_DRIVER: undefined, RAVENRY_RELAUNCH_TEST: 'foreground' };
  delete fgEnv.RAVENRY_DRIVER;
  const t3 = Date.now();
  const opened = spawnSync('/usr/bin/open', ['-n', '-a', app], { env: fgEnv, encoding: 'utf8', timeout: 20000 });
  step('3 open -n -a (foreground) with RAVENRY_PANE and RAVENRY_SOCKET set: open starts it', opened.status === 0, { status: opened.status, err: (opened.stderr || '').slice(-400) });
  // Settled: the relaunch line in the log, and then nothing new for 4 s.
  const relaunchLines = () => logText().split('\n').filter((l) => l.includes('launch: relaunched clean')).length;
  const before = relaunchLines();
  await until(() => relaunchLines() > before - 0 && relaunchLines() >= 2, 20000);
  let settled = mains();
  for (let i = 0; i < 40; i++) { await sleep(250); const now = mains(); if (now.join() === settled.join() && Date.now() - t3 > 6000) break; settled = now; }
  await sleep(4000);
  const final = mains();
  for (const p of final) others.add(p);
  const envs = final.map((p) => ({ pid: p, ppid: ppidOf(p), vars: (commandEnv(p).match(/(^|\s)(RAVENRY_PANE|RAVENRY_SOCKET|TERM_PROGRAM|TERM_PROGRAM_VERSION)=/g) || []).map((s) => s.trim()) }));
  fs.writeFileSync(path.join(OUT, 'foreground-ps-eww.txt'), final.map((p) => commandEnv(p)).join('\n') + '\n');
  step('3 once it settles, exactly one instance of the copy runs', final.length === 1, { pids: final, msFromOpen: Date.now() - t3 });
  step('3 that instance has none of RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM', final.length >= 1 && envs.every((e) => e.vars.length === 0), { envs });
  step('3 it relaunched clean (app.log), the relaunch opened without -g', relaunchLines() >= 2, { relaunchLines: relaunchLines() });
} finally {
  for (const p of [...others, ...mains()]) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  for (const p of mains()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  // The daemon the relaunched app started in the test's runtime folder.
  try {
    const bin = path.join(app, 'Contents', 'Resources', 'ravenryd');
    for (const d of JSON.parse(execFileSync(bin, ['daemons', '--json', '--no-start'], { env: { PATH: '/usr/bin:/bin', HOME: home, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state }, encoding: 'utf8' }) || '[]')) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  // The copy out of LaunchServices' list while it is still on disk
  // (tools/launchservices.mjs).
  release(root);
  fs.writeFileSync(path.join(OUT, 'relaunch-check.json'), JSON.stringify({ app: APP, root, failed, steps: results }, null, 2));
  try { fs.copyFileSync(appLog, path.join(OUT, 'app.log')); } catch { /* none */ }
  if (!process.argv[3]) console.log(`relaunch-check: ${root} kept for its output`); else removeTree(root);
}
// The guard: the copy is not left in LaunchServices' list.
const left = checkLeft('relaunch-check');
console.log(failed ? `relaunch-check: ${failed} step(s) failed` : 'relaunch-check: every step passed');
process.exit(failed || left.length ? 1 : 0);
