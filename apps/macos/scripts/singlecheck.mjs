#!/usr/bin/env node
// One Ravenry per data folder (WIN-004, SingleInstance.swift): opening
// Ravenry while it runs brings the running one's window to the front and
// the second copy quits. The app (a build.sh build, or a package's test
// twin, never the release: testapp.mjs) is copied to a throwaway folder,
// never /Applications, and started through LaunchServices as a person's
// open does (`open -n -g -a`, in the background, so the person's focus
// stays where it is), off every screen (RAVENRY_OFFSCREEN=1) in a
// throwaway HOME, data, runtime and state folder, on a daemon of its own,
// with no hub service, no updates and a hub nobody answers.
// RAVENRY_TEST_SINGLE=1 makes it take the lock off every screen; then the
// first one does what a Dock click does without being activated.
//
//   node scripts/singlecheck.mjs [APP] [OUT]
//
// running   the first one opened: its window drawn, off every screen
// second    `open -n` again: open says 0, that copy quits within 5 s and
//           says why in app.log, one process stays (the first, same pid)
// front     the first one heard it: its window ordered in front, visible,
//           not minimised, still off every screen; the app in front of
//           the person's screen is the one it was
// none      every window of the first closed (it keeps running), `open -n`
//           again: that copy quits, the first makes a window again
// Writes OUT/singlecheck.json and app.log.
import { guardSpawns } from '../../../tools/test-env.mjs';
import { track, release, removeTree, checkLeft } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { app: APP, exe: EXE0 } = testApp(process.argv[2] || path.join(HERE, '..', 'build', 'RavenryMac.app'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Short folders: the daemon's socket path stays under 104 bytes.
const root = track(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rvsi-'))));
const OUT = path.resolve(process.argv[3] || path.join(root, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const app = path.join(root, 'Applications', path.basename(APP));
fs.mkdirSync(path.dirname(app), { recursive: true });
execFileSync('/usr/bin/ditto', [APP, app]);
const exe = path.join(app, 'Contents', 'MacOS', path.basename(EXE0));
const home = path.join(root, 'h'), data = path.join(root, 'data'), rt = path.join(root, 'run'), state = path.join(root, 'state');
for (const d of [home, data, rt, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='~ > '\n");
const appLog = path.join(home, 'Library', 'Logs', 'Ravenry', 'app.log');
const report = path.join(root, 'report.json');
const env = {
  HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/zsh', TMPDIR: os.tmpdir() + '/', LANG: 'en_US.UTF-8',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state, RAVENRY_HUB_URL: 'http://127.0.0.1:9',
  RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OFFSCREEN: '1', RAVENRY_TEST_SINGLE: '1', RAVENRY_MAC_REPORT: report,
};

const results = [];
let failed = 0;
function step(name, ok, detail = {}) {
  results.push({ name, ok: !!ok, ...detail });
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}${ok ? '' : `\n     ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const alive = (pid) => spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).status === 0;
function mains() {
  const out = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').map((l) => l.trim().match(/^(\d+) (.*)$/)).filter((m) => m && (m[2] === exe || m[2].startsWith(exe + ' '))).map((m) => Number(m[1]));
}
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(100); } }
const logText = () => { try { return fs.readFileSync(appLog, 'utf8'); } catch { return ''; } };
const readReport = () => { try { return JSON.parse(fs.readFileSync(report, 'utf8')); } catch { return null; } };
const front = () => spawnSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).stdout.trim();
const open = () => spawnSync('/usr/bin/open', ['-n', '-g', '-a', app, '--args', '--offscreen'], { env, encoding: 'utf8', timeout: 20000 });
const count = (re) => logText().split('\n').filter((l) => re.test(l)).length;
const QUIT = /launch: another Ravenry with this data folder runs \(pid (\d+)\): it comes to the front, and this one quits/;
const HEARD = /launch: a second Ravenry started and quit; this one comes to the front \(off every screen in a test, not activated\): (.*)/;

const daemon = spawn(path.join(app, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 'daemon.log'), 'w')] });
try {
  for (let i = 0; !fs.readdirSync(rt).some((n) => /^ravenryd-.+\.sock$/.test(n)); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
  const front0 = front();

  // running
  const o1 = open();
  const r1 = await until(() => { const r = readReport(); return r && r.tabs?.length && r.windows?.length === 1 ? r : null; }, 30000);
  const pid1 = mains()[0];
  step('running: the first one opened through LaunchServices, its window drawn off every screen', o1.status === 0 && r1 && pid1 && r1.windows[0].visible && !r1.windows[0].onScreen,
    { open: o1.status, report: r1 && { tabs: r1.tabs.length, windows: r1.windows }, apps: mains() });

  // second
  const q0 = count(QUIT), h0 = count(HEARD);
  const t0 = Date.now();
  const o2 = open();
  const quit = await until(() => count(QUIT) > q0, 10000);
  const one = await until(() => { const m = mains(); return m.length === 1 && m[0] === pid1 ? m : null; }, 10000);
  const ms = Date.now() - t0;
  const quitLine = logText().split('\n').filter((l) => QUIT.test(l)).pop() || '';
  step('second: open -n again says 0, that copy quits and says why (the first one\'s pid), one process stays: the first', o2.status === 0 && quit && one && ms < 5000 && quitLine.includes(`(pid ${pid1})`),
    { open: o2.status, ms, line: quitLine, apps: mains(), first: pid1 });

  // front
  const heard = await until(() => count(HEARD) > h0, 5000);
  const heardLine = logText().split('\n').filter((l) => HEARD.test(l)).pop() || '';
  await sleep(1500);
  const r2 = readReport();
  step('front: the first heard it and came to the front as a Dock click does (its window ordered in front, visible, not minimised), off every screen, not activated', heard && /its window visible, ordered in front/.test(heardLine) && /1 window\(s\)/.test(heardLine)
    && r2?.windows?.length === 1 && r2.windows[0].visible && !r2.windows[0].miniaturized && !r2.windows[0].onScreen && alive(pid1),
    { line: heardLine, windows: r2?.windows });
  step('front: the app in front on the person\'s screen is the one it was', front() === front0, { before: front0, after: front() });

  // none: every window closed, then opened again
  fs.rmSync(report + '.done', { force: true });
  fs.writeFileSync(report + '.do', 'closewindows');
  const closed = await until(() => { try { return /"ok":true/.test(fs.readFileSync(report + '.done', 'utf8')); } catch { return false; } }, 5000);
  await sleep(1500);
  const q1 = count(QUIT), h1 = count(HEARD);
  fs.rmSync(report, { force: true });
  const o3 = open();
  const quit3 = await until(() => count(QUIT) > q1, 10000);
  const heard3 = await until(() => count(HEARD) > h1, 10000);
  const line3 = logText().split('\n').filter((l) => HEARD.test(l)).pop() || '';
  const r3 = await until(() => { const r = readReport(); return r && r.windows?.length === 1 ? r : null; }, 10000);
  const one3 = await until(() => { const m = mains(); return m.length === 1 && m[0] === pid1 ? m : null; }, 5000);
  step('none: with every window of the first closed (it runs on), open -n again: that copy quits, the first makes a window again, drawn off every screen', closed && o3.status === 0 && quit3 && heard3 && /a window made again visible/.test(line3) && r3 && r3.windows[0].visible && !r3.windows[0].onScreen && r3.tabs?.length && one3,
    { closed, open: o3.status, line: line3, report: r3 && { tabs: r3.tabs.length, windows: r3.windows }, apps: mains() });
  step('none: the app in front on the person\'s screen is still the one it was', front() === front0, { before: front0, after: front() });
} catch (e) {
  step('the check ran to its end', false, { error: String(e && e.stack || e) });
} finally {
  for (const p of mains()) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(800);
  for (const p of mains()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  daemon.kill();
  release(root);
  fs.writeFileSync(path.join(OUT, 'singlecheck.json'), JSON.stringify({ app: APP, at: new Date().toISOString(), failed, steps: results }, null, 2));
  try { fs.copyFileSync(appLog, path.join(OUT, 'app.log')); } catch { /* none */ }
  if (process.argv[3]) removeTree(root); else console.log(`singlecheck: ${root} kept for its output`);
}
const left = checkLeft('singlecheck');
console.log(failed ? `singlecheck: ${failed} of ${results.length} steps failed` : `singlecheck: all ${results.length} steps pass`);
process.exit(failed || left.length ? 1 : 0);
