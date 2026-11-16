// The way back on a phone (docs/PHONE.md, The way back): walks every screen,
// sheet and modal of the board at phone width and, on each, checks
//   - a visible way out: a full screen has its back arrow at the top left,
//     a sheet its Done or close;
//   - Android's Back (the app calls window.ravenryBack, as apps/phone/src/
//     board.ts does) goes exactly one level up: the layer closes, the screen
//     goes back to its destination, a destination to Projects;
//   - at home, Back leaves the app (ravenryBack says false).
// Then a dialog the board does not know yet: one with a close control closes
// on Back, one without fails (so a new modal with no way back fails here).
// Headless, read-only on the board (it opens and closes, never sends).
//
// Usage: node tools/phone-back-test.mjs --url http://127.0.0.1:4791 [--shots dir]
//   (a demo board: apps/phone/tools/demo.mjs)
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = opt('--url', 'http://127.0.0.1:4791');
const shots = opt('--shots', null);
if (shots) fs.mkdirSync(shots, { recursive: true });

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
// As in the app: window.ravenryApp makes the menu's This phone, and no browser chip.
await p.addInitScript(() => { window.ravenryApp = { openCheckpoint() {}, openSettings() {}, openTailscale() {}, reconnect() {}, platform: 'android', conn: { state: 'up', via: 'wifi', since: Date.now() - 60000, rtt: 12 } }; });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

let pass = 0, fail = 0, n = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what); } };

const go = async (h) => { await p.goto('about:blank'); await p.goto(base + '/' + h); await p.waitForSelector('#pbar .pn-ttl, #pbar [data-act="pn-back"]'); await p.waitForTimeout(900); };
const click = async (s) => { await p.locator(s).first().scrollIntoViewIfNeeded(); await p.click(s); await p.waitForTimeout(600); };
const look = () => p.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const layers = [...document.querySelectorAll('[role="dialog"], [role="menu"], #plan-phone:not(:empty)')].filter((e) => !e.hidden && vis(e));
  const tl = [...document.querySelectorAll('[aria-label^="Back"], [data-act="pn-back"], button, a')].filter((e) => e.matches('[aria-label^="Back"], [data-act="pn-back"]') || /^back$/i.test((e.textContent || '').trim())).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.left < 80 && r.top < 120; });
  const done = [...document.querySelectorAll('.bs-done, [aria-label="Close"], [data-act="pn-menu-close"], [data-lv-close], [data-gl-close]')].filter(vis);
  return { view: (window.ui && window.ui.view) || location.hash, hash: location.hash, layers: layers.map((e) => e.getAttribute('aria-label') || e.id || e.className), backArrow: tl.length > 0, done: done.length > 0, lvFull: !!(history.state && history.state.lvFull), pnav: (document.querySelector('#bnav .pn-d.on') || {}).dataset?.pnav || null, title: (document.querySelector('#pbar .pn-ttl') || {}).textContent || '' };
});
const back = () => p.evaluate(() => { if (history.state && history.state.lvFull) { history.back(); return true; } return window.ravenryBack(); });

/** One row: open it, see its way out, press Back, check where it lands. */
async function row(name, open, { way, after }) {
  n++;
  await open();
  const s = await look();
  if (shots) await p.screenshot({ path: `${shots}/back-${String(n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png` });
  ok(way === 'arrow' ? s.backArrow : way === 'done' ? s.done || s.backArrow : true, `${name}: a visible way out (${way}): ${JSON.stringify(s)}`);
  const r = await back();
  await p.waitForTimeout(700);
  const t = await look();
  const stuck = await p.evaluate(() => window.ravenryBackStuck || 0);
  const good = r === true && stuck === 0 && (await after(t, s));
  ok(good, `${name}: Back goes one level up (returned ${r}): before ${JSON.stringify(s)} after ${JSON.stringify(t)}`);
  console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: ${way}, Back to ${t.layers.length ? 'layer ' + t.layers.join('|') : t.title || t.hash}`);
}
const noLayer = (t) => t.layers.length === 0;
const atProjects = (t) => noLayer(t) && t.pnav === 'projects' && /Ravenry/.test(t.title);
const atPages = (t) => noLayer(t) && t.pnav === 'pages' && t.title === 'Pages';

// home: Back leaves
await go('#portfolio');
ok((await p.evaluate(() => window.ravenryBack())) === false, 'Projects (home): Back leaves the app');
console.log('ok   Projects (home): Back leaves the app');

await row('Idle sheet', async () => { await go('#portfolio'); await click('#pchips [data-idle-open]'); }, { way: 'done', after: (t) => atProjects(t) });
await row('Live screen, full screen', async () => { await go('#portfolio'); await click('#lv-tap'); }, { way: 'arrow', after: (t, s) => s.lvFull && !t.lvFull && atProjects(t) });
await row('Menu', async () => { await go('#portfolio'); await click('#pb-more'); }, { way: 'any', after: (t) => atProjects(t) });
await row('Settings (menu)', async () => { await go('#portfolio'); await click('#pb-more'); await click('#pmenu [data-act="pn-settings"]'); await p.waitForSelector('#hs-pop'); }, { way: 'arrow', after: (t) => atProjects(t) });
ok(await (async () => { await go('#/pages'); return (await p.$('#pn-pages [data-act="pn-settings"]')) === null; })(), 'Settings is not in Pages');
await row('Sessions', async () => { await go('#portfolio'); await click('#memchip-m'); }, { way: 'arrow', after: (t) => atProjects(t) });
await row('Search', async () => { await go('#portfolio'); await click('[data-act="pn-search"]'); }, { way: 'arrow', after: (t) => atProjects(t) });
await row('Pages', async () => { await go('#/pages'); }, { way: 'any', after: (t) => atProjects(t) });
await row('A page', async () => { await go('#/pages'); await click('#pn-pages [data-view^="page/"]'); }, { way: 'arrow', after: (t) => atPages(t) });
await row('Objectives', async () => { await go('#/pages'); await click('#pn-pages [data-view="objectives"]'); }, { way: 'arrow', after: (t) => atPages(t) });
await row('Ideas', async () => { await go('#/ideas'); }, { way: 'any', after: (t) => atProjects(t) });
await row('An idea, open', async () => { await go('#/ideas'); await click('.idea'); }, { way: 'arrow', after: (t) => noLayer(t) && t.pnav === 'ideas' && /Ravenry/.test(t.title) });
await row('Rules', async () => { await go('#/rules'); }, { way: 'any', after: (t) => atProjects(t) });
await row('Rules, Suggested', async () => { await go('#/rules'); await click('[data-rtab="sug"]'); }, { way: 'any', after: async (t) => noLayer(t) && t.pnav === 'rules' && (await p.evaluate(() => !document.querySelector('[data-rtab="sug"].on, [data-rtab="sug"][aria-selected="true"]'))) });
await row('Ship', async () => { await go('#/ship'); }, { way: 'any', after: (t) => atProjects(t) });
await row('New project', async () => { await go('#portfolio'); await click('#pbar [data-act="pn-new"]'); }, { way: 'arrow', after: (t) => atProjects(t) });
await row('Write the brief', async () => { await go('#portfolio'); await click('[data-act="write-brief"]'); }, { way: 'arrow', after: (t) => atProjects(t) });
await row('A plan, full page', async () => { await go('#/plan/garden-planner'); }, { way: 'arrow', after: (t) => atProjects(t) });
await row('New plan', async () => { await go('#garden-planner'); await click('[data-act="plan-new"]'); await p.waitForTimeout(600); }, { way: 'arrow', after: (t) => atProjects(t) });

// A dialog the board does not know yet.
await go('#portfolio');
const fresh = await p.evaluate(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
  d.style.cssText = 'position:fixed;inset:100px 20px;background:#333;z-index:99';
  d.innerHTML = '<button aria-label="Close">x</button>';
  d.querySelector('button').onclick = () => d.remove();
  document.body.appendChild(d);
  const r = window.ravenryBack();
  return r && !d.isConnected;
});
ok(fresh, 'a new dialog with a Close control closes on Back');
const none = await p.evaluate(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.style.cssText = 'position:fixed;inset:100px 20px;background:#333;z-index:99';
  d.textContent = 'no way out';
  document.body.appendChild(d);
  window.ravenryBack();
  d.remove();
  return window.ravenryBackStuck || 0;
});
ok(none === 1, 'a new dialog with no way out is caught (ravenryBackStuck)');
console.log(`${fresh ? 'ok  ' : 'FAIL'} a new dialog closes on Back; ${none === 1 ? 'ok  ' : 'FAIL'} one with no way out is caught`);

ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
await b.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
