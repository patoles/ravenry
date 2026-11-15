#!/usr/bin/env node
// A hand-off whose fresh session did not start, on the hub's browser board
// (2026-11-15: the person's shell asked a question at startup): on the demo
// board (apps/desktop/tools/demo-hub.mjs, 127.0.0.1, a throwaway home),
// paper-boat's session has a written hand-off whose start failed, with the
// question its tab asked and the command to run. Checks the hub's state
// (handoff.resumeError, resumeQuestion, resumeCommand), then the board
// headless, dark and light: the card says it did not start and what the tab
// asks; Copy command puts the command on the clipboard; Retry posts the
// same start again (/api/handoff/start) and the hub's answer shows. Never
// touches the board on :4600.
//
// Usage: node tools/handoff-start-board-test.mjs [--shots <dir>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'handoff-start-board-test');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SID = 'b2b2b2b2-0000-4000-8000-000000000002'; // paper-boat's session
const ERROR = "The fresh session didn't start: the terminal was asking something. Retry, or copy the command.";
const QUESTION = '[oh-my-zsh] Would you like to update? [Y/n]';
const hub = await startDemoHub({ dir: T, port: await freePort() });
let browser = null;
try {
  const folder = path.join(hub.root, 'paper-boat');
  const COMMAND = `cd '${folder}' && claude 'Read the Hand-off section of BRIEF.md and continue from it.'`;
  const dir = path.join(hub.home, '.ravenry', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, SID + '.json'), JSON.stringify({ sessionId: SID, state: 'written', writtenAt: at, cwd: folder, folder, workspaceId: 'ws-3', surfaceId: 'sf-3', handoffFile: path.join(folder, 'BRIEF.md'),
    resumeStartedAt: at, resumeError: ERROR, resumeQuestion: QUESTION, resumeCommand: COMMAND, history: [{ state: 'written', at }] }, null, 2));
  let h = null;
  for (let i = 0; i < 60 && !(h && h.resumeError); i++) { const st = await hub.state(); h = (st.projects.find((p) => p.id === 'paper-boat')?.sessions || []).find((s) => s.sessionId === SID)?.handoff || null; if (!(h && h.resumeError)) await sleep(200); }
  check('hub state: the failed start, the question and the command to copy', !!h && h.state === 'written' && h.resumeError === ERROR && h.resumeQuestion === QUESTION && h.resumeCommand === COMMAND && h.starting === false, h && { state: h.state, err: h.resumeError, q: h.resumeQuestion, starting: h.starting });

  browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1273, height: 900 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
    const pg = await ctx.newPage();
    await pg.goto(`${hub.url}/?theme=${theme}#paper-boat`);
    await pg.waitForSelector('#d-handoff .card', { timeout: 15000 });
    const card = await pg.textContent('#d-handoff .card');
    check(`${theme}: the card says it did not start, and what the tab asks`, card.includes(`Hand-off written to BRIEF.md. ${ERROR}`) && card.includes(`Its tab asks: "${QUESTION}". Ravenry never answers that for you.`), card.slice(0, 300));
    const btns = await pg.$$eval('#d-strip button', (bs) => bs.map((b) => b.textContent.trim()));
    check(`${theme}: Retry and Copy command in the strip`, btns.includes('Retry') && btns.includes('Copy command'), btns);
    if (SHOTS) {
      await pg.locator('#d-strip').scrollIntoViewIfNeeded();
      const top = await pg.$eval('#d-strip', (e) => e.getBoundingClientRect().top + window.scrollY);
      const bot = await pg.$eval('#d-handoff', (e) => e.getBoundingClientRect().bottom + window.scrollY);
      const left = await pg.$eval('#d-strip', (e) => e.getBoundingClientRect().left);
      const w = await pg.$eval('#d-strip', (e) => e.getBoundingClientRect().width);
      await pg.screenshot({ path: path.join(SHOTS, `board-handoff-not-started-${theme}.png`), clip: { x: Math.max(0, left - 12), y: Math.max(0, top - 12), width: w + 24, height: bot - top + 24 }, fullPage: true });
    }
    await pg.click('#d-strip [data-act="handoff-copy"]');
    await sleep(300);
    const clip = await pg.evaluate(() => navigator.clipboard.readText());
    check(`${theme}: Copy command puts the command on the clipboard`, clip === COMMAND, clip);
    if (theme === 'light') {
      const req = pg.waitForRequest((r) => r.url().endsWith('/api/handoff/start') && r.method() === 'POST', { timeout: 10000 });
      const resp = pg.waitForResponse((r) => r.url().endsWith('/api/handoff/start'), { timeout: 30000 });
      await pg.click('#d-strip [data-act="handoff-start"]');
      const body = JSON.parse((await req).postData() || '{}');
      const r = await resp;
      const j = await r.json().catch(() => null);
      // The demo's cmux opens no tab, so the retry fails again, and says so.
      check('Retry posts the same start for this session, and the hub answers it', body.sessionId === SID && body.projectId === 'paper-boat' && r.status() === 409 && /^The fresh session didn't start: cmux did not open a tab/.test((j && j.error) || ''), { body, status: r.status(), j });
      await sleep(400);
      const toast = await pg.evaluate(() => document.body.innerText.includes("The fresh session didn't start: cmux did not open a tab"));
      check('...and the board shows its answer', toast);
    }
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
