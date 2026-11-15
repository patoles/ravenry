// The Android alert's suggested answers, end to end, on a headless
// emulator: an APK (the testers' release, or a debug build),
// paired with a test hub (the demo board, its own HOME, 127.0.0.1, the
// tree's hub), paper-boat handing back "B, C, or keep A?"; the alert's
// actions read from the shade, the first one tapped, and what the session's
// prompt was sent read back from the fake cmux.
// Only an emulator: it starts its own, headless, read-only, names it on
// every adb command and checks ro.kernel.qemu=1. Never a phone.
//   node tools/alert-answers-e2e.mjs <outDir> <apk> [emulator port]
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub, freePort } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [OUT, APK, P] = process.argv.slice(2);
const PORT = Number(P || 5596);
const SERIAL = `emulator-${PORT}`;
const SDK = path.join(os.homedir(), 'Library/Android/sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb');
const APP = 'dev.ravenry.app';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, every = 400) => { const end = Date.now() + ms; for (;;) { let v = null; try { v = await fn(); } catch { v = null; } if (v || Date.now() > end) return v; await sleep(every); } };
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const shot = (n) => fs.writeFileSync(path.join(OUT, n), execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
let fails = 0, passes = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500) : ''}`); if (ok) passes++; else fails++; };
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

const dir = path.join(REPO, '.tmp', 'alert-answers-e2e');
const hubPort = await freePort();
const hub = await startDemoHub({ dir, port: hubPort, env: { RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(hubPort + 1) } });
let emu = null;
try {
  const f0 = JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
  f0.prompts = Object.fromEntries((f0.workspaces || []).flatMap((w) => (w.surfaces || []).map((s) => [s.id, { body: '' }])));
  fs.writeFileSync(hub.fake, JSON.stringify(f0));
  const sent = (sf) => (JSON.parse(fs.readFileSync(hub.fake, 'utf8')).prompts[sf] || {}).sent || [];
  const r = await fetch(`${hub.url}/api/phone/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  const card = await r.json();
  check('test hub: phone access on, a pairing link', r.ok && !!card.app && !!card.app.link, card);

  const booted = () => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } };
  emu = spawn(path.join(SDK, 'emulator', 'emulator'), ['-avd', 'ravenry-pixel', '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only', '-gpu', 'swiftshader_indirect'], { stdio: 'ignore' });
  await until(booted, 240000, 2000);
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error('not an emulator');
  const API = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  adb('install', '-r', APK);
  const ver = (adb('shell', 'dumpsys', 'package', APP).match(/versionCode=(\d+)/) || [])[1];
  check('the APK installed on the emulator', !!ver, `versionCode ${ver}, API ${API}`);
  if (API >= 33) adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  adb('shell', `am start -a android.intent.action.VIEW -d '${card.app.link}' ${APP}`);
  const pair = await until(() => find('Pair'), 40000, 800);
  if (pair) tap(pair);
  const paired = await until(async () => { const ph = await (await fetch(`${hub.url}/api/alerts/setup`)).json().catch(() => null); return ph && /"transport":"app"/.test(JSON.stringify(ph)) ? ph : null; }, 60000, 1500);
  check('the app pairs with the test hub and gets its alerts', !!paired, paired ? '' : screen().map((n) => n.text).filter(Boolean).join(' | '));
  await sleep(4000);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(1500);

  // The hand-back: the real message of the pictures round.
  const t = fs.readFileSync(path.join(REPO, 'hub', 'tools', 'fixtures', 'answers', 'handback-1.txt'), 'utf8').trim().split(/\n\s*\n/);
  const q = t.pop();
  await hub.arrive('paper-boat', q, t.join('\n\n'));
  const st = await until(async () => { const p = (await hub.state()).projects.find((x) => x.id === 'paper-boat'); return p && p.state === 'you' && p.quick.length ? p : null; }, 20000, 500);
  check('hub: paper-boat needs you, with its options', !!st, st && st.quick);
  const posted = await until(() => /Ravenry needs you|paper-boat needs you/.test(adb('shell', 'dumpsys', 'notification', '--noredact')) ? 1 : null, 30000, 1000);
  check('the alert reached the phone', !!posted);
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(2000);
  // Expand the alert itself (its actions show expanded).
  let nodes = screen();
  const head = find((n) => /paper-boat needs you/.test(n.text), nodes);
  if (head && !find('B: the app', nodes)) { adb('shell', 'input', 'swipe', String(head.x), String(head.y), String(head.x), String(head.y + 400), '300'); await sleep(1500); nodes = screen(); }
  const acts = nodes.filter((n) => n.pkg === 'com.android.systemui' && /Button/.test(n.cls)).map((n) => n.text || n.desc).filter(Boolean);
  check('the alert\'s actions: the first two answers and Reply', ['B: the app', 'C: the app with an alert…', 'Reply'].every((a) => acts.some((x) => x === a || x.replace('...', '…') === a)) && !acts.includes('Open'), acts);
  shot(`alert-${'dark'}.png`);
  const before = sent('sf-3').length;
  const b = find('B: the app', nodes);
  if (b) tap(b);
  const got = await until(() => (sent('sf-3').length > before ? sent('sf-3') : null), 20000, 500);
  check('a press on "B: the app" types exactly "B" into the session', !!got && got.at(-1) === 'B' && got.length === before + 1, got || sent('sf-3'));
  // Light too, for the picture.
  adb('shell', 'cmd', 'uimode', 'night', 'no');
  await sleep(1500);
  shot('alert-after-light.png');
} catch (e) {
  check('the run', false, String(e.stack || e).slice(0, 1500));
} finally {
  try { adb('emu', 'kill'); } catch { /* gone */ }
  if (emu) { await sleep(3000); try { emu.kill('SIGKILL'); } catch { /* gone */ } }
  hub.stop();
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
