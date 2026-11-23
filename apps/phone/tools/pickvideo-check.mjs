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
const pw = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
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
// A clip given keeps its own type (.webm, .mov): the variant and the page's data: URI say it.
const made = (name, src) => { const f = path.join(WORK, src ? name.replace(/\.mp4$/, path.extname(src).toLowerCase()) : name); if (src) fs.copyFileSync(src, f); else execFileSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', f]); return f; };
const CLIP = made('take-one.mp4', process.env.PICKVIDEO_CLIP || '');
const CLIP2 = made('take-three.mp4', process.env.PICKVIDEO_CLIP2 || '');
const sizeOf = (f) => execFileSync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const [VW, VH] = sizeOf(CLIP);
const [VW2] = sizeOf(CLIP2);
const PAGE = path.join(WORK, 'take-two.html');
fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#0d0f12;height:100%;display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100vh}</style></head><body><video src="data:${({ '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm' })[path.extname(CLIP)] || 'video/mp4'};base64,${fs.readFileSync(CLIP).toString('base64')}" controls autoplay muted loop playsinline></video></body></html>`);
const PIC = path.join(WORK, 'still.png');
fs.writeFileSync(PIC, gridPng(1280, 720, [70, 110, 170], [40, 60, 90]));
const VARS = [['Take one', CLIP, 'The clip as it is.'], ['Take two', PAGE, 'The same clip in a page.'], ['Still', PIC, 'A picture, for once.'], ['Take three', CLIP2, 'Another clip.']];
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

// ------------------------------------------------------------ the board
const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
let hub = null, serve = null, browser = null;

async function runEngine(E) {
  const N = (n) => (E === 'chromium' ? n : `${E}_${n}`);
  const PFX = E === 'chromium' ? '' : `${E}-`;
  // A plain shell pane in no project, as main's was: no session, no hooks.
  // This engine's own pick, its own copies of the variants (they change and go below).
  const dir = path.join(WORK, E);
  fs.mkdirSync(dir, { recursive: true });
  const [clip, page, pic, clip2] = [CLIP, PAGE, PIC, CLIP2].map((f) => { const t = path.join(dir, path.basename(f)); fs.copyFileSync(f, t); return t; });
  const vars = [['Take one', clip, 'The clip as it is.'], ['Take two', page, 'The same clip in a page.'], ['Still', pic, 'A picture, for once.'], ['Take three', clip2, 'Another clip.']];
  const OUTFILE = path.join(dir, 'pick.out');
  const variants = vars.map(([l, f, w]) => `--variant ${q(`${l}=${f}`)} --describe ${q(`${l}=${w}`)}`).join(' ');
  const script = path.join(dir, 'shell.sh');
  fs.writeFileSync(script, [`'${BIN}' pick ${q('Which take should I keep?')} ${variants} --timeout 30m >${q(OUTFILE)} 2>&1`, `echo "EXIT $?" >>${q(OUTFILE)}`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  const loose = path.join(dir, 'scratch');
  fs.mkdirSync(loose, { recursive: true });
  execFileSync(BIN, ['new', '--cwd', loose, '--name', 'Video test', '--size', '90x30', '--', '/bin/sh', script], { env: localEnv });
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.variants && c.variants[1] && c.variants[1].video && c.paneName && c.pick_record && c.pick_record.variants.every((v) => v.kept) && !seenPicks.has(c.id)) || null; }, 60000);
  check(N('pick_with_videos_in_no_project'), !!cp && cp.projectId == null && cp.paneName === 'Video test', cp ? `${cp.id} project ${cp.projectId} pane ${cp.paneName}: ${cp.variants.map((v) => `${v.type} ${v.video || '-'}`).join(', ')}` : `no open pick with its page's video, its pane's name and its copies kept; agent: ${(() => { try { return fs.readFileSync(OUTFILE, 'utf8').trim(); } catch { return 'nothing'; } })()}`);
  if (!cp) throw new Error('no pick');
  const ID = cp.id;
  seenPicks.add(ID);
  check(N('the_variants_play_videos'), cp.variants[0].type === 'video' && /\/variants\/0$/.test(cp.variants[0].video) && /\/variants\/1\?as=video$/.test(cp.variants[1].video) && !cp.variants[2].video && /\/variants\/3$/.test(cp.variants[3].video), JSON.stringify(cp.variants.map((v) => ({ type: v.type, video: v.video || null }))));
  // The agent's files change and go: the hub's copies are the only source from here.
  fs.writeFileSync(clip, fs.readFileSync(clip).subarray(0, 4096));
  fs.rmSync(page); fs.rmSync(clip2);
  const stillOpen = async () => ((await hub.state()).checkpoints || []).some((c) => c.id === ID && c.state === 'open');

  browser = await pw[E].launch({ headless: true });
  // A video element's state: its time, whether it plays, its frame.
  // A thumbnail's first frame: a picture drawn once (no player of its own, the pickvideo round's fourth part).
  const FRAME = `(b) => { const i = b && b.querySelector('img'); return b && !b.querySelector('video') && i && i.complete && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight, frame: !!i.dataset.frame || /^blob:/.test(i.getAttribute('src') || '') } : null; }`;
  const VID = `(v) => v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, h: v.videoHeight, muted: v.muted, loop: v.loop, controls: v.controls, src: v.getAttribute('src') || '' } : null`;
  if (CANT.has(E)) { await cantRun(E, N, ID, OUTFILE, stillOpen, FRAME); return; }

  // ---------------------------------------------------------- the board in a browser
  for (const dark of [true, false]) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(N(`board_${th}_no_page_error`), false, e.message));
    await p.goto(`${hub.url}/`);
    // Its row in Needs you, named by its pane; a click opens its page, which is its card.
    const row = await until(() => p.evaluate((id) => { const r = document.querySelector(`#list .row[data-id="cp:${id}"]`); return r ? { text: r.innerText.replace(/\s+/g, ' '), group: r.closest('section') && r.closest('section').querySelector('.grp-h').innerText.replace(/\s+/g, ' ') } : null; }, ID), 15000);
    if (dark) check(N('board_card_in_no_project_has_a_row'), !!row && /Video test/.test(row.text) && /Needs you/.test(row.group || ''), JSON.stringify(row));
    if (row) await p.click(`#list .row[data-id="cp:${ID}"]`);
    const tiles = await until(() => p.evaluate(([f, vw]) => { const t = [...document.querySelectorAll('.pk-tile')]; if (t.length !== 4) return null; const v = [0, 1, 3].map((k) => eval(f)(t[k])); const im = t[2].querySelector('img'); return v.every((x) => x) && v[0].w === vw && im && im.complete && im.naturalWidth === 1280 ? { v, marks: t.map((x) => !!x.querySelector('.pk-play')) } : null; }, [FRAME, VW]), 30000);
    await sleep(300);
    await p.screenshot({ path: path.join(OUT, PFX + `board-card-${th}.png`) });
    if (!dark) { await ctx.close(); continue; }
    check(N('board_card_first_frames'), !!tiles && tiles.marks.join() === 'true,true,false,true' && tiles.v.every((x) => x.frame) && tiles.v[1].w === VW && tiles.v[2].w === VW2, JSON.stringify(tiles));
    await p.click('.pk-tile[data-n="0"]');
    const v0 = await until(() => p.evaluate((f) => { const l = document.getElementById('gl-fs'); const v = eval(f)(document.getElementById('gl-vid')); return l && !l.hidden && v && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1200);
    const v1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    const shown = await p.evaluate(() => ({ vid: !document.getElementById('gl-vid').hidden, img: !document.getElementById('gl-im').hidden }));
    check(N('board_click_plays_time_advances'), !!v0 && v1.t > v0.t + 0.8 && !v1.paused && v1.muted && v1.loop && v1.controls && /\/variants\/0$/.test(v1.src) && shown.vid && !shown.img, `${JSON.stringify(v0)} then ${JSON.stringify(v1)}`);
    const lay = await p.evaluate(() => { const l = document.getElementById('gl-fs'); return { text: l.innerText, buttons: [...l.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }; });
    check(N('board_viewer_no_pick_words'), !lay.buttons.some((b) => /^(Pick|Send|None of these)\b/.test(b)) && lay.text.includes(EN['pick.answerElsewhere']) && lay.text.includes('A. Take one') && lay.text.includes(`${VW} x ${VH}`), lay.text.replace(/\n/g, ' / ').slice(0, 300));
    await p.screenshot({ path: path.join(OUT, PFX + `board-video-${th}.png`) });
    // The page's video: B plays the same way.
    await p.keyboard.press('ArrowRight');
    const b0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.getElementById('gl-vid')); return v && /\/variants\/1\?as=video$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const b1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    check(N('board_page_video_plays'), !!b0 && b1.t > b0.t + 0.6 && !b1.paused && b1.w === VW, `${JSON.stringify(b0)} then ${JSON.stringify(b1)}`);
    // C: a picture again, the video stopped and gone.
    await p.keyboard.press('ArrowRight');
    const c = await until(() => p.evaluate(() => { const im = document.getElementById('gl-im'); const v = document.getElementById('gl-vid'); return !im.hidden && v.hidden && !v.getAttribute('src') && /\/variants\/2$/.test(im.getAttribute('src')) && im.complete && im.naturalWidth === 1280; }), 6000);
    check(N('board_picture_after_video'), !!c);
    // D: the second video, its agent's file gone, plays from the hub's copy.
    await p.keyboard.press('ArrowRight');
    const d0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.getElementById('gl-vid')); return v && /\/variants\/3$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const d1 = await p.evaluate((f) => eval(f)(document.getElementById('gl-vid')), VID);
    check(N('board_second_video_plays_source_gone'), !!d0 && d1.t > d0.t + 0.6 && !d1.paused && d1.w === VW2, `${JSON.stringify(d0)} then ${JSON.stringify(d1)}`);
    // The strip: each video's first frame.
    const strip = await until(() => p.evaluate((f) => { const s = [...document.querySelectorAll('#gl-strip .gl-thumb')].map((b) => (b.querySelector('img[data-frame]') ? eval(f)(b) : b.querySelector('img') ? 'img' : null)); return s.length === 4 && s[0] && s[1] && s[3] ? s : null; }, FRAME), 10000);
    check(N('board_strip_first_frames'), !!strip && strip[0].w === VW && strip[1].w === VW && strip[2] === 'img' && strip[3].w === VW2, JSON.stringify(strip));
    // The viewer closed while D plays: its player stops and lets its video go (a player taken off the page plays on).
    await p.evaluate(() => { window.__rvVid = document.getElementById('gl-vid'); });
    await p.keyboard.press('Escape');
    const gone = await until(() => p.evaluate((f) => { const v = window.__rvVid; return v && v.paused && !v.getAttribute('src') ? eval(f)(v) : null; }, VID), 3000);
    check(N('board_close_lets_go'), !!gone, JSON.stringify(await p.evaluate((f) => eval(f)(window.__rvVid), VID)));
    check(N('board_answered_nothing'), await stillOpen());
    await ctx.close();
  }
  // ---------------------------------------------------------- an open board when the Mac's hub updates
  // (an iPad opened before 0.1.59 never showed a card in no project): the
  // board's files change on disk (their time, as an update's new ones), and
  // the open page loads the new board by itself; nothing typed is lost.
  if (E === 'chromium') {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(N('board_update_no_page_error'), false, e.message));
    await p.goto(`${hub.url}/#cp:${ID}`);
    await until(() => p.evaluate(() => !!window.__rvBoardBuild || null), 15000);
    await p.evaluate(() => { window.__rvMark = 'before the update'; return true; });
    const b0 = await p.evaluate(() => window.__rvBoardBuild || null);
    const css = path.join(REPO, 'hub', 'public', 'app.css');
    const st = fs.statSync(css);
    fs.utimesSync(css, st.atime, new Date());
    const again = await until(() => p.evaluate(() => (!window.__rvMark && window.__rvBoardBuild ? window.__rvBoardBuild : null)).catch(() => null), 20000, 500);
    const row = await until(() => p.evaluate((id) => !!document.querySelector(`#list .row[data-id="cp:${id}"]`), ID).catch(() => null), 10000);
    check(N('board_loads_again_when_the_hub_updates'), !!b0 && !!again && again !== b0 && !!row, `board ${b0} then ${again}, the card's row ${row}`);
    await ctx.close();
  }
  // ---------------------------------------------------------- the board at a phone's width (the phone and iPad apps open on it)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', ...(E === 'chromium' ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(N('board_phone_no_page_error'), false, e.message));
    await p.goto(`${hub.url}/`);
    const chip = await until(() => p.evaluate((id) => { const c = document.querySelector(`#pchips .pchip[data-id="cp:${id}"]`); return c ? c.innerText.replace(/\s+/g, ' ') : null; }, ID), 15000);
    if (chip) await (E === 'chromium' ? p.tap.bind(p) : p.click.bind(p))(`#pchips .pchip[data-id="cp:${ID}"]`);
    const shown = await until(() => p.evaluate((f) => { const t = [...document.querySelectorAll('.pk-tile')]; return t.length === 4 && t.filter((x) => eval(f)(x)).length === 4 ? document.getElementById('d-ask-top').innerText.replace(/\n/g, ' / ') : null; }, FRAME), 20000);
    check(N('board_phone_card_in_no_project_shows'), !!chip && /Video test/.test(chip) && !!shown && shown.includes('Which take should I keep?'), `chip ${chip}; card ${shown}`);
    await p.screenshot({ path: path.join(OUT, PFX + 'board-phone-dark.png') });
    await ctx.close();
  }

  // ---------------------------------------------------------- the phone board
  const PH = `http://127.0.0.1:${PORT}/phone/#/cp/${encodeURIComponent(ID)}`;
  for (const dark of [false, true]) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', ...(E === 'chromium' ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage();
    // (WebKit through serve.mjs: the phone board's machine list, a fetch it catches, fails "due to access control checks"; not a video's.)
    p.on('pageerror', (e) => { if (!(E === 'webkit' && /\/api\/machines due to access control checks/.test(e.message))) check(N(`phone_${th}_no_page_error`), false, e.message); });
    // Chromium: a finger (CDP's touch events); WebKit (no touch in Playwright's WebKit on a Mac): the mouse, pointer events all the same.
    const cdp = E === 'chromium' ? await ctx.newCDPSession(p) : null;
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const drag = E !== 'chromium' ? async (pts) => { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const [x, y] of pts.slice(1)) await p.mouse.move(x, y, { steps: 6 }); await p.mouse.up(); } : async (pts, steps = 8) => {
      await touch('touchStart', [pts[0]]);
      for (let k = 1; k < pts.length; k++) for (let s = 1; s <= steps; s++) { const [ax, ay] = pts[k - 1], [bx, by] = pts[k]; await touch('touchMove', [[ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps]]); }
      await touch('touchEnd', []);
    };
    const tap = E !== 'chromium' ? (x, y) => p.mouse.click(x, y) : async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
    await p.goto(PH);
    const track = await until(() => p.evaluate(([f, vw]) => { const s = [...document.querySelectorAll('.ptrack .pimg')]; if (s.length !== 4) return null; const v = [0, 1, 3].map((k) => eval(f)(s[k])); return v.every((x) => x && x.frame) && v[0].w === vw ? { v, marks: s.map((x) => !!x.querySelector('.pk-play')), h: Math.round(document.querySelector('.ptrack').getBoundingClientRect().height), w: Math.round(document.querySelector('.ptrack').clientWidth) } : null; }, [FRAME, VW]), 30000);
    await sleep(400);
    await p.screenshot({ path: path.join(OUT, PFX + `phone-swipe-${th}.png`) });
    if (dark) check(N('phone_track_first_frames'), !!track && track.marks.join() === 'true,true,false,true' && Math.abs(track.h - Math.round(track.w * VH / VW)) <= 1, JSON.stringify(track));
    // A tap: the viewer, A playing.
    const pr = await p.evaluate(() => { const r = document.querySelector('.ptrack').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await tap(pr.x, pr.y);
    const a0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.querySelector('.pzv-box video.pzv-vid')); return v && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1200);
    const a1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    const at = await p.evaluate(() => document.querySelector('.pzv-at')?.textContent);
    if (dark) check(N('phone_tap_plays_time_advances'), !!a0 && a1.t > a0.t + 0.8 && !a1.paused && a1.muted && a1.loop && a1.controls && at === 'A, 1 of 4', `${at}: ${JSON.stringify(a0)} then ${JSON.stringify(a1)}`);
    await p.screenshot({ path: path.join(OUT, PFX + `phone-video-${th}.png`) });
    // The strip: B, the page's video, plays the same way.
    await p.click('.pzv-th:nth-child(2)');
    const b0 = await until(() => p.evaluate((f) => { const v = eval(f)(document.querySelector('.pzv-box video.pzv-vid')); return v && /as=video$/.test(v.src) && v.t > 0.2 ? v : null; }, VID), 10000);
    await sleep(1000);
    const b1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    if (dark) check(N('phone_page_video_plays'), !!b0 && b1.t > b0.t + 0.6 && !b1.paused && (await p.evaluate(() => document.querySelector('.pzv-at').textContent)) === 'B, 2 of 4', `${JSON.stringify(b0)} then ${JSON.stringify(b1)}`);
    if (!dark) {
      // The viewer closed while B plays: its player stops and lets its video go.
      await p.evaluate(() => { window.__rvVid = document.querySelector('.pzv-box video.pzv-vid'); });
      await p.click(`button[aria-label="${EN['phone.pick.closeViewer']}"]`);
      const gone = await until(() => p.evaluate((f) => { const v = window.__rvVid; return v && v.paused && !v.getAttribute('src') ? eval(f)(v) : null; }, VID), 3000);
      check(N('phone_close_lets_go'), !!gone, JSON.stringify(await p.evaluate((f) => eval(f)(window.__rvVid), VID)));
      await ctx.close(); continue;
    }
    // Circle a part: it stops on the frame shown, its controls go; the hint says where.
    await p.click('.pzv-ctl .btn:not(.pri)');
    await sleep(400);
    const c0 = await p.evaluate((f) => ({ v: eval(f)(document.querySelector('.pzv-box video.pzv-vid')), hint: document.querySelector('.pzv-hint')?.textContent, drawing: !!document.querySelector('.pzv-stage.drawing') }), VID);
    await sleep(600);
    const c1 = await p.evaluate((f) => eval(f)(document.querySelector('.pzv-box video.pzv-vid')), VID);
    check(N('phone_circle_stops_on_frame'), c0.drawing && c0.v.paused && !c0.v.controls && Math.abs(c1.t - c0.v.t) < 0.01 && /^Stopped at 0:0\d\.\d\. Draw around/.test(c0.hint || ''), JSON.stringify(c0) + ` then ${c1.t}`);
    await p.screenshot({ path: path.join(OUT, PFX + `phone-circling-${th}.png`) });
    const sr = await p.evaluate(() => { const r = document.querySelector('.pzv-stage').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    const geo = await p.evaluate(() => { const r = document.querySelector('.pzv-box').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
    const a = { x: sr.cx - 60, y: sr.cy - 30 }, b = { x: sr.cx + 60, y: sr.cy + 30 };
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const want = { x: r4((a.x - geo.left) / geo.w), y: r4((a.y - geo.top) / geo.h), w: r4((b.x - a.x) / geo.w), h: r4((b.y - a.y) / geo.h) };
    await drag([[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y], [a.x, a.y + 2]], 6);
    await sleep(400);
    const ring = await p.evaluate((f) => ({ field: !!document.querySelector('.pzv-nf textarea'), frame: document.querySelector('.pzv-fr')?.textContent, v: eval(f)(document.querySelector('.pzv-box video.pzv-vid')), strip: [...document.querySelectorAll('.pzv-th .pk-lt')].map((e) => e.textContent), send: document.querySelector('.pzv-ctl .btn.pri')?.textContent }), VID);
    const clockOf = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    check(N('phone_ring_on_the_frame'), ring.field && ring.frame === EN['pick.frameAt'].replace('{t}', clockOf(c0.v.t)) && ring.v.paused && Math.abs(ring.v.t - c0.v.t) < 0.01 && ring.strip[1] === 'B ✓' && ring.send === 'Send B, with the circle', JSON.stringify(ring));
    await p.fill('.pzv-nf textarea', 'Slower here');
    await sleep(200);
    await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(200);
    await p.screenshot({ path: path.join(OUT, PFX + `phone-note-${th}.png`) });
    await p.evaluate(() => { window.__rvVid = document.querySelector('.pzv-box video.pzv-vid'); });
    await p.click('.pzv-ctl .btn.pri');
    const closed = await until(async () => !(await stillOpen()), 10000);
    // Answered: the screen goes and its video is let go (its source dropped), or the page itself has gone.
    const sentGone = await until(() => p.evaluate(() => { const v = window.__rvVid; return !v ? 'page gone' : v.paused && !v.getAttribute('src') ? 'let go' : null; }).catch(() => 'page gone'), 5000);
    check(N('phone_send_lets_go'), !!sentGone, String(sentGone));
    const got = await until(() => { try { const t = fs.readFileSync(OUTFILE, 'utf8'); return /EXIT/.test(t) ? t : null; } catch { return null; } }, 10000);
    const line = `region ${['x', 'y', 'w', 'h'].map((k) => want[k].toFixed(4)).join(' ')} at ${(Math.round(c0.v.t * 1000) / 1000).toFixed(2)}`;
    // (WebKit's ring is drawn with the mouse, its points a pixel off the touch path's: within 1 %.)
    const near = got && (() => { const m = /region ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) at ([\d.]+)/.exec(got); return m && ['x', 'y', 'w', 'h'].every((k, i) => Math.abs(+m[i + 1] - want[k]) < (E === 'chromium' ? 0.0002 : 0.01)) && Math.abs(+m[5] - c0.v.t) < 0.006; })();
    check(N('phone_send_reaches_agent_with_t'), closed && !!got && /^Take two$/m.test(got) && near && /note Slower here/.test(got) && /EXIT 0/.test(got), `want "${line}"; agent: ${(got || 'nothing').replace(/\n/g, ' / ').slice(-300)}`);
    await ctx.close();
  }
}

// A pick whose videos this engine cannot decode (PICKVIDEO_CANT=webkit with an
// AV1 clip: WebKit on an M1 or M2): ravenry pick said so when the card was
// made; the board's card, its viewer and strip, and the phone board's track
// and viewer show the still that says "This video can't play here", with no
// play mark and no player waiting; the pick is still sent.
async function cantRun(E, N, ID, OUTFILE, stillOpen, FRAME) {
  const PFX = E === 'chromium' ? '' : `${E}-`;
  const WORDS = EN['pick.cantPlay'];
  const told = (() => { try { return fs.readFileSync(OUTFILE, 'utf8'); } catch { return ''; } })();
  check(N('cant_agent_told_when_made'), /ravenry pick: Take one: take-one\.\w+ is AV1 video/.test(told) && told.includes("This video can't play here") && /H\.264 \.mp4/.test(told), told.replace(/\n/g, ' / ').slice(0, 400));
  for (const dark of [true, false]) {
    const th = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    await p.goto(`${hub.url}/`);
    await until(() => p.evaluate((id) => !!document.querySelector(`#list .row[data-id="cp:${id}"]`), ID), 15000);
    await p.click(`#list .row[data-id="cp:${ID}"]`);
    const tiles = await until(() => p.evaluate(([w, f]) => { const t = [...document.querySelectorAll('.pk-tile')]; if (t.length !== 4) return null; const c = [0, 1, 3].map((k) => { const s = t[k].querySelector('.pk-cant'); return s && s.textContent === w && !t[k].querySelector('.pk-play') && !t[k].querySelector('img, video'); }); return c.every(Boolean) && eval(f)(t[2]) ? c : null; }, [WORDS, FRAME]), 30000);
    await sleep(300);
    await p.screenshot({ path: path.join(OUT, PFX + `cant-board-card-${th}.png`) });
    if (!dark) { await ctx.close(); continue; }
    check(N('cant_board_card_stills'), !!tiles, JSON.stringify(tiles));
    await p.click('.pk-tile[data-n="0"]');
    const view = await until(() => p.evaluate((w) => { const c = document.getElementById('gl-cant'), v = document.getElementById('gl-vid'); return c && !c.hidden && c.textContent === w && v.hidden && !v.getAttribute('src') ? { strip: [...document.querySelectorAll('#gl-strip .gl-thumb')].map((b) => (b.querySelector('.pk-cant') ? 'cant' : b.querySelector('img') ? 'img' : 'none')) } : null; }, WORDS), 10000);
    check(N('cant_board_viewer_still'), !!view && view.strip.join() === 'cant,cant,img,cant', JSON.stringify(view));
    await p.screenshot({ path: path.join(OUT, PFX + `cant-board-viewer-${th}.png`) });
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('ArrowRight');
    const pic = await until(() => p.evaluate(() => { const im = document.getElementById('gl-im'); return !im.hidden && document.getElementById('gl-cant').hidden && im.complete && im.naturalWidth === 1280; }), 6000);
    check(N('cant_board_picture_after_still'), !!pic);
    await p.keyboard.press('Escape');
    await ctx.close();
  }
  // The phone board: the track's stills, the viewer's still, the pick sent all the same.
  const PH = `http://127.0.0.1:${PORT}/phone/#/cp/${encodeURIComponent(ID)}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', ...(E === 'chromium' ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  await p.goto(PH);
  const track = await until(() => p.evaluate((w) => { const s = [...document.querySelectorAll('.ptrack .pimg')]; if (s.length !== 4) return null; const c = [0, 1, 3].map((k) => { const x = s[k].querySelector('.pcant'); return !!x && x.textContent === w && !s[k].querySelector('.pk-play'); }); return c.every(Boolean) ? c : null; }, WORDS), 30000);
  check(N('cant_phone_track_stills'), !!track, JSON.stringify(track));
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, PFX + 'cant-phone-track-dark.png') });
  await p.click('.ptrack .pimg[data-n="0"]');
  const pv = await until(() => p.evaluate((w) => { const c = document.querySelector('.pzv-box .pcant'); return c && c.textContent === w && !document.querySelector('video.pzv-vid') ? true : null; }, WORDS), 10000);
  check(N('cant_phone_viewer_still'), !!pv);
  await p.screenshot({ path: path.join(OUT, PFX + 'cant-phone-viewer-dark.png') });
  await p.click('.pzv-th:nth-child(2)');
  await sleep(300);
  await p.click('.pzv-ctl .btn.pri');
  const closed = await until(async () => !(await stillOpen()), 10000);
  const got = await until(() => { try { const t = fs.readFileSync(OUTFILE, 'utf8'); return /EXIT/.test(t) ? t : null; } catch { return null; } }, 10000);
  check(N('cant_phone_pick_sent'), closed && !!got && /^Take two$/m.test(got) && /EXIT 0/.test(got), (got || 'nothing').replace(/\n/g, ' / ').slice(-200));
  await ctx.close();
}
const ENGINES = (process.env.PICKVIDEO_ENGINES || 'chromium,webkit').split(',').filter(Boolean);
// The engines that cannot decode the clips (PICKVIDEO_CANT=webkit, an AV1 clip): the still that says so.
const CANT = new Set((process.env.PICKVIDEO_CANT || '').split(',').filter(Boolean));
const seenPicks = new Set();
let PORT = 0;
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'], env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') } });
  PORT = await freePort();
  serve = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT), '--hub', hub.url], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: WORK } });
  await until(() => fetch(`http://127.0.0.1:${PORT}/phone/`).then((r) => r.ok), 10000);
  for (const E of ENGINES) {
    try { await runEngine(E); } catch (e) { check(`${E}_ran`, false, e.stack || e.message); }
    try { await browser?.close(); } catch { /* gone */ }
    browser = null;
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
