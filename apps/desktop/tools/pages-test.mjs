#!/usr/bin/env node
// The sidebar's pages in the app, end to end and offscreen (never on
// screen), against a demo board (tools/demo-hub.mjs, the real hub) and a
// real ravenryd, every folder a test's:
//   - the pages in the sidebar from their files: the shipped five, then
//     added ones after a line, a project's with its name;
//   - the default Objectives page drawn as the board drew it;
//   - an agent (a script in a real pane, writing the files as an agent's
//     Write would, then `ravenry page check`) makes the Playtest notes page
//     from the picture: its row appears, lit, with its count;
//   - the page: a board of notes with their pictures, Fixed on a card writes
//     the note's status, New note makes a file from the form, an agent's
//     edit to a note shows by itself;
//   - the agent breaks the page (line 14): the last good version stays under
//     the problem, the row gets its red dot, and the fix takes them away;
//   - narrow, the board becomes a list grouped by lane, the last folded;
//   - a page that came with a project: read-only with what its buttons
//     would do, then trusted, and its run button shows an approval card
//     with the row's value as a variable, never in the command;
//   - Customize, then "Default page, changed since your copy" and See what
//     changed; Customize's toast stays on Objectives and is gone on Ideas;
//   - Ship: each brief's Ship section under its repo, every dot with its
//     words, as the board's Ship card shows it.
// Nothing opens on the screen: the app writes what it would open to
// RAVENRY_OPEN_LOG. Every frame of docs/design/RavenryPages.dc.html is
// saved to <outDir> (light, as drawn there; `dark` for the dark theme).
//
//   node build.mjs && node tools/pages-test.mjs <outDir> [light|dark]
//
// Needs a ravenryd binary with approve env (RAVENRYD, else ../../daemon/ravenryd).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'pages-shots'));
const THEME = process.argv[3] === 'dark' ? 'dark' : 'light';
const WORK = path.join(OUT, '.work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvp-'));
fs.chmodSync(RT, 0o700);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ------------------------------------------------------------ the demo
// The projects of the picture's Objectives (made up), with briefs whose
// objectives and plans give its rows.
const BRIEFS = {
  'notes-app': ['# Notes App', '', 'Goal: Quick notes that sync between a phone and a laptop.', '', '## Plan',
    '### Sync settings screen', '- [x] Settings model', '- [x] Sync the settings', '- [x] Screen', '- [?] Ship the beta to the testers', '',
    '### Offline edits', '- [x] Store edits offline', '- [>] Merge two edits made offline', '- [ ] Conflict screen', '- [ ] Retry queue', '- [ ] Tests on a plane', ''].join('\n'),
  'paper-boat': ['# Paper Boat', '', 'Goal: A paper boat game: steer down a gutter river without sinking.', '', '## Plan',
    '### Hull physics', '- [x] Buoyancy', '- [x] Waves', '- [?] Tilt with the slope', '- [ ] Capsize', '',
    '### First level, start to finish', '- [x] Gutter', '- [x] Leaves', '- [x] Dock', '- [x] Waterfall', '- [>] The drain at the end', '- [ ] Score screen', '',
    '## Ship', '- [?] Upload the beta to the store', '- [?] Send it to the testers', ''].join('\n'),
  'recipe-box': ['# Recipe Box', '', 'Goal: Keep the old import format working.', '', '## Plan',
    '### Old import format', '- [x] Read the old export', '- [x] Units', '- [x] Photos', '- [>] Publish 2.3.0', '- [ ] Remove the shim', '',
    '## Ship', '- [?] Publish 2.3.0 to npm', ''].join('\n'),
  'weather-widget': ['# Weather Widget', '', 'Goal: Rain radar on the home screen, updated every 5 minutes.', '', '## Plan',
    '### Radar tiles', 'Runs on its own. Started: 2026-11-05 09:00. Not in the plan: stop and ask.', 'Goal: "Tiles cached for an hour"', '',
    '- [x] Do: Fetch the tiles', '- [x] Gate: Ask me before caching', '- [x] Do: Cache them on disk', '- [ ] Do: Cache tiles for an hour', '- [ ] Gate: Ask me before release', '- [ ] Do: Release', ''].join('\n'),
  'garden-planner': ['# Garden Planner', '', 'Goal: A planting calendar that says what to sow and when, bed by bed.', '', '## Plan',
    '### Reminder emails', 'Runs on its own. Started: 2026-11-04 09:00. Not in the plan: stop and ask. State: paused', 'Goal: "A reminder before each sowing"', '',
    '- [x] Do: Sowing windows', '- [x] Do: Frost dates', '- [x] Gate: Ask me before sending mail', '- [ ] Do: The first reminder', '- [ ] Gate: Ask me before turning it on', '- [ ] Do: Turn it on', ''].join('\n'),
};
const IDEAS = [
  ['tide-pool', 'Tide Pool', 'spark', 'Two players keep a rock pool alive between tides.'],
  ['kite-mail', 'Kite Mail', 'spark', 'Letters that fly between rooftops on kites.'],
  ['lantern-lake', 'Lantern Lake', 'mockup', 'Float lanterns across a lake at night without them going out.'],
  ['bus-stop', 'Bus Stop Stories', 'greenlit', 'Short stories you read while waiting, one per stop.'],
];
const TILES_PAGE = fs.readFileSync(path.join(REPO, 'packages', 'page-format', 'fixtures', 'valid', 'tiles.page.yaml'), 'utf8');
const REGIONS = [['lake', 'Lake District', 1204, '2026-10-30', 'checked'], ['peak', 'Peak District', 986, '2026-10-30', 'needs a look'], ['snowdonia', 'Snowdonia', 1410, '2026-10-12', 'out of date'], ['dartmoor', 'Dartmoor', 642, '2026-10-12', 'checked'], ['cairngorms', 'Cairngorms', 2031, '2026-09-28', 'out of date']];

const DEF = path.join(WORK, 'defaults');
fs.mkdirSync(DEF, { recursive: true });
for (const f of fs.readdirSync(path.join(REPO, 'hub', 'pages', 'defaults'))) fs.copyFileSync(path.join(REPO, 'hub', 'pages', 'defaults', f), path.join(DEF, f));
const OPEN_LOG = path.join(WORK, 'opened.jsonl');

// The notes' pictures: the picture's little game screenshots, drawn with
// Playwright when it is there, else the format's own small fixtures.
async function pictures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const boat = (x, y, s, r) => `<g transform="translate(${x} ${y}) rotate(${r || 0}) scale(${s || 1})"><path d="M-30 0 L30 0 L18 14 L-18 14 Z" fill="#F4F1EA"/><path d="M-4 0 L4 -24 L12 0 Z" fill="#E2DDD2"/><path d="M-30 0 L30 0" stroke="#C9C3B6" stroke-width="1.5"/></g>`;
  const SHOT = {
    'dock-clip': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 110" width="640" height="220"><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9FD0EE"/><stop offset="1" stop-color="#CFE8F5"/></linearGradient></defs><rect width="320" height="110" fill="url(#a)"/><rect y="56" width="320" height="54" fill="#2F6E9E"/><path d="M0 62 Q30 57 60 62 T120 62 T180 62 T240 62 T300 62 T360 62" stroke="#8FC6E8" stroke-width="2" fill="none" opacity=".7"/><rect x="176" y="40" width="150" height="12" fill="#8A6A48"/><rect x="176" y="40" width="150" height="3" fill="#A88560"/><rect x="190" y="52" width="7" height="44" fill="#5E4630"/><rect x="250" y="52" width="7" height="44" fill="#5E4630"/>${boat(178, 60, 1.05, -4)}<circle cx="196" cy="58" r="15" fill="none" stroke="#FF6961" stroke-width="2.5" stroke-dasharray="4 3"/></svg>`,
    'score-pause': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 110" width="640" height="220"><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3B27A"/><stop offset="1" stop-color="#F7D9B4"/></linearGradient></defs><rect width="320" height="110" fill="url(#a)"/><rect y="64" width="320" height="46" fill="#3D6C8C"/>${boat(120, 70, 0.8, 2)}<text x="210" y="27" font-family="Menlo,monospace" font-size="15" font-weight="700" fill="#FFFFFF" stroke="#7A4B2A" stroke-width=".6">SCORE 12840</text><circle cx="300" cy="22" r="13" fill="rgba(0,0,0,.35)"/><rect x="295" y="15" width="3.5" height="14" fill="#FFF"/><rect x="301.5" y="15" width="3.5" height="14" fill="#FFF"/></svg>`,
    'hull-slope': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 110" width="640" height="220"><rect width="320" height="110" fill="#BFE0F2"/><path d="M0 30 L320 86 L320 110 L0 110 Z" fill="#2F6E9E"/><path d="M0 36 L320 92" stroke="#8FC6E8" stroke-width="2" opacity=".7"/>${boat(150, 52, 1, -6)}<path d="M150 18 L150 38" stroke="#FF6961" stroke-width="2" stroke-linecap="round"/><path d="M144 32 L150 39 L156 32" stroke="#FF6961" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
    'rain-dark': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 110" width="640" height="220"><rect width="320" height="110" fill="#2A3340"/><rect y="58" width="320" height="52" fill="#1B2733"/><path d="M40 0l-8 24M90 6l-8 24M150 0l-8 24M210 8l-8 24M270 0l-8 24M120 30l-8 24M240 34l-8 24" stroke="#5B6E80" stroke-width="1.5"/><ellipse cx="220" cy="76" rx="22" ry="7" fill="#24303B"/><ellipse cx="270" cy="88" rx="16" ry="6" fill="#222D37"/>${boat(110, 62, 0.85, 0)}</svg>`,
  };
  let pw = null;
  try { pw = await import(path.join(REPO, 'hub', 'node_modules', 'playwright', 'index.mjs')); } catch { /* not installed here */ }
  if (pw) {
    const b = await pw.chromium.launch();
    const p = await b.newPage({ viewport: { width: 640, height: 220 } });
    for (const [n, s] of Object.entries(SHOT)) { await p.setContent(`<body style="margin:0">${s}</body>`); await p.screenshot({ path: path.join(dir, `${n}.png`) }); }
    await b.close();
  } else {
    for (const n of Object.keys(SHOT)) fs.copyFileSync(path.join(REPO, 'packages', 'page-format', 'fixtures', 'playtest', 'playtest', 'shots', `${n}.png`), path.join(dir, `${n}.png`));
  }
}
const SHOTS_SRC = path.join(WORK, 'shots-src');
await pictures(SHOTS_SRC);

// ------------------------------------------------------------ the agent's script
// What an agent does for "make me a page for my playtest notes": writes the
// page file and one file per note (its Write tool, here heredocs), puts the
// screenshots beside them, then checks the page with `ravenry page check`.
const NOTES = [
  ['boat-clips-the-dock', 'Boat clips through the dock on the left turn', 'new', 'paper-boat', 'Pixel 8', 'dock-clip', 0, '16:52', 'Third run, turning left past the dock at about half speed.\nThe bow goes inside the planks for a moment, then pops\nback out. Every time on the left side, never on the right.'],
  ['splash-plays-twice', 'Splash sound plays twice when the boat lands', 'new', 'paper-boat', 'Pixel 8', null, 0, '16:40', 'After the waterfall, the splash plays once on landing and again\nhalf a second later.'],
  ['score-covers-pause', 'Score covers the pause button on small phones', 'new', 'paper-boat', 'Moto G54', 'score-pause', 0, '16:31', 'At 720 px wide the score\'s last digit sits on top of the pause button.'],
  ['reminder-in-spam', 'Reminder email lands in spam on the school laptop', 'new', 'garden-planner', 'Chromebook', null, 1, '11:20', 'Only on the school\'s mail; a home address gets it in the inbox.'],
  ['hull-tilts-downhill', 'Hull tilts the wrong way going downhill', 'fixing', 'paper-boat', 'Pixel 8', 'hull-slope', 0, '15:10', 'On the long slope in level 2 the bow lifts instead of dipping.'],
  ['calendar-skips-march', 'Calendar skips March the first time it opens', 'fixing', 'garden-planner', 'iPad', null, 1, '10:05', 'February, then April. Opening it again shows March.'],
  ['rain-level-too-dark', 'Rain level too dark to see the rocks', 'fixed', 'paper-boat', 'Pixel 8', 'rain-dark', 3, '18:00', 'Fixed by raising the ambient light in the rain level.'],
  ['boat-drifts-paused', 'Boat keeps drifting while paused', 'fixed', 'paper-boat', 'Moto G54', null, 3, '17:00', 'The current kept running under the pause screen.'],
  ['bed-names-cut-off', 'Bed names cut off at 12 letters', 'fixed', 'garden-planner', 'iPad', null, 4, '12:00', '"Strawberries by the shed" showed as "Strawberries".'],
  ['leaves-pop-in', 'Leaves pop in late on the second river', 'fixed', 'paper-boat', 'Pixel 8', null, 9, '12:00', 'They now load with the river.'],
  ['menu-music-loops', 'Menu music loops with a click', 'fixed', 'paper-boat', 'iPad', null, 10, '12:00', 'A new loop point.'],
  ['frost-date-wrong', 'Frost date a week late in the north', 'fixed', 'garden-planner', 'Chromebook', null, 11, '12:00', 'The frost table now has the northern regions.'],
];
const stamp = (daysAgo, hm) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  const [H, M] = hm.split(':').map(Number); d.setHours(H, M, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
};
const PAGE = fs.readFileSync(path.join(REPO, 'packages', 'page-format', 'fixtures', 'playtest', 'playtest.page.yaml'), 'utf8');
const AGENT = path.join(WORK, 'agent.sh');
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
fs.writeFileSync(AGENT, [
  '#!/bin/sh',
  'P="$HOME/.ravenry/pages"',
  'mkdir -p "$P/playtest/shots"',
  'printf "\\033[1m⏺ Write\\033[0m(~/.ravenry/pages/playtest.page.yaml)\\n"',
  `cat > "$P/playtest.page.yaml" <<'PAGE_END'\n${PAGE}PAGE_END`,
  ...NOTES.map(([f, t, st, pj, dev, pic, days, hm, body]) => [
    `cat > "$P/playtest/${f}.md" <<'NOTE_END'\n---\ntitle: ${t}\nstatus: ${st}\nproject: ${pj}\ndevice: ${dev}\n${pic ? `picture: shots/${pic}.png\n` : ''}---\n${body}\nNOTE_END`,
    `touch -t ${stamp(days, hm)} "$P/playtest/${f}.md"`,
  ].join('\n')),
  ...Object.keys({ 'dock-clip': 1, 'score-pause': 1, 'hull-slope': 1, 'rain-dark': 1 }).map((n) => `cp ${q(path.join(SHOTS_SRC, n + '.png'))} "$P/playtest/shots/"`),
  'printf "\\033[1m⏺\\033[0m Wrote the other 11 notes the same way, one file each.\\n\\n"',
  'printf "\\033[1m⏺ Bash\\033[0m(ravenry page check ~/.ravenry/pages/playtest.page.yaml)\\n"',
  '"$SMOKE_RAVENRYD" page check "$P/playtest.page.yaml"',
  'printf "\\n\\033[1m⏺\\033[0m Done. \\"Playtest notes\\" is in Ravenry\'s sidebar now. It reads the 12 notes,\\n  one file each in ~/.ravenry/pages/playtest/. Each card has Fixed and Ask Claude\\n  to fix, and the page has New note.\\n"',
  '',
].join('\n'));

// ------------------------------------------------------------ the run
const port = await freePort();
let MC = null;
const hub = await startDemoHub({
  dir: path.join(WORK, 'demo'), port, runtime: RT,
  extra: [{ id: 'trail-map', name: 'trail-map' }],
  // ravenryd's own command, so the board can tell the app (a person) from a program in a pane.
  env: { RAVENRY_PAGE_DEFAULTS: DEF, RAVENRY_DAEMON_BIN: BIN },
  prepare: ({ ROOT, MC: mc }) => {
    MC = mc;
    for (const [id, md] of Object.entries(BRIEFS)) fs.writeFileSync(path.join(ROOT, id, 'BRIEF.md'), md + '\n');
    fs.writeFileSync(path.join(ROOT, 'recipe-box', 'TODO.md'), '# Checklist in TODO.md\n' + Array.from({ length: 11 }, (_, i) => `- [${i < 8 ? 'x' : ' '}] Item ${i + 1}`).join('\n') + '\n');
    const I = path.join(mc, 'pages', 'ideas');
    fs.mkdirSync(path.join(I, '.ravenry'), { recursive: true });
    for (const [f, t, st, pitch] of IDEAS) fs.writeFileSync(path.join(I, `${f}.md`), `---\ntitle: ${t}\nstage: ${st}\npitch: ${pitch}\nid: ${f}\n---\n`);
    fs.writeFileSync(path.join(I, '.ravenry', 'migrated.json'), '{}\n');
    const tp = path.join(ROOT, 'trail-map', '.ravenry', 'pages');
    fs.mkdirSync(path.join(tp, 'regions'), { recursive: true });
    fs.writeFileSync(path.join(tp, 'tiles.page.yaml'), TILES_PAGE);
    REGIONS.forEach(([f, r, tiles, built, st], i) => {
      const file = path.join(tp, 'regions', `${f}.md`);
      fs.writeFileSync(file, `---\nregion: ${r}\ntiles: ${tiles}\nbuilt: ${built}\nstatus: ${st}\n---\n`);
      const t = new Date(Date.now() - (i + 1) * 3600e3);
      fs.utimesSync(file, t, t);
    });
  },
});
const PAGES = path.join(MC, 'pages');
const NOTE = (f) => path.join(PAGES, 'playtest', `${f}.md`);
const sig = (n) => path.join(WORK, `${n}.signal`);
const go = (n) => path.join(WORK, `${n}.go`);
const shot = (f, extra = {}) => ({ shot: path.join(OUT, f), ...extra });
const S = 'window.__ravenry.S';
const P = 'window.__ravenry.pages()';
const lanes = `[...document.querySelectorAll('#page .lane')].map((l) => l.querySelector('.lane-h').textContent).join(',')`;
const rowsText = `[...document.querySelectorAll('.nav .vrow')].map((r) => r.textContent).join('|')`;
const save = (n, expr) => ({ save: { expr, out: path.join(WORK, `${n}.json`) } });
const read = (n) => JSON.parse(fs.readFileSync(path.join(WORK, `${n}.json`), 'utf8'));

const steps = [
  { ready: true },
  { until: `${S}.hub && ${S}.hub.pages && ${S}.hub.pages.length === 6 && ${S}.hub.projects.length >= 6`, timeout: 30000 },
  { sleep: 2500 },
  save('rows0', rowsText),
  shot('3-sidebar-before.png', { el: '.nav' }),
  // The default Objectives page.
  { js: `window.__ravenry.openPage('objectives')` },
  { until: `document.querySelectorAll('#page .ocard .orow').length >= 8 && document.querySelector('#page .legend2')`, timeout: 15000 },
  save('objectives', `({ cards: [...document.querySelectorAll('#page .ocards > .ocard')].map((c) => c.querySelector('.ocard-h').textContent), chip: document.querySelector('#page .chip').textContent, rows: document.querySelectorAll('#page .ocards .orow').length, quiet: [...document.querySelectorAll('#page .sec-t')].map((x) => x.textContent), centre: document.getElementById('centre').hidden, panel: document.getElementById('panel').hidden })`),
  shot('2a-objectives-default.png'),
  // The agent writes the Playtest page in a real pane.
  { js: 'window.__ravenry.newShell()' },
  { until: 'window.__ravenry.term().attached && window.__ravenry.term().term.buffer.active.cursorX > 0', timeout: 20000 },
  { type: `clear; sh ${AGENT}\r`, after: 300 },
  { until: `${S}.hub.pages.some((r) => r.key === 'playtest' && r.number === 4) && document.querySelector('.nav .vrow.fresh')`, timeout: 20000 },
  { until: `window.__ravenry.text().includes('OK  board by status')`, timeout: 20000 },
  save('agent', `({ rows: ${rowsText}, fresh: document.querySelector('.nav .vrow.fresh') && document.querySelector('.nav .vrow.fresh').textContent, term: window.__ravenry.text() })`),
  shot('3-agent-made-it.png'),
  shot('3-sidebar-after.png', { el: '.nav' }),
  // A few seconds later it looks like the others.
  { until: `!document.querySelector('.nav .vrow.fresh')`, timeout: 8000 },
  // The page, the pointer on its first card.
  { js: `window.__ravenry.openPage('playtest')` },
  { until: `document.querySelectorAll('#page .lane').length === 3 && document.querySelectorAll('#page .nt img').length === 4`, timeout: 15000 },
  { js: `${P}.hover = 'boat-clips-the-dock.md'; ${P}.render()` },
  { until: `[...document.querySelectorAll('#page .nt img')].every((i) => i.complete && i.naturalWidth > 0)`, timeout: 10000 },
  save('board0', `({ lanes: ${lanes}, more: (document.querySelector('#page .more') || {}).textContent, src: document.querySelector('#page .pg-src').textContent, buttons: [...document.querySelectorAll('#page .pg-h .btn')].map((b) => b.textContent), hov: [...document.querySelectorAll('#page .nt.hov .acts2 .btn')].map((b) => b.textContent) })`),
  shot('1-playtest-board.png'),
  // Fixed on the first card writes the note's status.
  { js: `[...document.querySelectorAll('#page .nt.hov .acts2 .btn')].find((b) => b.textContent === 'Fixed').click()` },
  { until: `${lanes} === 'New3,Fixing2,Fixed7'`, timeout: 10000 },
  { js: `${P}.hover = null; ${P}.render()` },
  { signal: sig('fixed') }, { wait: go('fixed') },
  // An agent's edit to a note shows by itself.
  { until: `${lanes} === 'New3,Fixing1,Fixed8'`, timeout: 10000 },
  // New note, from the form built from the page's fields.
  { js: `[...document.querySelectorAll('#page .pg-h .btn')].find((b) => b.textContent === 'New note').click()` },
  { until: `document.querySelector('#page .msheet .form')` },
  { js: `(() => { const f = document.querySelector('#page .msheet .form'); const t = f.querySelectorAll('input.field')[0]; t.value = 'Wake looks square behind the boat'; t.dispatchEvent(new Event('input')); const inputs = f.querySelectorAll('input.field'); inputs[1].value = 'paper-boat'; inputs[1].dispatchEvent(new Event('input')); inputs[2].value = 'Pixel 8'; inputs[2].dispatchEvent(new Event('input')); })()` },
  save('form', `({ status: document.querySelector('#page .msheet select').value, labels: [...document.querySelectorAll('#page .msheet .fr > span')].map((s) => s.textContent) })`),
  { js: `[...document.querySelectorAll('#page .msheet .btn.pri')].pop().click()` },
  { until: `${lanes} === 'New4,Fixing1,Fixed8' && !document.querySelector('#page .msheet')`, timeout: 10000 },
  // The agent breaks the page, then fixes it.
  { signal: sig('break') }, { wait: go('break') },
  { until: `document.querySelector('#page .nb.bad') && document.querySelector('.nav .vrow[data-page="playtest"] .errdot')`, timeout: 10000 },
  save('broken', `({ bar: document.querySelector('#page .nb.bad').textContent, lanes: ${lanes}, u: (document.querySelector('#page .eline u') || {}).textContent })`),
  shot('5-page-with-mistake.png'),
  { signal: sig('fix') }, { wait: go('fix') },
  { until: `!document.querySelector('#page .nb.bad') && !document.querySelector('.nav .errdot')`, timeout: 10000 },
  // Narrow: the board becomes a list grouped by lane, the last one folded.
  { size: [900, 700] },
  { until: `document.querySelectorAll('#page .gl-g').length === 3`, timeout: 10000 },
  save('narrow', `({ groups: [...document.querySelectorAll('#page .gl-h')].map((h) => h.textContent), rows: document.querySelectorAll('#page .gl-r').length })`),
  shot('6-narrow-board.png'),
  { size: [1440, 900] },
  // A page that came with a project.
  { js: `window.__ravenry.openPage('trail-map/tiles')` },
  { until: `document.querySelector('#page .nb.you') && document.querySelectorAll('#page .ptable tbody tr').length === 5`, timeout: 15000 },
  save('navcls', `[...document.querySelectorAll('.nav .vrow')].map((r) => r.className).join('|')`),
  save('tiles0', `({ bar: document.querySelector('#page .nb.you').textContent, off: [...document.querySelectorAll('#page .ptable .btn')].every((b) => b.disabled), would: [...document.querySelectorAll('#page .would li')].map((l) => l.textContent), chip: document.querySelector('#page .chip').textContent, src: document.querySelector('#page .pg-src').textContent, row: document.querySelector('.nav .vrow[data-page="trail-map/tiles"]').textContent })`),
  shot('4-project-page-trust.png'),
  { js: `[...document.querySelectorAll('#page .nb.you .btn')].find((b) => b.textContent === 'Trust').click()` },
  { until: `!document.querySelector('#page .nb.you') && [...document.querySelectorAll('#page .ptable .btn')].every((b) => !b.disabled)`, timeout: 10000 },
  { js: `[...document.querySelectorAll('#page .ptable tbody tr')].find((r) => r.textContent.startsWith('Lake District')).querySelector('.btn').click()` },
  { until: `!document.getElementById('panel').hidden && document.querySelector('#panel .cp') && document.querySelector('#panel').textContent.includes('REGION') && document.querySelector('#panel').textContent.includes('Map tiles: Rebuild tiles')`, timeout: 15000 },
  save('run', `({ panel: document.getElementById('panel').textContent, cmd: (document.querySelector('#panel .cmdb') || {}).textContent })`),
  shot('4b-run-needs-approval.png'),
  { signal: sig('run') }, { wait: go('run') },
  // Customize, then the default changes.
  { js: `${S}.overlay = false; ${S}.panelKey = null; window.__ravenry.openPage('objectives')` },
  { until: `document.querySelector('#page .pg-h .btn') && document.querySelector('#page .pg-h .btn').textContent === 'Customize'` },
  { js: `document.querySelector('#page .pg-h .btn').click()` },
  { until: `document.querySelector('#page .chip') && document.querySelector('#page .chip').textContent === 'Your copy'`, timeout: 10000 },
  { until: `!document.getElementById('toast').hidden`, timeout: 5000 },
  save('toast0', `({ text: document.getElementById('toast').textContent, at: Date.now() })`),
  { signal: sig('bump') }, { wait: go('bump') },
  { until: `document.querySelector('#page .nb.info')`, timeout: 10000 },
  save('copy', `({ bar: document.querySelector('#page .nb.info').textContent, src: document.querySelector('#page .pg-src').textContent, rows: ${rowsText} })`),
  shot('2b-objectives-copy-changed.png'),
  { js: `document.querySelector('#page .nb.info .lk').click()` },
  { until: `document.querySelector('#page .msheet .code')` },
  save('changed', `({ text: document.querySelector('#page .msheet').textContent, added: [...document.querySelectorAll('#page .msheet .r.add')].map((r) => r.textContent) })`),
  shot('2b-see-what-changed.png'),
  { js: `[...document.querySelectorAll('#page .msheet .btn')].find((b) => b.textContent === 'Not now').click()` },
  // The other shipped pages draw from their files too.
  { js: `window.__ravenry.openPage('ideas')` },
  { until: `document.querySelectorAll('#page .lane').length === 4 && document.querySelector('#page .bs')`, timeout: 10000 },
  save('ideas', `${lanes}`),
  save('toast1', `({ hidden: document.getElementById('toast').hidden, at: Date.now() })`),
  shot('7-ideas.png'),
  { js: `window.__ravenry.openPage('plans')` },
  { until: `document.querySelectorAll('#page .lrow').length >= 2`, timeout: 10000 },
  save('plans', `[...document.querySelectorAll('#page .lrow .lti')].map((x) => x.textContent).join('|')`),
  shot('7-plans.png'),
  { js: `window.__ravenry.openPage('ship')` },
  { until: `document.querySelectorAll('#page .pstat').length === 3 && document.querySelectorAll('#page .pcard').length >= 1`, timeout: 15000 },
  save('ship', `({ stats: [...document.querySelectorAll('#page .pstat')].map((x) => x.textContent), lines: [...document.querySelectorAll('#page .pcard .sub')].map((x) => x.textContent), tasks: [...document.querySelectorAll('#page .pcard')].map((c) => c.querySelector('.ti').textContent + ':' + [...c.querySelectorAll('.ptask')].map((t) => t.textContent).join('|')), bare: [...document.querySelectorAll('#page .dot')].filter((d) => !(d.closest('.ptask, .pdots, .orow, .prow, .legend2'))).length, toast: document.getElementById('toast').hidden })`),
  shot('7-ship.png'),
  { js: `window.__ravenry.openPage('rules')` },
  { until: `document.querySelector('#page .ptabs') && document.querySelectorAll('#page .pdoc').length >= 1`, timeout: 10000 },
  shot('7-rules.png'),
  // Picking a session brings the terminal back.
  { js: `window.__ravenry.pickSession(${S}.hub.projects.find((p) => p.id === 'paper-boat').id + '/' + ${S}.hub.projects.find((p) => p.id === 'paper-boat').sessions[0].surfaceId)` },
  { until: `document.getElementById('page').hidden && !document.getElementById('centre').hidden` },
];

const feed = (async () => {
  for (const n of ['fixed', 'break', 'fix', 'run', 'bump']) {
    while (!fs.existsSync(sig(n))) await sleep(50);
    if (n === 'fixed') {
      check('Fixed on the card wrote status: fixed in the note, and nothing else', /\nstatus: fixed\n/.test(fs.readFileSync(NOTE('boat-clips-the-dock'), 'utf8')) && fs.readFileSync(NOTE('boat-clips-the-dock'), 'utf8').includes('picture: shots/dock-clip.png\n---\nThird run'));
      // The agent marks a note fixed, as its editor would.
      fs.writeFileSync(NOTE('calendar-skips-march'), fs.readFileSync(NOTE('calendar-skips-march'), 'utf8').replace('status: fixing', 'status: fixed'));
    }
    if (n === 'break') {
      const made = fs.readdirSync(path.join(PAGES, 'playtest')).find((f) => f.startsWith('wake-looks-square'));
      check('New note made a file from the form, with the button\'s status', !!made && /status: new\nproject: paper-boat\ndevice: Pixel 8\n/.test(fs.readFileSync(path.join(PAGES, 'playtest', made), 'utf8')), made);
      fs.writeFileSync(path.join(PAGES, 'playtest.page.yaml'), PAGE.replace('    group_by: status', '    group_by: stauts').replace('values: [new, fixing, fixed]', 'values: [new, fixing, fixed, wontfix]'));
    }
    if (n === 'fix') fs.writeFileSync(path.join(PAGES, 'playtest.page.yaml'), PAGE);
    if (n === 'run') {
      const cps = (await (await fetch(hub.url + '/api/checkpoints')).json()).checkpoints;
      const cp = cps.find((c) => c.kind === 'approve' && c.env && c.env.REGION);
      check('the run button opened an approval: the page\'s own command, the row\'s region as a variable, in the project\'s folder', !!cp && cp.command === 'npm run build:tiles' && cp.env.REGION === 'Lake District' && cp.cwd.endsWith('trail-map') && cp.state === 'open', JSON.stringify(cp));
      if (cp) await fetch(hub.url + '/api/checkpoints/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ id: cp.id, decline: true, reason: 'only a test' }) });
    }
    if (n === 'bump') {
      fs.mkdirSync(path.join(WORK, 'history'), { recursive: true });
      fs.copyFileSync(path.join(DEF, 'objectives.page.yaml'), path.join(WORK, 'history', 'objectives-r1.page.yaml'));
      fs.writeFileSync(path.join(DEF, 'objectives.page.yaml'), fs.readFileSync(path.join(DEF, 'objectives.page.yaml'), 'utf8').replace('revision: 1', 'revision: 2').replace('      subtitle: brief.goal\n', '      subtitle: brief.goal\n      time: updated\n'));
    }
    fs.writeFileSync(go(n), '1');
  }
})();

try {
  const app = runApp({ name: 'pages', work: WORK, rt: RT, bin: BIN, home: hub.home, hubUrl: hub.url, steps, width: 1440, height: 900, env: { RAVENRY_THEME: THEME, RAVENRY_OPEN_LOG: OPEN_LOG, PS1: '$ ' }, shell: 'sh', timeoutMs: 240000 });
  await Promise.race([app, feed.then(() => app)]);
} catch (e) {
  console.log(`FAIL  the app run: ${String(e.message).split('\n').slice(0, 6).join(' | ')}`);
  fails++;
} finally {
  stopDaemons(BIN, RT);
  hub.stop();
  fs.rmSync(RT, { recursive: true, force: true });
}

const has = (n) => fs.existsSync(path.join(WORK, `${n}.json`));
if (has('rows0')) check('the sidebar\'s pages from their files: Objectives, Plans, Ideas, Rules, Ship, then a line and trail-map\'s Map tiles', /^Objectives\|Plans[^|]*\|Ideas4\|Rules\|Ship\d*\|Map tilestrail-map$/.test(read('rows0')), read('rows0'));
if (has('objectives')) {
  const o = read('objectives');
  check('the default Objectives page: a card per project with a brief, its rows, a quiet Customize, in place of the terminal and the panel', o.cards.length === 5 && o.chip === 'Default page' && o.rows === 8 && o.centre && o.panel && o.quiet.some((x) => /^No brief yet/.test(x)), JSON.stringify(o));
}
if (has('agent')) {
  const a = read('agent');
  check('the agent\'s page: its row appears after the line, lit, with its count; ravenry page check said OK in the pane', a.fresh === 'Playtest notes4' && /Ship\d*\|Playtest notes4\|Map tiles/.test(a.rows) && /OK {2}board by status: New 4, Fixing 2, Fixed 6\. 3 buttons\./.test(a.term), JSON.stringify({ fresh: a.fresh, rows: a.rows }));
}
if (has('board0')) {
  const b = read('board0');
  check('its board: New 4, Fixing 2, Fixed 6 with 3 more, the pointer\'s card showing Fixed and Ask Claude to fix', b.lanes === 'New4,Fixing2,Fixed6' && b.more === '3 more' && b.hov.join() === 'Fixed,Ask Claude to fix' && b.buttons.join() === 'Open file,New note' && /12 notes in playtest\//.test(b.src), JSON.stringify(b));
}
if (has('form')) check('New note\'s form: its fields, with the button\'s status', read('form').status === 'new' && read('form').labels.join() === 'Title (needed),Status,Project,Device,Text', JSON.stringify(read('form')));
if (has('broken')) {
  const b = read('broken');
  check('a mistake: the problem on top, the last good board under it, the red dot', /playtest\.page\.yaml line 14: 'stauts' is not a field\. Showing the last version that worked\./.test(b.bar) && /Did you mean status\?/.test(b.bar) && b.u === 'stauts' && b.lanes === 'New4,Fixing1,Fixed8', JSON.stringify(b));
}
if (has('narrow')) check('narrow: a list grouped by lane, the last folded', read('narrow').groups.join('|') === 'New4|Fixing1|Fixed8Show ' && read('narrow').rows === 5, JSON.stringify(read('narrow')));
if (has('tiles0')) {
  const t = read('tiles0');
  check('a project\'s page: read-only, its buttons off, what each would do, its project\'s name on its row', /This page came with the project\. Its buttons stay off until you trust it\./.test(t.bar) && t.off && t.would.join('|').includes('Runs npm run build:tiles in ~/Projects/trail-map, with REGION set to the item\'s region. You approve each run first.') && t.chip === 'trail-map' && /^Read-only/.test(t.src) && t.row === 'Map tilestrail-map', JSON.stringify(t));
}
if (has('navcls')) check('a page is lit only when it first appears, and the page shown is the one selected', read('navcls') === 'vrow|vrow|vrow|vrow|vrow|vrow|vrow sel', read('navcls'));
if (has('run')) check('trusted, its run button shows the command and REGION in an approval card, as the page\'s button and not an agent\'s', /REGION/.test(read('run').panel) && /Lake District/.test(read('run').panel) && read('run').cmd === 'npm run build:tiles' && /Map tiles: Rebuild tiles/.test(read('run').panel) && !/agent/i.test(read('run').panel), JSON.stringify(read('run')).slice(0, 400));
if (has('copy')) check('Customize: the copy takes Objectives\' place; the default changed since: one quiet line', /Default page, changed since your copy\./.test(read('copy').bar) && /objectives\.page\.yaml/.test(read('copy').src) && read('copy').rows.startsWith('Objectives|Plans'), JSON.stringify(read('copy')));
if (has('changed')) check('See what changed: the default\'s change, line by line', /What changed in the default Objectives page/.test(read('changed').text) && read('changed').added.some((x) => /time: updated/.test(x)), JSON.stringify(read('changed').added));
if (has('ideas')) check('Ideas: its board from the idea files, by stage', read('ideas') === 'Spark2,Mockup1,Greenlit1,Parked0', read('ideas'));
if (has('plans')) check('Plans: the running plans from the briefs', /Radar tiles/.test(read('plans')) && /Reminder emails/.test(read('plans')), read('plans'));
if (has('toast1')) check('a toast stays on the page it was said on: Customize\'s is gone on Ideas', /^Your copy is .*objectives\.page\.yaml/.test(read('toast0').text) && read('toast1').hidden, `${JSON.stringify(read('toast0').text)}, Ideas ${read('toast1').at - read('toast0').at} ms after it, hidden: ${read('toast1').hidden}`);
if (has('ship')) check('Ship: each brief\'s Ship section under its repo, every dot with its words, as the Ship card shows it', read('ship').tasks.includes('recipe-box:Publish 2.3.0 to npmYou') && read('ship').tasks.includes('paper-boat:Upload the beta to the storeYou|Send it to the testersYou') && read('ship').bare === 0 && read('ship').toast, JSON.stringify(read('ship').tasks));
if (has('ship')) check('Ship: its numbers, and each repo\'s line as the Ship card said it', read('ship').stats.length === 3 && read('ship').lines.length >= 1 && read('ship').lines.every((l) => /^(\d+ commits? to push|Uncommitted changes|No upstream|Pushed and clean)$/.test(l)), JSON.stringify(read('ship')));
const opened = fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('Customize opened the copy, logged instead of opened (nothing on the screen)', opened.some((o) => o.kind === 'path' && o.what.endsWith('/.ravenry/pages/objectives.page.yaml')), JSON.stringify(opened));
console.log(`shots in ${OUT}: ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort().join(', ')}`);
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
