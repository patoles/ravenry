#!/usr/bin/env node
// Suggested answers and the model on the hub's browser board, desktop and
// phone width, headless, on a real hub: the demo board
// (apps/desktop/tools/demo-hub.mjs, 127.0.0.1, a throwaway home), with
// paper-boat handing back the real "B, C, or keep A?" message of the
// pictures round (tools/fixtures/answers/handback-1.txt).
//
// - The card shows the message's options as buttons, B (recommended) first;
//   a press types exactly the key ("Keep A") into the session (the
//   prompt the stand-in cmux plays, through POST /api/send), and the card says it was sent.
// - The Live screen's tag says the assistant and its model ("Claude Opus
//   5.5"), the Sessions card's tag the model ("Opus 5.5").
// - New sessions' Model beside the Claude / Codex switch: the hub's menu,
//   a pick saved for the project (POST /api/project/model, the registry and
//   the state), shown again after a reload.
// Never touches the board on :4600.
//
// Usage: node tools/answers-board-test.mjs [--shots <dir>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'answers-board-test');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// The phone app's own stylesheet over the board (apps/phone, built), for the phone pictures.
const PHONE_CSS = path.join(ROOT, '..', 'apps', 'phone', 'dist', 'board.css');
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = await startDemoHub({ dir: T, port: await freePort() });
let browser = null;
// Each cmux tab plays Claude's prompt box: what the board types there is kept in its "sent".
const f0 = JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
f0.prompts = Object.fromEntries((f0.workspaces || []).flatMap((w) => (w.surfaces || []).map((s) => [s.id, { body: '' }])));
fs.writeFileSync(hub.fake, JSON.stringify(f0));
const sent = (sf) => (JSON.parse(fs.readFileSync(hub.fake, 'utf8')).prompts[sf] || {}).sent || [];
const t1 = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'answers', 'handback-1.txt'), 'utf8').trim().split(/\n\s*\n/);
const question = t1.pop();
try {
  await hub.arrive('paper-boat', question, t1.join('\n\n'));
  let pb = null;
  for (let i = 0; i < 100; i++) { pb = (await hub.state()).projects.find((p) => p.id === 'paper-boat'); if (pb && (pb.quick || []).length) break; await sleep(150); }
  check('hub: paper-boat asks, with the message\'s options', !!pb && pb.state === 'you' && JSON.stringify((pb.quick || []).map((o) => [o.label, o.text])) === JSON.stringify([['B: the app', 'B'], ['C: the app with an alert…', 'C'], ['Keep A: today', 'Keep A']]), pb && pb.quick);

  browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 412, height: 915, isMobile: true, hasTouch: true }]]) {
    for (const scheme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, colorScheme: scheme, ...(vp.isMobile ? { isMobile: true, hasTouch: true } : {}) });
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(e.message));
      await pg.goto(`${hub.url}/?theme=${scheme}#paper-boat`);
      if (name === 'phone' && fs.existsSync(PHONE_CSS)) await pg.addStyleTag({ path: PHONE_CSS });
      await pg.waitForSelector('.q-opts [data-act="quick"]', { timeout: 15000 });
      const btns = await pg.$$eval('.q-opts [data-act="quick"]', (bs) => bs.map((b) => ({ t: b.textContent, pri: b.classList.contains('pri'), w: b.scrollWidth <= b.clientWidth + 1 })));
      const tag = name + ' ' + scheme;
      check(`${tag}: the options as buttons, B first in the primary style, each whole`, JSON.stringify(btns.map((b) => b.t)) === JSON.stringify(['B: the app', 'C: the app with an alert…', 'Keep A: today']) && btns[0].pri && btns.every((b) => b.w), btns);
      const lv = await pg.evaluate(() => { const e = document.querySelector('#lv-tag'); return e && !e.hidden ? e.textContent : null; });
      check(`${tag}: the Live screen's tag says the assistant and its model`, lv === 'Claude Opus 5.5', lv);
      const sel = await pg.evaluate(() => { const s = document.querySelector('[data-pm-pid="paper-boat"]'); return s ? { opts: [...s.options].map((o) => [o.value, o.textContent]), v: s.value, h: s.getBoundingClientRect().height } : null; });
      check(`${tag}: New sessions' Model beside the switch: the hub's menu, its default picked`, !!sel && sel.opts[0][0] === '' && sel.opts[0][1] === "Claude Code's default" && sel.opts.some(([v, l]) => v === 'opus' && l === 'Opus 5.5') && sel.v === '', sel);
      if (SHOTS) {
        await pg.evaluate(() => { const c = document.querySelector('.q-opts'); if (c) c.scrollIntoView({ block: 'center' }); });
        await sleep(400);
        await pg.screenshot({ path: path.join(SHOTS, `board-${name}-card-${scheme}.png`) });
        await pg.evaluate(() => { const c = document.querySelector('#d-meta') || document.querySelector('#lv-tag'); if (c) c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); });
        await sleep(300);
        await pg.screenshot({ path: path.join(SHOTS, `board-${name}-model-${scheme}.png`) });
      }
      check(`${tag}: no page error`, errors.length === 0, errors);
      await ctx.close();
    }
  }

  // A press, at phone width: exactly the key typed into paper-boat's session.
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    await pg.goto(`${hub.url}/#paper-boat`);
    await pg.waitForSelector('.q-opts [data-act="quick"]', { timeout: 15000 });
    const before = sent('sf-3').length;
    const posts = [];
    pg.on('response', async (r) => { if (r.url().endsWith('/api/send')) posts.push({ status: r.status(), body: r.request().postDataJSON() }); });
    await pg.click('.q-opts [data-act="quick"]:has-text("Keep A: today")');
    for (let i = 0; i < 50 && sent('sf-3').length <= before; i++) await sleep(100);
    check('a press posts the key as the reply (POST /api/send, 200)', posts.length === 1 && posts[0].status === 200 && posts[0].body.text === 'Keep A' && posts[0].body.choice == null, posts);
    check('a press types exactly "Keep A" into the session', sent('sf-3').length === before + 1 && sent('sf-3').at(-1) === 'Keep A', sent('sf-3'));
    const said = await pg.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.textContent).find((t) => /^Sent "/.test(t)) || null);
    check('the card says what was sent', !!said && said.startsWith('Sent "Keep A".'), said);
    await ctx.close();
  }

  // The Model pick, on the desktop board: saved for the project, shown after a reload.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(`${hub.url}/#paper-boat`);
    await pg.waitForSelector('[data-pm-pid="paper-boat"]', { timeout: 15000 });
    const posts = [];
    pg.on('response', async (r) => { if (r.url().endsWith('/api/project/model')) posts.push({ status: r.status(), body: r.request().postDataJSON() }); });
    await pg.selectOption('[data-pm-pid="paper-boat"]', 'opus');
    for (let i = 0; i < 50 && !posts.length; i++) await sleep(100);
    check('Model: a pick posts it for the project (200)', posts.length === 1 && posts[0].status === 200 && posts[0].body.model === 'opus' && posts[0].body.assistant === 'claude', posts);
    const reg = JSON.parse(fs.readFileSync(path.join(hub.home, '.ravenry', 'projects.json'), 'utf8')).projects.find((p) => p.id === 'paper-boat');
    check('Model: remembered in the registry', reg && reg.models && reg.models.claude === 'opus', reg && reg.models);
    let st = null;
    for (let i = 0; i < 50; i++) { st = (await hub.state()).projects.find((p) => p.id === 'paper-boat'); if (st.models && st.models.claude === 'opus') break; await sleep(150); }
    check('Model: the state carries it', st && st.models && st.models.claude === 'opus', st && st.models);
    await pg.reload();
    await pg.waitForSelector('[data-pm-pid="paper-boat"]', { timeout: 15000 });
    await sleep(800);
    const v = await pg.$eval('[data-pm-pid="paper-boat"]', (s) => s.value);
    check('Model: shown again after a reload', v === 'opus', v);
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
