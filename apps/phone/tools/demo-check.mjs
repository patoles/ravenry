#!/usr/bin/env node
// The demo (src/demo.ts) in headless Chromium at a phone's width (360 x 780,
// touch), dark and light, as the shells serve it (tools/serve.mjs --demo:
// no hub anywhere): the bar on every screen, one more screen behind each
// bottom bar item, the live screen full, the question that arrives and is
// answered in its card (the card closes), the command run (running, then
// done) and in a second visit refused, the pick's own screen with B circled
// and a note, the settings, then Pair your Mac out of the demo with nothing
// of the visit left. Every request the pages made is checked: only the
// app's own files and the recording's pictures, nothing the recording did
// not answer (the demo's misses), no other origin.
//
//   node tools/demo-check.mjs [outDir]    (after node build.mjs)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'demo-check'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const results = [];
const check = (name, ok, why = '') => { results.push({ name, ok: !!ok, why }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !why ? '' : `: ${why}`}`); };
async function until(fn, ms = 10000, every = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); }
}

const PORT = await freePort();
const LOG = path.join(OUT, 'requests.jsonl');
const srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--demo', '--port', String(PORT), '--log', LOG], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill(); } catch { /* gone */ } });
const BASE = `http://127.0.0.1:${PORT}`;
await until(() => fetch(BASE + '/phone/left-demo').then((r) => r.ok), 5000);

const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
const browser = await chromium.launch({ headless: true });
const offsite = [];
const misses = [];

async function visit(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => check(`no_page_error_${scheme}`, false, e.message));
  p.on('request', (r) => { if (!r.url().startsWith(BASE + '/') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) offsite.push(r.url()); });
  const keepMisses = async () => { const m = await p.evaluate(() => (window.ravenryDemo ? window.ravenryDemo.misses : [])).catch(() => []); misses.push(...m.map((x) => `${scheme}: ${x}`)); };
  p.on('framenavigated', () => {});
  const shot = (name) => p.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
  const click = async (sel, wait = 700) => { const ok = await p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; }, sel); await sleep(wait); return ok; };
  const bar = () => p.evaluate(() => { const b = document.querySelector('.rv-demo'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, h: r.height, text: b.textContent, onTop: document.elementFromPoint(r.left + 20, r.top + r.height / 2)?.closest('.rv-demo') === b }; });
  const barOk = async (where) => { const b = await bar(); check(`bar_on_${where}_${scheme}`, b && b.top === 0 && b.onTop && /Demo\. Sample projects, nothing leaves this phone\.Pair your Mac/.test(b.text), JSON.stringify(b)); };

  await p.goto(BASE + '/');
  await until(() => p.evaluate(() => document.querySelectorAll('#pchips .pchip').length >= 4), 10000);
  await sleep(800);
  await barOk('board');
  check(`no_mac_controls_${scheme}`, await p.evaluate(() => ![...document.querySelectorAll('[data-act="open"], .cx-chip')].some((e) => e.offsetParent !== null)));
  check(`opens_on_paper_boat_${scheme}`, await p.evaluate(() => document.querySelector('#pchips .pchip.on')?.dataset.id === 'paper-boat'));
  await shot('01-board');

  // Each bottom bar item, then one more screen behind it.
  const more = { ideas: '#sheet [data-idea]', rules: '#sheet [data-rtab="sug"]', ship: '#sheet [data-goto]', pages: '#sheet button' };
  for (const k of ['ideas', 'rules', 'ship', 'pages']) {
    await click(`#bnav [data-pnav="${k}"]`, 1200);
    await barOk(k);
    await shot(`02-${k}`);
    const before = await p.evaluate(() => document.querySelector('#sheet')?.innerText.slice(0, 400));
    const opened = await click(more[k], 1500);
    const after = await p.evaluate(() => document.querySelector('#sheet')?.innerText.slice(0, 400) + '|' + (document.querySelector('#pbar')?.innerText || ''));
    check(`more_behind_${k}_${scheme}`, opened && after !== before, after.slice(0, 120));
    await barOk(`${k}_more`);
    await shot(`03-${k}-more`);
    await p.evaluate(() => window.ravenryBack && window.ravenryBack());
    await sleep(500);
  }
  await click('#bnav [data-pnav="projects"]', 1000);

  // The live screen, full.
  await click('#pchips .pchip[data-id="paper-boat"]', 1200);
  const full = await click('#lv-card [data-act="lv-full"], #lv-card .lv-expand, #lv-card [data-lv-full], #lv-scroll', 1200) && await until(() => p.evaluate(() => { const f = document.querySelector('#lv-fs'); return f && !f.hidden; }), 3000);
  check(`live_screen_full_${scheme}`, full);
  await barOk('live_screen');
  await shot('04-live');
  await p.evaluate(() => window.ravenryBack && window.ravenryBack());
  await sleep(600);

  // The question arrives a few seconds in, and is answered in its card.
  const arrived = await until(() => p.evaluate(() => !!document.querySelector('#pchips .pchip[data-id="notes-app"]') && (window.ravenryDemo?.asked() || false)), 12000);
  check(`question_arrives_${scheme}`, arrived);
  await click('#pchips .pchip[data-id="notes-app"]', 1200);
  const card = await until(() => p.evaluate(() => [...document.querySelectorAll('[data-act="cp-choice"]')].map((b) => b.textContent).join('|')), 4000);
  check(`question_card_${scheme}`, card === 'Ship it|Not yet', card);
  await p.evaluate(() => document.querySelector('[data-act="cp-choice"]').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot('05-question');
  await click('[data-act="cp-choice"][data-k="0"]', 1500);
  check(`question_card_closes_${scheme}`, await until(() => p.evaluate(() => !document.querySelector('[data-act="cp-choice"]')), 4000));
  await shot('06-question-answered');

  // The command: Run (no fingerprint in a browser), running, then done.
  await click('#pchips .pchip[data-id="recipe-box"]', 1200);
  await p.evaluate(() => document.querySelector('[data-act="cp-run"]')?.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot('07-approval');
  check(`approval_card_${scheme}`, await click('[data-act="cp-run"]', 600));
  const ran = await until(() => p.evaluate(() => !document.querySelector('[data-act="cp-run"]') && /Published recipe-box 2\.3\.0/.test(document.querySelector('#lv-lines')?.innerText || '')), 9000);
  check(`approval_runs_then_done_${scheme}`, ran);
  await shot('08-approval-ran');

  // The pick, on the app's own screen.
  await click('#pchips .pchip[data-id="paper-boat"]', 1200);
  await click('[data-act="cp-open"]', 1500);
  await until(() => p.evaluate(() => location.pathname.startsWith('/phone/') && [...document.querySelectorAll('.ptrack img')].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.ptrack img').length === 3), 8000);
  await barOk('pick');
  await shot('09-pick');
  await keepMisses();
  await p.evaluate(() => { const t = document.querySelector('.ptrack'); t.scrollLeft = t.clientWidth; });
  await sleep(700);
  check(`pick_on_b_${scheme}`, /B, 2 of 3/.test(await p.evaluate(() => document.body.innerText)));
  // Circle a part of B: the viewer, one finger around the boat, a note.
  await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Circle a part/.test(x.textContent)); b && b.click(); });
  await sleep(900);
  await barOk('pick_viewer');
  const st = await p.evaluate(() => { const r = document.querySelector('.pzv-stage')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
  if (st) {
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const ring = Array.from({ length: 13 }, (_, i) => [st.x + Math.cos(i / 12 * Math.PI * 2) * 60, st.y + Math.sin(i / 12 * Math.PI * 2) * 40]);
    await touch('touchStart', [ring[0]]);
    for (const pt of ring.slice(1)) await touch('touchMove', [pt]);
    await touch('touchEnd', []);
    await sleep(700);
  }
  const noted = await p.$('.pzv-nf textarea');
  if (noted) await p.fill('.pzv-nf textarea', 'This, but less spray.');
  await shot('10-pick-circled');
  const sendB = await p.evaluate(() => { const b = [...document.querySelectorAll('.pzv button.pri')].find((x) => /Send B/.test(x.textContent)); if (!b) return null; const t = b.textContent; b.click(); return t; });
  check(`pick_b_with_circle_sent_${scheme}`, sendB && /Send B/.test(sendB), String(sendB));
  await until(() => p.evaluate(() => location.pathname === '/' && document.querySelectorAll('#pchips .pchip').length > 0), 6000);
  await sleep(1200);
  check(`pick_card_closes_${scheme}`, await p.evaluate(() => !document.querySelector('[data-act="cp-open"]') && !(window.ravenryDemo?.openCheckpoints() || []).length));
  await shot('11-after-answers');

  // The settings (This phone, in the menu): a sample Mac, Leave the demo.
  await click('#pb-more', 600);
  await click('#pmenu [data-act="pn-app"]', 1500);
  await until(() => p.evaluate(() => location.hash === '#/settings' && /Leave the demo/.test(document.body.innerText)), 5000);
  check(`settings_say_demo_${scheme}`, await p.evaluate(() => /A sample Mac, for the demo/.test(document.body.innerText) && !/Sign out|Paired as/.test(document.body.innerText)));
  await barOk('settings');
  await shot('12-settings');
  await keepMisses();

  // Pair your Mac leaves the demo, and nothing of the visit stays.
  await p.evaluate(() => document.querySelector('.rv-demo button').click());
  const left = await until(() => p.evaluate(() => location.pathname === '/phone/left-demo'), 5000);
  const kept = await p.evaluate(() => Object.keys(sessionStorage).concat(Object.keys(localStorage)));
  check(`pair_your_mac_leaves_${scheme}`, left);
  check(`nothing_kept_${scheme}`, kept.length === 0, kept.join(','));

  // A second visit: the command refused this time.
  await p.goto(BASE + '/');
  await until(() => p.evaluate(() => document.querySelectorAll('#pchips .pchip').length >= 4), 10000);
  check(`second_visit_fresh_${scheme}`, await p.evaluate(() => !!document.querySelector('#pchips .pchip[data-id="recipe-box"]') && Object.keys(window.ravenryDemo.visit.answers).length === 0));
  await click('#pchips .pchip[data-id="recipe-box"]', 1200);
  await click('[data-act="cp-refuse"]', 800);
  // The board asks why (optional) or refuses at once: either way the card closes.
  await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Refuse$/.test(x.textContent.trim()) && x.offsetParent); b && b.click(); });
  check(`approval_refused_${scheme}`, await until(() => p.evaluate(() => !document.querySelector('[data-act="cp-refuse"]') && !/Published recipe-box/.test(document.querySelector('#lv-lines')?.innerText || '')), 5000));
  await keepMisses();
  await ctx.close();
}

try {
  await visit('dark');
  await visit('light');
  check('no_other_origin', offsite.length === 0, offsite.slice(0, 5).join(', '));
  check('recording_answers_every_request', misses.length === 0, misses.join(', '));
  // What the server was asked for: the app's own files and the recording's pictures only.
  const files = JSON.parse(fs.readFileSync(path.join(APP, 'dist', 'demo', 'files.json'), 'utf8'));
  const asked = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const odd = asked.filter((r) => {
    const u = new URL(r.url, 'http://x');
    const p = u.pathname.replace(/^\/phone\/hub\//, '/');
    if (p === '/phone/left-demo' || r.method !== 'GET') return r.method !== 'GET';
    if (p.startsWith('/api/')) { u.searchParams.delete('v'); return !files[p + (u.searchParams.toString() ? '?' + u.searchParams : '')]; }
    return false;
  });
  check('server_asked_for_files_only', odd.length === 0, odd.map((r) => r.url).slice(0, 8).join(', '));
  console.log(`${asked.length} requests, all to the app's own files`);
} finally {
  await browser.close();
  srv.kill();
}
const bad = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - bad.length}/${results.length} passed; pictures in ${OUT}`);
process.exit(bad.length ? 1 : 0);
