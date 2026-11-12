#!/usr/bin/env node
// The phone app end to end, on a headless emulator against a made-up board
// (tools/demo.mjs --phone --e2e: its own HOME, its own daemons, 127.0.0.1),
// every step driven by touch and checked where it lands:
//
//   - a pairing link whose only host is a tailnet name that does not
//     resolve: the pairing screen says Tailscale, never the host;
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
//   - pictures of each screen, dark and light, at 412 x 915.
//
//   node build.mjs && (cd ../android && ./gradlew assembleDebug)
//   node tools/phone-e2e.mjs <outDir> [--port 5584] [--avd ravenry-pixel] [--keep]
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
    emu = spawn(EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only'], { stdio: 'ignore' });
    await until(booted, 240000, 2000);
  }
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  adb('install', '-r', APK);
  adb('shell', 'pm', 'clear', APP);
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'pm', 'grant', APP, 'android.permission.CAMERA');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  const demoBar = (cmd, extra = []) => adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', cmd, ...extra);
  demoBar('enter'); demoBar('clock', ['-e', 'hhmm', '1755']); demoBar('notifications', ['-e', 'visible', 'false']); demoBar('battery', ['-e', 'level', '80', '-e', 'plugged', 'false']); demoBar('network', ['-e', 'wifi', 'show', '-e', 'level', '4']);
  const size = adb('shell', 'wm', 'size').trim();
  const dens = adb('shell', 'wm', 'density').trim();
  console.log(`${SERIAL}: ${size}, ${dens}`);

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
  {
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

  // ------------------------------------------------------------ 2. pairs, home is the board
  adb('shell', `am start -a android.intent.action.VIEW -d '${real}' ${APP}`);
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
