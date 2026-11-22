#!/usr/bin/env node
// A tap on an Android alert opens its card, end to end, on a headless
// emulator (docs/FEATURES.md ALERT rows): the alert's own card, never only
// the app. The board is first left on another project, so an app that only
// comes to the front fails every check.
//
//   - warm: the app in the background (Home), a session's alert (a
//     project that stops on a question) and a checkpoint's (`ravenry ask`);
//   - warm after over a minute in the background (the board's own
//     "open where you were" runs as the page shows again);
//   - cold: the app's process gone (as Android ends it in the background),
//     the alert still in the shade;
//   - in front: the alert pulled down from the shade over the board;
//   - a stack of two alerts: Android 16 folds an app's alerts that have a
//     group but no summary under a summary of its own whose tap opens only
//     the app (the cause of "the alerts open just the app", a tester's
//     phone on Android 16, 0.1.75); the app's own summary opens the newest
//     alert's card.
//     API 34 does not fold, so the stack's tap is sent as the summary's
//     intent: the app's own when it posts one, else the launcher's.
//
// What the board shows is read from the WebView (DevTools: a debug build):
// a session's alert shows its project with that session; a checkpoint's
// shows its question screen (/phone/index.html#/cp/<id>).
//
//   node tools/alert-open-e2e.mjs <outDir> [--apk path] [--port 5618]
//   (--apk an older build's debug APK, to see the stack's check fail there)
//
// Only an emulator: it starts its own, headless (-no-window), read-only,
// names it on every adb command and checks ro.kernel.qemu=1. Never a phone.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(APP_DIR, '.tmp', 'alert-open'));
const PORT = Number(opt('--port', 5618));
const WORK = path.join(APP_DIR, '.tmp', `alert-open-work-${PORT}`);
const SERIAL = `emulator-${PORT}`;
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
let passes = 0, fails = 0;
const check = (ok, what, detail = '') => { if (ok) passes++; else fails++; console.log(ok ? 'PASS' : 'FAIL', what, detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''); };

const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
// A session in a real pane that asks, one question per `go-<n>` file.
function askScript(s, title, questions) {
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const f = path.join(WORK, `session-${s.sid.slice(0, 4)}.sh`);
  fs.writeFileSync(f, [
    hook('SessionStart'), hook('UserPromptSubmit'),
    `printf '\\033]0;✳ ${title}\\007'`,
    ...questions.flatMap(([go, q]) => [
      `while [ ! -f '${path.join(WORK, go)}' ]; do sleep 0.3; done`,
      `'${BIN}' ask '${q}' --option 'Yes' --option 'Not yet' --timeout 30m >>"$HOME/.ask-${s.sid.slice(0, 4)}" 2>&1`,
    ]),
    'exec sleep 100000',
  ].join('\n') + '\n', { mode: 0o755 });
  return f;
}

let hub = null;
let emu = null;
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({
    dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false,
    panes: ['notes-app', 'weather-widget'],
    env: { MC_NO_EVENTS: '0', MC_ALERT_COOLDOWN_MS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_HUB_NAME: 'MacBook Pro', RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(await freePort()) },
  });
  const S = hub.sessions;
  const QS = [['go-1', 'Ship the beta to the testers on Friday?'], ['go-2', 'Turn on the offline sync for everyone?'], ['go-3', 'Keep the old export button for a week?'], ['go-4', 'Rename the Sync tab to Backup?'], ['go-5', 'Sync the attachments too?']];
  const QW = [['go-w', 'Show the wind in knots or in km/h?']];
  const askF = askScript(S['notes-app'], 'Sync settings', QS);
  execFileSync(BIN, ['new', '--cwd', S['notes-app'].folder, '--name', 'Sync settings', '--size', '90x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', askF], { env: localEnv, encoding: 'utf8' });
  const askW = askScript(S['weather-widget'], 'Wind', QW);
  execFileSync(BIN, ['new', '--cwd', S['weather-widget'].folder, '--name', 'Wind', '--size', '90x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', askW], { env: localEnv, encoding: 'utf8' });
  const r = await fetch(`${hub.url}/api/phone/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  const card = await r.json();
  if (!r.ok || !card.app) throw new Error(`phone access did not turn on: ${JSON.stringify(card)}`);

  // ------------------------------------------------------------ the emulator
  emu = spawn(EMULATOR, ['-avd', opt('--avd', 'ravenry-pixel'), '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only'], { stdio: 'ignore', detached: false });
  await until(() => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } }, 240000, 2000);
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator`);
  console.log(`${SERIAL} booted, API ${adb('shell', 'getprop', 'ro.build.version.sdk').trim()}`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  // The emulator's own copy (read-only: nothing of this run stays) may be signed otherwise.
  try { adb('uninstall', APP); } catch { /* none */ }
  adb('install', '-r', APK);
  adb('shell', 'pm', 'clear', APP);
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  console.log('installed', (adb('shell', 'dumpsys', 'package', APP).match(/versionName=(\S+)/) || [])[1]);

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
  const shot = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p')); return f; };
  const pidOf = () => { try { return adb('shell', 'pidof', APP).trim(); } catch { return ''; } };

  // The page in the WebView, through DevTools (a debug build allows it).
  async function board(expression) {
    const pid = pidOf();
    if (!pid) return null;
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && /^https:\/\/appassets\.androidplatform\.net\//.test(p.url));
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
  // What the page shows: the board's current project and its session, or a checkpoint's screen.
  const where = (words = '') => board(`(() => {
    const u = location.pathname + location.hash;
    const words = ${JSON.stringify(words)};
    if (location.pathname.startsWith('/phone/')) { const t = document.body.innerText; return { u, cp: (location.hash.match(/^#\\/cp\\/(.+)$/) || [])[1] || null, has: !!words && t.includes(words), text: t.slice(0, 300) }; }
    const chip = document.querySelector('#pchips [aria-current="true"][data-id]');
    const t = (document.getElementById('sheet') || document.body).innerText;
    return { u, project: chip ? chip.dataset.id : null, has: !!words && t.includes(words), text: t.slice(0, 300) };
  })()`);
  // The board left on another project, as the person had it.
  async function leaveOn(pid) {
    await board(`location.replace('/#${pid}')`);
    return until(async () => { const w = await where(); return w && w.project === pid ? w : null; }, 20000, 800);
  }
  const hubCps = async () => ((await (await fetch(`${hub.url}/api/checkpoints`)).json()).checkpoints || []);
  const alertShown = (id) => adb('shell', 'dumpsys', 'notification', '--noredact').includes(`|${APP}|2|${id}|`);
  async function tapAlert(words) {
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await sleep(1500);
    const n = await until(() => find((x) => x.pkg === 'com.android.systemui' && (x.text || '').includes(words)), 20000, 800);
    if (!n) throw new Error(`not in the shade: ${words}: ${screen().map((x) => x.text).filter(Boolean).join(' | ')}`);
    tap(n);
  }
  // A checkpoint's alert: the next ask, its id and its alert on the phone.
  let asked = 0;
  async function ask(which = null) {
    const [go, q] = which || QS[asked++];
    fs.writeFileSync(path.join(WORK, go), '1');
    const cp = await until(async () => (await hubCps()).find((c) => c.state === 'open' && (c.title || c.question || '').includes(q)), 30000, 500);
    if (!cp) throw new Error(`the ask did not open: ${q}`);
    const on = await until(() => alertShown(`cp:${cp.id}`), 30000, 1000);
    check(!!on, `the checkpoint's alert reached the phone (${q})`);
    return { id: cp.id, q };
  }
  // A session's alert: a demo project stops on a question. One already
  // waiting at the start (the hub alerts only on a move into Needs you):
  // the person typed to it first, so it works again.
  const evFile = (sid) => { const hit = execFileSync('/usr/bin/find', [hub.home, '-name', `${sid}.jsonl`, '-path', '*events*'], { encoding: 'utf8' }).trim().split('\n')[0]; return hit || null; };
  async function rearm(pid) {
    const sid = { 'garden-planner': 'a1a1a1a1-0000-4000-8000-000000000001', 'recipe-box': 'd4d4d4d4-0000-4000-8000-000000000004' }[pid];
    const f = evFile(sid);
    const first = JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0]);
    const { ends_on_question: _q, background_tasks: _b, source: _s, model: _m, question: _qq, ...line } = first;
    fs.appendFileSync(f, JSON.stringify({ ...line, at: new Date().toISOString(), event: 'UserPromptSubmit', prompt: 'Go on' }) + '\n');
    await until(async () => { const p = (await hub.state()).projects.find((x) => x.id === pid); return p && p.state !== 'you' ? p : null; }, 20000, 500);
  }
  async function arrive(pid, question) {
    const tags = () => new Set([...adb('shell', 'dumpsys', 'notification', '--noredact').matchAll(new RegExp(`\\|${APP}\\|2\\|(s:${pid}:[^|]*)\\|`, 'g'))].map((m) => m[1]));
    await hub.arrive(pid, question);
    const st = await until(async () => { const p = (await hub.state()).projects.find((x) => x.id === pid); return p && p.state === 'you' ? p : null; }, 20000, 500);
    // Its alert from before, if any, left the shade when it worked again (the hub closes it).
    const on = await until(() => [...tags()][0], 30000, 1000);
    check(!!(st && on), `${pid}'s alert reached the phone`, on || '');
    // What the board's card says: the question the hub read (the alert's body).
    return { pid, question: (st && st.question) || question, words: `${pid} needs you` };
  }
  async function expectSession(label, a) {
    const w = await until(async () => { const x = await where(a.question); return x && x.project === a.pid && x.has ? x : null; }, 15000, 800) || await where(a.question);
    check(!!w && w.project === a.pid && w.has && !w.u.startsWith('/phone/'), `${label}: the tap opens ${a.pid}'s session with its question`, w);
    return w;
  }
  async function expectCp(label, c) {
    const w = await until(async () => { const x = await where(c.q); return x && x.cp === c.id && x.has ? x : null; }, 15000, 800) || await where(c.q);
    check(!!w && w.cp === c.id && w.has, `${label}: the tap opens the checkpoint's question screen`, w);
    return w;
  }

  // ------------------------------------------------------------ pair
  adb('shell', `am start -a android.intent.action.VIEW -d '${card.app.link}' ${APP}`);
  const pair = await until(() => find('Pair'), 40000, 800);
  if (pair) tap(pair);
  const paired = await until(async () => { const d = await (await fetch(`${hub.url}/api/phone/devices`)).json(); return d && d.devices && d.devices.find((x) => x.platform === 'android'); }, 60000, 1500);
  if (!paired) throw new Error('the app did not pair');
  await until(() => board('document.querySelector("#pchips [data-id]") ? true : null'), 40000, 1000);
  await sleep(3000);

  // Each case: the board left on another project (weather-widget), then
  // the alert, then a tap on it in the shade.
  const away = async (ms) => { await leaveOn('weather-widget'); adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(ms); };
  const killApp = async () => {
    const pid = pidOf();
    adb('shell', 'run-as', APP, 'kill', '-9', pid);
    return until(() => (pidOf() !== pid ? 1 : null), 10000, 500);
  };
  const cases = [
    ['warm (Home, a few seconds)', 'session', 'paper-boat', 'Tilt the hull with the slope too, or keep it level?', 1500, false],
    ['warm (Home, a few seconds)', 'checkpoint', null, null, 1500, false],
    ['warm (Home, over a minute)', 'session', 'garden-planner', 'Water the tomatoes every day in July, or every other day?', 70000, false],
    ['warm (Home, over a minute)', 'checkpoint', null, null, 70000, false],
    ['cold (the process ended)', 'session', 'recipe-box', 'Import the old recipes with their photos, or the text only?', 1500, true],
    ['cold (the process ended)', 'checkpoint', null, null, 1500, true],
  ];
  let n = 0;
  const answer = (id) => fetch(`${hub.url}/api/checkpoints/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ id, choice: 1 }) });
  const backInFront = async () => {
    adb('shell', 'cmd', 'statusbar', 'collapse');
    if (!pidOf()) adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`);
    await until(() => board('document.querySelector("#pchips [data-id]") || location.pathname.startsWith("/phone/") ? true : null'), 30000, 1000);
  };
  for (const [when, kind, pid, question, ms, cold] of cases) {
    n++;
    if (kind === 'session' && pid !== 'paper-boat') await rearm(pid);
    await away(ms);
    const a = kind === 'session' ? await arrive(pid, question) : await ask();
    if (cold) check(!!(await killApp()), `${when}: the app's process ended, its alert still in the shade`);
    await tapAlert(kind === 'session' ? a.words : a.q.slice(0, 24));
    if (kind === 'session') await expectSession(`${when}, a session's alert`, a); else await expectCp(`${when}, a checkpoint's alert`, a);
    shot(`${n}-${kind}-${when.split(' ')[0]}.png`);
    // Answered, so the session's next ask comes.
    if (kind === 'checkpoint') await answer(a.id);
    await backInFront();
  }
  // In front: the board open on another project, the alert pulled down from the shade.
  await leaveOn('weather-widget');
  const cf = await ask();
  await tapAlert(cf.q.slice(0, 24));
  await expectCp('in front (the board open), a checkpoint\'s alert', cf);
  shot(`${++n}-checkpoint-front.png`);
  await answer(cf.id);
  await backInFront();

  // A stack: two alerts in the shade, folded into one. Android 16 folds an
  // app's alerts that have a group and no summary under a summary of its
  // own, which opens the app's launcher screen (AOSP GroupHelper,
  // NotificationManagerService); API 34 here does not fold them, so the
  // stack's tap is sent as that summary's intent: the app's own summary
  // when it posts one, else the launcher's.
  await away(1500);
  const older = await ask(QW[0]);
  await sleep(1500);
  const cs = await ask();
  await sleep(2000);
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(2000);
  shot(`${n + 1}-stack-shade.png`);
  adb('shell', 'cmd', 'statusbar', 'collapse');
  const own = adb('shell', 'dumpsys', 'notification', '--noredact').includes(`|${APP}|3|null|`);
  console.log(own ? 'the app posts its own summary over its alerts' : 'no summary of the app\'s own: the stack opens the launcher screen, as Android 16 makes it');
  if (own) adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`, '-a', 'open:newest', '-f', '0x30000000', '--ez', 'dev.ravenry.app.NEWEST', 'true');
  else adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`, '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-f', '0x10000000');
  await expectCp('a stack of two alerts (Android 16 folds them), its tap opens the newest', cs);
  shot(`${++n}-stack.png`);
  await answer(cs.id);
  await answer(older.id);
  if (own) {
    const left = await until(() => (adb('shell', 'dumpsys', 'notification', '--noredact').includes(`|${APP}|3|null|`) ? null : 1), 20000, 1000);
    check(!!left, 'both answered, their alerts and the summary leave the shade');
  }
} catch (e) {
  check(false, 'the run', String(e.stack || e).slice(0, 1500));
} finally {
  try { fs.writeFileSync(path.join(OUT, 'logcat.txt'), execFileSync(ADB, ['-s', SERIAL, 'logcat', '-d', '-v', 'time'], { encoding: 'utf8', maxBuffer: 64 << 20 })); } catch { /* gone */ }
  if (hub) try { fs.writeFileSync(path.join(OUT, 'board.log'), hub.log()); } catch { /* gone */ }
  try { execFileSync(ADB, ['-s', SERIAL, 'emu', 'kill']); } catch { /* gone */ }
  if (emu) { await sleep(3000); try { emu.kill('SIGTERM'); } catch { /* gone */ } }
  try {
    for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  hub?.stop();
  fs.rmSync(RT, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
