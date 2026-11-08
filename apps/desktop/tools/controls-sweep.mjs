#!/usr/bin/env node
// Every visible control of the window does something, and nothing of
// Ravenry's own sends the person to a web page (2026-11-08: "Why I can't
// click the latest picture and the gallery button opens a webpage? Same for
// the settings button.").
//
// The app runs offscreen on a demo board (tools/demo-hub.mjs: projects in
// each state, a question waiting, a brief, a picture, a project with no
// session) in a throwaway HOME. View by view (a shell, a session with its
// panel, a project page, the brief, Decisions, Machines, each page of the
// sidebar, Start, Learn Ravenry), every visible button, link, row, tab and
// picture gets a real mouse click, and what it did is recorded:
//   view       the window shows another view (S.view changed)
//   window     another window opened (Settings)
//   external   a browser open (RAVENRY_OPEN_LOG: the URL); to the board's
//              own address it is a failure
//   in place   the page changed where it is (a menu, a dialog, a toast, a
//              section opened), beyond what changes by itself meanwhile
//   nothing    none of these: a failure
// After each click the window goes back to the view under test.
//
//   node tools/controls-sweep.mjs [OUT] [--exe APP_EXECUTABLE]
// Writes OUT/controls.json (every control and what it did) and prints a
// PASS or FAIL line per view.
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'controls-sweep'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsw-'));
const work = path.join(root, 'w');
const rt = path.join(root, 'r');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
const openLog = path.join(root, 'open.jsonl');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The sweep itself runs in the main process (a driver `main` step): it
// moves the real mouse, and sees windows and the open log.
const SWEEP = String.raw`
const fs = require('fs');
const js = (x) => win.webContents.executeJavaScript(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = process.env.RAVENRY_OPEN_LOG;
const opens = () => { try { return fs.readFileSync(OPEN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const R = 'window.__ravenry';
await js("window.__mut = 0; new MutationObserver((l) => { for (const m of l) { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (t && !t.closest('.xterm, #toast, .when, .num, .mem')) window.__mut++; } }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); true");
const hub = await js(R + '.S.config ? ' + R + '.S.config.hubUrl : ""');
const LIST = "(() => { const sel = 'button, a[href], [role=button], [role=tab], img, .lk, .idl, .ss, .pj.open, .vrow, summary, input[type=checkbox], [data-act]'; const out = []; const seen = new Map(); for (const e of document.querySelectorAll(sel)) { if (e.closest('.xterm, #hint, #toast')) continue; if (e.parentElement && e.parentElement.closest(sel) && !['IMG'].includes(e.tagName)) continue; const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.disabled || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue; const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.pointerEvents === 'none') continue; const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy); if (!top || !(top === e || e.contains(top))) continue; const where = e.closest('#side') ? 'sidebar' : e.closest('#panel') ? 'panel' : e.closest('#tabs') ? 'tab strip' : (e.closest('main.pg[id]') || {}).id || (e.closest('#centre') ? 'middle' : 'window'); const label = (e.getAttribute('aria-label') || e.title || (e.tagName === 'IMG' ? 'picture: ' + (e.alt || '') : '') || e.textContent || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 70); const k = where + '|' + label; const n = seen.get(k) || 0; seen.set(k, n + 1); out.push({ key: k + '|' + n, where, label, tag: e.tagName.toLowerCase(), on: e.classList.contains('on') || e.classList.contains('sel') || ['aria-selected', 'aria-checked', 'aria-pressed'].some((a) => e.getAttribute(a) === 'true'), x: Math.round(cx), y: Math.round(cy) }); } return out; })()";
const SNAP = "(() => ({ view: JSON.stringify(" + R + ".S.view), overlay: " + R + ".S.overlay, mut: window.__mut, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent.slice(0, 120), focus: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : '', fp: (() => { let t = ''; const skip = '.xterm, #toast, .when, .num, .mem, [hidden]'; for (const root of [document.body]) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => n.nodeType === 1 ? (n.matches(skip) || getComputedStyle(n).display === 'none' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT }); let n; while ((n = w.nextNode())) t += n.nodeValue.replace(/\\d+/g, '#').trim() + ' '; t += '|'; } t += [...document.querySelectorAll('.on, .sel, [aria-selected=true], [aria-pressed=true], [aria-checked=true], :checked, img')].filter((e) => !e.closest('.xterm')).map((e) => e.tagName + '.' + e.className + (e.src ? e.src.slice(-40) : (e.getAttribute('aria-label') || e.textContent || '').slice(0, 30))).join(','); let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h + ':' + t.length; })() }))()";
const results = [];
// Each page of the sidebar (pages.ts), by its key.
const pageKeys = await js("(window.__ravenry.S.hub.pages || []).map((p) => p.key)");
const views = VIEWS.flatMap((v) => (v.pages ? pageKeys.map((k) => ({ name: 'page: ' + k, go: 'window.__ravenry.openPage(' + JSON.stringify(k) + '), true' })) : [v]));
for (const v of views) {
  // Into the view under test.
  await js(v.go); await sleep(900);
  if (v.wait) for (let i = 0; i < 40 && !(await js('!!(' + v.wait + ')')); i++) await sleep(250);
  const base = await js("JSON.stringify(" + R + ".S.view)");
  const panelPref = await js("JSON.stringify(" + R + ".S.panelPref)");
  const list = await js(LIST);
  for (const c of list) {
    if (v.skip && new RegExp(v.skip).test(c.label)) continue;
    // A control that ends a process: the stand-in process list's ids may be real ones on this Mac (its own checks use processes they started).
    if (/^(Move here|Close idle|End it)/.test(c.label)) { results.push({ view: v.name, ...c, what: 'not clicked', detail: 'ends a process; checked on processes the check starts itself' }); continue; }
    // Back in the view, and the control found again by its key (the sidebar is drawn again every second).
    await js("(() => { const v = " + base + "; if (JSON.stringify(" + R + ".S.view) !== JSON.stringify(v)) " + R + ".setView(v); return true; })()");
    await sleep(250);
    let now = (await js(LIST)).find((x) => x.key === c.key);
    // Not there after a click before it: the view opened again from the start, then looked for again.
    if (!now) {
      await js(v.go); await sleep(900);
      if (v.wait) for (let i = 0; i < 40 && !(await js('!!(' + v.wait + ')')); i++) await sleep(250);
      now = (await js(LIST)).find((x) => x.key === c.key);
    }
    if (!now) { results.push({ view: v.name, ...c, what: 'gone before its click' }); continue; }
    // How much the page changes by itself in 500 ms, then the click and 600 ms.
    const s0 = await js(SNAP); await sleep(350); const s1 = await js(SNAP);
    const churn = s1.mut - s0.mut;
    const o0 = opens().length; const w0 = require('electron').BrowserWindow.getAllWindows().length;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: now.x, y: now.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: now.x, y: now.y, button: 'left', clickCount: 1 });
    await sleep(90);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: now.x, y: now.y, button: 'left', clickCount: 1 });
    await sleep(500);
    let s2 = await js(SNAP);
    if (s2.view === s1.view && s2.fp === s1.fp && !opens().slice(o0).length) { await sleep(1200); s2 = await js(SNAP); }
    const newOpens = opens().slice(o0);
    const wins = require('electron').BrowserWindow.getAllWindows();
    let what, detail = '';
    if (newOpens.length) { what = 'external'; detail = newOpens.map((o) => o.what).join(' '); }
    else if (wins.length > w0) { what = 'window'; detail = wins.filter((w) => w !== win).map((w) => w.getTitle()).join(', '); }
    else if (s2.view !== s1.view || s2.overlay !== s1.overlay) { what = 'view'; detail = s2.view; }
    else if (s2.toast && s2.toast !== s1.toast) { what = 'in place'; detail = 'toast: ' + s2.toast; }
    // What the window shows (its words and what is selected), when it holds still by itself; else how much it moved.
    else if (s0.fp === s1.fp && s2.fp !== s1.fp) { what = 'in place'; detail = 'what the window shows changed (' + s1.fp.split(':')[1] + ' to ' + s2.fp.split(':')[1] + ' characters)'; }
    else if (s0.fp !== s1.fp && s2.mut - s1.mut > churn * 1.3 + 3) { what = 'in place'; detail = (s2.mut - s1.mut) + ' changes (by itself: ' + churn + ')'; }
    else if (s2.focus !== s1.focus && /INPUT|TEXTAREA/.test(s2.focus)) { what = 'in place'; detail = 'a field got the keyboard'; }
    else what = now.on ? 'already in front' : 'nothing';
    const toHub = what === 'external' && !!hub && newOpens.some((o) => String(o.what).startsWith(hub));
    results.push({ view: v.name, where: c.where, label: c.label, tag: c.tag, what, detail: detail.slice(0, 200), toHub });
    fs.appendFileSync(OUTFILE + '.jsonl', JSON.stringify(results[results.length - 1]) + '\n');
    // Back: close what opened, Escape, the view under test.
    for (const w of require('electron').BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed()) w.close();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await js("document.querySelectorAll('.pmodal, .ctx-menu').forEach((e) => e.remove()); " + R + ".S.panelPref = " + panelPref + "; " + R + ".S.overlay = false; " + R + ".render(); true");
    await sleep(150);
  }
}
// The Settings window: each tab, each control (a setting it changes is put back after).
{
  await js("window.ravenry.settings.open(), true");
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) { sw = require('electron').BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed() && /settings\.html/.test(w.webContents.getURL())); if (!sw) await sleep(100); }
  if (sw) {
    const sjs = (x) => sw.webContents.executeJavaScript(x);
    await sleep(800);
    const SLIST = "(() => { const out = []; const seen = new Map(); for (const e of document.querySelectorAll('button, [role=tab], [role=radio], input, select, a[href], label.cb')) { const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.disabled) continue; const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!top || !(top === e || e.contains(top) || top.contains(e))) continue; const label = (e.getAttribute('aria-label') || e.title || e.textContent || e.getAttribute('data-value') || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60); const n = seen.get(label) || 0; seen.set(label, n + 1); out.push({ key: label + '|' + n, label, tag: e.tagName.toLowerCase(), on: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); } return out; })()";
    for (const tab of ['appearance', 'behavior', 'skills']) {
      await sjs("(() => { const b = document.querySelector('[data-tab=\"" + tab + "\"]'); if (b) b.click(); return true; })()"); await sleep(500);
      for (const c of await sjs(SLIST)) {
        if (/^(Appearance|Behavior|Skills)$/.test(c.label)) continue;
        const saved = await js("window.ravenry.settings.get().then((s) => JSON.stringify(s.settings))");
        const now = (await sjs(SLIST)).find((x) => x.key === c.key);
        if (!now) continue;
        const h0 = await sjs("document.body.innerHTML.length + ':' + document.body.innerText.length");
        sw.webContents.sendInputEvent({ type: 'mouseMove', x: now.x, y: now.y });
        sw.webContents.sendInputEvent({ type: 'mouseDown', x: now.x, y: now.y, button: 'left', clickCount: 1 });
        await sleep(80);
        sw.webContents.sendInputEvent({ type: 'mouseUp', x: now.x, y: now.y, button: 'left', clickCount: 1 });
        await sleep(700);
        const after = await js("window.ravenry.settings.get().then((s) => JSON.stringify(s.settings))");
        const h1 = await sjs("document.body.innerHTML.length + ':' + document.body.innerText.length");
        const focused = await sjs("document.activeElement && document.activeElement !== document.body");
        const what = after !== saved ? 'setting' : h1 !== h0 ? 'in place' : focused && /^(input|select)$/.test(c.tag) ? 'field' : now.on ? 'already chosen' : 'nothing';
        results.push({ view: 'Settings: ' + tab, where: 'settings window', label: c.label, tag: c.tag, what, detail: what === 'setting' ? 'a setting changed (put back)' : '', toHub: false });
        fs.appendFileSync(OUTFILE + '.jsonl', JSON.stringify(results[results.length - 1]) + '\n');
        if (after !== saved) { await js("window.ravenry.settings.set(" + saved + ").then(() => true)"); await sleep(200); }
        sw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); sw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      }
    }
    sw.close();
  } else results.push({ view: 'Settings', where: 'settings window', label: 'the window', what: 'nothing', detail: 'it did not open', toHub: false });
}
fs.writeFileSync(OUTFILE, JSON.stringify(results, null, 2));
return results.length;
`;

let hub = null;
try {
  const port = await freePort();
  hub = await startDemoHub({ dir: path.join(root, 'demo'), port, extra: [{ id: 'harbour-map', name: 'harbour-map' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }] });
  const st = await hub.state();
  const sess = st.projects.find((p) => p.sessions && p.sessions.length && p.brief);
  const key = `${sess.id}/${sess.sessions[0].surfaceId}`;
  const VIEWS = [
    { name: 'a shell (sidebar, tab strip, shell panel)', go: `(() => { const t = window.__ravenry.S.tabs.find((x) => x.kind === 'shell'); window.__ravenry.setView({ kind: 'tab', id: t.id }); return true; })()`, skip: 'Close' },
    { name: 'a session (its panel: brief, picture, plan)', go: `window.__ravenry.pickSession(${JSON.stringify(key)}), true`, skip: '^(Close|Hand off now)' },
    { name: 'a project with no session and no conversation (project page)', go: `window.__ravenry.setView({ kind: 'project', id: 'harbour-map' }), true` },
    { name: 'a project with an earlier conversation (project page, Continue)', go: `window.__ravenry.setView({ kind: 'project', id: 'lighthouse' }), true`, wait: `document.querySelector('#none .pa .conv')` },
    { name: 'the brief', go: `window.__ravenry.setView({ kind: 'brief', key: ${JSON.stringify(key)}, project: ${JSON.stringify(sess.id)} }), true` },
    { name: 'Decisions', go: `window.__ravenry.setView({ kind: 'decisions' }), true` },
    { name: 'Machines', go: `window.__ravenry.setView({ kind: 'machines' }), true` },
    // (Choose another folder opens the system's folder dialog: offscreen, builds before 0.1.22's last commits showed it.)
    { name: 'Start', go: `window.__ravenry.onCommand('new-session'), true`, skip: process.env.SWEEP_SKIP_CHOOSER ? 'Choose another folder' : null },
    { name: 'Learn Ravenry', go: `window.__ravenry.onCommand('learn'), true`, skip: '^(Try it|Pair your phone)$' },
    { pages: true },
  ];
  const outFile = path.join(OUT, 'controls.json');
  try { fs.rmSync(outFile + '.jsonl', { force: true }); } catch { /* none */ }
  // The app's own HOME: the demo board's has its board.json, which a packaged app takes for the npm board.
  const appHome = path.join(root, 'apphome');
  // What the system's dialogs answer offscreen: a folder for Choose another folder, a theme file for Import.
  const chosen = path.join(root, 'demo', 'home', 'Projects', 'harbour-map');
  fs.mkdirSync(appHome, { recursive: true });
  await runApp({
    name: 'sweep', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home: appHome, hubUrl: hub.url, timeoutMs: 1500000,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog, RAVENRY_SETTINGS_IMPORT: path.join(HERE, '..', 'test', 'fixtures', 'themes', 'Kelp Forest'), RAVENRY_TEST_FOLDER: chosen }, width: 1440, height: 900,
    steps: [
      { ready: true },
      { until: `window.__ravenry.S.hub && window.__ravenry.S.hub.projects && window.__ravenry.S.hub.projects.length > 2 && window.__ravenry.term().attached`, timeout: 30000 },
      { sleep: 1500 },
      { main: `const VIEWS = ${JSON.stringify(VIEWS)}; const OUTFILE = ${JSON.stringify(outFile)};\n${SWEEP}` },
    ],
  });
  const rows = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const byView = new Map();
  for (const r of rows) { if (!byView.has(r.view)) byView.set(r.view, []); byView.get(r.view).push(r); }
  for (const [v, rs] of byView) {
    const bad = rs.filter((r) => r.toHub || r.what === 'nothing' || r.what === 'gone before its click');
    check(`${v}: ${rs.length} controls, each clicked, none does nothing, none opens the board in the browser`, !bad.length, bad.map((r) => `${r.where} "${r.label}": ${r.toHub ? 'opens ' + r.detail : r.what}`).join(' | '));
  }
  const md = ['| View | Where | Control | What it did | Detail |', '| --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r.view} | ${r.where} | ${String(r.label).replace(/\|/g, '/')} | ${r.toHub ? 'BROWSER (board)' : r.what} | ${String(r.detail || '').replace(/\|/g, '/').slice(0, 90)} |`)];
  fs.writeFileSync(path.join(OUT, 'controls.md'), md.join('\n') + '\n');
  console.log(`${rows.length} controls; table in ${path.join(OUT, 'controls.md')}`);
} catch (e) {
  check('the sweep ran', false, String(e.message || e).slice(0, 2000));
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
