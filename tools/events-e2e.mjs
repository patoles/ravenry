// Events first, end to end: a test board on :4601 (RAVENRY_HOME, transcripts and
// project under .tmp/events-e2e) with tools/fake-cmux.mjs as its cmux, so it
// never reaches the real cmux. hooks/events.mjs runs as Claude Code would run
// it, posts to the test board, and the board's state is checked per mapping.
// Then one headless shot of a sheet whose state came from events.
// Usage: node tools/events-e2e.mjs [shotsDir]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.resolve(process.argv[2] || path.join(ROOT, '.tmp/shots/events'));
const PORT = 4601;
const BASE = `http://127.0.0.1:${PORT}`;
const T = path.join(ROOT, '.tmp', 'events-e2e');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const CLAUDE = path.join(T, 'claude-projects');
const FAKE = path.join(T, 'fake-cmux.json');
for (const d of [MC, PROJ, path.join(PROJ, 'sub'), CLAUDE, SHOTS, path.join(T, 'root')]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// The project: a committed repo with a brief.
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Events test\n\nGoal: Prove that hook events decide the state before the screen does.\nKind: Test\nStage: Build\n\n## Next step\nWire the installer.\n');
const git = (...a) => execFileSync('git', ['-C', PROJ, '-c', 'user.name=mc-test', '-c', 'user.email=mc-test@localhost', ...a], { encoding: 'utf8' });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Scratch project for the events test');

fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root') },
  projects: [{ id: 'evproj', name: 'Events Test', folder: PROJ, workspaces: ['ws-ev'], brief: 'BRIEF.md' }],
}, null, 2));

// Fake cmux: one workspace, two tabs, both showing Claude at an empty prompt.
const W = 100;
const RULE = '─'.repeat(W);
const atRest = (topic) => `\n⏺ ${topic}\n\n✻ Worked for 2m 3s · done 9:41 PM\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: [{ id: 'ws-ev', ref: 'workspace:1', title: 'Events test', cwd: PROJ, surfaces: [{ id: 'sf-ev-1', ref: 'surface:1', title: '✳ Events hook' }, { id: 'sf-ev-2', ref: 'surface:2', title: '✳ Screen only' }] }],
  screens: { 'sf-ev-1': atRest('Wrote hooks/events.mjs.'), 'sf-ev-2': atRest('Older work.') },
}));

// Transcripts, in the folder Claude Code would use for PROJ.
const TDIR = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'));
fs.mkdirSync(TDIR, { recursive: true });
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const SID1 = 'e1e1e1e1-0000-4000-8000-000000000001'; // tab 1, reports by hook
const SID2 = 'e2e2e2e2-0000-4000-8000-000000000002'; // no terminal tab at all
const SID3 = 'e3e3e3e3-0000-4000-8000-000000000003'; // tab 2, no events (screen)
const rec = (sid, cwd, type, extra, at) => JSON.stringify({ type, cwd, sessionId: sid, timestamp: at, ...extra });
const said = (sid, cwd, text, at) => rec(sid, cwd, 'assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: 180000, output_tokens: 300 } } }, at);
const turn = (sid, cwd, prompt, text, m) => [rec(sid, cwd, 'user', { message: { role: 'user', content: prompt } }, ago(m + 1)), said(sid, cwd, text, ago(m)), rec(sid, cwd, 'system', { subtype: 'turn_duration' }, ago(m))].join('\n') + '\n';
const TR1 = path.join(TDIR, SID1 + '.jsonl');
const TR3 = path.join(TDIR, SID3 + '.jsonl');
const SUB = path.join(PROJ, 'sub');
const TR2 = path.join(CLAUDE, SUB.replace(/[^A-Za-z0-9-]/g, '-'), SID2 + '.jsonl');
fs.mkdirSync(path.dirname(TR2), { recursive: true });
fs.writeFileSync(TR1, turn(SID1, PROJ, 'Start on the events hook.', 'Read the docs for the five events. Ready to build.', 30));
fs.writeFileSync(TR3, turn(SID3, PROJ, 'Look at the old screen code.', 'Looked at it. Nothing to change.', 40 * 60));
fs.writeFileSync(TR2, turn(SID2, SUB, 'Check the sub folder.', 'Checked.', 5));

// The test board.
const env = {
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE,
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
};
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const state = async () => (await fetch(BASE + '/api/state')).json();
const proj = async () => (await state()).projects.find((p) => p.id === 'evproj');
const sess = (p, sf) => p && p.sessions.find((s) => s.surfaceId === sf);
async function until(cond, ms = 4000) {
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < ms) {
    try { p = await proj(); if (p && cond(p)) return { p, ms: Date.now() - t0 }; } catch { /* starting */ }
    await sleep(25);
  }
  return { p, ms: null };
}
const r0 = await until((p) => p.sessions.length >= 2, 15000);
check('test board on :4601 is up and shows the two fake tabs', r0.ms != null, r0.p ? r0.p.sessions.map((s) => s.surfaceId).join(', ') : serverLog.slice(-400));
const tab2 = sess(r0.p, 'sf-ev-2');
check('fallback: a tab with no events is read from the screen', tab2 && tab2.source === 'screen' && /guess/.test(tab2.method), tab2 ? `${tab2.state} via ${tab2.method}; ${tab2.reasons.join('; ')}` : '');

// The hook, as Claude Code runs it.
function hook(input, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs')], { env: { ...process.env, RAVENRY_HOME: MC, MC_BOARD_URL: BASE, CMUX_WORKSPACE_ID: 'ws-ev', CMUX_SURFACE_ID: 'sf-ev-1', ...extraEnv } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    c.stdin.end(JSON.stringify({ transcript_path: TR1, cwd: PROJ, permission_mode: 'auto', session_id: SID1, ...input }));
  });
}
// Runs the hook, then waits for the board to show `cond`; reports both times.
async function step(name, input, cond, extraEnv) {
  const h = await hook(input, extraEnv);
  const r = await until(cond);
  const s = r.p && (sess(r.p, 'sf-ev-1') || r.p.sessions[0]);
  check(name, h.code === 0 && h.out === '' && r.ms != null, `hook ${h.ms.toFixed(0)} ms, board showed it ${r.ms != null ? r.ms + ' ms' : 'NEVER'} after${s ? `; ${r.p.state} / ${s.state} (${s.source}): ${s.reasons.join('; ')}` : ''}`);
  return r.p;
}

let p = await step('SessionStart maps the tab by CMUX_SURFACE_ID; at rest = back to you', { hook_event_name: 'SessionStart', source: 'startup' },
  (p) => { const s = sess(p, 'sf-ev-1'); return s && s.sessionId === SID1 && s.method === 'hook events (surface id)' && s.source === 'events' && s.state === 'handback' && p.state === 'you'; });

const t2 = sess(p, 'sf-ev-2');
check('tab 2, still without events, takes the other transcript and stays on the screen', t2 && t2.sessionId === SID3 && t2.source === 'screen', t2 ? `${t2.state} (${t2.source}) via ${t2.method}` : '');

p = await step('UserPromptSubmit -> working (the screen still shows an empty prompt)', { hook_event_name: 'UserPromptSubmit', prompt: 'Build it.' },
  (p) => sess(p, 'sf-ev-1').state === 'working' && p.state === 'work' && sess(p, 'sf-ev-1').source === 'events');

const MSG = 'Claude needs your permission to use Bash';
p = await step('Notification permission_prompt -> needs you, with the message', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: MSG, title: 'Permission needed' },
  (p) => sess(p, 'sf-ev-1').state === 'dialog' && p.state === 'you' && p.line === MSG && sess(p, 'sf-ev-1').dialog === true);

// The shot: the sheet of a state that came from events, reason line visible.
const browser = await chromium.launch({ headless: true });
async function shoot(file, { w = 1440, h = 1000, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?theme=dark#evproj`);
  await page.waitForSelector('#d-why', { timeout: 15000 });
  await page.waitForTimeout(700);
  if (mobile) await page.evaluate(() => document.querySelector('#sheet').scrollIntoView());
  const why = await page.textContent('#d-why');
  await page.screenshot({ path: file });
  await ctx.close();
  return { why, errors };
}
let shot = await shoot(path.join(SHOTS, 'permission-from-events.png'));
check('sheet: reason line visible and names hook events as the source', /^From hook events: permission prompt/.test(shot.why) && shot.why.includes(MSG) && !shot.errors.length, `"${shot.why}"`);

// A question at the end of the turn, in the transcript and in the Stop input.
const Q = 'Should I wire the installer next?';
fs.appendFileSync(TR1, said(SID1, PROJ, `The hook writes one line per event and posts it.\n\n${Q}`, new Date().toISOString()) + '\n');
p = await step('Stop ending on a question -> asked, with the question', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `The hook writes one line per event and posts it.\n\n${Q}`, background_tasks: [], session_crons: [] },
  (p) => sess(p, 'sf-ev-1').state === 'asked' && p.state === 'you' && p.question === Q);
shot = await shoot(path.join(SHOTS, 'asked-from-events-phone.png'), { w: 390, h: 844, mobile: true });
check('phone sheet: reason line names hook events', /^From hook events: turn ended/.test(shot.why) && !shot.errors.length, `"${shot.why}"`);

p = await step('Stop with a background task running -> still working', { hook_event_name: 'Stop', last_assistant_message: 'Started the test run.', background_tasks: [{ id: 't1', type: 'shell', status: 'running' }] },
  (p) => sess(p, 'sf-ev-1').state === 'working' && p.state === 'work');

p = await step('Stop with nothing running, no question -> back to you', { hook_event_name: 'Stop', last_assistant_message: 'Done. Committed.', background_tasks: [] },
  (p) => sess(p, 'sf-ev-1').state === 'handback' && p.state === 'you');

p = await step('SessionEnd -> session gone, project idle', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
  (p) => sess(p, 'sf-ev-1').state === 'none' && p.state === 'idle');

// A session in no terminal the board knows: found by cwd, shown from events.
p = await step('no terminal tab: attached by cwd, asked from events', { hook_event_name: 'Stop', session_id: SID2, cwd: SUB, transcript_path: TR2, last_assistant_message: 'Checked the sub folder.\n\nKeep it or drop it?' },
  (p) => { const s = sess(p, 'ev:' + SID2); return s && s.state === 'asked' && s.method === 'hook events, no terminal tab' && s.terminal === false && p.state === 'you'; },
  { CMUX_WORKSPACE_ID: '', CMUX_SURFACE_ID: '' });

// A POSTed event only (nothing on disk), 60 s old, for tab 2: the events now
// say working, but the screen read since shows it at rest, so the turn
// ended without a Stop (Esc, a crash).
const posted = { at: new Date(Date.now() - 60000).toISOString(), event: 'UserPromptSubmit', session_id: SID3, cwd: PROJ, transcript_path: TR3, workspace_id: 'ws-ev', surface_id: 'sf-ev-2' };
const pr = await fetch(BASE + '/api/hook-event', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ravenry': '1' }, body: JSON.stringify(posted) });
let r = await until((p) => { const s = sess(p, 'sf-ev-2'); return s && s.source === 'events' && s.method === 'hook events (surface id)' && /without a Stop/.test(s.reasons.join(' ')) && s.state !== 'working'; });
const s2 = r.p && sess(r.p, 'sf-ev-2');
check('POST-only event maps tab 2; the screen at rest catches the missing Stop', pr.status === 200 && r.ms != null, s2 ? `${s2.state} (${s2.source}): ${s2.reasons.join('; ')}` : '');
const bad = await fetch(BASE + '/api/hook-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(posted) });
check('a POST without the board header is refused', bad.status === 403);
const legacy = await fetch(BASE + '/api/hook-event', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mission-control': '1' }, body: JSON.stringify(posted) });
check('a POST with the pre-rename header (x-mission-control) is still taken', legacy.status === 200);

await browser.close();
server.kill();
await sleep(300);
// Board gone: the hook still exits 0, silently, at once.
const down = await hook({ hook_event_name: 'UserPromptSubmit' });
check('board down: hook exits 0, silent', down.code === 0 && down.out === '', `${down.ms.toFixed(0)} ms`);
const lines = fs.readFileSync(path.join(MC, 'events', SID1 + '.jsonl'), 'utf8').trim().split('\n').length;
check('event file holds one line per hook run', lines === 8, `${lines} lines`);

console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}  (shots in ${path.relative(ROOT, SHOTS)}/)`);
process.exit(fails ? 1 : 0);
