#!/usr/bin/env node
// Push end to end through a real UnifiedPush distributor (docs/PHONE.md
// sections 4 and 5): the ntfy Android app on a headless emulator, ntfy's own
// server in Docker, a throwaway ravenryd and hub, and the Ravenry app.
//
//   1. ntfy's official release APK, checked by its SHA-256 (the one the
//      GitHub release lists) and its signer's certificate, then installed;
//      ntfy's server from the binwiederhier/ntfy image, published on
//      127.0.0.1 only. The ntfy app's default server is set to it through
//      ntfy's own Settings, before Ravenry registers.
//   2. Ravenry is paired with the test hub through its pairing link, and
//      takes ntfy as its distributor as a person's phone would; the hub
//      gets an http://10.0.2.2:<port>/up... endpoint (server/push.mjs takes
//      http to a home-network address, the body being encrypted anyway).
//   3. With the app closed: Stay connected off in Ravenry's Settings (no
//      held connection), Home, `am kill` (not force-stop, which would stop
//      broadcasts too) and no Ravenry process left. Then `ravenry ask --option
//      ...` waits on a checkpoint, the alert must appear in the shade, and
//      ntfy's server must have logged the publish to Ravenry's topic. Its
//      button is tapped in the shade and the waiting `ravenry ask` must print
//      that button's answer. The same for `ravenry approve` and Refuse.
//
// Test-only network shim: this computer cannot reach 10.0.2.2, the address
// the emulator gives the ntfy app for this computer, and so the address in
// the endpoint. The hub here runs with tools/emulator-host-preload.mjs
// (node --import), which sends fetch() to 10.0.2.2 to 127.0.0.1. The product
// never loads it.
//
// Only an emulator: --serial must be emulator-NNNN and say ro.kernel.qemu=1,
// and every adb command names it, so a phone on the same cable is never
// touched. The tool does not start or stop the emulator; it removes its
// ntfy container and its hub and daemon when it ends.
//
// Usage (from hub/, after `./gradlew assembleDebug` in apps/android):
//   RAVENRYD_BIN=../daemon/ravenryd node tools/push-ntfy-e2e.mjs --serial emulator-5554 \
//     [--apk ../apps/android/app/build/outputs/apk/debug/app-debug.apk] [--ntfy-apk FILE] [--shots DIR]
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const T = path.join(ROOT, '.tmp', 'push-ntfy-e2e');

// ntfy's Android app, F-Droid flavour (no Google services), as published on
// its GitHub release. The SHA-256 is the one the release lists for the
// file; the signer is Philipp Heckel's certificate (CN=Philipp Heckel).
const NTFY = {
  version: '1.25.2',
  url: 'https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-fdroid-release.apk',
  sha256: '8a1075c0963caa1e0dc404996531bc641cb2b982f92a4bc692d4999f9eb53f39',
  signer: '6e145d7ae685eff75468e5067e03a6c3645453343e4e181dac8b6b17ff67489d',
  pkg: 'io.heckel.ntfy',
};
const APP = 'dev.ravenry.app';
const IMAGE = 'binwiederhier/ntfy';

// ------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const opt = (name, d = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SERIAL = opt('--serial');
const APK = path.resolve(opt('--apk', path.join(REPO, 'apps/android/app/build/outputs/apk/debug/app-debug.apk')));
const NTFY_APK = opt('--ntfy-apk');
const SHOTS = path.resolve(opt('--shots', path.join(T, 'shots')));
const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
const ADB = process.env.ADB || path.join(SDK, 'platform-tools/adb');

function die(msg) { console.error(`push-ntfy-e2e: ${msg}`); process.exit(2); }
if (!SERIAL || !/^emulator-\d+$/.test(SERIAL)) die('give --serial emulator-NNNN (an emulator only; see `adb devices -l`).');
if (!BIN || !fs.existsSync(BIN)) die('set RAVENRYD_BIN to a ravenryd build (daemon/ravenryd).');
if (!fs.existsSync(APK)) die(`no Ravenry APK at ${APK}: build it with ./gradlew assembleDebug in apps/android.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; return ok; };
const measure = (name, ms) => console.log(`MEASURE ${name}: ${ms} ms`);

// Every adb command names the emulator.
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });
if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') die(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator.`);

fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
for (const d of [MC, SHOTS, path.join(T, 'root', 'boat'), path.join(T, 'claude'), path.join(T, 'home')]) fs.mkdirSync(d, { recursive: true });

// ------------------------------------------------------------ cleanup

let board = null;
let daemon = null;
let D = null;
let container = null;
const asks = new Set();
function cleanup() {
  for (const c of asks) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  if (board) { try { board.kill('SIGTERM'); } catch { /* gone */ } }
  if (daemon) { try { daemon.kill('SIGTERM'); } catch { /* gone */ } }
  if (container) { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 30000 }); } catch { /* gone */ } container = null; }
  if (D) { try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } D = null; }
}
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

async function until(fn, ms = 10000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ------------------------------------------------------------ the screen

// The emulator's screen as uiautomator sees it: nodes with text, a
// content description, resource id, class, checked state and centre.
function screen() {
  for (let i = 0; i < 4; i++) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/rv-e2e-ui.xml');
      const xml = adb('exec-out', 'cat', '/sdcard/rv-e2e-ui.xml');
      return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
        const g = (k) => ((new RegExp(` ${k}="([^"]*)"`).exec(m[0]) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const b = (/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds')) || [0, 0, 0, 0, 0]).slice(1).map(Number);
        return { text: g('text'), desc: g('content-desc'), id: g('resource-id'), cls: g('class'), pkg: g('package'), checked: g('checked') === 'true', b, x: (b[0] + b[2]) >> 1, y: (b[1] + b[3]) >> 1 };
      });
    } catch { /* the screen was moving: again */ }
  }
  return [];
}
const said = (n) => n.text || n.desc;
const match = (want) => (n) => (typeof want === 'function' ? want(n) : want instanceof RegExp ? want.test(n.text) || want.test(n.desc) : n.text === want || n.desc === want);
const find = (want, nodes = screen()) => nodes.find(match(want)) || null;
async function waitFor(want, ms = 15000) { return until(() => find(want), ms, 400); }
function tap(n) { adb('shell', 'input', 'tap', String(n.x), String(n.y)); }
async function tapWhen(want, ms = 15000, what = String(want)) {
  const n = await waitFor(want, ms);
  if (!n) throw new Error(`not on the screen: ${what}\n${screen().filter(said).map(said).join(' | ')}`);
  tap(n);
  return n;
}
function shot(name) {
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p'));
  return f;
}
const pidOf = (pkg) => { try { return adb('shell', 'pidof', pkg).trim(); } catch { return ''; } };

// Ravenry's notification for an alert id in the shade, from the system's
// own list (dumpsys notification): its key carries the tag, the alert id.
function notified(tag) {
  const out = adb('shell', 'dumpsys', 'notification', '--noredact');
  return out.split('\n').some((l) => l.includes('NotificationRecord(') && l.includes(`pkg=${APP}`) && l.includes(`|${tag}|`));
}

// ------------------------------------------------------------ ntfy's APK

function apksigner() {
  const bt = path.join(SDK, 'build-tools');
  const v = fs.existsSync(bt) ? fs.readdirSync(bt).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse() : [];
  for (const x of v) { const f = path.join(bt, x, 'apksigner'); if (fs.existsSync(f)) return f; }
  return null;
}

async function ntfyApk() {
  let f = NTFY_APK ? path.resolve(NTFY_APK) : null;
  if (!f) {
    // Into a new empty folder of its own; nothing in it is run.
    const dir = fs.mkdtempSync(path.join(T, 'ntfy-apk-'));
    f = path.join(dir, path.basename(new URL(NTFY.url).pathname));
    const r = await fetch(NTFY.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) die(`could not download ${NTFY.url}: ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const sum = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  check(`ntfy ${NTFY.version}'s APK has the SHA-256 its GitHub release lists`, sum === NTFY.sha256, sum);
  const signer = apksigner();
  if (signer) {
    let out = '';
    try { out = execFileSync(signer, ['verify', '--print-certs', f], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
    const cert = (/Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/.exec(out) || [])[1] || null;
    check('and its signature verifies, by Philipp Heckel\'s certificate', cert === NTFY.signer, String(cert));
  } else console.log('note: no apksigner in the Android SDK; the SHA-256 alone was checked');
  if (sum !== NTFY.sha256) die('refusing to install an ntfy APK that is not the published one');
  return f;
}

// ------------------------------------------------------------ ntfy's server

const NPORT = await freePort();
container = `ravenry-ntfy-e2e-${process.pid}`;
execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-e', 'NTFY_LOG_LEVEL=debug', '-p', `127.0.0.1:${NPORT}:80`, IMAGE, 'serve'], { stdio: 'ignore', timeout: 120000 });
const ntfyUp = await until(async () => (await fetch(`http://127.0.0.1:${NPORT}/v1/health`)).ok, 30000);
check(`ntfy's server runs in Docker on 127.0.0.1:${NPORT} only`, !!ntfyUp && execFileSync('docker', ['port', container], { encoding: 'utf8' }).trim() === `80/tcp -> 127.0.0.1:${NPORT}`);
// ntfy logs to stderr; with NTFY_LOG_LEVEL=debug it logs every publish.
const ntfyLines = () => { const r = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 64 << 20 }); return (String(r.stdout || '') + String(r.stderr || '')).split('\n'); };
const SERVER = `http://10.0.2.2:${NPORT}`;

// ------------------------------------------------------------ a daemon and a hub

const PORT = await freePort();
const PPORT = await freePort();
D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvpn-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const denv = { HOME: path.join(T, 'home'), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
daemon = spawn(BIN, ['serve'], { env: denv, stdio: 'ignore' });
fs.writeFileSync(path.join(T, 'fake-cmux.json'), JSON.stringify({ workspaces: [], screens: {} }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false },
  projects: [{ id: 'boat', name: 'paper-boat', folder: path.join(T, 'root', 'boat'), workspaces: [] }],
}, null, 2));
const env = withTestHome({
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_PHONE_PORT: String(PPORT), RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_HUB_NAME: 'Test hub',
  MC_NO_EVENTS: '0', MC_REPEATS_AUTO: '0', MC_ALERT_PRIME_MS: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'), MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  RAVENRY_DAEMON_BIN: BIN, MC_PUSH_RETRY_MS: '60000',
  RAVENRY_TERMINAL: 'ravenry', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
});
// `--import=` in one word, so the guard still sees server/index.mjs as the script.
board = spawn(process.execPath, [`--import=${path.join(ROOT, 'tools', 'emulator-host-preload.mjs')}`, path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });

const mac = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const up = await until(async () => (await mac('GET', '/api/state')).status === 200, 30000);
if (!check('the test hub answers', !!up, log.slice(-500))) process.exit(1);
const on = await mac('POST', '/api/phone/access', { on: true });
const link = on.body && on.body.app && on.body.app.link;
if (!check('phone access on: a pairing link that names 10.0.2.2', !!link && /hosts=[^&]*10\.0\.2\.2/.test(link), JSON.stringify(on.body).slice(0, 200))) process.exit(1);

// `ravenry ask` and the like, as an agent runs them, against this daemon.
const RAVENRY = path.join(D, 'ravenry');
fs.symlinkSync(BIN, RAVENRY);
function ravenry(args) {
  const c = spawn(RAVENRY, args, { env: { ...denv }, stdio: ['ignore', 'pipe', 'pipe'] });
  asks.add(c);
  const r = { out: '', err: '', code: null, done: null, child: c };
  c.stdout.on('data', (d) => { r.out += d; });
  c.stderr.on('data', (d) => { r.err += d; });
  r.done = new Promise((resolve) => c.on('exit', (code) => { r.code = code; r.at = Date.now(); asks.delete(c); resolve(code); }));
  return r;
}

// ------------------------------------------------------------ the apps

const ntfyFile = await ntfyApk();
adb('install', '-r', ntfyFile);
adb('install', '-r', APK);
// Both from a clean start: no server set in ntfy, no pairing in Ravenry.
adb('shell', 'pm', 'clear', NTFY.pkg);
adb('shell', 'pm', 'clear', APP);
try { adb('shell', 'dumpsys', 'deviceidle', 'whitelist', `-${NTFY.pkg}`); } catch { /* not on it */ }
adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
adb('shell', 'wm', 'dismiss-keyguard');

// ntfy: its default server is the test's, through its own Settings.
adb('shell', 'am', 'start', '-W', '-n', `${NTFY.pkg}/.ui.MainActivity`);
const allow1 = await waitFor((n) => n.id === 'com.android.permissioncontroller:id/permission_allow_button', 6000);
if (allow1) tap(allow1);
// ntfy's banner asks to turn battery optimization off, as its docs do: a
// distributor in the background may not start its listening service on
// Android 12 and later otherwise, and an app registering with it (Ravenry,
// just below) would get an endpoint nobody listens on until ntfy is opened.
const fix = await waitFor((n) => n.id === 'io.heckel.ntfy:id/main_banner_battery_fix_now', 5000);
if (fix) { tap(fix); await tapWhen((n) => n.id === 'android:id/button1' && n.text === 'Allow', 10000, 'Allow (Let app always run in background?)'); }
check('ntfy may run in the background (its battery banner\'s Fix now, allowed)', !!(await until(() => adb('shell', 'dumpsys', 'deviceidle', 'whitelist').includes(`,${NTFY.pkg},`), 5000, 300)), fix ? 'tapped' : 'no banner');
await tapWhen((n) => n.desc === 'More options', 15000, 'ntfy\'s menu');
await tapWhen('Settings', 5000);
await tapWhen('Default server', 10000);
await tapWhen((n) => n.id === 'io.heckel.ntfy:id/default_server_dialog_url', 5000, 'the server field');
adb('shell', 'input', 'text', SERVER);
await tapWhen((n) => n.id === 'io.heckel.ntfy:id/default_server_dialog_action_save', 5000, 'Save');
const setServer = await waitFor(SERVER, 10000);
check(`ntfy's default server is ${SERVER}, set in its Settings`, !!setServer);
adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');

// Ravenry: pair through the link, as from the Mac's QR code.
// adb shell joins its words into one line for the phone's shell: the link is quoted.
adb('shell', `am start -a android.intent.action.VIEW -d '${link}' ${APP}`);
await tapWhen('Pair', 20000, 'Pair (Pair with Test hub?)');
const allow2 = await waitFor((n) => n.id === 'com.android.permissioncontroller:id/permission_allow_button', 15000);
if (allow2) tap(allow2);
const paired = await until(async () => { const d = (await mac('GET', '/api/phone/devices')).body; return d && d.devices.find((x) => x.platform === 'android'); }, 20000);
check('the app paired with the test hub', !!paired, JSON.stringify(paired));

// The distributor: ntfy is the only one on this phone, so the app takes it
// as Android's UnifiedPush default; where it asks, it is picked.
let target = null;
const picked = [];
await until(async () => {
  const rec = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).tokens.find((t) => t.platform === 'android');
  if (rec && rec.push && rec.push.kind === 'unifiedpush') { target = rec.push; return true; }
  const n = find((x) => /^ntfy$/i.test(x.text) && x.pkg !== NTFY.pkg);
  if (n) { picked.push(said(n)); tap(n); }
  return false;
}, 40000, 1000);
check('Ravenry registered with ntfy: the hub has its unifiedpush endpoint on the test server', !!target && target.endpoint.startsWith(`${SERVER}/up`), JSON.stringify(target && { endpoint: target.endpoint, picked }));
if (!target) { console.log(log.slice(-1500)); process.exit(1); }
const topic = new URL(target.endpoint).pathname.slice(1);

// ------------------------------------------------------------ the board in the app

// The phone board is a WebView, which uiautomator does not see into. A
// debug build lets DevTools in (WebView.setWebContentsDebuggingEnabled):
// it gives where an element is, and adb taps it there, as a finger would.
async function boardRect(selector) {
  const pid = pidOf(APP);
  if (!pid) return null;
  const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = pages.find((p) => p.type === 'page' && /\/phone\//.test(p.url));
    if (!page) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const reply = new Promise((resolve) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result && m.result.result && m.result.result.value); }; });
    const expression = `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio, checked: e.getAttribute('aria-checked'), disabled: !!e.disabled }; })()`;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const v = await Promise.race([reply, sleep(5000).then(() => null)]);
    ws.close();
    return v;
  } finally {
    try { adb('forward', '--remove', `tcp:${port}`); } catch { /* gone */ }
  }
}
async function tapBoard(selector, what) {
  const web = find((n) => n.cls === 'android.webkit.WebView');
  const r = await until(async () => { const v = await boardRect(selector); return v && !v.disabled ? v : null; }, 15000, 500);
  if (!web || !r) throw new Error(`not on the board: ${what}`);
  adb('shell', 'input', 'tap', String(Math.round(web.b[0] + r.x * r.dpr)), String(Math.round(web.b[1] + r.y * r.dpr)));
  return r;
}

// Stay connected off, in the app's Settings behind the gear: no held
// connection, so an alert can only come through ntfy.
await tapBoard('button[aria-label="Settings"]', 'the gear');
// Its switches are disabled until Settings has read them from the app.
const before = await until(async () => { const v = await boardRect('button[aria-label="Stay connected"]'); return v && !v.disabled ? v : null; }, 15000, 500);
check('the app\'s Settings say Stay connected is on, and alerts go through ntfy', before && before.checked === 'true', JSON.stringify(before));
await tapBoard('button[aria-label="Stay connected"]', 'Stay connected');
const after = await until(async () => { const v = await boardRect('button[aria-label="Stay connected"]'); return v && v.checked === 'false' ? v : null; }, 10000, 500);
const held = () => adb('shell', 'dumpsys', 'activity', 'services', APP).includes(`${APP}/.ConnectionService`);
check('Stay connected is off: the connection service is gone', !!after && !!(await until(() => !held(), 5000)), JSON.stringify(after));
shot('settings-stay-connected-off.png');

// ------------------------------------------------------------ alerts with the app closed

// Home, then `am kill` (a process in the background only; force-stop would
// also stop Android from delivering ntfy's broadcast), until no Ravenry
// process is left.
async function closeApp() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(800);
  return until(() => { adb('shell', 'am', 'kill', APP); return !pidOf(APP); }, 10000, 500);
}

async function closedRound({ name, args, kind, button, expect }) {
  adb('shell', 'cmd', 'statusbar', 'collapse');
  const closed = await closeApp();
  check(`${name}: the app is closed (Home, am kill, pidof finds no ${APP})`, !!closed && !held());
  const logFrom = ntfyLines().length;
  const t0 = Date.now();
  const r = ravenry(args);
  const id = await until(() => (/waiting for a person to answer (\w+)/.exec(r.err) || [])[1], 15000, 20);
  const tRaised = Date.now();
  if (!check(`${name}: \`ravenry ${args[0]}\` waits on a checkpoint`, !!id, r.err)) return;
  const shown = await until(() => notified(`cp:${id}`), 30000, 50);
  const t1 = Date.now();
  check(`${name}: the alert is in the shade, with the app closed`, !!shown);
  if (!shown) return;
  measure(`${name}: checkpoint raised to notification shown`, t1 - tRaised);
  measure(`${name}: \`ravenry ${args[0]}\` started to notification shown`, t1 - t0);
  const pubs = ntfyLines().slice(logFrom).filter((l) => l.includes('Received message') && l.includes(`/${topic}?up=1`));
  check(`${name}: ntfy's server logged the publish to Ravenry's topic`, pubs.length >= 1, (pubs[0] || '').slice(0, 160));
  check(`${name}: the push started the app (it had no process)`, !!pidOf(APP));
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  let btn = await waitFor((n) => n.pkg === 'com.android.systemui' && n.text === button && n.id === 'android:id/action0', 5000);
  if (!btn) {
    // Not the first in the shade: open it to show its buttons.
    const title = find((n) => n.id === 'android:id/title' && n.text === kind);
    const all = screen();
    const exp = title && all.filter((n) => n.desc === 'Expand' && Math.abs(n.y - title.y) < 120)[0];
    if (exp) tap(exp);
    btn = await waitFor((n) => n.text === button && n.id === 'android:id/action0', 5000);
  }
  const nodes = screen();
  check(`${name}: its title and buttons in the shade`, !!find((n) => n.id === 'android:id/title' && n.text === kind, nodes) && !!btn, nodes.filter((n) => n.id === 'android:id/action0').map(said).join(', '));
  const f1 = shot(`${name}-alert-app-closed.png`);
  if (!btn) return;
  // Closed again before the tap, so the button's broadcast starts the app too.
  adb('shell', 'am', 'kill', APP);
  await until(() => !pidOf(APP), 5000, 200);
  const t2 = Date.now();
  tap(btn);
  const done = await Promise.race([r.done.then(() => true), sleep(30000).then(() => false)]);
  const t3 = Date.now();
  const sent = await waitFor((n) => n.text === `Sent: ${button}`, 4000);
  const f2 = shot(`${name}-after-tap.png`);
  check(`${name}: the alert says "Sent: ${button}" after the tap`, !!sent);
  check(`${name}: tapping ${button} in the shade answers it: \`ravenry ${args[0]}\` returned ${expect.what}`, done && r.code === expect.code && expect.test(r), JSON.stringify({ code: r.code, out: r.out.trim(), err: r.err.trim().split('\n').at(-1) }));
  if (done) measure(`${name}: tap to \`ravenry ${args[0]}\` returning`, t3 - t2);
  const gone = await until(() => !notified(`cp:${id}`), 10000, 200);
  check(`${name}: the alert leaves the shade`, !!gone);
  console.log(`shots: ${f1}\n       ${f2}`);
}

await closedRound({
  name: 'ask', args: ['ask', 'Ship the beta to the testers?', '--option', 'Ship it', '--option', 'Not yet'],
  kind: 'The agent asks', button: 'Ship it', expect: { code: 0, what: 'the answer "Ship it"', test: (r) => r.out.trim() === 'Ship it' },
});
await closedRound({
  name: 'approve', args: ['approve', 'npm publish --tag beta'],
  kind: 'The agent wants to run a command', button: 'Refuse', expect: { code: 125, what: 'declined (125)', test: (r) => /declined/.test(r.err) },
});

adb('shell', 'cmd', 'statusbar', 'collapse');
const errs = log.split('\n').filter((l) => /^push: /.test(l));
check('the hub posted every alert without an error', !errs.length, errs.join(' | '));
console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
