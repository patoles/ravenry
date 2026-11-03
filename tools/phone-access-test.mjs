#!/usr/bin/env node
// Phone access, end to end (server/phone.mjs, docs/design/PhoneQR.dc.html A).
// Two test boards with a throwaway RAVENRY_HOME under .tmp/phone-test and
// tools/fake-cmux.mjs as cmux: one on :4621 with the Mac's real Wi-Fi
// address, one on :4622 that pretends there is none (MC_PHONE_LAN=none).
// Requests sent to the Mac's own LAN address arrive as non-loopback, so they
// stand in for a phone. Never touches the board on :4600.
// Usage: node tools/phone-access-test.mjs [shotsDir]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const PORT = 4621;
const PORT_OFF = 4622;
const T = path.join(ROOT, '.tmp', 'phone-test');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const MC_OFF = path.join(T, 'mc-off');
const FAKE = path.join(T, 'fake-cmux.json');
for (const d of [MC, MC_OFF, path.join(T, 'root'), path.join(T, 'claude'), ...(SHOTS ? [SHOTS] : [])]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The Mac's Wi-Fi address, picked the way the board picks it.
const LAN = (() => {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  }
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return out[0] && out[0].address;
})();
if (!LAN) { console.log('FAIL  this Mac has no private LAN IPv4 address, so nothing can arrive as a phone'); process.exit(1); }

// Three fake projects so the board has something to show.
const projects = [['boat', 'Paper Boat', 'Is E the direction, or do you prefer B or C?'], ['court', 'Cloud Court', 'Pushed the wave tuning.'], ['arcade', 'Arcade', 'Working on the hand-off.']];
const RULE = '─'.repeat(100);
const atRest = (t) => `\n⏺ ${t}\n\n✻ Worked for 2m 3s · done 9:41 PM\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: projects.map(([id, name], i) => ({ id: 'ws-' + id, ref: `workspace:${i + 1}`, title: name, cwd: path.join(T, 'root', id), surfaces: [{ id: 'sf-' + id, ref: `surface:${i + 1}`, title: '✳ ' + name }] })),
  screens: Object.fromEntries(projects.map(([id, , line]) => ['sf-' + id, atRest(line)])),
}));
for (const home of [MC, MC_OFF]) {
  for (const [id] of projects) fs.mkdirSync(path.join(T, 'root', id), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
    version: 1,
    settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root') },
    projects: projects.map(([id, name]) => ({ id, name, folder: path.join(T, 'root', id), workspaces: ['ws-' + id] })),
  }, null, 2));
}

function board(home, port, extra = {}) {
  const env = {
    ...process.env, RAVENRY_HOME: home, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
    MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), ...extra,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  return child;
}

// A raw request, so the Host header can be anything.
function req(target, { method = 'GET', path: p = '/', host, headers = {}, body = null, stream = false } = {}) {
  const u = new URL(target);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, method, path: p, headers: { Host: host || u.host, ...headers } }, (res) => {
      if (stream) return resolve({ status: res.statusCode, headers: res.headers, res, req: r });
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const MAC = `http://127.0.0.1:${PORT}`;
const PH = `http://${LAN}:${PORT}`;
const main = board(MC, PORT);
const off = board(MC_OFF, PORT_OFF, { MC_PHONE_LAN: 'none' });
const procs = [main, off];
let browser = null;

async function up(base) {
  for (let i = 0; i < 150; i++) { try { const r = await req(base, { path: '/api/whoami' }); if (r.status === 200) return true; } catch { /* starting */ } await sleep(100); }
  return false;
}

try {
  check(`test boards are up on :${PORT} and :${PORT_OFF}`, (await up(MAC)) && (await up(`http://127.0.0.1:${PORT_OFF}`)), main.log.slice(-300));

  // ------------------------------------------------------------ host check
  let r = await req(PH, { host: `evil.example:${PORT}` });
  check('421 for a request to the LAN address with a foreign Host', r.status === 421, `HTTP ${r.status}`);
  r = await req(MAC, { host: `rebind.example:${PORT}` });
  check('421 for a loopback request with a foreign Host (DNS rebinding)', r.status === 421, `HTTP ${r.status}`);
  r = await req(PH, { host: `${LAN}:9999` });
  check('421 for the right address on the wrong port', r.status === 421, `HTTP ${r.status}`);

  // ------------------------------------------------------------ no cookie
  r = await req(PH, { path: '/' });
  check('401 for the board page from a phone with no cookie, as a plain page', r.status === 401 && /Scan the code on the Mac/.test(r.body), `HTTP ${r.status}`);
  const noCookie = await Promise.all(['/app.js', '/app.css', '/api/state', '/api/whoami', '/api/ideas', '/api/phone'].map((p) => req(PH, { path: p }).then((x) => [p, x.status])));
  check('401 for static files and API routes with no cookie', noCookie.every(([, s]) => s === 401), noCookie.map(([p, s]) => `${p} ${s}`).join(', '));
  r = await req(PH, { path: '/api/events' });
  check('401 for the live updates stream with no cookie', r.status === 401, `HTTP ${r.status}`);
  r = await req(PH, { method: 'POST', path: '/api/ideas/brainstorm/clear', headers: { 'X-Ravenry': '1', 'Content-Type': 'application/json' }, body: '{}' });
  check('401 for a write with no cookie', r.status === 401, `HTTP ${r.status}`);

  // ------------------------------------------------------------ the key
  const pf = path.join(MC, 'phone.json');
  const r0 = await req(MAC, { path: '/api/phone' });
  const card0 = JSON.parse(r0.body);
  const st = fs.statSync(pf);
  const saved = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const KEY = saved.key;
  check('the key is 32 random bytes in base64url, in phone.json with mode 0600', /^[A-Za-z0-9_-]{43}$/.test(KEY) && (st.mode & 0o777) === 0o600, `mode ${(st.mode & 0o777).toString(8)}`);
  check('loopback gets the card without a key: address, QR, 0 phones', r0.status === 200 && card0.address === `${PH}/?k=` && /<svg/.test(card0.svg) && card0.phones === 0, `HTTP ${r0.status} ${card0.address}`);
  check('the card JSON never carries the key in clear', !r0.body.includes(KEY));

  r = await req(PH, { path: '/?k=' + 'A'.repeat(43) });
  check('a wrong key is refused: 401, no cookie', r.status === 401 && !r.headers['set-cookie'], `HTTP ${r.status}`);
  r = await req(PH, { path: '/?k=' + KEY.slice(0, 20) });
  check('a truncated key is refused', r.status === 401 && !r.headers['set-cookie'], `HTTP ${r.status}`);

  r = await req(PH, { path: '/?k=' + encodeURIComponent(KEY), headers: { 'User-Agent': 'phone-access-test/1 (iPhone)' } });
  const sc = [].concat(r.headers['set-cookie'] || []);
  const ck = sc.find((c) => c.startsWith('mc_phone=')) || '';
  const COOKIE = ck.split(';')[0];
  check('the right key gives 303 to / with no key left in the address', r.status === 303 && r.headers.location === '/', `HTTP ${r.status} Location ${r.headers.location}`);
  check('the cookie is HttpOnly, SameSite=Strict, Path=/, one year', /HttpOnly/.test(ck) && /SameSite=Strict/.test(ck) && /Path=\//.test(ck) && /Max-Age=31536000/.test(ck), ck.replace(/=[^;]+/, '=<token>'));
  check('a one-time toast cookie comes with it', sc.some((c) => /^mc_new=1;/.test(c)));
  const saved1 = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const tok = COOKIE.split('=')[1];
  check('phone.json records the phone (hashed token, user agent, created and last seen)', saved1.tokens.length === 1 && saved1.tokens[0].ua.includes('iPhone') && saved1.tokens[0].created && saved1.tokens[0].lastSeen && !JSON.stringify(saved1).includes(tok));

  // ------------------------------------------------------------ signed in
  const H = { Cookie: COOKIE };
  const signedIn = await Promise.all(['/', '/app.js', '/app.css', '/api/state', '/api/ideas'].map((p) => req(PH, { path: p, headers: H }).then((x) => [p, x.status])));
  check('signed in: the board page, static files and API answer 200', signedIn.every(([, s]) => s === 200), signedIn.map(([p, s]) => `${p} ${s}`).join(', '));
  // The Perch icons the page links (favicon SVG, PNG fallbacks, apple-touch),
  // so a phone's tab and home-screen icon load through the sign-in cookie.
  const ICONS = [['/icons/favicon.svg', 'image/svg+xml'], ['/icons/favicon-32.png', 'image/png'], ['/icons/favicon-16.png', 'image/png'], ['/icons/apple-touch-icon-180.png', 'image/png']];
  const html = (await req(PH, { path: '/', headers: H })).body;
  check('signed in: the board page links every icon', ICONS.every(([p]) => html.includes(`href="${p}"`)), ICONS.filter(([p]) => !html.includes(`href="${p}"`)).join(', '));
  const icons = await Promise.all(ICONS.map(([p, t]) => req(PH, { path: p, headers: H }).then((x) => [p, x.status, x.headers['content-type'], t])));
  check('signed in: the icons answer 200 with their image type', icons.every(([, s, ct, t]) => s === 200 && ct === t), icons.map(([p, s, ct]) => `${p} ${s} ${ct}`).join(', '));
  const iconsOut = await Promise.all(ICONS.map(([p]) => req(PH, { path: p }).then((x) => x.status)));
  check('no cookie: the icons are refused like any static file (401)', iconsOut.every((s) => s === 401), iconsOut.join(', '));
  let n = 0;
  for (let i = 0; i < 50 && n !== 3; i++) { r = await req(PH, { path: '/api/state', headers: H }); n = (JSON.parse(r.body).projects || []).length; if (n !== 3) await sleep(100); }
  check('signed in: /api/state carries the board', n === 3, `${n} projects`);
  r = await req(PH, { path: '/api/whoami', headers: H });
  check('signed in: whoami says this is not the Mac', r.status === 200 && JSON.parse(r.body).local === false);
  const sse = await req(PH, { path: '/api/events', headers: H, stream: true });
  let sseText = '';
  let sseEnded = false;
  sse.res.on('data', (d) => { sseText += d; });
  sse.res.on('end', () => { sseEnded = true; });
  sse.res.on('close', () => { sseEnded = true; });
  for (let i = 0; i < 30 && !/event: state/.test(sseText); i++) await sleep(100);
  check('signed in: live updates stream state', sse.status === 200 && /event: state/.test(sseText), `HTTP ${sse.status}`);
  r = await req(PH, { method: 'POST', path: '/api/ideas/brainstorm/clear', headers: { ...H, 'X-Ravenry': '1', 'Content-Type': 'application/json', Origin: PH }, body: '{}' });
  check('signed in: the phone can write like the board (answers, notes)', r.status === 200, `HTTP ${r.status}`);
  r = await req(PH, { method: 'POST', path: '/api/ideas/brainstorm/clear', headers: { ...H, 'X-Ravenry': '1', 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  check('signed in: a write with a foreign Origin is refused', r.status === 403, `HTTP ${r.status}`);

  // ------------------------------------------------------------ loopback only
  const lo = await Promise.all([
    req(PH, { path: '/api/phone', headers: H }),
    req(PH, { method: 'POST', path: '/api/phone/new-key', headers: { ...H, 'X-Ravenry': '1', 'Content-Type': 'application/json', Origin: PH }, body: '{}' }),
  ]);
  check('a signed-in phone is refused the QR card and New key (403)', lo.every((x) => x.status === 403) && lo.every((x) => !x.body.includes(KEY)), lo.map((x) => x.status).join(', '));
  check('New key from the phone changed nothing', JSON.parse(fs.readFileSync(pf, 'utf8')).key === KEY);

  // ------------------------------------------------------------ loopback
  const loop = await Promise.all([
    req(MAC, { path: '/' }), req(MAC, { path: '/api/state' }),
    req(`http://localhost:${PORT}`, { path: '/api/whoami' }), req(`http://[::1]:${PORT}`, { path: '/api/whoami' }),
  ]);
  check('loopback works with no key: 127.0.0.1, localhost and [::1]', loop.every((x) => x.status === 200) && JSON.parse(loop[2].body).local === true && JSON.parse(loop[3].body).local === true, loop.map((x) => x.status).join(', '));
  r = await req(MAC, { path: '/api/phone' });
  check('the card counts 1 phone signed in', JSON.parse(r.body).phones === 1);

  // ------------------------------------------------------------ browser
  browser = await chromium.launch();
  const JSQR = fs.readFileSync(path.join(ROOT, 'node_modules/jsqr/dist/jsQR.js'), 'utf8');
  async function macPage(theme, base = MAC) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${base}/?theme=${theme}`);
    await page.waitForSelector('#phone-anchor:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('.row[data-id]', { timeout: 10000 });
    return { ctx, page };
  }
  const { ctx: dctx, page: dark } = await macPage('dark');
  await dark.click('#phone');
  await dark.waitForSelector('#phone-pop .qr-svg');
  check('the Mac shows the phone button and its card', await dark.isVisible('#phone-pop'));
  const texts = await dark.$eval('#phone-pop', (el) => el.innerText);
  check('the card reads as in the design', ['Open on your phone', 'Scan with your phone on the same Wi-Fi', `${PH}/?k=••••••••`, '1 phone signed in', 'New key', 'New key signs every phone out.'].every((t) => texts.includes(t)), JSON.stringify(texts));
  // Decode the QR as drawn: the SVG onto a canvas, then jsQR.
  await dark.addScriptTag({ content: JSQR });
  const decoded = await dark.evaluate(async () => {
    const svg = document.querySelector('#phone-pop .qr-svg').outerHTML.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 336; c.height = 336;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 336, 336);
    const d = g.getImageData(0, 0, 336, 336);
    const q = window.jsQR(d.data, 336, 336);
    return q && q.data;
  });
  const want = `${PH}/?k=${KEY}`;
  check('the QR code decodes to the sign-in address', decoded === want, decoded === want ? `decoded ${PH}/?k=<key, ${KEY.length} chars, equal>` : `got ${decoded && decoded.replace(KEY, '<key>')}`);
  if (SHOTS) await dark.screenshot({ path: path.join(SHOTS, 'card-dark-1440.png') });
  await dark.keyboard.press('Escape');
  check('Escape closes the card', !(await dark.isVisible('#phone-pop')));
  await dark.click('#phone');
  await dark.waitForSelector('#phone-pop');
  await dark.mouse.click(300, 600);
  check('a click outside closes the card', !(await dark.isVisible('#phone-pop')));
  await dctx.close();

  const { ctx: lctx, page: light } = await macPage('light');
  await light.click('#phone');
  await light.waitForSelector('#phone-pop .qr-svg');
  const tileBg = await light.$eval('.qr-tile', (el) => getComputedStyle(el).backgroundColor);
  check('the QR tile is white in light too', tileBg === 'rgb(255, 255, 255)', tileBg);
  if (SHOTS) await light.screenshot({ path: path.join(SHOTS, 'card-light-1440.png') });
  await lctx.close();

  const { ctx: octx, page: offPage } = await macPage('dark', `http://127.0.0.1:${PORT_OFF}`);
  await offPage.click('#phone');
  await offPage.waitForSelector('#phone-pop .qr-tile.off');
  const offText = await offPage.$eval('#phone-pop', (el) => el.innerText);
  check('off Wi-Fi: the dashed tile, the warning and No network address', /Not on Wi-Fi, so phones can't reach the board/.test(offText) && /No network address/.test(offText));
  const offBox = await offPage.$eval('.qr-tile.off', (el) => [el.offsetWidth, el.offsetHeight].join('x'));
  check('off Wi-Fi: the tile keeps the QR tile size', offBox === '176x176', offBox);
  if (SHOTS) await offPage.screenshot({ path: path.join(SHOTS, 'card-off-wifi-1440.png') });
  await octx.close();

  // A phone: 390 wide, through the LAN address, scanning the code.
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const ph = await pctx.newPage();
  await ph.goto(want);
  await ph.waitForSelector('#pchips .pchip', { timeout: 10000 });
  check('the phone lands on / with the key gone from the address bar', ph.url() === `${PH}/`, ph.url().replace(KEY, '<key>'));
  await ph.waitForSelector('#toast:not([hidden])');
  check('the phone sees the one-time toast', (await ph.textContent('#toast')) === 'Signed in. This phone stays signed in until you press New key on the Mac.');
  await ph.waitForTimeout(300);
  check('the phone button is hidden on the phone', !(await ph.isVisible('#phone')));
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'phone-390-signed-in.png') });
  const ph2 = await pctx.newPage();
  await ph2.goto(`${PH}/`);
  await ph2.waitForSelector('#pchips .pchip');
  await ph2.waitForTimeout(400);
  check('the toast shows only once', await ph2.isHidden('#toast'));
  await ph2.close();

  // ------------------------------------------------------------ New key
  r = await req(MAC, { method: 'POST', path: '/api/phone/new-key', headers: { 'X-Ravenry': '1', 'Content-Type': 'application/json', Origin: MAC }, body: '{}' });
  const after = JSON.parse(fs.readFileSync(pf, 'utf8'));
  check('New key on the Mac: a new key, every phone forgotten', r.status === 200 && JSON.parse(r.body).phones === 0 && after.key !== KEY && after.tokens.length === 0 && !r.body.includes(after.key), `HTTP ${r.status}`);
  for (let i = 0; i < 20 && !sseEnded; i++) await sleep(100);
  check('the phone\'s live stream is closed', sseEnded);
  r = await req(PH, { path: '/api/state', headers: H });
  check('the old cookie now gets 401', r.status === 401 && JSON.parse(r.body).signedOut === true, `HTTP ${r.status}`);
  r = await req(PH, { path: '/', headers: H });
  check('the old cookie on the page gets the signed-out screen', r.status === 401 && /Signed out\. Scan the code on the Mac again\./.test(r.body), `HTTP ${r.status}`);
  r = await req(PH, { path: '/?k=' + encodeURIComponent(KEY) });
  check('the old key no longer signs in', r.status === 401 && !r.headers['set-cookie'], `HTTP ${r.status}`);
  await ph.waitForSelector('.signed-out', { timeout: 10000 });
  check('the open phone page turns into the signed-out screen', (await ph.textContent('.signed-out')).trim() === 'Signed out. Scan the code on the Mac again.');
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'phone-390-signed-out.png') });
  r = await req(MAC, { path: '/api/state' });
  check('loopback still works after New key, with no key', r.status === 200, `HTTP ${r.status}`);
  await pctx.close();

  // ------------------------------------------------------------ logs
  const logs = procs.map((p) => p.log).join('\n');
  check('the key never reaches the board\'s console', !logs.includes(KEY) && !logs.includes(after.key) && !logs.includes(tok));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  if (browser) await browser.close();
  for (const p of procs) p.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
