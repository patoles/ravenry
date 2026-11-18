#!/usr/bin/env node
// Records the phone apps' demo (src/demo.ts) from a real board: the hub in
// ../../hub on the made-up board of tools/demo.mjs --sample (a throwaway
// HOME, its own port, "Sample Mac" and devbox, sample projects only), read
// by the phone board in headless Chromium at a phone's width while every
// screen of its bottom bar is opened, then each of its three cards answered
// as the person would. What the board asked for and what the hub answered
// is written to src/demo/sample.json, the pick's pictures beside it, with
// every folder of this machine said as a sample's ("/Users/you"). Run it
// again when the board's API changes; the demo check (tools/demo-check.mjs)
// fails on a request the recording does not answer.
//
//   node tools/demo-sample.mjs
//
// Nothing here talks to the person's own board: the board is the sample's,
// on 127.0.0.1 and a port of its own.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BOAT } from './boat-scene.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
// Outside the repository: a project folder in it would be read as part of its git repository.
const WORK = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rv-sample-'));
const OUT = path.join(APP, 'src', 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 30000, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

const PORT = await freePort();
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('RAVENRY_')) delete env[k];
const demo = spawn(process.execPath, [path.join(HERE, 'demo.mjs'), '--sample', '--hold', '--port', String(PORT), '--dir', WORK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let demoLog = '';
demo.stdout.on('data', (d) => { demoLog += d; });
demo.stderr.on('data', (d) => { demoLog += d; });
const stop = () => { try { demo.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);

const HUB = `http://127.0.0.1:${PORT}`;
const get = async (p) => { const r = await fetch(HUB + p); return { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', bytes: Buffer.from(await r.arrayBuffer()) }; };
const getJson = async (p) => JSON.parse((await get(p)).bytes.toString('utf8'));
const post = async (p, body) => { const r = await fetch(HUB + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

try {
  const info = await until(() => (fs.existsSync(path.join(WORK, 'demo.json')) ? JSON.parse(fs.readFileSync(path.join(WORK, 'demo.json'), 'utf8')) : null), 90000);
  if (!info) throw new Error('the sample board did not start:\n' + demoLog.slice(-3000));
  // The sessions at work first, before notes-app's and recipe-box's cards open.
  await until(async () => { const s = await getJson('/api/state'); return s.projects.filter((p) => p.state === 'work').length >= 5 ? s : null; }, 30000);
  await sleep(2500);
  const before = await getJson('/api/state');
  fs.writeFileSync(path.join(WORK, 'go'), '');
  const cps = await until(async () => { const s = await getJson('/api/state'); const c = (s.checkpoints || []).filter((x) => x.state === 'open'); return c.length === 3 ? c : null; }, 60000);
  if (!cps) throw new Error('the three cards did not open');
  await sleep(3000);
  const byKind = Object.fromEntries(cps.map((c) => [c.kind, c]));

  // ---------------------------------------------------------------- the walk
  const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true });
  const recorded = new Map();
  const posts = [];
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: 'dark', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || u.pathname === '/api/events') return;
    if (r.request().method() !== 'GET') { posts.push(u.pathname); return; }
    try { recorded.set(u.pathname + u.search, { status: r.status(), type: r.headers()['content-type'] || '', bytes: await r.body() }); } catch { /* a stream */ }
  });
  const tap = async (sel, wait = 1200) => {
    const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
    if (!ok) console.log('not there:', sel);
    await page.waitForTimeout(wait);
    return ok;
  };
  await page.goto(HUB + '/');
  await page.waitForTimeout(3000);
  for (const p of before.projects) {
    await page.evaluate((id) => { location.hash = '#' + encodeURIComponent(id); }, p.id);
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { location.hash = ''; });
  await tap('#pchips [data-idle-open]');
  await tap('#idle-sheet [data-idle-close]', 600);
  for (const k of ['ideas', 'rules', 'ship', 'pages']) {
    await tap(`#bnav [data-pnav="${k}"]`, 1500);
    // One more screen of each: its first card.
    const first = { ideas: '#sheet [data-idea]', rules: '#sheet [data-rtab="sug"]', ship: '#sheet [data-goto]', pages: '#sheet button' }[k];
    await tap(first, 1500);
    await page.evaluate(() => window.ravenryBack && window.ravenryBack());
    await page.waitForTimeout(800);
  }
  await tap('#bnav [data-pnav="pages"]', 1200);
  await page.evaluate(() => { const b = document.querySelectorAll('#sheet button')[1]; if (b) b.click(); });
  await page.waitForTimeout(1500);
  await tap('[data-act="pn-search"]', 1200);
  await page.evaluate(() => window.ravenryBack && window.ravenryBack());
  await tap('#bnav [data-pnav="projects"]', 1200);
  await tap('#pb-more', 800);
  const menu = await page.evaluate(() => [...document.querySelectorAll('#pmenu [data-act]')].map((e) => e.dataset.act));
  for (const act of menu.filter((a) => /settings|search|sessions/i.test(a))) {
    await tap(`#pmenu [data-act="${act}"]`, 1500);
    await page.evaluate(() => window.ravenryBack && window.ravenryBack());
    await page.waitForTimeout(500);
    await tap('#pb-more', 600);
  }
  await page.evaluate(() => window.ravenryBack && window.ravenryBack());
  await browser.close();

  // What the app's own screens and the shell ask for.
  for (const p of ['/api/state', '/api/machines', '/api/phone/me', '/api/whoami']) if (!recorded.has(p)) recorded.set(p, await get(p));
  for (const c of cps) for (let n = 0; n < (c.variants || []).length; n++) recorded.set(`/api/checkpoints/${c.id}/variants/${n}`, await get(`/api/checkpoints/${c.id}/variants/${n}`));
  const open = await getJson('/api/state');
  const openLive = {};
  for (const p of open.projects) for (const s of p.sessions || []) openLive[s.surfaceId] = await getJson(`/api/live?surface=${encodeURIComponent(s.surfaceId)}`);

  // ---------------------------------------------------------------- the answers, as the person gives them
  const after = {};
  const answer = async (cp, body, wait) => {
    const r = await post('/api/checkpoints/answer', { id: cp.id, by: 'phone', ...body });
    if (r.status !== 200) throw new Error(`the ${cp.kind} was not answered: ${JSON.stringify(r.body)}`);
    const first = r.body.checkpoint;
    await sleep(wait);
    const st = await getJson('/api/state');
    const done = (st.checkpoints || []).find((c) => c.id === cp.id) || (await getJson('/api/checkpoints?all=1').catch(() => null))?.checkpoints?.find((c) => c.id === cp.id) || first;
    after[cp.id] = { answer: body, first, done, live: await getJson(`/api/live?surface=${encodeURIComponent(cp.surfaceId)}`) };
  };
  await answer(byKind.ask, { choice: 0 }, 3000);
  await answer(byKind.approve, { approve: true }, 7000);
  await answer(byKind.pick, { pick: { label: BOAT[1].label, region: { x: 0.4, y: 0.25, w: 0.3, h: 0.3 }, note: 'This, but less spray.' } }, 3000);
  const answered = await getJson('/api/state');

  // ---------------------------------------------------------------- written, said as a sample's
  const homes = before.homes || {};
  const swaps = [];
  for (const [machine, home] of Object.entries(homes)) if (home) swaps.push([home, machine ? '/home/you' : '/Users/you']);
  swaps.push([WORK, '/Users/you/.sample'], [fs.realpathSync(WORK), '/Users/you/.sample']);
  if (info.runtime) swaps.push([info.runtime, '/tmp/ravenry-sample']);
  // macOS says /var and /tmp as /private/var and /private/tmp too.
  for (const [from, to] of [...swaps]) if (/^\/(var|tmp)\//.test(from)) swaps.push(['/private' + from, to]);
  swaps.sort((a, b) => b[0].length - a[0].length);
  // A time in ms that reads as a card number (13 digits passing Luhn) moves on by a ms or two, so the
  // personal-data audit (tools/audit.mjs) has nothing to flag in a recording of made-up projects.
  const luhn = (d) => { let s = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; } return s % 10 === 0; };
  const unCard = (t) => t.replace(/(?<![\w.-])\d{13,16}(?![\w.-])/g, (n) => { let v = BigInt(n); while (luhn(String(v))) v++; return String(v); });
  // A content hash (a page's notes, 64 hex) cut to 16: the audit reads 32 hex and more as a key.
  const unHex = (t) => t.replace(/\b([0-9a-f]{16})[0-9a-f]{16,}\b/g, '$1');
  const said = (text) => { let t = text; for (const [from, to] of swaps) t = t.split(from).join(to); return unHex(unCard(t)); };
  const body = (r) => {
    const type = r.type || '';
    if (/json/.test(type)) {
      const json = JSON.parse(said(r.bytes.toString('utf8')));
      // As a phone hears it: never this Mac's own board.
      if (json && json.local === true) json.local = false;
      return { status: r.status, json };
    }
    if (/^text\//.test(type)) return { status: r.status, type, text: said(r.bytes.toString('utf8')) };
    return { status: r.status, type, file: null, bytes: r.bytes };
  };
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f !== 'README.md') fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
  const get_ = {};
  let n = 0;
  for (const [k, r] of [...recorded].sort()) {
    const key = k.replace(/[?&]v=[^&]*/g, (m) => (m[0] === '?' ? '?' : '')).replace(/\?&/, '?').replace(/\?$/, '');
    const b = body(r);
    if (b.bytes) {
      // A picture: a file of its own beside the recording.
      const ext = /png/.test(b.type) ? 'png' : /jpe?g/.test(b.type) ? 'jpg' : /svg/.test(b.type) ? 'svg' : /webp/.test(b.type) ? 'webp' : 'bin';
      const v = recorded.get(k);
      const name = `f${++n}.${ext}`;
      fs.writeFileSync(path.join(OUT, name), v.bytes);
      get_[key] = { status: b.status, type: b.type, file: name };
    } else get_[key] = b;
  }
  // Who this phone is, as a paired phone hears it (the recording's browser is not one).
  get_['/api/phone/me'] = { status: 200, json: { ok: true, device: { id: 'sample', name: 'this phone', push: null }, hub: { name: 'Sample Mac', port: null, api: 1 }, access: true } };
  const lives = (o) => JSON.parse(said(JSON.stringify(o)));
  const sample = {
    $comment: 'The phone apps\' demo (src/demo.ts), recorded from the sample board by tools/demo-sample.mjs. Do not edit by hand: record it again.',
    capturedAt: Date.parse(open.generatedAt),
    ask: byKind.ask.id, approve: byKind.approve.id, pick: byKind.pick.id,
    open: lives({ state: open, live: openLive }),
    after: lives(after),
    answered: lives({ checkpoints: answered.checkpoints }),
    get: get_,
    posts: [...new Set(posts)],
  };
  const text = JSON.stringify(sample);
  // Nothing of this machine: every folder is a sample's.
  const leaks = [WORK, fs.realpathSync(WORK), process.env.HOME, '/private/', '/var/folders/'].filter((s) => s && text.includes(s));
  if (leaks.length) throw new Error('the recording still says ' + leaks.map((l) => { const i = text.indexOf(l); return text.slice(Math.max(0, i - 120), i + 120); }).join('\n'));
  fs.writeFileSync(path.join(OUT, 'sample.json'), text + '\n');
  console.log(`recorded ${Object.keys(get_).length} answers (${n} pictures), ${Math.round(text.length / 1024)} KB, in ${path.relative(process.cwd(), OUT)}; the board also posted: ${sample.posts.join(', ') || 'nothing'}`);
} finally {
  stop();
  await sleep(1500);
  fs.rmSync(WORK, { recursive: true, force: true });
}
