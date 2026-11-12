#!/usr/bin/env node
// The hand-off on the hub's browser board (Hand-backs), on a real hub: the
// demo board (apps/desktop/tools/demo-hub.mjs, 127.0.0.1, a throwaway home)
// with a long entry written into garden-planner's brief as a session would,
// its first sentence only naming a session. Checks the hub's state (the
// timeline's text is the line from server/handoffline.mjs, its full the
// whole entry), then the board headless at a desktop and a phone width:
// the row draws the line in at most two lines, cut at a word, with "›"; a press shows the
// entry whole (the board has no brief page), a second press its line again;
// Enter does the same from the keyboard. Never touches the board on :4600.
//
// Usage: node tools/handoff-card-board-test.mjs [--shots <dir>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';
import { LONG } from './fixtures/handoff-long.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'handoff-card-board-test');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = await startDemoHub({ dir: T, port: await freePort() });
let browser = null;
try {
  const bf = path.join(hub.root, 'garden-planner', 'BRIEF.md');
  fs.writeFileSync(bf, fs.readFileSync(bf, 'utf8').replace('## Hand-off\n', `## Hand-off\n- 2026-11-12 00:45 ${LONG}\n  - State: the card test's entry\n`));
  let ho = null;
  for (let i = 0; i < 100 && !(ho && ho.full && ho.full.length > 1000); i++) { const st = await hub.state(); ho = (st.projects.find((p) => p.id === 'garden-planner')?.timeline || []).find((x) => x.from === 'brief'); if (!(ho && ho.full && ho.full.length > 1000)) await sleep(200); }
  check('hub state: the line skips "Session <id> (<name>) is main." and is short', !!ho && ho.text.startsWith('Native 0.1.37+00eedd8 INSTALLED 00:39') && ho.text.length <= 120 && ho.text.endsWith('…') && !/25204b9f|ravenry-1d/.test(ho.text), ho && ho.text);
  check('hub state: the whole entry in full', !!ho && ho.full.startsWith('Session 25204b9f (ravenry-1d) is main.') && ho.full.length > 1700, ho && ho.full.length);

  browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1273, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.goto(`${hub.url}/?theme=dark#garden-planner`);
    await pg.waitForSelector('#d-timeline .ho-r', { timeout: 15000 });
    const row = () => pg.evaluate(() => { const r = document.querySelector('#d-timeline .ho-r'); if (!r) return null; const l = r.querySelector('.ho-line'); const lh = parseFloat(getComputedStyle(l).lineHeight);
      return { text: l.textContent, lines: Math.round(l.getBoundingClientRect().height / lh), open: r.classList.contains('open'), expanded: r.getAttribute('aria-expanded'), chev: r.querySelector('.ho-chev')?.textContent, cursor: getComputedStyle(r).cursor, role: r.getAttribute('role') }; });
    const a = await row();
    const atWord = (x) => !!x && (x.text === ho.text || (x.text.endsWith('…') && ho.text.startsWith(x.text.slice(0, -1)) && /[\s,;:)…]/.test(ho.text[x.text.length - 1])));
    check(`${name}: the row draws the hub's line in at most two lines, cut at a word, "›" after it, a button`, !!a && atWord(a) && a.lines >= 1 && a.lines <= 2 && a.chev === '›' && a.cursor === 'pointer' && a.role === 'button' && a.expanded === 'false', a);
    await pg.locator('#d-timeline').scrollIntoViewIfNeeded();
    if (SHOTS) await pg.locator('#d-timeline').screenshot({ path: path.join(SHOTS, `board-handoff-${name}.png`) });
    await pg.click('#d-timeline .ho-r');
    await sleep(300);
    const b = await row();
    check(`${name}: a press shows the entry whole`, !!b && b.open && b.expanded === 'true' && b.text === ho.full && b.lines > 2, b && { lines: b.lines, open: b.open, length: b.text.length });
    if (SHOTS) await pg.locator('#d-timeline').screenshot({ path: path.join(SHOTS, `board-handoff-${name}-whole.png`) });
    await pg.click('#d-timeline .ho-r');
    await sleep(300);
    const c = await row();
    check(`${name}: a second press, its line again`, !!c && !c.open && atWord(c) && c.lines <= 2, c);
    await pg.focus('#d-timeline .ho-r');
    await pg.keyboard.press('Enter');
    await sleep(300);
    const d = await row();
    check(`${name}: Enter on the row shows it whole`, !!d && d.open && d.text === ho.full, d && { open: d.open });
    await ctx.close();
  }
} catch (e) {
  check('the test ran', false, String(e.stack || e).slice(0, 1500));
} finally {
  if (browser) await browser.close();
  hub.stop();
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
