#!/usr/bin/env node
// ON SCREEN, so only with the person's go-ahead: the window's place and size on a real screen (TERM-043, WIN-006),
// which no offscreen check can see. The dev build (apps/macos/build/RavenryMac.app, not packaged, so it installs
// nothing) with its own daemon, data folder and no board; driven through System Events (Accessibility) by pid.
// A place kept and restored, the first window's place kept with three open, cascade 29 pt, full screen never saved,
// maximised kept, and Zoom after a maximised relaunch back to the normal size. About a minute; windows appear.
// Usage: env -u RAVENRY_SOCKET -u RAVENRY_PANE -u RAVENRY_HUB_URL node apps/macos/scripts/windowscreencheck.mjs
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { standInPath } from '../../../tools/test-env.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const T = path.join(REPO, '.tmp', 'windowscreen');
const APP = path.join(REPO, 'apps', 'macos', 'build', 'RavenryMac.app');
const BIN = path.join(APP, 'Contents/MacOS/ravenryd'), EXE = path.join(APP, 'Contents/MacOS/RavenryMac');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  // A stand-in first for each assistant the PATH would find as the person's own (tools/test-env.mjs).
  HOME: `${T}/user`, PATH: standInPath({ PATH: '/usr/bin:/bin', HOME: `${T}/user` }), SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
  RAVENRY_RUNTIME_DIR: `${T}/run`, RAVENRY_STATE_DIR: `${T}/state`, RAVENRY_DESKTOP_DATA: `${T}/desktop`,
  RAVENRY_HUB_URL: 'http://127.0.0.1:9', RAVENRY_UPDATES: '0',
};
function setup() {
  fs.rmSync(T, { recursive: true, force: true });
  for (const d of ['user', 'run', 'state', 'desktop']) fs.mkdirSync(`${T}/${d}`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${T}/user/.zshrc`, "PROMPT='~ > '\n");
}
async function daemon() {
  const d = spawn(BIN, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(`${T}/daemon.log`, 'a')] });
  for (let i = 0; !fs.readdirSync(`${T}/run`).some((f) => f.endsWith('.sock')); i++) { if (i > 100) throw new Error('no daemon'); await sleep(50); }
  const sock = path.join(`${T}/run`, fs.readdirSync(`${T}/run`).find((f) => f.endsWith('.sock')));
  execFileSync(BIN, ['new', '--name', 'one', '--size', '100x30', '--label', 'ravenry.kind=shell', '--', '/bin/zsh', '-f'], { env });
  return { d, sock };
}
async function launch(sock) {
  const a = spawn(EXE, ['--socket', sock], { env, stdio: ['ignore', fs.openSync(`${T}/app.log`, 'a'), fs.openSync(`${T}/app.log`, 'a')] });
  a.exited = false; a.on('exit', () => { a.exited = true; });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (wins(a.pid).length) break; } catch {} }
  await sleep(1000);
  return a;
}
function osa(s) {
  const r = spawnSync('/usr/bin/osascript', ['-e', s], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return r.stdout.trim();
}
const proc = (pid) => `(first process whose unix id is ${pid})`;
function wins(pid) {
  const n = Number(osa(`tell application "System Events" to count windows of ${proc(pid)}`));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const v = osa(`tell application "System Events" to tell window ${i} of ${proc(pid)} to get {position, size, value of attribute "AXFullScreen", subrole}`);
    const [x, y, w, h, fs_, sub] = v.split(', ');
    out.push({ x: +x, y: +y, w: +w, h: +h, full: fs_ === 'true', sub });
  }
  return out;
}
function menus(pid) { return osa(`tell application "System Events" to get name of menu bar items of menu bar 1 of ${proc(pid)}`); }
function items(pid, m) { return osa(`tell application "System Events" to get name of menu items of menu 1 of menu bar item "${m}" of menu bar 1 of ${proc(pid)}`); }
function click(pid, m, it) {
  osa(`tell application "System Events" to tell ${proc(pid)}
  set frontmost to true
  click menu item "${it}" of menu 1 of menu bar item "${m}" of menu bar 1
end tell`);
}
function layout() {
  const f = fs.readdirSync(`${T}/desktop`).find((x) => /^window.*\.json$/.test(x));
  return f ? JSON.parse(fs.readFileSync(`${T}/desktop/${f}`, 'utf8')) : null;
}
async function quit(a, pid) {
  click(pid, 'RavenryMac', Object.values(items(pid, 'RavenryMac').split(', ')).find((x) => x.startsWith('Quit')));
  for (let i = 0; i < 40 && !a.exited; i++) await sleep(250);
  if (!a.exited) { a.kill(); throw new Error('did not quit'); }
}
function screen() {
  return osa('tell application "Finder" to get bounds of window of desktop');
}

const res = []; const ok = (n, c, info) => { res.push({ n, pass: !!c, info }); console.log(c ? 'PASS' : 'FAIL', n, JSON.stringify(info)); };
const std = (pid) => wins(pid).filter((x) => x.sub === 'AXStandardWindow');
const setPos = (pid, x, y) => osa(`tell application "System Events" to set position of window 1 of (first process whose unix id is ${pid}) to {${x}, ${y}}`);
setup(); const { d, sock } = await daemon();
let a;
try {
  a = await launch(sock); setPos(a.pid, 200, 120); await sleep(800);
  // cascade on a 900x600 window
  click(a.pid, 'Shell', 'New Window'); await sleep(1500); click(a.pid, 'Shell', 'New Window'); await sleep(1500);
  const ws = std(a.pid).sort((p, q) => p.x - q.x || p.y - q.y);
  ok('cascade_positions', new Set(ws.map((x) => `${x.x},${x.y}`)).size === 3, ws.map((x) => [x.x, x.y, x.w, x.h]));
  await quit(a, a.pid); let b = layout().bounds; ok('first_keeps_its_place', b.x === 200 && b.y === 120, b);
  // full screen on a single window
  a = await launch(sock); let w = std(a.pid); ok('relaunch_one_window_at', true, w.map((x) => [x.x, x.y, x.w, x.h]));
  if (w.length) { setPos(a.pid, 200, 120); await sleep(600); }
  click(a.pid, 'View', 'Enter Full Screen'); await sleep(3000); w = std(a.pid); ok('entered_full_screen', w.some((x) => x.full), w);
  await quit(a, a.pid); b = layout().bounds; ok('full_screen_not_saved', b.width === 900 && b.height === 600 && !b.maximized, b);
  a = await launch(sock); w = std(a.pid); ok('relaunch_not_full_screen', w.length && !w[0].full && w[0].w === 900, w);
  // zoom then relaunch then unzoom
  click(a.pid, 'Window', 'Zoom'); await sleep(1200); await quit(a, a.pid); b = layout().bounds; ok('maximized_saved', b.maximized === true, b);
  a = await launch(sock); click(a.pid, 'Window', 'Zoom'); await sleep(1200); w = std(a.pid);
  ok('unzoom_after_relaunch_back_to_normal', w[0].w === 900 && w[0].h === 600, w[0]);
} catch (e) { console.log('ERROR', e.message); }
finally { if (a && !a.exited) a.kill(); d.kill(); fs.rmSync(T, { recursive: true, force: true }); }
console.log(`${res.filter((r) => r.pass).length}/${res.length} pass`);
process.exitCode = res.every((r) => r.pass) ? 0 : 1;
