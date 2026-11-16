// The board's Attach in a phone's browser (docs/FEATURES.md PHONE-038, the
// Phone web column): the hub's board at 390 px, Chromium and WebKit, on a
// made-up board on a throwaway HOME (127.0.0.1, apps/desktop/tools/demo-hub.mjs).
// The browser's own picker is the phone's; here the files are given to the
// message box's file input as the picker gives them. Checks: both land in
// the project's .inbox byte for byte (sha256), each shows as a chip.
//
//   node tools/attach-web-check.mjs [OUT]
import { guardSpawns } from '../../../tools/test-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(APP_DIR, '.tmp', 'attach-web-check'));
const WORK = path.join(APP_DIR, '.tmp', 'attach-web-work');
const pw = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 15000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };

let hub = null;
const browsers = [];
try {
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort() });
  const st = await (await fetch(`${hub.url}/api/state`)).json();
  const proj = (st.projects || []).find((p) => p.folder && fs.existsSync(p.folder));
  if (!proj) throw new Error('no project with a folder on the demo board');
  const inbox = path.join(proj.folder, '.inbox');
  const inboxNow = () => (fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((f) => !f.startsWith('.')) : []);
  for (const engine of ['chromium', 'webkit']) {
    const b = await pw[engine].launch({ headless: true });
    browsers.push(b);
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', colorScheme: 'dark' });
    const p = await ctx.newPage();
    await p.goto(`${hub.url}/`);
    const chip = p.locator(`#pchips .pchip[data-id="${proj.id}"]`);
    if (!(await until(() => chip.count().then((n) => n === 1), 20000))) { check(`${engine}_chip`, false, proj.id); continue; }
    await chip.tap();
    await until(() => p.locator('#composer #pick').count().then((n) => n === 1), 10000);
    const files = [
      { name: `notes-${engine}.pdf`, mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(200 * 1024)]) },
      { name: `photo-${engine}.png`, mimeType: 'image/png', buffer: await p.screenshot() },
    ];
    const before = inboxNow();
    await p.locator('#composer #pick').setInputFiles(files);
    const chips = await until(async () => { const c = await p.locator('#chips .chip').allInnerTexts(); return c.length >= 2 && !c.some((t) => t.startsWith('Saving ')) ? c : null; }, 20000);
    const got = inboxNow().filter((f) => !before.includes(f));
    const same = files.every((f) => got.includes(f.name) && sha(fs.readFileSync(path.join(inbox, f.name))) === sha(f.buffer));
    check(`${engine}_two_chips`, !!chips && files.every((f) => chips.some((t) => t.trim().endsWith('/' + f.name))), JSON.stringify(chips));
    check(`${engine}_in_the_inbox_byte_for_byte`, got.length === 2 && same, got.join(', '));
    await p.locator('#composer').scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(OUT, `attach-web-${engine}.png`) });
    await ctx.close();
  }
} catch (e) {
  check('the check ran', false, String(e && e.stack || e).slice(0, 800));
} finally {
  for (const b of browsers) { try { await b.close(); } catch { /* gone */ } }
  hub?.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`attach-web-check: ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
