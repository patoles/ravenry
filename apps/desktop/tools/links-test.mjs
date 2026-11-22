#!/usr/bin/env node
// Links in a terminal are found out (0.1.20). Cmd+click opens one (Ctrl+click
// off the Mac), the Mac's way, and:
//   - the pointer on a link shows a small "Cmd+click to open" tip; the link
//     is not underlined and the pointer stays the text one;
//   - holding Cmd turns it into a link: a solid underline and the pointing
//     hand, and the tip goes; letting go turns it back;
//   - a plain click opens nothing, Cmd+click opens it;
//   - the setting "Open links with a single click" (off by default): the
//     link is underlined with the hand without Cmd, no tip, and a plain
//     click opens it.
// For a plain URL in the text and an OSC 8 link a program names. Pictures,
// dark and light.
//
//   node tools/links-test.mjs [OUT] [--exe APP_EXECUTABLE]
import { hubState } from './stub-state.mjs';
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'links-test'));
fs.mkdirSync(OUT, { recursive: true });
const MAC = process.platform === 'darwin';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvln-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
const openLog = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (!ok) fails++; };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'links-test' });
const script = [
  "printf 'read https://example.com/plain for more\\n\\n'",
  "printf 'or the \\033]8;;https://example.com/osc\\033\\\\\\033[94mDocs page\\033[39m\\033]8;;\\033\\\\ here\\n'",
  'exec cat',
].join('\n');
const { pane } = await dc.request('pane.new', { cols: 100, rows: 30, command: ['/bin/sh', '-c', script], labels: { 'ravenry.session': 'claude', 'ravenry.project': 'kite' } });
dc.close();
const KEY = `kite/ravenry:${pane.id}`;

let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane.id));
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 1000);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const T = `${R}.term()`;
const SCREEN = `(() => { const b = ${T}.term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true)); return out.join('\\n'); })()`;
const cellOf = (text) => `(() => { const t = ${T}.term; const b = t.buffer.active; const scr = document.querySelector('#term .xterm-screen').getBoundingClientRect(); const cw = scr.width / t.cols, ch = scr.height / t.rows;
  for (let y = 0; y < t.rows; y++) { const l = b.getLine(b.viewportY + y); const x = l ? l.translateToString(true).indexOf(${JSON.stringify(text)}) : -1; if (x >= 0) return { x: Math.round(scr.left + (x + 2.5) * cw), y: Math.round(scr.top + (y + 0.5) * ch) }; } return null; })()`;
const MOD = MAC ? 'meta' : 'control';
const MODKEY = MAC ? 'Meta' : 'Control';
// The pointer to a point of the page (a main-process step: the page gives the point).
const moveTo = (text, mods = []) => ({ main: `const p = await win.webContents.executeJavaScript(${JSON.stringify(cellOf(text))}); win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x - 6, y: p.y, modifiers: ${JSON.stringify(mods)} }); await new Promise((r) => setTimeout(r, 60)); win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: ${JSON.stringify(mods)} }); await new Promise((r) => setTimeout(r, 350));` });
const modDown = { main: `win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '${MODKEY}', modifiers: ['${MOD}'] }); await new Promise((r) => setTimeout(r, 200));` };
const modUp = { main: `win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '${MODKEY}', modifiers: [] }); await new Promise((r) => setTimeout(r, 200));` };
const LINK = `(() => { const s = ${T}.linkState; const scr = document.querySelector('#term .xterm-screen'); return { ...s, cursor: scr ? getComputedStyle(scr).cursor : null }; })()`;
const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
// Waits up to 3 s for the link state to settle (the app finds the link under
// the pointer a moment after it moves; a busy machine takes longer), never
// failing the run itself: the checks below say what was read.
const settle = (cond) => ({ main: `for (let i = 0; i < 60; i++) { let v = false; try { v = await win.webContents.executeJavaScript(${JSON.stringify(`(() => { try { const s = ${T}.linkState || {}; return !!(${cond}); } catch (e) { return false; } })()`)}); } catch {} if (v) break; await new Promise((r) => setTimeout(r, 50)); }` });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).what); } catch { return []; } };
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog };
const TIP = `${MAC ? 'Cmd' : 'Ctrl'}+click to open`;

const kinds = [['a plain URL', 'https://example.com/plain', 'example.com/plain'], ['an OSC 8 link', 'https://example.com/osc', 'Docs page']];
try {
  await runApp({ name: 'links', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1200, height: 800, steps: [
    { ready: true },
    { until: `document.querySelector('#side .ss[data-key="${KEY}"]')`, timeout: 15000 },
    { click: `#side .ss[data-key="${KEY}"]` },
    { until: `${T}.attached && ${T}.attached.pane === ${JSON.stringify(pane.id)} && ${SCREEN}.includes('Docs page')`, timeout: 15000 },
    save('default', `window.ravenry.settings.get().then((s) => s.settings.openLinksSingleClick)`),
    ...kinds.flatMap(([, uri, text], i) => [
      moveTo(text), settle(`s.text === ${JSON.stringify(uri)} && s.tip`), save(`hover${i}`, LINK),
      ...(i === 0 ? [{ shot: path.join(OUT, 'link-hover-dark.png') }, { theme: 'light', after: 600 }, moveTo('read'), moveTo(text), { shot: path.join(OUT, 'link-hover-light.png') }, { theme: 'dark', after: 600 }, moveTo('read'), moveTo(text)] : []),
      modDown, moveTo(text, [MOD]), settle(`s.text === ${JSON.stringify(uri)} && s.underline`), save(`held${i}`, LINK),
      ...(i === 1 ? [{ shot: path.join(OUT, 'link-cmd-dark.png') }] : []),
      modUp, moveTo(text), settle(`s.text === ${JSON.stringify(uri)} && !s.underline`), save(`released${i}`, LINK),
      // A plain click: nothing opens.
      { clickAt: cellOf(text) }, { sleep: 300 },
      { main: `require('fs').writeFileSync(${JSON.stringify(path.join(work, `plain${i}.json`))}, JSON.stringify(require('fs').existsSync(${JSON.stringify(openLog)}) ? require('fs').readFileSync(${JSON.stringify(openLog)}, 'utf8') : ''))` },
      { clickAt: cellOf(text), modifiers: [MOD] }, { sleep: 400 },
    ]),
    // The setting: a plain click opens.
    { js: `window.ravenry.settings.set({ openLinksSingleClick: true })` }, { sleep: 600 },
    moveTo('read'), moveTo('Docs page'), save('single', LINK),
    { shot: path.join(OUT, 'link-single-click-dark.png') },
    { clickAt: cellOf('Docs page') }, { sleep: 400 },
    save('kept', `window.ravenry.settings.get().then((s) => s.settings.openLinksSingleClick)`),
  ] });
  const o = opened();
  kinds.forEach(([what, uri], i) => {
    const h = read(`hover${i}`), held = read(`held${i}`), rel = read(`released${i}`);
    check(`${what}: the pointer on it shows "${TIP}"; not underlined, no pointing hand`, h?.text === uri && h.tip === TIP && !h.underline && !h.pointer && h.cursor !== 'pointer', h);
    check(`${what}: holding ${MAC ? 'Cmd' : 'Ctrl'} underlines it with the pointing hand, the tip goes`, held?.text === uri && held.underline && held.pointer && held.tip === null && held.cursor === 'pointer', held);
    check(`${what}: letting go turns it back`, rel?.text === uri && !rel.underline && !rel.pointer, rel);
    check(`${what}: a plain click opens nothing`, !read(`plain${i}`)?.includes(uri), read(`plain${i}`));
  });
  check(`${MAC ? 'Cmd' : 'Ctrl'}+click opens each, once`, o.length >= 2 && o[0] === kinds[0][1] && o[1] === kinds[1][1], o);
  const s = read('single');
  check('"Open links with a single click": underlined with the pointing hand without the key, no tip', s?.underline && s.pointer && s.tip === null, s);
  check('"Open links with a single click": a plain click opens it', o.length === 3 && o[2] === kinds[1][1], o);
  check('the setting is off by default, and kept once on', read('default') === false && read('kept') === true, { default: read('default'), kept: read('kept') });
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
