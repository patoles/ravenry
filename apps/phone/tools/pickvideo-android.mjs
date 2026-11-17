#!/usr/bin/env node
// A pick's videos in the Android app, on a headless emulator (the
// pickvideo round, 2026-11-16): a made-up board on a throwaway HOME
// (apps/desktop/tools/demo-hub.mjs) where a plain shell pane in no project
// ("Video test") waits on a real `ravenry pick` of a video (A, or
// PICKVIDEO_CLIP), a page that holds the same video as a data: URI (B) and a
// picture (C); once the hub has kept them the agent's files change and go.
// The app pairs through the board's link; its home shows the card's chip
// (a card in no project), whose page shows the first frames; then the
// pick's own screen, and as the person: a tap on A's first frame opens the
// viewer, where it plays (its time read from the WebView moves on); the
// strip moves to B, which plays the same way (the app's shell passes a
// player's Range to the hub, MainActivity.hubResource); Circle a part stops
// it on a frame, a finger draws the ring, the note is typed, Send B, with
// the note: the agent prints "region x y w h at t". Pictures in OUT.
//
//   node build.mjs && (cd ../android && ./gradlew assembleDebug)
//   node tools/pickvideo-android.mjs <outDir> [--port 5562] [--avd ravenry-pixel]
//
// Only an emulator: it starts its own, headless (-no-window), read-only, on
// the port given, names it on every adb command (`-s emulator-<port>`),
// checks it says ro.kernel.qemu=1, and stops it at the end. Never a phone.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(APP_DIR, '.tmp', 'pickvideo-android'));
const WORK = path.join(APP_DIR, '.tmp', 'pickvideo-android-work');
const PORT = Number(opt('--port', 5562));
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
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rva-'));
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
let failed = 0;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };

// ------------------------------------------------------------ the variants
function gridPng(w, h, a, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(x % 100 < 3 || y % 100 < 3 ? [240, 240, 240] : (Math.floor(x / 300) + Math.floor(y / 300)) % 2 ? a : b, y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A clip given keeps its own type (.webm, .mov): the variant and the page's data: URI say it.
const CLIP = path.join(WORK, `take-one${process.env.PICKVIDEO_CLIP ? path.extname(process.env.PICKVIDEO_CLIP).toLowerCase() : '.mp4'}`);
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm' };
if (process.env.PICKVIDEO_CLIP) fs.copyFileSync(process.env.PICKVIDEO_CLIP, CLIP);
else {
  const ff = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f)) || 'ffmpeg';
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', CLIP]);
}
const VW = Number(execFileSync((['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((f) => fs.existsSync(f)) || 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', CLIP], { encoding: 'utf8' }).trim());
const PAGE = path.join(WORK, 'take-two.html');
fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0d0f12;height:100%;display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100vh}</style></head><body><video src="data:${MIME[path.extname(CLIP)] || 'video/mp4'};base64,${fs.readFileSync(CLIP).toString('base64')}" controls autoplay muted loop playsinline></video></body></html>`);
const PIC = path.join(WORK, 'still.png');
fs.writeFileSync(PIC, gridPng(1280, 720, [70, 110, 170], [40, 60, 90]));
const VARS = [['Take one', CLIP, 'The clip as it is.'], ['Take two', PAGE, 'The same clip in a page.'], ['Still', PIC, 'A picture, for once.']];
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
const OUTFILE = path.join(WORK, 'pick.out');
let hub = null, emu = null;
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const adbBin = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 60000, maxBuffer: 64 << 20 });
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'],
    env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_HUB_NAME: 'MacBook Pro', RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(await freePort()) } });
  // A plain shell pane in no project, as main's was.
  const variants = VARS.map(([l, f, w]) => `--variant ${q(`${l}=${f}`)} --describe ${q(`${l}=${w}`)}`).join(' ');
  const script = path.join(WORK, 'shell.sh');
  fs.writeFileSync(script, [`'${BIN}' pick ${q('Which take should I keep?')} ${variants} --timeout 30m >${q(OUTFILE)} 2>&1`, `echo "EXIT $?" >>${q(OUTFILE)}`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  fs.mkdirSync(path.join(WORK, 'scratch'), { recursive: true });
  execFileSync(BIN, ['new', '--cwd', path.join(WORK, 'scratch'), '--name', 'Video test', '--size', '90x30', '--', '/bin/sh', script], { env: localEnv });
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.variants && c.variants[1] && c.variants[1].video && c.paneName && c.pick_record && c.pick_record.variants.every((v) => v.kept)) || null; }, 60000);
  check('pick_with_videos_in_no_project', !!cp && cp.projectId == null, cp ? `${cp.id} pane ${cp.paneName}` : `agent: ${(() => { try { return fs.readFileSync(OUTFILE, 'utf8'); } catch { return 'nothing'; } })()}`);
  if (!cp) throw new Error('no pick');
  const ID = cp.id;
  // The agent's files change and go: the hub's copies are the only source from here.
  fs.writeFileSync(CLIP, fs.readFileSync(CLIP).subarray(0, 4096));
  fs.rmSync(PAGE);
  const r = await fetch(`${hub.url}/api/phone/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  const card = await r.json();
  if (!r.ok || !card.app) throw new Error(`phone access did not turn on: ${JSON.stringify(card)}`);

  // ------------------------------------------------------------ the emulator
  emu = spawn(EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only'], { stdio: 'ignore' });
  await until(() => { try { return adb('shell', 'getprop', 'sys.boot_completed').trim() === '1'; } catch { return false; } }, 240000, 2000);
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error(`${SERIAL} does not say ro.kernel.qemu=1: not an emulator`);
  console.log(`${SERIAL} booted`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  // A copy signed by another key (a release build on the image): taken off first, on this read-only emulator only.
  try { adb('install', '-r', APK); } catch (x) { if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(x.stderr || x.message))) throw x; adb('uninstall', APP); adb('install', APK); }
  adb('shell', 'pm', 'clear', APP);
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');

  function screen() {
    for (let i = 0; i < 4; i++) {
      try {
        adb('shell', 'uiautomator', 'dump', '/sdcard/rv-ui.xml');
        const xml = adb('exec-out', 'cat', '/sdcard/rv-ui.xml');
        return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
          const g = (k) => ((new RegExp(` ${k}="([^"]*)"`).exec(m[0]) || [])[1] || '').replace(/&amp;/g, '&');
          const b = (/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds')) || [0, 0, 0, 0, 0]).slice(1).map(Number);
          return { text: g('text'), desc: g('content-desc'), cls: g('class'), b, x: (b[0] + b[2]) >> 1, y: (b[1] + b[3]) >> 1 };
        });
      } catch { /* moving */ }
    }
    return [];
  }
  const find = (want, nodes = screen()) => nodes.find((n) => (typeof want === 'function' ? want(n) : n.text === want || n.desc === want)) || null;
  const shot = (name) => { const f = path.join(OUT, name); fs.writeFileSync(f, adbBin('exec-out', 'screencap', '-p')); return f; };
  async function board(expression) {
    const pid = adb('shell', 'pidof', APP).trim();
    if (!pid) return null;
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && /\/phone\//.test(p.url)) || pages.find((p) => p.type === 'page' && /^https:\/\/appassets\.androidplatform\.net\//.test(p.url));
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
  // An element's rect on the emulator's screen, in pixels.
  async function onScreen(selector) {
    const web = webView();
    const rr = await until(() => board(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; })()`), 15000, 500);
    if (!web || !rr) throw new Error(`not on the board: ${selector}`);
    return { x: web.b[0] + rr.x * rr.dpr, y: web.b[1] + rr.y * rr.dpr, w: rr.w * rr.dpr, h: rr.h * rr.dpr, dpr: rr.dpr, web: web.b };
  }
  async function tapBoard(selector) { const rr = await onScreen(selector); adb('shell', 'input', 'tap', String(Math.round(rr.x + rr.w / 2)), String(Math.round(rr.y + rr.h / 2))); }
  const VID = `((v) => v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, muted: v.muted, controls: v.controls, src: v.getAttribute('src') || '', err: v.error && v.error.code } : null)`;

  // Pair through the link, as from the Mac's QR code.
  adb('shell', `am start -a android.intent.action.VIEW -d '${card.app.link}' ${APP}`);
  const pairB = await until(() => find('Pair'), 30000, 800);
  if (!pairB) throw new Error('no Pair button');
  adb('shell', 'input', 'tap', String(pairB.x), String(pairB.y));
  const paired = await until(async () => { const d = await (await fetch(`${hub.url}/api/phone/devices`)).json(); return d && d.devices && d.devices.find((x) => x.platform === 'android'); }, 30000);
  check('paired', !!paired);
  if (!paired) throw new Error('the app did not pair');
  // The app's home: the card in no project has its chip; its page shows the first frames.
  const chip = await until(() => board(`(() => { const c = document.querySelector('#pchips .pchip[data-id="cp:${ID}"]'); return c ? c.innerText.replace(/\\s+/g, ' ') : null; })()`), 30000, 1000);
  if (chip) await tapBoard(`#pchips .pchip[data-id="cp:${ID}"]`);
  const home = await until(() => board(`(() => { const t = document.getElementById('d-ask-top'); const b = t && t.querySelector('[data-act="cp-open"][data-cp="${ID}"]'); return b ? t.innerText.replace(/\\n/g, ' / ') : null; })()`), 30000, 800);
  check('android_home_card_in_no_project', !!chip && /Video test/.test(chip) && !!home && home.includes('Which take should I keep?'), `chip ${chip}; card ${home}`);
  shot('android-home-dark.png');
  // Its Compare: the pick's own screen.
  if (home) await tapBoard(`#d-ask-top [data-act="cp-open"][data-cp="${ID}"]`);
  else await board(`location.href = '/phone/index.html#/cp/${ID}'`);
  // The track: each video's first frame.
  // (pictures drawn once, with no player of their own: the pickvideo round's fourth part)
  const FRAME = `((b) => { const i = b && b.querySelector('img'); return b && !b.querySelector('video') && i && i.complete && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight, blob: /^blob:/.test(i.getAttribute('src') || '') } : null; })`;
  const track = await until(() => board(`(() => { const s = [...document.querySelectorAll('.ptrack .pimg')]; if (s.length !== 3) return null; const v = s.slice(0, 2).map((x) => ${FRAME}(x)); return v.every((x) => x && x.blob && x.w === ${VW}) ? v : null; })()`), 30000, 800);
  check('android_track_first_frames', !!track, JSON.stringify(track || await board(`[...document.querySelectorAll('.ptrack .pimg')].map((x) => ${FRAME}(x) || x.innerHTML.replace(/src="[^"]{60,}"/g, 'src=...').slice(0, 300))`)));
  await sleep(500);
  shot('android-swipe-dark.png');
  // A tap on A: the viewer, playing.
  await tapBoard('.ptrack .pimg');
  const a0 = await until(() => board(`(() => { const v = ${VID}(document.querySelector('.pzv-box video.pzv-vid')); return v && v.t > 0.2 ? v : null; })()`), 20000, 500);
  await sleep(1500);
  const a1 = await board(`${VID}(document.querySelector('.pzv-box video.pzv-vid'))`);
  check('android_tap_plays_time_advances', !!a0 && a1 && a1.t > a0.t + 0.8 && !a1.paused && a1.muted && a1.controls, `${JSON.stringify(a0)} then ${JSON.stringify(a1)}`);
  shot('android-video-dark.png');
  // The strip: B, the page's video.
  await tapBoard('.pzv-th:nth-child(2)');
  const b0 = await until(() => board(`(() => { const v = ${VID}(document.querySelector('.pzv-box video.pzv-vid')); return v && /as=video$/.test(v.src) && v.t > 0.2 ? v : null; })()`), 20000, 500);
  await sleep(1500);
  const b1 = await board(`${VID}(document.querySelector('.pzv-box video.pzv-vid'))`);
  check('android_page_video_plays', !!b0 && b1 && b1.t > b0.t + 0.8 && !b1.paused, `${JSON.stringify(b0)} then ${JSON.stringify(b1)}`);
  // One plays at a time (the pickvideo round's fourth part): the strip to A and back to B five times; each time the
  // one come to plays on, and the screen's one player is the only video element holding a video, so the one left
  // stopped with it (the app's shell passes each part on as it comes, and drops it when the player closes it).
  const one = `(() => { const all = [...document.querySelectorAll('video')]; const v = document.querySelector('.pzv-box video.pzv-vid'); return { n: all.length, holding: all.filter((x) => x.getAttribute('src') && x.networkState !== 0).length, playing: all.filter((x) => !x.paused).length, src: v && v.getAttribute('src'), t: v ? v.currentTime : -1, paused: v ? v.paused : null }; })()`;
  const rounds = [];
  for (let r = 1; r <= 5; r++) {
    for (const [k, want] of [[1, /variants\/0$/], [2, /as=video$/]]) {
      await tapBoard(`.pzv-th:nth-child(${k})`);
      const s0 = await until(async () => { const x = await board(one); return x && want.test(x.src || '') && x.t > 0.1 && !x.paused ? x : null; }, 20000, 400);
      await sleep(1200);
      const s1 = await board(one);
      const ok = !!s0 && s1 && s1.t > s0.t + 0.6 && s1.playing === 1 && s1.holding === 1;
      rounds.push(`${r}${k === 1 ? 'A' : 'B'} ${ok ? 'ok' : `NO ${JSON.stringify(s0)} then ${JSON.stringify(s1)}`}`);
    }
  }
  check('android_switch_one_plays_at_a_time', rounds.every((x) => x.endsWith('ok')), rounds.join(', '));
  // A seek: the scrub bar's job (the hub serves parts, the shell passes them on).
  await board(`(() => { const v = document.querySelector('.pzv-box video.pzv-vid'); v.currentTime = 4.5; return true; })()`);
  const sk = await until(() => board(`(() => { const v = ${VID}(document.querySelector('.pzv-box video.pzv-vid')); return v && v.t > 4.7 && v.t < 6 && !v.paused ? v : null; })()`), 8000, 300);
  check('android_seek_plays_on', !!sk, JSON.stringify(sk));
  // Circle a part: stopped on its frame.
  await tapBoard('.pzv-ctl .btn:not(.pri)');
  const c0 = await until(() => board(`(() => { const v = ${VID}(document.querySelector('.pzv-box video.pzv-vid')); return document.querySelector('.pzv-stage.drawing') && v.paused ? { v, hint: document.querySelector('.pzv-hint').textContent } : null; })()`), 8000, 400);
  await sleep(800);
  const c1 = await board(`${VID}(document.querySelector('.pzv-box video.pzv-vid'))`);
  check('android_circle_stops_on_frame', !!c0 && !c0.v.controls && Math.abs(c1.t - c0.v.t) < 0.01 && /^Stopped at/.test(c0.hint), JSON.stringify(c0) + ` then ${c1 && c1.t}`);
  // A finger around a rectangle in the middle of the frame.
  const st = await onScreen('.pzv-stage');
  const cx = Math.round(st.x + st.w / 2), cy = Math.round(st.y + st.h / 2), dx = Math.round(60 * st.dpr), dy = Math.round(30 * st.dpr);
  const pts = [[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx - dx, cy - dy + 4]];
  adb('shell', 'input', 'motionevent', 'DOWN', String(pts[0][0]), String(pts[0][1]));
  for (let k = 1; k < pts.length; k++) for (let s2 = 1; s2 <= 5; s2++) adb('shell', 'input', 'motionevent', 'MOVE', String(Math.round(pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * s2 / 5)), String(Math.round(pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * s2 / 5)));
  adb('shell', 'input', 'motionevent', 'UP', String(pts[4][0]), String(pts[4][1]));
  const ring = await until(() => board(`(() => document.querySelector('.pzv-nf textarea') ? { frame: document.querySelector('.pzv-fr') && document.querySelector('.pzv-fr').textContent, send: document.querySelector('.pzv-ctl .btn.pri').textContent } : null)()`), 8000, 400);
  check('android_ring_on_the_frame', !!ring && /^On the frame at 0:0\d\.\d$/.test(ring.frame || '') && ring.send === 'Send B, with the circle', JSON.stringify(ring));
  await board(`(() => { const f = document.querySelector('.pzv-nf textarea'); f.value = 'Slower here'; f.dispatchEvent(new Event('input')); f.blur(); return true; })()`);
  await sleep(600);
  shot('android-note-dark.png');
  await tapBoard('.pzv-ctl .btn.pri');
  const got = await until(() => { try { const t = fs.readFileSync(OUTFILE, 'utf8'); return /EXIT/.test(t) ? t : null; } catch { return null; } }, 15000);
  const m = got && /region ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) at ([\d.]+)/.exec(got);
  check('android_send_reaches_agent_with_t', !!m && /^Take two$/m.test(got) && Math.abs(+m[5] - c0.v.t) < 0.006 && /note Slower here/.test(got) && /EXIT 0/.test(got), `stopped at ${c0 && c0.v.t}; agent: ${(got || 'nothing').replace(/\n/g, ' / ').slice(0, 300)}`);
} catch (e) {
  check('ran', false, e.stack || e.message);
} finally {
  try { if (emu) { execFileSync(ADB, ['-s', SERIAL, 'emu', 'kill'], { timeout: 20000, stdio: 'ignore' }); } } catch { /* gone */ }
  try { emu?.kill(); } catch { /* gone */ }
  hub?.stop();
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
  if (!process.env.PICKVIDEO_KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
fs.writeFileSync(path.join(OUT, 'pickvideo-android.json'), JSON.stringify({ failed, checks: results }, null, 1));
console.log(`pickvideo-android: ${results.length} checks, ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
