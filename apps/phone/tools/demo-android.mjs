#!/usr/bin/env node
// The demo (src/demo.ts, the Android shell's Demo.kt) on a headless
// emulator at 360 dp, every step by touch and checked where it lands, in
// airplane mode the whole time, with the app's sockets counted (none):
//
//   1. alerts not allowed: the demo never asks for them, and posts none;
//   2. dark: "No Mac yet? Try the demo" on the pairing screen; the board
//      with the bar; each bottom bar item and one more screen behind it;
//      the live screen full; the question arrives, its alert ("Demo:
//      notes-app needs you", "...Sample question. Your answer stays on this
//      phone.") answered by its Ship it (the card closes); the command run;
//      the pick, B with a circle; the settings; Pair your Mac: the pairing
//      screen;
//   3. light: the same, the question answered in its card (its alert goes),
//      the command refused, and Back at the board's home out of the demo;
//   4. paired with a test hub (tools/demo.mjs --phone): no demo line, and
//      the demo's intent opens the real board.
//
//   node tools/demo-android.mjs <outDir> [--port 5590] [--avd ravenry-pixel]   (after ./gradlew assembleDebug)
//
// It starts its own read-only emulator and names it on every adb command.
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
const OUT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(APP_DIR, '.tmp', 'demo-android'));
const WORK = path.resolve(opt('--work', path.join(APP_DIR, '.tmp', 'demo-android-work')));
const PORT = Number(opt('--port', 5590));
const SERIAL = `emulator-${PORT}`;
const AVD = opt('--avd', 'ravenry-pixel');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK, 'emulator', 'emulator');
const APK = path.resolve(opt('--apk', path.join(REPO, 'apps/android/app/build/outputs/apk/debug/app-debug.apk')));
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const APP = 'dev.ravenry.app';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 300) {
  const end = Date.now() + ms;
  for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); }
}
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: !!ok, what, detail }); console.log(ok ? 'PASS' : 'FAIL', what, detail ? `  ${detail}` : ''); };
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });

let emu = null;
let hub = null;
try {
  const booted = () => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } };
  if (!booted()) {
    emu = spawn(EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only', '-gpu', 'host'], { stdio: 'ignore' });
    await until(booted, 240000, 2000);
  }
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} is not an emulator`);
  const API = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  try { adb('install', '-r', APK); } catch (e) {
    if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(e.stderr || e.message))) throw e;
    adb('uninstall', APP); adb('install', APK);
  }
  adb('shell', 'pm', 'clear', APP);
  // 360 dp, as a narrow phone.
  const px = Number((/(\d+)x\d+/.exec(adb('shell', 'wm', 'size')) || [])[1]);
  adb('shell', 'wm', 'density', String(Math.round((px * 160) / 360)));
  const UID = (/uid:(\d+)/.exec(adb('shell', 'cmd', 'package', 'list', 'packages', '-U', APP)) || [])[1];
  if (!UID) throw new Error('the app\'s uid is unknown');
  // The camera's screen without Android's dialog over it.
  adb('shell', 'pm', 'grant', APP, 'android.permission.CAMERA');
  console.log(`${SERIAL}: API ${API}, ${adb('shell', 'wm', 'size').trim()}, density ${adb('shell', 'wm', 'density').trim()}, app uid ${UID}`);

  // ------------------------------------------------------------ helpers
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
  const shot = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p')); return f; };
  const resumed = () => { const d = adb('shell', 'dumpsys', 'activity', 'activities'); return (d.match(/topResumedActivity=.*?\/(\.\w+)/) || d.match(/mResumedActivity: .*?\/(\.\w+)/) || [])[1] || null; };
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
    } catch { return null; } finally {
      try { adb('forward', '--remove', `tcp:${port}`); } catch { /* gone */ }
    }
  }
  let webAt = null;
  const webView = () => { const w = find((n) => n.cls === 'android.webkit.WebView'); if (w) webAt = w; return webAt; };
  async function rectOf(selector) {
    const r = await until(() => page(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })()`), 15000, 400);
    const web = webView();
    if (!web || !r) throw new Error(`not on the page: ${selector}`);
    return { x: web.b[0] + r.x * r.dpr, y: web.b[1] + r.y * r.dpr, w: r.w * r.dpr, h: r.h * r.dpr };
  }
  async function tapPage(selector) { const r = await rectOf(selector); adb('shell', 'input', 'tap', String(Math.round(r.x + r.w / 2)), String(Math.round(r.y + r.h / 2))); await sleep(900); }
  // The app's sockets now, from the kernel's tables (its uid's rows): the demo must have none.
  const sockets = () => {
    let n = 0;
    for (const t of ['tcp', 'tcp6', 'udp', 'udp6']) {
      let txt = '';
      try { txt = adb('shell', 'cat', `/proc/net/${t}`); } catch { continue; }
      for (const line of txt.trim().split('\n').slice(1)) { const c = line.trim().split(/\s+/); if (c[7] === UID) n++; }
    }
    return n;
  };
  const socketSeen = [];
  const watchSockets = setInterval(() => { try { socketSeen.push(sockets()); } catch { /* adb busy */ } }, 2500);
  const shade = { open: () => adb('shell', 'cmd', 'statusbar', 'expand-notifications'), close: () => adb('shell', 'cmd', 'statusbar', 'collapse') };
  const barOk = async (where, scheme) => {
    const b = await until(() => page(`(() => { const b = document.querySelector('.rv-demo'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, text: b.textContent, on: document.elementFromPoint(20, r.top + r.height / 2)?.closest('.rv-demo') === b }; })()`), 6000, 400);
    check(b && b.top === 0 && b.on && /^Demo\. Sample projects, nothing leaves this phone\.Pair your Mac$/.test(b.text), `${scheme}: the demo's bar is on top of ${where}`, b ? '' : 'no bar');
  };

  // ------------------------------------------------------------ offline, as a reviewer's phone may be
  adb('logcat', '-c');
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
  await sleep(2000);
  check(/1/.test(adb('shell', 'settings', 'get', 'global', 'airplane_mode_on')), 'airplane mode on for the whole demo');

  const openPairing = async () => { adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`); return until(() => resumed() === '.PairActivity' && find((n) => /Try the demo/.test(n.text)), 15000, 500); };

  // 1. Alerts not allowed: no ask, no alert.
  if (API >= 33) { try { adb('shell', 'pm', 'revoke', APP, 'android.permission.POST_NOTIFICATIONS'); } catch { /* not granted */ } }
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  const entry = await openPairing();
  check(!!entry, 'not paired: the pairing screen says "No Mac yet? Try the demo" at its foot', entry ? entry.text : '');
  tap(entry);
  await until(() => page('!!document.querySelector(".rv-demo")'), 20000, 500);
  await sleep(9000);
  const asked = find((n) => /Allow Ravenry to send you notifications/.test(n.text));
  const alerted = /demo:/.test(adb('shell', 'dumpsys', 'notification', '--noredact'));
  check(!asked && resumed() === '.MainActivity' && !alerted, 'alerts not allowed: the demo never asks for them and posts none', `asked ${!!asked}, posted ${alerted}`);
  await tapPage('.rv-demo button');
  check(await until(() => resumed() === '.PairActivity', 8000, 400), 'Pair your Mac: the pairing screen');
  if (API >= 33) adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');

  async function visit(scheme) {
    adb('shell', 'cmd', 'uimode', 'night', scheme === 'dark' ? 'yes' : 'no');
    await sleep(1500);
    const e = await openPairing();
    shot(`a01-pairing-${scheme}.png`);
    tap(e);
    const ok = await until(() => page('!!document.querySelector(".rv-demo") && document.querySelectorAll("#pchips .pchip").length >= 4'), 20000, 500);
    check(ok, `${scheme}: Try the demo opens the board on sample projects`);
    await sleep(1200);
    await barOk('the board', scheme);
    check(await page('!document.querySelector(".cx-chip") || document.querySelector(".cx-chip").offsetParent === null'), `${scheme}: no connection chip, no Show on Mac`);
    shot(`a02-board-${scheme}.png`);
    for (const k of ['ideas', 'rules', 'ship', 'pages']) {
      await tapPage(`#bnav [data-pnav="${k}"]`);
      await barOk(k, scheme);
      shot(`a03-${k}-${scheme}.png`);
      const more = { ideas: '#sheet [data-idea]', rules: '#sheet [data-rtab="sug"]', ship: '#sheet [data-goto]', pages: '#sheet button' }[k];
      const was = await page('document.querySelector("#sheet").innerText.slice(0, 300)');
      await tapPage(more);
      await sleep(600);
      const now = await page('document.querySelector("#sheet").innerText.slice(0, 300)');
      check(now && now !== was, `${scheme}: one more screen behind ${k}`);
      shot(`a04-${k}-more-${scheme}.png`);
      // Back one level (Ship's project is the Projects page itself, the demo's home: Back there would leave the demo).
      if (k !== 'ship') { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(900); }
    }
    await tapPage('#bnav [data-pnav="projects"]');
    // The live screen, full.
    await tapPage('#pchips .pchip[data-id="paper-boat"]');
    await tapPage('#lv-scroll');
    check(await until(() => page('!document.querySelector("#lv-fs").hidden'), 5000, 400), `${scheme}: the live screen full`);
    await barOk('the live screen', scheme);
    shot(`a05-live-${scheme}.png`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(900);

    // The question arrives, with its alert.
    check(await until(() => page('window.ravenryDemo && window.ravenryDemo.asked()'), 15000, 500), `${scheme}: notes-app's question arrives`);
    const posted = await until(() => { const d = adb('shell', 'dumpsys', 'notification', '--noredact'); return /tag=demo:/.test(d) ? d : null; }, 8000, 500);
    shade.open();
    await sleep(1500);
    const title = await until(() => find('Demo: notes-app needs you'), 6000, 500);
    const text = find((n) => /Sample question\. Your answer stays on this phone\.$/.test(n.text));
    check(posted && title && text, `${scheme}: the alert "Demo: notes-app needs you", its text ending "Sample question. Your answer stays on this phone."`, text ? text.text : '');
    shot(`a06-alert-${scheme}.png`);
    if (scheme === 'dark') {
      await tapWhen('Ship it');
      await sleep(1500);
      check(!!find((n) => n.text === 'Sent: Ship it'), 'dark: the alert\'s Ship it says "Sent: Ship it" in the shade');
      shot('a07-alert-answered-dark.png');
      shade.close();
      await sleep(800);
      await tapPage('#pchips .pchip[data-id="notes-app"]');
      check(await until(() => page('!document.querySelector("[data-act=cp-choice]")'), 5000, 400), 'dark: answered from its alert, the question\'s card is closed on the board');
    } else {
      shade.close();
      await sleep(800);
      await tapPage('#pchips .pchip[data-id="notes-app"]');
      shot(`a07-question-${scheme}.png`);
      await tapPage('[data-act="cp-choice"][data-k="0"]');
      check(await until(() => page('!document.querySelector("[data-act=cp-choice]")'), 5000, 400), `${scheme}: Ship it in the card: the card closes`);
      check(await until(() => !/tag=demo:/.test(adb('shell', 'dumpsys', 'notification', '--noredact')), 5000, 500), `${scheme}: answered on the board, its alert leaves the shade`);
    }
    shot(`a08-question-answered-${scheme}.png`);
    // The command.
    await tapPage('#pchips .pchip[data-id="recipe-box"]');
    await rectOf('[data-act="cp-run"]');
    shot(`a09-approval-${scheme}.png`);
    if (scheme === 'dark') {
      await tapPage('[data-act="cp-run"]');
      check(await until(() => page('!document.querySelector("[data-act=cp-run]") && /Published recipe-box 2\\.3\\.0/.test(document.querySelector("#lv-lines").innerText)'), 10000, 500), 'dark: Run: the card closes, the command runs on the live screen (no fingerprint set up, none asked)');
    } else {
      await tapPage('[data-act="cp-refuse"]');
      const why = await page('(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Refuse$/.test(x.textContent.trim()) && x.offsetParent && !x.dataset.act); return b ? (b.click(), true) : false; })()');
      check(await until(() => page('!document.querySelector("[data-act=cp-refuse]") && !/Published recipe-box/.test(document.querySelector("#lv-lines").innerText)'), 8000, 500), `${scheme}: Refuse: the card closes, nothing runs`, why ? 'confirmed in its sheet' : '');
    }
    shot(`a10-approval-answered-${scheme}.png`);
    // The pick, B with a circle.
    await tapPage('#pchips .pchip[data-id="paper-boat"]');
    await tapPage('[data-act="cp-open"]');
    check(await until(() => page('location.pathname.startsWith("/phone/") && document.querySelectorAll(".ptrack img").length === 3 && [...document.querySelectorAll(".ptrack img")].every((i) => i.complete && i.naturalWidth > 0)'), 10000, 500), `${scheme}: Compare opens the app's pick screen, its three pictures from the app's own files`);
    await barOk('the pick', scheme);
    shot(`a11-pick-${scheme}.png`);
    const tr = await rectOf('.ptrack');
    adb('shell', 'input', 'swipe', String(Math.round(tr.x + tr.w * 0.8)), String(Math.round(tr.y + tr.h / 2)), String(Math.round(tr.x + tr.w * 0.15)), String(Math.round(tr.y + tr.h / 2)), '250');
    check(await until(() => page('/B, 2 of 3/.test(document.body.innerText)'), 5000, 400), `${scheme}: a swipe to B`);
    await page('[...document.querySelectorAll("button")].find((x) => /Circle a part/.test(x.textContent)).click()');
    await sleep(1200);
    await barOk('the pick\'s viewer', scheme);
    const st = await rectOf('.pzv-stage');
    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    const pts = Array.from({ length: 17 }, (_, i) => [Math.round(cx + Math.cos(i / 16 * Math.PI * 2) * st.w * 0.18), Math.round(cy + Math.sin(i / 16 * Math.PI * 2) * st.h * 0.14)]);
    adb('shell', 'input', 'motionevent', 'DOWN', String(pts[0][0]), String(pts[0][1]));
    for (const [x, y] of pts.slice(1)) adb('shell', 'input', 'motionevent', 'MOVE', String(x), String(y));
    adb('shell', 'input', 'motionevent', 'UP', String(pts[16][0]), String(pts[16][1]));
    await sleep(1200);
    const circled = await page('!!document.querySelector(".pzv-box svg.ov polyline, .pzv-box svg polyline")');
    check(circled, `${scheme}: B circled with a finger`);
    shot(`a12-pick-circled-${scheme}.png`);
    const sent = await page('(() => { const b = [...document.querySelectorAll(".pzv button.pri")].find((x) => /^Send B|^Pick B/.test(x.textContent)); return b ? (b.click(), b.textContent) : null; })()');
    check(sent && /B/.test(sent), `${scheme}: B sent with its circle`, String(sent));
    check(await until(() => page('location.pathname === "/" && !!document.querySelector("#pchips .pchip") && !(window.ravenryDemo.openCheckpoints() || []).length'), 10000, 500), `${scheme}: back on the board, every card answered and closed`);
    shot(`a13-answered-${scheme}.png`);
    // The settings.
    await tapPage('#pb-more');
    await tapPage('#pmenu [data-act="pn-app"]');
    check(await until(() => page('location.hash === "#/settings" && /A sample Mac, for the demo/.test(document.body.innerText) && /Leave the demo/.test(document.body.innerText)'), 8000, 400), `${scheme}: This phone's settings say it is the demo, with Leave the demo`);
    await barOk('the settings', scheme);
    shot(`a14-settings-${scheme}.png`);
    const misses = await page('window.ravenryDemo ? window.ravenryDemo.misses : null');
    check(Array.isArray(misses) && misses.length === 0, `${scheme}: every request answered from the recording`, JSON.stringify(misses));
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await until(() => page('location.pathname === "/"'), 8000, 400);
    await sleep(800);
    if (scheme === 'dark') await tapPage('.rv-demo button');
    else adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    check(await until(() => resumed() === '.PairActivity', 8000, 400), `${scheme}: ${scheme === 'dark' ? 'Pair your Mac' : 'Back at the board\'s home'} leaves the demo for the pairing screen`);
    check(!/tag=demo:/.test(adb('shell', 'dumpsys', 'notification', '--noredact')) || scheme === 'dark', `${scheme}: no alert of the demo's left in the shade`);
    await sleep(1500);
    shot(`a15-left-${scheme}.png`);
  }
  await visit('dark');
  await visit('light');
  clearInterval(watchSockets);
  const max = Math.max(0, ...socketSeen);
  check(socketSeen.length > 10 && max === 0, `no socket of the app's (uid ${UID}) in the kernel's tables, sampled ${socketSeen.length} times through the demo`, `most at once: ${max}`);
  const log = adb('logcat', '-d', '-s', 'Ravenry');
  const lefts = [...log.matchAll(/demo: left, (\d+) of the app's own files served, no connection made/g)];
  check(lefts.length >= 3, 'the shell says each visit served only the app\'s own files', lefts.map((m) => m[1]).join(', '));

  // ------------------------------------------------------------ paired: no demo
  adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
  await sleep(3000);
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  hub = spawn(process.execPath, [path.join(HERE, 'demo.mjs'), '--phone', '--dir', WORK], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RAVENRY_'))), RAVENRYD: BIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d; }); hub.stderr.on('data', (d) => { hubLog += d; });
  const info = await until(() => (/demo hub on/.test(hubLog) ? JSON.parse(fs.readFileSync(path.join(WORK, 'demo.json'), 'utf8')) : null), 90000, 500);
  if (!info || !info.phone) throw new Error('the test hub did not start:\n' + hubLog.slice(-2000));
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${info.phone.link}'`, APP);
  await tapWhen((n) => /^Pair$/i.test(n.text), 20000);
  const board = await until(() => resumed() === '.MainActivity' && page('!!document.querySelector("#pchips .pchip") && !document.querySelector(".rv-demo")'), 30000, 800);
  check(board, 'paired with the test hub: the real board, no demo bar');
  adb('shell', 'am', 'start', '-n', `${APP}/.PairActivity`);
  await sleep(2500);
  const line = find((n) => /Try the demo/.test(n.text));
  shot('a16-paired-pairing-screen.png');
  check(!line, 'paired: the pairing screen has no demo line');
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`, '--ez', 'dev.ravenry.app.DEMO', 'true');
  await sleep(2500);
  adb('shell', 'am', 'force-stop', APP);
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`, '--ez', 'dev.ravenry.app.DEMO', 'true');
  const real = await until(() => page('!!document.querySelector("#pchips .pchip") && !document.querySelector(".rv-demo") && !window.ravenryDemo'), 30000, 800);
  check(real, 'paired: the demo\'s own intent opens the real board, never the demo');
  shot('a17-paired-board.png');
} catch (e) {
  check(false, 'the run', e.stack || String(e));
} finally {
  try { adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'); } catch { /* gone */ }
  if (hub) { hub.kill('SIGTERM'); await sleep(1500); }
  if (emu) { try { adb('emu', 'kill'); } catch { /* gone */ } }
  fs.rmSync(WORK, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - bad.length}/${results.length} passed; pictures in ${OUT}`);
process.exit(bad.length ? 1 : 0);
