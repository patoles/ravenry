#!/usr/bin/env node
// The phone's pick, from a headless emulator, in dark and light: the alert
// in the shade with the pictures side by side, the swipe screen Compare
// opens, and the circle and note screen; then the pick answered from the
// phone, checked on the hub. A made-up board on a throwaway HOME
// (apps/desktop/tools/demo-hub.mjs) with real ravenryd panes: paper-boat's
// "Tilting the hull" waits on `ravenry pick` with three pictures drawn
// here (each with the agent's words), notes-app's "Sync settings" on
// `ravenry ask`, recipe-box's "Recipe card layout" on a pick of two HTML
// pages (shown in their sandboxed frames), and two agents ask, with their
// reasons, to act on the "dev server" pane the person started:
// weather-widget's "Cache forecasts" to close it, garden-planner's "Phone
// preview" to type in it. Then, as the person on the phone: the pick sent
// with a circle and a note, the typing allowed with a fingerprint (enrolled
// on the emulator first), the close refused, Not now on the HTML pick's
// alert and Undo on a decision an agent saved, both tapped in the shade.
//
//   node build.mjs && (cd ../android && ./gradlew assembleDebug)
//   node tools/pick-shots.mjs <outDir> [--port 5560] [--avd ravenry-pixel]
//
// Only an emulator: it starts its own, headless (-no-window), on the port
// given, read-only (nothing it does stays in the AVD), names it on every
// adb command (`-s emulator-<port>`), checks it says ro.kernel.qemu=1, and
// stops it at the end. Never a phone.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(APP_DIR, '.tmp', 'pick-shots'));
const WORK = path.join(APP_DIR, '.tmp', 'pick-shots-work');
const PORT = Number(opt('--port', 5560));
const SERIAL = `emulator-${PORT}`;
const AVD = opt('--avd', 'ravenry-pixel');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK, 'emulator', 'emulator');
const APK = path.resolve(opt('--apk', path.join(REPO, 'apps/android/app/build/outputs/apk/debug/app-debug.apk')));
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const APP = 'dev.ravenry.app';
for (const [f, what] of [[BIN, 'ravenryd (daemon/README.md)'], [APK, 'the debug APK (./gradlew assembleDebug in apps/android)']]) if (!fs.existsSync(f)) { console.error(`missing ${what}: ${f}`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const RT = fs.mkdtempSync(path.join(SHORT, 'rvk-'));
fs.chmodSync(RT, 0o700);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 15000, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

// ------------------------------------------------------------ the pictures

// Three renders of one moment, as a game's agent would show them: a paper
// boat on a steep wave at dusk, level, tilted with the slope (spray over
// the bow) and tilted half as much. Drawn here; nothing comes from a game.
function scene(tilt, spray) {
  const drops = spray === 2 ? [[332, 150, 7], [347, 137, 5], [323, 131, 6], [354, 160, 4], [339, 120, 4], [311, 146, 5], [362, 143, 3], [329, 110, 3], [349, 170, 5]]
    : spray === 1 ? [[330, 172, 4], [342, 163, 3], [319, 165, 3]] : [];
  const y = tilt === 0 ? 200 : 206;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#394878"/><stop offset=".56" stop-color="#C47A6C"/><stop offset="1" stop-color="#F0B88C"/></linearGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D6C8C"/><stop offset="1" stop-color="#163852"/></linearGradient></defs>
<rect width="640" height="400" fill="url(#s)"/><circle cx="498" cy="148" r="38" fill="#FFDAA9" opacity=".92"/>
<path d="M0 252 L70 230 L140 246 L215 216 L305 240 L385 221 L470 243 L560 224 L640 238 L640 400 L0 400Z" fill="#585E85" opacity=".72"/>
<path d="M0 302 C82 297 132 291 172 277 C216 262 252 214 301 190 C337 172 373 179 396 201 C432 238 472 287 640 301 L640 400 L0 400Z" fill="url(#w)"/>
<path d="M152 284 C212 261 252 214 301 190 C337 172 373 179 396 201" fill="none" stroke="#DCEFF4" stroke-width="3" opacity=".8"/>
<path d="M0 341 C122 331 222 353 331 339 C441 325 521 347 640 335 L640 400 L0 400Z" fill="#11304A" opacity=".82"/>
<g transform="translate(266 ${y}) rotate(${tilt})"><path d="M-62 -2 L62 -2 L42 24 L-42 24Z" fill="#F4F0E6" stroke="#B8B0A0" stroke-width="2"/><path d="M-40 -2 L-4 -66 L34 -2Z" fill="#FFFFFF" stroke="#B8B0A0" stroke-width="2"/><path d="M-4 -66 L-4 -2" stroke="#D5CEBE" stroke-width="1.5"/></g>
${drops.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F3FAFC" opacity=".92"/>`).join('')}
</svg>`;
}
const PICS = path.join(WORK, 'renders');
fs.mkdirSync(PICS, { recursive: true });
{
  const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 640, height: 400 } });
  for (const [name, tilt, spray] of [['level', 0, 0], ['slope', -24, 2], ['half', -12, 1]]) {
    await p.setContent(`<html><body style="margin:0">${scene(tilt, spray)}</body></html>`);
    await p.screenshot({ path: path.join(PICS, `${name}.png`) });
  }
  await b.close();
}
// Two layouts of a recipe card, as an agent would render them as pages.
const card = (side) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#FBF7F0;color:#2B2622;height:100vh;display:flex;${side ? '' : 'flex-direction:column;'}}
nav{background:#2F5D50;color:#F3EFE6;padding:14px;display:flex;${side ? 'flex-direction:column;width:28%;' : ''}gap:10px;font-weight:600}
main{padding:16px 18px;flex:1}h1{margin:0 0 6px;font-size:22px}.t{color:#7A6E62;font-size:13px}
.i{margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px 14px}.i span{border-bottom:1px solid #E8DFD2;padding:3px 0}</style>
<nav><span>Recipes</span><span>Plan</span><span>Shop</span></nav><main><h1>Lemon risotto</h1><div class="t">35 min, serves 4</div>
<div class="i"><span>Arborio rice</span><span>300 g</span><span>Lemons</span><span>2</span><span>Parmesan</span><span>60 g</span><span>Stock</span><span>1 l</span></div></main>`;
fs.writeFileSync(path.join(PICS, 'menu-left.html'), card(true));
fs.writeFileSync(path.join(PICS, 'menu-top.html'), card(false));

// ------------------------------------------------------------ the board

const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
const C = { dim: '\x1b[38;5;245m', w: '\x1b[97m', g: '\x1b[32m', y: '\x1b[33m', box: '\x1b[48;5;235m', r: '\x1b[0m' };
function sessionScript(s, { screen, wait, title, after = null, delay = 0 }) {
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const f = path.join(WORK, `session-${s.sid.slice(0, 4)}.sh`);
  fs.writeFileSync(f, [
    hook('SessionStart'), hook('UserPromptSubmit'),
    `printf '\\033]0;✳ ${title}\\007'`,
    `printf '%b' '${screen.replace(/'/g, "'\\''")}'`,
    `while [ ! -f '${path.join(WORK, 'go')}' ]; do sleep 0.3; done`,
    delay ? `sleep ${delay}` : ':',
    `${wait} >"$HOME/.cp-out-${s.sid.slice(0, 4)}" 2>&1`,
    `echo "exit $?" >>"$HOME/.cp-out-${s.sid.slice(0, 4)}"`,
    after || ':',
    'exec sleep 100000',
  ].join('\n') + '\n', { mode: 0o755 });
  return f;
}

const LABELS = ['Level', 'Tilt with the slope', 'Half the slope'];
const DESCS = ['The hull stays flat; the wave moves under it.', 'The hull follows the wave\'s angle at the bow.', 'Follows the wave, half as much. Less spray.'];
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
let hub = null;
let emu = null;
const adbRaw = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adb = (...a) => adbRaw(...a);
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({
    dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false,
    panes: ['paper-boat', 'notes-app', 'weather-widget', 'garden-planner', 'recipe-box'],
    env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_HUB_NAME: 'MacBook Pro', RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(await freePort()) },
  });
  const S = hub.sessions;
  const variants = [['level', 0], ['slope', 1], ['half', 2]].map(([f, i]) => `--variant ${q(`${LABELS[i]}=${path.join(PICS, `${f}.png`)}`)} --describe ${q(`${LABELS[i]}=${DESCS[i]}`)}`).join(' ');
  const pickS = sessionScript(S['paper-boat'], {
    title: 'Tilting the hull',
    delay: 4,
    screen: `${C.box} > Make the hull tilt with the slope on steep waves, then let me pick on my phone ${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Bash${C.r}(npm run render -- --frame 412 --variants tilt)\\n${C.dim}  ⎿  3 renders in shots/tilt/${C.r}\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry pick "Which tilt reads best on the steep wave?" ...)\\n${C.dim}  ⎿  Waiting for your pick in Ravenry.${C.r}\\n`,
    wait: `'${BIN}' pick "$(printf 'Which tilt reads best on the steep wave?\\nRendered from the game at the same moment, frame 412 of the storm level.')" ${variants} --timeout 30m`,
    // Once its pick is answered, it saves what the person said, as an agent records a decision.
    after: `while [ ! -f '${path.join(WORK, 'decide')}' ]; do sleep 0.3; done; RAVENRY_HUB_URL='${hub.url}' '${BIN}' decide ${q('Tilt the hull with the slope, but only half as much as the wave.')} --project paper-boat >"$HOME/.decide-out" 2>&1`,
  });
  const htmlS = sessionScript(S['recipe-box'], {
    title: 'Recipe card layout',
    screen: `${C.box} > Try the recipe card with the menu on the left and on top ${C.r}\\n`,
    wait: `'${BIN}' pick ${q('Which recipe card reads better?')} --variant ${q(`Menu on the left=${path.join(PICS, 'menu-left.html')}`)} --describe ${q('Menu on the left=More room for the steps, less for the title.')} --variant ${q(`Menu on top=${path.join(PICS, 'menu-top.html')}`)} --describe ${q('Menu on top=The title and the list get the whole width.')} --timeout 30m`,
  });
  const askS = sessionScript(S['notes-app'], {
    title: 'Sync settings',
    screen: `${C.box} > Finish the sync settings screen, then ask me before the beta goes out ${C.r}\\n`,
    wait: `'${BIN}' ask "$(printf 'Ship the beta to the testers?\\nThe settings screen is done and all 64 tests pass.')" --option 'Ship it' --option 'Not yet' --text --timeout 30m`,
  });
  const newPane = (s, file, name) => execFileSync(BIN, ['new', '--cwd', s.folder, '--name', name, '--size', '90x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', file], { env: localEnv, encoding: 'utf8' }).trim();
  // The person's own dev server, started from outside every pane, and an
  // agent in another session that asks to close it.
  const devPane = execFileSync(BIN, ['new', '--cwd', S['weather-widget'].folder, '--name', 'dev server', '--size', '90x30', '--', '/bin/sh', '-c', 'trap "" INT; echo "  VITE v6.0.3  ready in 412 ms"; while :; do sleep 100000; done'], { env: localEnv, encoding: 'utf8' }).trim().split(/\s+/)[0];
  const closeS = sessionScript(S['weather-widget'], {
    title: 'Cache forecasts',
    screen: `${C.box} > Restart the dev server with the cache on ${C.r}\n`,
    wait: `'${BIN}' close ${devPane} --reason ${q('It restarts with the cache on; the old one keeps the stale forecasts in memory.')}`,
  });
  const typeS = sessionScript(S['garden-planner'], {
    title: 'Phone preview',
    screen: `${C.box} > Let me check the calendar on my phone ${C.r}\\n`,
    wait: `'${BIN}' send ${devPane} --key Ctrl+C --paste 'npm run dev -- --host' --key Enter --reason ${q('The game only listens on this Mac. --host lets your phone open it on the home Wi-Fi.')}`,
  });
  newPane(S['weather-widget'], closeS, 'Cache forecasts');
  newPane(S['garden-planner'], typeS, 'Phone preview');
  newPane(S['recipe-box'], htmlS, 'Recipe card layout');
  newPane(S['notes-app'], askS, 'Sync settings');
  newPane(S['paper-boat'], pickS, 'Tilting the hull');
  const r = await fetch(`${hub.url}/api/phone/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  const card = await r.json();
  if (!r.ok || !card.app) throw new Error(`phone access did not turn on: ${JSON.stringify(card)}`);
  const link = card.app.link;

  // ------------------------------------------------------------ the emulator
  emu = spawn(EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only'], { stdio: 'ignore', detached: false });
  await until(() => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } }, 240000, 2000);
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator`);
  console.log(`${SERIAL} booted`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');

  // uiautomator's view of the screen, and taps on it.
  function screen() {
    for (let i = 0; i < 4; i++) {
      try {
        adb('shell', 'uiautomator', 'dump', '/sdcard/rv-ui.xml');
        const xml = adb('exec-out', 'cat', '/sdcard/rv-ui.xml');
        return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
          const g = (k) => ((new RegExp(` ${k}="([^"]*)"`).exec(m[0]) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const b = (/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds')) || [0, 0, 0, 0, 0]).slice(1).map(Number);
          return { text: g('text'), desc: g('content-desc'), id: g('resource-id'), cls: g('class'), pkg: g('package'), b, x: (b[0] + b[2]) >> 1, y: (b[1] + b[3]) >> 1 };
        });
      } catch { /* moving */ }
    }
    return [];
  }
  const find = (want, nodes = screen()) => nodes.find((n) => (typeof want === 'function' ? want(n) : n.text === want || n.desc === want)) || null;
  const tap = (n) => adb('shell', 'input', 'tap', String(n.x), String(n.y));
  async function tapWhen(want, ms = 15000, what = String(want)) {
    const n = await until(() => find(want), ms, 500);
    if (!n) throw new Error(`not on the screen: ${what}\n${screen().map((x) => x.text || x.desc).filter(Boolean).join(' | ')}`);
    tap(n);
    return n;
  }
  const shot = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p')); console.log('shot', f); return f; };
  const results = [];
  const check = (ok, what, detail = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', what, detail); };

  // A fingerprint, enrolled as a person does in Settings, after a PIN (the
  // emulator's sensor is touched with `adb emu finger touch`).
  adb('shell', 'locksettings', 'set-pin', '1234');
  adb('shell', 'am', 'start', '-a', 'android.settings.FINGERPRINT_ENROLL');
  await until(() => find('Re-enter your PIN') || find('Enter your PIN'), 15000, 800);
  adb('shell', 'input', 'text', '1234'); adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
  for (let i = 0; i < 6 && !find('I AGREE'); i++) { const more = find('MORE'); if (more) tap(more); await sleep(800); }
  await tapWhen('I AGREE', 10000);
  await until(() => find('Touch the sensor'), 15000, 800);
  for (let i = 0; i < 12 && !find('Fingerprint added'); i++) { adb('emu', 'finger', 'touch', '1'); await sleep(900); }
  check(!!find('Fingerprint added'), 'a fingerprint is enrolled on the emulator');
  await tapWhen('DONE', 10000);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');

  adb('install', '-r', APK);
  adb('shell', 'pm', 'clear', APP);
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  // A quiet status bar: a fixed clock (demo mode).
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  const demo = (cmd, extra = []) => adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', cmd, ...extra);
  demo('enter'); demo('clock', ['-e', 'hhmm', '1755']); demo('notifications', ['-e', 'visible', 'false']); demo('battery', ['-e', 'level', '80', '-e', 'plugged', 'false']); demo('network', ['-e', 'wifi', 'show', '-e', 'level', '4']);

  // The board in the WebView, through DevTools (a debug build allows it).
  async function board(expression) {
    const pid = adb('shell', 'pidof', APP).trim();
    if (!pid) return null;
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && /\/phone\//.test(p.url));
      if (!page) return null;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
      const reply = new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m.result && m.result.result && m.result.result.value); }; });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const v = await Promise.race([reply, sleep(5000).then(() => null)]);
      ws.close();
      return v;
    } finally {
      try { adb('forward', '--remove', `tcp:${port}`); } catch { /* gone */ }
    }
  }
  const webView = () => find((n) => n.cls === 'android.webkit.WebView');
  // Where an element of the board is on the emulator's screen, in pixels.
  async function onScreen(selector) {
    const web = webView();
    const r = await until(() => board(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })()`), 15000, 500);
    if (!web || !r) throw new Error(`not on the board: ${selector}`);
    return { x: web.b[0] + r.x * r.dpr, y: web.b[1] + r.y * r.dpr, w: r.w * r.dpr, h: r.h * r.dpr };
  }
  async function tapBoard(selector) { const r = await onScreen(selector); adb('shell', 'input', 'tap', String(Math.round(r.x + r.w / 2)), String(Math.round(r.y + r.h / 2))); }
  // A button by its words, found and measured in one look, so a board drawn
  // anew in between never leaves the tap on a stale element.
  async function tapText(text) {
    const web = webView();
    const r = await until(() => board(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio }; })()`), 15000, 500);
    if (!web || !r) throw new Error(`no button "${text}" on the board`);
    adb('shell', 'input', 'tap', String(Math.round(web.b[0] + r.x * r.dpr)), String(Math.round(web.b[1] + r.y * r.dpr)));
  }

  const go = (route) => board(`location.replace('#${route}')`);
  const hubCps = async (all = false) => ((await (await fetch(`${hub.url}/api/checkpoints${all ? '?all' : ''}`)).json()).checkpoints || []);
  const alertShown = (id) => adb('shell', 'dumpsys', 'notification', '--noredact').includes(`|${APP}|2|${id}|`);

  // Pair through the link, as from the Mac's QR code.
  adb('shell', `am start -a android.intent.action.VIEW -d '${link}' ${APP}`);
  await tapWhen('Pair', 30000, 'Pair (Pair with MacBook Pro?)');
  const paired = await until(async () => { const d = await (await fetch(`${hub.url}/api/phone/devices`)).json(); return d && d.devices && d.devices.find((x) => x.platform === 'android'); }, 30000);
  if (!paired) throw new Error('the app did not pair');
  console.log('paired');
  await until(() => board('document.querySelector(".grp") ? true : null'), 30000, 1000);
  // The checkpoints open now, so their alerts reach the phone as they open.
  fs.writeFileSync(path.join(WORK, 'go'), '1');
  const cps = await until(async () => {
    const list = (await hubCps()).filter((c) => c.state === 'open');
    const pick = list.find((c) => c.kind === 'pick' && (c.variants || []).length === 3);
    const html = list.find((c) => c.kind === 'pick' && (c.variants || []).length === 2);
    const ask = list.find((c) => c.kind === 'ask');
    const close = list.find((c) => c.kind === 'drive' && c.drive && c.drive.action === 'close');
    const type = list.find((c) => c.kind === 'drive' && c.drive && (c.drive.action || 'input') === 'input');
    return pick && html && ask && close && type ? { pick, html, ask, close, type } : null;
  }, 40000, 500);
  if (!cps) throw new Error(`the checkpoints did not all open: ${JSON.stringify((await hubCps()).map((c) => [c.kind, c.state]))}`);
  const PICK = cps.pick.id, HTML = cps.html.id, ASK = cps.ask.id, CLOSE = cps.close.id, TYPE = cps.type.id;
  console.log('checkpoints', JSON.stringify({ PICK, HTML, ASK, CLOSE, TYPE }), JSON.stringify(cps.type.drive), JSON.stringify(cps.pick.variants.map((v) => v.description)));
  // The hub keeps the pictures; wait for them.
  await until(async () => (await fetch(`${hub.url}/api/checkpoints/${PICK}/variants/2`)).ok && (await fetch(`${hub.url}/api/checkpoints/${HTML}/variants/1`)).ok, 20000, 500);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(1500);

  // For the shade's picture, only the pick's and the question's alerts: the
  // emulator's own notices, Ravenry's quiet connection line and the other
  // alerts (each has a frame of its own) are snoozed for a few seconds.
  // Snoozed for the rest of the run (a shorter snooze comes back as a
  // heads-up over the board's screens); one is let back for a test.
  const snoozed = new Map();
  function snoozeOthers(keep) {
    const out = adb('shell', 'dumpsys', 'notification', '--noredact');
    for (const k of new Set([...out.matchAll(/key=(-?\d+\|[^|\s]+\|-?\d+\|[^|]*\|\d+)/g)].map((m) => m[1]))) {
      const [, pkg, , tag] = k.split('|');
      if (pkg === APP && keep.includes(tag)) continue;
      try { adb('shell', 'cmd', 'notification', 'snooze', '--for', '1800000', `'${k}'`); snoozed.set(tag, k); } catch { /* not snoozable */ }
    }
  }
  async function openShade() {
    try { adb('shell', 'am', 'force-stop', 'io.heckel.ntfy'); } catch { /* not here */ }
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await sleep(1500);
  }
  async function expand(title) {
    const n = await until(() => find((x) => x.text === title), 30000, 1000);
    if (!n) throw new Error(`not in the shade: ${title}: ${screen().map((x) => x.text).filter(Boolean).join(' | ')}`);
    const exp = screen().find((x) => /^expand/i.test(x.desc) && Math.abs(x.y - n.y) < 140);
    if (exp) { tap(exp); await sleep(1200); }
    return n;
  }
  async function shade(scheme) {
    snoozeOthers([`cp:${PICK}`, `cp:${ASK}`]);
    await openShade();
    await expand('Tilting the hull wants you to pick');
    await until(() => find('Compare'), 10000, 500);
    await sleep(1500); // the pictures, fetched over the pinned connection
    shot(`phone-32-shade-${scheme}.png`);
  }

  async function screens(scheme) {
    // Compare, on the boat pick's alert, opens its swipe screen.
    const title = await until(() => find('Tilting the hull wants you to pick'), 10000, 500);
    const cmp = await until(() => screen().filter((n) => n.text === 'Compare' && title && n.y > title.y).sort((x, y2) => x.y - y2.y)[0] || null, 10000, 500);
    if (cmp) tap(cmp);
    else {
      // The shade moved under the tap (alerts coming back): open the pick from the app instead.
      console.log('no Compare to tap on the boat pick\'s alert:', screen().map((x) => x.text).filter(Boolean).join(' | '));
      adb('shell', 'cmd', 'statusbar', 'collapse');
      adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`);
      await sleep(1500);
      await go(`/cp/${PICK}`);
    }
    await until(() => board('document.querySelector(".ppick .ptrack img") && document.querySelector(".ppick .ptrack img").complete ? true : null'), 20000, 500);
    await sleep(800);
    // A swipe to B, as a finger does.
    const t = await onScreen('.ppick .ptrack');
    const y = Math.round(t.y + t.h / 2);
    adb('shell', 'input', 'swipe', String(Math.round(t.x + t.w * 0.85)), String(y), String(Math.round(t.x + t.w * 0.15)), String(y), '250');
    await until(() => board('document.querySelector(".ppick .btn.pri").textContent === "Pick B" ? true : null'), 8000, 400);
    await sleep(800);
    shot(`phone-32-swipe-${scheme}.png`);
    console.log('swipe caption:', await board('document.querySelector(".ppick .pcap").innerText'));
    // Circle a part: a finger draws around the spray over the bow.
    await tapText('Circle a part');
    const p = await onScreen('.ppick .pdraw');
    const cx = p.x + p.w * 0.52, cy = p.y + p.h * 0.36, rx = p.w * 0.105, ry = p.h * 0.15;
    const pts = [];
    for (let i = 0; i <= 26; i++) { const a = -2.3 + (i / 26) * 2 * Math.PI * 1.04; pts.push([Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))]); }
    adb('shell', 'input', 'motionevent', 'DOWN', String(pts[0][0]), String(pts[0][1]));
    for (const [x, y2] of pts.slice(1)) adb('shell', 'input', 'motionevent', 'MOVE', String(x), String(y2));
    adb('shell', 'input', 'motionevent', 'UP', String(pts[pts.length - 1][0]), String(pts[pts.length - 1][1]));
    await until(() => board('document.querySelector(".ppick .pnote") ? true : null'), 8000, 400);
    // The note, typed with the phone's keyboard.
    await tapBoard('.ppick .pnote');
    await sleep(800);
    for (const word of 'This, but less spray at the bow. It hides the boat.'.split(' ').map((w, i) => (i ? ' ' : '') + w)) adb('shell', 'input', 'text', word.replace(/ /g, '%s').replace(/([,.;'"])/g, '\\$1'));
    await sleep(500);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); // the keyboard goes, the note stays
    await sleep(1200);
    shot(`phone-32-circle-${scheme}.png`);
    const r = await board('JSON.stringify({ note: document.querySelector(".ppick .pnote").value, send: document.querySelector(".ppick .btn.pri").textContent })');
    // The drives: Cache forecasts asks to close the person's dev server,
    // Phone preview to type in it; each with its reason.
    for (const [id, name, word] of [[CLOSE, 'close', 'close'], [TYPE, 'type', 'type in']]) {
      await go(`/cp/${id}`);
      await until(() => board(`document.querySelector(".pcp h2") && document.querySelector(".pcp h2").textContent.includes(${JSON.stringify(word)}) ? true : null`), 10000, 400);
      await sleep(800);
      shot(`phone-6-drive-${name}-${scheme}.png`);
      console.log(`drive ${name} screen:`, await board('document.querySelector(".pcp").innerText.replace(/\\n+/g, " | ")'));
    }
    // The HTML pick: its first page in its sandboxed frame.
    await go(`/cp/${HTML}`);
    await until(() => board('document.querySelector(".ppick iframe.phtml") ? true : null'), 10000, 400);
    await sleep(2500);
    shot(`phone-32-html-${scheme}.png`);
    console.log('html frame:', await board('JSON.stringify([...document.querySelectorAll(".ppick iframe.phtml")].map((f) => ({ sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src"), h: f.getBoundingClientRect().height })))'));
    await go(`/cp/${PICK}`);
    await sleep(800);
    return r;
  }

  // Not now on the HTML pick's alert, tapped in the shade: the alert goes,
  // nothing is sent, the pick stays open.
  await until(() => alertShown(`cp:${HTML}`), 15000, 500);
  check(alertShown(`cp:${HTML}`), 'the HTML pick has its alert in the shade');
  await openShade();
  const ht = await expand('Recipe card layout wants you to pick');
  const notNow = await until(() => screen().filter((n) => n.text === 'Not now' && n.y > ht.y).sort((x, y2) => x.y - y2.y)[0] || null, 10000, 500);
  shot('phone-32-html-shade-dark.png');
  if (notNow) tap(notNow);
  await sleep(2000);
  const htmlCp = (await hubCps(true)).find((x) => x.id === HTML);
  check(notNow && !alertShown(`cp:${HTML}`) && htmlCp && htmlCp.state === 'open', 'Not now in the shade takes the pick\'s alert away and leaves the pick open');
  adb('shell', 'cmd', 'statusbar', 'collapse');

  // The drives' alerts in the shade, as the hub words them.
  snoozeOthers([`cp:${CLOSE}`, `cp:${TYPE}`, `cp:${PICK}`, `cp:${ASK}`]);
  await openShade();
  await expand([...screen()].map((n) => n.text).find((t) => / wants to type in /.test(t)) || 'x');
  await sleep(800);
  shot('phone-6-drive-shade-dark.png');
  console.log('drive alerts:', screen().map((n) => n.text).filter((t) => / wants to | says: |It would type/.test(t)).join(' | '));
  adb('shell', 'cmd', 'statusbar', 'collapse');
  await shade('dark');
  console.log('dark:', await screens('dark'));
  // Light: the shade again, then the screens (a theme change draws the board anew).
  adb('shell', 'cmd', 'uimode', 'night', 'no');
  await sleep(2500);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(1000);
  await shade('light');
  const last = await screens('light');
  console.log('light:', last);

  // ------------------------------------------------ as the person, on the phone
  // The pick, which kept its circle and note, sent from the phone.
  await go(`/cp/${PICK}`);
  await until(() => board('document.querySelector(".ppick .pnote") ? true : null'), 10000, 400);
  await tapText(JSON.parse(last).send);
  const done = await until(async () => (await hubCps(true)).find((x) => x.id === PICK && x.state !== 'open') || null, 20000, 500);
  const a = done && done.answer && done.answer.pick;
  check(a && a.label === LABELS[1] && a.region && a.region.w > 0.05 && a.region.h > 0.05 && /less spray/.test(a.note || '') && done.answer.by === 'phone', 'the pick sent from the phone, with its region and note:', JSON.stringify(done && done.answer));
  const out = fs.readFileSync(path.join(WORK, `.cp-out-${S['paper-boat'].sid.slice(0, 4)}`), 'utf8');
  console.log('ravenry pick printed:', out.trim().split('\n').slice(-6).join(' | '));
  await sleep(1500);
  shot('phone-32-after-light.png');

  // The typing, allowed once with a fingerprint: the prompt, then the sensor.
  await go(`/cp/${TYPE}`);
  await tapText('Allow once');
  const prompt = await until(() => find((n) => n.pkg === 'com.android.systemui' && /fingerprint|Allow once/i.test(n.text || n.desc)), 15000, 700);
  check(!!prompt, 'the fingerprint prompt opens before the yes', prompt ? (prompt.text || prompt.desc) : screen().map((x) => x.text).filter(Boolean).join(' | '));
  // (The prompt is a secure window: a screen capture of it comes out empty.)
  adb('emu', 'finger', 'touch', '1');
  const allowed = await until(async () => (await hubCps(true)).find((x) => x.id === TYPE && x.state !== 'open') || null, 20000, 500);
  const typedOut = await until(() => { const f = path.join(WORK, `.cp-out-${S['garden-planner'].sid.slice(0, 4)}`); const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; return /exit \d+/.test(t) ? t : null; }, 15000, 500);
  const screenNow = execFileSync(BIN, ['capture', devPane], { env: localEnv, encoding: 'utf8' });
  check(allowed && allowed.state === 'answered' && allowed.answer && allowed.answer.approved && allowed.answer.allow === 'once' && /exit 0/.test(typedOut || '') && /npm run dev -- --host/.test(screenNow), 'the typing allowed once with a fingerprint: ravenry send went through and the dev server pane shows it', JSON.stringify(allowed && allowed.answer));

  // The close refused from the phone: the dev server stays.
  await go(`/cp/${CLOSE}`);
  await sleep(4000); // the last answer's toast sits over the bottom buttons for a few seconds
  await tapText('Refuse');
  const refused = await until(async () => (await hubCps(true)).find((x) => x.id === CLOSE && x.state === 'declined') || null, 15000, 500);
  if (!refused) console.log('the close now:', JSON.stringify((await hubCps(true)).find((x) => x.id === CLOSE)), await board('document.body.innerText.slice(0, 400)'));
  const listed = JSON.parse(execFileSync(BIN, ['ls', '--json'], { env: localEnv, encoding: 'utf8' }));
  const alive = (Array.isArray(listed) ? listed : listed.panes || []).some((x) => x.id === devPane && x.state === 'running');
  check(refused && alive, 'the close refused from the phone, and the dev server still runs', JSON.stringify(refused && refused.answer));

  // A decision the agent saves: its alert, Undo tapped in the shade, and
  // the decision is gone from the hub.
  fs.writeFileSync(path.join(WORK, 'decide'), '1');
  const dec = await until(async () => { const r2 = await (await fetch(`${hub.url}/api/decisions?project=paper-boat`)).json(); return (r2.decisions || [])[0] || null; }, 20000, 500);
  check(!!dec, 'the agent saved a decision', JSON.stringify(dec && dec.quote) + ' ' + fs.readFileSync(path.join(WORK, '.decide-out'), 'utf8').trim());
  await until(() => alertShown(`dec:${dec && dec.id}`), 15000, 500);
  await openShade();
  const dt = await until(() => find('Saved your decision'), 15000, 800);
  const undo = await until(() => screen().filter((n) => n.text === 'Undo' && dt && n.y > dt.y).sort((x, y2) => x.y - y2.y)[0] || null, 10000, 500);
  shot('phone-31-decision-shade-light.png');
  if (undo) tap(undo);
  const gone = await until(async () => { const r2 = await (await fetch(`${hub.url}/api/decisions?project=paper-boat&all=1`)).json(); return !(r2.decisions || []).some((d) => d.id === dec.id); }, 15000, 500);
  await sleep(1500);
  shot('phone-31-decision-undone-light.png');
  check(undo && gone, 'Undo in the shade takes the saved decision back', screen().filter((n) => n.text).map((n) => n.text).filter((t) => /Taken back|Saved your/.test(t)).join(' | '));
  adb('shell', 'cmd', 'statusbar', 'collapse');
  if (results.some((x) => !x)) process.exitCode = 1;
} catch (e) {
  console.error(e);
  if (hub) fs.writeFileSync(path.join(WORK, 'board.log'), hub.log());
  process.exitCode = 1;
} finally {
  try { adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'); } catch { /* gone */ }
  try { adb('emu', 'kill'); } catch { /* gone */ }
  if (emu) { await sleep(3000); try { emu.kill('SIGTERM'); } catch { /* gone */ } }
  try {
    for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  hub?.stop();
  fs.rmSync(RT, { recursive: true, force: true });
}
