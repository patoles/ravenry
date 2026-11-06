#!/usr/bin/env node
// The phone board in a headless browser at the phone's size (412 x 915,
// the pictures' phone), light and dark: one picture per screen, for a look
// before the emulator. Never on screen.
//
//   node tools/preview.mjs <served board url> <outDir> [route ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, '..', '..', '..', 'hub', 'package.json'));
const { chromium } = require('playwright');
const [, , base, outDir, ...routes] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const want = routes.length ? routes : ['/'];
const b = await chromium.launch({ headless: true });
for (const scheme of ['dark', 'light']) {
  const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  for (const r of want) {
    const [route, feats] = r.split('|');
    await p.goto(`${base}${feats ? `?features=${feats}` : ''}#${route}`);
    await p.waitForTimeout(2500);
    const name = (route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sessions') + `-${scheme}.png`;
    await p.screenshot({ path: path.join(outDir, name) });
    console.log(name);
  }
  await ctx.close();
}
await b.close();
