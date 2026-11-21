#!/usr/bin/env node
// On the phone, open a link and select and copy text (docs/FEATURES.md
// TERM-021, TERM-028; the approved picture "Tap opens, hold selects").
//
// 1. Unit checks: server/ravenryd.mjs joinLinks (a pane's OSC 8 runs, a
//    link cut by a soft wrap joined) and server/screenlinks.mjs (links put
//    on the entry lines that show them; http, https and file only).
// 2. A real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd) with a
//    throwaway HOME, runtime and state folder runs tools/fake-screen-claude.mjs
//    in a pane: a Claude Code screen with a plain URL, an OSC 8 web link, an
//    OSC 8 file link and file paths. A test board (scratch RAVENRY_HOME, the
//    stub process list) shows it. GET /api/live must carry the OSC 8 targets.
// 3. Headless Chrome at 390x844 with touch, the Live screen full screen:
//    - a tap on the URL and on the OSC 8 web link opens their target in a
//      new window (caught as a popup, answered by a stub: nothing browses);
//    - a tap on a path and on the OSC 8 file link copies the path (an
//      in-memory clipboard: the Mac's is never written) and rings it green;
//    - text selected in the screen holds it: a line fed meanwhile does not
//      show, the bar says Held; the system's Copy shows a "Copied" toast
//      over the screen above the key bar, the selection goes, the screen
//      catches up and the bar says Live;
//    - Select All selects only the screen's text;
//    - every toast is over the full-screen layer.
//    Screenshots of the three states, and the board at 1440 (no change there).
//
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] [CHROME_BIN=...] [PLAYWRIGHT=<module>] node tools/phone-links-test.mjs [--shots dir]
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { joinLinks } from '../server/ravenryd.mjs';
import { linkEntries, usableLinks } from '../server/screenlinks.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. units

{
  const rows = [
    { text: 'see x' },
    { text: 'a click and a.txt', links: [{ col: 2, width: 5, text: 'click', uri: 'https://r.dev/x' }, { col: 12, width: 5, text: 'a.txt', uri: 'file:///tmp/a.txt' }] },
    { text: '0123456789012345wrap', wrapped: true, links: [{ col: 16, width: 4, text: 'wrap', uri: 'https://r.dev/long' }] },
    { text: 'ped here', links: [{ col: 0, width: 3, text: 'ped', uri: 'https://r.dev/long' }] },
    { text: '0123456789012345 end', wrapped: true, links: [{ col: 0, width: 4, text: '0123', uri: 'https://r.dev/a' }] },
    { text: 'next', links: [{ col: 0, width: 4, text: 'next', uri: 'https://r.dev/a' }] },
  ];
  const got = joinLinks(rows, 20);
  check('unit: joinLinks gives each OSC 8 run with its text, target and line', JSON.stringify(got.slice(0, 2)) === JSON.stringify([{ t: 'click', u: 'https://r.dev/x', line: 'a click and a.txt' }, { t: 'a.txt', u: 'file:///tmp/a.txt', line: 'a click and a.txt' }]), JSON.stringify(got));
  check('unit: a link cut by a soft wrap is one link on the joined line', got[2] && got[2].t === 'wrapped' && got[2].line === '0123456789012345wrapped here', JSON.stringify(got[2]));
  check('unit: a link that does not reach the row\'s end does not run on into the next row', got.length === 5 && got[3].t === '0123' && got[4].t === 'next', JSON.stringify(got));
  const links = [{ t: 'the notes', u: 'https://n.dev/a', line: '  Notes: the notes, the log run.log.' }, { t: 'run.log', u: 'file:///tmp/run.log', line: '  Notes: the notes, the log run.log.' }, { t: 'mail me', u: 'mailto:a@b.c', line: 'mail me' }, { t: 'the notes', u: 'https://n.dev/b', line: 'other line with the notes' }];
  check('unit: only http, https and file links are kept', usableLinks(links).length === 3 && !usableLinks(links).some((k) => /^mailto/.test(k.u)));
  const es = linkEntries([{ k: 'c', l: ['Notes: the notes, the log run.log.', 'Again the notes here.'] }, { k: 't', n: 'Read', a: 'x' }], links);
  check('unit: links go on the entry line that shows them, only there', JSON.stringify(es[0].lk) === JSON.stringify([{ i: 0, t: 'the notes', u: 'https://n.dev/a' }, { i: 0, t: 'run.log', u: 'file:///tmp/run.log' }]) && !es[1].lk, JSON.stringify(es));
}

// ------------------------------------------------------------ 2. a pane and a board

const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  phone-links-test: no ravenryd at ${BIN} (set RAVENRYD_BIN)`); process.exit(fails ? 1 : 0); }
const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright');
const { chromium } = pw.default || pw;
const SHOTS = path.resolve(opt('--shots', path.join(ROOT, '.tmp', 'phone-links-shots')));
fs.mkdirSync(SHOTS, { recursive: true });

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'phone-links-'));
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const PROJ = path.join(HOME, 'Projects', 'signin-app');
const CLAUDE = path.join(HOME, '.claude', 'projects');
for (const d of [path.join(MC, 'events'), PROJ, CLAUDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'signin-app', name: 'signin-app', folder: PROJ, workspaces: [], brief: null }] }, null, 2));
const PS = path.join(T, 'stub-ps.json');
fs.writeFileSync(PS, '[]');
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const SID = '5e55107e-0000-4000-8000-00000000f1f1';

// The screen: what the approved picture shows, with an OSC 8 web link and
// an OSC 8 file link added.
const URL_PLAIN = 'https://signin-fix.example.dev/signin';
const URL_OSC8 = 'https://notes.example.dev/redirect';
const FILE_OSC8 = 'file:///tmp/signin-app/run%20log.txt';
const osc8 = (uri, text) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
const SCREEN = [
  '❯ Why does sign in loop back to the sign in page?',
  '',
  '⏺ The loop starts in the redirect after sign in. Let me read it.',
  '',
  '⏺ Read(src/auth/redirect.ts)',
  '  ⎿  Read 88 lines',
  '',
  '⏺ Update(src/auth/redirect.ts)',
  '  ⎿  Updated src/auth/redirect.ts with 12 additions',
  '',
  '⏺ Bash(npm test -- redirect)',
  '  ⎿  PASS test/auth/redirect.test.ts',
  '     … +6 lines (ctrl+o to expand)',
  '',
  '⏺ Found it. After sign in the redirect kept the old next value, so it sent you back to /signin and',
  '  looped.',
  '',
  '  It now drops next when it points at the sign in page. The change is in src/auth/redirect.ts:42,',
  '  the test in test/auth/redirect.test.ts.',
  '',
  `  Preview: ${URL_PLAIN}`,
  '',
  `  Notes: ${osc8(URL_OSC8, 'the redirect notes')}, and the log ${osc8(FILE_OSC8, 'run log.txt')}.`,
  '',
  '  To run the test yourself:',
  '',
  '  ! npm test -- redirect',
  '',
  '✻ Worked for 1m 12s',
];
const SCREEN_FILE = path.join(T, 'screen.json');
const setScreen = (lines) => fs.writeFileSync(SCREEN_FILE, JSON.stringify({ lines }));
setScreen(SCREEN);
// The reply in the session's transcript: its code spans (server/codespans.mjs).
const REPLY = 'Found it. After sign in the redirect kept the old `next` value, so it sent you back to `/signin` and looped.\n\nIt now drops `next` when it points at the sign in page. The change is in src/auth/redirect.ts:42, the test in test/auth/redirect.test.ts.\n\nPreview: https://signin-fix.example.dev/signin\n\nNotes: the redirect notes, and the log run log.txt.\n\nTo run the test yourself:\n\n`! npm test -- redirect`';
const TR = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'), `${SID}.jsonl`);
fs.mkdirSync(path.dirname(TR), { recursive: true });
fs.writeFileSync(TR, JSON.stringify({ type: 'assistant', uuid: 'u1', sessionId: SID, cwd: PROJ, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } }) + '\n');

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvpk-'));
const RUN = path.join(D, 'run');
const STATE = path.join(D, 'state');
const DENV = { HOME, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let board = null;
let boardLog = '';
let browser = null;
const cleanup = () => {
  if (board) board.kill('SIGKILL');
  daemon.kill('SIGTERM');
  try { for (const p of JSON.parse(fs.readFileSync(PS, 'utf8'))) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the test daemon is up', !!sock);
if (!sock) process.exit(1);
const c = await connectSocket(sock, { name: 'phone-links-test' });
const pane = (await c.request('pane.new', { cwd: PROJ, name: 'signin-app', cols: 100, rows: 40, command: [process.execPath, path.join(ROOT, 'tools', 'fake-screen-claude.mjs'), SCREEN_FILE, '--session-id', SID] })).pane.id;
const cap = await (async () => { for (let i = 0; i < 60; i++) { const r = await c.request('pane.capture', { pane, links: true }); if (r.lines.some((l) => l.links)) return r; await sleep(100); } return null; })();
const capLinks = cap ? cap.lines.flatMap((l) => l.links || []) : [];
check('daemon: pane.capture with links gives the screen\'s two OSC 8 links', capLinks.length === 2 && capLinks[0].uri === URL_OSC8 && capLinks[0].text === 'the redirect notes' && capLinks[1].uri === FILE_OSC8, JSON.stringify(capLinks));

const PORT = await freePort();
const env = withStubMachine({
  PATH: process.env.PATH, HOME, LANG: 'en_US.UTF-8', RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_CLAUDE_PROJECTS: CLAUDE, MC_CLAUDE_SETTINGS: SETTINGS, MC_CODEX: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools', 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'),
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools', 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl'),
  MC_APPS: 'ravenry', CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE,
});
fs.writeFileSync(env.FAKE_CMUX_STATE, JSON.stringify({ workspaces: [] }));
const base = `http://127.0.0.1:${PORT}`;
const surface = `ravenry:${pane}`;
board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
const getJson = async (p) => { const r = await fetch(base + p); return r.json(); };
let row = null;
for (let i = 0; i < 100 && !row; i++) {
  try { const st = await getJson('/api/state'); row = (st.projects.find((p) => p.id === 'signin-app') || { sessions: [] }).sessions.find((s) => s.surfaceId === surface) || null; } catch { /* starting */ }
  if (!row) await sleep(100);
}
check('board: the pane\'s session is a row of the project', !!row, boardLog.slice(-800));
if (!row) process.exit(1);
const live = async (want, ms = 8000) => {
  const end = Date.now() + ms;
  let j = null;
  while (Date.now() < end) { j = await getJson(`/api/live?surface=${encodeURIComponent(surface)}`); if (j.entries && want(j)) return j; await sleep(200); }
  return j;
};
const lk = (j) => (j && j.entries ? j.entries.flatMap((e) => e.lk || []) : []);
const j0 = await live((j) => lk(j).length >= 2);
check('api: /api/live carries the OSC 8 targets on the line that shows them', JSON.stringify(lk(j0).map((k) => [k.t, k.u])) === JSON.stringify([['the redirect notes', URL_OSC8], ['run log.txt', FILE_OSC8]]), JSON.stringify(lk(j0)));

// ------------------------------------------------------------ 3. the phone

const launch = { headless: true };
// A browser app (CHROME_BIN, an .app's binary) starts with the test's own
// folders, as the test guard asks of any app (tools/test-env.mjs).
if (process.env.CHROME_BIN) {
  launch.executablePath = process.env.CHROME_BIN;
  launch.env = { ...process.env, HOME: path.join(T, 'browser-home'), RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: STATE, RAVENRY_DESKTOP_DATA: path.join(T, 'browser-data') };
}
browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
// Nothing leaves the test: a page another host would serve is a stub.
await ctx.route((u) => !String(u).startsWith(base), (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
// The clipboard is in memory (the Mac's is never written): navigator.clipboard
// and execCommand('copy'), whose copy event fires as the browser fires it.
await ctx.addInitScript(() => {
  window.__copied = [];
  const clip = { writeText: (t) => { window.__copied.push(String(t)); return Promise.resolve(); }, readText: () => Promise.resolve(window.__copied.at(-1) || '') };
  Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => clip, configurable: true });
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (String(cmd).toLowerCase() !== 'copy') return exec.call(this, cmd, ...rest);
    const el = document.activeElement;
    const field = el && typeof el.value === 'string' && el.selectionStart != null;
    const text = field ? el.value.slice(el.selectionStart, el.selectionEnd) : String(getSelection());
    (field ? el : document).dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    window.__copied.push(text);
    return true;
  };
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const waitFor = async (fn, arg = null, ms = 8000) => { try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
await page.goto(`${base}/?theme=dark#signin-app`);
await page.waitForSelector('#lv-lines .e', { timeout: 15000 });
await waitFor(() => document.querySelectorAll('#lv-lines .lnk').length >= 2);
await page.tap('#lv-tap');
await waitFor(() => !document.querySelector('#lv-fs').hidden);
await page.waitForTimeout(400);
const bar = () => page.$eval('#lv-fs-bar [data-fresh]', (el) => ({ text: el.textContent.trim(), kind: el.className }));
const dom = await page.evaluate(() => ({
  links: Array.from(document.querySelectorAll('#lv-fs .lnk')).map((a) => [a.textContent, a.getAttribute('href'), a.target]),
  paths: Array.from(document.querySelectorAll('#lv-fs .fp')).map((f) => [f.textContent, f.dataset.lvChip]),
  dotted: (() => { const f = document.querySelector('#lv-fs .fp'); const cs = f && getComputedStyle(f); return cs ? `${cs.textDecorationLine} ${cs.textDecorationStyle}` : ''; })(),
  keys: !!document.querySelector('#lv-fs #lv-keys'),
}));
check('phone: the plain URL and the OSC 8 web link are links that open a new window', JSON.stringify(dom.links) === JSON.stringify([[URL_PLAIN, URL_PLAIN, '_blank'], ['the redirect notes', URL_OSC8, '_blank']]), JSON.stringify(dom.links));
check('phone: the paths and the OSC 8 file link are dotted paths that copy the file\'s path', JSON.stringify(dom.paths) === JSON.stringify([['src/auth/redirect.ts:42', 'src/auth/redirect.ts:42'], ['test/auth/redirect.test.ts', 'test/auth/redirect.test.ts'], ['run log.txt', '/tmp/signin-app/run log.txt']]) && dom.dotted === 'underline dotted', JSON.stringify(dom));
check('phone: the key bar is in full screen (a Ravenry pane)', dom.keys);
check('phone: the bar says Live', /^Live/.test((await bar()).text), JSON.stringify(await bar()));
await page.screenshot({ path: path.join(SHOTS, '1-tap-a-link.png') });

// Tap opens: a popup with the target, caught and closed (a stub answers it).
for (const [sel, want] of [[`#lv-fs a.lnk[href="${URL_PLAIN}"]`, URL_PLAIN], [`#lv-fs a.lnk[href="${URL_OSC8}"]`, URL_OSC8]]) {
  const t0 = Date.now();
  const [pop] = await Promise.all([page.waitForEvent('popup', { timeout: 5000 }).catch(() => null), page.tap(sel)]);
  const url = pop ? pop.url() : null;
  check(`phone: a tap on ${want === URL_PLAIN ? 'the URL' : 'the OSC 8 web link'} opens ${want} in a new window (${Date.now() - t0} ms)`, url === want, String(url));
  if (pop) await pop.close();
}
check('phone: full screen stays open after a link opened', await page.evaluate(() => !document.querySelector('#lv-fs').hidden));

// Tap copies a path, and it rings green with its check for 1.5 s.
for (const [text, want] of [['src/auth/redirect.ts:42', 'src/auth/redirect.ts:42'], ['run log.txt', '/tmp/signin-app/run log.txt']]) {
  await page.evaluate(() => { window.__copied.length = 0; });
  await page.tap(`#lv-fs .fp:text-is("${text}")`);
  await page.waitForTimeout(120);
  const v = await page.evaluate((t) => { const f = Array.from(document.querySelectorAll('#lv-fs .fp')).find((x) => x.textContent === t); const cs = getComputedStyle(f); return { copied: window.__copied.slice(), done: f.classList.contains('done'), ring: cs.boxShadow, color: cs.color, check: getComputedStyle(f, '::after').content, open: !document.querySelector('#lv-fs').hidden }; }, text);
  check(`phone: a tap on "${text}" copies ${want}`, JSON.stringify(v.copied) === JSON.stringify([want]), JSON.stringify(v.copied));
  check(`phone: "${text}" rings green with a check, as code does`, v.done && /48, 209, 88/.test(v.ring) && v.color === 'rgb(48, 209, 88)' && v.check !== 'none', JSON.stringify(v));
  if (text === 'src/auth/redirect.ts:42') await page.screenshot({ path: path.join(SHOTS, '1b-path-copied.png') });
  await page.waitForTimeout(1600);
  check(`phone: the green ring on "${text}" goes after 1.5 s`, await page.evaluate((t) => !Array.from(document.querySelectorAll('#lv-fs .fp')).find((x) => x.textContent === t).classList.contains('done'), text));
}

// Hold to select: text selected in the screen holds it still.
const selectIn = (needle) => page.evaluate((n) => {
  const walker = document.createTreeWalker(document.querySelector('#lv-lines'), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const i = node.textContent.indexOf(n);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + n.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return String(s);
  }
  return null;
}, needle);
const picked = await selectIn('It now drops ');
await page.waitForTimeout(100);
check('phone: a selection in the screen shows Held in the bar', picked === 'It now drops ' && (await bar()).text === 'Held' && /held/.test((await bar()).kind), JSON.stringify(await bar()));
const NEW = '⏺ One more line, written while the text was selected.';
const t1 = Date.now();
setScreen([...SCREEN, '', NEW]);
const j1 = await live((j) => j.entries.some((e) => (e.l || []).some((x) => x.includes('One more line'))));
const readMs = Date.now() - t1;
await page.waitForTimeout(2600); // more than one poll of the page after the board has the line
const held = await page.evaluate(() => ({ shown: document.querySelector('#lv-lines').textContent.includes('One more line'), sel: String(getSelection()) }));
check(`phone: a line fed while selected does not show (board had it after ${readMs} ms, page waited 2.6 s more)`, !!j1 && !held.shown, JSON.stringify(held));
check('phone: the selection survives the poll', held.sel === 'It now drops ', JSON.stringify(held.sel));
await page.screenshot({ path: path.join(SHOTS, '2-hold-to-select.png') });

// After Copy: the system's Copy (execCommand fires its copy event).
await page.evaluate(() => { window.__copied.length = 0; document.execCommand('copy'); });
await page.waitForTimeout(150);
const after = await page.evaluate(() => {
  const t = document.querySelector('#toast');
  const r = t.getBoundingClientRect();
  const keys = document.querySelector('#lv-keys').getBoundingClientRect();
  const screenBox = document.querySelector('#lv-scroll').getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { copied: window.__copied.slice(), hidden: t.hidden, text: t.textContent, check: !!t.querySelector('.tk svg'), onTop: !!(top && top.closest('#toast')), aboveKeys: r.bottom <= keys.top, overScreen: r.top >= screenBox.top && r.bottom <= screenBox.bottom, sel: String(getSelection()), z: [getComputedStyle(t).zIndex, getComputedStyle(document.querySelector('#lv-fs')).zIndex] };
});
check('phone: Copy copies the selected text', JSON.stringify(after.copied) === JSON.stringify(['It now drops ']), JSON.stringify(after.copied));
check('phone: a "Copied" toast with its check shows', !after.hidden && after.text === 'Copied' && after.check, JSON.stringify(after));
check('phone: the toast is over the full-screen layer, over the screen\'s text, above the key bar', after.onTop && after.aboveKeys && after.overScreen, JSON.stringify(after));
check('phone: after Copy the selection goes', after.sel === '', JSON.stringify(after.sel));
const caught = await waitFor(() => document.querySelector('#lv-lines').textContent.includes('One more line'), null, 3000);
check('phone: the screen catches up and the bar is back to Live', caught && /^Live/.test((await bar()).text), JSON.stringify(await bar()));
await page.screenshot({ path: path.join(SHOTS, '3-after-copy.png') });
await page.waitForTimeout(1600);
check('phone: the toast goes after 1.5 s', await page.evaluate(() => document.querySelector('#toast').hidden));

// Select All selects only the screen.
await page.evaluate(() => document.execCommand('selectAll'));
await page.waitForTimeout(100);
const all = await page.evaluate(() => ({ sel: String(getSelection()), screen: document.querySelector('#lv-lines').innerText }));
const outside = ['Back', 'Esc', 'Ctrl-C', 'Enter', 'Send', 'Add as note', 'Attach', 'New session', 'Projects'].filter((w) => all.sel.includes(w));
check('phone: Select All selects the screen\'s text', all.sel.includes('It now drops') && all.sel.includes('One more line') && all.sel.includes('Worked for 1m 12s'), all.sel.slice(0, 200));
check('phone: Select All selects nothing around the screen (bar, key bar, message box, the board behind)', outside.length === 0 && all.sel.replace(/\s+/g, ' ').trim() === all.screen.replace(/\s+/g, ' ').trim(), `found: ${outside.join(', ')} | ${all.sel.length} vs ${all.screen.length} chars`);
check('phone: Select All holds the screen too', (await bar()).text === 'Held');
await page.evaluate(() => getSelection().removeAllRanges());
await page.waitForTimeout(100);

// Every toast is over the full-screen layer (any message, not only Copied).
const anyToast = await page.evaluate(() => {
  const t = document.querySelector('#toast');
  t.textContent = 'A toast said in full screen'; t.hidden = false;
  const r = t.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const ps = document.createElement('div'); ps.className = 'ps-toast'; document.querySelector('#mc').append(ps);
  const z = [getComputedStyle(t).zIndex, getComputedStyle(ps).zIndex, getComputedStyle(document.querySelector('#lv-fs')).zIndex];
  ps.remove(); t.hidden = true;
  return { onTop: !!(top && top.closest('#toast')), z };
});
check('phone: any toast is seen over the full-screen layer (toast, session toast over every layer)', anyToast.onTop && Number(anyToast.z[0]) > Number(anyToast.z[2]) && Number(anyToast.z[1]) > Number(anyToast.z[2]), JSON.stringify(anyToast));
await page.tap('#lv-fs [data-lv-close]');
await page.waitForTimeout(300);
check('phone: no page errors', errs.length === 0, errs.join(' | '));
await page.close();

// The board at 1440: as before (no dotted paths, links as before).
const wide = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await wide.goto(`${base}/?theme=dark#signin-app`);
await wide.waitForSelector('#lv-lines .e', { timeout: 15000 });
await wide.waitForTimeout(800);
const w = await wide.evaluate(() => { const f = document.querySelector('#lv-lines .fp'); const cs = f && getComputedStyle(f); return { deco: cs ? cs.textDecorationLine : null, cursor: cs ? cs.cursor : null, bar: document.querySelector('#lv-card [data-fresh]').textContent.trim() }; });
check('desktop 1440: paths look as plain text', w.deco === 'none' && w.cursor !== 'pointer', JSON.stringify(w));
await wide.screenshot({ path: path.join(SHOTS, 'desktop-1440.png') });
await wide.close();
await browser.close();
c.close();
console.log(`shots: ${SHOTS}`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
