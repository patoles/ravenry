// The phone's top bar with the connection chip (docs/PHONE.md, The
// connection): at 360, 393 and 412 px wide, in every state the chip has
// (Wi-Fi, Tailscale, Reconnecting, Offline), dark and light, nothing in the
// bar overlaps or is cut, and the word Ravenry stays beside the mark (bar B);
// narrower than 360 the word gives way to the mark alone. Then the details
// sheet (its rows and buttons, Reconnect calls the app, no "home" in it), and
// a phone's browser: the chip from its own address (a Wi-Fi address, a
// tailnet name), none on the Mac itself.
//
// Usage: node tools/phone-bar-test.mjs --url http://127.0.0.1:4791 [--shots dir]
//   (a demo board: apps/phone/tools/demo.mjs)
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = opt('--url', 'http://127.0.0.1:4791');
const shots = opt('--shots', null);
if (shots) fs.mkdirSync(shots, { recursive: true });
const port = new URL(base).port;

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what); } };
const b = await chromium.launch({ headless: true,  });

const STATES = {
  wifi: { state: 'up', via: 'wifi', since: Date.now() - 42 * 60000, rtt: 14, mac: 'Studio Mac' },
  tailscale: { state: 'up', via: 'tailscale', since: Date.now() - 5 * 60000, rtt: 63, mac: 'Studio Mac' },
  reconnecting: { state: 'reconnecting', via: 'wifi', since: null, rtt: null, mac: 'Studio Mac' },
  offline: { state: 'offline', via: 'wifi', since: null, rtt: null, reason: 'mac-away', words: 'The Mac is not answering. It may be asleep or off.', mac: 'Studio Mac' },
};
const WORD = { wifi: 'Wi-Fi', tailscale: 'Tailscale', reconnecting: 'Reconnecting', offline: 'Offline' };

/** Every piece of the bar inside it and apart from the others. */
const measure = (page) => page.evaluate(() => {
  const bar = document.querySelector('#pbar');
  const B = bar.getBoundingClientRect();
  const kids = [...bar.children].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).display !== 'none'; });
  const rs = kids.map((e) => { const r = e.getBoundingClientRect(); return { n: e.id || e.className || e.tagName, l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  const out = rs.filter((r) => r.l < B.left - 0.5 || r.r > B.right + 0.5 || r.r > window.innerWidth + 0.5);
  const over = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].r > rs[j].l + 0.5 && rs[j].r > rs[i].l + 0.5) over.push(rs[i].n + ' / ' + rs[j].n);
  const chip = document.querySelector('#cx-chip .cx-w');
  const cut = chip && chip.scrollWidth > chip.clientWidth + 0.5;
  const word = document.querySelector('#pbar .pn-word');
  return { out: out.map((r) => r.n), over, cut, chip: chip ? chip.textContent : null, ravenry: !!(word && word.getBoundingClientRect().width > 0), scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});

for (const scheme of ['dark', 'light']) {
  for (const w of [360, 393, 412]) {
    for (const [k, conn] of Object.entries(STATES)) {
      const page = await b.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      await page.addInitScript((c) => { window.ravenryApp = { openCheckpoint() {}, openSettings() {}, openTailscale() { window.__ts = 1; }, reconnect() { window.__re = 1; }, platform: 'android', conn: c }; }, conn);
      await page.goto(base + '/#portfolio');
      await page.waitForSelector('#cx-chip');
      await page.evaluate((s) => { localStorage.setItem('mc.theme', JSON.stringify(s)); }, scheme);
      await page.reload(); await page.waitForSelector('#cx-chip'); await page.waitForTimeout(500);
      const m = await measure(page);
      const good = !m.out.length && !m.over.length && !m.cut && m.chip === WORD[k] && !m.scroll && m.ravenry;
      ok(good, `${w} ${k} ${scheme}: ${JSON.stringify(m)}`);
      console.log(`${good ? 'ok  ' : 'FAIL'} ${scheme} ${w} px, ${WORD[k]}: ${m.ravenry ? 'Ravenry beside the mark' : 'the mark alone'}${m.over.length ? ', overlaps ' + m.over.join(', ') : ''}${m.out.length ? ', cut ' + m.out.join(', ') : ''}`);
      if (shots) await page.screenshot({ path: `${shots}/bar-${scheme}-${w}-${k}.png`, clip: { x: 0, y: 0, width: w, height: 72 } });
      if (w === 412 && (k === 'wifi' || k === 'tailscale' || k === 'offline')) {
        await page.click('#cx-chip'); await page.waitForTimeout(400);
        const sh = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.cx-row .k')].map((e) => e.textContent), btns: [...document.querySelectorAll('.cx-btns .btn')].map((e) => e.textContent), how: (document.querySelectorAll('.cx-row .v')[1] || {}).textContent, all: document.querySelector('.cx-sheet').innerText }));
        const howWant = { wifi: 'Wi-Fi, straight to the Mac', tailscale: "Tailscale, through Ravenry's own device on your tailnet", offline: STATES.offline.words }[k];
        ok(sh.rows.join() === 'Mac,How,Since,Answers in' && sh.btns.includes('Reconnect') && (k === 'wifi' || sh.btns.includes('Open Tailscale')) && sh.how === howWant && !sh.all.toLowerCase().includes('home'), `${k} sheet: ${JSON.stringify(sh)}`);
        console.log(`ok   ${scheme} the details sheet, ${k}: ${sh.how}`);
        if (shots) await page.screenshot({ path: `${shots}/sheet-${scheme}-${k}.png` });
        await page.click('[data-act="cx-reconnect"]'); await page.waitForTimeout(300);
        ok(await page.evaluate(() => window.__re === 1 && !document.querySelector('.cx-sheet')), `${k}: Reconnect calls the app and closes the sheet`);
      }
      if (k === 'offline' && w === 412) {
        // The words under it stay the app's reach bar (apps/phone/src/board.ts): the chip only adds the state.
      }
      await page.close();
    }
  }
}

// Narrower than any phone the bar was drawn for (300 px): the word gives way
// to the mark, and still nothing overlaps or is cut.
{
  const page = await b.newPage({ viewport: { width: 300, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await page.addInitScript((c) => { window.ravenryApp = { openCheckpoint() {}, openSettings() {}, openTailscale() {}, reconnect() {}, platform: 'android', conn: c }; }, STATES.reconnecting);
  await page.goto(base + '/#portfolio');
  await page.waitForSelector('#cx-chip'); await page.waitForTimeout(500);
  const m = await measure(page);
  const good = !m.out.length && !m.over.length && !m.cut && !m.scroll && !m.ravenry && m.chip === 'Reconnecting';
  ok(good, `300 reconnecting: ${JSON.stringify(m)}`);
  console.log(`${good ? 'ok  ' : 'FAIL'} 300 px, Reconnecting: the word gives way to the mark alone, nothing cut`);
  if (shots) await page.screenshot({ path: `${shots}/bar-dark-300-reconnecting.png`, clip: { x: 0, y: 0, width: 300, height: 72 } });
  await page.close();
}

// A phone's browser: its own address says the path (the board answers only
// to its own addresses, so the tailnet names are read by the board's own
// classifier, and the chip drawn at a Wi-Fi address).
{
  const page = await b.newPage({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await page.route('**/api/whoami', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ local: false }) }));
  await page.goto(base + '/#portfolio');
  await page.waitForSelector('#cx-chip', { timeout: 15000 }).catch(() => {});
  const chip = await page.evaluate(() => { const e = document.querySelector('#cx-chip .cx-w'); return e ? e.textContent : null; });
  ok(chip === 'Wi-Fi', `browser at a Wi-Fi address: ${chip}`);
  console.log(`${chip === 'Wi-Fi' ? 'ok  ' : 'FAIL'} a phone's browser at a Wi-Fi address: ${chip}`);
  if (shots) await page.screenshot({ path: `${shots}/browser-home.png`, clip: { x: 0, y: 0, width: 393, height: 72 } });
  const hosts = { '192.168.1.20': 'wifi', 'homemac.local': 'wifi', '10.0.0.5': 'wifi', 'ravenry.tail0000.ts.net': 'tailscale', 'studio.tail0000.ts.net': 'tailscale', '100.101.102.103': 'tailscale', '100.63.0.1': 'wifi', '[fd7a:115c:a1e0::1]': 'tailscale' };
  const got = await page.evaluate((hs) => Object.fromEntries(Object.keys(hs).map((h) => [h, window.ravenryConnVia(h)])), hosts);
  const bad = Object.keys(hosts).filter((h) => got[h] !== hosts[h]);
  ok(!bad.length, 'the address says the path: ' + bad.map((h) => `${h} ${got[h]}`).join(', '));
  console.log(`${!bad.length ? 'ok  ' : 'FAIL'} the address says the path: ${Object.keys(hosts).length} addresses (.ts.net and 100.64/10 Tailscale, others Wi-Fi)`);
  await page.close();
}
{
  const page = await b.newPage({ viewport: { width: 393, height: 800 }, isMobile: true, hasTouch: true });
  await page.goto(base + '/#portfolio'); await page.waitForSelector('#pbar .pn-ttl'); await page.waitForTimeout(1200);
  const chip = await page.$('#cx-chip');
  ok(!chip, 'the Mac\'s own board at phone width: no chip');
  console.log(`${!chip ? 'ok  ' : 'FAIL'} the board on the Mac itself: no chip`);
  await page.close();
}
await b.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
