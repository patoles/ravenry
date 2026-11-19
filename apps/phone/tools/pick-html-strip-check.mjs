#!/usr/bin/env node
// A pick whose variants are .html pages, on the phone board: the strip of
// pictures under the viewer draws each page as the picture the hub draws of
// it (GET variants/<n>?as=png, hub/server/pagepicture.mjs), as the board's
// tiles and the Mac app do. Before, a page's place in the strip was empty.
//
// Headless, against a made-up board on a throwaway HOME
// (apps/desktop/tools/demo-hub.mjs, 127.0.0.1) started without Playwright,
// as the installed app's hub (hub/tools/no-playwright.mjs), where
// paper-boat's session waits on a real `ravenry pick` of two pages in a
// real ravenryd pane. The pages: PICK_HTML=a.html:b.html, else two made
// here (dark, with data: pictures).
//
//   node tools/pick-html-strip-check.mjs [OUT]     (after node build.mjs)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(APP_DIR, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(APP_DIR, '.tmp', 'pick-html-strip-check'));
const WORK = path.join(APP_DIR, '.tmp', 'pick-html-strip-work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const { chromium } = createRequire(path.join(REPO, 'hub', 'package.json'))('playwright');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvh-'));
fs.chmodSync(RT, 0o700);
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

// Two dark pages of data: pictures (one colour each), if none are given.
function solidPng(w, h, c) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let PAGES = (process.env.PICK_HTML || '').split(':').filter(Boolean);
if (PAGES.length !== 2) PAGES = [[255, 140, 0], [40, 160, 255]].map((c, n) => {
  const img = `data:image/png;base64,${solidPng(300, 600, c).toString('base64')}`;
  const f = path.join(WORK, `page-${'ab'[n]}.html`);
  fs.writeFileSync(f, `<!doctype html><html><body style="background:#111;color:#eee;font:600 28px sans-serif;margin:24px"><h2>${'AB'[n]}: a page</h2><div style="display:flex;gap:16px;overflow-x:auto">${`<img src="${img}" style="height:420px">`.repeat(4)}</div></body></html>`);
  return f;
});
const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;

const localEnv = { HOME: WORK, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
let hub = null, serve = null, browser = null;
try {
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
  // The hub without Playwright, as the installed app's.
  hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), runtime: RT, alerts: false, panes: ['paper-boat'], env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), NODE_OPTIONS: `--import=${path.join(REPO, 'hub', 'tools', 'no-playwright.mjs')}` } });
  const s = hub.sessions['paper-boat'];
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const script = path.join(WORK, 'session.sh');
  fs.writeFileSync(script, [hook('SessionStart'), hook('UserPromptSubmit'),
    `'${BIN}' pick ${q('App Store screenshots: which one leads?')} --variant ${q(`A=${PAGES[0]}`)} --variant ${q(`B=${PAGES[1]}`)} --describe ${q('A=A question waiting for you comes first')} --describe ${q('B=The whole board comes first, then the question')} --timeout 30m >/dev/null 2>&1`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  execFileSync(BIN, ['new', '--cwd', s.folder, '--name', 'App Store shots', '--size', '90x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', script], { env: localEnv });
  const cp = await until(async () => { const st = await hub.state(); return (st.checkpoints || []).find((c) => c.kind === 'pick' && c.state === 'open' && c.projectId === 'paper-boat') || null; }, 30000);
  check('pick_of_two_pages_on_the_board', !!cp && cp.variants.every((v) => v.type === 'html'), cp ? `${cp.id}: ${cp.variants.map((v) => v.type).join(', ')}` : 'no open pick on paper-boat');
  if (!cp) throw new Error('no pick');

  const PORT = await freePort();
  serve = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT), '--hub', hub.url], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: WORK } });
  await until(() => fetch(`http://127.0.0.1:${PORT}/phone/`).then((r) => r.ok), 10000);
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => check('phone_no_page_error', false, e.message));
  await p.goto(`http://127.0.0.1:${PORT}/phone/#/cp/${encodeURIComponent(cp.id)}`);
  await until(() => p.evaluate(() => document.querySelectorAll('.ptrack .pimg').length === 2), 15000);
  await p.screenshot({ path: path.join(OUT, 'phone-pick.png') });
  // The viewer, on A (a page's frame takes the taps inside it, so the slide is clicked as its handler is).
  await p.evaluate(() => document.querySelector('.ptrack .pimg').click());
  const strip = await until(() => p.evaluate(() => {
    const th = [...document.querySelectorAll('.pzv-strip .pzv-th')];
    if (th.length !== 2) return null;
    const ims = th.map((t) => t.querySelector('img'));
    return ims.every((i) => i && i.complete && i.naturalWidth > 0) ? ims.map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight })) : null;
  }), 20000);
  const seen = strip || await p.evaluate(() => [...document.querySelectorAll('.pzv-strip .pzv-th')].map((t) => t.innerHTML.slice(0, 120)));
  check('phone_strip_draws_each_page', !!strip && strip.every((x) => /\/variants\/\d\?as=png$/.test(x.src) && x.w * 10 === x.h * 16), JSON.stringify(seen));
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, 'phone-viewer-strip.png') });
  await ctx.close();
} catch (e) {
  check('ran', false, e.stack || e.message);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  serve?.kill();
  hub?.stop();
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: localEnv, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
}
console.log(`pick-html-strip-check: ${failed} failed; pictures in ${OUT}`);
process.exit(failed ? 1 : 0);
