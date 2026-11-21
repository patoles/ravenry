// Antigravity CLI end to end (docs/ASSISTANTS.md, "Antigravity CLI";
// docs/FEATURES.md SESS-055): the real `agy` in a real ravenryd pane under
// a scratch board, with a scratch HOME (its ~/.gemini, Ravenry's hooks
// group and skill), a scratch project and a scratch Ravenry data folder.
//
// Without a board: the registry's words, its screen reading on screens
// captured from agy 1.5.14, its transcript, and Ravenry's group in a
// hooks.json that holds another group (added and taken out with the other
// group's bytes as they were). With the board: Set up writes the group
// (and the doctor's rows say so), the skill installs where agy lists it,
// New session lists Antigravity CLI signed in with its models (`agy
// models`), a session starts with its model and first message, Working,
// the permission prompt read from its screen as Needs you and answered
// from the board, at rest with its model chip, context and last message,
// Hand off now (the Stop hook's "continue" carries it on, the hand-off is
// written, a fresh agy session starts), and Continue by its id in a new
// pane, where a message typed from the board is answered in the same
// conversation. Remove puts the hooks file back as it was.
//
// Sign-in: agy keeps its Google sign-in in the login keychain, which
// macOS finds under HOME/Library/Keychains, so the scratch HOME links that
// folder (read only by agy, never written by the test). A PATH shim stands
// in for `open`, so nothing can open a browser; the test fails if it was
// called. Skips cleanly (exit 0) when agy or ravenryd is not here, or when
// agy is not signed in (`agy models` lists nothing).
//
// Model calls (about ten, on the cheapest model `agy models` lists, or
// ANTIGRAVITY_TEST_MODEL): the first turn (two calls), the hand-off (a few
// calls), the fresh session's first call (it is closed then), one reply
// in the resumed session.
//
// The board page at 390 px (headless Chromium): New session with
// Antigravity CLI picked and its Model menu, and the permission's Needs
// you; with OUT, their pictures go there.
//
//   node tools/antigravity-test.mjs [--keep] [--no-model] [OUT]
//
// --no-model stops before the first model call.
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + String(detail).slice(0, 1500) : ''}`); if (!ok) fails++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

// ------------------------------------------------------------ no board
const reg = await import('../server/assistants.mjs');
const ag = await import('../server/antigravity.mjs');
const agh = await import('../server/antigravityhooks.mjs');
const ags = await import('../server/antigravitysession.mjs');
const asst = await import('../server/assistant.mjs');
const RULE = '─'.repeat(120);
const pad = (l, r) => l + ' '.repeat(Math.max(2, 120 - l.length - r.length)) + r;
// Captured from agy 1.5.14 in a ravenryd pane, 120 columns (folders cut).
const SCREEN = {
  permission: ['  Antigravity CLI 1.5.14', '  Gemini 3.8 Flash (High)', '', '────────────────────────────────────────────────────────────', '> Run the shell command: wc -l notes.txt   Then reply with only the number.', '', '● Ran (wc -l notes.txt) (ctrl+o to expand)', '', 'Command', RULE, '', 'Requesting permission for:', '   wc -l notes.txt', '', 'Run this command?', '> 1. Yes, run command', "  2. Yes, and always allow in this conversation for commands that start with 'wc'", "  3. Yes, and always allow for commands that start with 'wc' (Persist to settings.json)", '  4. No, cancel', '', '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', pad('esc to cancel', 'Gemini 3.8 Flash · high'), '', ''].join('\n'),
  working: ['● Explored 1 file (notes.txt) (ctrl+o to expand)', '⣟  Counting the lines...', RULE, '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)', RULE, pad('esc to cancel', 'auto · Gemini 3.8 Flash · high'), ''].join('\n'),
  idle: ['> Reply with exactly: RESUMED-OK', '  RESUMED-OK', RULE, '>', RULE, pad('? for shortcuts', 'Gemini 3.8 Flash · low'), '', ''].join('\n'),
  draft: ['  3', RULE, '> fix the tests', RULE, pad('? for shortcuts', 'Gemini 3.8 Flash · low')].join('\n'),
  exit: [RULE, '>', RULE, 'Resume with -c (or command below):', 'agy --conversation=0f0f0f0f-0000-4000-8000-0000000000a2', ''].join('\n'),
};
{
  const a = reg.get('antigravity');
  check('registered: Antigravity CLI, third, with its own words', reg.IDS.join() === 'claude,codex,antigravity,opencode' && a && a.name === 'Antigravity CLI' && a.short === 'Antigravity' && a.bin === 'agy' && a.hooks === 'antigravity' && a.caps.resume && a.caps.model && a.caps.handoff && a.caps.permission && !a.caps.print && a.limits.length >= 3, reg.IDS.join());
  check('its first message goes after -i, a dash one as -i=', JSON.stringify(reg.promptArgs('antigravity', 'Read BRIEF.md')) === '["-i","Read BRIEF.md"]' && JSON.stringify(reg.promptArgs('antigravity', '-x')) === '["-i=-x"]');
  check('resume and model words; its ids are UUIDs', JSON.stringify(reg.words('antigravity', 'resume', 'u')) === '["--conversation","u"]' && JSON.stringify(reg.words('antigravity', 'model', 'gemini-3.8-flash-low')) === '["--model","gemini-3.8-flash-low"]' && reg.sessionIdOf('0F0F0F0F-0000-4000-8000-0000000000A2', 'antigravity') === '0f0f0f0f-0000-4000-8000-0000000000a2');
  check('its Stop carries on with "continue"; the others keep "block"', JSON.stringify(reg.stopReply('antigravity', { decision: 'block', reason: 'r' })) === '{"decision":"continue","reason":"r"}' && reg.stopReply('claude', { decision: 'block', reason: 'r' }).decision === 'block' && reg.stopReply('opencode', { decision: 'block' }).decision === 'block');
  const p = ag.parseScreen(SCREEN.permission);
  check('its permission prompt reads as a dialog: four answers, the first selected, what it runs', p.claudeLive && !p.working && p.dialog && p.dialog.options.map((o) => o.n).join() === '1,2,3,4' && p.dialog.options[0].selected && p.dialog.options[0].label === 'Yes, run command' && p.dialog.options[3].label === 'No, cancel' && p.dialog.question === 'Run this command? wc -l notes.txt', JSON.stringify(p.dialog));
  const w = ag.parseScreen(SCREEN.working);
  check('a turn running: working, Auto mode\'s placeholder is not a draft', w.claudeLive && w.working && !w.dialog && w.draft === '');
  const i = ag.parseScreen(SCREEN.idle);
  check('at rest: live, not working, nothing typed', i.claudeLive && !i.working && !i.dialog && i.draft === '');
  check('a half-typed message is a draft', ag.parseScreen(SCREEN.draft).draft === 'fix the tests');
  const x = ag.parseScreen(SCREEN.exit);
  check('its exit: not live, the conversation to resume', !x.claudeLive && x.exited && x.resumeId === '0f0f0f0f-0000-4000-8000-0000000000a2');
  check('a screen no session names: its own reading first (Claude Code\'s takes its menu for its own)', asst.parseAny(SCREEN.permission).kind === 'antigravity' && asst.parseAny(SCREEN.working).kind === 'antigravity' && asst.detect(SCREEN.idle) === 'antigravity' && asst.parseAny('me@host proj % ls\nBRIEF.md\nme@host proj % ').kind === 'claude');
  const m = ag.parseModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  check('`agy models`: ids and labels', JSON.stringify(m) === '[{"id":"gemini-3.8-flash-high","label":"Gemini 3.8 Flash (High)"},{"id":"claude-sonnet-4-6","label":"Claude Sonnet 4.6 (Thinking)"}]');
  const models = await import('../server/models.mjs');
  const menus = models.startMenus({ seen: [{ id: 'claude-sonnet-4-6', kind: 'antigravity' }, { id: 'claude-opus-5-5', kind: 'claude' }], antigravityModels: m });
  check('New session\'s Model menu: its default, then `agy models` by label; its Claude model stays out of Claude Code\'s menu', menus.antigravity[0].id === '' && menus.antigravity[1].label === 'Gemini 3.8 Flash (High)' && menus.antigravity.length === 3 && !menus.claude.some((o) => o.id === 'claude-sonnet-4-6') && !menus.codex.some((o) => o.id === 'claude-sonnet-4-6'), JSON.stringify(menus.antigravity));
  // Its transcript: steps as agy 1.5.14 writes them.
  const lines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T17:56:41Z', content: '<USER_REQUEST>\nRun the shell command: wc -l notes.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T17:56:42Z', model: 'gemini-3.8-flash-high', input_tokens: 9132, cache_read_tokens: 0, output_tokens: 126, tool_calls: [{ name: 'run_command', args: { CommandLine: '"wc -l notes.txt"' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T17:57:02Z', content: 'Command exited with code 0.' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T17:57:03Z', model: 'gemini-3.8-flash-high', input_tokens: 2258, cache_read_tokens: 7091, output_tokens: 35, content: '3' },
  ];
  const stop = { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-21T17:57:08Z', content: '<SYSTEM_MESSAGE>\nStop hook blocked termination: Reply with exactly: CONTINUED-OK\n</SYSTEM_MESSAGE>' };
  const t = ags.fromText(lines.map((l) => JSON.stringify(l)).join('\n'));
  check('its transcript: model, tokens in use (input, cache and output), last message, prompt, last tool', t.model === 'gemini-3.8-flash-high' && t.contextTokens === 2258 + 7091 + 35 && t.contextWindow === null && t.lastText === '3' && t.lastPrompt === 'Run the shell command: wc -l notes.txt' && t.lastTool.name === 'run_command' && t.lastTool.what === 'wc -l notes.txt' && !t.inTurn && !t.stopHookActive, JSON.stringify(t));
  const t2 = ags.fromText([...lines, stop].map((l) => JSON.stringify(l)).join('\n'));
  check('a Stop hook\'s reason carried on: the next Stop knows (its continuationActive never says)', t2.stopHookActive && t2.hookReason === 'Reply with exactly: CONTINUED-OK' && t2.lastPrompt === t.lastPrompt);
  // Ravenry's group beside another one, in a scratch ~/.gemini.
  const G = fs.mkdtempSync(path.join(ROOT, '.tmp', 'antigravity-hooks-'));
  const env = { MC_ANTIGRAVITY_HOME: path.join(G, '.gemini'), TEST_RAVENRY: '1' };
  fs.mkdirSync(path.join(G, '.gemini', 'config'), { recursive: true });
  const other = '{\n  "other" : {\n    "SessionStart" : [\n      {\n        "command" : "\\/usr\\/bin\\/true",\n        "timeout" : 10,\n        "type" : "command"\n      }\n    ]\n  }\n}';
  fs.writeFileSync(agh.hooksFile(env), other);
  const rv = path.resolve(process.env.RAVENRYD_BIN || path.join(REPO, 'daemon', 'ravenryd'));
  const fake = fs.existsSync(rv) ? rv : '/bin/sh';
  check('before: no group of ours', agh.status({ env }).state === 'missing');
  const p1 = agh.plan({ ravenryd: fake, env });
  agh.write(p1);
  const after = fs.readFileSync(agh.hooksFile(env), 'utf8');
  const j = JSON.parse(after);
  check('set up: our group after the other, whose bytes are as they were', after.startsWith(other.slice(0, -2)) && Object.keys(j).join() === 'other,ravenry' && agh.status({ env }).state === 'ok' && JSON.stringify(Object.keys(j.ravenry)) === '["SessionStart","PreInvocation","Stop"]' && j.ravenry.Stop[0].command.endsWith('hook --assistant antigravity --state idle --event Stop --decide --timeout 8s') && j.ravenry.Stop[0].timeout === 15, after);
  check('no PreToolUse of ours: its answer must name a decision, and nothing refuses the tool', !('PreToolUse' in j.ravenry));
  check('set up again: nothing to do', agh.plan({ ravenryd: fake, env }).changes.length === 0);
  agh.write(agh.plan({ remove: true, env }));
  check('removed: the file is back byte for byte', fs.readFileSync(agh.hooksFile(env), 'utf8') === other);
  fs.writeFileSync(agh.hooksFile(env), JSON.stringify({ ravenry: { Stop: [{ command: 'echo mine' }] } }));
  check('a "ravenry" group that is not ours is left alone', agh.status({ env }).state === 'foreign' && agh.plan({ ravenryd: fake, env }).changes.length === 0 && agh.plan({ remove: true, env }).changes.length === 0);
  check('a test that names no scratch ~/.gemini plans nothing', agh.plan({ ravenryd: fake, env: { TEST_RAVENRY: '1' } }).changes.length === 0 && !agh.present({ env: { TEST_RAVENRY: '1' }, findBin: () => '/x/agy' }));
  fs.rmSync(G, { recursive: true, force: true });
}

// ------------------------------------------------------------ the board
const findOn = (bin) => { for (const d of String(process.env.PATH || '').split(':')) { const p = path.join(d, bin); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } } return null; };
const AGY = process.env.ANTIGRAVITY_BIN || findOn('agy') || [path.join(os.homedir(), '.local', 'bin', 'agy')].find((p) => fs.existsSync(p));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(REPO, 'daemon', 'ravenryd'));
const RAVENRY = path.join(path.dirname(BIN), 'ravenry');
if (!AGY) { console.log('SKIP  the board part: agy is not installed here'); process.exit(fails ? 1 : 0); }
if (!fs.existsSync(BIN)) { console.log(`SKIP  the board part: no ravenryd at ${BIN}`); process.exit(fails ? 1 : 0); }
const KEEP = process.argv.includes('--keep');
const NO_MODEL = process.argv.includes('--no-model');
const OUT = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ? path.resolve(process.argv.slice(2).filter((a) => !a.startsWith('--'))[0]) : null;
let pw = null;
try { pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(ROOT, 'package.json'))('playwright'); } catch { pw = null; }
let browser = null;
async function phonePage() {
  if (!pw) return null;
  if (!browser) browser = await pw.chromium.launch({ headless: true });
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p = await c.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.goto(base + '/');
  return p;
}
const shot = async (p, name) => { if (OUT && p) { fs.mkdirSync(OUT, { recursive: true }); await p.screenshot({ path: path.join(OUT, name) }); console.log(`picture: ${path.join(OUT, name)}`); } };

const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'antigravity-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
const SHIMS = path.join(T, 'shims');
const GEM = path.join(HOME, '.gemini');
const AGHOME = path.join(GEM, 'antigravity-cli');
for (const d of [MC, HOME, PROJ, SHIMS, path.join(AGHOME, 'cache'), path.join(GEM, 'config'), path.join(HOME, 'Library'), path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
// Its sign-in: the login keychain, found under HOME/Library/Keychains.
const REAL = os.homedir();
fs.symlinkSync(path.join(REAL, 'Library', 'Keychains'), path.join(HOME, 'Library', 'Keychains'));
// Its first-run screens already passed (copied, never written back).
for (const f of ['cache/onboarding.json', 'jetski_state.pbtxt']) { try { fs.copyFileSync(path.join(REAL, '.gemini', 'antigravity-cli', f), path.join(AGHOME, f)); } catch { /* not there */ } }
// The project trusted; every command and write asks (no Auto mode).
fs.writeFileSync(path.join(AGHOME, 'settings.json'), JSON.stringify({ colorScheme: 'dark', agentMode: '', toolPermission: 'request-review', trustedWorkspaces: [PROJ] }, null, 2) + '\n');
// Another program's group in its hooks file, which must stay as it is.
const OTHER = '{\n  "other" : {\n    "SessionStart" : [\n      {\n        "command" : "\\/usr\\/bin\\/true",\n        "timeout" : 10,\n        "type" : "command"\n      }\n    ]\n  }\n}\n';
const HOOKS = path.join(GEM, 'config', 'hooks.json');
fs.writeFileSync(HOOKS, OTHER);
// Nothing may open a browser: `open` is a shim that only notes the call.
const OPENED = path.join(T, 'open-called.log');
for (const n of ['open', 'xdg-open']) fs.writeFileSync(path.join(SHIMS, n), `#!/bin/sh\necho "$0 $*" >> '${OPENED}'\nexit 1\n`, { mode: 0o755 });
const NODE_DIR = path.dirname(process.execPath);
const PATHS = [...new Set([SHIMS, path.dirname(AGY), NODE_DIR, path.dirname(BIN), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const AENV = { HOME, PATH: PATHS, USER: os.userInfo().username, LOGNAME: os.userInfo().username, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', BROWSER: path.join(SHIMS, 'open') };
const cleanupT = () => { if (!KEEP && !fails) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ } } };
// Signed in? Its models, listed with this HOME.
const listed = spawnSync(AGY, ['models'], { cwd: PROJ, env: AENV, encoding: 'utf8', timeout: 60000 });
const MODELS = ag.parseModels(listed.stdout || '');
if (!MODELS.length) { console.log(`SKIP  the board part: agy lists no models (not signed in?): ${String(listed.stdout || listed.stderr || '').trim().slice(0, 200)}`); cleanupT(); process.exit(fails ? 1 : 0); }
const pick = () => process.env.ANTIGRAVITY_TEST_MODEL || (MODELS.find((m) => m.id === 'gemini-3.8-flash-low') || MODELS.find((m) => /flash.*low/.test(m.id)) || MODELS.find((m) => /flash/.test(m.id)) || MODELS[0]).id;
const MODEL = pick();
const LABEL = (MODELS.find((m) => m.id === MODEL) || {}).label || MODEL;
console.log(`agy ${spawnSync(AGY, ['--version'], { env: AENV, encoding: 'utf8' }).stdout.trim()} at ${AGY}, model ${MODEL} (${LABEL})`);

// The project: a git repo with a brief.
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Proj\n\nGoal: a scratch project for the Antigravity CLI test.\n\n## Hand-off\n\n## Next step\n\n- Nothing yet\n');
fs.writeFileSync(path.join(PROJ, 'notes.txt'), 'one\ntwo\nthree\n');
const git = (...a) => execFileSync('git', a, { cwd: PROJ, env: { HOME, PATH: PATHS, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, stdio: 'ignore' });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'start');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, handoffAutoStart: true }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvag-'));
const RUN = path.join(D, 'run');
const PORT = 4794;
const base = `http://localhost:${PORT}`;
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const DENV = { ...AENV, SHELL: '/bin/zsh', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let boardLog = '';
const env = {
  ...DENV, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CLAUDE: '1', MC_CODEX: '0', MC_OPENCODE: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_ANTIGRAVITY: '1', MC_ANTIGRAVITY_HOME: GEM, MC_ANTIGRAVITY_BIN: AGY,
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine(env), stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
const cleanup = () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } cleanupT(); };
process.on('exit', cleanup);

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const proj = async () => (await get('/api/state')).body.projects.find((x) => x.id === 'proj');
const SOCK = () => fs.readdirSync(RUN).filter((n) => n.endsWith('.sock')).map((n) => path.join(RUN, n))[0];
const pane = (args) => spawnSync(RAVENRY, [...args.slice(0, 1), '--socket', SOCK(), '--no-start', ...args.slice(1)], { env: DENV, encoding: 'utf8' });
const capture = (id, history = 0) => pane(['capture', id, ...(history ? ['--history', String(history)] : [])]).stdout || '';
const first = await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r.body : null; }, 20000);
check('the board answers', !!first, boardLog.slice(-800));
if (!first) process.exit(1);
check('state lists Antigravity CLI third', (first.assistants.list || []).map((a) => a.id).join() === 'claude,codex,antigravity,opencode' && first.assistants.list[2].limits.length >= 3);

// Set up: Ravenry's group in its hooks file, and the doctor's row.
const su = await post('/api/setup/hooks', { ravenryd: BIN, only: 'antigravity' });
const hooksNow = fs.readFileSync(HOOKS, 'utf8');
check('Set up for Antigravity CLI adds its group, and only that', su.status === 200 && su.body.claude === null && su.body.codex === null && JSON.parse(hooksNow).ravenry && hooksNow.startsWith(OTHER.trimEnd().slice(0, -1).trimEnd()) && fs.readFileSync(SETTINGS, 'utf8') === '{}', su.text + hooksNow);
const rows = (await get('/api/setup/hooks')).body.rows || [];
const arow = rows.find((r) => r.kind === 'antigravity');
check('the doctor\'s rows: Antigravity CLI on', !!arow && arow.on === true && arow.state === 'ok' && arow.name === 'Antigravity CLI', JSON.stringify(rows));

// New session: found, signed in, its models.
const sv = await until(async () => { const r = await get('/api/setup/start'); return r.body.models && (r.body.models.antigravity || []).some((m) => m.id === MODEL) ? r.body : null; }, 90000, 1000);
const card = sv && (sv.assistants || []).find((a) => a.kind === 'antigravity');
check('New session lists Antigravity CLI, found and signed in (its keychain item)', !!card && card.found && card.signedIn && card.name === 'Antigravity CLI', JSON.stringify(sv && sv.assistants));
check('its Model menu: the default, then `agy models` by their labels', !!sv && sv.models.antigravity[0].id === '' && sv.models.antigravity.some((m) => m.id === MODEL && m.label === LABEL), JSON.stringify(sv && sv.models.antigravity));

// The Ravenry skill, in its global skills folder.
{
  const sk = await post('/api/setup/skills', { kind: 'antigravity', on: true, ravenryd: BIN, version: '0.0.0-test' });
  const row = sk.body && (sk.body.skills || []).find((r) => r.kind === 'antigravity');
  check('the skill installs for Antigravity CLI, in ~/.gemini/antigravity-cli/skills', sk.status === 200 && fs.existsSync(path.join(AGHOME, 'skills', 'ravenry', 'SKILL.md')) && row && row.installed && row.ours && row.dir === '~/.gemini/antigravity-cli/skills/ravenry', sk.text.slice(0, 400));
}

// The phone's New session: its card, picked, its Model menu.
{
  const p = await phonePage();
  if (!p) console.log('SKIP  the page: no Playwright');
  else {
    await p.waitForSelector('[data-act="pn-new"]', { timeout: 20000 });
    await p.tap('[data-act="pn-new"]');
    await p.waitForSelector('.ps-newmenu', { timeout: 5000 });
    await p.tap('[data-act="pn-new-session"]');
    await p.waitForSelector('.ps-ac[data-ps-asst="antigravity"]', { timeout: 10000 });
    await p.tap('.ps-ac[data-ps-asst="antigravity"]');
    await sleep(300);
    const go = await p.textContent('#ps-go');
    const opts = await p.$$eval('#ps-model option', (xs) => xs.map((x) => x.value));
    check('phone, 390 px: its card picked, Start names it, its Model menu', /^Start Antigravity CLI in /.test(go || '') && opts[0] === '' && opts.includes(MODEL), `${go} ${opts.slice(0, 5)}`);
    const wide = await p.evaluate(() => document.documentElement.scrollWidth);
    check('phone, 390 px: no sideways scroll with four assistants', wide <= 390, String(wide));
    await shot(p, 'phone-new-session-antigravity.png');
    check('no page errors', !p.errs.length, p.errs.join(' | '));
    await p.context().close();
  }
}
if (NO_MODEL) {
  const un = await post('/api/setup/hooks', { remove: true, only: 'antigravity' });
  check('removing puts the hooks file back as it was', un.status === 200 && fs.readFileSync(HOOKS, 'utf8') === OTHER, fs.readFileSync(HOOKS, 'utf8'));
  check('nothing opened a browser', !fs.existsSync(OPENED));
  if (browser) await browser.close();
  console.log(fails ? `\n${fails} failed` : '\nall passed (no model calls)');
  process.exit(fails ? 1 : 0);
}

// A session: its model and first message; the shell command asks first.
const PROMPT = 'Run the shell command: wc -l notes.txt   Then reply with only the number.';
const st = await post('/api/sessions/start', { projectId: 'proj', assistant: 'antigravity', model: MODEL, text: PROMPT, cols: 120, rows: 40 });
check('start: agy in a labelled pane, with --model and -i', st.status === 200 && st.body.pane && st.body.pane.labels['ravenry.session'] === 'antigravity' && st.body.command.includes(`--model ${MODEL}`) && / -i /.test(st.body.command), st.text.slice(0, 600));
const SURF = st.body && st.body.surfaceId;
const PANE = SURF ? SURF.replace(/^ravenry:/, '') : null;
const sess = async () => { const p = await proj(); return p && p.sessions.find((s) => s.surfaceId === SURF); };
const w1 = await until(async () => { const s = await sess(); return s && s.sessionId && /^[0-9a-f-]{36}$/.test(s.sessionId) && (s.state === 'working' || s.dialog) ? s : null; }, 90000, 300);
check('its hooks report the session through the daemon: its conversation id, Working (or already asking)', !!w1 && w1.assistant === 'antigravity', JSON.stringify(await sess()));
const SID = w1 && w1.sessionId;
const asking = await until(async () => { const p = await proj(); const s = p && p.sessions.find((x) => x.surfaceId === SURF); return s && s.dialog && p.quick && p.quick.length === 4 ? p : null; }, 120000, 400);
check('the permission prompt, read from its screen, is Needs you with its four answers', !!asking && asking.state === 'you' && asking.quick[0].label === 'Yes, run command' && asking.quick[3].label === 'No, cancel' && /wc -l notes\.txt/.test(asking.headline || asking.question || ''), JSON.stringify(asking && { state: asking.state, quick: asking.quick, headline: asking.headline, line: asking.line }));
{
  const p = await phonePage();
  if (p) {
    await p.waitForSelector('text=Yes, run command', { timeout: 20000 }).catch(() => null);
    const txt = await p.evaluate(() => document.body.innerText);
    check('phone, 390 px: Needs you shows the permission and its answers', /Yes, run command/.test(txt) && /No, cancel/.test(txt), txt.slice(0, 600));
    await shot(p, 'phone-board-antigravity-permission.png');
    await p.context().close();
  }
}
// Hand off now while it asks: the request waits for the turn's Stop,
// whose answer, "continue" with the hand-off's words, carries it on.
const ho = await post('/api/handoff', { projectId: 'proj', surfaceId: SURF });
check('Hand off now is taken while it asks (it waits for the next stop)', ho.status === 200, ho.text);
const ans = await post('/api/send', { projectId: 'proj', surfaceId: SURF, choice: 1 });
check('answered from the board: Yes, run command (the arrows and Enter)', ans.status === 200 && ans.body.sent === 'Yes, run command', ans.text);
const handed = await until(async () => {
  const p = await proj();
  const s = p && p.sessions.find((x) => x.surfaceId === SURF);
  // Its edits and commands ask: each answered from the board.
  if (s && s.dialog && p.quick && p.quick.length >= 2) await post('/api/send', { projectId: 'proj', surfaceId: SURF, choice: 1 });
  const m = path.join(MC, 'handoffs', `${SID}.json`);
  const mk = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : null;
  return mk && ['written', 'resumed'].includes(mk.state) ? mk : null;
}, 300000, 1500);
const TR = path.join(AGHOME, 'brain', SID || 'x', '.system_generated', 'logs', 'transcript_full.jsonl');
const trText = fs.existsSync(TR) ? fs.readFileSync(TR, 'utf8') : '';
check('the turn\'s Stop was answered "continue": agy carried on with the hand-off\'s words', /Stop hook blocked termination: [\s\S]*Hand-off/.test(trText), trText.slice(-800));
check('the hand-off is written in the brief', !!handed && /## Hand-off\n\n- \d{4}-\d{2}-\d{2}/.test(fs.readFileSync(path.join(PROJ, 'BRIEF.md'), 'utf8')), JSON.stringify(handed) + ' ' + fs.readFileSync(path.join(PROJ, 'BRIEF.md'), 'utf8').slice(0, 600));
const done = await until(async () => { const s = await sess(); return s && !s.dialog && s.state !== 'working' && s.ctx && s.ctx.tokens > 0 ? s : null; }, 120000, 500);
check('the session at rest after it', !!done && !done.working, JSON.stringify(done || (await sess())));
check('its model chip: the model it ran, by its label', !!done && done.model === MODEL && done.modelName === LABEL, JSON.stringify(done && { model: done.model, name: done.modelName, short: done.modelShort }));
check('its context: tokens in use, of the window from Settings', !!done && done.ctx.tokens > 1000 && done.ctx.window === 1000000 && done.ctx.pct > 0, JSON.stringify(done && done.ctx));
const tr = ag.readTranscript(TR);
check('its last turns: the answer, then the hand-off\'s line, in its transcript', !!tr && tr.turns.some((x) => /^3\b/.test(x.text)) && !!tr.lastText && tr.lastTool && tr.lastTool.name, JSON.stringify(tr && { lastText: tr.lastText, turns: tr.turns.map((x) => x.text.slice(0, 60)), lastTool: tr.lastTool }));

// The skill, as agy lists it (a slash command: no model call).
{
  pane(['send', PANE, '--typed', '/skills']);
  await sleep(400);
  pane(['send', PANE, '--key', 'Enter']);
  const seen = await until(async () => (/ravenry: Ask the person through Ravenry/.test(capture(PANE)) ? true : null), 10000, 300);
  check('agy lists the ravenry skill (Global skills)', !!seen, capture(PANE).slice(-1500));
  pane(['send', PANE, '--key', 'Escape']);
  await sleep(600);
}

const fresh = await until(async () => {
  const p = await proj();
  return p && p.sessions.find((x) => x.surfaceId !== SURF && x.assistant === 'antigravity' && x.sessionId && x.sessionId !== SID);
}, 120000, 1000);
check('the fresh session is Antigravity CLI, in a new pane, reading the hand-off', !!fresh, JSON.stringify((await proj()).sessions.map((s) => ({ s: s.surfaceId, id: s.sessionId, a: s.assistant, st: s.state }))));
// Closed at once: its reading of the brief is not needed here.
if (fresh) pane(['close', fresh.surfaceId.replace(/^ravenry:/, '')]);

// Continue: the first session by its id, in a new pane; a message from the board.
pane(['close', PANE]);
await until(async () => { const s = await sess(); return !s || s.state === 'none'; }, 30000, 500);
const rs = await post('/api/sessions/resume', { projectId: 'proj', sessionId: SID, cols: 120, rows: 40 });
check('Continue: agy --conversation <its id>, in a new pane', rs.status === 200 && rs.body.command && rs.body.command.includes(`--conversation ${SID}`) && rs.body.surfaceId !== SURF, rs.text);
const RS = rs.body && rs.body.surfaceId;
const RP = RS ? RS.replace(/^ravenry:/, '') : null;
const opened = await until(async () => (ag.parseScreen(capture(RP)).claudeLive && capture(RP, 400).includes('wc -l notes.txt') ? true : null), 30000, 500);
check('the new pane shows the conversation it continues', !!opened, capture(RP).slice(-1200));
const say = await post('/api/send', { projectId: 'proj', surfaceId: RS, text: 'Reply with exactly: RESUMED-OK' });
check('a message typed from the board', say.status === 200, say.text);
const back = await until(async () => { const p = await proj(); const s = p && p.sessions.find((x) => x.sessionId === SID && x.surfaceId === RS); return s && s.state !== 'working' && /RESUMED-OK/.test((ag.readTranscript(TR) || {}).lastText || '') ? s : null; }, 90000, 500);
check('the resumed session is the same conversation, in its new pane, and answered', !!back, JSON.stringify((await proj()).sessions.map((s) => ({ s: s.surfaceId, id: s.sessionId, st: s.state }))));
pane(['close', RP]);

// Remove: the hooks file as it was.
const un = await post('/api/setup/hooks', { remove: true, only: 'antigravity' });
check('removing puts the hooks file back as it was', un.status === 200 && fs.readFileSync(HOOKS, 'utf8') === OTHER, fs.readFileSync(HOOKS, 'utf8'));
check('nothing opened a browser', !fs.existsSync(OPENED), fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8') : '');

if (browser) await browser.close();
if (fails) console.log(`\nkept for a look: ${T}\n--- board log (end) ---\n${boardLog.slice(-3000)}`);
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
