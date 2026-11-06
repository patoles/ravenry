// A hand-off written while its marker was still queued, end to end, on a
// test board (:4667) whose cmux is tools/fake-cmux.mjs, with a scratch
// RAVENRY_HOME, fake transcripts and a fake brief. Nothing real is read or
// written, and no real cmux workspace is touched.
//
// The real case (2026-11-03): 11 finished agents Claude Code still listed as
// running kept a session's marker queued, so the hook never asked. The session
// wrote its hand-off and opened the fresh session itself. The stop after the
// write took a fresh base, so the board never saw a hand-off: the old session
// stayed the project's primary and the board showed Needs you.
//
//   three tabs in one workspace: the old session (queued, past the line), a
//   fresh one whose first prompt is "Read the Hand-off section of ...", and
//   an older side session still open.
//   The user has the old one chosen on the Sessions card. The old session writes
//   the hand-off (a Bash call naming the brief, a new dated bullet) ->
//   queued -> written -> resumed on the fresh tab already open (no second
//   tab asked for) -> the old session reads "handed", the fresh one is the
//   primary, the choice moves to it and the card lists it first.
//
// Usage: node tools/handoff-queued-e2e.mjs [<shotsDir>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.resolve(process.argv[2] || path.join(ROOT, '.tmp', 'handoff-queued-shots'));
const PORT = 4667;
const BASE = `http://127.0.0.1:${PORT}`;
const T = path.join(ROOT, '.tmp', 'handoff-queued-e2e');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const CLAUDE = path.join(T, 'claude-projects');
for (const d of [MC, PROJ, CLAUDE, SHOTS, path.join(MC, 'events'), path.join(MC, 'handoffs')]) fs.mkdirSync(d, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const BRIEF = path.join(PROJ, 'BRIEF.md');
fs.writeFileSync(BRIEF, '# Queued test\n\nGoal: Prove a hand-off written while queued.\n\n## Next step\nKeep going.\n\n## Hand-off\n- 2026-11-01 10:00 Older hand-off.\n');

const WS = 'ws-queued-0001';
const OLD = 'sf-old-0001';
const NEW = 'sf-new-0001';
const SID_OLD = '0c0ffee0-0000-4000-8000-0000000000a1';
const SID_NEW = '0c0ffee0-0000-4000-8000-0000000000b2';
// A third, older session still open in the same workspace (a side task).
const SIDE = 'sf-side-0001';
const SID_SIDE = '0c0ffee0-0000-4000-8000-0000000000c3';
const tdir = path.join(CLAUDE, PROJ.replace(/[^A-Za-z0-9-]/g, '-'));
fs.mkdirSync(tdir, { recursive: true });
const TR_OLD = path.join(tdir, SID_OLD + '.jsonl');
const TR_NEW = path.join(tdir, SID_NEW + '.jsonl');
const TR_SIDE = path.join(tdir, SID_SIDE + '.jsonl');
const line = (r) => JSON.stringify(r) + '\n';
fs.writeFileSync(TR_OLD, [
  { type: 'user', cwd: PROJ, sessionId: SID_OLD, message: { role: 'user', content: 'Build the gallery.' }, timestamp: ago(120) },
  { type: 'assistant', cwd: PROJ, sessionId: SID_OLD, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Gallery built and committed.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 3000, cache_read_input_tokens: 600000, output_tokens: 900 } }, timestamp: ago(20) },
  { type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: ago(20) },
].map(line).join(''));
fs.writeFileSync(TR_NEW, [
  { type: 'user', cwd: PROJ, sessionId: SID_NEW, message: { role: 'user', content: 'Read the Hand-off section of BRIEF.md and continue from it.' }, timestamp: ago(3) },
  { type: 'assistant', cwd: PROJ, sessionId: SID_NEW, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Read the hand-off. Starting on the gallery mockup.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 300 } }, timestamp: ago(2) },
  { type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: ago(2) },
].map(line).join(''));

fs.writeFileSync(TR_SIDE, [
  { type: 'user', cwd: PROJ, sessionId: SID_SIDE, message: { role: 'user', content: 'Check the icon sizes.' }, timestamp: ago(200) },
  { type: 'assistant', cwd: PROJ, sessionId: SID_SIDE, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Icon sizes checked.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 3000, cache_read_input_tokens: 90000, output_tokens: 300 } }, timestamp: ago(190) },
  { type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: ago(190) },
].map(line).join(''));

// The events hook's record of the sessions.
const evLine = (sid, sf, tp, event, at, extra = {}) => line({ at, event, session_id: sid, cwd: PROJ, transcript_path: tp, workspace_id: WS, surface_id: sf, ...extra });
fs.writeFileSync(path.join(MC, 'events', SID_OLD + '.jsonl'),
  evLine(SID_OLD, OLD, TR_OLD, 'SessionStart', ago(121), { source: 'startup' }) +
  evLine(SID_OLD, OLD, TR_OLD, 'UserPromptSubmit', ago(120)) +
  evLine(SID_OLD, OLD, TR_OLD, 'Stop', ago(20), { ends_on_question: false, background_tasks: 0 }));
fs.writeFileSync(path.join(MC, 'events', SID_SIDE + '.jsonl'),
  evLine(SID_SIDE, SIDE, TR_SIDE, 'SessionStart', ago(201), { source: 'startup' }) +
  evLine(SID_SIDE, SIDE, TR_SIDE, 'UserPromptSubmit', ago(200)) +
  evLine(SID_SIDE, SIDE, TR_SIDE, 'Stop', ago(190), { ends_on_question: false, background_tasks: 0 }));
fs.writeFileSync(path.join(MC, 'events', SID_NEW + '.jsonl'),
  evLine(SID_NEW, NEW, TR_NEW, 'SessionStart', ago(4), { source: 'startup' }) +
  evLine(SID_NEW, NEW, TR_NEW, 'UserPromptSubmit', ago(3)) +
  evLine(SID_NEW, NEW, TR_NEW, 'Stop', ago(2), { ends_on_question: false, background_tasks: 0 }));

// The old session's marker as the hook left it: queued for an hour by
// "11 background tasks running", with a base taken at its last stop.
const { handoffHash } = await import('../server/handoff.mjs');
const queuedAt = ago(60);
fs.writeFileSync(path.join(MC, 'handoffs', SID_OLD + '.json'), JSON.stringify({
  cwd: PROJ, transcriptPath: TR_OLD, workspaceId: WS, surfaceId: OLD, handoffFile: BRIEF, handoffBase: handoffHash(BRIEF),
  projectId: 'queued-test', folder: PROJ, pct: 60.3, tokens: 603006, window: 1000000, threshold: 50, ceiling: 70,
  lastStopAt: ago(20), queuedAt, state: 'queued', lastCheck: { at: ago(20), clean: false, why: '11 background tasks running' },
  sessionId: SID_OLD, updatedAt: ago(20), history: [{ state: 'queued', at: queuedAt }],
}, null, 2));

const RULE = '─'.repeat(80);
const prompt = (topic) => `⏺ ${topic}\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: [{ id: WS, ref: 'workspace:90', title: 'Queued test', cwd: PROJ, surfaces: [
    { id: OLD, ref: 'surface:901', title: '✳ Gallery build' },
    { id: NEW, ref: 'surface:902', title: '✳ Gallery mockup' },
    { id: SIDE, ref: 'surface:903', title: '✳ Icon sizes' },
  ] }],
  screens: { [OLD]: prompt('Gallery built and committed.'), [NEW]: prompt('Read the hand-off. Starting on the gallery mockup.'), [SIDE]: prompt('Icon sizes checked.') },
}, null, 2));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, handoffAutoStart: true, handoffCommand: "printf 'FRESH: %s\\n'" },
  projects: [{ id: 'queued-test', name: 'Queued test', folder: PROJ, workspaces: [WS], brief: 'BRIEF.md', waitingOn: null }],
}, null, 2));

const env = {
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
  MC_CLAUDE_PROJECTS: CLAUDE, MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE,
};
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const state = async () => (await (await fetch(BASE + '/api/state')).json()).projects.find((p) => p.id === 'queued-test');
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* not up yet */ } await sleep(300); } return null; };
const marker = () => { try { return JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', SID_OLD + '.json'), 'utf8')); } catch { return null; } };

let browser;
try {
  const p0 = await waitFor(async () => { const p = await state(); return p && p.sessions.length === 3 ? p : null; });
  check('board: three sessions in the project, the old one queued', !!p0 && p0.sessions.find((x) => x.surfaceId === OLD)?.handoff?.state === 'queued', p0 ? JSON.stringify(p0.sessions.map((x) => [x.surfaceId, x.state, x.handoff && x.handoff.state])) : log.slice(-400));
  await sleep(2500);
  check('nothing written yet: the marker stays queued', marker().state === 'queued');

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' })).newPage();
  page.on('pageerror', (e) => { console.error('pageerror', e.message); fails++; });
  await page.goto(`${BASE}/?theme=light#queued-test`);
  await page.waitForSelector('#d-sessions .sess');
  const order = async () => page.$$eval('#d-sessions .sess', (els) => els.map((e) => e.dataset.surface));
  const chosen = async () => page.$eval('#d-sessions .sess.sel', (e) => e.dataset.surface).catch(() => null);
  check('card order before: newest started first (fresh, old, side)', JSON.stringify(await order()) === JSON.stringify([NEW, OLD, SIDE]), JSON.stringify(await order()));
  await page.click(`#d-sessions .sess[data-surface="${OLD}"]`);
  await page.waitForTimeout(300);
  check('the user chooses the old session on the Sessions card', (await chosen()) === OLD);
  await page.screenshot({ path: path.join(SHOTS, 'before-old-chosen.png') });

  // The old session writes its hand-off by a Bash call, as the real one did.
  const now = new Date();
  fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('## Hand-off\n', `## Hand-off\n- ${stamp(now)} Gallery built; the mockup round is next.\n  - State: committed.\n  - Next step: the gallery mockup.\n`));
  fs.appendFileSync(TR_OLD, line({ type: 'assistant', cwd: PROJ, sessionId: SID_OLD, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_w1', name: 'Bash', input: { command: `python3 - <<'EOF'\np='${BRIEF}'\ns=open(p).read()\nEOF` } }], usage: { input_tokens: 6, cache_creation_input_tokens: 100, cache_read_input_tokens: 603000, output_tokens: 50 } }, timestamp: now.toISOString() }) +
    line({ type: 'assistant', cwd: PROJ, sessionId: SID_OLD, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hand-off written to BRIEF.md.' }], usage: { input_tokens: 6, cache_creation_input_tokens: 100, cache_read_input_tokens: 603100, output_tokens: 20 } }, timestamp: new Date(now.getTime() + 1000).toISOString() }) +
    line({ type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: new Date(now.getTime() + 1100).toISOString() }));
  // Its stop: the events hook records it (the hand-off hook ran too, but its
  // queued check is what this test leaves to the board).
  fs.appendFileSync(path.join(MC, 'events', SID_OLD + '.jsonl'), evLine(SID_OLD, OLD, TR_OLD, 'Stop', new Date(now.getTime() + 1200).toISOString(), { ends_on_question: false, background_tasks: 0 }));

  const done = await waitFor(() => (marker().state === 'resumed' ? marker() : null), 20000);
  check('board: queued -> written -> resumed', !!done && JSON.stringify(done.history.map((x) => x.state)) === '["queued","written","resumed"]', JSON.stringify(marker().history));
  check('resumed on the fresh tab already open, found, not opened by the board', !!done && done.resumeSurfaceId === NEW && done.resumeSessionId === SID_NEW && done.resumedBy === 'found' && !done.resumeStartedAt && done.writtenSeenBy === 'board');
  check('no second fresh session asked of cmux', !fs.existsSync(FAKE + '.new-workspace.log') && !/fresh session for/.test(log) && !(marker().resumeError));

  const p1 = await waitFor(async () => { const p = await state(); return p && p.sessions.find((x) => x.surfaceId === OLD)?.state === 'handed' ? p : null; });
  check('old session reads "handed"; the fresh one is the primary', !!p1 && p1.primary === NEW, p1 ? `primary ${p1.primary}` : '');
  await page.waitForFunction((sf) => document.querySelector('#d-sessions .sess.sel')?.dataset.surface === sf, NEW, { timeout: 8000 }).catch(() => null);
  check('the choice moved from the old session to the fresh one', (await chosen()) === NEW, await chosen());
  check('card order after: fresh on top, the handed-off one below every open one (fresh, side, old)', JSON.stringify(await order()) === JSON.stringify([NEW, SIDE, OLD]), JSON.stringify(await order()));
  await page.screenshot({ path: path.join(SHOTS, 'after-handoff.png') });
  await page.$eval('#d-sessions', (e) => e.scrollIntoView({ block: 'center' }));
  await page.locator('#d-sessions').screenshot({ path: path.join(SHOTS, 'sessions-card.png') });

  // Chosen again on purpose, a handed-off session stays chosen.
  await page.click(`#d-sessions .sess[data-surface="${OLD}"]`);
  await page.waitForTimeout(2600);
  check('choosing the handed-off session again keeps it chosen', (await chosen()) === OLD);

  // Phone width: the same card order.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light', isMobile: true, hasTouch: true })).newPage();
  await phone.goto(`${BASE}/?theme=light#queued-test`);
  await phone.waitForSelector('#d-sessions .sess');
  await phone.$eval('#d-sessions', (e) => e.scrollIntoView({ block: 'center' }));
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: path.join(SHOTS, 'after-handoff-phone.png') });
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  if (browser) await browser.close();
  server.kill();
}
if (fails) console.log(log.split('\n').slice(-30).join('\n'));
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}  (shots in ${SHOTS})`);
process.exit(fails ? 1 : 0);
