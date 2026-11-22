#!/usr/bin/env node
// An assistant's own program never runs on a timer just to list its models
// (hub/server/modellists.mjs, docs/ASSISTANTS.md "Model lists"). On
// 2026-11-22 the installed board ran `agy models` every 10 minutes all
// night from its state's tick, each run starting Antigravity's language
// server and writing a log file into the person's ~/.gemini.
//
// A test board on :4746 whose clock runs 60 times as fast (a preload makes
// Date.now() go a fake minute each real second; its timers stay real, so
// its tick still comes every 2 s), with stand-ins for agy, opencode and
// codex that count their runs (never a real one). Everything reads the
// state the whole time, as a board page left open does:
//
// - an hour with nobody opening New session or a Model menu: no run of
//   any of the three;
// - the board's Model menu for Antigravity CLI opened (POST
//   /api/assistant/models): one `agy models`, its menu in the answer by the
//   labels, and nothing of OpenCode's; New session opened (GET
//   /api/setup/start): one `opencode models`, `agy models` not again;
// - asked again within the 10 minutes: no run; 20 idle minutes: no run;
//   asked after them: one run each;
// - a session of Antigravity CLI starting (POST /api/sessions/start)
//   after the 10 minutes: one run;
// - a run that lists nothing (signed out): the last list stays, asked
//   again within a minute no run, after it one;
// - the board restarted: the menus and the labels from the list kept in
//   its data folder, with no run;
// - the board page on that project (headless Chromium): its Model menu
//   drawn asks once, the page left open 20 fake minutes asks nothing and
//   runs nothing, the menu opened asks again.
// Usage: node tools/model-lists-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'model-lists');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc'), HOME = path.join(T, 'home'), PROJ = path.join(T, 'boat'), STUB = path.join(T, 'stub-bin'), RUNS = path.join(T, 'runs.log'), SIGNED_OUT = path.join(T, 'signed-out');
for (const d of [MC, HOME, PROJ, STUB, path.join(T, 'gemini'), path.join(T, 'opencode'), path.join(T, 'codex'), path.join(T, 'claude-projects')]) fs.mkdirSync(d, { recursive: true });

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  ' + String(extra).slice(0, 1200) : ''}`); if (ok) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-ins: each run is a line of runs.log, then the list it prints.
const stub = (name, out) => fs.writeFileSync(path.join(STUB, name), `#!/bin/sh\necho "${name} $*" >> '${RUNS}'\n${out}\n`, { mode: 0o755 });
stub('agy', `[ -e '${SIGNED_OUT}' ] && { echo 'You are not logged into Antigravity.' >&2; exit 1; }\nprintf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)\\n'`);
stub('opencode', 'echo opencode/big-pickle; echo openrouter/x-ai/grok-5');
stub('codex', 'echo \'{"models":[{"slug":"gpt-6-luna","priority":1}]}\'');
const runs = () => { const l = fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean) : []; return { agy: l.filter((x) => x.startsWith('agy ')).length, opencode: l.filter((x) => x.startsWith('opencode ')).length, codex: l.filter((x) => x.startsWith('codex ')).length, lines: l }; };
// The runs once they reach agy/opencode (a run may end after the answer
// that started it), then 300 ms more, so a run too many shows too.
async function ran(agy, opencode) {
  const end = Date.now() + 3000;
  while (Date.now() < end && !(runs().agy >= agy && runs().opencode >= opencode)) await sleep(50);
  await sleep(300);
  return runs();
}
const counts = () => { const r = runs(); return `agy ${r.agy}, opencode ${r.opencode}, codex ${r.codex}`; };

fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Boat\n\nGoal: A boat.\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'boat', name: 'Boat', folder: PROJ, workspaces: [], brief: 'BRIEF.md', assistant: 'antigravity' }] }, null, 2));
fs.writeFileSync(path.join(T, 'fake-cmux.json'), JSON.stringify({ workspaces: [] }));
fs.writeFileSync(path.join(T, 'claude-settings.json'), '{}');

// Date.now() a fake minute each real second, from the board's start.
const X = 60;
const CLOCK = `data:text/javascript,${encodeURIComponent(`const r0 = Date.now(), real = Date.now.bind(Date); Date.now = () => r0 + (real() - r0) * ${X};`)}`;
const PORT = 4746;
const base = `http://127.0.0.1:${PORT}`;
const boardEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|PORT$|STUB_|CMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|TMUX)/.test(k)));
let board = null, log = '', browser = null;
async function startBoard() {
  log = '';
  const env = withTestHome({
    ...boardEnv, HOME, PATH: `${STUB}:/usr/bin:/bin`, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_HUB_BIND: '127.0.0.1',
    MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects'), MC_CLAUDE_SETTINGS: path.join(T, 'claude-settings.json'),
    MC_ANTIGRAVITY: '1', MC_ANTIGRAVITY_BIN: path.join(STUB, 'agy'), MC_ANTIGRAVITY_HOME: path.join(T, 'gemini'),
    MC_OPENCODE: '1', MC_OPENCODE_BIN: path.join(STUB, 'opencode'), MC_OPENCODE_HOME: path.join(T, 'opencode'),
    MC_CODEX: '1', MC_CODEX_HOME: path.join(T, 'codex'), MC_CLAUDE: '1',
    RAVENRY_TERMINAL: 'cmux', CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'),
  }, HOME);
  board = spawn(process.execPath, ['--import', CLOCK, path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  board.stdout.on('data', (d) => { log += d; });
  board.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) { try { const s = await state(); if (s.generatedAt) return s; } catch { /* starting */ } await sleep(250); }
  return null;
}
async function stopBoard() {
  if (!board) return;
  const b = board; board = null;
  await new Promise((r) => { b.once('exit', r); b.kill('SIGTERM'); setTimeout(r, 4000); });
}
process.on('exit', () => { if (board) board.kill('SIGKILL'); });
const state = async () => (await fetch(base + '/api/state')).json();
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const askMenu = (assistant) => post('/api/assistant/models', { assistant });
const openStart = async () => (await fetch(base + '/api/setup/start')).json();
// The board's own clock, in fake minutes since `from` (its state's generatedAt).
const fakeNow = async () => { const s = await state(); return typeof s.generatedAt === 'number' ? s.generatedAt : Date.parse(s.generatedAt); };
// The state read each second for `min` fake minutes, as an open board page does.
async function idle(min) {
  const t0 = await fakeNow();
  let reads = 0;
  for (;;) { await sleep(1000); reads++; if ((await fakeNow()) - t0 >= min * 60000) return reads; }
}

try {
  const s0 = await startBoard();
  check('board: answers', !!s0, log.slice(-800));
  if (!s0) throw new Error('no board');

  // ---------------------------------------------------- an hour, nobody looking at a menu
  const t0 = await fakeNow();
  const reads = await idle(60);
  const hour = ((await fakeNow()) - t0) / 60000;
  const r1 = runs();
  check(`an hour of the board's clock (${hour.toFixed(0)} fake min, ${reads} state reads): no agy, opencode or codex run`, hour >= 60 && r1.agy === 0 && r1.opencode === 0 && r1.codex === 0, `${counts()} ${r1.lines.join(' | ')}`);
  const s1 = await state();
  check('meanwhile the state\'s menus hold each default only', s1.startModels && s1.startModels.antigravity.length === 1 && s1.startModels.opencode.length === 1, JSON.stringify(s1.startModels));

  // ---------------------------------------------------- the Model menu, then New session
  const a1 = await askMenu('antigravity');
  let r = await ran(1, 0);
  check('the Model menu for Antigravity CLI opened: one `agy models`, none of OpenCode\'s', r.agy === 1 && r.opencode === 0, counts());
  check('its answer: the menu by the labels', a1.status === 200 && Array.isArray(a1.body.menu) && a1.body.menu.some((o) => o.id === 'gemini-3.8-flash-high' && o.label === 'Gemini 3.8 Flash (High)'), JSON.stringify(a1.body));
  const ns1 = await openStart();
  r = await ran(1, 1);
  check('New session opened: one `opencode models`, `agy models` not again (its list is fresh)', r.opencode === 1 && r.agy === 1, counts());
  check('New session\'s menus: OpenCode\'s and Antigravity CLI\'s lists', ns1.models && ns1.models.opencode.some((o) => o.id === 'openrouter/x-ai/grok-5') && ns1.models.antigravity.some((o) => o.label === 'Claude Sonnet 4.6 (Thinking)'), JSON.stringify(ns1.models));
  let s2 = null;
  for (let i = 0; i < 50 && !(s2 && s2.startModels.opencode.length === 3); i++) { s2 = await state(); await sleep(100); }
  check('the state carries them too', s2.startModels.antigravity.length === 3 && s2.startModels.opencode.length === 3, JSON.stringify(s2.startModels));
  const cl = await askMenu('claude');
  r = await ran(1, 1);
  check('Claude Code\'s menu opened: nothing runs (its models are not listed by a program)', cl.status === 200 && r.agy === 1 && r.opencode === 1 && r.codex === 0, counts());

  // ---------------------------------------------------- within the cache age, then after it
  await idle(5);
  await askMenu('antigravity'); await openStart(); await askMenu('opencode');
  r = await ran(1, 1);
  check('asked again 5 fake minutes later: no run', r.agy === 1 && r.opencode === 1, counts());
  await idle(20);
  check('20 idle fake minutes: no run', runs().agy === 1 && runs().opencode === 1 && runs().codex === 0, counts());
  await askMenu('antigravity');
  r = await ran(2, 1);
  check('the Model menu opened after them: one more `agy models`', r.agy === 2 && r.opencode === 1, counts());
  await openStart();
  r = await ran(2, 2);
  check('New session opened after them: one more `opencode models`, `agy models` not again', r.opencode === 2 && r.agy === 2, counts());

  // ---------------------------------------------------- a session starting
  await idle(11);
  const st = await post('/api/sessions/start', { projectId: 'boat', assistant: 'antigravity' });
  r = await ran(3, 2);
  check('a session of Antigravity CLI starting, 11 fake minutes later: one more `agy models`', r.agy === 3 && r.opencode === 2, `${counts()} start: ${st.status} ${JSON.stringify(st.body).slice(0, 200)}`);

  // ---------------------------------------------------- a run that lists nothing
  await idle(11);
  fs.writeFileSync(SIGNED_OUT, '');
  const a2 = await askMenu('antigravity');
  r = await ran(4, 2);
  check('signed out: the run lists nothing, the last list stays', r.agy === 4 && a2.body.menu.some((o) => o.id === 'gemini-3.8-flash-high'), `${counts()} ${JSON.stringify(a2.body)}`);
  await askMenu('antigravity');
  r = await ran(4, 2);
  check('asked again at once: no run', r.agy === 4, counts());
  fs.rmSync(SIGNED_OUT);
  await idle(2);
  await askMenu('antigravity');
  r = await ran(5, 2);
  check('asked again after a minute: one run', r.agy === 5, counts());

  // ---------------------------------------------------- a restart
  const before = runs();
  await stopBoard();
  const kept = JSON.parse(fs.readFileSync(path.join(MC, 'model-lists.json'), 'utf8'));
  check('the lists kept in the data folder', kept.antigravity && kept.antigravity.list.length === 2 && kept.opencode && kept.opencode.list.length === 2, JSON.stringify(kept));
  const s3 = await startBoard();
  check('restarted board: answers', !!s3, log.slice(-800));
  await idle(15);
  const s4 = await state();
  const after = runs();
  check('restarted: the menus from the kept lists, and 15 fake minutes with no run', s4.startModels.antigravity.some((o) => o.label === 'Gemini 3.8 Flash (High)') && s4.startModels.opencode.length === 3 && after.agy === before.agy && after.opencode === before.opencode && after.codex === 0, `${counts()} ${JSON.stringify(s4.startModels)}`);

  // ---------------------------------------------------- the board page
  // Headless, on the project (its new sessions start Antigravity CLI):
  // the Model menu drawn asks once; left open, nothing more; opened, it
  // asks again (a run only once the list is old). The restarted board's
  // clock is behind the one that kept the list, so the list counts as old.
  browser = await chromium.launch();
  const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const asks = [];
  pg.on('request', (q) => { if (q.url().endsWith('/api/assistant/models')) asks.push(q.postDataJSON()); });
  await pg.goto(`${base}/#boat`);
  await pg.waitForSelector('select[data-pm-pid="boat"][data-pm-kind="antigravity"]', { timeout: 15000 });
  let labels = [];
  for (let i = 0; i < 50 && !labels.includes('Gemini 3.8 Flash (High)'); i++) { labels = await pg.$$eval('select[data-pm-pid="boat"] option', (os) => os.map((o) => o.textContent)); await sleep(100); }
  r = await ran(before.agy + 1, before.opencode);
  check('the board page on the project: its Model menu drawn asks once, one `agy models`, the menu by the labels', asks.length === 1 && asks[0].assistant === 'antigravity' && r.agy === before.agy + 1 && r.opencode === before.opencode && labels.includes('Gemini 3.8 Flash (High)'), `${counts()} asks ${JSON.stringify(asks)} labels ${labels}`);
  await idle(20);
  r = runs();
  check('the page left open 20 fake minutes: no ask, no run', asks.length === 1 && r.agy === before.agy + 1 && r.opencode === before.opencode && r.codex === 0, `${counts()} asks ${asks.length}`);
  // Opened from the keyboard (focus): a first-run card covers the page's pointer.
  const SEL = 'select[data-pm-pid="boat"]';
  await pg.focus(SEL);
  r = await ran(before.agy + 2, before.opencode);
  await pg.$eval(SEL, (x) => x.blur());
  check('the Model menu opened after them: one ask, one `agy models`', asks.length >= 2 && r.agy === before.agy + 2 && r.opencode === before.opencode, `${counts()} asks ${asks.length}`);
  await pg.focus(SEL);
  r = await ran(before.agy + 2, before.opencode);
  check('opened again at once: no run', r.agy === before.agy + 2, counts());
  console.log(`\nRuns over the whole test: ${counts()}`);
} catch (e) {
  check('ran to the end', false, e.stack);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopBoard();
}
if (!failed) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* left for a look */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
