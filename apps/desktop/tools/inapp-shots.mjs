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
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port: await freePort(), plan: true, ideas: true });
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
