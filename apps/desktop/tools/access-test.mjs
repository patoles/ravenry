#!/usr/bin/env node
// FEATURES ONB-007 in the Electron app, as in the Mac app (6720460): the
// window says what the hub says about a folder macOS protects, in the Mac
// app's words (shared/strings/en.json), and the app, in front, asks macOS
// for a folder the hub has no answer for itself, then tells the hub to ask
// again (POST /api/access/retry; src/main/accessask.ts).
//
// The built app runs offscreen on a stub hub that goes through the hub's
// states (hub/server/access.mjs view and its 503):
//   503      macOS is asking (the 503 before the first state, its path a
//            test's folder): the sidebar note and the Start card with the
//            question and Open Files & Folders; the app reads that folder
//            and posts the retry
//   waiting  past the 3 s grace: the state's access.waiting, the project's
//            lock says it waits; that folder is not read twice
//   refused  access.denied: "Ravenry can't read ~/Documents." with the
//            remove-and-add steps and Open Full Disk Access, over Start too;
//            the refused folder (another test folder) is read, retry again
//   slow     access.slow (a stale Full Disk Access entry): the same words;
//            a slow folder is never read (asking changes nothing)
// Each button's URL is read from the app's record (RAVENRY_OPEN_LOG:
// offscreen, nothing opens). The folders read are the test's own: a test's
// run never reads the person's protected folders (accessask.ts personsOwn,
// test/accessask.test.ts).
//
//   node build.mjs && node tools/access-test.mjs [OUT] [--exe APP_EXECUTABLE]
//
// Writes electron-access-waiting.png, electron-access-waiting-card.png,
// electron-access-refused.png and electron-access-refused-card.png to OUT.
import { hubState } from './stub-state.mjs';
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';
import { SETTINGS_FILES, SETTINGS_FULL_DISK, refusedWords, waitingWords } from '../../../hub/server/access.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(REPO, 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'access-test'));
fs.mkdirSync(OUT, { recursive: true });
const en = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'strings', 'en.json'), 'utf8'));
const t = (k, vars = {}) => en[k].replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvacc-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
// The folders the app reads for macOS: a test's own, never a protected one.
const ASK_A = path.join(root, 'ask-documents');
const ASK_B = path.join(root, 'ask-desktop');
const ASK_C = path.join(root, 'ask-slow');
for (const d of [ASK_A, ASK_B, ASK_C]) fs.mkdirSync(d);
const openLog = path.join(root, 'open.jsonl');
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200) : ''}`); if (ok) passes++; else fails++; };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });

// The board: one project in ~/Documents (marked while macOS has not let the board read it), one outside it.
const now = new Date().toISOString();
const session = (id, state, topic) => ({ surfaceId: `ravenry:${id}`, topic, live: true, state, since: now, source: 'events', terminal: true, term: 'ravenry', termName: 'Ravenry', machine: null, assistant: 'claude', working: state === 'working', words: { line: topic, headline: topic, quick: [] }, screen: [], handed: false });
const project = (id, folder, state, s, access) => ({ id, name: id, state, since: now, folder, folderShort: folder.replace('/Users/you', '~'), line: s.topic, headline: s.topic, quick: [], brief: null, primary: s.surfaceId, machine: null, waitingOn: null, timeline: [], sessions: [s], ...(access ? { access } : {}) });
const say = (p) => p.replace(path.dirname(ASK_A), '~').replace(/~\/ask-documents$/, '~/Documents').replace(/~\/ask-desktop$/, '~/Desktop').replace(/~\/ask-slow$/, '~/Documents');
const base = (access, projAccess) => ({
  generatedAt: now, settings: { handoffThreshold: 50 }, homes: { '': '/Users/you' }, checkpoints: [], machines: [], pages: [],
  projects: [
    project('garden-planner', '/Users/you/Documents/garden-planner', 'idle', session('g1', 'idle', 'Seed list'), projAccess),
    project('kite', '/Users/you/Projects/kite', 'work', session('k1', 'working', 'Kite tail'), null),
  ],
  access,
});
const folder = (p, name) => ({ folder: say(p), name, path: p });
const STATES = {
  waiting: base({ waiting: { ...folder(ASK_A, 'Documents'), since: now }, denied: [], slow: [], blocked: [{ ...folder(ASK_A, 'Documents'), state: 'waiting', since: now }], words: waitingWords(ASK_A, say), settings: SETTINGS_FILES }, { state: 'waiting', folder: '~/Documents', name: 'Documents' }),
  refused: base({ waiting: null, denied: [folder(ASK_B, 'Desktop')], slow: [], blocked: [{ ...folder(ASK_B, 'Desktop'), state: 'denied', since: now }], words: refusedWords([ASK_B], say), settings: SETTINGS_FULL_DISK }, { state: 'denied', folder: '~/Desktop', name: 'Desktop' }),
  slow: base({ waiting: null, denied: [], slow: [folder(ASK_C, 'Documents')], blocked: [{ ...folder(ASK_C, 'Documents'), state: 'slow', since: now }], words: refusedWords([ASK_C], say), settings: SETTINGS_FULL_DISK }, { state: 'slow', folder: '~/Documents', name: 'Documents' }),
};
let phase = '503';
const retries = [];
const streams = new Set();
const push = () => { for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(STATES[phase]))}\n\n`); };
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/test/phase?p=')) { phase = q.url.split('=')[1]; push(); r.writeHead(200); r.end('{}'); return; }
  if (q.method === 'POST' && q.url === '/api/access/retry') {
    retries.push({ phase, header: q.headers['x-ravenry'] || null });
    fs.writeFileSync(path.join(work, `retry-${retries.length}`), '1');
    r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, asked: [] })); return;
  }
  if (phase === '503') {
    // The hub's 503 before its first state while macOS asks (hub/server/index.mjs accessWait).
    r.writeHead(503, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ starting: true, waitingFor: '~/Documents', folder: 'Documents', path: ASK_A, settings: SETTINGS_FILES, error: waitingWords(ASK_A, say) }));
    return;
  }
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(STATES[phase]))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(STATES[phase]))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const save = (name, expr) => ({ save: { expr, out: path.join(work, `${name}.json`) } });
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const opened = () => { try { return fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const go = (p) => ({ main: `await fetch(${JSON.stringify(`${hubUrl}/test/phase?p=${p}`)});` });
// What the window shows: the sidebar's note (its bold part, all of it, its button), the Start card, the project locks' tips.
const SEEN = `(() => { const clean = (s) => s == null ? null : s.replace(/\\u2060/g, '');
  const n = document.querySelector('#side .access-note'); const c = document.querySelector('#start:not([hidden]) .access-card');
  return {
    note: n ? { bold: clean(n.querySelector('b') && n.querySelector('b').textContent), text: clean(n.textContent), button: n.querySelector('.ac-open') && n.querySelector('.ac-open').textContent } : null,
    card: c ? { where: c.classList.contains('alone') ? 'alone' : c.classList.contains('over') ? 'over' : '?', title: c.querySelector('.ac-t') && c.querySelector('.ac-t').textContent, sub: c.querySelector('.ac-s') && c.querySelector('.ac-s').textContent, button: c.querySelector('.ac-open') && c.querySelector('.ac-open').textContent, lock: !!c.querySelector('.ac-lock svg'), withStart: !!document.querySelector('#start .fl-card') } : null,
    locks: [...document.querySelectorAll('#side .acc-tag')].map((e) => ({ tip: e.title, row: (e.closest('[data-key]') || e.parentElement).getAttribute('data-key') })),
  }; })()`;
const NOTE_HAS = (s) => `(() => { const n = document.querySelector('#side .access-note'); return !!n && n.textContent.replace(/\\u2060/g, '').includes(${JSON.stringify(s)}); })()`;
const env = { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_OPEN_LOG: openLog };
let log = '';

try {
  log = await runApp({ name: 'access', work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, width: 1280, height: 800, steps: [
    { ready: true },
    // 503: macOS is asking.
    { until: NOTE_HAS(t('start.askingT', { folder: '~/Documents' })), timeout: 20000 },
    { click: '#side .brand button[aria-label="New session"]' },
    { until: `!!document.querySelector('#start:not([hidden]) .access-card .ac-open')`, timeout: 10000 },
    { sleep: 300 },
    save('s503', SEEN),
    { shot: path.join(OUT, 'electron-access-waiting.png') },
    { shot: path.join(OUT, 'electron-access-waiting-card.png'), el: '#start .access-card' },
    { click: '#side .access-note .ac-open' },
    { click: '#start .access-card .ac-open' },
    // In front: the app reads the folder the 503 names, then the hub asks again.
    { main: 'globalThis.__ravenryAccessFront = true; win.emit("focus");' },
    { wait: path.join(work, 'retry-1'), timeout: 15000 },
    // Past the grace: the state names the folder it waits for.
    go('waiting'),
    { until: `!!document.querySelector('#side .acc-tag') && !!window.__ravenry.S.hubStatus.reachable`, timeout: 15000 },
    { sleep: 400 },
    save('swaiting', SEEN),
    { click: '#side .access-note .ac-open' },
    // Refused.
    go('refused'),
    { until: NOTE_HAS(t('start.deniedT', { folders: '~/Desktop' })), timeout: 15000 },
    { wait: path.join(work, 'retry-2'), timeout: 15000 },
    { click: '#side .brand button[aria-label="New session"]' },
    { until: `!!document.querySelector('#start:not([hidden]) .access-card.over')`, timeout: 10000 },
    { sleep: 400 },
    save('srefused', SEEN),
    { shot: path.join(OUT, 'electron-access-refused.png') },
    { shot: path.join(OUT, 'electron-access-refused-card.png'), el: '#start .access-card' },
    { click: '#side .access-note .ac-open' },
    { click: '#start .access-card .ac-open' },
    // Slow: allowed but checked file by file.
    go('slow'),
    { until: `(window.__ravenry.S.hub.access.slow || []).length === 1 && ${NOTE_HAS(t('start.deniedT', { folders: '~/Documents' }))}`, timeout: 15000 },
    { sleep: 800 },
    save('sslow', SEEN),
    { click: '#side .access-note .ac-open' },
    { sleep: 300 },
  ] });
  const askingNote = { bold: t('start.askingT', { folder: '~/Documents' }), text: `${t('start.askingT', { folder: '~/Documents' })} ${t('side.accessClosed', { folder: 'Documents' })}${t('side.openPrivacy')}`, button: t('side.openPrivacy') };
  const s503 = read('s503');
  check('503: the sidebar note asks the Mac app\'s question, Closed it?, and Open Files & Folders', !!s503 && JSON.stringify(s503.note) === JSON.stringify(askingNote), s503 && s503.note);
  check('503: the Start card alone, a lock, the question, where to turn it on, Open Files & Folders', !!s503 && !!s503.card && s503.card.where === 'alone' && s503.card.lock && s503.card.title === t('start.askingT', { folder: '~/Documents' }) && s503.card.sub === t('start.askingS', { folder: '~/Documents' }) && s503.card.button === t('start.openPrivacy'), s503 && s503.card);
  const sw = read('swaiting');
  check('waiting (state past the grace): the same note from the state\'s access.waiting', !!sw && JSON.stringify(sw.note) === JSON.stringify(askingNote), sw && sw.note);
  check('waiting: the project in that folder has a lock, its tip says it waits; the one outside has none', !!sw && sw.locks.length === 1 && sw.locks[0].tip === t('side.accessProject', { folder: '~/Documents' }) && /garden-planner/.test(sw.locks[0].row || ''), sw && sw.locks);
  const deniedText = (f) => `${t('start.deniedT', { folders: f })} ${t('start.denied')}${t('start.openFullDisk')}`;
  const sr = read('srefused');
  check('refused: "Ravenry can\'t read ~/Desktop." with the remove-and-add steps and Open Full Disk Access', !!sr && !!sr.note && sr.note.bold === t('start.deniedT', { folders: '~/Desktop' }) && sr.note.text === deniedText('~/Desktop') && sr.note.button === t('start.openFullDisk'), sr && sr.note);
  check('refused: the card over Start says the same, with Open Full Disk Access', !!sr && !!sr.card && sr.card.where === 'over' && sr.card.withStart && sr.card.lock && sr.card.title === t('start.deniedT', { folders: '~/Desktop' }) && sr.card.sub === t('start.denied') && sr.card.button === t('start.openFullDisk'), sr && sr.card);
  check('refused: the project\'s lock says Ravenry can\'t read the folder', !!sr && sr.locks.length === 1 && sr.locks[0].tip === t('side.accessProjectDenied', { folder: '~/Desktop' }), sr && sr.locks);
  const ss = read('sslow');
  check('slow (a stale Full Disk Access entry): the refused words and Open Full Disk Access', !!ss && !!ss.note && ss.note.text === deniedText('~/Documents') && ss.note.button === t('start.openFullDisk') && ss.locks.length === 1 && ss.locks[0].tip === t('side.accessProjectDenied', { folder: '~/Documents' }), ss);
  check('the words are the hub\'s: its refused words are the note\'s, its waiting words name the same folder', refusedWords([ASK_B], say) === `${t('start.deniedT', { folders: '~/Desktop' })} ${t('start.denied')}` && waitingWords(ASK_A, say).startsWith(t('start.askingT', { folder: '~/Documents' })));
  const o = opened().map((x) => `${x.kind} ${x.what}`);
  const want = [SETTINGS_FILES, SETTINGS_FILES, SETTINGS_FILES, SETTINGS_FULL_DISK, SETTINGS_FULL_DISK, SETTINGS_FULL_DISK].map((u) => `settings ${u}`);
  check('each button opens the pane the hub names: Files & Folders while asking, Full Disk Access once refused or slow', JSON.stringify(o) === JSON.stringify(want), o);
  const reads = log.split('\n').filter((l) => l.startsWith('access: macOS answered this app for '));
  check('in front, the app read the folder the 503 named, then posted the retry', reads.some((l) => l.includes(ASK_A) && l.endsWith('(ok); the hub asks again')) && retries.length >= 1 && retries[0].phase === '503' && retries[0].header === '1', { reads, retries });
  check('the waiting folder already asked is not read again; the refused one is, then the retry', reads.filter((l) => l.includes(ASK_A)).length === 1 && reads.some((l) => l.includes(ASK_B)) && retries.length === 2 && retries[1].phase === 'refused', { reads, retries });
  check('a slow folder is never read (asking changes nothing), no third retry', !reads.some((l) => l.includes(ASK_C)) && retries.length === 2, { reads, retries });
  console.log(`pictures: ${OUT}`);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 3000));
} finally {
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED, ${passes} pass` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
