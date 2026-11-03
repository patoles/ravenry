// Headless screenshots of the phase D views (never opens a window, never
// clicks anything that writes). Usage:
//   node tools/shoot-views.mjs <outDir> [--url http://localhost:4600] [--project <id>] [--idea "<name>"]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'docs/shots/phase-d';
const base = opt('--url', 'http://localhost:4600');
const idea = opt('--idea', null);      // the idea panel shots need one
const pid = opt('--project', null);    // the plan shot needs one
const only = opt('--only', null);
fs.mkdirSync(out, { recursive: true });

const shots = [
  { name: 'objectives', q: '#/objectives', wait: '#o-rows .card', full: true },
  { name: 'project-plan', q: `#${pid}`, wait: '#d-objs .card', scrollTo: '#d-objs', needs: pid },
  { name: 'ideas', q: '?idea=none#/ideas', wait: '.idea' },
  { name: 'ideas-panel', q: `?idea=${encodeURIComponent(idea)}#/ideas`, wait: '#i-name', needs: idea },
  { name: 'rules', q: '#/rules', wait: '.yr-card' },
  { name: 'ship', q: '#/ship', wait: '#s-repos .card', full: true },
  { name: 'new-project-modal', q: '?modal=new#/projects', wait: '#modal-form' },
  { name: 'ideas-phone', q: '?idea=none#/ideas', wait: '.idea', w: 390, h: 844, mobile: true, full: true },
  { name: 'ideas-panel-phone', q: `?idea=${encodeURIComponent(idea)}#/ideas`, wait: '#i-name', w: 390, h: 844, mobile: true, scrollTo: '#i-panel', needs: idea },
];

const browser = await chromium.launch({ headless: true });
for (const s of shots) {
  if (only && !only.split(',').includes(s.name)) continue;
  if ('needs' in s && !s.needs) continue;
  const ctx = await browser.newContext({ viewport: { width: s.w || 1440, height: s.h || 1000 }, deviceScaleFactor: 2, isMobile: !!s.mobile, hasTouch: !!s.mobile, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text()); });
  const [qs, hash] = s.q.split('#');
  const sep = qs ? qs + '&' : '?';
  await page.goto(`${base}/${sep}theme=dark#${hash}`);
  await page.waitForSelector(s.wait, { timeout: 15000 });
  await page.waitForTimeout(900);
  if (s.scrollTo) { await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), s.scrollTo); await page.waitForTimeout(200); }
  const file = path.join(out, `${s.name}.png`);
  await page.screenshot({ path: file, fullPage: !!s.full });
  console.log('wrote', file);
  await ctx.close();
}
await browser.close();
