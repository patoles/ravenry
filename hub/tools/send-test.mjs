// Phase B proof, headless: drives the board's composer against a TEST
// server whose registry holds only a scratch workspace running
// tools/fake-claude.mjs. Never point this at the real registry.
// Usage: node tools/send-test.mjs http://localhost:4601 <projectId> <outDir>
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [base, pid, out] = process.argv.slice(2);
if (!base || !/:(?!4600)\d+$/.test(base)) { console.error('refusing: give the TEST server url (not :4600)'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`${base}/#${pid}`);
await page.waitForSelector('#compose:not([disabled])');
await page.waitForFunction(() => !document.querySelector('#send').disabled);

// 1. A typed message.
await page.fill('#compose', 'hello from ravenry');
await page.click('#send');
await page.waitForSelector('#toast:not([hidden])');
console.log('toast 1:', await page.textContent('#toast'));

// 2. A file through Attach: saved to .inbox, its path appended.
const tmp = path.join(out, 'drop test.txt');
fs.writeFileSync(tmp, 'a file dropped on the board\n');
await page.waitForTimeout(800);
await page.setInputFiles('#pick', tmp);
await page.waitForFunction(() => document.querySelector('#chips .chip') && !/Saving/.test(document.querySelector('#chips').textContent));
console.log('chip:', await page.textContent('#chips'));
await page.fill('#compose', 'here is the file');
await page.screenshot({ path: path.join(out, 'composer-with-file.png') });
await page.click('#send');
await page.waitForTimeout(400);
console.log('toast 2:', await page.textContent('#toast'));

// 3. A pasted path goes through untouched.
await page.waitForTimeout(800);
await page.fill('#compose', 'see /Users/x/Desktop/some shot.png');
await page.click('#send');
await page.waitForTimeout(400);

// 4. Add as note.
await page.waitForTimeout(800);
await page.fill('#compose', 'the end screen still clips on my phone');
await page.click('#note');
await page.waitForTimeout(400);
console.log('toast 4:', await page.textContent('#toast'));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, 'after-send.png') });
await browser.close();
