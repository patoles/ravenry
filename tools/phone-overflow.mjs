// Fails if any view of the running board scrolls sideways at phone width.
// Headless only, read-only: it opens views and expands rows (Suggested, a
// Reword preview, the memory list), and never presses anything that sends,
// closes, saves or writes. (Opening the phone alerts sheet makes the ntfy
// topic on a board that has none yet, as any first look at it does.)
//
// The idle sheet is position:fixed, so its rows are measured like any other
// element inside it (only the fixed box itself is skipped).
//
// Usage: node tools/phone-overflow.mjs [--url http://127.0.0.1:4600]
//          [--engine webkit|chromium|both] [--w 390] [--h 844]
//          [--shots <dir>] [--project <id>] [--only rules,ship]
// Plans (docs/design/Plans.dc.html): the Plan card and the gate card of the
// first project waiting at a gate (else running a plan), its full plan, and
// the planning sheet of the first project with a brief and no plan (it opens
// on the draft when one is open there; opening it writes nothing).
// --files <file> adds one view, plan-sheet-files: that sheet with the file
// attached to every box it shows (the goal box, or the chat box and the
// first step's comment box), so the chips are measured. It saves the file
// into that project's .inbox, the only write, so it is off unless asked.
// Exit 1 when a view's document.documentElement.scrollWidth passes its
// clientWidth; each offending element is listed with its right edge.
import { chromium, webkit, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = opt('--url', 'http://127.0.0.1:4600');
const engine = opt('--engine', 'both');
const W = Number(opt('--w', 390));
const H = Number(opt('--h', 844));
const shots = opt('--shots', null);
let pid = opt('--project', null); // default: the board's first project
const only = opt('--only', null);
const attach = opt('--files', null);
if (shots) fs.mkdirSync(shots, { recursive: true });

// The idea with the longest thread is the widest panel to open.
let ideaId = 'none';
let mockIdeaId = 'none';
try {
  const j = await (await fetch(base + '/api/ideas')).json();
  const list = (j.ideas || []).slice().sort((a, b) => (b.thread || []).length - (a.thread || []).length);
  if (list[0]) ideaId = list[0].id;
  // And one with mockup rounds, for the Mockups card (none: the first idea).
  const withMockups = list.find((x) => x.mockups && x.mockups.rounds && x.mockups.rounds.length);
  mockIdeaId = withMockups ? withMockups.id : ideaId;
} catch { /* the ideas view reports its own error */ }
if (!pid) {
  try { pid = ((await (await fetch(base + '/api/state')).json()).projects || [])[0]?.id || 'none'; } catch { pid = 'none'; }
}

let gatePid = null;
let sheetPid = null;
try {
  const st = await (await fetch(base + '/api/state')).json();
  const ps = st.projects || [];
  const g = ps.find((x) => x.planGate) || ps.find((x) => x.plan);
  gatePid = g ? g.id : null;
  const sp = ps.find((x) => x.brief && !x.plan && x.planDraft) || ps.find((x) => x.brief && !x.plan);
  sheetPid = sp ? sp.id : null;
} catch { /* the views report their own errors */ }

const click = (sel, wait) => async (page) => {
  await page.click(sel);
  if (wait) await page.waitForSelector(wait, { timeout: 15000 });
};
const VIEWS = [
  { name: 'projects', q: `#${pid}`, wait: '#d-objs .card', also: ['#lv-card', '#d-timeline', '#d-sessions'] },
  // The Live screen full screen, from the card's "Tap to expand".
  { name: 'projects-live-full', q: `#${pid}`, wait: '#lv-lines > *', steps: [click('#lv-tap', '#lv-fs .fs-bar .lv-back')] },
  // The phone's "N idle" chip opens the idle projects in a bottom sheet.
  { name: 'projects-idle-sheet', q: `#${pid}`, wait: '#pchips [data-idle-open]', steps: [click('#pchips [data-idle-open]', '#idle-sheet .bsheet .row')] },
  { name: 'objectives', q: '#/objectives', wait: '#o-rows .card' },
  { name: 'ideas', q: '?idea=none#/ideas', wait: '.idea' },
  { name: 'idea-open', q: `?idea=${encodeURIComponent(ideaId)}#/ideas`, wait: '#i-name' },
  { name: 'idea-mockups', q: `?idea=${encodeURIComponent(mockIdeaId)}#/ideas`, wait: '#mk-card' },
  { name: 'rules-mine', q: '#/rules', wait: '.yr-card' },
  { name: 'rules-suggested', q: '#/rules', wait: '.yr-card', steps: [click('[data-rtab="sug"]', '.quiet-line')] },
  { name: 'rules-reword', q: '#/rules', wait: '.yr-card', steps: [click('[data-rtab="sug"]', '.quiet-line'), async (p) => { if (await p.$('[data-rep-act="open"]')) await click('[data-rep-act="open"]', '.pv')(p); }] },
  { name: 'rules-memory', q: '#/rules', wait: '.yr-card', steps: [click('[data-rtab="sug"]', '.quiet-line'), click('[data-act="rules-more"]', '#r-rows .card, #r-rows .err-line')] },
  { name: 'ship', q: '#/ship', wait: '#s-repos .card' },
  { name: 'sessions', q: '#/projects', wait: '#pchips .pchip', steps: [click('#memchip-m', '#sessions-view h1')] },
  { name: 'new-project', q: '?modal=new#/projects', wait: '#modal-form' },
  // The Folder row on Existing, a long name typed, every known folder shown.
  { name: 'new-project-existing', q: '?modal=new#/projects', wait: '#modal-form', steps: [async (p) => { await p.fill('[name="name"]', 'A rather long project name to test the footer'); }, click('[data-fmode="existing"]', '.frow'), async (p) => { if (await p.$('[data-act="folders-more"]')) await click('[data-act="folders-more"]')(p); }] },
  // The Settings card from the gear (opening it writes nothing).
  { name: 'settings-card', q: `#${pid}`, wait: '#pchips .pchip', steps: [click('#gear', '#hs-pop .hs-th')] },
  // Phone alerts' setup sheet, one view per channel (docs/design/PhoneAlerts.dc.html, B).
  // Opening it writes only the ntfy topic, on a board that has none yet.
  ...[['telegram', 'Telegram'], ['webhook', 'Discord or Slack'], ['ntfy', 'ntfy']].map(([tab]) => ({
    name: `alerts-sheet-${tab}`, q: `#${pid}`, wait: '#pchips .pchip',
    steps: [click('#gear', '#pa-btns [data-pa="setup"]'), click('#pa-btns [data-pa="setup"]', '#pa-back .pa-step'), click(`[data-pa-tab="${tab}"]`, `[data-pa-tab="${tab}"].on`)],
  })),
  ...(gatePid ? [
    { name: 'plan-card', q: `#${gatePid}`, wait: '#d-plan .pl-card', also: ['#d-ask'] },
    { name: 'plan-full', q: `#/plan/${gatePid}`, wait: '.pl-flow' },
  ] : []),
  ...(sheetPid ? [{ name: 'plan-sheet', q: `#${sheetPid}`, wait: '[data-act="plan-new"]', steps: [click('[data-act="plan-new"]', '#plan-phone .strip')] }] : []),
  ...(sheetPid && attach ? [{ name: 'plan-sheet-files', q: `#${sheetPid}`, wait: '[data-act="plan-new"]', steps: [click('[data-act="plan-new"]', '#plan-phone .strip'), async (page) => {
    const saved = async () => { for (let i = 0; i < 100 && await page.$('.chip:has-text("Saving")'); i++) await page.waitForTimeout(100); };
    for (const box of ['goal', 'chat']) if (await page.$(`#plan-phone [data-plfile="${box}"]`)) { await page.setInputFiles(`#plan-phone [data-plfile="${box}"]`, [attach, attach]); await saved(); }
    if (await page.$('#plan-phone .cv-s [data-pl="comment"]')) { await page.click('#plan-phone .cv-s [data-pl="comment"]'); await page.setInputFiles('#plan-phone [data-plfile="comment"]', [attach]); await saved(); }
  }] }] : []),
];

// Elements whose right edge passes the viewport and that no clipping
// ancestor (overflow-x other than visible, itself inside) hides.
function measure() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const out = [];
  // The nearest ancestor inside the viewport that clips the element: 'scroll'
  // when it scrolls (a wide terminal line, a command) or ends in an ellipsis,
  // 'cut' when it hides content without a sign.
  const clipper = (el) => {
    for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ox = cs.overflowX;
      // An ellipsis box truncates on purpose and shows that it did.
      if (ox !== 'visible' && a.getBoundingClientRect().right <= vw + 0.5) return ox === 'auto' || ox === 'scroll' || cs.textOverflow === 'ellipsis' ? 'scroll' : 'cut';
    }
    return null;
  };
  const clipped = (el) => clipper(el) !== null;
  const cut = [];
  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).join('.');
    return s;
  };
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 0.5) continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    const c = clipper(el);
    if (c === 'cut' && !(el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 0.5 && clipper(el.parentElement) === 'cut')) cut.push({ el: label(el.parentElement) + ' > ' + label(el), right: Math.round(r.right), text: (el.textContent || '').trim().slice(0, 60) });
    if (c) continue;
    // Report the outermost offender; children that inherit its overflow add nothing.
    const p = el.parentElement;
    const pr = p && p.getBoundingClientRect();
    const inherits = p && p !== document.body && pr.right > vw + 0.5 && !clipped(p);
    if (inherits) continue;
    let path = [];
    for (let a = el; a && a !== document.body && path.length < 4; a = a.parentElement) path.unshift(label(a));
    out.push({ el: path.join(' > '), right: Math.round(r.right), width: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 60) });
  }
  return { scrollWidth: de.scrollWidth, clientWidth: vw, offenders: out, cut };
}

const engines = engine === 'both' ? ['webkit', 'chromium'] : [engine];
let failed = 0;
for (const en of engines) {
  const browser = await (en === 'webkit' ? webkit : chromium).launch({ headless: true });
  const dev = en === 'webkit' ? devices['iPhone 13'] : devices['Pixel 5'];
  for (const v of VIEWS) {
    if (only && !only.split(',').includes(v.name)) continue;
    const ctx = await browser.newContext({ ...dev, viewport: { width: W, height: H }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`  pageerror (${v.name}):`, e.message));
    const [qs, hash] = v.q.split('#');
    const sep = qs ? qs + '&' : '?';
    let res;
    try {
      await page.goto(`${base}/${sep}theme=dark#${hash}`);
      await page.waitForSelector(v.wait, { timeout: 15000 });
      for (const s of v.steps || []) await s(page);
      await page.waitForTimeout(700);
      res = await page.evaluate(measure);
    } catch (e) {
      console.log(`${en} ${W}x${H} ${v.name}: could not open (${e.message.split('\n')[0]})`);
      failed++;
      await ctx.close();
      continue;
    }
    // Content an overflow:hidden box cuts off at the screen edge is unreadable,
    // so it fails like a sideways scroll.
    const bad = res.scrollWidth > res.clientWidth || res.cut.length > 0;
    if (bad) failed++;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${en} ${W}x${H} ${v.name}: scrollWidth ${res.scrollWidth} / clientWidth ${res.clientWidth}`);
    for (const o of res.cut) console.log(`       cut at the edge: right ${o.right} ${o.el}${o.text ? '  "' + o.text + '"' : ''}`);
    for (const o of res.offenders) console.log(`       right ${o.right} (w ${o.width}) ${o.el}${o.text ? '  "' + o.text + '"' : ''}`);
    if (shots && en === engines[0]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(shots, `${v.name}-${W}.png`), fullPage: true });
    }
    await ctx.close();
  }
  await browser.close();
}
console.log(failed ? `\n${failed} view(s) scroll sideways or failed to open` : '\nNo view scrolls sideways');
process.exit(failed ? 1 : 0);
