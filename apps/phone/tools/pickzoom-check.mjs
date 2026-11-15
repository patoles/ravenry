#!/usr/bin/env node
// A pick's pictures up close on the board in a browser and on the phone
// board (the pickzoom round, 2026-11-15), headless, against a made-up board
// on a throwaway HOME (apps/desktop/tools/demo-hub.mjs, 127.0.0.1) where
// paper-boat's session waits on a real `ravenry pick` of four big pictures
// in a real ravenryd pane. Each check drives the page as the person would
// and reads where it lands:
//
//   the board (1440 x 900): the answer card shows the four pictures whole
//   and the words; a click opens the gallery's viewer on that picture; the
//   wheel zooms around the pointer, a double click toggles, a drag pans, Fit
//   and Esc go back, the arrows and the strip move; no Pick anywhere, and
//   the words say where to answer; nothing answered from the browser.
//
//   the phone board (390 x 844, touch): the swipe track is as tall as the
//   picture on screen (no empty band under a wide one, measured); a tap opens
//   the full-screen viewer; a double tap and a pinch zoom; a finger pans a
//   zoomed picture and does not change it, a swipe at fit does; circling
//   while zoomed gives the ring in fractions of the whole picture (worked
//   out from what the screen shows); the note, then Send B, with the note,
//   reaches the agent waiting in the pane (its output read).
//
// Pictures of each, dark and light, in OUT.
//
//   node tools/pickzoom-check.mjs [OUT]     (after node build.mjs; PICKZOOM_PICTURES=a:b:c:d)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args[0] || path.join(APP_DIR, '.tmp', 'pickzoom-check'));
const WORK = path.join(APP_DIR, '.tmp', 'pickzoom-work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const EN = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'strings', 'en.json'), 'utf8'));
const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvz-'));
fs.chmodSync(RT, 0o700);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 15000, every = 200) {
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

// ------------------------------------------------------------ the pictures
/** A w x h PNG: blocks of two colours with a light grid every 100 px. */
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
let PICS = (process.env.PICKZOOM_PICTURES || '').split(':').filter(Boolean);
if (PICS.length !== 4) PICS = [[3030, 2364, [70, 110, 170], [40, 60, 90]], [3030, 2364, [180, 90, 60], [90, 45, 30]], [1530, 2364, [80, 150, 90], [40, 75, 45]], [2530, 2364, [150, 150, 60], [75, 75, 30]]].map(([w, h, a, b], n) => { const f = path.join(WORK, `sheet-${n}.png`); fs.writeFileSync(f, gridPng(w, h, a, b)); return f; });
const LABELS = ['Pairing', 'Alerts', 'Run and secret', 'Launch Ink'];
const SAYS = ['Scan the QR code, or type the code, then Connected.', 'The ask, the iOS sheet, and alerts on the lock screen.', 'Face ID before Run, and the secret field.', 'The Mac’s Ink on the iPhone, dark and light.'];
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

// ------------------------------------------------------------ the board
const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
let hub = null, serve = null, browser = null;
const OUTFILE = path.join(WORK, 'pick.out');
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'], env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') } });
  const s = hub.sessions['paper-boat'];
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const variants = LABELS.map((l, i) => `--variant ${q(`${l}=${PICS[i]}`)} --describe ${q(`${l}=${SAYS[i]}`)}`).join(' ');
  const script = path.join(WORK, 'session.sh');
  fs.writeFileSync(script, [hook('SessionStart'), hook('UserPromptSubmit'), "printf '\\033]0;✳ iPhone screens\\007'",
    `'${BIN}' pick ${q('Which iPhone screens should I build first?')} ${variants} --timeout 30m >${q(OUTFILE)} 2>&1`, `echo "EXIT $?" >>${q(OUTFILE)}`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  execFileSync(BIN, ['new', '--cwd', s.folder, '--name', 'iPhone screens', '--size', '90x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', script], { env: localEnv });
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.projectId === 'paper-boat') || null; }, 30000);
  check('pick_on_the_board', !!cp, cp ? `${cp.id} on ${cp.projectId}` : 'no open pick on paper-boat');
  if (!cp) throw new Error('no pick');
  const ID = cp.id;
  const stillOpen = async () => ((await hub.state()).checkpoints || []).some((c) => c.id === ID && c.state === 'open');

  browser = await chromium.launch({ headless: true });

  // ---------------------------------------------------------- the board in a browser
  // The picture's own rect inside an element drawn with object-fit: contain (its transform included).
  const CONTENT = `(el) => { const r = el.getBoundingClientRect(); const nw = el.naturalWidth, nh = el.naturalHeight; const k = Math.min(r.width / nw, r.height / nh); const w = nw * k, h = nh * k; return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h, nw, nh }; }`;
  // PICKZOOM_ONLY=phone: the phone board's checks alone.
  const BOARD = process.env.PICKZOOM_ONLY !== 'phone';
  for (const dark of BOARD ? [true, false] : []) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(`board_${th}_no_page_error`, false, e.message));
    await p.goto(`${hub.url}/#paper-boat`);
    const tilesIn = await until(() => p.evaluate(() => { const t = [...document.querySelectorAll('.pk-tile img')]; return t.length === 4 && t.every((i) => i.complete && i.naturalWidth > 0); }), 15000);
    if (!dark) { await p.screenshot({ path: path.join(OUT, `board-card-${th}.png`) }); await ctx.close(); continue; }
    check('board_card_shows_4_pictures', tilesIn);
    const card = await p.evaluate(() => { const t = [...document.querySelectorAll('.pk-tile img')]; const top = document.getElementById('d-ask-top'); return { fit: t.map((i) => getComputedStyle(i).objectFit), text: top ? top.innerText : '' }; });
    check('board_card_pictures_whole', card.fit.length === 4 && card.fit.every((f) => f === 'contain'), card.fit.join(','));
    check('board_card_words', card.text.includes(EN['pick.look']) && card.text.includes(EN['pick.answerElsewhere']) && !/\bPick [A-D]\b/.test(card.text), card.text.replace(/\n/g, ' / ').slice(0, 200));
    await p.screenshot({ path: path.join(OUT, `board-card-${th}.png`) });
    await p.click('.pk-tile[data-n="1"]');
    const opened = await until(() => p.evaluate(() => { const l = document.getElementById('gl-fs'); const im = document.getElementById('gl-im'); return l && !l.hidden && im && /\/variants\/1$/.test(im.getAttribute('src')) && im.complete && im.naturalWidth > 0; }), 10000);
    check('board_click_opens_viewer_on_b', opened);
    await sleep(300);
    const lay = await p.evaluate(() => { const l = document.getElementById('gl-fs'); return { text: l.innerText, buttons: [...l.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }; });
    check('board_viewer_no_pick', !lay.buttons.some((b) => /^(Pick|Send|None of these)\b/.test(b)), lay.buttons.join(' | '));
    check('board_viewer_words', lay.text.includes(EN['pick.answerElsewhere']) && lay.text.includes('B. Alerts') && lay.text.includes(SAYS[1]) && /3030 x 2364|\d+ x \d+/.test(lay.text), lay.text.replace(/\n/g, ' / ').slice(0, 300));
    await p.screenshot({ path: path.join(OUT, `board-fit-${th}.png`) });
    // The wheel zooms around the pointer: the picture's point under it stays.
    const v = await p.evaluate(() => { const r = document.getElementById('gl-view').getBoundingClientRect(); return { x: r.left + r.width * 0.56, y: r.top + r.height * 0.42 }; });
    const fracAt = (pt) => p.evaluate(([f, pt]) => { const c = eval(f)(document.getElementById('gl-im')); return { fx: (pt.x - c.left) / c.width, fy: (pt.y - c.top) / c.height, w: c.width }; }, [CONTENT, pt]);
    const f0 = await fracAt(v);
    // Around the pointer on each axis where the picture is bigger than the view; on an axis where it
    // is still smaller it stays in the middle (the gallery's rule), so the point moves there only.
    await p.mouse.move(v.x, v.y);
    await sleep(100);
    const vw = await p.evaluate(() => document.getElementById('gl-view').getBoundingClientRect().width);
    const seq = [f0];
    for (let k = 0; k < 5; k++) { await p.mouse.wheel(0, -200); await sleep(250); seq.push(await fracAt(v)); }
    const f1 = seq[seq.length - 1];
    const kept = seq.slice(1).every((f, k) => Math.abs(f.fy - seq[k].fy) < 0.003 && (seq[k].w <= vw || Math.abs(f.fx - seq[k].fx) < 0.003));
    check('board_wheel_zooms_at_pointer', f1.w > f0.w * 2 && kept, `view ${vw.toFixed(0)} px wide; ${seq.map((f) => `${f.w.toFixed(0)} px wide at ${f.fx.toFixed(4)},${f.fy.toFixed(4)}`).join('; ')}`);
    const fitShown = await p.evaluate(() => { const b = document.querySelector('[data-gl-fit]'); return b && !b.hidden ? b.innerText.replace(/\s+/g, ' ').trim() : null; });
    check('board_fit_chip_while_zoomed', !!fitShown && /\d+%\s*Fit/.test(fitShown), fitShown || 'hidden');
    // A drag pans.
    const t0 = await p.evaluate(() => document.getElementById('gl-im').style.transform);
    await p.mouse.down(); await p.mouse.move(v.x - 120, v.y - 60, { steps: 6 }); await p.mouse.up();
    const t1 = await p.evaluate(() => document.getElementById('gl-im').style.transform);
    check('board_drag_pans', t0 !== t1 && /scale/.test(t1), `${t0} to ${t1}`);
    await p.screenshot({ path: path.join(OUT, `board-zoom-${th}.png`) });
    await p.click('[data-gl-fit]');
    await sleep(300);
    check('board_fit_goes_back', await p.evaluate(() => !/scale/.test(document.getElementById('gl-im').style.transform)));
    // A double click toggles.
    await p.mouse.dblclick(v.x, v.y);
    await sleep(300);
    const dz = await p.evaluate(() => document.getElementById('gl-im').style.transform);
    await p.mouse.dblclick(v.x, v.y);
    await sleep(300);
    check('board_double_click_toggles', /scale\(2\.5\)/.test(dz) && await p.evaluate(() => !/scale/.test(document.getElementById('gl-im').style.transform)), dz);
    // The arrows and the strip move; each picture opens whole.
    await p.keyboard.press('ArrowRight');
    check('board_arrow_next', await until(() => p.evaluate(() => /\/variants\/2$/.test(document.getElementById('gl-im').getAttribute('src'))), 3000));
    await p.click('[data-gl-go="3"]');
    check('board_strip_goes', await until(() => p.evaluate(() => /\/variants\/3$/.test(document.getElementById('gl-im').getAttribute('src'))), 3000));
    // Esc fits a zoomed picture first, then closes.
    await p.mouse.dblclick(v.x, v.y);
    await sleep(250);
    await p.keyboard.press('Escape');
    await sleep(250);
    const afterEsc = await p.evaluate(() => ({ open: !document.getElementById('gl-fs').hidden, z: document.getElementById('gl-im').style.transform }));
    await p.keyboard.press('Escape');
    await sleep(250);
    check('board_escape_fits_then_closes', afterEsc.open && !/scale/.test(afterEsc.z) && await p.evaluate(() => document.getElementById('gl-fs').hidden), JSON.stringify(afterEsc));
    check('board_answered_nothing', await stillOpen());
    await ctx.close();
  }

  // ---------------------------------------------------------- the board in a phone's browser (390): the same card and viewer, no Pick
  if (BOARD) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check('board_phone_no_page_error', false, e.message));
    await p.goto(`${hub.url}/#paper-boat`);
    const tiles = await until(() => p.evaluate(() => { const t = [...document.querySelectorAll('.pk-tile img')]; return t.length === 4 && t.every((i) => i.complete && i.naturalWidth > 0); }), 15000);
    if (tiles) await p.tap('.pk-tile[data-n="1"]');
    const open = await until(() => p.evaluate(() => { const l = document.getElementById('gl-fs'); return l && !l.hidden && l.classList.contains('gl-p') && /\/variants\/1$/.test(document.getElementById('gl-im').getAttribute('src')); }), 6000);
    await sleep(400);
    const lay = await p.evaluate(() => { const l = document.getElementById('gl-fs'); return { text: l.innerText, buttons: [...l.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }; });
    check('board_phone_tap_opens_viewer_no_pick', !!tiles && !!open && !lay.buttons.some((b) => /^(Pick|Send|None of these)\b/.test(b)) && lay.text.includes(EN['pick.answerElsewhere']) && lay.text.includes('B, 2 of 4'), lay.text.replace(/\n/g, ' / ').slice(0, 240));
    await p.screenshot({ path: path.join(OUT, 'board-phone-dark.png') });
    await ctx.close();
  }

  // ---------------------------------------------------------- the phone board
  const PORT = await freePort();
  serve = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT), '--hub', hub.url], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: WORK } });
  await until(() => fetch(`http://127.0.0.1:${PORT}/phone/`).then((r) => r.ok), 10000);
  const PH = `http://127.0.0.1:${PORT}/phone/#/cp/${encodeURIComponent(ID)}`;
  for (const dark of [false, true]) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(`phone_${th}_no_page_error`, false, e.message));
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    // One finger along a path, or two (a pinch), in steps.
    const drag = async (pts, steps = 8) => {
      await touch('touchStart', [pts[0]]);
      for (let k = 1; k < pts.length; k++) for (let s = 1; s <= steps; s++) { const [ax, ay] = pts[k - 1], [bx, by] = pts[k]; await touch('touchMove', [[ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps]]); }
      await touch('touchEnd', []);
    };
    const pinch = async (c, d0, d1) => {
      await touch('touchStart', [[c.x - d0, c.y], [c.x + d0, c.y]]);
      for (let s = 1; s <= 8; s++) { const d = d0 + (d1 - d0) * s / 8; await touch('touchMove', [[c.x - d, c.y], [c.x + d, c.y]]); }
      await touch('touchEnd', []);
    };
    const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
    await p.goto(PH);
    await until(() => p.evaluate(() => { const t = [...document.querySelectorAll('.ptrack img')]; return t.length === 4 && t.every((i) => i.complete && i.naturalWidth > 0); }), 15000);
    await sleep(500);
    // The track's band: for each picture on screen, the gap between the bottom of what it shows and the track's.
    const bands = [];
    for (let k = 0; k < 4; k++) {
      await p.evaluate((k) => { const t = document.querySelector('.ptrack'); t.scrollLeft = k * t.clientWidth; }, k);
      await sleep(350);
      bands.push(await p.evaluate(([f, k]) => { const t = document.querySelector('.ptrack').getBoundingClientRect(); const c = eval(f)(document.querySelectorAll('.ptrack img')[k]); return { k, under: Math.round((t.bottom - (c.top + c.height)) * 10) / 10, over: Math.round((c.top - t.top) * 10) / 10, track: Math.round(t.height) }; }, [CONTENT, k]));
    }
    check(`phone_track_no_empty_band_${th}`, bands.every((b) => b.under <= 1 && b.over <= 1), bands.map((b) => `${'ABCD'[b.k]}: ${b.under} px under, ${b.over} over, track ${b.track}`).join('; '));
    await p.evaluate(() => { const t = document.querySelector('.ptrack'); t.scrollLeft = 0; });
    await sleep(350);
    await p.screenshot({ path: path.join(OUT, `phone-swipe-${th}.png`) });
    // A tap on the picture: the viewer, full screen, at its fit.
    const pr = await p.evaluate(() => { const r = document.querySelector('.ptrack').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await tap(pr.x, pr.y);
    const vOpen = await until(() => p.evaluate(() => { const v = document.querySelector('.pzv'); const im = document.querySelector('.pzv-box img'); return v && im && im.complete && im.naturalWidth > 0 ? document.querySelector('.pzv-at').textContent : null; }), 6000);
    await sleep(300);
    const st = () => p.evaluate(() => { const b = document.querySelector('.pzv-box'); const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e]+)\)/.exec(b.style.transform || ''); return { s: m ? +m[3] : 1, x: m ? +m[1] : 0, y: m ? +m[2] : 0, at: document.querySelector('.pzv-at').textContent, chip: !document.querySelector('.pzv-fit').hidden }; });
    check(`phone_tap_opens_viewer_${th}`, vOpen === 'A, 1 of 4' && await p.evaluate(() => { const v = document.querySelector('.pzv').getBoundingClientRect(); return v.width === innerWidth && v.height === innerHeight; }), String(vOpen));
    await p.screenshot({ path: path.join(OUT, `phone-fit-${th}.png`) });
    const sr = await p.evaluate(() => { const r = document.querySelector('.pzv-stage').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    const boxFrac = (pt) => p.evaluate((pt) => { const r = document.querySelector('.pzv-box').getBoundingClientRect(); return { fx: (pt.x - r.left) / r.width, fy: (pt.y - r.top) / r.height, w: r.width }; }, pt);
    // A swipe at fit: the next picture.
    await drag([[sr.cx + 120, sr.cy], [sr.cx - 120, sr.cy]]);
    await sleep(300);
    const sw = await st();
    check(`phone_swipe_at_fit_moves_${th}`, sw.at === 'B, 2 of 4', sw.at);
    await until(() => p.evaluate(() => { const im = document.querySelector('.pzv-box img'); return im.complete && im.naturalWidth > 0; }), 5000);
    await sleep(200);
    // A double tap zooms around the finger.
    const dp = { x: sr.x + sr.w * 0.62, y: sr.cy - 20 };
    const d0 = await boxFrac(dp);
    await tap(dp.x, dp.y); await sleep(80); await tap(dp.x, dp.y);
    await sleep(350);
    const d1 = await boxFrac(dp);
    const z1 = await st();
    check(`phone_double_tap_zooms_at_finger_${th}`, z1.s > 2 && Math.abs(d1.fx - d0.fx) < 0.004 && Math.abs(d1.fy - d0.fy) < 0.004 && z1.chip, `scale ${z1.s}, point ${d0.fx.toFixed(4)},${d0.fy.toFixed(4)} to ${d1.fx.toFixed(4)},${d1.fy.toFixed(4)}`);
    // Zoomed, one finger pans and the picture stays the same one.
    await drag([[sr.cx + 100, sr.cy], [sr.cx - 100, sr.cy + 30]]);
    await sleep(300);
    const z2 = await st();
    check(`phone_zoomed_finger_pans_not_swipes_${th}`, z2.at === 'B, 2 of 4' && z2.s === z1.s && (z2.x !== z1.x || z2.y !== z1.y), `${JSON.stringify(z1)} to ${JSON.stringify(z2)}`);
    // The chip: back to fit. A pinch: in again.
    if (await p.evaluate(() => !document.querySelector('.pzv-fit').hidden)) await p.click('.pzv-fit');
    await sleep(350);
    const z3 = await st();
    await pinch({ x: sr.cx, y: sr.cy }, 40, 150);
    await sleep(300);
    const z4 = await st();
    check(`phone_fit_chip_then_pinch_zooms_${th}`, z3.s === 1 && !z3.chip && z4.s > 2.5 && z4.chip, `fit ${JSON.stringify(z3)}, pinched ${JSON.stringify(z4)}`);
    await p.screenshot({ path: path.join(OUT, `phone-zoom-${th}.png`) });
    // Circle a part while zoomed: one finger around a rectangle; its fractions of the whole picture from what the screen shows.
    await p.click('.pzv-ctl .btn:not(.pri)');
    await sleep(300);
    const drawing = await p.evaluate(() => !!document.querySelector('.pzv-stage.drawing') && document.querySelector('.pzv-hint')?.textContent);
    await p.screenshot({ path: path.join(OUT, `phone-circling-${th}.png`) });
    const geo = await p.evaluate(() => { const r = document.querySelector('.pzv-box').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
    const a = { x: sr.cx - 50, y: sr.cy - 25 }, b = { x: sr.cx + 50, y: sr.cy + 25 };
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const want = { x: r4((a.x - geo.left) / geo.w), y: r4((a.y - geo.top) / geo.h), w: r4((b.x - a.x) / geo.w), h: r4((b.y - a.y) / geo.h) };
    if (!dark) { await ctx.close(); continue; }
    check('phone_circle_mode_while_zoomed', drawing === EN['phone.pick.drawHint'] && (await st()).s > 2.5, String(drawing));
    await drag([[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y], [a.x, a.y + 2]], 6);
    await sleep(300);
    const ring = await p.evaluate(() => ({ field: !!document.querySelector('.pzv-nf textarea'), strip: [...document.querySelectorAll('.pzv-th .pk-lt')].map((e) => e.textContent), send: document.querySelector('.pzv-ctl .btn.pri')?.textContent }));
    check('phone_circled_asks_note', ring.field && ring.strip[1] === 'B ✓' && ring.send === 'Send B, with the circle', JSON.stringify(ring));
    await p.fill('.pzv-nf textarea', 'Make Allow the bigger button');
    await sleep(200);
    const noted = await p.evaluate(() => ({ send: document.querySelector('.pzv-ctl .btn.pri')?.textContent }));
    await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(200);
    check('phone_note_send_label', noted.send === 'Send B, with the note', JSON.stringify(noted));
    await p.screenshot({ path: path.join(OUT, `phone-note-${th}.png`) });
    await p.click('.pzv-ctl .btn.pri');
    const closed = await until(async () => !(await stillOpen()), 10000);
    const got = await until(() => { try { const t = fs.readFileSync(OUTFILE, 'utf8'); return /EXIT/.test(t) ? t : null; } catch { return null; } }, 10000);
    const nums = got && ['x', 'y', 'w', 'h'].every((k) => got.includes(String(want[k])));
    check('phone_send_reaches_agent', closed && !!got && /Alerts/.test(got) && /Make Allow the bigger button/.test(got) && nums && /EXIT 0/.test(got), `want region ${JSON.stringify(want)}; agent: ${(got || 'nothing').replace(/\n/g, ' / ').slice(0, 300)}`);
    check('phone_ring_is_a_part_of_the_whole', want.w < 0.1 && want.h < 0.1, `ring ${JSON.stringify(want)} (zoomed: a small part of the whole picture)`);
    await ctx.close();
  }
} catch (e) {
  check('ran', false, e.stack || e.message);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  serve?.kill();
  hub?.stop();
  // The test's daemons (and with them their panes), as pick-shots stops them.
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
}
fs.writeFileSync(path.join(OUT, 'pickzoom-check.json'), JSON.stringify({ failed, checks: results }, null, 1));
console.log(`pickzoom-check: ${results.length} checks, ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
