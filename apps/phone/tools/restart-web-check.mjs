#!/usr/bin/env node
// Resume after a restart on the phone (docs/FEATURES.md SESS-053, the
// phone board): the hub's board at 390 px in headless Chromium, signed in as
// a phone on the Mac's Wi-Fi (hub/tools/as-phone.mjs, so every request
// meets the checks a phone meets), on a made-up board of its own in the
// system's temp folder (apps/desktop/tools/demo-hub.mjs: its own HOME, a
// fake cmux, a stub ps), with its own ravenryd and stand-ins for `claude`
// and `codex` first on its PATH (each writes what it was started with,
// where, then reports SessionStart through `ravenryd hook`). As
// hub/tools/restart-test.mjs: a running-sessions file from an older boot,
// MC_BOOT_TIME for this one. Nothing real is read, started or resumed; it
// never opens a window.
//
//   node tools/restart-web-check.mjs [OUT]
//
// RAVENRY_PLAYWRIGHT (a playwright index.mjs) and RAVENRY_CHROME (a Chrome
// binary) pick the browser; by default the hub's Playwright and its Chromium.
//
// It checks, by the person's taps and what the screen shows:
// - the card sits at the top of Projects, over the project chips: its
//   title, the short body, the four rows in order (project, the Mid-turn
//   tag, Resume, topic, chip, "Ran ..."), the mid-turn note, Resume all 4,
//   the phone's note and Dismiss; the Mac's long words are not on it;
// - Resume all posts {} to /api/restart/resume with the board's headers;
//   the rows go Back, Resuming, Next one at a time in order, the button
//   says "Resuming 2 of 4..." and is disabled;
// - Show on a row that is back opens that session's project and its Live
//   screen (on a second phone);
// - the stand-ins ran with their assistant and model, in their folders, in
//   the card's order;
// - once all are back the card goes and the toast says "All 4 sessions are
//   back.".
// - a wide board on the Mac itself shows it at the top of the list, with
//   the Mac's words (body, dismissNote).
// - at an iPad's width (768 and 1024) every project name is whole on one
//   line (scrollWidth <= clientWidth), the Mid-turn tag beside or under it;
// - the all-back toast has its check.
// Pictures at 390 x 844 in OUT: the card dark and light, mid-resume, Show's
// Live screen and all back; and the wide board.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freePort, lanAddress, phoneEnv, phoneProxy } from '../../../hub/tools/as-phone.mjs';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const HUBDIR = path.join(REPO, 'hub');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'restart-web-check'));
// In the system's temp folder: a board whose data is there may take the phone stand-in (hub/server/testphone.mjs).
const WORK = path.join(os.tmpdir(), 'ravenry-restart-web');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
const pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(HUBDIR, 'package.json'))('playwright');
const LAN = lanAddress();
if (!LAN) { console.error('This check needs a private Wi-Fi address on this Mac (only named in the Host header; nothing listens there).'); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 900)}` : ''}`); if (!ok) failed++; };
async function until(fn, ms = 15000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

// ---- the daemon and the stand-ins
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const RT = fs.mkdtempSync(path.join(SHORT, 'rvw-'));
fs.chmodSync(RT, 0o700);
const DHOME = path.join(WORK, 'daemon-home');
fs.mkdirSync(DHOME, { recursive: true });
const DENV = { HOME: DHOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'daemon-state') };
const STAND = path.join(WORK, 'standin');
const RAN = path.join(WORK, 'ran.log');
fs.mkdirSync(STAND, { recursive: true });
// `name|folder|args` in RAN, then SessionStart after 2 s: long enough to see each one resuming.
for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(STAND, name), `#!/bin/sh
printf '%s|%s|%s\\n' '${name}' "$PWD" "$*" >> '${RAN}'
printf '${name} stand-in: %s\\n' "$*"
sid=''; prev=''
for a in "$@"; do if [ "$prev" = --resume ] || [ "$prev" = resume ]; then sid="$a"; fi; prev="$a"; done
(sleep 2; printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"resume"}' "$sid" "$PWD" | '${BIN}' hook --assistant ${name} >/dev/null 2>&1) &
exec cat
`, { mode: 0o755 });
}
const ran = () => (fs.existsSync(RAN) ? fs.readFileSync(RAN, 'utf8').trim().split('\n').filter(Boolean) : []);

// ---- the sessions that ran before the restart (as hub/tools/restart-test.mjs)
const S = {
  boat: 'b2b2b2b2-0000-4000-8000-0000000000b2',
  notes: 'c3c3c3c3-0000-4000-8000-0000000000c3',
  harbour: 'd4d4d4d4-0000-4000-8000-0000000000d4',
  garden: 'a1a1a1a1-0000-4000-8000-0000000000a1',
};
const NOW_BOOT = Math.floor(Date.now() / 1000) - 600;
const OLD_BOOT = NOW_BOOT - 86400;
const entry = (sid, id, assistant, model, topic, ranMin, extra = {}) => ({ sessionId: sid, assistant, model, folder: null, projectId: id, project: id, topic, startedAt: ago(ranMin + 12), lastSeenAt: ago(12), working: false, doing: null, ...extra });
const BEFORE = [
  entry(S.boat, 'paper-boat', 'claude', 'claude-opus-5-5', 'Tilting the hull', 130, { working: true, doing: 'rendering the tilt frames' }),
  entry(S.notes, 'notes-app', 'claude', 'claude-opus-5-5', 'Sync settings', 45),
  entry(S.harbour, 'harbour-light', 'codex', 'gpt-5.4', 'Run the tests before the commit', 80),
  entry(S.garden, 'garden-planner', 'claude', 'claude-opus-5-5', 'Planting reminders', 25),
];
const ORDER = ['paper-boat', 'notes-app', 'harbour-light', 'garden-planner'];
const PROJECTS = [...ORDER, 'kite', 'moss', 'trail-map', 'portfolio'];

let hub = null;
let browser = null;
const pictures = [];
try {
  execFileSync(BIN, ['serve', '--detach'], { env: DENV });
  const STANDIN = await freePort();
  hub = await startDemoHub({
    dir: path.join(WORK, 'board'), port: await freePort(), runtime: RT, empty: true,
    extra: PROJECTS.map((id) => ({ id, name: id })),
    env: { PATH: `${STAND}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, MC_NO_EVENTS: '0', MC_CODEX: '1', RAVENRY_DAEMON_BIN: BIN, RAVENRY_TERMINAL: 'ravenry', RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), MC_BOOT_TIME: String(NOW_BOOT), RAVENRY_HUB_NAME: 'MacBook Pro', LANG: 'en_US.UTF-8', ...phoneEnv(STANDIN) },
    prepare: ({ ROOT, MC }) => {
      const sessions = BEFORE.map((e) => ({ ...e, folder: path.join(ROOT, e.projectId) }));
      fs.writeFileSync(path.join(MC, 'running.json'), JSON.stringify({ boot: OLD_BOOT, writtenAt: ago(12), sessions }, null, 2));
      for (const e of sessions) {
        const ev = (event, m, more = {}) => JSON.stringify({ at: ago(m), event, session_id: e.sessionId, assistant: e.assistant, cwd: e.folder, terminal: 'ravenry', ...more });
        fs.writeFileSync(path.join(MC, 'events', `${e.sessionId}.jsonl`), [ev('SessionStart', 200, { source: 'startup' }), ev('UserPromptSubmit', 190)].join('\n') + '\n');
      }
      fs.writeFileSync(path.join(WORK, 'board', 'stub-ps.json'), '[]');
    },
  });
  const card0 = await until(async () => (await hub.state()).restart, 20000);
  check('board_has_the_card', !!card0 && card0.phase === 'offer' && card0.count === 4, card0 ? card0.phase : hub.log().slice(-1500));
  if (!card0) throw new Error('no card');

  // The phone signs in through the Mac's Wi-Fi address (phone access on, its key).
  const base = hub.url;
  const PH = `http://${LAN}:${new URL(base).port}`;
  await fetch(base + '/api/phone/access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  await fetch(base + '/api/phone');
  const KEY = JSON.parse(fs.readFileSync(path.join(hub.home, '.ravenry', 'phone.json'), 'utf8')).key;
  fs.mkdirSync(path.join(WORK, 'browser-home'), { recursive: true });
  const browserEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(WORK, 'browser-home'), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', RAVENRY_DESKTOP_DATA: path.join(WORK, 'browser-home', 'app-data') };
  browser = await pw.chromium.launch({ headless: true, env: browserEnv, ...(process.env.RAVENRY_CHROME ? { executablePath: process.env.RAVENRY_CHROME } : {}) });
  const ctx = (scheme = 'dark') => browser.newContext({ proxy: phoneProxy(STANDIN), viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  const c = await ctx();
  const p = await c.newPage();
  const posts = [];
  p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/restart\//.test(r.url())) posts.push({ path: new URL(r.url()).pathname, body: r.postData(), headers: r.headers() }); });
  p.on('pageerror', (e) => check('no_page_error', false, e.message));
  await p.goto(`${PH}/?k=${encodeURIComponent(KEY)}`);
  const who = await p.evaluate(async () => (await (await fetch('/api/whoami')).json()).local);
  check('signed_in_as_a_phone', who === false, `whoami local ${who}`);
  await p.waitForSelector('#restart .rs-card', { timeout: 20000 });
  await p.waitForSelector('#pchips .pchip', { timeout: 20000 });
  const shot = async (name, page = p, { toast = false } = {}) => {
    const f = path.join(OUT, name + '.png');
    if (!toast) await page.evaluate(() => { for (const t of document.querySelectorAll('#toast, #ps-toast')) t.hidden = true; });
    await page.waitForTimeout(250);
    await page.screenshot({ path: f });
    pictures.push(f);
  };
  // What the card shows, read off the screen.
  const read = (page = p) => page.evaluate(() => {
    const el = document.querySelector('#restart .rs-card');
    if (!el) return null;
    const tx = (s, r = el) => { const x = r.querySelector(s); return x ? x.innerText.replace(/\s+/g, ' ').trim() : null; };
    const all = el.querySelector('[data-rs-all]');
    return {
      title: tx('h2'), sub: tx('.rs-sub'), note: tx('.rs-fn'), all: all.innerText.trim(), allDisabled: all.disabled, allSpin: !!all.querySelector('.rs-spin'), dismiss: tx('[data-rs-dismiss]'),
      rows: [...el.querySelectorAll('.rs-row')].map((r) => ({
        state: [...r.classList].find((k) => k.startsWith('s-')).slice(2), project: tx('.rs-pj', r), tag: tx('.rs-tag', r), topic: tx('.rs-tp', r), chip: tx('.rs-chip', r), b: tx('.rs-b', r),
        right: [...r.querySelectorAll('.rs-a > .btn, .rs-a > .rs-st, .rs-a > .rs-lk')].map((x) => x.innerText.trim()).join('|'), note: tx('.rs-note', r), spin: !!r.querySelector('.rs-st.run .rs-spin'), check: !!r.querySelector('.rs-st.ok svg'),
      })),
    };
  });

  // ---- 01: the card at the top of Projects
  const v0 = await read();
  const geo = await p.evaluate(() => {
    const card = document.querySelector('#restart .rs-card').getBoundingClientRect();
    const chips = document.querySelector('#pchips').getBoundingClientRect();
    const sheet = document.querySelector('#sheet').getBoundingClientRect();
    return { cardTop: card.top, cardBottom: card.bottom, cardLeft: card.left, cardRight: card.right, chipsTop: chips.top, sheetTop: sheet.top, scrollW: document.documentElement.scrollWidth };
  });
  check('card_at_the_top_of_projects', geo.cardTop < 200 && geo.cardBottom <= geo.chipsTop + 1 && geo.chipsTop < geo.sheetTop && geo.cardLeft >= 8 && geo.cardRight <= 382 && geo.scrollW <= 390, JSON.stringify(geo));
  check('card_title_and_short_body', v0.title === card0.title && v0.title === '4 sessions were running before the restart' && v0.sub === card0.bodyShort && /^This Mac restarted at \d{1,2}:\d\d\. Each one picks up its conversation in its folder, with its assistant\.$/.test(v0.sub), JSON.stringify([v0.title, v0.sub]));
  check('four_rows_in_order', v0.rows.map((r) => r.project).join(',') === ORDER.join(','), v0.rows.map((r) => r.project).join(','));
  const [r0, r1, r2, r3] = v0.rows;
  check('row_words', r0.tag === 'Mid-turn' && r0.topic === 'Tilting the hull' && r0.chip === 'Claude Opus 5.5' && r0.b === 'Claude Opus 5.5 Ran 2 h 10 min' && r0.right === 'Resume'
    && r1.tag === null && r1.topic === 'Sync settings' && r1.b === 'Claude Opus 5.5 Ran 45 min'
    && r2.topic === 'Run the tests before the commit' && r2.b === 'Codex gpt-5.4 Ran 1 h 20 min'
    && r3.topic === 'Planting reminders' && r3.b === 'Claude Opus 5.5 Ran 25 min' && v0.rows.every((r) => r.state === 'waiting' && r.right === 'Resume'), JSON.stringify(v0.rows));
  check('mid_turn_note_under_its_row', r0.note === 'It stopped in the middle of a turn. Resuming opens the conversation where it was; it does not run that turn again. Tell it to go on.' && [r1, r2, r3].every((r) => r.note === null), r0.note);
  check('buttons_and_phone_note', v0.all === 'Resume all 4' && !v0.allDisabled && v0.note === 'They resume in Ravenry panes on your Mac. You watch and type from here.' && v0.dismiss === 'Dismiss', JSON.stringify([v0.all, v0.note, v0.dismiss]));
  const text0 = await p.evaluate(() => document.querySelector('#restart').innerText);
  check('no_mac_words_no_doing_no_dashes', !text0.includes(card0.body) && !text0.includes(card0.dismissNote) && !/Was working|At its prompt/.test(text0) && !/\u2014/.test(text0), text0.slice(0, 300));
  await shot('01-card-dark');

  // ---- 01b: light, on a second phone (from the menu's Theme, as a person picks it)
  const cl = await ctx('light');
  const pl = await cl.newPage();
  pl.on('pageerror', (e) => check('no_page_error_light', false, e.message));
  await pl.goto(`${PH}/?k=${encodeURIComponent(KEY)}`);
  await pl.waitForSelector('#restart .rs-card', { timeout: 20000 });
  await pl.tap('#pb-more');
  await pl.tap('[data-theme-pick="light"]');
  await pl.tap('[data-act="pn-menu-close"]');
  check('light_theme', await pl.evaluate(() => document.querySelector('#mc').classList.contains('light')));
  await shot('02-card-light', pl);

  // ---- 02b: a wide board on the Mac itself: the card at the top of the list, with the Mac's words
  const cw = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const pw2 = await cw.newPage();
  await pw2.goto(base + '/');
  await pw2.waitForSelector('#list .rs-card', { timeout: 20000 });
  const wide = await until(() => pw2.evaluate(() => { const el = document.querySelector('#list .rs-card'); const t = el.innerText; return el.getBoundingClientRect().width > 200 && el.parentElement.firstElementChild === el && /restarted at .* and they stopped/.test(t) ? { sub: el.querySelector('.rs-sub').innerText, fn: el.querySelector('.rs-fn').innerText } : null; }), 10000);
  check('wide_card_at_the_top_of_the_list', !!wide && wide.sub === card0.body && wide.fn === card0.dismissNote, JSON.stringify(wide));
  await shot('06-wide-dark', pw2);
  await cw.close();

  // ---- 02c: an iPad's width (768 and 1024): every project name whole, the Mid-turn tag beside it or under it, never over it
  for (const [w, hgt] of [[768, 1024], [1024, 768]]) {
    const ci = await browser.newContext({ proxy: phoneProxy(STANDIN), viewport: { width: w, height: hgt }, deviceScaleFactor: 2, hasTouch: true, colorScheme: 'dark' });
    const pi = await ci.newPage();
    pi.on('pageerror', (e) => check(`no_page_error_${w}`, false, e.message));
    await pi.goto(`${PH}/?k=${encodeURIComponent(KEY)}`);
    await pi.waitForSelector('#list .rs-card .rs-pj', { timeout: 20000 });
    const names = await pi.evaluate(() => [...document.querySelectorAll('#list .rs-card .rs-row')].map((r) => {
      const pj = r.querySelector('.rs-pj');
      const tag = r.querySelector('.rs-tag');
      const range = document.createRange();
      range.selectNodeContents(pj);
      const a = pj.getBoundingClientRect();
      const t = tag && tag.getBoundingClientRect();
      return { name: pj.textContent, sw: pj.scrollWidth, cw: pj.clientWidth, lines: range.getClientRects().length, clear: !t || t.left >= a.right - 0.5 || t.top >= a.bottom - 0.5 };
    }));
    check(`ipad_${w}_names_never_cut`, names.length === 4 && names.map((x) => x.name).join(',') === ORDER.join(',') && names.every((x) => x.sw <= x.cw && x.lines === 1 && x.clear), JSON.stringify(names));
    await shot(`07-ipad-${w}-dark`, pi);
    await ci.close();
  }

  // ---- 03: Resume all, one at a time
  await p.evaluate(() => {
    window.__rs = [];
    const look = () => {
      const rows = [...document.querySelectorAll('#restart .rs-row')].map((r) => [...r.classList].find((k) => k.startsWith('s-')).slice(2));
      const b = document.querySelector('#restart [data-rs-all]');
      const k = JSON.stringify([rows, b ? b.innerText.trim() : null, b ? b.disabled : null]);
      if (window.__rs[window.__rs.length - 1] !== k) window.__rs.push(k);
    };
    window.__rsT = setInterval(look, 30);
    look();
  });
  await p.tap('#restart [data-rs-all]');
  const post0 = await until(() => posts.find((x) => x.path === '/api/restart/resume'), 5000);
  check('resume_all_posted', !!post0 && JSON.stringify(JSON.parse(post0.body || 'null')) === '{}' && post0.headers['x-ravenry'] === '1' && /application\/json/.test(post0.headers['content-type'] || ''), JSON.stringify(post0 && { body: post0.body, h: post0.headers['x-ravenry'] }));
  // Mid-resume: the first back, the second resuming, the others next.
  const mid = await until(async () => { const v = await read(); return v && v.rows[0].state === 'back' && v.rows[1].state === 'resuming' && v.rows[2].state === 'next' && v.rows[3].state === 'next' ? v : null; }, 20000, 40);
  if (mid) await shot('03-resuming-dark');
  check('mid_resume_rows', !!mid && mid.rows[0].right === 'Back|Show' && mid.rows[0].check && mid.rows[0].note === null && mid.rows[1].right === 'Resuming...' && mid.rows[1].spin && mid.rows[2].right === 'Next' && mid.rows[3].right === 'Next', JSON.stringify(mid && mid.rows.map((r) => [r.state, r.right, r.note && 'note'])));
  check('mid_resume_button', !!mid && mid.all === 'Resuming 2 of 4...' && mid.allDisabled && mid.allSpin, JSON.stringify(mid && [mid.all, mid.allDisabled, mid.allSpin]));

  // Show on a back row, on the second phone: paper-boat's page and its Live screen.
  const showable = await until(() => pl.evaluate(() => { const b = document.querySelector('#restart .rs-row[data-rs-row="b2b2b2b2-0000-4000-8000-0000000000b2"] [data-rs-show]'); return !!b; }), 10000, 50);
  if (showable) await pl.tap('#restart [data-rs-show="b2b2b2b2-0000-4000-8000-0000000000b2"]');
  const shown = await until(() => pl.evaluate(() => ({ h1: (document.querySelector('#d-head h1') || {}).textContent, full: !document.querySelector('#lv-fs').hidden, lines: (document.querySelector('#lv-lines') || {}).innerText || '' })).then((x) => (x.h1 === 'paper-boat' && x.full && /claude stand-in: .*--resume b2b2b2b2/.test(x.lines) ? x : null)), 20000, 200);
  check('show_opens_the_session', !!shown, JSON.stringify(shown || await pl.evaluate(() => ({ h1: (document.querySelector('#d-head h1') || {}).textContent, full: !document.querySelector('#lv-fs').hidden }))));
  if (shown) await shot('04-show-live-light', pl);

  // ---- 05: all back: the card goes, the toast shows
  const toastSeen = await until(() => p.evaluate(() => { const t = document.querySelector('#toast'); return !document.querySelector('#restart .rs-card') && t && !t.hidden ? t.textContent : null; }), 60000, 50);
  check('card_goes_and_toast', toastSeen === 'All 4 sessions are back.', String(toastSeen));
  check('toast_check_icon', await p.evaluate(() => !!document.querySelector('#toast .rs-ti svg')));
  if (toastSeen) await shot('05-all-back-dark', p, { toast: true });
  const seen = (await p.evaluate(() => { clearInterval(window.__rsT); return window.__rs; })).map((k) => JSON.parse(k));
  const states = seen.map((x) => x[0]).filter((s) => s.length === 4);
  check('never_two_resuming', states.every((s) => s.filter((x) => x === 'resuming').length <= 1), JSON.stringify(states.slice(0, 8)));
  const firstBack = [0, 1, 2, 3].map((i) => states.findIndex((s) => s[i] === 'back'));
  const firstRun = [0, 1, 2, 3].map((i) => states.findIndex((s) => s[i] === 'resuming'));
  // The last one's Back is the card going (all back: done).
  check('back_one_at_a_time_in_order', firstRun.every((v, i) => v >= 0 && (i === 0 || v > firstRun[i - 1])) && [0, 1, 2].every((i) => firstBack[i] > firstRun[i] && firstBack[i] === firstRun[i + 1]) && !!toastSeen, JSON.stringify({ firstBack, firstRun }));
  const words = [...new Set(seen.map((x) => x[1]).filter(Boolean))];
  check('button_counts_up', ['Resume all 4', 'Resuming 1 of 4...', 'Resuming 2 of 4...', 'Resuming 3 of 4...', 'Resuming 4 of 4...'].every((w) => words.includes(w)), words.join(' / '));
  const lines = ran();
  const want = [
    ['claude', 'paper-boat', `--model claude-opus-5-5 --resume ${S.boat}`],
    ['claude', 'notes-app', `--model claude-opus-5-5 --resume ${S.notes}`],
    ['codex', 'harbour-light', `-m gpt-5.4 resume ${S.harbour}`],
    ['claude', 'garden-planner', `--model claude-opus-5-5 --resume ${S.garden}`],
  ];
  const got = lines.map((l) => l.split('|'));
  check('stand_ins_ran_in_order', got.length === 4 && want.every(([a, f, args], i) => got[i][0] === a && got[i][1].endsWith(`/Projects/${f}`) && got[i][2] === args), lines.join(' / '));
  // Once: a later snapshot does not say it again.
  await p.evaluate(() => { document.querySelector('#toast').hidden = true; });
  await sleep(2500);
  check('toast_once', await p.evaluate(() => document.querySelector('#toast').hidden));
  await cl.close();
  await c.close();
} catch (e) {
  check('ran_through', false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (hub) { if (failed) console.log(hub.log().split('\n').filter((l) => /restart|error/i.test(l)).slice(-30).join('\n')); hub.stop(); }
  try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: DENV, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
}
console.log(`pictures: ${pictures.join(', ')}`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
