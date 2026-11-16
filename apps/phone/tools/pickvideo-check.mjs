#!/usr/bin/env node
// A pick's videos on the board in a browser and on the phone board (the
// pickvideo round, 2026-11-16), headless, against a made-up board on a
// throwaway HOME (apps/desktop/tools/demo-hub.mjs, 127.0.0.1) where a plain
// shell pane in no project ("Video test", as on 2026-11-16) waits on a real
// `ravenry pick` in a real ravenryd of: a video (A, 640x360 6 s H.264, or
// PICKVIDEO_CLIP), a page that holds the same video as a data: URI (B, the
// shape of the page that did not play on 2026-11-16), a picture (C) and a
// second video (D, PICKVIDEO_CLIP2 or made here). Once the hub has kept
// them, the agent's files change and go (A cut short as a render rewriting
// it in place, B and D removed): the hub's copies are the only source.
// Each check drives the page as the person would and reads where it lands:
//
//   the board (1440 x 900): the card in no project has a row in Needs you,
//   named by its pane; its page shows each video's first frame (a frame
//   decoded, its size the video's) and the picture; a click opens the
//   viewer, where A plays (its time moves on), muted, looping, with its
//   controls; B plays its video the same way; C is a picture again, D plays;
//   no Pick. At 390 (the board the phone and iPad apps open on) the card has
//   its chip, and its page its pictures.
//
//   the phone board (390 x 844, touch): the track shows the first frames; a
//   tap opens the viewer, where A plays; the strip moves to B, which plays;
//   Circle a part stops it on the frame shown (its controls hidden); a ring
//   drawn there and the note, then Send B, with the note, reaches the agent
//   waiting in the pane as "region x y w h at t", t the frame's second.
//
// Pictures of each, dark and light, in OUT.
//
//   node tools/pickvideo-check.mjs [OUT]     (after node build.mjs; PICKVIDEO_CLIP=an.mp4)
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
const OUT = path.resolve(args[0] || path.join(APP_DIR, '.tmp', 'pickvideo-check'));
const WORK = path.join(APP_DIR, '.tmp', 'pickvideo-work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const EN = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'strings', 'en.json'), 'utf8'));
const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvv-'));
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
const FF = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f)) || 'ffmpeg';
const made = (name, src) => { const f = path.join(WORK, name); if (src) fs.copyFileSync(src, f); else execFileSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', f]); return f; };
const CLIP = made('take-one.mp4', process.env.PICKVIDEO_CLIP || '');
const CLIP2 = made('take-three.mp4', process.env.PICKVIDEO_CLIP2 || '');
const sizeOf = (f) => execFileSync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const [VW, VH] = sizeOf(CLIP);
const [VW2] = sizeOf(CLIP2);
const PAGE = path.join(WORK, 'take-two.html');
fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#0d0f12;height:100%;display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100vh}</style></head><body><video src="data:video/mp4;base64,${fs.readFileSync(CLIP).toString('base64')}" controls autoplay muted loop playsinline></video></body></html>`);
const PIC = path.join(WORK, 'still.png');
fs.writeFileSync(PIC, gridPng(1280, 720, [70, 110, 170], [40, 60, 90]));
const VARS = [['Take one', CLIP, 'The clip as it is.'], ['Take two', PAGE, 'The same clip in a page.'], ['Still', PIC, 'A picture, for once.'], ['Take three', CLIP2, 'Another clip.']];
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

// ------------------------------------------------------------ the board
const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
let hub = null, serve = null, browser = null;
const OUTFILE = path.join(WORK, 'pick.out');
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'], env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') } });
  // A plain shell pane in no project, as main's was: no session, no hooks.
  const variants = VARS.map(([l, f, w]) => `--variant ${q(`${l}=${f}`)} --describe ${q(`${l}=${w}`)}`).join(' ');
  const script = path.join(WORK, 'shell.sh');
  fs.writeFileSync(script, [`'${BIN}' pick ${q('Which take should I keep?')} ${variants} --timeout 30m >${q(OUTFILE)} 2>&1`, `echo "EXIT $?" >>${q(OUTFILE)}`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  const loose = path.join(WORK, 'scratch');
  fs.mkdirSync(loose, { recursive: true });
  execFileSync(BIN, ['new', '--cwd', loose, '--name', 'Video test', '--size', '90x30', '--', '/bin/sh', script], { env: localEnv });
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.variants && c.variants[1] && c.variants[1].video && c.paneName && c.pick_record && c.pick_record.variants.every((v) => v.kept)) || null; }, 60000);
  check('pick_with_videos_in_no_project', !!cp && cp.projectId == null && cp.paneName === 'Video test', cp ? `${cp.id} project ${cp.projectId} pane ${cp.paneName}: ${cp.variants.map((v) => `${v.type} ${v.video || '-'}`).join(', ')}` : `no open pick with its page's video, its pane's name and its copies kept; agent: ${(() => { try { return fs.readFileSync(OUTFILE, 'utf8').trim(); } catch { return 'nothing'; } })()}`);
  if (!cp) throw new Error('no pick');
  const ID = cp.id;
  check('the_variants_play_videos', cp.variants[0].type === 'video' && /\/variants\/0$/.test(cp.variants[0].video) && /\/variants\/1\?as=video$/.test(cp.variants[1].video) && !cp.variants[2].video && /\/variants\/3$/.test(cp.variants[3].video), JSON.stringify(cp.variants.map((v) => ({ type: v.type, video: v.video || null }))));
  // The agent's files change and go: the hub's copies are the only source from here.
  fs.writeFileSync(CLIP, fs.readFileSync(CLIP).subarray(0, 4096));
  fs.rmSync(PAGE); fs.rmSync(CLIP2);
  const stillOpen = async () => ((await hub.state()).checkpoints || []).some((c) => c.id === ID && c.state === 'open');

  browser = await chromium.launch({ headless: true });
  // A video element's state: its time, whether it plays, its frame.
  const VID = `(v) => v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, h: v.videoHeight, muted: v.muted, loop: v.loop, controls: v.controls, src: v.getAttribute('src') || '' } : null`;

  // ---------------------------------------------------------- the board in a browser
  for (const dark of [true, false]) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(`board_${th}_no_page_error`, false, e.message));
    await p.goto(`${hub.url}/`);
    // Its row in Needs you, named by its pane; a click opens its page, which is its card.
    const row = await until(() => p.evaluate((id) => { const r = document.querySelector(`#list .row[data-id="cp:${id}"]`); return r ? { text: r.innerText.replace(/\s+/g, ' '), group: r.closest('section') && r.closest('section').querySelector('.grp-h').innerText.replace(/\s+/g, ' ') } : null; }, ID), 15000);
    if (dark) check('board_card_in_no_project_has_a_row', !!row && /Video test/.test(row.text) && /Needs you/.test(row.group || ''), JSON.stringify(row));
    if (row) await p.click(`#list .row[data-id="cp:${ID}"]`);
    const tiles = await until(() => p.evaluate(([f, vw]) => { const t = [...document.querySelectorAll('.pk-tile')]; if (t.length !== 4) return null; const v = [0, 1, 3].map((k) => eval(f)(t[k].querySelector('video'))); const im = t[2].querySelector('img'); return v.every((x) => x && x.rs >= 2) && v[0].w === vw && im && im.complete && im.naturalWidth === 1280 ? { v, marks: t.map((x) => !!x.querySelector('.pk-play')) } : null; }, [VID, VW]), 30000);
    await sleep(300);
    await p.screenshot({ path: path.join(OUT, `board-card-${th}.png`) });
    if (!dark) { await ctx.close(); continue; }
    check('board_card_first_frames', !!tiles && tiles.marks.join() === 'true,true,false,true' && tiles.v.every((x) => x.paused && x.t < 0.1) && tiles.v[2].w === VW2, JSON.stringify(tiles));
    await p.click('.pk-tile[data-n="0"]');
    const v0 = await until(() => p.evaluate((f) => { const l = document.getElementById('gl-fs'); const v = eval(f)(document.getElementById('gl-vid')); return l && !l.hidden && v && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1200);
    const v1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    const shown = await p.evaluate(() => ({ vid: !document.getElementById('gl-vid').hidden, img: !document.getElementById('gl-im').hidden }));
    check('board_click_plays_time_advances', !!v0 && v1.t > v0.t + 0.8 && !v1.paused && v1.muted && v1.loop && v1.controls && /\/variants\/0$/.test(v1.src) && shown.vid && !shown.img, `${JSON.stringify(v0)} then ${JSON.stringify(v1)}`);
    const lay = await p.evaluate(() => { const l = document.getElementById('gl-fs'); return { text: l.innerText, buttons: [...l.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }; });
    check('board_viewer_no_pick_words', !lay.buttons.some((b) => /^(Pick|Send|None of these)\b/.test(b)) && lay.text.includes(EN['pick.answerElsewhere']) && lay.text.includes('A. Take one') && lay.text.includes(`${VW} x ${VH}`), lay.text.replace(/\n/g, ' / ').slice(0, 300));
    await p.screenshot({ path: path.join(OUT, `board-video-${th}.png`) });
    // The page's video: B plays the same way.
    await p.keyboard.press('ArrowRight');
    const b0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.getElementById('gl-vid')); return v && /\/variants\/1\?as=video$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const b1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    check('board_page_video_plays', !!b0 && b1.t > b0.t + 0.6 && !b1.paused && b1.w === VW, `${JSON.stringify(b0)} then ${JSON.stringify(b1)}`);
    // C: a picture again, the video stopped and gone.
    await p.keyboard.press('ArrowRight');
    const c = await until(() => p.evaluate(() => { const im = document.getElementById('gl-im'); const v = document.getElementById('gl-vid'); return !im.hidden && v.hidden && !v.getAttribute('src') && /\/variants\/2$/.test(im.getAttribute('src')) && im.complete && im.naturalWidth === 1280; }), 6000);
    check('board_picture_after_video', !!c);
    // D: the second video, its agent's file gone, plays from the hub's copy.
    await p.keyboard.press('ArrowRight');
    const d0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.getElementById('gl-vid')); return v && /\/variants\/3$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const d1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    check('board_second_video_plays_source_gone', !!d0 && d1.t > d0.t + 0.6 && !d1.paused && d1.w === VW2, `${JSON.stringify(d0)} then ${JSON.stringify(d1)}`);
    // The strip: each video's first frame.
    const strip = await p.evaluate((f) => [...document.querySelectorAll('#gl-strip .gl-thumb')].map((b) => { const v = b.querySelector('video'); return v ? eval(f)(v) : b.querySelector('img') ? 'img' : null; }), VID);
    check('board_strip_first_frames', strip.length === 4 && strip[0] && strip[0].rs >= 2 && strip[1] && strip[1].rs >= 2 && strip[2] === 'img' && strip[3] && strip[3].rs >= 2, JSON.stringify(strip));
    await p.keyboard.press('Escape');
    check('board_answered_nothing', await stillOpen());
    await ctx.close();
  }
  // ---------------------------------------------------------- an open board when the Mac's hub updates
  // (an iPad opened before 0.1.59 never showed a card in no project): the
  // board's files change on disk (their time, as an update's new ones), and
  // the open page loads the new board by itself; nothing typed is lost.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check('board_update_no_page_error', false, e.message));
    await p.goto(`${hub.url}/#cp:${ID}`);
    await until(() => p.evaluate(() => !!window.__rvBoardBuild || null), 15000);
    await p.evaluate(() => { window.__rvMark = 'before the update'; return true; });
    const b0 = await p.evaluate(() => window.__rvBoardBuild || null);
    const css = path.join(REPO, 'hub', 'public', 'app.css');
    const st = fs.statSync(css);
    fs.utimesSync(css, st.atime, new Date());
    const again = await until(() => p.evaluate(() => (!window.__rvMark && window.__rvBoardBuild ? window.__rvBoardBuild : null)).catch(() => null), 20000, 500);
    const row = await until(() => p.evaluate((id) => !!document.querySelector(`#list .row[data-id="cp:${id}"]`), ID).catch(() => null), 10000);
    check('board_loads_again_when_the_hub_updates', !!b0 && !!again && again !== b0 && !!row, `board ${b0} then ${again}, the card's row ${row}`);
    await ctx.close();
  }
  // ---------------------------------------------------------- the board at a phone's width (the phone and iPad apps open on it)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check('board_phone_no_page_error', false, e.message));
    await p.goto(`${hub.url}/`);
    const chip = await until(() => p.evaluate((id) => { const c = document.querySelector(`#pchips .pchip[data-id="cp:${id}"]`); return c ? c.innerText.replace(/\s+/g, ' ') : null; }, ID), 15000);
    if (chip) await p.tap(`#pchips .pchip[data-id="cp:${ID}"]`);
    const shown = await until(() => p.evaluate(() => { const t = [...document.querySelectorAll('.pk-tile')]; return t.length === 4 && t.filter((x) => { const v = x.querySelector('video'); return v && v.readyState >= 2; }).length === 3 ? document.getElementById('d-ask-top').innerText.replace(/\n/g, ' / ') : null; }), 20000);
    check('board_phone_card_in_no_project_shows', !!chip && /Video test/.test(chip) && !!shown && shown.includes('Which take should I keep?'), `chip ${chip}; card ${shown}`);
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
    const drag = async (pts, steps = 8) => {
      await touch('touchStart', [pts[0]]);
      for (let k = 1; k < pts.length; k++) for (let s = 1; s <= steps; s++) { const [ax, ay] = pts[k - 1], [bx, by] = pts[k]; await touch('touchMove', [[ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps]]); }
      await touch('touchEnd', []);
    };
    const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
    await p.goto(PH);
    const track = await until(() => p.evaluate(([f, vw]) => { const s = [...document.querySelectorAll('.ptrack .pimg')]; if (s.length !== 4) return null; const v = [0, 1, 3].map((k) => eval(f)(s[k].querySelector('video'))); return v.every((x) => x && x.rs >= 2) && v[0].w === vw ? { v, marks: s.map((x) => !!x.querySelector('.pk-play')), h: Math.round(document.querySelector('.ptrack').getBoundingClientRect().height), w: Math.round(document.querySelector('.ptrack').clientWidth) } : null; }, [VID, VW]), 30000);
    await sleep(400);
    await p.screenshot({ path: path.join(OUT, `phone-swipe-${th}.png`) });
    if (dark) check('phone_track_first_frames', !!track && track.marks.join() === 'true,true,false,true' && Math.abs(track.h - Math.round(track.w * VH / VW)) <= 1, JSON.stringify(track));
    // A tap: the viewer, A playing.
    const pr = await p.evaluate(() => { const r = document.querySelector('.ptrack').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await tap(pr.x, pr.y);
    const a0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.querySelector('.pzv-box video.pzv-vid')); return v && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1200);
    const a1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    const at = await p.evaluate(() => document.querySelector('.pzv-at')?.textContent);
    if (dark) check('phone_tap_plays_time_advances', !!a0 && a1.t > a0.t + 0.8 && !a1.paused && a1.muted && a1.loop && a1.controls && at === 'A, 1 of 4', `${at}: ${JSON.stringify(a0)} then ${JSON.stringify(a1)}`);
    await p.screenshot({ path: path.join(OUT, `phone-video-${th}.png`) });
    // The strip: B, the page's video, plays the same way.
    await p.click('.pzv-th:nth-child(2)');
    const b0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.querySelector('.pzv-box video.pzv-vid')); return v && /as=video$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const b1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    if (dark) check('phone_page_video_plays', !!b0 && b1.t > b0.t + 0.6 && !b1.paused && (await p.evaluate(() => document.querySelector('.pzv-at').textContent)) === 'B, 2 of 4', `${JSON.stringify(b0)} then ${JSON.stringify(b1)}`);
    if (!dark) { await ctx.close(); continue; }
    // Circle a part: it stops on the frame shown, its controls go; the hint says where.
    await p.click('.pzv-ctl .btn:not(.pri)');
    await sleep(400);
    const c0 = await p.evaluate((f) => ({ v: eval(f)(document.querySelector('.pzv-box video.pzv-vid')), hint: document.querySelector('.pzv-hint')?.textContent, drawing: !!document.querySelector('.pzv-stage.drawing') }), VID);
    await sleep(600);
    const c1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    check('phone_circle_stops_on_frame', c0.drawing && c0.v.paused && !c0.v.controls && Math.abs(c1.t - c0.v.t) < 0.01 && /^Stopped at 0:0\d\.\d\. Draw around/.test(c0.hint || ''), JSON.stringify(c0) + ` then ${c1.t}`);
    await p.screenshot({ path: path.join(OUT, `phone-circling-${th}.png`) });
    const sr = await p.evaluate(() => { const r = document.querySelector('.pzv-stage').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    const geo = await p.evaluate(() => { const r = document.querySelector('.pzv-box').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
    const a = { x: sr.cx - 60, y: sr.cy - 30 }, b = { x: sr.cx + 60, y: sr.cy + 30 };
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const want = { x: r4((a.x - geo.left) / geo.w), y: r4((a.y - geo.top) / geo.h), w: r4((b.x - a.x) / geo.w), h: r4((b.y - a.y) / geo.h) };
    await drag([[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y], [a.x, a.y + 2]], 6);
    await sleep(400);
    const ring = await p.evaluate((f) => ({ field: !!document.querySelector('.pzv-nf textarea'), frame: document.querySelector('.pzv-fr')?.textContent, v: eval(f)(document.querySelector('.pzv-box video.pzv-vid')), strip: [...document.querySelectorAll('.pzv-th .pk-lt')].map((e) => e.textContent), send: document.querySelector('.pzv-ctl .btn.pri')?.textContent }), VID);
    const clockOf = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    check('phone_ring_on_the_frame', ring.field && ring.frame === EN['pick.frameAt'].replace('{t}', clockOf(c0.v.t)) && ring.v.paused && Math.abs(ring.v.t - c0.v.t) < 0.01 && ring.strip[1] === 'B ✓' && ring.send === 'Send B, with the circle', JSON.stringify(ring));
    await p.fill('.pzv-nf textarea', 'Slower here');
    await sleep(200);
    await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(200);
    await p.screenshot({ path: path.join(OUT, `phone-note-${th}.png`) });
    await p.click('.pzv-ctl .btn.pri');
    const closed = await until(async () => !(await stillOpen()), 10000);
    const got = await until(() => { try { const t = fs.readFileSync(OUTFILE, 'utf8'); return /EXIT/.test(t) ? t : null; } catch { return null; } }, 10000);
    const line = `region ${['x', 'y', 'w', 'h'].map((k) => want[k].toFixed(4)).join(' ')} at ${(Math.round(c0.v.t * 1000) / 1000).toFixed(2)}`;
    const near = got && (() => { const m = /region ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) at ([\d.]+)/.exec(got); return m && ['x', 'y', 'w', 'h'].every((k, i) => Math.abs(+m[i + 1] - want[k]) < 0.0002) && Math.abs(+m[5] - c0.v.t) < 0.006; })();
    check('phone_send_reaches_agent_with_t', closed && !!got && /^Take two$/m.test(got) && near && /note Slower here/.test(got) && /EXIT 0/.test(got), `want "${line}"; agent: ${(got || 'nothing').replace(/\n/g, ' / ').slice(0, 300)}`);
    await ctx.close();
  }
} catch (e) {
  check('ran', false, e.stack || e.message);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  serve?.kill();
  hub?.stop();
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
  if (!process.env.PICKVIDEO_KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
fs.writeFileSync(path.join(OUT, 'pickvideo-check.json'), JSON.stringify({ failed, checks: results }, null, 1));
console.log(`pickvideo-check: ${results.length} checks, ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
