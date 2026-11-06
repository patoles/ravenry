#!/usr/bin/env node
// The picture card (docs/design/GalleryCard.dc.html, variant B): the newest picture two thirds wide on the left, the
// two before it stacked on the right, every tile 16:9 in a 24:9 card, the
// count on the big tile's corner and each tile opening the gallery on its
// own picture. With two pictures, two thirds and one third side by side;
// with one, the whole width as before, no count.
//
// A test board on :4689 with a throwaway RAVENRY_HOME, three projects whose
// sessions showed 6, 2 and 1 pictures (fake transcripts and
// tools/fake-cmux.mjs), driven headless at a real board's pane (1273x740, where the
// mockup measures the card 173 px tall) and at 390x844 (128 px). Also
// checks that the right column still pins with the shorter card. The
// pictures are neutral placeholders
// (tools/fixtures/gallery-placeholders.json) drawn to PNG. Never touches
// the board on :4600.
//
// Usage: node tools/gallery-card-test.mjs [--shots <dir>]
//   GL_WEBKIT=1 runs it in WebKit (cmux's browser) instead of Chromium.
//   --shots: the card at both sizes in light and dark, the 2 and 1 picture
//   cards, the mockup's B frames, and each pair side by side.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'gallery-card-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const SCRATCH = path.join(T, 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const WK = !!process.env.GL_WEBKIT;
const ENGINE = WK ? 'webkit' : 'chromium';

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');
const MIN = 60 * 1000;

// ------------------------------------------------------------ the pictures
const browser = await (WK ? webkit : chromium).launch();
const MOCK = path.join(ROOT, 'docs/design/GalleryCard.dc.html'); // the design, for the side-by-side shots (private: not in the public copy)
const svgs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/gallery-placeholders.json'), 'utf8'));
const drawn = {};
async function draw(svgName, file, ageMin) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!drawn[svgName]) {
    const svg = svgs[svgName];
    const w = Number(svg.match(/width="(\d+)"/)[1]), h = Number(svg.match(/height="(\d+)"/)[1]);
    const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w > h ? 1.8 : 1 });
    await pg.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    drawn[svgName] = await pg.screenshot();
    await pg.close();
  }
  fs.writeFileSync(file, drawn[svgName]);
  const t = new Date(Date.now() - ageMin * MIN);
  fs.utimesSync(file, t, t);
  return file;
}

// Three projects: their sessions showed 6, 2 and 1 pictures, newest last.
const SETS = {
  sketchbook: [['home', 'home.png', 26], ['phone', 'phone-screen.png', 21], ['chart', 'response-times.png', 15], ['landscape', 'landscape.png', 9], ['shapes', 'shapes.png', 4], ['settings', 'settings.png', 1]],
  pair: [['shapes', 'shapes.png', 4], ['settings', 'settings.png', 1]],
  solo: [['settings', 'settings.png', 1]],
};
const CLAUDE = path.join(T, 'claude');
const MC = path.join(T, 'mc');
fs.mkdirSync(path.join(MC, 'briefs'), { recursive: true });
const workspaces = [], screens = {}, projects = [];
let k = 0;
for (const [id, set] of Object.entries(SETS)) {
  k++;
  const H = path.join(T, 'root', id);
  fs.mkdirSync(H, { recursive: true });
  execFileSync('git', ['init', '-q', H]);
  const SID = `abababab-0000-4000-8000-00000000000${k}`;
  const at = (ageMin) => new Date(Date.now() - ageMin * MIN).toISOString();
  const lines = [];
  let n = 0;
  for (const [svg, name, age] of set) {
    const file = await draw(svg, path.join(H, 'shots', name), age);
    const idc = `toolu_${k}_${++n}`;
    lines.push(JSON.stringify({ type: 'assistant', timestamp: at(age), cwd: H, sessionId: SID, message: { content: [{ type: 'tool_use', id: idc, name: 'Bash', input: { command: `node tools/shoot.mjs --${svg}` } }] } }));
    lines.push(JSON.stringify({ type: 'user', timestamp: at(age), cwd: H, sessionId: SID, message: { content: [{ type: 'tool_result', tool_use_id: idc, content: `wrote ${file} (2880 x 1620)` }] } }));
    lines.push(JSON.stringify({ type: 'assistant', timestamp: at(age - 0.1), cwd: H, sessionId: SID, message: { content: [{ type: 'tool_use', id: `${idc}r`, name: 'Read', input: { file_path: file } }] } }));
  }
  const TD = path.join(CLAUDE, slug(H));
  fs.mkdirSync(TD, { recursive: true });
  fs.writeFileSync(path.join(TD, SID + '.jsonl'), lines.join('\n') + '\n');
  const name = id[0].toUpperCase() + id.slice(1);
  fs.writeFileSync(path.join(MC, 'briefs', `${id}.md`), `# ${name}\n\n## Goal\nA drawing app that reads at a glance.\n`);
  workspaces.push({ id: `ws-${id}`, ref: `workspace:${k}`, title: name, cwd: H, surfaces: [{ id: `sf-${id}`, ref: `surface:${k}`, title: name }] });
  screens[`sf-${id}`] = `Resume this session with:\nclaude --resume ${SID}\n~/${id} $ `;
  projects.push({ id, name, folder: H, brief: path.join(MC, 'briefs', `${id}.md`), workspaces: [`ws-${id}`] });
}
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces, screens }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root') },
  projects,
}, null, 2));

// ------------------------------------------------------------ the board
const PORT = 4689;
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
  env: { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_SCRATCH_ROOT: SCRATCH,
    MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const base = `http://localhost:${PORT}`;

// A card's geometry: the card, each tile (newest first, as drawn), its
// picture, label and badge, and the column it sits in.
const geom = (pg) => pg.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const card = document.querySelector('#d-pics .card');
  const grid = card.querySelector('.pc-b');
  return {
    col: r(document.querySelector('.col-r')),
    card: r(card),
    grid: !!grid,
    tiles: [...card.querySelectorAll('.picard')].map((t) => {
      const im = t.querySelector('img');
      const hint = t.querySelector('.pic-hint');
      return { ...r(t), src: im.getAttribute('src'), label: t.getAttribute('aria-label'), key: t.dataset.galleryKey || null, hint: hint ? hint.textContent : null, hintBox: hint ? r(hint) : null, fit: getComputedStyle(im).objectFit, pos: getComputedStyle(im).objectPosition, img: r(im) };
    }),
  };
});
const name = (src) => decodeURIComponent((src.match(/auto=([^&]+)/) || [])[1] || src);
const near = (a, b, tol = 1.01) => Math.abs(a - b) <= tol;
const shown = (pg) => pg.evaluate(() => {
  const l = document.querySelector('#gl-fs');
  if (!l || l.hidden) return null;
  return { src: l.querySelector('#gl-im').getAttribute('src'), on: [...l.querySelectorAll('.gl-thumb')].findIndex((b) => b.classList.contains('on')) };
});

async function page(vp, theme, id, extra = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, ...extra });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`${base}/?theme=${theme}#${id}`);
  await pg.waitForSelector('#d-pics .picard', { timeout: 15000 });
  await pg.waitForFunction(() => [...document.querySelectorAll('#d-pics img')].every((i) => i.complete && i.naturalWidth > 0));
  await pg.evaluate(() => Promise.all([...document.querySelectorAll('#d-pics img')].map((x) => x.decode().catch(() => {}))));
  return { ctx, pg, errs };
}
const settle = (pg) => pg.waitForFunction(() => { const i = document.querySelector('#gl-im'); return i && i.complete && i.naturalWidth > 0; });

// The mockup's B frames, for the side-by-side shots.
async function mockShot(theme, sel, file) {
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  await pg.goto(`file://${MOCK}?theme=${theme}`);
  await sleep(300);
  await (await pg.$(sel)).screenshot({ path: file });
  await ctx.close();
}
async function sideBySide(a, b, la, lb, file, theme) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  const img = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  const bg = theme === 'light' ? '#E7E6E2' : '#0E0E10', fg = theme === 'light' ? '#1D1D1F' : '#F2F2F4';
  await pg.setContent(`<html><body style="margin:0;background:${bg};color:${fg};font:600 22px -apple-system,sans-serif"><div id="w" style="display:inline-flex;gap:40px;padding:24px;align-items:flex-start">
    <div style="display:flex;flex-direction:column;gap:10px"><span>${la}</span><img src="${img(a)}"></div>
    <div style="display:flex;flex-direction:column;gap:10px"><span>${lb}</span><img src="${img(b)}"></div></div></body></html>`);
  // Both at their own pixel size, so a CSS pixel is the same on each side.
  await pg.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  await pg.evaluate(() => { for (const i of document.images) i.style.width = i.naturalWidth / 2 + 'px'; });
  await (await pg.$('#w')).screenshot({ path: file });
  await ctx.close();
}

try {
  let st = null;
  for (let i = 0; i < 100; i++) {
    try {
      st = await (await fetch(base + '/api/state')).json();
      const counts = Object.keys(SETS).map((id) => { const p = st.projects.find((x) => x.id === id); const a = p && p.brief && p.brief.pictures.find((x) => x.auto); return a && a.gallery ? a.gallery.length : 0; });
      if (counts.join() === '6,2,1') break;
    } catch { /* starting */ }
    await sleep(200);
  }
  const counts = Object.keys(SETS).map((id) => { const p = st && st.projects.find((x) => x.id === id); const a = p && p.brief && p.brief.pictures.find((x) => x.auto); return a && a.gallery ? a.gallery.length : 0; });
  check('board: the three sessions showed 6, 2 and 1 pictures', counts.join() === '6,2,1', counts.join() + ' ' + log.slice(-400));

  // ---------------------------------------------------- 6 pictures, desktop
  for (const theme of ['dark', 'light']) {
    const vp = { width: 1273, height: 740 };
    const { ctx, pg, errs } = await page(vp, theme, 'sketchbook');
    const g = await geom(pg);
    const [big, top, bot] = g.tiles;
    const tag = `${ENGINE} 1273x740 ${theme}`;
    console.log(`INFO  ${tag}: column ${g.col.w.toFixed(1)} px wide, ${g.col.h.toFixed(1)} px tall; card ${g.card.w.toFixed(1)} x ${g.card.h.toFixed(1)}; tiles ${g.tiles.map((t) => `${t.w.toFixed(1)}x${t.h.toFixed(1)}`).join(', ')}`);
    if (theme === 'dark') {
      check(`${tag}: the column is 462 px wide, as in that pane`, near(g.col.w, 462), g.col.w.toFixed(2));
      check(`${tag}: the card is 173 px tall (the mockup's number)`, Math.round(g.card.h) === 173, g.card.h.toFixed(2));
      check(`${tag}: three tiles, newest first: settings big, shapes and landscape stacked on the right`, g.grid && g.tiles.length === 3 && /settings/.test(name(big.src)) && /shapes/.test(name(top.src)) && /landscape/.test(name(bot.src)), g.tiles.map((t) => name(t.src)).join(' '));
      check(`${tag}: the big tile is two thirds wide, top left, the card's full height`, near(big.x, g.card.x) && near(big.y, g.card.y) && near(big.h, g.card.h) && near(big.w, (g.card.w - 2) * 2 / 3), JSON.stringify(big));
      check(`${tag}: the two small tiles are a third wide, half the height, stacked on the right`, near(top.w, (g.card.w - 2) / 3) && near(bot.w, top.w) && near(top.h, (g.card.h - 2) / 2) && near(bot.h, top.h) && near(top.x, big.x + big.w + 2) && near(bot.x, top.x) && near(top.y, g.card.y) && near(bot.y, top.y + top.h + 2), JSON.stringify([top, bot]));
      check(`${tag}: every tile is 16:9 (within the 2 px gap)`, g.tiles.every((t) => Math.abs(t.w * 9 / 16 - t.h) <= 2), g.tiles.map((t) => (t.w / t.h).toFixed(3)).join(' '));
      check(`${tag}: each picture fills its tile (cover)`, g.tiles.every((t) => t.fit === 'cover' && near(t.img.w, t.w) && near(t.img.h, t.h)));
      check(`${tag}: the count "6" sits on the big tile's bottom-right corner only`, big.hint === '6' && !top.hint && !bot.hint && near(big.x + big.w - (big.hintBox.x + big.hintBox.w), 8) && near(big.y + big.h - (big.hintBox.y + big.hintBox.h), 8), JSON.stringify(big.hintBox));
      check(`${tag}: each tile has its own name, numbered as in the gallery`, big.label === 'Open picture 6 of 6, settings.png' && top.label === 'Open picture 5 of 6, shapes.png' && bot.label === 'Open picture 4 of 6, landscape.png', g.tiles.map((t) => t.label).join(' | '));
      const cursor = await pg.$eval('.pc-tile img', (i) => getComputedStyle(i).cursor);
      check(`${tag}: a zoom-in cursor`, cursor === 'zoom-in', cursor);

      // Each tile opens the gallery on its own picture.
      for (const [k2, want, on] of [[0, 'settings', 5], [1, 'shapes', 4], [2, 'landscape', 3]]) {
        await pg.click(`#d-pics .pc-tile:nth-child(${k2 + 1})`);
        await settle(pg);
        const s = await shown(pg);
        check(`${tag}: a click on tile ${k2 + 1} opens the gallery on ${want}.png`, s && name(s.src).includes(want) && s.on === on, JSON.stringify(s));
        await pg.keyboard.press('Escape');
        check(`${tag}: Esc closes it`, (await shown(pg)) === null);
      }

      // Keyboard: Tab from the big tile reaches the next, with a ring, and
      // Enter opens the gallery on it.
      await pg.focus('#d-pics .pc-tile:nth-child(1)');
      await pg.keyboard.press(WK ? 'Alt+Tab' : 'Tab');
      let f = await pg.evaluate(() => { const a = document.activeElement; return { label: a.getAttribute('aria-label'), ring: a.matches(':focus-visible') ? getComputedStyle(a).outlineWidth + ' ' + getComputedStyle(a).outlineStyle : null }; });
      check(`${tag}: Tab moves from the big tile to the next tile, ringed`, f.label === 'Open picture 5 of 6, shapes.png' && f.ring === '2px solid', JSON.stringify(f));
      if (SHOTS) await (await pg.$('#d-pics')).screenshot({ path: path.join(SHOTS, `card-6-focus-${ENGINE}.png`) });
      await pg.keyboard.press('Enter');
      await settle(pg);
      let s = await shown(pg);
      check(`${tag}: Enter opens the gallery on that tile's picture`, s && name(s.src).includes('shapes'), JSON.stringify(s));
      await pg.keyboard.press('ArrowLeft');
      s = await shown(pg);
      check(`${tag}: the arrows still move from there`, s && s.on === 3);
      await pg.keyboard.press('Escape');
      f = await pg.evaluate(() => document.activeElement.getAttribute('aria-label'));
      check(`${tag}: closing gives focus back to the tile`, f === 'Open picture 5 of 6, shapes.png', String(f));

      // The right column still pins as one piece with the shorter card.
      await pg.evaluate(() => document.querySelector('#d-timeline').insertAdjacentHTML('afterend', '<div class="card" id="test-long" style="height: 2600px"></div>'));
      await sleep(400);
      for (const y of [400, 900, 1600, 2400]) {
        await pg.evaluate((yy) => window.scrollTo(0, yy), y);
        await sleep(150);
        const r = await pg.evaluate(() => {
          const c = document.querySelector('.col-r').getBoundingClientRect(), pic = document.querySelector('#d-pics').getBoundingClientRect(), lv = document.querySelector('#lv-card').getBoundingClientRect();
          return { colTop: Math.round(c.top), colBottom: Math.round(c.bottom), colH: Math.round(c.height), overlap: Math.max(0, Math.round(Math.min(pic.bottom, lv.bottom) - Math.max(pic.top, lv.top))) };
        });
        const fits = r.colH + 24 <= vp.height;
        check(`${tag} scrolled ${y}: the column is pinned (top at 12 when it fits, foot 12 px above the window's bottom when not) and the Live screen never covers the card`, r.overlap === 0 && (fits ? r.colTop === 12 : (r.colBottom <= vp.height && r.colBottom >= vp.height - 13)), JSON.stringify({ ...r, fits }));
      }
      await pg.evaluate(() => window.scrollTo(0, scrollY - 300));
      await sleep(150);
      const back = await pg.$eval('.col-r', (c) => Math.round(c.getBoundingClientRect().top));
      check(`${tag}: scrolling up a little brings the column's head back to 12`, back === 12, String(back));
      // A window shorter than the column: its foot pins 12 px above the
      // bottom, and its head comes back on the way up.
      await pg.setViewportSize({ width: 1273, height: 560 });
      await pg.evaluate(() => window.scrollTo(0, 1200));
      await sleep(150);
      await pg.evaluate(() => window.scrollTo(0, 2400));
      await sleep(150);
      const low = await pg.$eval('.col-r', (c) => { const b = c.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; });
      check(`${tag} in a 560 px window: the taller column's foot is pinned 12 px above the bottom`, low.h + 24 > 560 && low.bottom === 548, JSON.stringify(low));
      await pg.evaluate(() => window.scrollTo(0, 1800));
      await sleep(150);
      // Chromium's scroll anchoring can nudge the page down a few pixels
      // after the scroll when something above grows (the test board's page
      // grows 4 px now and then); pinColumn takes that nudge as a scroll and
      // lifts the column by as much. So: 12, or 12 less that nudge.
      const up = await pg.$eval('.col-r', (c) => ({ top: Math.round(c.getBoundingClientRect().top), y: Math.round(scrollY) }));
      check(`${tag} in a 560 px window: scrolling up brings its head back to 12`, up.y - 1800 >= 0 && up.y - 1800 <= 4 && (up.top === 12 || up.top === 12 - (up.y - 1800)), JSON.stringify(up));
      await pg.setViewportSize(vp);
      await pg.evaluate(() => { document.querySelector('#test-long').remove(); window.scrollTo(0, 0); });
      await sleep(200);
    }
    if (SHOTS) {
      await pg.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
      await pg.screenshot({ path: path.join(SHOTS, `desk-${theme}-${ENGINE}.png`) });
      await (await pg.$('.col-r')).screenshot({ path: path.join(SHOTS, `desk-col-${theme}-${ENGINE}.png`) });
    }
    check(`${tag}: no script errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------- 6 pictures, phone
  for (const theme of ['dark', 'light']) {
    const vp = { width: 390, height: 844 };
    const { ctx, pg, errs } = await page(vp, theme, 'sketchbook', { hasTouch: true, isMobile: true });
    const g = await geom(pg);
    const [big, top, bot] = g.tiles;
    const tag = `${ENGINE} 390x844 ${theme}`;
    console.log(`INFO  ${tag}: card ${g.card.w.toFixed(1)} x ${g.card.h.toFixed(1)}; tiles ${g.tiles.map((t) => `${t.w.toFixed(1)}x${t.h.toFixed(1)}`).join(', ')}`);
    check(`${tag}: the same split, the card 128 px tall at 342 wide`, g.grid && g.tiles.length === 3 && near(g.card.w, 342) && Math.round(g.card.h) === 128 && near(big.w, (g.card.w - 2) * 2 / 3) && near(top.x, big.x + big.w + 2) && near(bot.y, top.y + top.h + 2), JSON.stringify(g.card));
    check(`${tag}: the small tiles about 113 x 63`, Math.round(top.w) === 113 && Math.round(top.h) === 63, `${top.w.toFixed(1)} x ${top.h.toFixed(1)}`);
    check(`${tag}: the count "6" on the big tile`, big.hint === '6');
    await pg.tap('#d-pics .pc-tile:nth-child(3)');
    await settle(pg);
    const s = await shown(pg);
    const bar = await pg.$eval('#gl-bar', (b) => b.textContent);
    check(`${tag}: a tap on the bottom small tile opens landscape, "4 of 6"`, s && name(s.src).includes('landscape') && /4 of 6/.test(bar), bar);
    await pg.click('[data-gl-close]');
    const wide = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${tag}: the page does not scroll sideways`, wide <= 0, String(wide));
    if (SHOTS) {
      await pg.evaluate(() => { const e = document.querySelector('#d-pics'); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 260); });
      await sleep(150);
      await pg.screenshot({ path: path.join(SHOTS, `phone-${theme}-${ENGINE}.png`) });
    }
    check(`${tag}: no script errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------- 2 and 1 pictures
  for (const theme of ['dark', 'light']) {
    const vp = { width: 1273, height: 740 };
    const tag = `${ENGINE} 1273x740 ${theme}`;
    {
      const { ctx, pg, errs } = await page(vp, theme, 'pair');
      const g = await geom(pg);
      const [big, small] = g.tiles;
      if (theme === 'dark') {
        check(`${tag}, 2 pictures: two thirds and one third side by side, the same height, 173 px`, g.grid && g.tiles.length === 2 && Math.round(g.card.h) === 173 && near(big.h, g.card.h) && near(small.h, g.card.h) && near(big.y, small.y) && near(big.w, (g.card.w - 2) * 2 / 3) && near(small.x, big.x + big.w + 2), JSON.stringify(g.tiles.map((t) => [t.x, t.y, t.w, t.h])));
        check(`${tag}, 2 pictures: newest big, the small one cropped to its middle`, /settings/.test(name(big.src)) && /shapes/.test(name(small.src)) && small.fit === 'cover' && small.pos === '50% 50%', `${small.fit} ${small.pos}`);
        check(`${tag}, 2 pictures: the "2" on the big tile`, big.hint === '2' && !small.hint);
        check(`${tag}, 2 pictures: names`, big.label === 'Open picture 2 of 2, settings.png' && small.label === 'Open picture 1 of 2, shapes.png', g.tiles.map((t) => t.label).join(' | '));
        await pg.click('#d-pics .pc-tile:nth-child(2)');
        await settle(pg);
        const s = await shown(pg);
        check(`${tag}, 2 pictures: the small tile opens shapes`, s && name(s.src).includes('shapes') && s.on === 0, JSON.stringify(s));
        await pg.keyboard.press('Escape');
      }
      if (SHOTS) await (await pg.$('#d-pics')).screenshot({ path: path.join(SHOTS, `card-2-${theme}-${ENGINE}.png`) });
      check(`${tag}, 2 pictures: no script errors`, errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
    {
      const { ctx, pg, errs } = await page(vp, theme, 'solo');
      const g = await geom(pg);
      const [t] = g.tiles;
      if (theme === 'dark') {
        check(`${tag}, 1 picture: the whole width, 16:9, as before, no count`, !g.grid && g.tiles.length === 1 && near(t.w, g.card.w) && Math.abs(t.h - t.w * 9 / 16) <= 1 && !t.hint && t.label === 'Open the picture large', JSON.stringify({ w: t.w, h: t.h, hint: t.hint, label: t.label }));
        console.log(`INFO  ${tag}, 1 picture: card ${g.card.w.toFixed(1)} x ${g.card.h.toFixed(1)}`);
        await pg.click('#d-pics .picard');
        await settle(pg);
        const s = await shown(pg);
        check(`${tag}, 1 picture: a click opens it`, s && name(s.src).includes('settings'), JSON.stringify(s));
        await pg.keyboard.press('Escape');
      }
      if (SHOTS) await (await pg.$('#d-pics')).screenshot({ path: path.join(SHOTS, `card-1-${theme}-${ENGINE}.png`) });
      check(`${tag}, 1 picture: no script errors`, errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
  }

  // ---------------------------------------------------- side by side
  if (SHOTS && fs.existsSync(MOCK)) {
    for (const theme of ['dark', 'light']) {
      const m = (f) => path.join(SHOTS, f);
      await mockShot(theme, '#vB .frame', m(`mock-B-desk-${theme}.png`));
      await mockShot(theme, '#vB .pframe', m(`mock-B-phone-${theme}.png`));
      await sideBySide(m(`mock-B-desk-${theme}.png`), m(`desk-col-${theme}-${ENGINE}.png`), 'Mockup B, 1273 x 740', 'Built, right column at 1273 x 740', m(`compare-desk-${theme}-${ENGINE}.png`), theme);
      await sideBySide(m(`mock-B-phone-${theme}.png`), m(`phone-${theme}-${ENGINE}.png`), 'Mockup B, phone', 'Built, 390 x 844', m(`compare-phone-${theme}-${ENGINE}.png`), theme);
    }
  }
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  child.kill();
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
