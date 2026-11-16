#!/usr/bin/env node
// A pick's videos play one at a time (the pickvideo round's fourth part,
// 2026-11-16: on the person's iPad the video left did not pause, and the
// other one, then the first again, loaded for ever). Headless, Chromium and
// WebKit, against a made-up board on a throwaway HOME (127.0.0.1) where a
// plain shell pane in no project waits on a real `ravenry pick` of two
// videos, the 30 s and 15 s cuts (docs/media, or PICKVIDEO_CLIP and
// PICKVIDEO_CLIP2), as on the person's iPad.
//
// Every video element a page makes or plays is kept and read (a script run
// before the page's own): after each change, the one come to plays (its time
// moves on) and every other is paused, its time still, and no more than one
// element holds a video at all (the others let theirs go). On each surface
// that draws a pick up close:
//
//   the board (1440 x 900): the card's tiles, the viewer on the first, Next
//   and Previous five times back and forth, Esc (nothing plays on), the
//   viewer again on the second;
//   the board at a phone's width (390, touch): the same with its strip;
//   the phone board (390, touch; the Android, iPhone and iPad apps' pick
//   screen): its full screen on the first, the strip to the other and back
//   five times, closed, opened again on the second; at the end the agent
//   withdraws the card while it plays: nothing plays on or holds a video.
//
// The thumbnails (the card's tiles, the strips, the swipe track) show each
// video's first frame without a player of their own (a picture drawn once).
//
//   node tools/pickswitch-check.mjs [OUT]     (after node build.mjs)
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
const OUT = path.resolve(args[0] || path.join(APP_DIR, '.tmp', 'pickswitch-check'));
const WORK = path.join(APP_DIR, '.tmp', 'pickswitch-work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const ROUNDS = Number(process.env.PICKSWITCH_ROUNDS || 5);
const ENGINES = (process.env.PICKSWITCH_ENGINES || 'chromium,webkit').split(',');
const pw = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvw-'));
fs.chmodSync(RT, 0o700);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 15000, every = 150) {
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

const media = path.join(REPO, 'docs', 'media');
const made = (name, src) => { const f = path.join(WORK, name); fs.copyFileSync(src, f); return f; };
const CLIP = made('ravenry-30s.mp4', process.env.PICKVIDEO_CLIP || path.join(media, 'ravenry-30s.mp4'));
const CLIP2 = made('ravenry-15s.mp4', process.env.PICKVIDEO_CLIP2 || path.join(media, 'ravenry-15s.mp4'));
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

// Before the page's own scripts: every video element made or played is kept, to be read.
const TRACK = () => {
  window.__pv = new Set();
  const p = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { window.__pv.add(this); return p.apply(this, a); };
  const scan = () => { for (const v of document.querySelectorAll('video')) window.__pv.add(v); };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
};
// What each thumbnail shows: a picture (its first frame drawn), a video element (a player of its own), or nothing yet.
const THUMBS = (sel) => [...document.querySelectorAll(sel)].map((x) => { const i = x.querySelector('img'); return x.querySelector('video') ? 'video' : i && i.complete && i.naturalWidth > 0 ? 'picture' : 'none'; });
// Each element: its variant, time, whether it plays, whether it holds a video at all, whether it is the one up close.
const READ = (cur) => [...window.__pv].map((v) => ({
  n: ((v.currentSrc || v.getAttribute('src') || '').match(/variants\/(\d)/) || [])[1] || '-',
  t: Math.round(v.currentTime * 100) / 100, paused: v.paused, rs: v.readyState, holds: !!v.getAttribute('src') && v.networkState !== 0, live: v.isConnected, cur: v === document.querySelector(cur),
}));

// ------------------------------------------------------------ the board
const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
let hub = null, serve = null;
const browsers = [];
const OUTFILE = path.join(WORK, 'pick.out');
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'], env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') } });
  const script = path.join(WORK, 'shell.sh');
  fs.writeFileSync(script, [`'${BIN}' pick ${q('Which cut should I keep?')} --variant ${q(`30s=${CLIP}`)} --variant ${q(`15s=${CLIP2}`)} --timeout 30m >${q(OUTFILE)} 2>&1`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  const loose = path.join(WORK, 'scratch');
  fs.mkdirSync(loose, { recursive: true });
  const PANE = execFileSync(BIN, ['new', '--cwd', loose, '--name', 'Video test', '--size', '90x30', '--', '/bin/sh', script], { env: localEnv, encoding: 'utf8' }).trim().split(/\s+/)[0];
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.variants && c.variants.length === 2 && c.variants.every((v) => v.video) && c.pick_record && c.pick_record.variants.every((v) => v.kept)) || null; }, 60000);
  check('pick_of_two_videos', !!cp, cp ? `${cp.id}: ${cp.variants.map((v) => v.video).join(', ')}` : 'no open pick of two videos');
  if (!cp) throw new Error('no pick');
  const ID = cp.id;

  const PORT = await freePort();
  serve = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT), '--hub', hub.url], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: WORK } });
  await until(() => fetch(`http://127.0.0.1:${PORT}/phone/`).then((r) => r.ok), 10000);

  // One surface: open on the first, to the other and back ROUNDS times, closed, opened on the second.
  async function surface(p, tag, cur, act) {
    const all = () => p.evaluate(READ, cur);
    const playing = (l) => l.filter((x) => !x.paused && x.n !== '-');
    let ok = true;
    const came = async (n, label) => {
      const t0 = Date.now();
      let s0 = null;
      const started = await until(async () => { s0 = await all(); return s0.some((x) => x.cur && x.n === String(n) && !x.paused && x.t > 0.05) ? s0 : null; }, 25000);
      const wait = ((Date.now() - t0) / 1000).toFixed(1);
      await sleep(1500);
      const s1 = await all();
      const curT = (l) => (l || []).find((x) => x.cur)?.t ?? -1;
      const moved = !!started && curT(s1) > curT(s0) + 0.7;
      const others = s1.map((x, k) => ({ x, k })).filter(({ x }) => !x.cur);
      const still = others.every(({ x, k }) => x.paused && (!s0 || !s0[k] || Math.abs(x.t - s0[k].t) <= 0.05));
      const holding = s1.filter((x) => x.holds && x.n !== '-').length;
      const good = moved && still && playing(s1).length === 1 && holding === 1;
      if (!good) ok = false;
      check(`${tag}_${label}`, good, `${started ? `played after ${wait} s` : `NOT playing after ${wait} s`}, its time ${curT(s0)} to ${curT(s1)}, the others still ${still}, playing ${playing(s1).length}, holding a video ${holding}; ${JSON.stringify(s1)}`);
      return good;
    };
    await act.open(0);
    await came(0, 'open_on_the_first');
    for (let r = 1; r <= ROUNDS; r++) {
      await act.go(1);
      await came(1, `round${r}_to_the_second`);
      await act.go(0);
      await came(0, `round${r}_back_to_the_first`);
    }
    await act.close();
    let cl = null;
    const quiet = await until(async () => { cl = await all(); return playing(cl).length === 0 && cl.filter((x) => x.holds && x.n !== '-').length === 0; }, 5000);
    check(`${tag}_closed_nothing_plays_or_holds`, !!quiet, JSON.stringify(cl));
    await act.open(1);
    await came(1, 'opened_again_on_the_second');
    await act.close();
    // The thumbnails: each video's first frame, drawn once, with no player of their own.
    return ok;
  }

  for (const engine of ENGINES) {
    const browser = await pw[engine].launch({ headless: true });
    browsers.push(browser);
    // ---------------------------------------------------------- the board, wide and at a phone's width
    for (const [w, h, tag] of [[1440, 900, 'board'], [390, 844, 'board390']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', ...(w < 500 ? { hasTouch: true, isMobile: engine === 'chromium' } : {}) });
      await ctx.addInitScript(TRACK);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => check(`${engine}_${tag}_no_page_error`, false, e.message));
      await p.goto(`${hub.url}/#cp:${ID}`);
      const opened = await until(() => p.evaluate((id) => {
        if (document.querySelectorAll('.pk-tile').length === 2) return true;
        const r = document.querySelector(`#list .row[data-id="cp:${id}"]`) || document.querySelector(`#pchips .pchip[data-id="cp:${id}"]`);
        if (r) r.click();
        return false;
      }, ID), 20000);
      check(`${engine}_${tag}_card_tiles`, !!opened);
      // Each tile's first frame comes as a picture (a player of its own shows over it only while it draws).
      const tiles = await until(async () => { const t = await p.evaluate(THUMBS, '.pk-tile'); return t.length === 2 && t.every((x) => x === 'picture') ? t : null; }, 20000) || await p.evaluate(THUMBS, '.pk-tile');
      check(`${engine}_${tag}_tiles_first_frames_without_a_player`, !!tiles && tiles.every((x) => x === 'picture'), JSON.stringify(tiles));
      await surface(p, `${engine}_${tag}`, '#gl-vid', {
        open: (n) => p.evaluate((k) => document.querySelector(`.pk-tile[data-n="${k}"]`).click(), n),
        go: (n) => p.evaluate((k) => document.querySelector(`#gl-strip [data-gl-go="${k}"]`).click(), n),
        close: () => p.evaluate(() => document.querySelector('[data-gl-close]').click()),
      });
      await ctx.close();
    }
    // ---------------------------------------------------------- the phone board (the apps' pick screen)
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, ...(engine === 'chromium' ? { isMobile: true } : {}) });
      await ctx.addInitScript(TRACK);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => check(`${engine}_phone_no_page_error`, false, e.message));
      await p.goto(`http://127.0.0.1:${PORT}/phone/#/cp/${encodeURIComponent(ID)}`);
      const track = await until(async () => { const t = await p.evaluate(THUMBS, '.ptrack .pimg'); return t.length === 2 && t.every((x) => x === 'picture') ? t : null; }, 25000) || await p.evaluate(THUMBS, '.ptrack .pimg');
      check(`${engine}_phone_track_first_frames_without_a_player`, !!track && track.every((x) => x === 'picture'), JSON.stringify(track));
      await surface(p, `${engine}_phone`, '.pzv-box video.pzv-vid', {
        open: (n) => p.evaluate((k) => document.querySelector(`.ptrack .pimg[data-n="${k}"]`).click(), n),
        go: (n) => p.evaluate((k) => document.querySelectorAll('.pzv-th')[k].click(), n),
        close: () => p.evaluate(() => document.querySelector('.pzv-bar .icon-btn').click()),
      });
      const strip = await p.evaluate(() => [...document.querySelectorAll('.ptrack .pimg')].map((x) => (x.querySelector('video') ? 'video' : x.querySelector('img') ? 'picture' : 'none')));
      check(`${engine}_phone_track_after_still_pictures`, strip.every((x) => x === 'picture'), JSON.stringify(strip));
      await p.screenshot({ path: path.join(OUT, `${engine}-phone-track.png`) });
      // The card leaving (the last engine only: the agent withdraws it) while the full screen plays the second: the
      // screen says so, on the same page, and its video stops and lets go.
      if (engine === ENGINES[ENGINES.length - 1]) {
        await p.evaluate(() => document.querySelector('.ptrack .pimg[data-n="1"]').click());
        const on = await until(() => p.evaluate(() => { const v = document.querySelector('.pzv-box video.pzv-vid'); if (!v || v.paused || v.currentTime < 0.2) return false; window.__cur = v; window.__stay = 1; return true; }), 20000);
        execFileSync(BIN, ['checkpoint', ID, '--cancel', '--reason', 'withdrawn by the check'], { env: { ...localEnv, RAVENRY_PANE: PANE }, stdio: 'ignore' });
        const left = await until(async () => !((await hub.state()).checkpoints || []).some((c) => c.id === ID && c.state === 'open'), 10000);
        let after = null;
        const gone = await until(async () => { after = await p.evaluate((r) => ({ same: window.__stay === 1, viewer: !!document.querySelector('.pzv'), player: window.__cur ? { paused: window.__cur.paused, holds: !!window.__cur.getAttribute('src') && window.__cur.networkState !== 0 } : null, all: eval(r)('.pzv-box video.pzv-vid') }), `(${READ})`); return after.same && !after.viewer && after.player && after.player.paused && !after.player.holds && after.all.every((x) => x.paused && !x.holds) ? after : null; }, 6000);
        check(`${engine}_phone_card_withdrawn_its_video_stops_and_lets_go`, !!on && !!left && !!gone, `playing before ${!!on}, withdrawn ${!!left}; ${JSON.stringify(after)}`);
      }
      await ctx.close();
    }
  }
} catch (e) {
  check('ran', false, e.stack || e.message);
} finally {
  for (const b of browsers) { try { await b.close(); } catch { /* gone */ } }
  serve?.kill();
  hub?.stop();
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
  if (!process.env.PICKVIDEO_KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
fs.writeFileSync(path.join(OUT, 'pickswitch-check.json'), JSON.stringify({ failed, checks: results }, null, 1));
console.log(`pickswitch-check: ${results.length} checks, ${failed} failed; in ${OUT}`);
process.exit(failed ? 1 : 0);
