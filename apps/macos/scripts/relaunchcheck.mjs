#!/usr/bin/env node
// The packaged native app started from inside a pane relaunches itself
// clean (Sources/RavenryMac/Relaunch.swift), checked on a real build, as
// apps/desktop/tools/relaunch-check.mjs checks the Electron app:
//
//   node scripts/relaunchcheck.mjs [APP] [OUT]
//
// APP is a packaged Ravenry.app (scripts/package.mjs; default
// build/package/Ravenry.app). It is copied to a throwaway folder, never
// /Applications, and started as an agent in a pane would start it:
// RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM=ravenry, CLAUDECODE,
// CLAUDE_CODE_SESSION_ID and an argument. Then:
//
//   1. that process exits with 0, and a second one, started by launchd
//      through LaunchServices, runs with none of those variables and no
//      argument, app.log says it relaunched clean and what it dropped, and
//      the marker is consumed;
//   2. the loop guard: with the marker a relaunch leaves, a start that
//      still has pane variables stays up and says so;
//   3. a clean start (no pane variable) does not relaunch: it stays up,
//      starts no other copy and leaves no marker;
//   4. --older-hub-check with pane variables does its check and exits
//      before the relaunch is looked at: no other copy starts;
//   5. opened with `open -n -a` and the pane's variables (LaunchServices
//      hands them on, the route of 2026-11-10 11:53), it relaunches clean
//      too; and the starts reuse the daemon the first one started.
//
// Everything runs in a throwaway HOME, data, runtime and state folder, off
// every screen (RAVENRY_OFFSCREEN=1), with no hub service, no updates and
// a hub URL nobody answers (RAVENRY_RELAUNCH_TEST=1 keeps those for the
// new app). The relaunch opens in the background (open -g), so the
// person's focus stays where it is. Whatever it started is stopped at the
// end, the daemon the app started in the test's runtime folder too, and
// the copy is taken out of LaunchServices' list. Writes
// OUT/relaunchcheck.json.
import { guardSpawns, allowPaneLaunch } from '../../../tools/test-env.mjs';
import { track, release, removeTree, checkLeft } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
// This tool starts the app with a pane's variables on purpose.
allowPaneLaunch();

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The test twin (testapp.mjs): the release quits on a test's switches.
const APP = testApp(process.argv[2] || path.join(HERE, '..', 'build', 'package', 'Ravenry.app')).app;
if (!fs.existsSync(path.join(APP, 'Contents', 'MacOS', 'Ravenry')) || !fs.existsSync(path.join(APP, 'Contents', 'Resources', 'build.json'))) {
  console.error('usage: node scripts/relaunchcheck.mjs [PACKAGED_APP] [OUT] (scripts/package.mjs makes one)');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A short name: the daemon's socket (<root>/run/ravenryd-<version>.sock)
// must stay under the 104 bytes a socket's path may take, and under
// "rv-mac-relaunch-" it took 104, so the daemon never started and every
// start of the app logged "starting this app's ... (none ran)".
const root = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rvrl-'))));
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

const clean = {
  HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/zsh', TMPDIR: os.tmpdir() + '/', LANG: 'en_US.UTF-8',
  PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state, RAVENRY_HUB_URL: 'http://127.0.0.1:9',
  RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OFFSCREEN: '1', RAVENRY_RELAUNCH_TEST: '1',
};
// What a pane gives the agent, and what the agent adds (2026-11-10: a Claude
// session in a pane ran `open -a Ravenry`).
const env = {
  ...clean,
  RAVENRY_PANE: 'ptest001', RAVENRY_SOCKET: path.join(rt, 'ravenryd-0.0.0-1.sock'), TERM_PROGRAM: 'ravenry', TERM_PROGRAM_VERSION: '0.1.23', TERM: 'xterm-256color',
  CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'not-a-session', NODE_OPTIONS: '--inspect=0',
};
const ARGS = ['--attach', 'pnothere'];
const LEAK = '(^|\\s)(RAVENRY_PANE|RAVENRY_SOCKET|RAVENRY_RELAUNCH_TEST|TERM_PROGRAM|TERM_PROGRAM_VERSION|CLAUDECODE|CLAUDE_CODE_SESSION_ID|NODE_OPTIONS)=';

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
// The app processes of this copy (not the Node it runs for its setup).
function mains() {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').map((l) => l.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === exe || m[2].startsWith(exe + ' '))).map((m) => Number(m[1]));
}
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(100); } }
const logText = () => { try { return fs.readFileSync(appLog, 'utf8'); } catch { return ''; } };
const relaunchLines = () => logText().split('\n').filter((l) => l.includes('launch: relaunched clean')).length;
async function stop(pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } await until(() => !alive(pid), 10000); }

try {
  // 1. Started from a pane: it goes, and a clean one comes.
  const first = spawn(exe, ARGS, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let firstOut = '';
  first.stdout.on('data', (d) => { firstOut += d; });
  first.stderr.on('data', (d) => { firstOut += d; });
  const pid1 = first.pid;
  const t0 = Date.now();
  const firstEnv = commandEnv(pid1);
  fs.writeFileSync(path.join(OUT, 'first-ps-eww.txt'), firstEnv + '\n');
  const code = await Promise.race([new Promise((r) => first.on('exit', (c, s) => r(c ?? s))), sleep(15000).then(() => 'still running')]);
  step('1 started with pane variables: that process exits by itself, with 0', code === 0, { pid: pid1, code, exitedMs: Date.now() - t0, out: firstOut.slice(-2000) });
  const quitLine = logText().split('\n').find((l) => l.includes('relaunching clean through LaunchServices'));
  step('1 app.log says why it quit', !!quitLine, { line: quitLine });
  const pid2 = await until(() => mains().find((p) => p !== pid1), 15000);
  const seen = pid2 ? commandEnv(pid2) : '';
  fs.writeFileSync(path.join(OUT, 'relaunched-ps-eww.txt'), seen + '\n');
  step('1 a second process of this copy runs, started by launchd (LaunchServices), not by the first', !!pid2 && ppidOf(pid2) === 1, { pid2, ppid: pid2 ? ppidOf(pid2) : null, msFromStart: Date.now() - t0 });
  step('1 the first process is gone', !alive(pid1), { pid1 });
  step('1 its first environment has no RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM, CLAUDE*, NODE_OPTIONS', !!seen && !new RegExp(LEAK).test(seen), { leaked: (seen.match(new RegExp(LEAK, 'g')) || []).map((s) => s.trim()), ravenryVars: (seen.match(/(^|\s)RAVENRY_[A-Z_]+=/g) || []).map((s) => s.trim()) });
  step('1 it got no argument from the caller (no --attach)', !!seen && !seen.includes('--attach'));
  const line = await until(() => logText().split('\n').find((l) => l.includes('launch: relaunched clean')), 10000);
  step('1 app.log says it relaunched clean and names what it dropped', !!line && /pid \d+/.test(line) && /RAVENRY_PANE/.test(line) && /CLAUDE_CODE_SESSION_ID/.test(line) && /TERM_PROGRAM/.test(line), { line });
  step('1 the marker is consumed', !fs.existsSync(marker));
  await sleep(3000);
  step('1 the relaunched app stays up (off every screen)', !!pid2 && alive(pid2), { pid2 });
  if (pid2) await stop(pid2);
  step('1 the relaunched app quits on SIGTERM', !pid2 || !alive(pid2));

  // 2. The loop guard: a relaunch that still has pane variables stays.
  fs.writeFileSync(marker, JSON.stringify({ pid: 1, at: Date.now(), dropped: ['RAVENRY_PANE'] }));
  const loop = spawn(exe, [], { env, stdio: 'ignore' });
  await sleep(6000);
  const extra = mains().filter((p) => p !== loop.pid);
  step('2 loop guard: with a fresh marker and pane variables, it stays up and starts no other copy', alive(loop.pid) && extra.length === 0, { pid: loop.pid, extra });
  const loopLine = logText().split('\n').find((l) => l.includes('after relaunching clean; staying'));
  step('2 loop guard: app.log says it stays', !!loopLine, { line: loopLine });
  step('2 loop guard: the marker is consumed', !fs.existsSync(marker));
  await stop(loop.pid);

  // 3. A clean start does not relaunch.
  const before = relaunchLines();
  const quitsBefore = logText().split('\n').filter((l) => l.includes('relaunching clean through LaunchServices')).length;
  const plain = spawn(exe, [], { env: clean, stdio: 'ignore' });
  await sleep(6000);
  const extra3 = mains().filter((p) => p !== plain.pid);
  step('3 a clean start stays up, as the same process, and starts no other copy', alive(plain.pid) && extra3.length === 0, { pid: plain.pid, extra: extra3 });
  const quitsAfter = logText().split('\n').filter((l) => l.includes('relaunching clean through LaunchServices')).length;
  step('3 a clean start leaves no marker and no relaunch line', !fs.existsSync(marker) && relaunchLines() === before && quitsAfter === quitsBefore);
  await stop(plain.pid);

  // The daemon: the relaunched app started one, and the later starts use it.
  const dLines = logText().split('\n').filter((l) => / daemon: (starting|using) /.test(l));
  const starts = dLines.filter((l) => l.includes('daemon: starting'));
  step('3 the first app started a daemon and each later start uses it (one start, a "using" line for each start)', starts.length === 1 && dLines.filter((l) => l.includes('daemon: using')).length >= 3, { lines: dLines });

  // 5. Through LaunchServices, as the agent did on 2026-11-10 at 11:53
  //    (`open -a Ravenry` in its pane; open hands the caller's environment
  //    to the app): that app, started by launchd, relaunches clean too.
  const quits5 = logText().split('\n').filter((l) => l.includes('relaunching clean through LaunchServices')).length;
  const lines5 = relaunchLines();
  const op = spawnSync('/usr/bin/open', ['-n', '-g', '-a', app], { env, encoding: 'utf8', timeout: 20000 });
  const quit5 = await until(() => logText().split('\n').filter((l) => l.includes('relaunching clean through LaunchServices')).length > quits5, 15000);
  const clean5 = await until(() => relaunchLines() > lines5 && mains().find((p) => !new RegExp(LEAK).test(commandEnv(p))), 15000);
  const seen5 = clean5 ? commandEnv(clean5) : '';
  step('5 opened with open -a from a pane: that app quits and a clean one runs, started by launchd', op.status === 0 && !!quit5 && !!clean5 && ppidOf(clean5) === 1 && !new RegExp(LEAK).test(seen5),
    { open: op.status, quit: !!quit5, pid: clean5, ppid: clean5 ? ppidOf(clean5) : null, apps: mains() });
  for (const p of mains()) await stop(p);

  // 4. --older-hub-check: its check, before the relaunch is looked at.
  const inFile = path.join(root, 'older-in.json');
  const outFile = path.join(root, 'older-out.json');
  fs.writeFileSync(inFile, JSON.stringify({ sidebar: {}, checkpoints: [], projects: [] }));
  const oh = spawnSync(exe, ['--older-hub-check', inFile, outFile], { env, encoding: 'utf8', timeout: 20000 });
  await sleep(3000);
  const extra4 = mains();
  step('4 --older-hub-check with pane variables: does its check, exits 0, and no other copy starts', oh.status === 0 && fs.existsSync(outFile) && extra4.length === 0, { status: oh.status, out: fs.existsSync(outFile), extra: extra4 });
} finally {
  for (const p of mains()) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  for (const p of mains()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  // The daemon the app started in the test's runtime folder.
  try {
    const bin = path.join(app, 'Contents', 'MacOS', 'ravenryd');
    for (const d of JSON.parse(execFileSync(bin, ['daemons', '--json', '--no-start'], { env: { PATH: '/usr/bin:/bin', HOME: home, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state }, encoding: 'utf8' }) || '[]')) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  // The copy out of LaunchServices' list while it is still on disk
  // (tools/launchservices.mjs).
  release(root);
  fs.writeFileSync(path.join(OUT, 'relaunchcheck.json'), JSON.stringify({ app: APP, root, failed, steps: results }, null, 2));
  try { fs.copyFileSync(appLog, path.join(OUT, 'app.log')); } catch { /* none */ }
  if (!process.argv[3]) console.log(`relaunchcheck: ${root} kept for its output`); else removeTree(root);
}
// The guard: the copy is not left in LaunchServices' list.
const left = checkLeft('relaunchcheck');
console.log(failed ? `relaunchcheck: ${failed} step(s) failed` : 'relaunchcheck: every step passed');
process.exit(failed || left.length ? 1 : 0);
