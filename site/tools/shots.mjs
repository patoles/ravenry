#!/usr/bin/env node
// The launch page's review pictures and its link check, in headless Chromium.
//
//   node site/tools/shots.mjs [--out DIR] [--og]
//
// Serves site/ on 127.0.0.1 (a port of its own), then for each width (1440
// and 390, at 2x) writes DIR/page-<width>.png (the whole page) and
// DIR/hero-<width>.png (the first screen). DIR defaults to a new folder in
// the system's temp folder; the pictures are for review, never committed.
// --og also writes site/assets/og-image.png, the 1200x630 link preview, from
// the hero.
//
// The check, which fails the run (exit 1):
// - every request the page makes goes to the local server and gets a 200
//   (no 404, no font, script, picture or tracker from anywhere else: any
//   other request is blocked and listed);
// - every link and asset in the page resolves: #anchors name an element,
//   relative paths are served, and the only links that leave the page are
//   the GitHub downloads and the issue link the config block at the top of
//   index.html names;
// - no script error, and nothing wider than the screen.
// Playwright: the hub's dev dependency (npm install in hub/), else one installed
// beside the page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SITE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HUB = path.join(path.dirname(SITE), 'hub', 'package.json');
const { chromium } = fs.existsSync(HUB) ? createRequire(HUB)('playwright') : await import('playwright');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(args[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-site-'));
const OG = args.includes('--og');
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const served = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(SITE, rel);
  const ok = file.startsWith(SITE + path.sep) && !file.includes(`${path.sep}tools${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile();
  served.push({ path: url.pathname, status: ok ? 200 : 404 });
  if (!ok) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const problems = [];
const external = [];
const browser = await chromium.launch({ headless: true });

async function open(viewport, scale) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, colorScheme: 'dark' });
  page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    external.push(u);
    return route.abort();
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return page;
}

for (const width of [1440, 390]) {
  const page = await open({ width, height: width < 600 ? 844 : 900 }, 2);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) problems.push(`${width}: ${over}px wider than the screen`);
  await page.screenshot({ path: path.join(OUT, `hero-${width}.png`) });
  await page.screenshot({ path: path.join(OUT, `page-${width}.png`), fullPage: true });

  if (width === 1440) {
    const found = await page.evaluate(() => {
      const S = window.RAVENRY_SITE;
      const refs = [];
      for (const el of document.querySelectorAll('a[href]')) refs.push({ kind: 'link', text: el.textContent.trim(), url: el.getAttribute('href'), abs: el.href });
      for (const el of document.querySelectorAll('link[href]')) refs.push({ kind: 'asset', text: el.rel, url: el.getAttribute('href'), abs: el.href });
      for (const el of document.querySelectorAll('script[src], img[src]')) refs.push({ kind: 'asset', text: el.tagName.toLowerCase(), url: el.getAttribute('src'), abs: el.src });
      for (const el of document.querySelectorAll('meta[property="og:image"]')) refs.push({ kind: 'asset', text: 'og:image', url: el.content, abs: new URL(el.content, location.href).href });
      for (const r of refs) if (r.url.startsWith('#')) r.target = !!document.getElementById(r.url.slice(1));
      return { refs, allowed: [S.downloads, S.reportUrl] };
    });
    for (const r of found.refs) {
      let verdict;
      if (r.url.startsWith('#')) verdict = r.target ? 'ok (anchor)' : 'MISSING anchor';
      else if (r.abs.startsWith(BASE)) {
        const res = await fetch(r.abs);
        verdict = res.status === 200 ? `ok (${res.status})` : `BROKEN (${res.status})`;
      } else if (r.abs === found.allowed[1] || (r.abs.startsWith(found.allowed[0]) && !r.abs.slice(found.allowed[0].length).includes('/'))) verdict = 'ok (GitHub, not fetched)';
      else verdict = 'NOT ALLOWED (leaves the page)';
      if (!verdict.startsWith('ok')) problems.push(`${r.kind} "${r.text}" ${r.url}: ${verdict}`);
      console.log(`${verdict.padEnd(26)} ${r.kind.padEnd(5)} ${r.text.slice(0, 24).padEnd(24)} ${r.abs.startsWith(BASE) ? r.url : r.abs}`);
    }
  }
  await page.close();
}

if (OG) {
  // The hero alone, set for a 1200x630 card: the headline over the product.
  // The phone whole, its bottom bar included, above the card's bottom edge.
  const page = await open({ width: 1200, height: 630 }, 1);
  await page.addStyleTag({ content: `
    nav, .eyebrow, .lede, .ctas, .fine { display:none !important; }
    .hero { padding-top:40px; }
    h1 { font-size:72px; margin-bottom:0; }
    .stage { margin-top:34px; max-width:1060px; } .stage .callout { display:none; }
    .stage .tilt { transform:rotateX(10deg); margin-right:120px; }
    .stage .phone { width:236px; right:20px; top:-34px; bottom:auto; }` });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SITE, 'assets', 'og-image.png') });
  await page.close();
  console.log('og image: site/assets/og-image.png');
}

await browser.close();
server.close();

for (const s of served) if (s.status !== 200) problems.push(`the page asked for ${s.path}: ${s.status}`);
for (const u of new Set(external)) problems.push(`external request (blocked): ${u}`);
console.log(`requests: ${served.length} local (${served.filter((s) => s.status === 200).length} ok), ${external.length} external`);
console.log(`pictures: ${OUT}`);
for (const p of problems) console.log('PROBLEM  ' + p);
console.log(problems.length ? `site check: FAILED (${problems.length})` : 'site check: CLEAN');
process.exit(problems.length ? 1 : 0);
