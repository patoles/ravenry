// Mac notifications, posted by the app itself (src/main/notify.ts), proved
// without one reaching the screen: offscreen, a stand-in takes the place of
// Electron's Notification and records each one (RAVENRY_NOTIFY_LOG).
//   - Alerts' Send a test reaches the app over the board's stream, is posted
//     as "Ravenry" with the test's text and a click handler, and Alerts then
//     says it was shown (a picture);
//   - a click on one opens the session it is about;
//   - macOS not allowing Ravenry's notifications (the stand-in refuses as
//     macOS does): Alerts says so, with a button that opens System Settings
//     > Notifications (a picture), and never that it was shown.
//
//   node tools/notify-check.mjs [OUT] [--exe APP_EXECUTABLE]
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
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'notify-check'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvnc-'));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (!ok) fails++; };
const R = 'window.__ravenry';
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ALERT_LINE = `(document.querySelector('#inapp .ia-al .tx span') || {}).textContent || ''`;
const TEST_BTN = `[...document.querySelectorAll('#inapp .ia-al button')].find((b) => b.textContent === 'Send a test')`;

async function run(name, standIn) {
  const work = path.join(root, name);
  const rt = path.join(root, name + '-r');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  const hub = await startDemoHub({ dir: path.join(root, name + '-demo'), port: await freePort() });
  const notes = path.join(work, 'notes.jsonl');
  const opens = path.join(work, 'open.jsonl');
  const steps = [
    { ready: true },
    { until: `${R}.S.hub && ${R}.S.hub.projects && ${R}.S.hub.projects.length > 2`, timeout: 30000 },
    { js: `${R}.setView({ kind: 'alerts', back: { kind: 'decisions' } }), true` },
    { until: `!!(${TEST_BTN})`, timeout: 10000 },
    { click: TEST_BTN, clickJs: true, after: 300 },
    { until: standIn === 'denied' ? `/not allowed/.test(${ALERT_LINE})` : `/Last shown/.test(${ALERT_LINE})`, timeout: 15000, soft: true },
    { sleep: 400 },
    { save: { expr: ALERT_LINE, out: path.join(work, 'line.json') } },
    { save: { expr: `[...document.querySelectorAll('#inapp .ia-al')][0].innerText`, out: path.join(work, 'row.json') } },
    { shot: path.join(OUT, `alerts-${name}-1280-dark.png`), settle: 300 },
  ];
  if (standIn === 'denied') {
    steps.push({ click: `[...document.querySelectorAll('#inapp .ia-al button')].find((b) => b.textContent === 'Open Notifications settings')`, clickJs: true, after: 500 });
  } else {
    // One about a session, as the hub sends it; its click opens that session.
    steps.push({ main: `await globalThis.__ravenryNotify({ id: 'n-click', title: 'garden-planner needs you', body: 'Asked you a question', kind: 'question', projectId: 'garden-planner', surfaceId: 'sf-1' }); const n = globalThis.__ravenryNotes; n[n.length - 1].emit('click'); return n.length;` });
    steps.push({ until: `${R}.S.view.kind === 'tab' && /garden-planner/.test(JSON.stringify(${R}.S.tabs.find((t) => t.id === ${R}.S.view.id) || {}))`, timeout: 8000, soft: true });
    steps.push({ save: { expr: `JSON.stringify(${R}.S.tabs.find((t) => t.id === ${R}.S.view.id) || ${R}.S.view)`, out: path.join(work, 'opened.json') } });
    // The one-app rule (the native Mac app beside this one): a second app's
    // stream, a stand-in, connects last; each notification then reaches one
    // app only, the one focused last. This window's focus is its own
    // handler's report (main.ts), the stand-in's a POST as the native app's.
    steps.push({ main: ONE_APP_OPEN(hub.url) });
    for (const [k, focus] of [['window', 'win.emit(\'focus\')'], ['other', `await post('/api/alerts/desktop/focus', { client: 'stand-in-app' })`], ['window-again', 'win.emit(\'focus\')']]) {
      steps.push({ main: `${ONE_APP_HELPERS(hub.url)} ${focus}; await new Promise((r) => setTimeout(r, 400)); const a = globalThis.__ravenryNotes.length, b = globalThis.__otherApp.got.length; const t = await post('/api/alerts/desktop/test', {}); await new Promise((r) => setTimeout(r, 400)); return { test: t, window: globalThis.__ravenryNotes.length - a, other: globalThis.__otherApp.got.length - b };`, out: path.join(work, `one-${k}.json`) });
    }
    steps.push({ main: `globalThis.__otherApp.ac.abort(); return true;` });
  }
  fs.mkdirSync(path.join(root, name + '-home'), { recursive: true });
  try {
    await runApp({ name, work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home: path.join(root, name + '-home'), hubUrl: hub.url, timeoutMs: 120000,
      env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_NOTIFY_LOG: notes, RAVENRY_OPEN_LOG: opens, ...(standIn ? { RAVENRY_NOTIFY_STANDIN: standIn } : {}) }, width: 1280, height: 820, steps });
  } finally { hub.stop(); stopDaemons(BIN, rt); }
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch { return null; } };
  return { notes: lines(notes), opens: lines(opens), line: read('line.json'), row: read('row.json'), opened: read('opened.json'), one: Object.fromEntries(['window', 'other', 'window-again'].map((k) => [k, read(`one-${k}.json`)])) };
}

// In the app's main process: a POST to the hub as an app sends it, and a
// second app's notification stream (?app=1&client=stand-in-app) that
// answers each notification shown, as the native Mac app does.
const ONE_APP_HELPERS = (url) => `const post = async (p, body) => { const r = await fetch(${JSON.stringify(url)} + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };`;
const ONE_APP_OPEN = (url) => `${ONE_APP_HELPERS(url)}
  const g = globalThis.__otherApp = { got: [], ac: new AbortController() };
  const res = await fetch(${JSON.stringify(url)} + '/api/events?app=1&client=stand-in-app', { signal: g.ac.signal, headers: { Accept: 'text/event-stream' } });
  (async () => { const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\\n\\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); if (!/^event: notify$/m.test(blk)) continue; const d = JSON.parse(blk.split('\\n').find((l) => l.startsWith('data: ')).slice(6)); g.got.push(d); void post('/api/alerts/desktop/result', { id: d.id, ok: true }); } } } catch { /* closed */ } })();
  await new Promise((r) => setTimeout(r, 600));
  return true;`;

try {
  const a = await run('shown', null);
  const t = a.notes[0] || {};
  check('Send a test: the app posted one notification, titled "Ravenry", with the test\'s text and a click handler', a.notes.length >= 1 && t.title === 'Ravenry' && t.body === 'A test: Mac notifications reach you.' && t.clickable === true, a.notes);
  check('Alerts then says it was shown (alerts-shown-1280-dark.png)', /^On\. Last shown/.test(a.line || ''), a.line);
  check('a click on one about a session opens that session', /garden-planner\/sf-1|garden-planner/.test(a.opened || ''), a.opened);
  const one = a.one || {};
  const only = (r, who) => !!r && r.test && r.test.ok === true && r.window === (who === 'window' ? 1 : 0) && r.other === (who === 'other' ? 1 : 0);
  check('one app only: with a second app connected after it, a test goes to this window once it was focused, never to both', only(one.window, 'window'), one.window);
  check('one app only: the other app focused, the next goes to it alone; this window focused again, to this window alone', only(one.other, 'other') && only(one['window-again'], 'window'), { other: one.other, again: one['window-again'] });
  const b = await run('denied', 'denied');
  check('macOS not allowing them: Alerts says so, never "shown" (alerts-denied-1280-dark.png)', /has not allowed Ravenry's notifications/.test(b.line || '') && !/shown/i.test(b.line || ''), b.line);
  check('with a button that opens System Settings > Notifications', /Open Notifications settings/.test(b.row || '') && b.opens.some((o) => o.kind === 'settings' && o.what === 'notifications'), { row: b.row, opens: b.opens });
} catch (e) {
  check('ran', false, String(e.message || e).slice(0, 2000));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
