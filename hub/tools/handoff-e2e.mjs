// Phase C proof, end to end, on a SCRATCH cmux workspace this script makes
// (mc-test-handoff, never focused) and closes at the end. A test server on
// :4601 reads only a scratch registry, fake transcripts and a fake brief, so
// nothing real is read for state and nothing real is written.
//
//   queued (past 50%) -> "Hand off now" pressed headless -> the hook blocks
//   a stop -> the "agent" writes the hand-off -> the board opens ONE fresh tab
//   in the same workspace running the resume command -> resumed. Then it
//   proves the start never repeats, even across a server restart.
//
// Usage: node tools/handoff-e2e.mjs <shotsDir>
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.resolve(process.argv[2] || path.join(ROOT, '.tmp/shots/phase-c'));
const PORT = 4601;
const BASE = `http://localhost:${PORT}`;
const CMUX = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const T = path.join(ROOT, '.tmp', 'handoff-e2e');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const CLAUDE = path.join(T, 'claude-projects');
for (const d of [MC, PROJ, CLAUDE, SHOTS]) fs.mkdirSync(d, { recursive: true });

const cm = (args, json) => {
  const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...args] : args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
  return json ? JSON.parse(out) : out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The project: a git repo with a brief, committed, so "Work committed" is true.
const BRIEF = path.join(PROJ, 'BRIEF.md');
fs.writeFileSync(BRIEF, `# Handoff test

Goal: Prove the clean hand-off on a scratch workspace.
Kind: Test
Stage: Build

## Plan
### Phase C
- [x] Stop hook
- [>] Board auto-start
- [ ] Docs

## Next step
Write docs/HANDOFF.md.

## Hand-off
- 2026-11-02 18:00 Phase B finished; phase C starts from the hook.
`);
const git = (...a) => execFileSync('git', ['-C', PROJ, '-c', 'user.name=mc-test', '-c', 'user.email=mc-test@localhost', ...a], { encoding: 'utf8' });
const WORK = path.join(PROJ, 'board.js');
fs.writeFileSync(WORK, '// work in progress\n');
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Scratch project for the hand-off test');
// Uncommitted work, so the queued sheet shows one check still open.
fs.appendFileSync(WORK, '// more work, not committed yet\n');

// The "old session": a fake transcript at 52% of 1M.
const SID = '0c0ffee0-0000-4000-8000-00000000c0de';
const tdir = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'));
fs.mkdirSync(tdir, { recursive: true });
const TRANSCRIPT = path.join(tdir, SID + '.jsonl');
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
fs.writeFileSync(TRANSCRIPT, [
  { type: 'user', cwd: PROJ, sessionId: SID, message: { role: 'user', content: 'Finish the board side of the hand-off.' }, timestamp: ago(30) },
  { type: 'assistant', cwd: PROJ, sessionId: SID, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Board side done: the checks card and the Hand off now button. Committed.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 3000, cache_read_input_tokens: 520000, output_tokens: 900 } }, timestamp: ago(2) },
  { type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: ago(2) },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

// Scratch workspace: one tab running the fake Claude prompt.
cm(['new-workspace', '--name', 'mc-test-handoff', '--focus', 'false', '--cwd', PROJ, '--command', `node ${path.join(ROOT, 'tools/fake-claude.mjs')}`]);
await sleep(1500);
const findWs = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces).find((w) => w.title === 'mc-test-handoff');
let ws = findWs();
if (!ws) { console.error('scratch workspace did not appear'); process.exit(1); }
const WS = ws.id;
const surfaces = () => findWs().panes.flatMap((p) => p.surfaces);
const OLD = surfaces()[0].id;
console.log('scratch workspace', ws.ref, WS, 'old tab', surfaces()[0].ref);

fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, handoffAutoStart: true, handoffCommand: "printf 'FRESH SESSION PROMPT: %s\\n'" },
  projects: [{ id: 'handoff-test', name: 'Handoff test', folder: PROJ, workspaces: [WS], brief: 'BRIEF.md', waitingOn: null }],
}, null, 2));

const env = { ...process.env, RAVENRY_HOME: MC, MC_CLAUDE_PROJECTS: CLAUDE, PORT: String(PORT), MC_NO_EVENTS: '1' };
let server;
const startServer = async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('  [server!] ' + d));
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/state')).ok) return; } catch { /* not yet */ } await sleep(250); }
  throw new Error('test server did not start');
};
const stopServer = async () => { server.kill(); await sleep(400); };
const state = async () => (await (await fetch(BASE + '/api/state')).json()).projects.find((p) => p.id === 'handoff-test');
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(400); } return null; };
const markerFile = path.join(MC, 'handoffs', SID + '.json');
const marker = () => { try { return JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { return null; } };

let browser;
try {
  await startServer();
  const p0 = await waitFor(async () => { const p = await state(); return p && p.sessions.length && p.sessions[0].handoff && p.sessions[0].handoff.state === 'queued' && p.sessions[0].handoff.checks[2].ok === false ? p : null; });
  check('past 50% shows as queued; uncommitted work leaves "Work committed" open', !!p0, p0 ? JSON.stringify(p0.sessions[0].handoff.checks.map((k) => k.label + '=' + k.ok)) : '');
  check('list flag says "Hand-off after this task"', !!p0 && p0.flags.some((f) => f.kind === 'hand' && f.title === 'Hand-off after this task'));

  // Headless: the queued sheet, then press "Hand off now".
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' })).newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`${BASE}/?theme=dark#handoff-test`);
  await page.waitForSelector('#d-handoff .card');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'queued-sheet.png') });
  console.log('card:', (await page.textContent('#d-handoff')).replace(/\s+/g, ' ').trim());
  await page.click('[data-act="handoff"]');
  await page.waitForSelector('#toast:not([hidden])');
  console.log('toast:', await page.textContent('#toast'));
  check('"Hand off now" writes the request marker', marker() && marker().state === 'queued' && !!marker().manualAt && marker().workspaceId === WS);

  // The agent commits its work: the check turns green.
  git('commit', '-q', '-am', 'Commit the work');
  const pc = await waitFor(async () => { const p = await state(); return p.sessions[0].handoff.checks[2].ok ? p : null; });
  check('after the commit, "Work committed" is checked', !!pc);

  // The old session stops: the hook (installed nowhere, run by hand) blocks it.
  const hook = (extra) => spawnSync(process.execPath, [path.join(ROOT, 'hooks/handoff-stop.mjs')], {
    input: JSON.stringify({ session_id: SID, transcript_path: TRANSCRIPT, cwd: PROJ, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], session_crons: [], last_assistant_message: 'Board side done. Committed.', ...extra }),
    env: { ...process.env, RAVENRY_HOME: MC, CMUX_WORKSPACE_ID: WS, CMUX_SURFACE_ID: OLD }, encoding: 'utf8',
  });
  const r1 = hook({});
  const out1 = r1.stdout.trim() ? JSON.parse(r1.stdout) : null;
  check('hook blocks the stop and names BRIEF.md', out1 && out1.decision === 'block' && out1.reason.includes(BRIEF), out1 ? out1.reason.split('\n')[1] : r1.stderr);
  check('marker: requested', marker().state === 'requested');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(SHOTS, 'requested-sheet.png') });

  // The "agent" writes its hand-off and commits; then its next stop.
  fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('## Hand-off\n', `## Hand-off\n- 2026-11-02 21:40 Board side of the hand-off done; docs next.\n  - State: hook and board committed.\n  - Next step: write docs/HANDOFF.md.\n  - Open items: none.\n  - Key files: ${path.join(PROJ, 'BRIEF.md')}\n`));
  git('commit', '-q', '-am', 'Write the hand-off');
  const r2 = hook({ stop_hook_active: true, last_assistant_message: 'Hand-off written to BRIEF.md.' });
  check('stop after the hand-off: no block', !r2.stdout.trim());

  const resumed = await waitFor(() => (marker() && marker().state === 'resumed' ? marker() : null), 20000);
  check('board opened the fresh session and marked it resumed', !!resumed, resumed ? `${resumed.resumeSurfaceRef}: ${resumed.resumeCommand}` : JSON.stringify(marker()));
  check('history: queued -> requested -> written -> resumed', JSON.stringify((marker().history || []).map((x) => x.state)) === '["queued","requested","written","resumed"]', JSON.stringify((marker().history || []).map((x) => x.state)));
  const all = surfaces();
  check('exactly one new tab, old tab still there', all.length === 2 && all.some((x) => x.id === OLD), all.map((x) => x.ref + ' ' + x.title).join(', '));
  await sleep(1200);
  const fresh = all.find((x) => x.id !== OLD);
  const screen = fresh ? cm(['read-screen', '--workspace', WS, '--surface', fresh.id, '--lines', '20']) : '';
  fs.writeFileSync(path.join(SHOTS, 'fresh-tab-screen.txt'), screen);
  check('fresh tab ran the resume command in the project folder', /FRESH SESSION PROMPT: Read the Hand-off section of BRIEF\.md and continue from it\./.test(screen));
  const oldScreen = cm(['read-screen', '--workspace', WS, '--surface', OLD, '--lines', '20']);
  check('old tab untouched (still the fake prompt, nothing typed)', /fake claude for ravenry tests/.test(oldScreen) && !/received:/.test(oldScreen));

  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(SHOTS, 'resumed-sheet.png') });
  console.log('card:', (await page.textContent('#d-handoff')).replace(/\s+/g, ' ').trim());

  // Never twice: more ticks, a server restart, and another stop.
  await sleep(6000);
  check('no second tab after more ticks', surfaces().length === 2);
  await stopServer();
  await startServer();
  await sleep(6000);
  check('no second tab after a server restart', surfaces().length === 2);
  const r3 = hook({});
  check('later stops of the old session stay silent', !r3.stdout.trim());
  const p1 = await state();
  const oldS = p1.sessions.find((x) => x.surfaceId === OLD);
  check('old session reads "handed", not a hand-back', oldS && oldS.state === 'handed', oldS ? oldS.state : 'missing');
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
  try { cm(['close-workspace', '--workspace', WS]); console.log('closed scratch workspace'); } catch (e) { console.error('could not close scratch workspace', e.message); }
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
