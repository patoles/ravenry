// Ravenry's own pages for what opened the board in the browser (inapp.ts,
// ravenry-inapp.html): each drawn in the window from the demo board, at
// 1280 and 900 wide, dark and light, with a picture of each. A row each:
// the page shows what it is for, nothing opened outside the window, and
// the session panel's picture, Gallery and Open the plan lead to them.
//
//   node tools/inapp-shots.mjs [OUT] [--exe APP_EXECUTABLE]
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';
import { startDemoHub } from './demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'inapp-shots'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvia-'));
const work = path.join(root, 'w');
const rt = path.join(root, 'r');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
const openLog = path.join(root, 'open.jsonl');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const R = 'window.__ravenry';

let hub = null;
try {
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true, extra: [{ id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }] });
  const st = await hub.state();
  const sess = st.projects.find((p) => p.id === 'garden-planner');
  const key = `${sess.id}/${sess.sessions[0].surfaceId}`;
  const back = { kind: 'decisions' };
  // Each page, what shows it is drawn (an expression), and its name in the pictures.
  const PAGES = [
    ['gallery', { kind: 'gallery', project: sess.id, at: null, lit: 0, back }, `document.querySelectorAll('#inapp .ia-gc img').length >= 1 && [...document.querySelectorAll('#inapp .ia-gc img')].every((i) => i.complete && i.naturalWidth > 0)`],
    ['picture', { kind: 'gallery', project: sess.id, at: 0, back }, `(() => { const i = document.querySelector('#inapp .ia-big img'); return !!i && i.complete && i.naturalWidth > 0 && /Show in Finder|Next/.test(document.querySelector('#inapp .ia-vbar').textContent); })()`],
    ['plan', { kind: 'plan', project: sess.id, title: null, back }, `document.querySelectorAll('#inapp .ia-ps').length === 3 && /Proof: windows.json/.test(document.getElementById('inapp').textContent) && /1 of 3 done/.test(document.getElementById('inapp').textContent)`],
    ['newplan', { kind: 'newplan', project: 'paper-boat', back }, `!!document.getElementById('ia-goal') && /Draft the plan/.test(document.getElementById('inapp').textContent) && /You read the draft before anything runs/.test(document.getElementById('inapp').textContent)`],
    ['idea', { kind: 'idea', id: 'demo-tidepool', back }, `document.querySelectorAll('#inapp .ia-msg').length === 2 && !!document.getElementById('ia-say') && /Mockup round/.test(document.getElementById('inapp').textContent)`],
    ['alerts', { kind: 'alerts', back }, `document.querySelectorAll('#inapp .ia-al').length >= 5 && /Mac notifications/.test(document.getElementById('inapp').textContent)`],
  ];
  const steps = [
    { ready: true },
    { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2 && ${R}.term().attached`, timeout: 30000 },
    { sleep: 1200 },
    // The session panel: its picture, Gallery and Open the plan lead into the window.
    { js: `${R}.pickSession(${JSON.stringify(key)}), true` },
    { until: `document.querySelector('#panel img.shot') && [...document.querySelectorAll('#panel button')].some((b) => b.textContent === 'Open the plan')`, timeout: 15000 },
    { sleep: 600 }, { shot: path.join(OUT, 'panel-1280-dark.png'), settle: 300 },
    { js: `document.querySelector('#panel img.shot').click(), true` },
    { until: `${R}.S.view.kind === 'gallery' && ${R}.S.view.at === 0 && document.querySelector('#inapp .ia-big img')`, timeout: 8000 },
    { save: { expr: `${R}.S.view.kind + ':' + ${R}.S.view.at`, out: path.join(work, 'from-picture.json') } },
    { js: `${R}.pickSession(${JSON.stringify(key)}), true` }, { sleep: 600 },
    { js: `[...document.querySelectorAll('#panel button')].find((b) => /^Gallery/.test(b.textContent)).click(), true` },
    { until: `${R}.S.view.kind === 'gallery' && ${R}.S.view.at == null && document.querySelector('#inapp .ia-gc')`, timeout: 8000 },
    { save: { expr: `${R}.S.view.kind + ':' + ${R}.S.view.at`, out: path.join(work, 'from-gallery.json') } },
    { js: `${R}.pickSession(${JSON.stringify(key)}), true` }, { sleep: 600 },
    { js: `[...document.querySelectorAll('#panel button')].find((b) => b.textContent === 'Open the plan').click(), true` },
    { until: `${R}.S.view.kind === 'plan' && document.querySelector('#inapp .ia-ps')`, timeout: 8000 },
    { save: { expr: `${R}.S.view.kind`, out: path.join(work, 'from-plan.json') } },
    { js: `document.querySelector('#side [aria-label="Alerts"]').click(), true` },
    { until: `${R}.S.view.kind === 'alerts' && document.querySelector('#inapp .ia-al')`, timeout: 8000 },
    { save: { expr: `${R}.S.view.kind`, out: path.join(work, 'from-bell.json') } },
  ];
  // Each page keeps its scroll, zoom, focus, selection and typed text
  // through the window's redraws: set them, wait through 3 states from the
  // board, and read them again.
  const KEEP = [
    ['gallery', { kind: 'gallery', project: sess.id, at: null, lit: 0, back }, '#inapp', null],
    ['picture', { kind: 'gallery', project: sess.id, at: 0, back }, '#inapp', null],
    ['plan', { kind: 'plan', project: sess.id, title: null, back }, '#inapp', null],
    ['newplan', { kind: 'newplan', project: 'paper-boat', back }, '#inapp', 'ia-goal'],
    ['idea', { kind: 'idea', id: 'demo-tidepool', back }, '#inapp', 'ia-say'],
    ['alerts', { kind: 'alerts', back }, '#inapp', null],
    ['brief', { kind: 'brief', key: 'project:' + sess.id, project: sess.id }, '#brief', null],
    ['decisions', { kind: 'decisions' }, '#decisions', 'search'],
    ['project page', { kind: 'project', id: 'lighthouse' }, '#none', null],
    ['learn', { kind: 'learn' }, '#learn', null],
  ];
  const SET = (root, field) => `(() => {
    const root = document.querySelector(${JSON.stringify(root)});
    // Each page's body made short (a style, so a new drawing keeps it), so
    // that every page has something to scroll even with little in it.
    if (!document.getElementById('keep-short')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'keep-short', textContent: '.pg-b:not(.ia-view), .pa { max-height: 40px !important; overflow-y: auto !important; }' }));
    const sc = [root, ...root.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 30 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    let f = null;
    if (${JSON.stringify(field)} === 'search') f = root.querySelector('input[type=search]');
    else if (${JSON.stringify(field)}) f = document.getElementById(${JSON.stringify(field)});
    if (f) { f.focus(); f.value = 'kept through the redraws'; f.dispatchEvent(new Event('input', { bubbles: true })); f.setSelectionRange(5, 10); }
    // Scrolled after the field took the keyboard (which scrolls it into view).
    if (sc) sc.scrollTop = 37;
    // Some words of the page selected (no field): the selection stays too.
    if (!f) { const t = [...root.querySelectorAll('p, h2, span, b, div')].find((e) => !e.children.length && e.textContent.trim().length > 6 && e.offsetParent && getComputedStyle(e).userSelect !== 'none'); if (t) { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }
    window.__keep = { scroll: sc ? sc.scrollTop : null, value: f ? f.value : null, sel: f ? [f.selectionStart, f.selectionEnd] : String(getSelection()), focus: f ? document.activeElement === f : null };
    window.__keepEls = { sc, f };
    window.__refreshes = 0; let g = ${R}.S.hub; clearInterval(window.__keepT); window.__keepT = setInterval(() => { if (${R}.S.hub !== g) { g = ${R}.S.hub; window.__refreshes++; } }, 50);
    return true; })()`;
  const READ = `(() => { const { sc, f } = window.__keepEls; const sc2 = sc && sc.isConnected ? sc : null; return { before: window.__keep, after: { scroll: sc ? (sc2 ? sc2.scrollTop : 'gone') : null, value: f ? (f.isConnected ? f.value : 'gone') : null, sel: f ? [f.selectionStart, f.selectionEnd] : String(getSelection()), focus: f ? document.activeElement === f : null }, refreshes: window.__refreshes }; })()`;
  steps.push({ size: [1280, 520] });
  for (const [name, v, root, field] of KEEP) {
    steps.push({ js: `${R}.setView(${JSON.stringify(v)}), true` }, { sleep: 1500 });
    steps.push({ js: SET(root, field) });
    steps.push({ until: 'window.__refreshes >= 3', timeout: 20000, soft: true }, { sleep: 200 });
    steps.push({ save: { expr: READ, out: path.join(work, `keep-${name.replace(/ /g, '-')}.json`) } });
  }
  steps.push({ js: `document.getElementById('keep-short')?.remove(), true` });
  // A pinch on the large picture (a wheel with Ctrl, as macOS sends a trackpad
  // pinch) zooms in around the pointer.
  steps.push({ size: [1280, 820] }, { js: `${R}.setView(${JSON.stringify({ kind: 'gallery', project: sess.id, at: 0, back })}), true` }, { until: `document.querySelector('#inapp .ia-big img') && document.querySelector('#inapp .ia-big img').complete`, timeout: 8000 }, { sleep: 600 });
  steps.push({ save: { expr: `(() => { const img = document.querySelector('#inapp .ia-big img'); const r0 = img.getBoundingClientRect(); const cx = r0.left + r0.width * 0.7, cy = r0.top + r0.height * 0.3; const fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height; for (let i = 0; i < 6; i++) img.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true })); const r1 = img.getBoundingClientRect(); return { w0: r0.width, w1: r1.width, fx, fy, fx1: (cx - r1.left) / r1.width, fy1: (cy - r1.top) / r1.height }; })()`, out: path.join(work, 'pinch.json') } });
  steps.push({ js: `(() => { window.__refreshes = 0; let g = ${R}.S.hub; clearInterval(window.__keepT); window.__keepT = setInterval(() => { if (${R}.S.hub !== g) { g = ${R}.S.hub; window.__refreshes++; } }, 50); window.__zw = document.querySelector('#inapp .ia-big img').getBoundingClientRect().width; window.__zs = document.querySelector('#inapp .ia-big').scrollLeft; return true; })()` });
  steps.push({ until: 'window.__refreshes >= 3', timeout: 20000, soft: true });
  steps.push({ save: { expr: `({ w: window.__zw, w2: document.querySelector('#inapp .ia-big img').getBoundingClientRect().width, s: window.__zs, s2: document.querySelector('#inapp .ia-big').scrollLeft, refreshes: window.__refreshes })`, out: path.join(work, 'pinch-kept.json') } });
  steps.push({ shot: path.join(OUT, 'inapp-picture-pinched-1280-dark.png'), settle: 300 });
  for (const [w, hgt] of [[1280, 820], [900, 760]]) {
    steps.push({ size: [w, hgt] });
    for (const theme of ['dark', 'light']) {
      steps.push({ theme, after: 500 });
      for (const [name, v, drawn] of PAGES) {
        steps.push({ js: `${R}.setView(${JSON.stringify(v)}), true` });
        steps.push({ until: drawn, timeout: 10000, soft: true }, { sleep: 500 });
        steps.push({ save: { expr: `!!(${drawn}) && document.getElementById('inapp').scrollWidth <= document.getElementById('inapp').clientWidth + 1`, out: path.join(work, `ok-${name}-${w}-${theme}.json`) } });
        steps.push({ shot: path.join(OUT, `inapp-${name}-${w}-${theme}.png`), settle: 300 });
      }
    }
  }
  fs.mkdirSync(path.join(root, 'apphome'), { recursive: true });
  await runApp({ name: 'inapp', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home: path.join(root, 'apphome'), hubUrl: hub.url, timeoutMs: 300000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog }, width: 1280, height: 820, steps });
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch { return null; } };
  check('the session panel\'s latest picture opens it large in the window', read('from-picture.json') === 'gallery:0', read('from-picture.json'));
  check('the session panel\'s Gallery opens the gallery in the window', read('from-gallery.json') === 'gallery:null' || read('from-gallery.json') === 'gallery:undefined', read('from-gallery.json'));
  check('the session panel\'s Open the plan opens the plan in the window', read('from-plan.json') === 'plan', read('from-plan.json'));
  check('the bell opens Alerts in the window', read('from-bell.json') === 'alerts', read('from-bell.json'));
  for (const [name] of PAGES) {
    const bad = [];
    for (const w of [1280, 900]) for (const theme of ['dark', 'light']) if (read(`ok-${name}-${w}-${theme}.json`) !== true) bad.push(`${w} ${theme}`);
    check(`${name}: drawn in the window at 1280 and 900, dark and light, with no sideways scroll (inapp-${name}-*.png)`, !bad.length, bad.join(', '));
  }
  const opens = fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const [name] of KEEP) {
    const k = read(`keep-${name.replace(/ /g, '-')}.json`) || {};
    // Something to keep on every page: a scroll (the large picture's is its zoom, below), and typed text or selected words.
    const real = !!k.before && (name === 'picture' || typeof k.before.scroll === 'number') && (Array.isArray(k.before.sel) || !!k.before.sel);
    const same = real && k.refreshes >= 3 && JSON.stringify(k.before) === JSON.stringify(k.after);
    check(`${name}: its scroll, focus, selection and typed text stay through ${k.refreshes || 0} states from the board`, same, JSON.stringify(k));
  }
  const pz = read('pinch.json') || {};
  check('a pinch on the large picture zooms in around the pointer', pz.w1 > pz.w0 * 1.5 && Math.abs(pz.fx1 - pz.fx) < 0.03 && Math.abs(pz.fy1 - pz.fy) < 0.03, JSON.stringify(pz));
  const pk = read('pinch-kept.json') || {};
  check('the zoom and where it is scrolled stay through 3 states from the board', pk.refreshes >= 3 && Math.abs(pk.w2 - pk.w) < 1 && pk.s2 === pk.s, JSON.stringify(pk));
  check('nothing opened outside the window', !opens.length, JSON.stringify(opens).slice(0, 400));
} catch (e) {
  check('the pictures were taken', false, String(e.message || e).slice(0, 2000));
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
