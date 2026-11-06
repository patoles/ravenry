// Headless screenshots of the running board (never opens a window).
// Usage: node tools/shoot.mjs [outDir] [--url http://localhost:4600] [--p <projectId>]...
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'docs/shots';
const base = opt('--url', 'http://localhost:4600');
const picks = args.flatMap((a, i) => (a === '--p' ? [args[i + 1]] : []));
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const shots = [
  { name: 'desktop-dark', w: 1440, h: 1000, theme: 'dark' },
  { name: 'phone-dark', w: 390, h: 844, theme: 'dark', mobile: true },
  { name: 'desktop-light', w: 1440, h: 1000, theme: 'light' },
];
const targets = picks.length ? picks : [null];
for (const p of targets) {
  for (const s of shots) {
    if (p && s.theme === 'light' && targets.indexOf(p) > 0) continue;
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, isMobile: !!s.mobile, hasTouch: !!s.mobile, colorScheme: s.theme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text()); });
    await page.goto(`${base}/?theme=${s.theme}${p ? '#' + encodeURIComponent(p) : ''}`);
    await page.waitForSelector('#list .row', { timeout: 15000 });
    await page.waitForTimeout(600);
    const file = path.join(out, `${s.name}${p ? '-' + p : ''}.png`);
    await page.screenshot({ path: file, fullPage: !!s.full });
    if (s.mobile) {
      await page.evaluate(() => document.querySelector('#sheet').scrollIntoView());
      await page.waitForTimeout(200);
      await page.screenshot({ path: file.replace('.png', '-sheet.png') });
    }
    console.log('wrote', file);
    await ctx.close();
  }
}
await browser.close();
