#!/usr/bin/env node
// The phone app end to end, on a headless emulator against a made-up board
// (tools/demo.mjs --phone --e2e: its own HOME, its own daemons, 127.0.0.1),
// every step driven by touch and checked where it lands:
//
//   - a pairing link whose only host is a tailnet name that does not
//     resolve: the pairing screen says Tailscale, never the host;
//   - Android's Back on the pairing screen goes one step up, and leaves only
//     from the camera;
//   - the stand-in tailnet name answering (a debug build's DebugNet): it
//     pairs, and the top bar's connection chip says Tailscale;
//   - the real link pairs, and the home is the board (PhoneProjects C);
//   - a chip swaps the project's detail in place; the idle chip's sheet
//     opens an idle project;
//   - the live screen of a 140 x 40 pane, full screen: its lines laid out at
//     the phone's width (a soft-wrapped paragraph joined, no sideways
//     scroll), a touch drag scrolls back, new lines bring the jump pill,
//     which goes back to the bottom; text typed with the soft keyboard and
//     a key bar key reach the pane; the pane stays 140 x 40 before, during
//     (keyboard open) and after;
//   - an answer in the question card reaches the hub (a checkpoint's);
//   - New session (NewSession D) starts a real pane in the project's folder
//     running the stand-in claude with the words, shown as Starting; the
//     Sessions card then opens the other session;
//   - Sign out: the time from the tap to the pairing screen, and the device
//     gone from the hub (its token refused);
//   - pictures of each screen, dark and light, at 412 x 915;
//   - the way back: Android's Back on every screen, sheet and modal goes one
//     level up (the rows of hub/tools/phone-back-test.mjs, by touch), a sheet
//     closes on a swipe down, Settings is the menu's only;
//   - the connection chip says Wi-Fi; Reconnecting then Offline while
//     the board's process is stopped, Wi-Fi again when it runs; the
//     details sheet's Reconnect reconnects;
//   - the launch (docs/PHONE.md, The launch): a cold start from the
//     launcher, recorded (launch-cold.webm), gfxinfo's frames; none on a
//     warm start; the still mark and the board at once with animations off.
//     Android 13 and later (the Mac's Ink as a shader): its first frames
//     within the GPU budget, the 3.4 s played and the mark landing on the
//     top bar's; a touch ends it; Reaching your Mac... once the raven has
//     formed (2.15 s) with the board stopped, then the landing; a GPU over
//     the budget (a debug build's ravenry_ink_budget) plays today's version.
//     Under 13 (today's version): the splash ending within 1 s (12; 8 to 11
//     the window's still mark), the mark flying to the top bar's;
//     Reaching your Mac... only after 1.4 s with the board stopped.
//
//   node build.mjs && (cd ../android && ./gradlew assembleDebug)
//   node tools/phone-e2e.mjs <outDir> [--port 5584] [--avd ravenry-pixel] [--keep] [--launch-only]
//
// --launch-only: pair with the real link, then the launch's checks only (an
// AVD of Android 12 or older for today's version, where the rest is not run).
//
// Only an emulator: it starts its own, headless, read-only, names it on
// every adb command (`-s emulator-<port>`), checks ro.kernel.qemu=1, and
// stops it at the end (with the board and its daemons). Never a phone.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(APP_DIR, '.tmp', 'phone-e2e'));
const WORK = path.resolve(opt('--work', path.join(APP_DIR, '.tmp', 'phone-e2e-work')));
const PORT = Number(opt('--port', 5584));
const SERIAL = `emulator-${PORT}`;
const AVD = opt('--avd', 'ravenry-pixel');
const LAUNCH_ONLY = args.includes('--launch-only');
// The host's GPU, headless all the same (no window): frame times mean something.
const GPU = opt('--gpu', 'host');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK, 'emulator', 'emulator');
const APK = path.resolve(opt('--apk', path.join(REPO, 'apps/android/app/build/outputs/apk/debug/app-debug.apk')));
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const APP = 'dev.ravenry.app';
for (const [f, what] of [[BIN, 'ravenryd (daemon/README.md)'], [APK, 'the debug APK (./gradlew assembleDebug in apps/android)']]) if (!fs.existsSync(f)) { console.error(`missing ${what}: ${f}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: !!ok, what }); console.log(ok ? 'PASS' : 'FAIL', what, detail ? `  ${detail}` : ''); };
const t0 = Date.now();

let demo = null;
let emu = null;
const adbRaw = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adb = (...a) => adbRaw(...a);
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });
let info = null;
try {
  // ------------------------------------------------------------ the board
  demo = spawn(process.execPath, [path.join(HERE, 'demo.mjs'), '--phone', '--e2e', '--dir', WORK], { env: { ...process.env, RAVENRYD: BIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let demoLog = '';
  demo.stdout.on('data', (d) => { demoLog += d; });
  demo.stderr.on('data', (d) => { demoLog += d; });
  info = await until(() => (/demo hub on/.test(demoLog) ? JSON.parse(fs.readFileSync(path.join(WORK, 'demo.json'), 'utf8')) : null), 90000, 500);
  if (!info || !info.wide) throw new Error(`the demo board did not start:\n${demoLog}`);
  const HUB = info.url;
  const dEnv = { HOME: WORK, PATH: '/usr/bin:/bin', RAVENRY_RUNTIME_DIR: info.runtime, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
  const panes = () => { const j = JSON.parse(execFileSync(BIN, ['ls', '--json'], { env: dEnv, encoding: 'utf8' })); return Array.isArray(j) ? j : j.panes || []; };
  const sizeOf = (id) => { const p = panes().find((x) => x.id === id); return p ? `${p.cols}x${p.rows}` : null; };
  const capture = (id) => execFileSync(BIN, ['capture', id, '--history', '200'], { env: dEnv, encoding: 'utf8' });
  const WIDE = info.wide.pane;
  console.log(`board ${HUB}, wide pane ${WIDE} ${sizeOf(WIDE)}`);

  // ------------------------------------------------------------ the emulator
  const booted = () => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } };
  if (!booted()) {
    emu = spawn(EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only', '-gpu', GPU], { stdio: 'ignore' });
    await until(booted, 240000, 2000);
  }
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator`);
  const API = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  adb('install', '-r', APK);
  adb('shell', 'pm', 'clear', APP);
  if (API >= 33) adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'pm', 'grant', APP, 'android.permission.CAMERA');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  const demoBar = (cmd, extra = []) => adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', cmd, ...extra);
  demoBar('enter'); demoBar('clock', ['-e', 'hhmm', '1755']); demoBar('notifications', ['-e', 'visible', 'false']); demoBar('battery', ['-e', 'level', '80', '-e', 'plugged', 'false']); demoBar('network', ['-e', 'wifi', 'show', '-e', 'level', '4']);
  const size = adb('shell', 'wm', 'size').trim();
  const dens = adb('shell', 'wm', 'density').trim();
  console.log(`${SERIAL}: API ${API}, ${size}, ${dens}`);

  function screen() {
    for (let i = 0; i < 4; i++) {
      try {
        adb('shell', 'uiautomator', 'dump', '/sdcard/rv-ui.xml');
        const xml = adb('exec-out', 'cat', '/sdcard/rv-ui.xml');
        return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
          const g = (k) => ((new RegExp(` ${k}="([^"]*)"`).exec(m[0]) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const b = (/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds')) || [0, 0, 0, 0, 0]).slice(1).map(Number);
          return { text: g('text'), desc: g('content-desc'), cls: g('class'), pkg: g('package'), b, x: (b[0] + b[2]) >> 1, y: (b[1] + b[3]) >> 1 };
        });
      } catch { /* moving */ }
    }
    return [];
  }
  const find = (want, nodes = screen()) => nodes.find((n) => (typeof want === 'function' ? want(n) : n.text === want || n.desc === want)) || null;
  const tap = (n) => adb('shell', 'input', 'tap', String(n.x), String(n.y));
  async function tapWhen(want, ms = 15000) {
    const n = await until(() => find(want), ms, 500);
    if (!n) throw new Error(`not on the screen: ${want}\n${screen().map((x) => x.text || x.desc).filter(Boolean).join(' | ')}`);
    tap(n);
    return n;
  }
  const shot = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p')); console.log('shot', f); return f; };
  // A fingerprint, enrolled as a person does in Settings after a PIN (as
  // tools/pick-shots.mjs does; the sensor is touched with `adb emu finger touch`).
  if (!LAUNCH_ONLY) {
    const fp = () => screen();
    adb('shell', 'locksettings', 'set-pin', '1234');
    adb('shell', 'am', 'start', '-a', 'android.settings.FINGERPRINT_ENROLL');
    await until(() => find('Re-enter your PIN') || find('Enter your PIN'), 15000, 800);
    adb('shell', 'input', 'text', '1234'); adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
    for (let i = 0; i < 6 && !find('I AGREE'); i++) { const more = find('MORE'); if (more) tap(more); await sleep(800); }
    const agree = await until(() => find('I AGREE'), 10000, 600);
    if (agree) tap(agree);
    await until(() => find('Touch the sensor'), 15000, 800);
    for (let i = 0; i < 12 && !find('Fingerprint added'); i++) { adb('emu', 'finger', 'touch', '1'); await sleep(900); }
    check(!!find('Fingerprint added', fp()), 'a fingerprint is enrolled on the emulator');
    const done = await until(() => find('DONE'), 10000, 600);
    if (done) tap(done);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  }

  // The page in the WebView, through DevTools (a debug build allows it).
  async function page(expression) {
    const pid = adb('shell', 'pidof', APP).trim();
    if (!pid) return null;
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pg = pages.find((p) => p.type === 'page' && p.url.startsWith('https://appassets.androidplatform.net/'));
      if (!pg) return null;
      const ws = new WebSocket(pg.webSocketDebuggerUrl);
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
      const reply = new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m.result && m.result.result ? m.result.result.value : null); }; });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      const v = await Promise.race([reply, sleep(6000).then(() => null)]);
      ws.close();
      return v;
    } finally {
      try { adb('forward', '--remove', `tcp:${port}`); } catch { /* gone */ }
    }
  }
  // The WebView's corner on the screen, found once: it never moves, and
  // uiautomator can stall for a while after the fingerprint prompt.
  let webAt = null;
  const webView = () => { if (!webAt) webAt = find((n) => n.cls === 'android.webkit.WebView'); return webAt; };
  async function rectOf(selector) {
    const r = await until(() => page(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })()`), 15000, 400);
    const web = webView();
    if (!web || !r) throw new Error(`not on the page: ${selector}`);
    return { x: web.b[0] + r.x * r.dpr, y: web.b[1] + r.y * r.dpr, w: r.w * r.dpr, h: r.h * r.dpr };
  }
  async function tapPage(selector) { const r = await rectOf(selector); adb('shell', 'input', 'tap', String(Math.round(r.x + r.w / 2)), String(Math.round(r.y + r.h / 2))); }
  // A tap that must show something: tapped again (at most three times) when the board drew itself anew under the first.
  async function tapUntil(selector, done, ms = 4000) {
    for (let i = 0; i < 3; i++) {
      await tapPage(selector);
      const v = await until(done, ms, 300);
      if (v) return v;
    }
    return null;
  }
  const typeText = (text) => { for (const word of text.split(' ').map((w, i) => (i ? ' ' : '') + w)) adb('shell', 'input', 'text', word.replace(/ /g, '%s').replace(/([,.;'"()&!?])/g, '\\$1')); };
  const keyboardUp = () => /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'));

  // The resumed activity (Android 10 and later say topResumedActivity; Android 11's dump may carry only mResumedActivity).
  const resumed = () => { const d = adb('shell', 'dumpsys', 'activity', 'activities'); return (d.match(/topResumedActivity=.*?\/(\.\w+)/) || d.match(/mResumedActivity: .*?\/(\.\w+)/) || [])[1] || null; };

  // The launch (docs/PHONE.md, The launch), from the launcher; the app in the background to begin with.
  async function launchSection() {
    const inkLog = () => adb('logcat', '-d', '-s', 'RavenryInk');
    const msOf = (re, log) => { const m = re.exec(log); return m ? Number(m[1]) : null; };
    async function launch({ record = null, waitFor = /exit done|board ready/, ms: wait = 20000, during = null } = {}) {
      adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      await sleep(800);
      adb('shell', 'input', 'swipe', '540', '2000', '540', '600', '300');
      await sleep(1500);
      const icon = find((n) => n.text === 'Ravenry' && n.pkg !== APP);
      if (!icon) throw new Error('the launcher shows no Ravenry');
      adb('logcat', '-c');
      try { adb('shell', 'dumpsys', 'gfxinfo', APP, 'reset'); } catch { /* not running */ }
      if (record) { adb('emu', 'screenrecord', 'start', '--time-limit', '8', '--fps', '60', path.join(OUT, record)); await sleep(400); }
      const at = Date.now();
      tap(icon);
      if (during) await during();
      const log = await until(() => { const l = inkLog(); return waitFor.test(l) ? l : null; }, wait, 300) || inkLog();
      if (record) { await sleep(1500); try { adb('emu', 'screenrecord', 'stop'); } catch { /* done */ } await sleep(1500); }
      return { log, at };
    }
    const SHADER = API >= 33;
    const last = (log, n = 2) => log.trim().split('\n').slice(-n).map((l) => l.replace(/^.*RavenryInk: /, '')).join(' | ');
    // The bar's mark where the page draws it (screen px): its glyph centre, as InkLaunch.barMark.
    const barMark = async () => { const r = await rectOf('#pbar .pn-ttl svg'); const k = r.w / 100; return { x: r.x + k * (4.77 + 0.8954 * 50.5), y: r.y + k * (-2.10 + 0.8954 * 58.5) }; };
    // Warm: the app is in the background: no launch.
    const warm = await launch({ waitFor: /never/, ms: 2500 });
    const warmSplash = /SplashScreenView: Build/.test(adb('logcat', '-d', '-s', 'SplashScreenView'));
    check(!/cold start/.test(warm.log) && !warmSplash && resumed() === '.MainActivity', 'a warm start (the app in the background): no splash and no Ink, the board at once', `${warm.log.trim().split('\n').pop() || 'no Ink log'}; splash ${warmSplash}`);
    // Cold, recorded.
    adb('shell', 'am', 'force-stop', APP);
    const cold = await launch({ record: 'launch-cold.webm', waitFor: SHADER ? /shader ink: ended|exit done/ : /exit done/ });
    const gfx = adb('shell', 'dumpsys', 'gfxinfo', APP);
    const g2 = (re) => (re.exec(gfx) || [])[1];
    if (SHADER) {
      // Android 13 and later: the Mac's Ink as a shader over the board.
      const guard = /shader ink: first frames ([\d.]+) ms on the GPU, ([\d.]+) ms in all \(budget ([\d.]+) ms\): (\w+ ?\w*)/.exec(cold.log);
      check(/launch path: shader/.test(cold.log) && guard && guard[4] === 'fine', 'Android 13 and later: a cold start plays the Mac\'s Ink as a shader, its first frames within the GPU budget', guard ? `${guard[1]} ms a frame on the GPU, ${guard[2]} ms in all (budget ${guard[3]} ms)` : last(cold.log, 4));
      const ended = /shader ink: ended \((\w+)\) after (\d+) frames, (\d+) ms/.exec(cold.log);
      const lands = /shader ink lands at ([\d.]+),([\d.]+)/.exec(cold.log);
      const want = await barMark();
      check(ended && ended[1] === 'done' && Number(ended[2]) >= 60 && Number(ended[3]) >= 3400 && lands && Math.abs(lands[1] - want.x) < 2 && Math.abs(lands[2] - want.y) < 2, 'the Ink plays its 3.4 s and the mark lands on the top bar\'s mark, the board washed in from there', ended && lands ? `${ended[2]} frames in ${ended[3]} ms (board ready at ${msOf(/board ready at (\d+) ms/, cold.log)} ms); landed at ${Math.round(lands[1])},${Math.round(lands[2])} (the bar's mark at ${Math.round(want.x)},${Math.round(want.y)})` : last(cold.log, 4));
    } else {
      const splashGo = msOf(/splash let go at (\d+) ms/, cold.log);
      const splashEnd = msOf(/splash ended at (\d+) ms/, cold.log);
      if (API >= 31) {
        // The app lets the splash go once the Ink has played (800 ms); the system
        // then takes it down at the app's next frame (the hold under it draws the
        // same picture, so nothing shows the step).
        check(/AnimatableIconAnimateListener/.test(adb('logcat', '-d', '-s', 'SplashScreenView')) && splashGo !== null && splashGo <= 1000, 'a cold start from the launcher plays the Ink (the splash\'s animated icon) and the app lets the splash go within 1 s', `let go ${splashGo} ms after the process started, taken down by the system at ${splashEnd} ms`);
      } else {
        check(/launch path: today's \(api \d+\)/.test(cold.log) && splashEnd !== null && splashEnd <= 1500, 'Android 8 to 11: a cold start shows the window\'s still mark (no splash API), held by the app from its first frame', `held from ${splashEnd} ms after the process started`);
      }
      const exitM = /exit: (\d+) frames.*the mark at (\d+),(\d+) scale ([\d.]+) \(target ([\d.]+),([\d.]+) scale ([\d.]+)\)/.exec(cold.log);
      check(/launch path: today's/.test(cold.log) && exitM && Number(exitM[1]) >= 10 && Math.abs(exitM[2] - exitM[5]) < 2 && Math.abs(exitM[3] - exitM[6]) < 2, 'today\'s version: the mark flies to the top bar\'s mark and lands on it, the board revealed from there', exitM ? `${exitM[1]} frames in ${msOf(/exit done at (\d+)/, cold.log) - msOf(/exit from .* at (\d+) ms/, cold.log)} ms, landed at ${exitM[2]},${exitM[3]} (the bar's mark at ${Math.round(exitM[5])},${Math.round(exitM[6])})` : cold.log);
    }
    check(fs.existsSync(path.join(OUT, 'launch-cold.webm')), 'the cold start is recorded (launch-cold.webm, frames to compare with the approved strip)');
    console.log(`gfxinfo over the launch: ${g2(/Total frames rendered: (\d+)/)} frames, janky ${g2(/Janky frames: ([^\n]+)/)}, 50th ${g2(/50th percentile: (\d+ms)/)}, 90th ${g2(/90th percentile: (\d+ms)/)}, 99th ${g2(/99th percentile: (\d+ms)/)}, GPU 50th ${g2(/50th gpu percentile: (\d+ms)/)}, 90th ${g2(/90th gpu percentile: (\d+ms)/)}`);
    if (SHADER) {
      // Any touch ends it: a tap once the ink is drawing (its first frames timed), the board then as it is
      // (or, before it is there, the hold and the flight). Before the app's first frame the system's splash
      // window is on the screen, and a touch there never reaches the app.
      adb('shell', 'am', 'force-stop', APP);
      const touched = await launch({ waitFor: /exit done|the board as it is/, during: async () => { await until(() => /shader ink: first frames/.test(inkLog()), 6000, 100); adb('shell', 'input', 'tap', '540', '1500'); } });
      const tEnd = /shader ink: ended \(touch\) after (\d+) frames, (\d+) ms/.exec(touched.log);
      check(tEnd && Number(tEnd[2]) < 3000 && /exit done|the board as it is/.test(touched.log), 'a touch ends the Ink at once, and the board comes', tEnd ? `ended ${tEnd[2]} ms in (${tEnd[1]} frames); ${last(touched.log, 1)}` : last(touched.log, 3));
      await sleep(1500);
    }
    // The Mac slow to answer: the board stopped for 6 s.
    adb('shell', 'am', 'force-stop', APP);
    process.kill(info.pid, 'SIGSTOP');
    let holdWords = null;
    try {
      const p0 = launch({ waitFor: /hold words/, ms: 12000 });
      holdWords = await until(() => find((n) => /Reaching your Mac/.test(n.text)), 15000, 300);
      if (holdWords) shot('launch-hold-dark.png');
      await p0;
    } finally { setTimeout(() => process.kill(info.pid, 'SIGCONT'), 1500); }
    const held = await until(() => { const l = inkLog(); return (SHADER ? /shader ink: ended/ : /exit done/).test(l) ? l : null; }, 30000, 500) || inkLog();
    const wordsAt = msOf(/hold words at (\d+) ms/, held);
    if (SHADER) {
      const heldMs = msOf(/shader ink: held (\d+) ms/, held);
      check(holdWords && /holding for the board/.test(held) && wordsAt >= 2150 && heldMs > 0 && /shader ink: ended \(done\)/.test(held), 'the Mac slow to answer: the raven formed holds (its eye on), Reaching your Mac... from then (after 2.15 s), then the landing', `words at ${wordsAt} ms, board at ${msOf(/board ready at (\d+) ms/, held)} ms, held ${heldMs} ms`);
    } else {
      check(holdWords && wordsAt >= 1400 && /exit done/.test(held), 'the Mac slow to answer: the same drawing holds, Reaching your Mac... only after 1.4 s, then the same exit', `words at ${wordsAt} ms, board at ${msOf(/board ready at (\d+) ms/, held)} ms`);
    }
    // Animations off: the still mark, then the board at once.
    const scales = ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale'];
    for (const k of scales) adb('shell', 'settings', 'put', 'global', k, '0');
    adb('shell', 'am', 'force-stop', APP);
    let still;
    try { still = await launch({ waitFor: /board ready/ }); await sleep(1000); still.log = inkLog(); } finally { for (const k of scales) adb('shell', 'settings', 'put', 'global', k, '1'); }
    check(/animations off/.test(still.log) && /launch path: today's \(animations off\)/.test(still.log) && /board ready/.test(still.log) && !/exit:|shader ink/.test(still.log), 'with the phone\'s animations off: the still mark, then the board at once (no flight, no shader)', last(still.log));
    if (SHADER) {
      // A GPU too slow for the shader (the debug build's budget at 0.5 ms): today's version plays in its place.
      adb('shell', 'settings', 'put', 'global', 'ravenry_ink_budget', '0.5');
      adb('shell', 'am', 'force-stop', APP);
      let slow;
      try { slow = await launch({ waitFor: /exit done/ }); } finally { adb('shell', 'settings', 'delete', 'global', 'ravenry_ink_budget'); }
      const exitS = /exit: (\d+) frames.*the mark at (\d+),(\d+) scale ([\d.]+) \(target ([\d.]+),([\d.]+) scale ([\d.]+)\)/.exec(slow.log);
      const gs = /shader ink: first frames ([\d.]+) ms on the GPU.*: too slow/.exec(slow.log);
      check(gs && /shader ink: ended \(slow\)/.test(slow.log) && /launch path: today's \(the shader too slow here\)/.test(slow.log) && /vector ink played/.test(slow.log) && exitS && Math.abs(exitS[2] - exitS[5]) < 2 && Math.abs(exitS[3] - exitS[6]) < 2, 'a GPU over the budget: the shader stops after its first frames and today\'s version plays (the vector Ink, the hold, the flight to the bar\'s mark)', gs && exitS ? `${gs[1]} ms a frame over a 0.5 ms budget; ended ${msOf(/shader ink: ended \(slow\) after \d+ frames, (\d+) ms/, slow.log)} ms in; flight landed at ${exitS[2]},${exitS[3]}` : last(slow.log, 4));
    }
    await until(() => page('document.querySelector("#pchips .pchip") ? 1 : null'), 15000, 500);
  }

  sections: {
  if (LAUNCH_ONLY) {
    // Paired with the real link, then the launch only.
    adb('shell', `am start -a android.intent.action.VIEW -d '${info.phone.link}' ${APP}`);
    await tapWhen('Pair', 30000);
    const paired = await until(() => page('document.querySelector("#pchips .pchip") ? location.pathname : null'), 40000, 1000);
    check(paired === '/', 'the real link pairs, and the home is the board (the project chips)', String(paired));
    await sleep(1500);
    await launchSection();
    break sections;
  }

  // ------------------------------------------------------------ 1. Tailscale off
  const real = info.phone.link;
  const q = new URL(real.replace('ravenry://', 'https://'));
  const tsLink = `ravenry://pair?v=1&name=${encodeURIComponent('MacBook Pro')}&hosts=ravenry.tail0000.ts.net&port=${q.searchParams.get('port')}&pin=${q.searchParams.get('pin')}&code=${q.searchParams.get('code')}`;
  adb('shell', `am start -a android.intent.action.VIEW -d '${tsLink}' ${APP}`);
  await tapWhen('Pair', 30000);
  const words = await until(() => find((n) => /Tailscale/.test(n.text) && /phone/.test(n.text)), 20000, 600);
  const texts = screen().map((n) => n.text).filter(Boolean);
  check(words && !texts.some((t) => /ts\.net|tail0000|\d+\.\d+\.\d+\.\d+/.test(t)) && texts.some((t) => /^(Get|Open) Tailscale$/.test(t)), 'a link whose tailnet host does not resolve: the pairing screen says Tailscale, no host or address, with a button for it', words ? words.text : texts.join(' | '));
  check(!texts.some((t) => /didn.t answer/.test(t)), 'and no "<name> didn\'t answer" line', texts.join(' | '));
  shot('pair-tailscale-dark.png');

  // ------------------------------------------------------------ 1b. Back on the pairing screen
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  const scan = await until(() => find('Pair with your Mac'), 6000, 400);
  await tapWhen((n) => /Type the code instead/.test(n.text));
  await until(() => find("The Mac's address"), 6000, 400);
  await sleep(800);
  if (keyboardUp()) { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(600); }
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  const scan2 = await until(() => find('Pair with your Mac'), 6000, 400);
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  const left = await until(() => (resumed() !== '.PairActivity' ? 1 : null), 6000, 400);
  check(scan && scan2 && left, "Android's Back on the pairing screen goes one step up (Pair with... to the camera, Type the code to the camera) and leaves only from the camera", `${!!scan} ${!!scan2} ${!!left}`);

  // ------------------------------------------------------------ 1c. through the stand-in tailnet name: Tailscale
  // The debug build's stand-in network (Reach.kt DebugNet): the tailnet name
  // answers at this machine, and a VPN counts as up.
  adb('shell', `run-as ${APP} sh -c 'mkdir -p files && echo "{\\"dns\\":{\\"ravenry.tail0000.ts.net\\":\\"10.0.2.2\\"},\\"vpn\\":true}" > files/debug-net.json'`);
  adb('shell', `am start -a android.intent.action.VIEW -d '${tsLink}' ${APP}`);
  await tapWhen('Pair', 30000);
  const tsChip = await until(() => page('(document.querySelector("#cx-chip .cx-w") || {}).textContent || null'), 40000, 1000);
  await sleep(800);
  await tapPage('#cx-chip');
  const tsHow = await until(() => page('(document.querySelectorAll(".cx-row .v")[1] || {}).textContent || null'), 6000);
  await sleep(500);
  shot('chip-tailscale-sheet-dark.png');
  check(tsChip === 'Tailscale' && /Tailscale/.test(tsHow || ''), 'paired through the tailnet name (the stand-in), the chip says Tailscale and its sheet how', `${tsChip}; ${tsHow}`);
  // Signed out here for the real link (a fresh code: the one above is used),
  // and this device taken off the hub as the Mac's Sign out does.
  adb('shell', 'pm', 'clear', APP);
  for (const d of ((await (await fetch(`${info.url}/api/phone/devices`)).json()).devices || [])) {
    await fetch(`${info.url}/api/phone/devices/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ id: d.id }) });
  }
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'pm', 'grant', APP, 'android.permission.CAMERA');
  const freshLink = (await (await fetch(`${info.url}/api/phone?code=new`)).json()).app.link;

  // ------------------------------------------------------------ 2. pairs, home is the board
  adb('shell', `am start -a android.intent.action.VIEW -d '${freshLink}' ${APP}`);
  await tapWhen('Pair', 30000);
  const board = await until(() => page('document.querySelector("#pchips .pchip") ? location.pathname : null'), 40000, 1000);
  check(board === '/', 'the real link pairs, and the home is the board (the project chips)', String(board));
  await sleep(1500);

  // ------------------------------------------------------------ 3. chips and the idle sheet
  const before = sizeOf(WIDE);
  check(before === '140x40', 'the wide pane is 140x40 before the phone looks at it', before);
  const title = () => page('(document.querySelector("#d-head h1") || {}).textContent || null');
  const t1 = await tapUntil('#pchips .pchip[data-id="weather-widget"]', async () => ((await title()) === 'weather-widget' ? 'weather-widget' : null));
  const t2 = await tapUntil('#pchips .pchip[data-id="portfolio"]', async () => ((await title()) === 'portfolio' ? 'portfolio' : null));
  const where = await page('location.pathname');
  check(t1 && t2 && where === '/', 'a chip swaps the detail in place (weather-widget, then portfolio, the same page)', `${t1} ${t2} ${where}`);
  const machines = await page('JSON.stringify({ line: document.querySelector("#memchip-m").innerText.replace(/\\s+/g, " ").trim(), chip: (document.querySelector("#pchips .pchip[data-id=recipe-box] .mtag") || {}).textContent || null })');
  const mj = JSON.parse(machines || '{}');
  check(/This Mac/.test(mj.line || '') && /devbox/.test(mj.line || '') && mj.chip === 'devbox', 'several machines: the machines line names this Mac and devbox, and recipe-box\'s chip says devbox', machines);
  shot('home-chip-tapped-dark.png');
  await tapPage('#pchips [data-idle-open]');
  const sheetRows = await until(() => page('document.querySelectorAll("#idle-sheet .bsheet .row[data-id]").length || null'), 8000);
  await sleep(600);
  shot('home-idle-sheet-dark.png');
  await tapPage('#idle-sheet .row[data-id="notes-cli"]');
  const t3 = await until(async () => ((await title()) === 'notes-cli' ? 'notes-cli' : null), 8000);
  const closed = await page('!document.querySelector("#idle-sheet .bsheet")');
  check(sheetRows >= 2 && t3 === 'notes-cli' && closed, 'the idle chip opens the sheet with every idle project, and picking one shows its detail', `${sheetRows} rows, ${t3}`);

  // ------------------------------------------------------------ 4. the live screen of a 140 x 40 pane
  await tapPage('#pchips .pchip[data-id="portfolio"]');
  await until(async () => ((await title()) === 'portfolio' ? 1 : null), 8000);
  await until(() => page('document.querySelector("#lv-lines .e") ? 1 : null'), 15000, 500);
  shot('home-chips-dark.png');
  await tapPage('#lv-tap');
  const full = await until(() => page('document.querySelector("#lv-fs:not([hidden]) #lv-scroll") && document.querySelector("#lv-keys") ? 1 : null'), 8000);
  await sleep(800);
  const lay = await page(`(() => {
    const sc = document.querySelector('#lv-scroll');
    const ent = [...document.querySelectorAll('#lv-lines .e')];
    const para = ent.find((e) => e.textContent.includes('The intro now opens'));
    const lh = para ? parseFloat(getComputedStyle(para).lineHeight) : 0;
    const cut = ent.filter((e) => e.scrollWidth > e.clientWidth + 1).length;
    return { page: document.documentElement.scrollWidth - innerWidth, sc: sc.scrollWidth - sc.clientWidth, joined: !!para && para.textContent.includes('scrolling; the old about page folds into it.'), lines: para ? Math.round(para.getBoundingClientRect().height / lh) : 0, cut, width: innerWidth };
  })()`);
  check(full && lay && lay.page <= 0 && lay.sc <= 1 && lay.cut === 0, 'full screen, the live screen fits the phone: no sideways scroll on the page or the screen, no line cut', JSON.stringify(lay));
  check(lay && lay.joined && lay.lines >= 4, 'the paragraph the pane\'s 140 columns wrapped is one line again, laid out at the phone\'s width', `${lay && lay.lines} lines at ${lay && lay.width} px`);
  check(sizeOf(WIDE) === '140x40', 'the pane is still 140x40 while the phone shows it', sizeOf(WIDE));
  shot('live-full-keybar-dark.png');

  // A touch drag scrolls back.
  const sc = await rectOf('#lv-scroll');
  const topBefore = await page('document.querySelector("#lv-scroll").scrollTop');
  const firstBefore = await page('(() => { const sc = document.querySelector("#lv-scroll"); const e = [...document.querySelectorAll("#lv-lines .e")].find((n) => n.offsetTop + n.offsetHeight > sc.scrollTop); return e ? e.textContent.slice(0, 40) : null; })()');
  const x = Math.round(sc.x + sc.w / 2);
  adb('shell', 'input', 'swipe', String(x), String(Math.round(sc.y + sc.h * 0.25)), String(x), String(Math.round(sc.y + sc.h * 0.85)), '400');
  await sleep(900);
  const topAfter = await page('document.querySelector("#lv-scroll").scrollTop');
  const firstAfter = await page('(() => { const sc = document.querySelector("#lv-scroll"); const e = [...document.querySelectorAll("#lv-lines .e")].find((n) => n.offsetTop + n.offsetHeight > sc.scrollTop); return e ? e.textContent.slice(0, 40) : null; })()');
  check(topAfter < topBefore - 50 && firstAfter !== firstBefore, 'a touch drag scrolls back through the history (the lines in view change)', `${topBefore} -> ${topAfter}: "${firstBefore}" -> "${firstAfter}"`);

  // Typed with the soft keyboard, sent: it reaches the pane; the pane keeps its size with the keyboard up.
  await tapPage('#compose');
  const kb = await until(keyboardUp, 8000, 400);
  const word = `hello from the phone ${Date.now() % 10000}`;
  typeText(word);
  await sleep(500);
  const during = sizeOf(WIDE);
  shot('live-full-typing-dark.png');
  await tapPage('#send');
  const typed = await until(() => (capture(WIDE).includes(`You said: ${word}`) ? 1 : null), 15000, 500);
  check(kb && typed, 'text typed with the soft keyboard and sent reaches the pane', word);
  check(during === '140x40', 'the pane is still 140x40 with the phone\'s keyboard up', during);
  // New lines while scrolled back: the pill, then back to the bottom.
  const pill = await until(() => page('(() => { const b = document.querySelector("#lv-jump"); return b && !b.hidden ? b.textContent : null; })()'), 20000, 600);
  shot('live-full-jump-dark.png');
  if (pill) await tapPage('#lv-jump');
  await sleep(800);
  const bottom = await page('(() => { const sc = document.querySelector("#lv-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 && document.querySelector("#lv-jump").hidden; })()');
  check(pill && bottom, 'new lines while scrolled back bring the jump pill, and it goes back to the bottom', String(pill));
  // A key bar key: Up, then Enter, reach the pane's program (it reads ESC [ A and says it).
  if (keyboardUp()) { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(600); } // the keyboard goes
  await tapPage('#lv-keys [data-key="up"]');
  await sleep(300);
  await tapPage('#lv-keys [data-key="enter"]');
  const upKey = await until(() => (/You said: \[A\s*$/m.test(capture(WIDE)) ? 1 : null), 10000, 500);
  check(upKey, 'the key bar\'s Up and Enter reach the pane\'s program', upKey ? 'it read ESC [ A, then Enter' : capture(WIDE).split('\n').slice(-6).join(' | '));
  await tapPage('[data-lv-close]');
  await sleep(600);

  // ------------------------------------------------------------ 5. the question card
  await tapPage('#pchips .pchip[data-id="notes-app"]');
  await until(() => page('document.querySelector("[data-act=cp-choice]") ? 1 : null'), 10000);
  shot('card-ask-dark.png');
  const askId = await page('document.querySelector("[data-act=cp-choice]").dataset.cp');
  await tapPage('[data-act="cp-choice"][data-k="0"]');
  const answered = await until(async () => { const r = await (await fetch(`${HUB}/api/checkpoints?all`)).json(); const c = (r.checkpoints || []).find((x) => x.id === askId); return c && c.state !== 'open' ? c : null; }, 15000, 500);
  check(answered && answered.answer && answered.answer.choice === 0 && answered.answer.by === 'phone', 'an answer in the question card reaches the hub, as the phone\'s', JSON.stringify(answered && answered.answer));
  await tapPage('#pchips .pchip[data-id="recipe-box"]');
  await until(() => page('document.querySelector("[data-act=cp-run]") ? 1 : null'), 10000);
  await sleep(600);
  await page('document.querySelector("#d-ask").scrollIntoView({ block: "start" })');
  await sleep(500);
  shot('card-approve-dark.png');

  // ------------------------------------------------------------ 6. New session (D)
  await tapPage('#pchips .pchip[data-id="portfolio"]');
  await until(async () => ((await title()) === 'portfolio' ? 1 : null), 8000);
  const panesBefore = panes().map((p) => p.id);
  const nsOn = await tapUntil('#ns', () => page('document.querySelector("#send").textContent === "Start session" ? 1 : null'));
  check(nsOn, 'the New session switch turns on: Send reads Start session');
  await tapPage('#compose');
  await until(keyboardUp, 8000, 400);
  const first = 'Check the contact line on small phones';
  typeText(first);
  if (keyboardUp()) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await sleep(500);
  await page('document.querySelector("#composer").scrollIntoView({ block: "center" })');
  await sleep(400);
  shot('newsession-on-dark.png');
  await tapPage('#send');
  const fresh = await until(() => panes().find((p) => !panesBefore.includes(p.id)) || null, 20000, 500);
  const freshScreen = fresh ? await until(() => { const c = capture(fresh.id); return c.includes('claude stand-in') ? c : null; }, 15000, 500) : null;
  check(fresh && fresh.cwd === info.wide.folder && freshScreen && freshScreen.includes(`claude stand-in: ${first}`), 'New session starts a real pane in the project\'s folder, running claude with the words', fresh ? `${fresh.id} in ${fresh.cwd}` : 'no new pane');
  const starting = await until(() => page('(() => { const r = [...document.querySelectorAll("#d-sessions .sess")].find((x) => /Starting/.test(x.textContent)); return r ? r.textContent.replace(/\\s+/g, " ").trim() : null; })()'), 15000, 500);
  check(!!starting, 'and it shows as Starting in the Sessions card', String(starting));
  await page('document.querySelector("#d-sessions").scrollIntoView({ block: "center" })');
  await sleep(500);
  shot('newsession-started-dark.png');
  // The Sessions card opens the other session (the new one, once it reported).
  await until(() => page('[...document.querySelectorAll("#d-sessions .sess[data-surface]")].length >= 2 ? 1 : null'), 20000, 600);
  const sel0 = await page('(document.querySelector("#d-sessions .sess.sel") || {}).dataset?.surface || null');
  const other = await page('(() => { const b = [...document.querySelectorAll("#d-sessions .sess[data-surface]")].find((x) => !x.classList.contains("sel")); return b ? b.dataset.surface : null; })()');
  const sel1 = other ? await tapUntil(`#d-sessions .sess[data-surface="${other}"]`, () => page(`(document.querySelector('#d-sessions .sess.sel') || {}).dataset?.surface === ${JSON.stringify(other)} ? ${JSON.stringify(other)} : null`)) : null;
  check(other && sel1 === other && sel0 !== other, 'the Sessions card opens the project\'s other session in one tap', `${sel0} -> ${sel1}`);
  check(sizeOf(WIDE) === '140x40', 'the wide pane is still 140x40 after all of it', sizeOf(WIDE));

  // ------------------------------------------------------------ 7. the menu (PhoneMenu A)
  const navOn = () => page('(document.querySelector("#bnav .pn-d.on") || {}).dataset?.pnav || null');
  const seen = [];
  for (const [k, ok] of [['ideas', 'location.hash === "#/ideas"'], ['rules', 'location.hash === "#/rules"'], ['ship', 'location.hash === "#/ship"'], ['pages', '!!document.querySelector("#pn-pages .pn-li")'], ['projects', '!!document.querySelector("#pchips .pchip") && !!document.querySelector("#d-head h1")']]) {
    const v = await tapUntil(`#bnav [data-pnav="${k}"]`, async () => ((await navOn()) === k && (await page(ok)) ? k : null));
    seen.push(`${k}:${v ? 'ok' : 'no'}`);
    if (k === 'pages') { await sleep(500); shot('menu-pages-dark.png'); }
  }
  check(seen.every((x) => x.endsWith(':ok')), 'each item of the bottom bar shows its view, lit (Ideas, Rules, Ship, Pages, Projects)', seen.join(' '));
  await tapUntil('#bnav [data-pnav="pages"]', () => page('document.querySelector("#pn-pages .pn-li") ? 1 : null'));
  const pageName = await page('(document.querySelector("#pn-pages [data-view^=\'page/\'] .pn-t1") || {}).textContent || null');
  const opened = await tapUntil('#pn-pages [data-view^="page/"]', async () => ((await page('(document.querySelector("#pv-t") || {}).textContent || null')) === pageName && (await navOn()) === 'pages' && (await page('!!document.querySelector("#pbar [data-act=pn-back]")')) ? 1 : null), 6000);
  await sleep(1500);
  shot('menu-page-dark.png');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  const backList = await until(() => page('document.querySelector("#pn-pages .pn-li") ? 1 : null'), 6000);
  await tapUntil('#pn-pages [data-view^="page/"]', () => page('document.querySelector("#pv-t") ? 1 : null'));
  const backBtn = await tapUntil('#pbar [data-act="pn-back"]', () => page('document.querySelector("#pn-pages .pn-li") ? 1 : null'));
  check(pageName && opened && backList && backBtn, 'Pages opens one of the sidebar\'s pages with Pages still lit; Back (the phone\'s and the arrow) returns to the list', String(pageName));
  await tapUntil('#bnav [data-pnav="projects"]', async () => ((await navOn()) === 'projects' ? 1 : null));
  await tapUntil('#pb-more', () => page('document.querySelector("#pmenu .pn-menu") ? 1 : null'));
  await sleep(400);
  shot('menu-more-dark.png');
  await tapPage('[data-theme-pick="light"]');
  const lit = await until(() => page('document.body.classList.contains("light") ? 1 : null'), 4000);
  await tapPage('[data-theme-pick="dark"]');
  const dark = await until(() => page('!document.body.classList.contains("light") ? 1 : null'), 4000);
  const saved = await page('localStorage.getItem("mc.theme")');
  check(lit && dark && saved === '"dark"', 'the menu\'s theme switch changes the theme (Light, then Dark), and keeps it', String(saved));
  await tapPage('#pmenu [data-act="pn-menu-close"]');

  // ------------------------------------------------------------ 7b. the way back (Android's Back on every row)
  const back = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  const look = async () => JSON.parse(await page(`JSON.stringify((() => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const layers = [...document.querySelectorAll('[role="dialog"], [role="menu"], #plan-phone:not(:empty)')].filter((e) => !e.hidden && vis(e));
    const tl = [...document.querySelectorAll('button, a, [data-act="pn-back"]')].filter((e) => e.matches('[aria-label^="Back"], [data-act="pn-back"]') || /^back$/i.test((e.textContent || '').trim())).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.left < 80 && r.top < 120; });
    const done = [...document.querySelectorAll('.bs-done, [aria-label="Close"], [data-act="pn-menu-close"], [data-lv-close]')].filter(vis);
    return { layers: layers.length, way: tl.length > 0 ? 'arrow' : done.length ? 'done' : 'none', lvFull: !!(history.state && history.state.lvFull), pnav: (document.querySelector('#bnav .pn-d.on') || {}).dataset?.pnav || null, title: ((document.querySelector('#pbar .pn-ttl') || {}).textContent || '').trim(), sug: !!document.querySelector('[data-rtab="sug"].on, [data-rtab="sug"][aria-selected="true"]'), stuck: window.ravenryBackStuck || 0 };
  })())`) || 'null');
  const toProjects = async () => { if ((await navOn()) !== 'projects') await tapUntil('#bnav [data-pnav="projects"]', async () => ((await navOn()) === 'projects' ? 1 : null)); };
  const nav = (k) => tapUntil(`#bnav [data-pnav="${k}"]`, async () => ((await navOn()) === k ? 1 : null));
  const home = (t) => t && !t.layers && t.pnav === 'projects' && /Ravenry/.test(t.title);
  const atPages = (t) => t && !t.layers && t.pnav === 'pages' && t.title === 'Pages';
  const walked = [];
  async function backRow(name, open, want, way) {
    try {
      await open();
      await sleep(800);
      const before = await look();
      if (keyboardUp()) { back(); await sleep(600); }
      back();
      const after = await until(async () => { const t = await look(); return t && !t.stuck && want(t, before) ? t : null; }, 6000, 400);
      const wayOk = way === 'any' || (before && (before.way === way || (way === 'done' && before.way === 'arrow')));
      walked.push(`${name}:${after && wayOk ? 'ok' : `NO (${JSON.stringify(before)} -> ${JSON.stringify(await look())})`}`);
    } catch (e) { walked.push(`${name}:NO (${e.message.split('\n')[0]})`); }
    await toProjects().catch(() => {});
  }
  await toProjects();
  await backRow('idle sheet', () => tapPage('#pchips [data-idle-open]'), home, 'done');
  await backRow('live screen, full screen', () => tapUntil('#lv-tap', async () => ((await look()).lvFull ? 1 : null)), (t, b) => b.lvFull && !t.lvFull && home(t), 'arrow');
  await backRow('menu', () => tapUntil('#pb-more', () => page('document.querySelector("#pmenu .pn-menu") ? 1 : null')), home, 'any');
  await backRow('Settings', async () => { await tapUntil('#pb-more', () => page('document.querySelector("#pmenu .pn-menu") ? 1 : null')); await tapUntil('#pmenu [data-act="pn-settings"]', () => page('document.querySelector("#hs-pop") ? 1 : null')); }, home, 'arrow');
  await backRow('Sessions', () => tapUntil('#memchip-m', async () => ((await look()).title === 'Sessions' ? 1 : null)), home, 'arrow');
  await backRow('Search', () => tapUntil('[data-act="pn-search"]', () => page('document.querySelector("#pn-q") ? 1 : null')), home, 'arrow');
  await backRow('Pages', () => nav('pages'), home, 'any');
  await backRow('a page', async () => { await nav('pages'); await tapUntil('#pn-pages [data-view^="page/"]', () => page('document.querySelector("#pv-t") ? 1 : null')); }, atPages, 'arrow');
  await backRow('Objectives', async () => { await nav('pages'); await tapUntil('#pn-pages [data-view="objectives"]', async () => ((await look()).title === 'Objectives' ? 1 : null)); }, atPages, 'arrow');
  await backRow('Ideas', () => nav('ideas'), home, 'any');
  await backRow('an idea, open', async () => { await nav('ideas'); await tapUntil('.idea', async () => ((await look()).way === 'arrow' ? 1 : null)); }, (t) => t && !t.layers && t.pnav === 'ideas' && /Ravenry/.test(t.title), 'arrow');
  await backRow('Rules', () => nav('rules'), home, 'any');
  await backRow('Rules, Suggested', async () => { await nav('rules'); await tapUntil('[data-rtab="sug"]', async () => ((await look()).sug ? 1 : null)); }, (t) => t && t.pnav === 'rules' && !t.sug, 'any');
  await backRow('Ship', () => nav('ship'), home, 'any');
  await backRow('New project', () => tapUntil('#pbar [data-act="pn-new"]', () => page('document.querySelector("#modal-title") ? 1 : null')), home, 'arrow');
  await backRow('Write the brief', async () => { await tapUntil('#pchips .pchip[data-id="portfolio"]', async () => ((await title()) === 'portfolio' ? 1 : null)); await tapUntil('[data-act="write-brief"]', () => page('document.querySelector("#modal-title") ? 1 : null')); }, home, 'arrow');
  await backRow('New plan', async () => { await tapUntil('#pchips .pchip[data-id="garden-planner"]', async () => ((await title()) === 'garden-planner' ? 1 : null)); await tapUntil('[data-act="plan-new"]', () => page('document.querySelector("#plan-phone .body") ? 1 : null')); }, home, 'arrow');
  await backRow('a plan, full page', () => page('location.hash = "#/plan/garden-planner"; 1'), home, 'arrow');
  check(walked.every((x) => x.endsWith(':ok')), `Android's Back goes one level up on every row (${walked.length}): each with its way out on the screen (a back arrow at the top left, or Done on a sheet)`, walked.filter((x) => !x.endsWith(':ok')).join(' | ') || walked.map((x) => x.split(':')[0]).join(', '));
  const noSettings = await nav('pages').then(() => page('document.querySelector("#pn-pages [data-act=pn-settings]") ? "listed" : "not listed"'));
  check(noSettings === 'not listed', 'Settings is not in Pages (the menu\'s only)', noSettings);
  await toProjects();
  // A sheet closes on a swipe down.
  await tapPage('#pchips [data-idle-open]');
  await until(() => page('document.querySelector("#idle-sheet .bsheet") ? 1 : null'), 5000);
  await sleep(500);
  const g = await rectOf('#idle-sheet .grab');
  adb('shell', 'input', 'swipe', String(Math.round(g.x + g.w / 2)), String(Math.round(g.y + g.h / 2)), String(Math.round(g.x + g.w / 2)), String(Math.round(g.y + g.h / 2 + 600)), '250');
  const swiped = await until(() => page('!document.querySelector("#idle-sheet .bsheet") ? 1 : null'), 5000);
  check(swiped, 'a sheet closes on a swipe down (the idle sheet, from its handle)');
  // Home: Back leaves the app (the warm start below brings it back).
  await sleep(500);
  back();
  const leftHome = await until(() => (resumed() !== '.MainActivity' ? 1 : null), 5000, 400);
  check(leftHome, 'at home (Projects), Android\'s Back leaves the app', String(resumed()));

  // ------------------------------------------------------------ 7c. the launch (docs/PHONE.md, The launch)
  await launchSection();

  // ------------------------------------------------------------ 7d. the connection chip
  const chipWord = () => page('(document.querySelector("#cx-chip .cx-w") || {}).textContent || null');
  const homeWifi = await until(async () => ((await chipWord()) === 'Wi-Fi' ? 1 : null), 15000, 500);
  check(homeWifi, 'the top bar\'s chip says Wi-Fi (the phone reaches the Mac at a Wi-Fi address)', String(await chipWord()));
  const stopAt = Date.now();
  process.kill(info.pid, 'SIGSTOP');
  let reAt = null, offAt = null, reach = null;
  try {
    reAt = await until(async () => ((await chipWord()) === 'Reconnecting' ? Date.now() : null), 60000, 700);
    offAt = await until(async () => ((await chipWord()) === 'Offline' ? Date.now() : null), 60000, 700);
    reach = await page('(() => { const r = document.querySelector(".rv-reach"); return r && r.getBoundingClientRect().height ? r.innerText.replace(/\\s+/g, " ").trim() : null; })()');
    await sleep(600);
    shot('chip-offline-dark.png');
  } finally { process.kill(info.pid, 'SIGCONT'); }
  const contAt = Date.now();
  const upAt = await until(async () => ((await chipWord()) === 'Wi-Fi' ? Date.now() : null), 30000, 700);
  check(reAt && offAt && upAt, 'the board\'s process stopped: the chip goes Reconnecting, then Offline (the reason words under it), and Wi-Fi again once it runs', `Reconnecting after ${reAt && Math.round((reAt - stopAt) / 100) / 10} s, Offline after ${offAt && Math.round((offAt - stopAt) / 100) / 10} s; "${reach}"; back ${upAt && Math.round((upAt - contAt) / 100) / 10} s after it ran again`);
  await page('window.__cx = []; window.addEventListener("ravenry:conn", () => window.__cx.push(window.ravenryApp.conn.state)); 1');
  await tapUntil('#cx-chip', () => page('document.querySelector(".cx-sheet") ? 1 : null'));
  await sleep(500);
  shot('chip-sheet-dark.png');
  await tapPage('[data-act="cx-reconnect"]');
  const recon = await until(async () => { const v = JSON.parse(await page('JSON.stringify(window.__cx)') || '[]'); return v.includes('reconnecting') && v[v.length - 1] === 'up' ? v : null; }, 15000, 500);
  check(recon, 'the details sheet\'s Reconnect reconnects (reconnecting, then up)', JSON.stringify(recon));

  // ------------------------------------------------------------ 8. pictures in light
  await page('localStorage.setItem("mc.theme", JSON.stringify("light")); location.reload()');
  adb('shell', 'cmd', 'uimode', 'night', 'no');
  await sleep(3500);
  await until(() => page('document.querySelector("#pchips .pchip") ? 1 : null'), 15000);
  await tapPage('#pchips .pchip[data-id="portfolio"]');
  await sleep(1500);
  shot('home-chip-tapped-light.png');
  await tapPage('#pchips [data-idle-open]');
  await sleep(1000);
  shot('home-idle-sheet-light.png');
  await page('document.querySelector("[data-idle-close].bs-done").click()');
  await tapPage('#lv-tap');
  await sleep(1500);
  shot('live-full-keybar-light.png');
  await tapPage('[data-lv-close]');
  await tapPage('#pchips .pchip[data-id="recipe-box"]');
  await sleep(1200);
  await page('document.querySelector("#d-ask").scrollIntoView({ block: "start" })');
  await sleep(500);
  shot('card-approve-light.png');
  // Run from the card: the fingerprint prompt first, then the command runs.
  const runId = await page('document.querySelector("[data-act=cp-run]").dataset.cp');
  await tapPage('[data-act="cp-run"]');
  const prompt = await until(() => find((n) => n.pkg === 'com.android.systemui' && /fingerprint|Run this command/i.test(n.text || n.desc)), 15000, 700);
  const notYet = (await (await fetch(`${HUB}/api/checkpoints?all`)).json()).checkpoints.find((x) => x.id === runId);
  adb('emu', 'finger', 'touch', '1');
  const ran = await until(async () => { const c = (await (await fetch(`${HUB}/api/checkpoints?all`)).json()).checkpoints.find((x) => x.id === runId); return c && c.state !== 'open' ? c : null; }, 20000, 500);
  check(prompt && notYet && notYet.state === 'open' && ran && ran.answer && ran.answer.approved && ran.answer.by === 'phone', 'Run in the command\'s card asks for the fingerprint first (nothing sent before), then the command is allowed, by the phone', `${prompt ? prompt.text || prompt.desc : 'no prompt'}; before: ${notYet && notYet.state}; after: ${JSON.stringify(ran && ran.answer)}`);
  await sleep(1500);
  const after = await page('JSON.stringify({ path: location.pathname, hash: location.hash, chips: [...document.querySelectorAll("#pchips .pchip[data-id]")].map((c) => c.dataset.id) })');
  console.log('after Run:', after);
  // The board again from its start (the prompt's window came and went over it).
  await page('location.replace("/")');
  await until(() => page('document.querySelector("#pchips .pchip[data-id=weather-widget]") ? 1 : null'), 15000, 500);
  await tapPage('#pchips .pchip[data-id="weather-widget"]');
  await sleep(800);
  await tapPage('#ns');
  await sleep(500);
  await page('document.querySelector("#composer").scrollIntoView({ block: "center" })');
  await sleep(500);
  shot('newsession-on-light.png');
  await tapPage('#ns');
  await tapUntil('#bnav [data-pnav="pages"]', () => page('document.querySelector("#pn-pages .pn-li") ? 1 : null'));
  await sleep(500);
  shot('menu-pages-light.png');
  await tapUntil('#pn-pages [data-view^="page/"]', () => page('document.querySelector("#pv-t") ? 1 : null'));
  await sleep(1500);
  shot('menu-page-light.png');
  await tapUntil('#bnav [data-pnav="projects"]', async () => ((await navOn()) === 'projects' ? 1 : null));
  await tapUntil('#pb-more', () => page('document.querySelector("#pmenu .pn-menu") ? 1 : null'));
  await sleep(400);
  shot('menu-more-light.png');

  // ------------------------------------------------------------ 9. settings and Sign out
  await tapPage('#pmenu [data-act="pn-app"]');
  await until(() => page('location.hash === "#/settings" && document.querySelector(".setr.red") ? 1 : null'), 10000);
  await sleep(1200);
  shot('settings-light.png');
  await tapPage('.setr.red');
  await until(() => page('document.querySelector(".sheet .sheet-r.danger") ? 1 : null'), 5000);
  const r = await rectOf('.sheet .sheet-r.danger');
  adb('logcat', '-c');
  // The Mac out of reach: the phone in airplane mode while it signs out.
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
  await sleep(2500);
  const tapAt = Date.now();
  adb('shell', 'input', 'tap', String(Math.round(r.x + r.w / 2)), String(Math.round(r.y + r.h / 2)));
  const pairUp = await until(() => (/mResumedActivity.*PairActivity|topResumedActivity.*PairActivity/.test(adb('shell', 'dumpsys', 'activity', 'activities')) ? Date.now() : null), 10000, 100);
  const shown = (adb('logcat', '-d', '-s', 'ActivityTaskManager').match(/Displayed dev\.ravenry\.app\/\.PairActivity[^+]*\+(\d+)s?(\d+)?ms/) || []);
  const ms = pairUp ? pairUp - tapAt : null;
  check(ms !== null && ms < 1500, 'Sign out changes the screen on the tap: the pairing screen shows', `${ms} ms from the tap (adb and dumpsys included)${shown[0] ? `; Android: ${shown[0].replace(/^.*Displayed /, '')}` : ''}`);
  await sleep(4000);
  const listed = ((await (await fetch(`${HUB}/api/phone/devices`)).json()).devices || []).some((x) => x.platform === 'android');
  const onAt = Date.now();
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
  const gone = await until(async () => { const d = await (await fetch(`${HUB}/api/phone/devices`)).json(); return !(d.devices || []).some((x) => x.platform === 'android') ? Date.now() : null; }, 60000, 300);
  check(listed && gone, 'with the Mac out of reach the device stays on the hub; back in reach, the retried unpair revokes it (its token then gets 401: phone-app-test, a phone signing itself out)', gone ? `still listed ${Math.round((onAt - tapAt) / 1000)} s after the tap in airplane mode; revoked ${Math.round((gone - onAt) / 100) / 10} s after the network came back` : 'still listed');
  await sleep(1000);
  shot('pair-after-signout-light.png');
  }
} catch (e) {
  console.error(e);
  try { fs.writeFileSync(path.join(OUT, 'error.png'), adbBin('exec-out', 'screencap', '-p')); } catch { /* gone */ }
  results.push({ ok: false, what: String(e.message || e) });
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`${results.length - fails} pass, ${fails} fail in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!args.includes('--keep')) {
    try { adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'); } catch { /* gone */ }
    if (emu) { try { adb('emu', 'kill'); } catch { /* gone */ } await sleep(3000); try { emu.kill('SIGTERM'); } catch { /* gone */ } }
    if (demo) { demo.kill('SIGTERM'); await sleep(2500); }
  }
  process.exitCode = fails ? 1 : 0;
}
