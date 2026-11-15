#!/usr/bin/env node
// Where the hub's browser board opens (server/openon.mjs, hub/public/app.js
// applyOpenOn; docs/FEATURES.md NAV-009), headless, on the demo board
// (apps/desktop/tools/demo-hub.mjs, 127.0.0.1, a throwaway home) shaped like
// the person's: weather-widget waits on the designer since three days and is
// first in the list, above the projects in use; notes-app is the session
// typed to last. Each check reads the project the board shows (the row or
// chip it marks current) and what it told the hub (POST /api/opened).
//
// The Mac's browser (1273 wide):
//   1. a fresh load with this browser's pick from three days ago kept
//      (localStorage and the #weather-widget its page was left on) opens on
//      notes-app, typed to last;
//   2. reloaded: notes-app again;
//   3. a click on recipe-box: the hub's openOn follows (opened, browser);
//      reloaded on #recipe-box: recipe-box;
//   4. the person types to garden-planner elsewhere: a reload of the page
//      still on #recipe-box opens on garden-planner;
//   5. a link to a project (#paper-boat, a fresh tab) still wins.
// The phone board (390 wide, the app's WebView as a page):
//   6. a fresh load with its own pick from days ago: the chip of the
//      project typed to last;
//   7. a tap on a chip (weather-widget), then the person types to
//      recipe-box on the Mac; the app goes to the background for over a
//      minute and comes back: recipe-box. Back after a few seconds only:
//      it stays where it was;
//   8. an alert tapped (the shell sets #<project>/<session>): that project wins.
// Never touches the board on :4600.
//
// Usage: node tools/openon-board-test.mjs [--hub-dir DIR] [--shots DIR]
//   --hub-dir: another hub folder to run (an older tree's, to see the checks fail there).
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'openon-board-test');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; };
const SHOTS = arg('--shots');
const HUB_DIR = arg('--hub-dir');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS3 = Date.now() - 3 * 24 * 3600000;

const waitFirst = ({ MC }) => {
  const f = path.join(MC, 'projects.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const w = j.projects.find((p) => p.id === 'weather-widget');
  w.waitingOn = 'the designer';
  j.projects = [w, ...j.projects.filter((p) => p !== w)];
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
};
const hub = await startDemoHub({ dir: T, port: await freePort(), prepare: waitFirst, ...(HUB_DIR ? { hubDir: HUB_DIR } : {}) });
const SIDS = { 'garden-planner': ['a1a1a1a1-0000-4000-8000-000000000001', 'ws-1', 'sf-1'], 'recipe-box': ['d4d4d4d4-0000-4000-8000-000000000004', 'ws-2', 'sf-2'] };
// The person types to a project's session in its terminal: its transcript and its hook event.
const typeTo = (id, text) => {
  const [sid, ws, sf] = SIDS[id];
  const tr = hub.transcript(id);
  const at = new Date().toISOString();
  const cwd = path.join(hub.root, id);
  fs.appendFileSync(tr, JSON.stringify({ type: 'user', cwd, sessionId: sid, timestamp: at, message: { role: 'user', content: text } }) + '\n');
  fs.appendFileSync(path.join(hub.home, '.ravenry', 'events', sid + '.jsonl'), JSON.stringify({ at, event: 'UserPromptSubmit', session_id: sid, cwd, transcript_path: tr, workspace_id: ws, surface_id: sf }) + '\n');
};
const openOnIs = async (id, ms = 15000) => {
  let o = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) { o = (await hub.state()).openOn; if (o && o.projectId === id) return o; }
  return o;
};
// The project the board shows: the row (or the phone's chip) it marks current.
const shown = async (pg, sel = '#list [aria-current="true"][data-id]') => {
  try { await pg.waitForSelector(sel, { timeout: 10000 }); } catch { return null; }
  await sleep(400);
  return pg.$eval(sel, (e) => e.dataset.id).catch(() => null);
};
// This browser's state from three days ago: its pick and the old key, and the page left on that project.
const stale = (ctx, id) => ctx.addInitScript(([pid, at]) => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  localStorage.setItem('mc.sel', JSON.stringify(pid));
  localStorage.setItem('mc.pick', JSON.stringify({ id: pid, at }));
}, [id, DAYS3]);
const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, name) }); };

let browser = null;
try {
  const o0 = await openOnIs('notes-app');
  check('hub: openOn is notes-app (typed to last), weather-widget first in the list', o0 && o0.projectId === 'notes-app' && (await hub.state()).projects[0].id === 'weather-widget', o0);
  browser = await chromium.launch();

  // --- the Mac's browser
  const ctx = await browser.newContext({ viewport: { width: 1273, height: 900 } });
  await stale(ctx, 'weather-widget');
  const pg = await ctx.newPage();
  const opened = [];
  pg.on('request', (r) => { if (r.url().endsWith('/api/opened')) opened.push(r.postDataJSON()); });
  await pg.goto(`${hub.url}/#weather-widget`);
  let id = await shown(pg);
  check('browser, fresh load, its pick from three days ago kept: opens on notes-app, typed to last', id === 'notes-app', id);
  await shot(pg, 'board-fresh-load.png');
  check('browser: a load tells the hub nothing (no POST /api/opened)', opened.length === 0, opened);
  await pg.reload();
  id = await shown(pg);
  check('browser, reload: notes-app again', id === 'notes-app', id);

  await pg.click('#list .row[data-id="recipe-box"]');
  const o1 = await openOnIs('recipe-box');
  check('browser: a click on recipe-box tells the hub (opened, browser)', o1 && o1.projectId === 'recipe-box' && o1.why === 'opened' && o1.device === 'browser' && opened.some((b) => b.projectId === 'recipe-box'), o1);
  await pg.reload();
  id = await shown(pg);
  check('browser, reload after that click: recipe-box', id === 'recipe-box' && pg.url().endsWith('#recipe-box'), `${id} at ${pg.url()}`);

  await sleep(1100);
  typeTo('garden-planner', 'A week before sowing.');
  const o2 = await openOnIs('garden-planner');
  check('hub: the person typed to garden-planner elsewhere', o2 && o2.projectId === 'garden-planner' && o2.why === 'typed', o2);
  await pg.reload();
  id = await shown(pg);
  check('browser, reload of the page still on #recipe-box: opens on garden-planner', id === 'garden-planner', `${id} at ${pg.url()}`);
  await shot(pg, 'board-reload-after-typed.png');

  const ctxL = await browser.newContext({ viewport: { width: 1273, height: 900 } });
  const pgL = await ctxL.newPage();
  await pgL.goto(`${hub.url}/#paper-boat`);
  id = await shown(pgL);
  check('browser: a link to a project (#paper-boat) still wins', id === 'paper-boat', id);
  await ctxL.close();
  await ctx.close();

  // --- the phone board
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await stale(ph, 'weather-widget');
  const pp = await ph.newPage();
  await pp.clock.install();
  await pp.goto(hub.url + '/');
  const chip = '#pchips [aria-current="true"][data-id]';
  const o3 = (await hub.state()).openOn || {};
  id = await shown(pp, chip);
  check('phone at 390, fresh load with its pick from days ago: the chip of the project used last', id === o3.projectId && id !== 'weather-widget', `${id}, openOn ${o3.projectId}`);
  await shot(pp, 'phone-fresh-load.png');

  await pp.tap('#pchips [data-id="weather-widget"]');
  await openOnIs('weather-widget');
  id = await shown(pp, chip);
  check('phone: a tap on weather-widget shows it', id === 'weather-widget', id);
  await sleep(1100);
  typeTo('recipe-box', 'Keep it.');
  await openOnIs('recipe-box');
  await sleep(1500); // the board's stream has the new state
  const away = async (ms) => {
    await pp.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await pp.clock.fastForward(ms);
    await pp.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  };
  await away(5000);
  id = await shown(pp, chip);
  check('phone: back in front after 5 s: stays on weather-widget', id === 'weather-widget', id);
  await away(90000);
  id = await shown(pp, chip);
  check('phone: back in front after 90 s, the person typed to recipe-box on the Mac since: recipe-box', id === 'recipe-box', id);
  await shot(pp, 'phone-back-in-front.png');

  await pp.evaluate(() => { location.hash = '#garden-planner/sf-1'; });
  id = await shown(pp, chip);
  check('phone: an alert tapped (#garden-planner/sf-1) wins', id === 'garden-planner', id);
  await ph.close();
} finally {
  if (browser) await browser.close();
  hub.stop();
}
console.log(`\n${fails ? `${fails} failed` : 'all passed'} (${passes} passed)`);
process.exit(fails ? 1 : 0);
