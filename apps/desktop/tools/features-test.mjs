#!/usr/bin/env node
// The terminal-basics features, in the app (the picture
// ravenry-terminal-basics.html):
//   F1 Find (Cmd+F): every match tinted, "N of M", next and previous, case
//      and regex, Esc closes;
//   F2 the right-click menu, the system's own: Open Link and Copy Link only
//      over a link, Copy off with no selection, Copy Path the pane's folder;
//   F3 closing a busy shell asks first (Cancel the default, Don't ask
//      again), an idle one closes at once;
//   F4 the visual bell flashes the pane; a bell in a tab not on screen
//      leaves a small bell on it until it is opened;
//   G  Cmd+N a new window (a shell of its own, the first window's tabs
//      untouched), New Session on Cmd+Shift+N, Close Window;
//   the settings: the snapshot's xterm options, Option as Meta per side,
//      copy on select, Cmd+= / Cmd+- written to the settings, Cmd+, past
//      the terminal.
// Pictures in dark and light (the menu is the system's own and cannot be
// drawn offscreen: its items are checked instead).
//
//   node tools/features-test.mjs [OUT] [--exe APP_EXECUTABLE]
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'features-test'));
fs.mkdirSync(OUT, { recursive: true });
const MAC = process.platform === 'darwin';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvft-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
const openLog = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (!ok) fails++; };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'features-test' });
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', 'echo the session pane; exec cat'], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();

let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(state)); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const T = `${R}.term()`;
const SCREEN = `(() => { const b = ${T}.term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true)); return out.join('\\n'); })()`;
const cellOf = (text) => `(() => { const t = ${T}.term; const b = t.buffer.active; const scr = document.querySelector('#pbox0 .xterm-screen').getBoundingClientRect(); const cw = scr.width / t.cols, ch = scr.height / t.rows;
  for (let y = 0; y < t.rows; y++) { const l = b.getLine(b.viewportY + y); const x = l ? l.translateToString(true).indexOf(${JSON.stringify(text)}) : -1; if (x >= 0) return { x: Math.round(scr.left + (x + 1.5) * cw), y: Math.round(scr.top + (y + 0.5) * ch) }; } return null; })()`;
const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
const mainSave = (name, code) => ({ main: code, out: path.join(work, `${name}.json`) });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const settingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')); } catch { return null; } };
const FIND = `(() => { const b = document.getElementById('findbar'); return { open: !b.hidden, n: b.querySelector('.fb-n') ? b.querySelector('.fb-n').textContent : null, q: b.querySelector('input') ? b.querySelector('input').value : null }; })()`;
const MENU = `const m = globalThis.__ravenryMenuItems; globalThis.__ravenryMenuItems = null; return m;`;
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog };
const cmdMod = MAC ? ['meta'] : ['control'];

try {
  await runApp({ name: 'features', work, rt, bin: EXE ? undefined : BIN, cli: BIN, exe: EXE || undefined, home, hubUrl, env, width: 1440, height: 900, steps: [
    { ready: true },
    { js: `${R}.newShell()` },
    { until: `${T}.attached && ${T}.ready && ${R}.S.view.kind === 'tab'`, timeout: 15000 },
    { sleep: 800 },
    { type: "printf 'error one\\nfine\\nerror two\\nERROR three\\nsee https://example.com/docs here\\n'\r" },
    { until: `${SCREEN}.includes('ERROR three')`, timeout: 10000 },
    // F1 Find.
    { js: `${R}.onCommand('find')` }, { sleep: 200 },
    { type: 'error' }, { sleep: 400 },
    save('find-all', FIND),
    { shot: path.join(OUT, 'find-dark.png') },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'find-light.png') }, { theme: 'dark' },
    { key: 'Enter' }, { sleep: 200 },
    save('find-next', FIND),
    { click: '#findbar .fb-t' }, { sleep: 300 },
    save('find-case', FIND),
    { js: `${R}.onCommand('find-prev')` }, { sleep: 200 },
    save('find-prev', FIND),
    { key: 'Escape' }, { sleep: 200 },
    save('find-closed', `({ ...${FIND}, focus: document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea') })`),
    // F2 the right-click menu: over the link (Copy Link picked), then elsewhere (Copy Path).
    { main: `globalThis.__ravenryMenuPick = 'copy-link';` },
    { clickAt: cellOf('https://example.com/docs'), button: 'right' }, { sleep: 400 },
    mainSave('menu-link', MENU),
    { main: `globalThis.__ravenryMenuPick = 'copy-path';` },
    { clickAt: cellOf('fine'), button: 'right' }, { sleep: 400 },
    mainSave('menu-plain', MENU),
    { main: `globalThis.__ravenryMenuPick = null;` },
    // F4 the visual bell: the pane flashes.
    { js: `window.__flashes = 0; new MutationObserver(() => { if (document.getElementById('pbox0').classList.contains('bell')) window.__flashes++; }).observe(document.getElementById('pbox0'), { attributes: true }); true` },
    { type: "printf '\\a'\r" }, { sleep: 600 },
    save('bell-front', 'window.__flashes'),
    // A bell in a tab not on screen: a second shell rings while the first is in front.
    { js: `window.__first = ${R}.S.view.id; ${R}.newShell()` },
    { until: `${R}.S.view.id !== window.__first && ${T}.ready`, timeout: 10000 }, { sleep: 600 },
    { type: "sleep 1.5; printf '\\a'\r" }, { sleep: 200 },
    { js: `window.__ringer = ${R}.S.view.id; ${R}.setView({ kind: 'tab', id: window.__first })` },
    { sleep: 2500 },
    save('bell-tab', `(() => { const e = document.querySelector('#tabs .tab[data-tab="' + window.__ringer + '"]'); return { bell: !!(e && e.querySelector('.tbell')) }; })()`),
    { shot: path.join(OUT, 'bell-tab-dark.png'), el: '#tabs' },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'bell-tab-light.png'), el: '#tabs' }, { theme: 'dark' },
    { click: `#tabs .tab[data-tab]:not(.on)` , clickJs: false }, { sleep: 400 },
    { js: `${R}.setView({ kind: 'tab', id: window.__ringer })` }, { sleep: 400 },
    save('bell-opened', `(() => { const e = document.querySelector('#tabs .tab[data-tab="' + window.__ringer + '"]'); return { bell: !!(e && e.querySelector('.tbell')) }; })()`),
    // F3 closing: the ringer is idle (closes at once); a busy one asks.
    { js: `${R}.onCommand('close-tab')` }, { sleep: 800 },
    save('close-idle', `({ sheet: !document.getElementById('closesheet').hidden, gone: !${R}.S.tabs.some((t) => t.id === window.__ringer) })`),
    { js: `${R}.setView({ kind: 'tab', id: window.__first })` },
    { until: `${T}.ready && ${R}.S.view.id === window.__first`, timeout: 10000 }, { sleep: 400 },
    { type: 'sleep 600\r' }, { sleep: 800 },
    save('typed-here', `(() => { const p = ${T}.attached.pane; const ins = ${R}.store.inputsOf(p); return { last: ins.length ? ins[ins.length - 1].text : null, panel: (document.getElementById('panel').textContent || '').includes('sleep 600') }; })()`),
    { js: `${R}.onCommand('close-tab')` },
    { until: `!document.getElementById('closesheet').hidden`, timeout: 5000 }, { sleep: 200 },
    save('sheet', `({ text: document.getElementById('closesheet').textContent, focus: document.activeElement ? document.activeElement.textContent : null })`),
    { shot: path.join(OUT, 'close-dark.png') },
    { theme: 'light' }, { sleep: 300 }, { shot: path.join(OUT, 'close-light.png') }, { theme: 'dark' },
    { key: 'Enter' }, { sleep: 300 },
    save('sheet-cancel', `({ sheet: !document.getElementById('closesheet').hidden, open: ${R}.S.tabs.some((t) => t.id === window.__first) })`),
    { js: `${R}.onCommand('close-tab')` },
    { until: `!document.getElementById('closesheet').hidden`, timeout: 5000 },
    { click: '#closesheet .cs-d input' },
    { click: '#closesheet .btn.danger' }, { sleep: 800 },
    save('sheet-closed', `({ sheet: !document.getElementById('closesheet').hidden, open: ${R}.S.tabs.some((t) => t.id === window.__first) })`),
    // The settings: applied from the snapshot, Option as Meta per side, copy on select, the size keys.
    { js: `${R}.newShell()` },
    { until: `${T}.attached && ${T}.ready`, timeout: 10000 }, { sleep: 500 },
    { js: `window.ravenry.settings.set({ fontSize: 15, cursorStyle: 'bar', copyOnSelect: true, optionAsMeta: 'left', scrollback: 50000 })` }, { sleep: 600 },
    { sleep: 600 },
    save('settings-applied', `${T}.attached.client.request('pane.list', {}).then((r) => ({ size: ${T}.term.options.fontSize, cursor: ${T}.term.options.cursorStyle, scrollback: ${T}.term.options.scrollback, daemon: (r.panes.find((p) => p.id === ${T}.attached.pane) || {}).scrollback }))`),
    { js: `const ta = document.querySelector('#pbox0 .xterm-helper-textarea'); ta.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', altKey: true, bubbles: true })); window.__metaLeft = ${T}.term.options.macOptionIsMeta; ta.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltRight', key: 'Alt', altKey: true, bubbles: true })); window.__metaRight = ${T}.term.options.macOptionIsMeta; true` },
    save('option-meta', `({ left: window.__metaLeft, right: window.__metaRight })`),
    { type: "echo copy-me-please\r" }, { sleep: 500 },
    { js: `const b = ${T}.term.buffer.active; for (let y = 0; y < b.length; y++) { const x = b.getLine(y).translateToString(true).indexOf('copy-me-please'); if (x >= 0 && !b.getLine(y).translateToString(true).includes('echo')) { ${T}.term.select(x, y, 14); break; } } true` }, { sleep: 300 },
    { js: `${R}.onCommand('zoom', 1)` }, { sleep: 600 },
    save('zoom', `({ size: ${T}.term.options.fontSize })`),
    save('settings-key', `(() => { const ev = { metaKey: ${MAC}, ctrlKey: ${!MAC}, shiftKey: false, altKey: false, key: ',', type: 'keydown' }; return ${R}.views()[0].isAppKey(ev); })()`),
    // G: Cmd+N, a new window: a shell of its own; the first window's tabs as they were.
    save('tabs-before', `${R}.S.tabs.map((t) => t.id)`),
    { main: `const { Menu } = electron; const shell = Menu.getApplicationMenu().items.find((m) => m.label === 'Shell'); shell.submenu.items.find((i) => i.label === 'New Window').click(); return true;` },
    { sleep: 3000 },
    mainSave('windows', `const { BrowserWindow, Menu } = electron; const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /index\\.html/.test(w.webContents.getURL())); const other = all.find((w) => w !== win);
      let seen = null; for (let i = 0; i < 40 && other; i++) { seen = await other.webContents.executeJavaScript('(() => { const r = window.__ravenry; return r && r.term && r.term().attached ? { pane: r.term().attached.pane, tabs: r.S.tabs.length } : null; })()'); if (seen) break; await new Promise((r) => setTimeout(r, 250)); }
      if (other) { const img = await other.webContents.capturePage(); require('fs').writeFileSync(${JSON.stringify(path.join(OUT, 'window2-dark.png'))}, img.toPNG()); }
      const shell = Menu.getApplicationMenu().items.find((m) => m.label === 'Shell').submenu.items.map((i) => ({ label: i.label, acc: i.accelerator || null }));
      return { count: all.length, other: seen, shell };`),
    save('tabs-after', `${R}.S.tabs.map((t) => t.id)`),
    mainSave('closed-window', `const { BrowserWindow } = electron; const other = BrowserWindow.getAllWindows().find((w) => w !== win && /index\\.html/.test(w.webContents.getURL())); if (other) other.close(); await new Promise((r) => setTimeout(r, 800)); return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /index\\.html/.test(w.webContents.getURL())).length;`),
  ] });
  const fa = read('find-all'), fn = read('find-next'), fc = read('find-case'), fp = read('find-prev'), fx = read('find-closed');
  const nOf = (f) => { const m = /^(\d+) of (\d+)$/.exec(f?.n || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
  check('F1 Find: Cmd+F opens it over the pane, "error" found (every match counted)', !!fa?.open && fa.q === 'error' && (nOf(fa)?.[1] || 0) >= 4, fa);
  check('F1 Find: Enter goes to the next match', !!nOf(fn) && nOf(fn)[1] === nOf(fa)[1] && nOf(fn)[0] !== nOf(fa)[0], { all: fa?.n, next: fn?.n });
  // "ERROR" is on screen twice: in the printf typed and in what it printed.
  check('F1 Find: Aa (match case) leaves out ERROR', !!nOf(fc) && nOf(fc)[1] === nOf(fa)[1] - 2, { all: fa?.n, caseOn: fc?.n });
  check('F1 Find: Find Previous (Cmd+Shift+G) goes back', !!nOf(fp) && nOf(fp)[0] !== nOf(fc)[0], { before: fc?.n, prev: fp?.n });
  check('F1 Find: Esc closes it, the terminal has the keyboard again', fx && !fx.open && fx.focus === true, fx);
  const ml = read('menu-link'), mp = read('menu-plain');
  const ids = (m) => (m || []).map((x) => x.id);
  check('F2 the right-click menu over a link: Open Link and Copy Link, Copy off with no selection', ids(ml).includes('open-link') && ids(ml).includes('copy-link') && (ml || []).find((x) => x.id === 'copy')?.enabled === false, ml);
  check('F2 elsewhere: no link items; Copy Path on', !ids(mp).includes('open-link') && (mp || []).find((x) => x.id === 'copy-path')?.enabled === true, mp);
  const copies = opened().filter((x) => x.kind === 'copy').map((x) => x.what);
  check('F2 Copy Link copies the link, Copy Path the pane\'s folder', copies.includes('https://example.com/docs') && copies.some((c) => c === home || c.startsWith('/')), copies);
  check('F4 a bell in the pane on screen: it flashes', (read('bell-front') || 0) >= 1, read('bell-front'));
  check('F4 a bell in a tab not on screen: a small bell on that tab, gone once it is opened', read('bell-tab')?.bell === true && read('bell-opened')?.bell === false, { rang: read('bell-tab'), opened: read('bell-opened') });
  check('F3 an idle shell closes at once, with no question', read('close-idle')?.sheet === false && read('close-idle')?.gone === true, read('close-idle'));
  const th = read('typed-here');
  check('Typed here: a command typed shows as one entry, the whole line (not its first key)', th?.last === 'sleep 600<Enter>' && th.panel === true, th);
  const sh = read('sheet');
  check('F3 a busy shell asks: "Close this tab?", what runs, Cancel the default', /Close this tab\?/.test(sh?.text || '') && /sleep 600/.test(sh?.text || '') && sh?.focus === 'Cancel', sh);
  check('F3 Enter cancels: the tab stays', read('sheet-cancel')?.sheet === false && read('sheet-cancel')?.open === true, read('sheet-cancel'));
  const sf = settingsFile();
  check("F3 Don't ask again, then Close: the tab closes and the setting is off", read('sheet-closed')?.open === false && sf?.confirmCloseBusy === false, { closed: read('sheet-closed'), setting: sf?.confirmCloseBusy });
  const sa = read('settings-applied');
  check('settings: the snapshot\'s options on the terminal (size, cursor); the scrollback, 50,000 lines, in the terminal and kept by the daemon for the pane', sa?.size === 15 && sa.cursor === 'bar' && sa.scrollback === 50000 && sa.daemon === 50000, sa);
  if (MAC) check('settings: Option as Meta on the left only: on for left Option, off for right', read('option-meta')?.left === true && read('option-meta')?.right === false, read('option-meta'));
  check('settings: copy on select copies the selection as it is made', copies.includes('copy-me-please'), copies);
  check('settings: Cmd+= writes the size to the settings, and the terminal follows', read('zoom')?.size === 16 && settingsFile()?.fontSize === 16, { term: read('zoom'), file: settingsFile()?.fontSize });
  check('settings: Cmd+, gets past the terminal to the menu', read('settings-key') === true, read('settings-key'));
  const w = read('windows');
  check('G Cmd+N: a new window, with a shell of its own', w?.count === 2 && !!w.other?.pane, w && { count: w.count, other: w.other });
  check('G the first window\'s tabs as they were', JSON.stringify(read('tabs-before')) === JSON.stringify(read('tabs-after')), { before: read('tabs-before'), after: read('tabs-after') });
  const sl = (w?.shell || []);
  check('G the Shell menu: New Window on Cmd+N, New Session on Cmd+Shift+N, Close Window', sl.find((x) => x.label === 'New Window')?.acc?.endsWith('+N') && /Shift\+N$/.test(sl.find((x) => x.label === 'New Session…')?.acc || '') && sl.some((x) => x.label === 'Close Window'), sl);
  check('G Close Window closes that window, the first one stays', read('closed-window') === 1, read('closed-window'));
  console.log(`pictures: ${OUT}`);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  clearInterval(tick);
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
