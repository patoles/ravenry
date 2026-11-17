#!/usr/bin/env node
// An element marked hidden is never drawn, on every web surface (the
// hiddenclass round, 2026-11-17). A rule like `.gb-im{display:block}` or an
// inline `style="display:flex"` beats the browser's own [hidden] rule, so the
// element stays on screen: a PNG in the gallery showed as a dead video
// (.gb-im), the composer kept an empty band for its file chips (#chips).
// Each base sheet now starts with `[hidden] { display: none !important; }`;
// this sweep checks what the person sees, headless, on a made-up board on a
// throwaway HOME (apps/desktop/tools/demo-hub.mjs, 127.0.0.1):
//
//   board 1440      the hub's board (hub/public) at 1440 x 900
//   board 390       the same at phone width, touch
//   phone 360       the phone board: the hub's board as the app shows it
//                   (window.ravenryApp and the app's layer, apps/phone
//                   dist/board.css), 360 x 780, touch
//   desktop         the Mac app's window (apps/desktop renderer), offscreen,
//                   1440 x 900, through its views
//   site            site/index.html and site/privacy.html at 1440 and 390
//
// On each screen, every element with the hidden attribute must have
// computed display none and a zero box. The one kept on purpose: the
// desktop's #split (the terminals), which stays laid out under the view in
// front, invisible and inert (app.css), so a pane keeps its size; for it the
// sweep checks just that (display not none, a box, visibility hidden,
// pointer-events none).
//
//   node tools/hidden-sweep.mjs [OUT] [--no-build]
//   HIDDEN_ONLY=board,phone,desktop,site picks surfaces.
// Builds apps/desktop and apps/phone first (esbuild) unless --no-build.
// Writes OUT/hidden.json (every screen, its count, what was drawn).
import { guardSpawns } from './test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDemoHub, freePort } from '../apps/desktop/tools/demo-hub.mjs';
import { runApp, stopDaemons } from '../apps/desktop/tools/run-app.mjs';

guardSpawns();
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const NO_BUILD = argv.includes('--no-build');
const OUT = path.resolve(argv.filter((a) => !a.startsWith('--'))[0] || path.join(REPO, '.tmp', 'hidden-sweep'));
const ONLY = (process.env.HIDDEN_ONLY || 'board,phone,desktop,site').split(',');
const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// In the page: every [hidden] element, its display and box. KEEP: ids laid
// out on purpose, reported apart.
const SCAN = `((KEEP) => {
  const label = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; const c = typeof e.className === 'string' ? e.className.trim() : ''; if (c) s += '.' + c.split(/\\s+/).join('.'); return s; };
  const out = { n: 0, drawn: [], kept: [] };
  for (const e of document.querySelectorAll('[hidden]')) {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    const row = { el: label(e), display: cs.display, w: Math.round(r.width), h: Math.round(r.height), visibility: cs.visibility, pointer: cs.pointerEvents };
    if (KEEP.includes(e.id)) { let a = e.parentElement; while (a && getComputedStyle(a).display !== 'none') a = a.parentElement; out.kept.push({ ...row, inShown: !a }); continue; }
    out.n++;
    if (cs.display !== 'none' || r.width || r.height) out.drawn.push(row);
  }
  return out;
})`;
const results = [];
const record = (surface, view, r) => {
  results.push({ surface, view, ...r });
  check(`${surface} ${view}: ${r.n} hidden, none drawn`, !r.drawn.length, r.drawn.map((d) => `${d.el} (display ${d.display}, ${d.w}x${d.h})`).join(' | '));
};

if (!NO_BUILD) {
  if (ONLY.includes('desktop')) execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(REPO, 'apps', 'desktop'), stdio: 'ignore' });
  if (ONLY.includes('phone')) execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(REPO, 'apps', 'phone'), stdio: 'ignore' });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvhid-'));
let hub = null;
let browser = null;
try {
  if (ONLY.some((s) => ['board', 'phone', 'desktop'].includes(s))) {
    hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true, extra: [{ id: 'harbour-map', name: 'harbour-map' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }] });
  }
  if (ONLY.some((s) => ['board', 'phone', 'site'].includes(s))) browser = await chromium.launch({ headless: true });

  // ------------------------------------------------ the board and the phone board
  const clickAny = (...sels) => async (p) => {
    for (const s of sels) if (await p.locator(s).first().isVisible().catch(() => false)) { await p.locator(s).first().click(); return; }
    throw new Error('none of ' + sels.join(', ') + ' to click');
  };
  const waitFor = (sel) => async (p) => { await p.waitForSelector(sel, { timeout: 15000 }); };
  const gear = async (p) => { if (await p.isVisible('#gear')) await p.click('#gear'); else { await p.click('#pb-more'); await p.click('#pmenu [data-act="pn-settings"]'); } await p.waitForSelector('#hs-pop', { timeout: 15000 }); };
  const BOARD_VIEWS = [
    { name: 'projects', q: '#/projects', wait: '#mc' },
    // The project: its live screen, the composer (#chips, #ns-hint, #send-why), timeline, notes.
    { name: 'project', q: '#garden-planner', wait: '#composer' },
    { name: 'project waiting', q: '#paper-boat', wait: '#composer' },
    { name: 'project without session', q: '#harbour-map', wait: '#mc' },
    // The gallery on a picture: the <video> beside it stays hidden (the phonebugs round's dead video).
    { name: 'gallery', q: '#garden-planner', wait: '.picard', steps: [clickAny('.picard'), waitFor('#gl-im')] },
    { name: 'live full screen', q: '#garden-planner', wait: '#lv-card', steps: [clickAny('#lv-exp', '#lv-tap'), waitFor('#lv-fs:not([hidden])')] },
    { name: 'objectives', q: '#/objectives', wait: '#mc' },
    { name: 'ideas', q: '?idea=none#/ideas', wait: '.idea' },
    { name: 'idea open', q: '?idea=demo-tidepool#/ideas', wait: '#i-name' },
    { name: 'rules', q: '#/rules', wait: '#mc' },
    { name: 'ship', q: '#/ship', wait: '#mc' },
    { name: 'sessions', q: '#/sessions', wait: '#sessions-view' },
    { name: 'pages', q: '#/pages', wait: '#mc' },
    { name: 'search', q: '#/search', wait: '#mc' },
    { name: 'plan', q: '#/plan/garden-planner', wait: '#mc' },
    { name: 'new project', q: '?modal=new#/projects', wait: '#modal-form' },
    { name: 'settings', q: '#garden-planner', wait: '#composer', steps: [gear] },
    // (Not in the app: it has its own alert settings.)
    { name: 'phone alerts setup', q: '#garden-planner', wait: '#composer', steps: [gear, clickAny('#pa-btns [data-pa="setup"]'), waitFor('#pa-back .pa-step')], notApp: true },
  ];
  const BOARD_SIZES = [
    { surface: 'board 1440', vp: { width: 1440, height: 900 }, phone: false },
    { surface: 'board 390', vp: { width: 390, height: 844 }, phone: false, mobile: true },
    { surface: 'phone 360', vp: { width: 360, height: 780 }, phone: true, mobile: true },
  ].filter((s) => ONLY.includes(s.phone ? 'phone' : 'board'));
  const boardCss = path.join(REPO, 'apps', 'phone', 'dist', 'board.css');
  for (const sz of BOARD_SIZES) {
    for (const v of BOARD_VIEWS.filter((x) => !(sz.phone && x.notApp))) {
      const ctx = await browser.newContext({ viewport: sz.vp, colorScheme: 'dark', ...(sz.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      if (sz.phone) {
        // As the app draws it (apps/phone/src/board.ts): its window.ravenryApp and its layer, board.css.
        await ctx.route('**/phone/board.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(boardCss, 'utf8') }));
        await p.addInitScript(() => {
          window.ravenryApp = { openCheckpoint() {}, openSettings() {}, openTailscale() {}, reconnect() {}, platform: 'android', conn: { state: 'up', via: 'wifi', since: Date.now() - 60000, rtt: 12 } };
          document.addEventListener('DOMContentLoaded', () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/phone/board.css'; document.head.appendChild(l); });
        });
      }
      try {
        await p.goto(hub.url + '/' + v.q);
        await p.waitForSelector(v.wait, { timeout: 15000 });
        await p.waitForTimeout(800);
        for (const s of v.steps || []) await s(p);
        await p.waitForTimeout(600);
        record(sz.surface, v.name, await p.evaluate(`${SCAN}([])`));
      } catch (e) {
        check(`${sz.surface} ${v.name}: opens`, false, String(e.message || e).split('\n')[0]);
      }
      if (errors.length) check(`${sz.surface} ${v.name}: no page errors`, false, errors.join(' | '));
      await ctx.close();
    }
  }

  // ------------------------------------------------ the site
  if (ONLY.includes('site')) {
    for (const page of ['index.html', 'privacy.html']) {
      for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
        const p = await ctx.newPage();
        await p.goto(pathToFileURL(path.join(REPO, 'site', page)).href);
        await p.waitForTimeout(400);
        record(`site ${vp.width}`, page, await p.evaluate(`${SCAN}([])`));
        await ctx.close();
      }
    }
  }

  // ------------------------------------------------ the desktop window
  if (ONLY.includes('desktop')) {
    const st = await hub.state();
    const sess = st.projects.find((x) => x.sessions && x.sessions.length && x.brief);
    const key = `${sess.id}/${sess.sessions[0].surfaceId}`;
    const R = 'window.__ravenry';
    const VIEWS = [
      { name: 'a shell', go: `(() => { const t = ${R}.S.tabs.find((x) => x.kind === 'shell'); ${R}.setView({ kind: 'tab', id: t.id }); return true; })()` },
      { name: 'a session with its panel', go: `${R}.pickSession(${JSON.stringify(key)}), true` },
      { name: 'a project with no session', go: `${R}.setView({ kind: 'project', id: 'harbour-map' }), true` },
      { name: 'a project with an earlier conversation', go: `${R}.setView({ kind: 'project', id: 'lighthouse' }), true` },
      { name: 'the brief', go: `${R}.setView({ kind: 'brief', key: ${JSON.stringify(key)}, project: ${JSON.stringify(sess.id)} }), true` },
      { name: 'Decisions', go: `${R}.setView({ kind: 'decisions' }), true` },
      { name: 'Machines', go: `${R}.setView({ kind: 'machines' }), true` },
      { name: 'Start', go: `${R}.onCommand('new-session'), true` },
      { name: 'Learn Ravenry', go: `${R}.onCommand('learn'), true` },
      { pages: true },
      ...[
        ['Gallery', { kind: 'gallery', project: sess.id, at: null, lit: 0 }],
        ['One picture, large', { kind: 'gallery', project: sess.id, at: 0 }],
        ['A plan', { kind: 'plan', project: sess.id, title: null }],
        ['A new plan', { kind: 'newplan', project: 'paper-boat' }],
        ['An idea\'s thread', { kind: 'idea', id: 'demo-tidepool' }],
        ['Alerts', { kind: 'alerts' }],
      ].map(([name, v]) => ({ name, go: `${R}.setView(${JSON.stringify({ ...v, back: { kind: 'decisions' } })}), true` })),
      // Back to a session: the terminals in front again, after the views hid them.
      { name: 'a session again', go: `${R}.pickSession(${JSON.stringify(key)}), true` },
    ];
    const outFile = path.join(root, 'desktop.json');
    const MAIN = String.raw`
const js = (x) => win.webContents.executeJavaScript(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageKeys = await js("(window.__ravenry.S.hub.pages || []).map((p) => p.key)");
const views = VIEWS.flatMap((v) => (v.pages ? pageKeys.map((k) => ({ name: 'page: ' + k, go: 'window.__ravenry.openPage(' + JSON.stringify(k) + '), true' })) : [v]));
const out = [];
for (const v of views) {
  try { await js(v.go); } catch (e) { out.push({ view: v.name, error: String(e.message || e) }); continue; }
  await sleep(1000);
  out.push({ view: v.name, ...(await js(SCAN + "(['split'])")) });
}
return out;
`;
    const appHome = path.join(root, 'apphome');
    const work = path.join(root, 'w');
    const rt = path.join(root, 'r');
    fs.mkdirSync(appHome, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
    try {
      await runApp({
        name: 'hidden', work, rt, bin: BIN, home: appHome, hubUrl: hub.url, timeoutMs: 300000,
        env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: path.join(root, 'open.jsonl') }, width: 1440, height: 900,
        steps: [
          { ready: true },
          { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2 && ${R}.term().attached`, timeout: 30000 },
          { sleep: 1500 },
          { main: `const VIEWS = ${JSON.stringify(VIEWS)}; const SCAN = ${JSON.stringify(SCAN)};\n${MAIN}`, out: outFile },
        ],
      });
    } finally {
      stopDaemons(BIN, rt);
    }
    const rows = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    for (const r of rows) {
      if (r.error) { check(`desktop ${r.view}: opens`, false, r.error); continue; }
      record('desktop', r.view, r);
      // The terminals, hidden under another view, stay laid out (a pane keeps
      // its size; a box only while the middle shows) and never show or take a click.
      for (const k of r.kept) check(`desktop ${r.view}: ${k.el} hidden stays laid out, invisible and inert`, k.display !== 'none' && (!k.inShown || (k.w > 0 && k.h > 0)) && k.visibility === 'hidden' && k.pointer === 'none', JSON.stringify(k));
    }
    check('desktop: the views include one with the terminals hidden and laid out', rows.some((r) => r.kept && r.kept.some((k) => k.inShown && k.w > 0 && k.h > 0)));
  }
} catch (e) {
  check('the sweep ran', false, String(e.stack || e).slice(0, 2000));
} finally {
  if (browser) await browser.close();
  if (hub) hub.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

fs.writeFileSync(path.join(OUT, 'hidden.json'), JSON.stringify(results, null, 2) + '\n');
const screens = results.length;
const seen = results.reduce((a, r) => a + r.n, 0);
const drawn = results.reduce((a, r) => a + r.drawn.length, 0);
console.log(`\n${screens} screens, ${seen} hidden elements checked, ${drawn} drawn; ${path.join(OUT, 'hidden.json')}`);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
