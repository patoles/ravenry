#!/usr/bin/env node
// The model a session runs, and the one a new session starts with
// (server/models.mjs).
//
// 1. Names from ids: Claude's family and version ("claude-opus-5-5" ->
//    "Opus 5.5", a dated id, the older order, "[1m]" -> "(1M)", an alias),
//    Codex's ids as Codex prints them; the short name for a narrow row.
// 2. A real transcript's shape (Claude Code's records around a /model
//    switch: the local-command lines, then replies on the new model): the
//    model read from it changes with the first reply after the switch, and
//    the board's sidebar row and session say it (a demo board on
//    127.0.0.1, its garden-planner session's transcript grown by the
//    switch). A Codex rollout's turn_context model follows the same way.
// 3. New session's Model: `--model` for Claude Code, `-m` for Codex (one it
//    had replaced); the menus from the ids seen (the default first, the
//    aliases named by the newest version seen, other families by id).
// 4. A test board with a real ravenryd (RAVENRYD_BIN) and stand-ins for
//    claude and codex that only write the command line they were started
//    with: POST /api/sessions/start with a model starts the session with it
//    (the stand-in's own argv, read back), remembers it for the project and
//    that assistant, a start that leaves model out uses the remembered one,
//    '' goes back to the default; POST /api/project/model sets it, and
//    GET /api/setup/start and the state carry the menus and the picks.
//    Never a real claude or codex.
// Usage: RAVENRYD_BIN=<ravenryd> node tools/models-test.mjs
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelName, modelShort, modelView, withModel, startMenus } from '../server/models.mjs';
import { readTranscript } from '../server/transcript.mjs';
import { parseRollout } from '../server/codexrollout.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (ok) passed++; else failed++; };
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

// ------------------------------------------------------------ 1. names
same('names: Claude ids', ['claude-opus-5-5', 'claude-fable-5-2', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-opus-5-5[1m]', 'opus'].map(modelName),
  ['Opus 5.5', 'Fable 5.2', 'Haiku 4.5', 'Sonnet 4.6', 'Fable 5', 'Opus 4', 'Sonnet 3.5', 'Opus 5.5 (1M)', 'Opus']);
same('names: Codex ids as Codex prints them', ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.6-luna'].map(modelName), ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.6-luna']);
same('names: none for no model and for Claude Code\'s <synthetic>', [modelName(null), modelName(''), modelName('<synthetic>')], [null, null, null]);
same('short: the family, else the assistant', [modelShort('claude-opus-5-5', 'claude'), modelShort('claude-fable-5-2', 'claude'), modelShort('gpt-5.3-codex', 'codex')], ['Opus', 'Fable', 'Codex']);
same('the session\'s view: id, name, short, title', modelView('claude-opus-5-5', 'claude'), { model: 'claude-opus-5-5', modelName: 'Opus 5.5', modelShort: 'Opus', modelTitle: 'Claude Opus 5.5' });
same('the session\'s view of a Codex model', modelView('gpt-5.4', 'codex').modelTitle, 'Codex gpt-5.4');

// ------------------------------------------------------------ 2. /model in a transcript
// Claude Code's records around a /model switch, as it writes them (the
// shapes of a real transcript, words of our own).
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'models-'));
const at = (m) => new Date(Date.now() - m * 60000).toISOString();
const rec = (type, extra, m) => JSON.stringify({ type, cwd: '/tmp/boat', sessionId: 'c3c3c3c3-0000-4000-8000-000000000003', timestamp: at(m), ...extra });
const reply = (model, text, m) => rec('assistant', { message: { model, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5, cache_read_input_tokens: 40000, output_tokens: 90 } } }, m);
const user = (content, m) => rec('user', { message: { role: 'user', content } }, m);
const SWITCH = [
  rec('system', { subtype: 'local_command', content: '<command-name>/model</command-name>' }, 6),
  user('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>', 6),
  user('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-sonnet-4-6</command-args>', 6),
  user('<local-command-stdout>Set model to `Sonnet 4.6` and saved as your default for new sessions</local-command-stdout>', 6),
];
{
  const f = path.join(T, 'switch.jsonl');
  fs.writeFileSync(f, [user('Make the boat rock with the waves', 10), reply('claude-opus-5-5', 'The hull now follows the wave height.', 9), rec('system', { subtype: 'turn_duration' }, 9)].join('\n') + '\n');
  const before = readTranscript(f);
  same('transcript: the model before the switch', modelView(before.model, 'claude').modelName, 'Opus 5.5');
  fs.appendFileSync(f, SWITCH.join('\n') + '\n');
  // Grow it by a few bytes so the reader sees a change (the same second).
  const mid = readTranscript(f);
  same('transcript: the /model lines alone change nothing until a reply', modelView(mid.model, 'claude').modelName, 'Opus 5.5');
  fs.appendFileSync(f, [user('Now tilt it', 5), reply('claude-sonnet-4-6', 'Tilted.', 4)].join('\n') + '\n');
  const after = readTranscript(f);
  same('transcript: the first reply after the switch names the new model', modelView(after.model, 'claude').modelName, 'Sonnet 4.6');
}
{
  // Codex: each turn's turn_context names its model (a /model switch there too).
  const line = (type, payload, m) => JSON.stringify({ timestamp: at(m), type, payload });
  const roll = [line('session_meta', { id: 'r1', cwd: '/tmp/boat' }, 9), line('turn_context', { cwd: '/tmp/boat', model: 'gpt-5.4' }, 9), line('turn_context', { cwd: '/tmp/boat', model: 'gpt-5.3-codex' }, 4)].join('\n');
  const r = parseRollout(roll);
  same('rollout: the latest turn\'s model', modelView(r.model, 'codex'), { model: 'gpt-5.3-codex', modelName: 'gpt-5.3-codex', modelShort: 'Codex', modelTitle: 'Codex gpt-5.3-codex' });
}
{
  // The board: the demo board's garden-planner (claude-opus-5-5), its
  // transcript grown by the switch and a reply on Sonnet.
  const { startDemoHub, freePort } = await import('../../apps/desktop/tools/demo-hub.mjs');
  const hub = await startDemoHub({ dir: path.join(T, 'demo'), port: await freePort() });
  try {
    const row = (st) => st.sidebar.sections.flatMap((s) => s.projects).filter((p) => p.id === 'garden-planner').flatMap((p) => p.rows)[0] || null;
    const st0 = await hub.state();
    const r0 = row(st0);
    const s0 = st0.projects.find((p) => p.id === 'garden-planner').sessions[0];
    same('board: the row says the model (wide and short) and the assistant', r0 && [r0.model, r0.modelShort, r0.assistant], ['Opus 5.5', 'Opus', 'Claude']);
    same('board: the session carries its model\'s id, name and title', [s0.model, s0.modelName, s0.modelTitle], ['claude-opus-5-5', 'Opus 5.5', 'Claude Opus 5.5']);
    const TR = path.join(hub.home, '.claude', 'projects', path.join(hub.root, 'garden-planner').replace(/[^A-Za-z0-9]/g, '-'), 'a1a1a1a1-0000-4000-8000-000000000001.jsonl');
    check('board: the fixture transcript is there', fs.existsSync(TR), TR);
    fs.appendFileSync(TR, SWITCH.join('\n') + '\n' + [user('Use the frost date', 1), reply('claude-sonnet-4-6', 'The first reminder goes out on the first frost-free day.', 0)].join('\n') + '\n');
    const st1 = await until(async () => { const s = await hub.state(); const r = row(s); return r && r.model === 'Sonnet 4.6' ? s : null; }, 15000);
    const r1 = st1 ? row(st1) : null;
    same('board: after /model and a reply, the row says the new model', r1 && [r1.model, r1.modelShort], ['Sonnet 4.6', 'Sonnet']);
    same('board: and the session\'s title', st1 && st1.projects.find((p) => p.id === 'garden-planner').sessions[0].modelTitle, 'Claude Sonnet 4.6');
  } finally { hub.stop(); }
}

// ------------------------------------------------------------ 3. the launch command and the menus
same('launch: Claude Code with --model', withModel('claude', 'claude', 'opus'), 'claude --model opus');
same('launch: Codex with -m, the one it had replaced', withModel('codex -m gpt-5.6-luna', 'codex', 'gpt-5.4'), 'codex -m gpt-5.4');
same('launch: a [1m] id is quoted for the shell', withModel('claude', 'claude', 'claude-opus-5-5[1m]'), "claude --model 'claude-opus-5-5[1m]'");
same('launch: no model, the command as it was', withModel('claude --verbose', 'claude', null), 'claude --verbose');
same('launch: a model that is not a model name is never put on the line', withModel('claude', 'claude', 'opus; rm -rf ~'), 'claude');
{
  const m = startMenus({ seen: ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-5.3-codex', 'gpt-5.6-luna', '<synthetic>'], codexDefault: 'gpt-5.4' });
  same('menu: Claude Code\'s default, the aliases by the newest seen, other families by id', m.claude, [
    { id: '', label: "Claude Code's default" }, { id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku 4.5' }, { id: 'claude-fable-5-2', label: 'Fable 5.2' }]);
  same('menu: Codex\'s default (config.toml\'s), then the ids seen', m.codex, [
    { id: '', label: "Codex's default (gpt-5.4)" }, { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }, { id: 'gpt-5.4', label: 'gpt-5.4' }, { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex' }]);
}

// ------------------------------------------------------------ 4. starting with one, on a test board
const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  starting with a model: set RAVENRYD_BIN to a ravenryd binary');
} else {
  const MC = path.join(T, 'mc'), HOME = path.join(T, 'home'), PROJ = path.join(T, 'boat'), STUB = path.join(T, 'stub-bin'), ARGV = path.join(T, 'argv.log');
  for (const d of [MC, HOME, PROJ, STUB, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
  // Stand-ins: they write how they were started, then wait (never a real claude or codex).
  for (const n of ['claude', 'codex']) fs.writeFileSync(path.join(STUB, n), `#!/bin/sh\nprintf '%s' "${n}" >> '${ARGV}'\nfor a in "$@"; do printf ' [%s]' "$a" >> '${ARGV}'; done\necho >> '${ARGV}'\nexec sleep 60\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Boat\n\nGoal: A boat.\n');
  fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'boat', name: 'Boat', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
  const SETTINGS = path.join(T, 'claude-settings.json');
  fs.writeFileSync(SETTINGS, '{}');
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-'));
  const RUN = path.join(D, 'run');
  const DENV = { HOME, PATH: `${STUB}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
  const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
  const PORT = 4793;
  let log = '';
  const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
    env: withStubMachine({ ...DENV, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_HUB_BIND: '127.0.0.1', RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN, MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CODEX: '1', MC_CODEX_HOME: path.join(HOME, '.codex'), TEST_RAVENRY: '1', MC_TEST: '1', MC_NO_AUTOSTART: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  board.stdout.on('data', (d) => { log += d; });
  board.stderr.on('data', (d) => { log += d; });
  process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${PORT}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const ready = await until(async () => { const s = await get('/api/state'); return s.generatedAt ? s : null; }, 20000);
  check('board: answers', !!ready, ready ? '' : log.slice(-600));
  const lines = () => (fs.existsSync(ARGV) ? fs.readFileSync(ARGV, 'utf8').trim().split('\n').filter(Boolean) : []);
  const started = async (n) => until(async () => (lines().length >= n ? lines()[n - 1] : null), 15000);
  const reg = () => JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8')).projects.find((p) => p.id === 'boat');

  const a = await post('/api/sessions/start', { projectId: 'boat', assistant: 'claude', model: 'opus' });
  check('start with Opus: 200, the command has --model opus', a.status === 200 && /^claude --model opus /.test(a.body.command), JSON.stringify(a.body).slice(0, 300));
  same('start with Opus: the pane ran claude with --model opus (its own argv)', (await started(1) || '').split(' ').slice(0, 3).join(' '), 'claude [--model] [opus]');
  same('start with Opus: remembered for the project and Claude Code', reg().models, { claude: 'opus' });
  const b = await post('/api/sessions/start', { projectId: 'boat', assistant: 'claude' });
  same('start again, no model sent: the remembered one', (await started(2) || '').split(' ').slice(0, 3).join(' '), 'claude [--model] [opus]');
  check('start again: 200', b.status === 200, JSON.stringify(b.body).slice(0, 200));
  const c = await post('/api/sessions/start', { folder: PROJ, assistant: 'codex', model: 'gpt-5.3-codex' });
  same('Codex by its folder (no projectId, as the Mac\'s New session sends it): -m, its own argv', (await started(3) || '').split(' ').slice(0, 3).join(' '), 'codex [-m] [gpt-5.3-codex]');
  check('Codex: 200', c.status === 200, JSON.stringify(c.body).slice(0, 200));
  same('Codex: remembered beside Claude\'s', reg().models, { claude: 'opus', codex: 'gpt-5.3-codex' });
  await post('/api/sessions/start', { projectId: 'boat', assistant: 'claude', model: '' });
  const l4 = await started(4) || '';
  same('Claude Code\'s default (\'\'): no --model, and forgotten', [l4.startsWith('claude ') && !l4.includes('[--model]'), reg().models], [true, { codex: 'gpt-5.3-codex' }]);
  const bad = await post('/api/sessions/start', { projectId: 'boat', assistant: 'claude', model: 'opus; touch x' });
  check('a model that is not a model name: 400, nothing started', bad.status === 400 && lines().length === 4, JSON.stringify(bad.body));
  const pm = await post('/api/project/model', { projectId: 'boat', assistant: 'claude', model: 'claude-fable-5-2' });
  check('POST /api/project/model: 200 and saved', pm.status === 200 && pm.body.model === 'claude-fable-5-2' && reg().models.claude === 'claude-fable-5-2', JSON.stringify(pm.body));
  const ss = await until(async () => { const s = await get('/api/state'); const p = s.projects.find((x) => x.id === 'boat'); return p && p.models && p.models.claude === 'claude-fable-5-2' ? s : null; });
  check('state: the project\'s picks and the menus', !!ss && ss.startModels && ss.startModels.claude[0].id === '' && ss.startModels.claude.some((o) => o.id === 'claude-fable-5-2' && o.label === 'Fable 5.2') && ss.startModels.codex[0].id === '', JSON.stringify(ss && { m: ss.startModels, p: ss.projects.find((x) => x.id === 'boat').models }));
  const su = await get('/api/setup/start?folder=' + encodeURIComponent(PROJ));
  const sf = (su.folders || []).find((f) => f.path === PROJ);
  check('GET /api/setup/start: the menus, and the folder\'s picks', !!su.models && Array.isArray(su.models.claude) && !!sf && sf.models && sf.models.claude === 'claude-fable-5-2' && sf.models.codex === 'gpt-5.3-codex', JSON.stringify({ models: su.models, f: sf }).slice(0, 400));
  const bm = await post('/api/project/model', { projectId: 'boat', assistant: 'claude', model: '$(touch x)' });
  check('POST /api/project/model: a bad name is refused', bm.status === 400, JSON.stringify(bm.body));
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* left for a look */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
