// The phone's Settings has a Privacy row that opens the privacy page
// (site/privacy.html, published at shared/strings/en.json privacy.url) in
// the browser. Headless, Chromium and WebKit (the engine of the iPhone
// app's WKWebView) at 390 px, dark and light, on the phone board served as
// the shells serve it (tools/serve.mjs) against a made-up board on a
// throwaway HOME (127.0.0.1, apps/desktop/tools/demo-hub.mjs). A request
// that would leave this machine is stopped and recorded, never sent.
//
// Checks: the row is there with its words; it is a link to privacy.url that
// opens a new window (the Android and iPhone shells hand such a link to the
// phone's browser: MainActivity onCreateWindow, Board.swift
// createWebViewWith); a tap asks for exactly that address; the address is
// the site's privacy page.
//
//   node tools/privacy-check.mjs [OUT]     (after node build.mjs)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(APP_DIR, '.tmp', 'privacy-check'));
const WORK = path.join(APP_DIR, '.tmp', 'privacy-work');
const pw = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
const words = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'strings', 'en.json'), 'utf8'));
const URL_ = words['privacy.url'];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };

check('privacy_url_is_the_site_page', /^https:\/\/[^/]+\/.*privacy\.html$/.test(URL_ || '') && fs.existsSync(path.join(REPO, 'site', 'privacy.html')), URL_);

let hub = null, serve = null;
const browsers = [];
try {
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort() });
  const PORT = await freePort();
  serve = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT), '--hub', hub.url], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: WORK } });
  await until(() => fetch(`http://127.0.0.1:${PORT}/phone/`).then((r) => r.ok), 10000);
  const LOCAL = `http://127.0.0.1:${PORT}/`;

  for (const engine of ['chromium', 'webkit']) {
    const b = await pw[engine].launch({ headless: true });
    browsers.push(b);
    for (const scheme of ['dark', 'light']) {
      const tag = `${engine}_${scheme}`;
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: scheme });
      const away = [];
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(LOCAL) || u.startsWith(hub.url)) return route.continue();
        away.push(u);
        return route.abort();
      });
      const p = await ctx.newPage();
      await p.goto(`${LOCAL}phone/#/settings`);
      // The screen paints again when the hub and the shell answer: a locator, read after it settles.
      const row = p.locator('a.setr[data-k="privacy"]');
      const shown = await until(() => row.count().then((n) => n === 1), 20000);
      check(`${tag}_row_shown`, !!shown);
      if (!shown) { await p.screenshot({ path: path.join(OUT, `settings-${tag}-missing.png`) }); await ctx.close(); continue; }
      await sleep(1500);
      await p.evaluate(() => document.querySelector('a.setr[data-k="privacy"]')?.scrollIntoView({ block: 'center' }));
      await sleep(300);
      const a = await row.evaluate((el) => ({ href: el.getAttribute('href'), target: el.getAttribute('target'), rel: el.getAttribute('rel'), text: el.innerText.replace(/\s+/g, ' ').trim() }));
      check(`${tag}_row_words`, a.text.startsWith(words['privacy.title']) && a.text.includes(words['privacy.sub']), a.text);
      check(`${tag}_row_links_to_the_page_in_a_new_window`, a.href === URL_ && a.target === '_blank' && /noopener/.test(a.rel || ''), JSON.stringify(a));
      await p.screenshot({ path: path.join(OUT, `settings-${tag}.png`) });
      const popup = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await row.tap();
      const opened = await popup;
      await until(() => away.length > 0, 5000);
      check(`${tag}_tap_asks_for_the_page_only`, !!opened && away.length >= 1 && away.every((u) => u === URL_), JSON.stringify(away));
      await ctx.close();
    }
  }
} catch (e) {
  check('the check ran', false, String(e && e.stack || e).slice(0, 800));
} finally {
  for (const b of browsers) { try { await b.close(); } catch { /* gone */ } }
  serve?.kill();
  hub?.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`privacy-check: ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
