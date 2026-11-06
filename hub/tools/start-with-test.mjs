#!/usr/bin/env node
// Which assistant the board starts, and Plans and Ideas on Codex
// (docs/ASSISTANTS.md, "Starting sessions" and "Print mode"):
//
// - the launch command per assistant, and the words reaching the shell as
//   one exact word for both (an apostrophe, $, backticks, !, a leading dash
//   after --), checked through /bin/sh;
// - startWith and its fallback when the chosen assistant is not installed,
//   the New project form's choice over it, and a project's new sessions
//   starting its own assistant, else startWith, else Claude Code, never its
//   newest session's;
// - the assistant settings' check and write path;
// - codex exec's argv (no tools, no hooks, read-only, the schema, the
//   pictures), its JSONL read into text and tokens, a refused model run
//   again on the fallback and remembered, a feature this Codex lacks
//   dropped, all against tools/stub-codex.mjs;
// - then a test board on :4695 with the fake cmux and the stub as Codex:
//   GET/POST /api/settings/assistant (the write guard), Revive, New session
//   and New project typing `codex` or `claude` as chosen, and a plan draft,
//   an Ideas reply, Get 3 directions and a mockup round going to `codex
//   exec` with startWith codex, and to `claude -p` (stubs) with claude.
// - then a test board on :4694 with no startWith (the maintainer, 2026-11-04:
//   "Initiating the Ravenry project from brief started a codex session"): a
//   project whose newest session is a throwaway Codex one Revives on Claude
//   Code and its "New sessions:" switch shows Claude; with startWith codex
//   both say Codex; a project set to Codex starts Codex; and a hand-off from
//   that Codex session still continues on Codex.
//
// --real: measures that the real `codex` takes a leading-dash prompt only
// after `--` (no terminal, so it stops after parsing: no model call), then
// runs one plan draft through the real `codex exec` with a tiny prompt, in
// a scratch CODEX_HOME (.tmp/start-with/codex-home, auth.json copied in and
// deleted after) whose config.toml names the model the real one names, so a
// refused model is run again on the fallback as on this Mac.
//
// The page (docs/design/CodexStage2.dc.html, section 3, variant A) on a
// test board on :4696: the Settings card's Assistant section first, its
// Claude / Codex switch saving startWith, New project's Assistant row under
// Folder defaulting from Settings, and the New session switch's line in a
// Codex project; and the sheet's "New sessions:" switch
// (docs/design/ProjectAssistant.dc.html, round 2, A1): its state, a flip
// saving the project's assistant with the running session's tag unchanged,
// a failed save snapping back, its words on the meta line's baseline and
// the switch centred on it within 1px at 1440, 412 and 390, and the line's
// height unchanged at 1440. --shots <dir> saves each at 1440x900 and
// 390x844 (the meta line also at 412), dark and light.
//
// Usage: node tools/start-with-test.mjs [--real] [--shots <dir>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'start-with');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'mc-unit');
const REAL = process.argv.includes('--real');
const SHOTS = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const STUB = path.join(ROOT, 'tools', 'stub-codex.mjs');
fs.chmodSync(STUB, 0o755);

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];

// A scratch CODEX_HOME for the unit part: the stub reads nothing from it,
// codexexec reads its config.toml.
const CXH = path.join(T, 'codex-home');
fs.mkdirSync(CXH, { recursive: true });
fs.writeFileSync(path.join(CXH, 'config.toml'), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n\n[projects."/x"]\nmodel = "not-this-one"\n');
process.env.MC_CODEX_HOME = CXH;
const ARGV = path.join(T, 'stub-argv.jsonl');
const runs = () => { try { return fs.readFileSync(ARGV, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const asst = await import('../server/assistant.mjs');
const cx = await import('../server/codexexec.mjs');
const registry = await import('../server/registry.mjs');
const create = await import('../server/create.mjs');

// ------------------------------------------------------------ 1. launch commands and quoting

check('launch: Claude Code starts with the launchCommand setting, `claude` by default, as before', asst.startCommand('claude', {}) === 'claude' && asst.startCommand('claude', { launchCommand: 'echo X' }) === 'echo X');
check('launch: the hand-off keeps handoffCommand for Claude Code', asst.launchCommand('claude', { handoffCommand: 'claude --x' }) === 'claude --x' && asst.launchCommand('claude', {}) === 'claude');
check('launch: Codex starts with `codex`, or codexCommand', asst.startCommand('codex', {}) === 'codex' && asst.startCommand('codex', { codexCommand: 'codex --y' }) === 'codex --y' && asst.launchCommand('codex', {}) === 'codex');

// The typed line (a new tab's shell) is shellWord; the cmux --command line is
// quoteWord. Both must give the shell's argument back exactly.
const WORDS = ["Don't touch $HOME, it's `fine`!", 'Say "hi" and $(echo no) then !!', "plain words", "it's fine", '- one\n- two', '--fix it'];
const sh = (line) => execFileSync('/bin/sh', ['-c', line.replace(/^(claude|codex)( --)? /, 'printf %s ')], { encoding: 'utf8' });
for (const kind of ['claude', 'codex']) {
  const cmd = asst.startCommand(kind, {});
  for (const w of WORDS) {
    const typed = `${cmd} ${w.startsWith('-') ? '-- ' : ''}${create.shellWord(w)}`;
    check(`quoting (${kind}, typed): ${JSON.stringify(w).slice(0, 40)} reaches the shell as one exact word`, sh(typed) === w && (!w.startsWith('-') || typed.startsWith(`${cmd} -- `)), JSON.stringify([typed, sh(typed)]));
  }
  // quoteWord (cmux's --command, no backslashes) keeps a word without both
  // an apostrophe and a shell character exactly, as before.
  for (const w of ["it's fine", 'Read BRIEF.md and start on the first milestone.', 'a $b']) {
    const line = `${cmd} ${create.quoteWord(w)}`;
    check(`quoting (${kind}, cmux command): ${JSON.stringify(w)} reaches the shell exactly`, sh(line) === w, JSON.stringify([line, sh(line)]));
  }
}

// ------------------------------------------------------------ 2. startWith and continuing

const both = { claude: true, codex: true };
let c = asst.startChoice({}, null, { installed: both });
check('startWith: unset is Claude Code', c.kind === 'claude' && c.from === 'default' && !c.fallback && !c.note, JSON.stringify(c));
c = asst.startChoice({ startWith: 'codex' }, null, { installed: both });
check('startWith: codex starts Codex', c.kind === 'codex' && c.from === 'startWith' && !c.fallback, JSON.stringify(c));
c = asst.startChoice({ startWith: 'codex' }, null, { installed: { claude: true, codex: false } });
check('startWith: codex not installed falls back to Claude Code and says so', c.kind === 'claude' && c.wanted === 'codex' && c.fallback && /Codex is not installed/.test(c.note), JSON.stringify(c));
c = asst.startChoice({ startWith: 'claude' }, null, { installed: { claude: false, codex: true } });
check('startWith: Claude Code not installed falls back to Codex and says so', c.kind === 'codex' && c.fallback && /Claude Code is not installed/.test(c.note), JSON.stringify(c));
c = asst.startChoice({ startWith: 'codex' }, null, { installed: { claude: false, codex: false } });
check('startWith: neither installed runs the chosen one\'s command and says so', c.kind === 'codex' && !c.fallback && /Neither/.test(c.note), JSON.stringify(c));
c = asst.startChoice({ startWith: 'bogus' }, null, { installed: both });
check('startWith: an unknown value is Claude Code', c.kind === 'claude', JSON.stringify(c));
c = asst.startChoice({ startWith: 'claude' }, 'codex', { installed: both });
check('New project: the form\'s choice wins over startWith', c.kind === 'codex' && c.from === 'form', JSON.stringify(c));
c = asst.continueChoice({ startWith: 'codex' }, { assistant: 'claude' }, { installed: both });
check('new session: the project\'s own assistant wins over startWith', c.kind === 'claude' && c.from === 'project', JSON.stringify(c));
c = asst.continueChoice({ startWith: 'claude' }, { assistant: 'codex' }, { installed: both });
check('new session: a project set to Codex starts Codex under startWith claude', c.kind === 'codex' && c.from === 'project', JSON.stringify(c));
c = asst.continueChoice({}, {}, { installed: both });
check('new session: a project with no assistant and no startWith is Claude Code', c.kind === 'claude' && c.wanted === 'claude' && c.from === 'default', JSON.stringify(c));
c = asst.continueChoice({ startWith: 'codex' }, {}, { installed: both });
check('new session: a project with no assistant is startWith (Codex)', c.kind === 'codex' && c.from === 'startWith', JSON.stringify(c));
c = asst.continueChoice({}, { assistant: 'codex' }, { installed: { claude: true, codex: false } });
check('continuing: a project\'s Codex not installed falls back and says so', c.kind === 'claude' && c.fallback && /Codex is not installed/.test(c.note), JSON.stringify(c));
check('installed: a test counts Codex only with MC_CODEX or a scratch CODEX_HOME', cx.installed({}, { TEST_RAVENRY: '1', PATH: process.env.PATH }) === false && cx.installed({}, { MC_CODEX: '1' }) === true && cx.installed({}, { MC_CODEX: '0', PATH: process.env.PATH }) === false);
check('installed: cmux\'s shims are not the real binary', cx.isShim('/var/folders/x/T/cmux-cli-shims/ABC/codex') && cx.isShim('/Applications/cmux.app/Contents/Resources/bin/codex') && !cx.isShim('/opt/homebrew/bin/codex'));

// ------------------------------------------------------------ 3. the settings' check

check('settings: startWith claude or codex, codexModel a model name or empty', registry.checkAssistantPatch({ startWith: 'codex' }) === null && registry.checkAssistantPatch({ codexModel: 'gpt-5.6-luna' }) === null && registry.checkAssistantPatch({ codexModel: '' }) === null && registry.checkAssistantPatch({ codexModel: null }) === null);
check('settings: anything else is refused with the reason', /startWith must be/.test(registry.checkAssistantPatch({ startWith: 'gemini' })) && /codexModel must be/.test(registry.checkAssistantPatch({ codexModel: 'x; rm -rf ~' })) && /Not a setting/.test(registry.checkAssistantPatch({ handoffEnabled: false })) && /Nothing/.test(registry.checkAssistantPatch({})));
check('settings: defaults read as Claude Code with no codexModel', JSON.stringify(registry.assistantSettings({})) === JSON.stringify({ startWith: 'claude', codexModel: null }));

// ------------------------------------------------------------ 4. codex exec

check('exec: the configured model is config.toml\'s top-level one', cx.configuredModel() === 'gpt-5.4', String(cx.configuredModel()));
const args = cx.execArgs({ schemaFile: '/s.json', images: ['/a.png', '/b.png'], cwd: '/w', model: 'm1' });
check('exec: argv is exec, the pictures first, JSONL, ephemeral, read-only, hooks and tools off, the schema, the folder, stdin last',
  args[0] === 'exec' && args.slice(1, 5).join(' ') === '-i /a.png -i /b.png' && ['--json', '--ephemeral', '--skip-git-repo-check'].every((a) => args.includes(a)) && args[args.indexOf('--sandbox') + 1] === 'read-only'
  && ['hooks', 'shell_tool', 'unified_exec', 'computer_use', 'browser_use'].every((f) => args.some((a, i) => a === '--disable' && args[i + 1] === f))
  && args[args.indexOf('--output-schema') + 1] === '/s.json' && args[args.indexOf('-m') + 1] === 'm1' && args[args.indexOf('-C') + 1] === '/w' && args[args.length - 1] === '-', JSON.stringify(args));
check('exec: no model, no -m (Codex\'s configured one)', !cx.execArgs({ cwd: '/w' }).includes('-m'));
// The JSONL Codex 0.166.0 printed (2026-11-04), a pong with a schema, and a refusal.
const OK = ['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"word\\":\\"pong\\"}"}}', '{"type":"turn.completed","usage":{"input_tokens":11794,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0}}'].join('\n');
let p = cx.parseExec(OK);
check('exec: the last agent_message is the answer, turn.completed the tokens, no cost', p.ok && p.text === '{"word":"pong"}' && p.usage.in === 11794 && p.usage.out === 15 && p.usage.cost === null, JSON.stringify(p));
const REFUSED = ['{"type":"thread.started","thread_id":"x"}', '{"type":"item.completed","item":{"id":"item_2","type":"error","message":"Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}', '{"type":"turn.started"}', '{"type":"error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}', '{"type":"turn.failed","error":{"message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}'].join('\n');
p = cx.parseExec(REFUSED);
check('exec: a refused model is a refusal, a warning item is not the answer', !p.ok && p.refused && /not supported/.test(p.error) && p.text === undefined, JSON.stringify(p));
p = cx.parseExec('{"type":"thread.started"}\n{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"stream disconnected"}}');
check('exec: another failure is not taken for a refusal', !p.ok && !p.refused, JSON.stringify(p));

const env0 = { ...process.env, MC_CODEX_BIN: STUB, STUB_CODEX_ARGV_FILE: ARGV, STUB_CODEX_REFUSE: 'gpt-5.4' };
let r = await cx.run({ prompt: 'The user now says: hello', cwd: path.join(T, 'work'), env: env0, settings: {} });
let rs = runs();
check('exec: a refused configured model is run again on Codex\'s default (debug models: gpt-6-luna)', r.ok && r.model === 'gpt-6-luna' && rs.length === 2 && !rs[0].argv.includes('-m') && rs[1].argv[rs[1].argv.indexOf('-m') + 1] === 'gpt-6-luna', JSON.stringify({ r, argv: rs.map((x) => x.argv.includes('-m')) }));
check('exec: the run has cmux\'s hooks off and the scratch CODEX_HOME', rs.every((x) => x.env.CMUX_CODEX_HOOKS_DISABLED === '1' && x.env.CODEX_HOME === CXH), JSON.stringify(rs.map((x) => x.env)));
check('exec: the refusal is remembered while config.toml names that model', (() => { const st = cx.modelState(); return st && st.refused && st.configured === 'gpt-5.4' && st.using === 'gpt-6-luna'; })(), JSON.stringify(cx.modelState()));
r = await cx.run({ prompt: 'The user now says: again', cwd: path.join(T, 'work'), env: env0, settings: {} });
rs = runs();
check('exec: the next call starts on the fallback, no refused call first', r.ok && rs.length === 3 && rs[2].argv[rs[2].argv.indexOf('-m') + 1] === 'gpt-6-luna', JSON.stringify(rs.map((x) => x.argv.includes('-m'))));
check('exec: ...and a session the board starts gets -m too (a refused model fails its first turn)', asst.startCommand('codex', {}) === 'codex -m gpt-6-luna' && asst.startCommand('codex', { codexCommand: 'codex' }) === 'codex', asst.startCommand('codex', {}));
r = await cx.run({ prompt: 'The user now says: own model', cwd: path.join(T, 'work'), env: env0, settings: { codexModel: 'gpt-5.6-luna' } });
rs = runs();
check('exec: codexModel in the settings is the model used once the configured one is refused', r.ok && rs[rs.length - 1].argv[rs[rs.length - 1].argv.indexOf('-m') + 1] === 'gpt-5.6-luna' && asst.startCommand('codex', { codexModel: 'gpt-5.6-luna' }) === 'codex -m gpt-5.6-luna');
fs.writeFileSync(path.join(CXH, 'config.toml'), 'model = "gpt-5.6-terra"\n');
check('exec: a config.toml naming another model forgets the refusal', cx.modelState() === null && asst.startCommand('codex', {}) === 'codex');
fs.writeFileSync(path.join(CXH, 'config.toml'), 'model = "gpt-5.4"\n');
fs.rmSync(path.join(process.env.RAVENRY_HOME, 'codex-model.json'), { force: true });
r = await cx.run({ prompt: 'The user now says: drop', cwd: path.join(T, 'work'), env: { ...env0, STUB_CODEX_REFUSE: '', STUB_CODEX_UNKNOWN: 'goals' } });
rs = runs();
check('exec: a feature this Codex does not know is dropped and the call run again', r.ok && rs[rs.length - 1].argv.join(' ').includes('--disable shell_tool') && !rs[rs.length - 1].argv.join(' ').includes('--disable goals'), JSON.stringify(r));

// ------------------------------------------------------------ 5. a test board

const boardEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|PORT$|STUB_)/.test(k)));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|TMUX|RAVENRY_|MC_|PORT$|STUB_)/.test(k)));
async function startBoard({ port, mc, env }) {
  const e = {
    ...boardEnv, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
    MC_CLAUDE_PROJECTS: path.join(T, 'claude-' + port), MC_PROJECTS_ROOT: path.join(T, 'projects'),
    MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), ...env,
  };
  fs.mkdirSync(e.MC_CLAUDE_PROJECTS, { recursive: true });
  const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(board);
  const b = { board, base: `http://localhost:${port}`, log: '' };
  board.stdout.on('data', (d) => { b.log += d; });
  board.stderr.on('data', (d) => { b.log += d; });
  b.get = async (u) => (await fetch(b.base + u)).json();
  b.state = () => b.get('/api/state');
  b.post = async (u, body, headers = { 'X-Ravenry': '1' }) => { const x = await fetch(b.base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: x.status, j: await x.json().catch(() => null) }; };
  for (let i = 0; i < 60; i++) { try { const s = await b.state(); if (s.generatedAt) break; } catch { /* starting */ } await sleep(250); }
  return b;
}

fs.writeFileSync(path.join(T, 'CLAUDE.md'), '# Rules\n\n## Pictures first\n- Show a picture before building anything visual.\n');
const BRIEF = (n) => `# ${n}\n\nGoal: A paper boat that floats.\n\n## Plan\n\n## Next step\nTilt the hull.\n\n## Hand-off\n`;
const P = (n) => path.join(T, 'projects', n);
for (const n of ['boat', 'kite', 'mill', 'fresh']) fs.mkdirSync(P(n), { recursive: true });
for (const n of ['boat', 'kite', 'mill']) fs.writeFileSync(path.join(P(n), 'BRIEF.md'), BRIEF(n));
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: {
    autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'projects'), repeatsAuto: false,
    launchCommand: 'claude', startWith: 'codex', claudeTimeoutMs: 8000, planTimeoutMs: 8000,
    printCommand: [process.execPath, path.join(ROOT, 'tools/stub-claude.mjs')],
    mockupCommand: [process.execPath, path.join(ROOT, 'tools/stub-mockup-claude.mjs')],
  },
  projects: [
    { id: 'boat', name: 'Boat', folder: P('boat'), workspaces: ['ws-boat'], brief: 'BRIEF.md' },
    { id: 'kite', name: 'Kite', folder: P('kite'), workspaces: ['ws-kite'], brief: 'BRIEF.md', assistant: 'claude' },
    { id: 'mill', name: 'Mill', folder: P('mill'), workspaces: ['ws-mill'], brief: 'BRIEF.md' },
  ],
}, null, 2));
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({
  newSurfaces: true,
  workspaces: ['boat', 'kite', 'mill'].map((n, i) => ({ id: 'ws-' + n, ref: `workspace:${i + 1}`, title: n, cwd: P(n), surfaces: [] })),
  screens: {}, prompts: {},
}));
const fst = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
const sentIn = (id) => ((fst().prompts || {})[id] || {}).sent || [];
const newWorkspaces = () => { try { return fs.readFileSync(FAKE + '.new-workspace.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv); } catch { return []; } };
const optOf = (argv, k) => argv[argv.indexOf(k) + 1];

const BCXH = path.join(T, 'codex-home-board');
fs.mkdirSync(BCXH, { recursive: true });
fs.writeFileSync(path.join(BCXH, 'config.toml'), 'model = "gpt-5.6-luna"\n');
const BARGV = path.join(T, 'board-codex-argv.jsonl');
const bruns = () => { try { return fs.readFileSync(BARGV, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const PLAN_ARGV = path.join(T, 'board-claude-plan-argv.txt');
const b = await startBoard({ port: 4695, mc: MC, env: {
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE,
  MC_CODEX: '1', MC_CLAUDE: '1', MC_CODEX_HOME: BCXH, MC_CODEX_BIN: STUB, STUB_CODEX_ARGV_FILE: BARGV,
  MC_PLAN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-plan-claude.mjs')]), STUB_PLAN_ARGV_FILE: PLAN_ARGV,
} });
try {
  // ---- the settings
  let g = await b.get('/api/settings/assistant');
  check('board: GET /api/settings/assistant says startWith codex, Codex starts, both installed, the model config.toml names', g.ok && g.startWith === 'codex' && g.starts === 'codex' && g.installed.claude && g.installed.codex && !g.fallback && g.codex && g.codex.configured === 'gpt-5.6-luna' && !g.codex.refused, JSON.stringify(g));
  const st = await b.state();
  check('board: /api/state carries the same', st.assistants && st.assistants.startWith === 'codex' && st.assistants.starts === 'codex', JSON.stringify(st.assistants));
  let w = await b.post('/api/settings/assistant', { startWith: 'claude' }, {});
  check('board: a write without the board\'s header is refused', w.status === 403, `${w.status}`);
  w = await b.post('/api/settings/assistant', { startWith: 'gemini' });
  check('board: a bad value is refused with the reason', w.status === 400 && /startWith must be/.test(w.j.error), JSON.stringify(w));
  w = await b.post('/api/settings/assistant', { startWith: 'claude', codexModel: 'gpt-5.6-luna' });
  const saved = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8')).settings;
  check('board: a good write saves only those keys, through the registry', w.status === 200 && w.j.startWith === 'claude' && w.j.codexModel === 'gpt-5.6-luna' && saved.startWith === 'claude' && saved.codexModel === 'gpt-5.6-luna' && saved.launchCommand === 'claude', JSON.stringify(w.j));
  w = await b.post('/api/settings/assistant', { startWith: 'codex', codexModel: '' });
  const saved2 = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8')).settings;
  check('board: an empty codexModel clears it', w.status === 200 && w.j.codexModel === null && !('codexModel' in saved2) && saved2.startWith === 'codex', JSON.stringify(saved2));

  // ---- launching
  let r = await b.post('/api/project/revive', { projectId: 'boat' });
  check('Revive: a project with no assistant and no session starts startWith, Codex', r.status === 200 && r.j.assistant === 'codex' && sentIn(r.j.surfaceId)[0] === "codex 'Read BRIEF.md (Hand-off section first) and continue.'", `${r.status} ${JSON.stringify(r.j)} ${JSON.stringify(sentIn(r.j && r.j.surfaceId))}`);
  r = await b.post('/api/project/revive', { projectId: 'kite' });
  check('Revive: a project that names Claude Code keeps it under startWith codex', r.status === 200 && r.j.assistant === 'claude' && sentIn(r.j.surfaceId)[0] === "claude 'Read BRIEF.md (Hand-off section first) and continue.'", JSON.stringify(sentIn(r.j && r.j.surfaceId)));
  const tricky = "Don't touch $HOME, it's `fine`!";
  r = await b.post('/api/project/revive', { projectId: 'boat', text: tricky });
  const line = sentIn(r.j.surfaceId)[0] || '';
  check('New session: the words go to codex as one exact word', r.status === 200 && line === `codex 'Don'\\''t touch $HOME, it'\\''s \`fine\`!'`, line);
  check('New session: ...and /bin/sh gives them back unchanged', sh(line) === tricky, sh(line));
  r = await b.post('/api/project/revive', { projectId: 'boat', text: '- one\n- two' });
  check('New session: words that start with a dash come after -- for codex too', sentIn(r.j.surfaceId)[0] === "codex -- '- one\n- two'", JSON.stringify(sentIn(r.j.surfaceId)));
  // Mill's newest session is a Claude Code one (its hook events): a new
  // session still starts startWith (Codex), not its newest session's.
  const hook = (input, assistant) => new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs'), ...(assistant === 'codex' ? ['--assistant=codex'] : [])], { env: { ...cleanEnv, RAVENRY_HOME: MC, MC_BOARD_URL: b.base } });
    ch.on('close', resolve);
    ch.stdin.end(JSON.stringify(input));
  });
  await hook({ hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-000000000001', cwd: P('mill'), source: 'startup' }, 'claude');
  await hook({ hook_event_name: 'SessionEnd', session_id: '11111111-2222-4333-8444-000000000001', cwd: P('mill'), reason: 'exit' }, 'claude');
  await sleep(2500);
  r = await b.post('/api/project/revive', { projectId: 'mill' });
  check('Revive: a project whose newest session is Claude Code starts startWith (Codex), not the session\'s', r.status === 200 && r.j.assistant === 'codex' && /^codex 'Read BRIEF/.test(sentIn(r.j.surfaceId)[0] || ''), `${JSON.stringify(r.j)} ${JSON.stringify(sentIn(r.j && r.j.surfaceId))}`);
  await hook({ hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-000000000002', cwd: P('mill'), source: 'startup', model: 'gpt-5.6-luna' }, 'codex');
  await sleep(2500);
  r = await b.post('/api/project/revive', { projectId: 'mill' });
  check('Revive: ...and with a newer Codex session it is still startWith (Codex)', r.status === 200 && r.j.assistant === 'codex' && /^codex 'Read BRIEF/.test(sentIn(r.j.surfaceId)[0] || ''), `${JSON.stringify(r.j)} ${JSON.stringify(sentIn(r.j && r.j.surfaceId))}`);
  // New project: cmux's new-workspace is recorded, then refused (fake cmux).
  r = await b.post('/api/project/new', { name: 'Pond', goal: 'A pond for the boat.' });
  let nw = newWorkspaces().pop() || [];
  check('New project: startWith codex runs `codex \'Read BRIEF.md ...\'` in the new workspace', r.j && r.j.assistant === 'codex' && optOf(nw, '--command') === "codex 'Read BRIEF.md and start on the first milestone.'", `${r.status} ${JSON.stringify(r.j)} ${JSON.stringify(nw)}`);
  r = await b.post('/api/project/new', { name: 'Pier', goal: 'A pier.', assistant: 'claude' });
  nw = newWorkspaces().pop() || [];
  const pier = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8')).projects.find((x) => x.id === 'pier');
  check('New project: the form\'s Claude Code wins over startWith and is kept on the project', r.j && r.j.assistant === 'claude' && optOf(nw, '--command') === "claude 'Read BRIEF.md and start on the first milestone.'" && pier && pier.assistant === 'claude', `${JSON.stringify(r.j)} ${JSON.stringify(nw)} ${JSON.stringify(pier)}`);
  r = await b.post('/api/project/new', { name: 'Dock', goal: 'A dock.', assistant: 'gemini' });
  check('New project: an unknown assistant is refused, nothing written', r.status === 400 && /claude or codex/.test(r.j.error) && !fs.existsSync(P('dock')), JSON.stringify(r));

  // ---- Plans and Ideas on Codex
  const n0 = bruns().length;
  r = await b.post('/api/plan/draft', { projectId: 'boat', goal: 'Make the boat float longer' });
  let d = null;
  for (let i = 0; i < 40; i++) { await sleep(250); d = (await b.get('/api/plan/draft?projectId=boat')).draft; if (d && !d.busy) break; }
  const pr = bruns().slice(n0).find((x) => x.argv.includes('--output-schema'));
  check('Plans: a draft with startWith codex runs codex exec with the plan schema, read-only, no tools, in the plans folder', !!pr && pr.argv[0] === 'exec' && pr.argv[pr.argv.indexOf('--sandbox') + 1] === 'read-only' && pr.argv.some((a, i) => a === '--disable' && pr.argv[i + 1] === 'shell_tool') && pr.argv[pr.argv.indexOf('-C') + 1] === path.join(MC, 'plans') && pr.env.MC_PLAN_JOB === 'boat', JSON.stringify(pr && pr.argv));
  check('Plans: ...with the system words first and the user\'s rule in the prompt', !!pr && pr.prompt.startsWith('You turn what the user wants done') && /R1 \(Every project, Pictures first\): Show a picture before building anything visual/.test(pr.prompt), pr ? pr.prompt.slice(0, 120) : '');
  check('Plans: the answer is the draft, its rule gate marked', d && !d.error && d.steps.length === 4 && d.steps[1].kind === 'gate' && d.steps[1].ruleId === 'R1', JSON.stringify(d && { error: d.error, steps: d.steps.map((s) => s.kind + ':' + s.ruleId) }));
  check('Plans: the board logs tokens and no cost for a Codex call', /plans: draft for boat in [\d.]+ s, 1234 tokens in, 56 out(?!, \$)/.test(b.log), (b.log.match(/plans: .*/g) || []).join(' | '));
  check('Plans: claude -p was not run', !fs.existsSync(PLAN_ARGV));
  r = await b.post('/api/plan/revise', { projectId: 'boat', message: 'Also paint it red' });
  for (let i = 0; i < 40; i++) { await sleep(250); d = (await b.get('/api/plan/draft?projectId=boat')).draft; if (d && !d.busy) break; }
  check('Plans: a revision goes to Codex too and marks the added step', d && !d.error && d.steps.length === 5 && Object.values(d.marks).includes('add'), JSON.stringify(d && { error: d.error, marks: d.marks }));
  await b.post('/api/plan/discard', { projectId: 'boat' });
  // Files with a plan: Codex gets the picture with -i and the text file's
  // words in the prompt, in the empty folder, since it has no Read tool.
  const up = async (name, buf) => (await (await fetch(`${b.base}/api/inbox/boat`, { method: 'POST', headers: { 'X-Ravenry': '1', 'X-Filename': name }, body: buf })).json()).path;
  const png = await up('style.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const txt = await up('notes.txt', Buffer.from('Keep the hull white, like the 1990 boat.\n'));
  const n2 = bruns().length;
  r = await b.post('/api/plan/draft', { projectId: 'boat', goal: 'Paint the boat like the picture', files: [png, txt] });
  for (let i = 0; i < 40; i++) { await sleep(250); d = (await b.get('/api/plan/draft?projectId=boat')).draft; if (d && !d.busy) break; }
  const fr = bruns().slice(n2).find((x) => x.argv.includes('--output-schema'));
  check('Plans: with files, Codex gets the picture with -i, the text file\'s words in the prompt, in the empty folder', !!fr && fr.argv[1] === '-i' && fs.realpathSync(fr.argv[2]) === fs.realpathSync(png) && !fr.argv.includes(txt) && fr.argv[fr.argv.indexOf('-C') + 1] === path.join(MC, 'plans', 'empty') && /The pictures among them are attached to this message/.test(fr.prompt) && /Keep the hull white, like the 1990 boat\./.test(fr.prompt) && !/Read tool/.test(fr.prompt) && d && !d.error, JSON.stringify(fr && fr.argv.slice(0, 4)));
  await b.post('/api/plan/discard', { projectId: 'boat' });

  r = await b.post('/api/ideas/add', { name: 'Float test', pitch: 'How long a paper boat floats' });
  const ideaId = r.j.id;
  await b.post(`/api/ideas/${ideaId}/say`, { text: 'Which paper floats best?' });
  let iv = null;
  for (let i = 0; i < 40; i++) { await sleep(250); iv = (await b.get('/api/ideas')).ideas.find((x) => x.id === ideaId); if (iv && !iv.pending) break; }
  const lastMsg = iv && iv.thread[iv.thread.length - 1];
  check('Ideas: a thread message with startWith codex is answered by codex exec in the ideas folder', lastMsg && /^Codex stub reply \(cwd ideas\): Which paper floats best\?/.test(lastMsg.text) && !lastMsg.error, JSON.stringify(lastMsg));
  const ir = bruns().filter((x) => x.env.MC_IDEA_JOB === ideaId).pop();
  check('Ideas: ...with no schema, read-only, hooks off', ir && !ir.argv.includes('--output-schema') && ir.argv[ir.argv.indexOf('--sandbox') + 1] === 'read-only' && ir.argv.some((a, i) => a === '--disable' && ir.argv[i + 1] === 'hooks') && ir.env.CMUX_CODEX_HOOKS_DISABLED === '1', JSON.stringify(ir && ir.argv));
  await b.post('/api/ideas/brainstorm', { seed: 'a toy boat game' });
  let ideasView = null;
  for (let i = 0; i < 40; i++) { await sleep(250); ideasView = await b.get('/api/ideas'); if (!ideasView.brainstorm) break; }
  check('Ideas: Get 3 directions goes to Codex and lands 3 ideas', ['Codex 1', 'Codex 2', 'Codex 3'].every((n) => ideasView.ideas.some((x) => x.name === n)) && !ideasView.brainstormError, JSON.stringify(ideasView.ideas.map((x) => x.name)));
  const storedIdea = (id) => JSON.parse(fs.readFileSync(path.join(MC, 'ideas.json'), 'utf8')).ideas.find((x) => x.id === id);
  check('Ideas: Codex\'s reply is stored as Codex\'s (who "codex"), in ideas.json and on the page\'s feed', lastMsg && lastMsg.who === 'codex' && storedIdea(ideaId).thread.slice(-1)[0].who === 'codex', JSON.stringify(lastMsg));
  // ---- busy lines name the assistant running the job: the stub hangs on
  // SLOW until the board's 8 s stop (claudeTimeoutMs, planTimeoutMs).
  r = await b.post('/api/ideas/add', { name: 'Slow boat', pitch: 'A boat that waits' });
  const slowId = r.j.id;
  await b.post(`/api/ideas/${slowId}/say`, { text: 'SLOW: think it through' });
  const busy1 = await b.post(`/api/ideas/${slowId}/say`, { text: 'And another thing' });
  const busy2 = await b.post(`/api/ideas/${slowId}/mockups`, {});
  let sv = (await b.get('/api/ideas')).ideas.find((x) => x.id === slowId);
  check('busy: while Codex answers, a second message is refused with "Codex is still answering the last one."', busy1.status === 409 && busy1.j.error === 'Codex is still answering the last one.' && sv.pending && sv.pending.who === 'codex', `${JSON.stringify(busy1)} ${JSON.stringify(sv.pending)}`);
  check('busy: ...and Mock it up says Codex is still answering', busy2.status === 409 && /^Codex is still answering the last message\./.test(busy2.j.error), JSON.stringify(busy2));
  await b.post('/api/ideas/brainstorm', { seed: 'SLOW sea game' });
  const busy3 = await b.post('/api/ideas/brainstorm', { seed: 'another seed' });
  const bs = (await b.get('/api/ideas')).brainstorm;
  check('busy: a second seed is refused with "Codex is still working on the last seed."', busy3.status === 409 && busy3.j.error === 'Codex is still working on the last seed.' && bs && bs.who === 'codex', `${JSON.stringify(busy3)} ${JSON.stringify(bs)}`);
  await b.post('/api/plan/draft', { projectId: 'mill', goal: 'SLOW: make the mill turn' });
  let md = null;
  for (let i = 0; i < 20; i++) { md = (await b.get('/api/plan/draft?projectId=mill')).draft; if (md && md.busy) break; await sleep(100); }
  const busy4 = await b.post('/api/plan/draft', { projectId: 'mill', goal: 'Something else' });
  check('busy: a second draft is refused with "Codex is still on the last change."', busy4.status === 409 && /^Codex is still on the last change\./.test(busy4.j.error) && md && md.busy && md.busy.who === 'codex', `${JSON.stringify(busy4)} ${JSON.stringify(md && md.busy)}`);
  await b.post('/api/plan/halt', { projectId: 'mill' });
  await b.post('/api/plan/discard', { projectId: 'mill' });
  let all = null;
  for (let i = 0; i < 80; i++) { all = await b.get('/api/ideas'); if (!all.brainstorm && !all.ideas.find((x) => x.id === slowId).pending) break; await sleep(250); }
  const slowLast = all.ideas.find((x) => x.id === slowId).thread.slice(-1)[0];
  check('busy: the answer that never came is Codex\'s, marked not answered', slowLast && slowLast.who === 'codex' && slowLast.error && !all.brainstorm, JSON.stringify(slowLast));
  let hasPw = true;
  try { await import('playwright'); } catch { hasPw = false; }
  if (hasPw) {
    await b.post(`/api/ideas/${ideaId}/mockups`, {});
    for (let i = 0; i < 60; i++) { await sleep(300); iv = (await b.get('/api/ideas')).ideas.find((x) => x.id === ideaId); if (iv && iv.mockups && !iv.mockups.job) break; }
    const round = iv && iv.mockups && iv.mockups.rounds[0];
    check('Mockups: a round with startWith codex lands 3 variants drawn from Codex\'s HTML, with its tokens', round && round.variants.length === 3 && round.variants[0].title === 'Codex a' && round.tokens && round.tokens.input === 1234 && !iv.mockups.error, JSON.stringify(iv && iv.mockups));
  } else console.log('SKIP  Mockups on Codex: Playwright is not installed');

  // ---- startWith claude: the stubs of claude -p again
  await b.post('/api/settings/assistant', { startWith: 'claude' });
  const n1 = bruns().length;
  await b.post(`/api/ideas/${ideaId}/say`, { text: 'And with Claude?' });
  for (let i = 0; i < 40; i++) { await sleep(250); iv = (await b.get('/api/ideas')).ideas.find((x) => x.id === ideaId); if (iv && !iv.pending) break; }
  const lm = iv.thread[iv.thread.length - 1];
  check('Ideas: with startWith claude the thread goes to claude -p as before', /^Stub reply \(stage Spark, cwd mc\/ideas\): And with Claude\?/.test(lm.text) && bruns().length === n1, JSON.stringify(lm));
  check('Ideas: Claude\'s reply is stored as Claude\'s, and the earlier Codex reply stays as it was', lm.who === 'claude' && iv.thread.find((m) => /^Codex stub reply/.test(m.text)).who === 'codex', JSON.stringify(iv.thread.map((m) => m.who)));
  await b.post('/api/plan/draft', { projectId: 'boat', goal: 'Make the boat float longer' });
  for (let i = 0; i < 40; i++) { await sleep(250); d = (await b.get('/api/plan/draft?projectId=boat')).draft; if (d && !d.busy) break; }
  check('Plans: with startWith claude the draft goes to claude -p as before', fs.existsSync(PLAN_ARGV) && d && d.title === 'Long notes on the paths' && bruns().length === n1, JSON.stringify(d && d.title));
  await b.post('/api/plan/discard', { projectId: 'boat' });

  // ---- a project's assistant after it was created: the API (the page's
  // "New sessions:" switch is checked on :4696 below). Mill has no
  // assistant of its own and Settings now says Claude; its newest session
  // is a Codex one, which plays no part.
  const regNow = () => JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));
  const millOf = () => regNow().projects.find((x) => x.id === 'mill');
  let pa = await b.post('/api/project/assistant', { projectId: 'mill', assistant: 'claude' }, {});
  check('project assistant: a write without the board\'s header is refused, nothing written', pa.status === 403 && !('assistant' in millOf()), `${pa.status} ${JSON.stringify(millOf())}`);
  const before = regNow();
  pa = await b.post('/api/project/assistant', { projectId: 'mill', assistant: 'claude' });
  const after = regNow();
  check('project assistant: set to Claude, through the registry: only that key of that project changes', pa.status === 200 && pa.j.assistant === 'claude' && pa.j.starts === 'claude' && millOf().assistant === 'claude' && JSON.stringify(after.settings) === JSON.stringify(before.settings) && JSON.stringify(after.projects.filter((x) => x.id !== 'mill')) === JSON.stringify(before.projects.filter((x) => x.id !== 'mill')), JSON.stringify(pa.j));
  await sleep(400);
  check('project assistant: /api/state carries it', (await b.state()).projects.find((x) => x.id === 'mill').assistant === 'claude');
  r = await b.post('/api/project/revive', { projectId: 'mill' });
  check('project assistant: the next Revive starts it (Claude Code)', r.status === 200 && r.j.assistant === 'claude' && /^claude 'Read BRIEF/.test(sentIn(r.j.surfaceId)[0] || ''), `${JSON.stringify(r.j)} ${JSON.stringify(sentIn(r.j && r.j.surfaceId))}`);
  pa = await b.post('/api/project/assistant', { projectId: 'mill', assistant: null });
  check('project assistant: null clears it, and the project follows Settings again (Claude Code), not its newest session (Codex)', pa.status === 200 && pa.j.assistant === null && pa.j.starts === 'claude' && !('assistant' in millOf()), JSON.stringify(pa.j));
  await sleep(400);
  const millSt = (await b.state()).projects.find((x) => x.id === 'mill');
  check('project assistant: ...and /api/state\'s switch value says Claude too', millSt.assistant === 'claude' && millSt.assistantWants === 'claude', JSON.stringify({ assistant: millSt.assistant, wants: millSt.assistantWants }));
  const bad = [await b.post('/api/project/assistant', { projectId: 'mill', assistant: 'gemini' }), await b.post('/api/project/assistant', { projectId: 'nope', assistant: 'codex' }), await b.post('/api/project/assistant', { projectId: 'mill' })];
  check('project assistant: an unknown assistant (400), an unknown project (404) and a missing value (400) are refused, nothing written', bad[0].status === 400 && /claude or codex/.test(bad[0].j.error) && bad[1].status === 404 && bad[2].status === 400 && !('assistant' in millOf()), JSON.stringify(bad.map((x) => [x.status, x.j && x.j.error])));
} catch (e) {
  console.error(e);
  fails++;
} finally {
  for (const s of servers) { try { s.kill(); } catch { /* gone */ } }
}

// ------------------------------------------------------------ 5b. no startWith, a throwaway Codex session
// The maintainer, 2026-11-04: "Initiating the Ravenry project from brief
// started a codex session". His settings had no startWith and the project no
// assistant; its newest session was a Codex live check run in its folder,
// and the board started Codex from that. A board on :4694 with that
// registry: Raven (no assistant) whose newest session is Codex, Owl (set
// to Codex).
async function noStartWithChecks() {
  const NMC = path.join(T, 'mc-nostart');
  fs.mkdirSync(NMC, { recursive: true });
  for (const n of ['raven', 'owl']) { fs.mkdirSync(P(n), { recursive: true }); fs.writeFileSync(path.join(P(n), 'BRIEF.md'), BRIEF(n)); }
  fs.writeFileSync(path.join(NMC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'projects'), repeatsAuto: false, launchCommand: 'claude' }, projects: [
    { id: 'raven', name: 'Raven', folder: P('raven'), workspaces: ['ws-raven'], brief: 'BRIEF.md' },
    { id: 'owl', name: 'Owl', folder: P('owl'), workspaces: ['ws-owl'], brief: 'BRIEF.md', assistant: 'codex' },
  ] }, null, 2));
  const NF = path.join(T, 'fake-cmux-nostart.json');
  fs.writeFileSync(NF, JSON.stringify({ newSurfaces: true, workspaces: ['raven', 'owl'].map((n, i) => ({ id: 'ws-' + n, ref: `workspace:${i + 1}`, title: n, cwd: P(n), surfaces: [] })), screens: {}, prompts: {} }));
  const nsent = (id) => (((JSON.parse(fs.readFileSync(NF, 'utf8')).prompts || {})[id] || {}).sent || []);
  // Auto-start on, for the hand-off's fresh session.
  const nb = await startBoard({ port: 4694, mc: NMC, env: { CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: NF, MC_CODEX: '1', MC_CLAUDE: '1', MC_CODEX_HOME: BCXH, MC_NO_AUTOSTART: '0' } });
  const hookTo = (input, assistant) => new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs'), ...(assistant === 'codex' ? ['--assistant=codex'] : [])], { env: { ...cleanEnv, RAVENRY_HOME: NMC, MC_BOARD_URL: nb.base } });
    ch.on('close', resolve);
    ch.stdin.end(JSON.stringify(input));
  });
  const CX_SID = '22222222-3333-4444-8555-000000000002';
  try {
    check('no startWith: the registry has none', !('startWith' in JSON.parse(fs.readFileSync(path.join(NMC, 'projects.json'), 'utf8')).settings));
    // An older Claude Code session, then the throwaway Codex check: the newest.
    await hookTo({ hook_event_name: 'SessionStart', session_id: '22222222-3333-4444-8555-000000000001', cwd: P('raven'), source: 'startup' }, 'claude');
    await hookTo({ hook_event_name: 'SessionEnd', session_id: '22222222-3333-4444-8555-000000000001', cwd: P('raven'), reason: 'exit' }, 'claude');
    await sleep(300);
    await hookTo({ hook_event_name: 'SessionStart', session_id: CX_SID, cwd: P('raven'), source: 'startup', model: 'gpt-5.6-luna' }, 'codex');
    await sleep(2500);
    let st = (await nb.state()).projects.find((x) => x.id === 'raven');
    check('no startWith: the switch (/api/state) shows Claude for a project whose newest session is Codex', st && st.assistant === 'claude' && st.assistantWants === 'claude', JSON.stringify(st && { assistant: st.assistant, wants: st.assistantWants }));
    let r = await nb.post('/api/project/revive', { projectId: 'raven' });
    check('no startWith: Revive (start from brief) starts Claude Code, not the newest session\'s Codex', r.status === 200 && r.j.assistant === 'claude' && /^claude 'Read BRIEF/.test(nsent(r.j.surfaceId)[0] || ''), `${r.status} ${JSON.stringify(r.j)} ${JSON.stringify(nsent(r.j && r.j.surfaceId))}`);
    r = await nb.post('/api/project/revive', { projectId: 'raven', text: 'Fix the switch' });
    check('no startWith: New session starts Claude Code too', r.status === 200 && r.j.assistant === 'claude' && /^claude 'Fix the switch'/.test(nsent(r.j.surfaceId)[0] || ''), JSON.stringify(nsent(r.j && r.j.surfaceId)));
    // The page's "New sessions:" switch, headless.
    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP  no startWith, the page: Playwright is not installed'); }
    const pageBtns = async (hash) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
        await pg.goto(`${nb.base}/?theme=dark#${hash}`);
        await pg.waitForSelector('#d-meta .pas-meta');
        await pg.waitForFunction((h) => document.querySelector('#d-head h1') && document.querySelector('#d-head h1').textContent.toLowerCase().includes(h), hash);
        return await pg.evaluate(() => [...document.querySelectorAll('#d-meta [data-pas]')].map((b) => b.textContent + (b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(','));
      } finally { await browser.close(); }
    };
    if (chromium) { const btns = await pageBtns('raven'); check('no startWith: the page\'s "New sessions:" switch shows Claude', btns === 'Claude*,Codex', btns); }
    // A project set to Codex starts Codex.
    st = (await nb.state()).projects.find((x) => x.id === 'owl');
    r = await nb.post('/api/project/revive', { projectId: 'owl' });
    check('no startWith: a project set to Codex Revives on Codex and its switch says Codex', r.status === 200 && r.j.assistant === 'codex' && /^codex 'Read BRIEF/.test(nsent(r.j.surfaceId)[0] || '') && st.assistantWants === 'codex', `${JSON.stringify(r.j)} ${JSON.stringify(nsent(r.j && r.j.surfaceId))} ${st.assistantWants}`);
    // A hand-off from the Codex session continues on Codex: the session's
    // assistant, not the project's or Settings' (both Claude Code here).
    fs.mkdirSync(path.join(NMC, 'handoffs'), { recursive: true });
    fs.writeFileSync(path.join(NMC, 'handoffs', CX_SID + '.json'), JSON.stringify({ sessionId: CX_SID, state: 'written', assistant: 'codex', cwd: P('raven'), folder: P('raven'), workspaceId: 'ws-raven', writtenAt: new Date().toISOString(), history: [{ state: 'written', at: new Date().toISOString() }] }, null, 2));
    let m = null;
    for (let i = 0; i < 40; i++) { await sleep(250); try { m = JSON.parse(fs.readFileSync(path.join(NMC, 'handoffs', CX_SID + '.json'), 'utf8')); } catch { m = null; } if (m && (m.state === 'resumed' || m.resumeError)) break; }
    check('hand-off: a Codex session\'s fresh session starts Codex, under no startWith and a project with no assistant', m && m.state === 'resumed' && /^codex 'Read the Hand-off section/.test(m.resumeCommand || '') && /^codex 'Read the Hand-off/.test(nsent(m.resumeSurfaceId)[0] || ''), JSON.stringify(m && { state: m.state, cmd: m.resumeCommand, err: m.resumeError }));
    // Settings to Codex: the same project now starts Codex and says so.
    await nb.post('/api/settings/assistant', { startWith: 'codex' });
    await sleep(1500);
    st = (await nb.state()).projects.find((x) => x.id === 'raven');
    check('startWith codex: the switch (/api/state) shows Codex for the same project', st && st.assistant === 'codex' && st.assistantWants === 'codex', JSON.stringify(st && { assistant: st.assistant, wants: st.assistantWants }));
    r = await nb.post('/api/project/revive', { projectId: 'raven' });
    check('startWith codex: Revive starts Codex', r.status === 200 && r.j.assistant === 'codex' && /^codex 'Read BRIEF/.test(nsent(r.j.surfaceId)[0] || ''), `${JSON.stringify(r.j)} ${JSON.stringify(nsent(r.j && r.j.surfaceId))}`);
    if (chromium) { const btns = await pageBtns('raven'); check('startWith codex: the page\'s "New sessions:" switch shows Codex', btns === 'Claude,Codex*', btns); }
  } finally {
    nb.board.kill();
  }
}

await noStartWithChecks().catch((e) => { console.error(e); fails++; });

// ------------------------------------------------------------ 6. the page
// docs/design/CodexStage2.dc.html, section 3, variant A, on a test board on
// :4696 with the fake cmux: Boat (assistant codex) and Kite (assistant
// claude) each with a session at its prompt.

// Where the meta line's words sit, in the page: for every item (each fact,
// the "New sessions:" group) its layout box (the margin box, so the box
// the flex line holds) and the baseline of its words (a Range's box, the
// font's ascent share of it measured on a zero inline-block, which sits on
// the baseline). `dy` is a baseline's distance from its row's top, so a
// group alone on a row compares with the facts too; `same` lists the
// absolute baseline differences against a fact on the same row.
function metaGeometry() {
  const meta = document.querySelector('#d-meta');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;font-size:100px;line-height:normal;white-space:nowrap;visibility:hidden';
  probe.append('Xg');
  const mk = document.createElement('span');
  mk.style.cssText = 'display:inline-block;width:0;height:0';
  probe.append(mk);
  meta.append(probe);
  const pr = document.createRange(); pr.selectNodeContents(probe.firstChild);
  const pb = pr.getBoundingClientRect();
  const ratio = (mk.getBoundingClientRect().top - pb.top) / pb.height;
  probe.remove();
  // the first line's box: a fact that wraps (a long folder on a phone)
  // has one per line
  const baseOf = (node) => { const r = document.createRange(); r.selectNodeContents(node); const b = r.getClientRects()[0]; return b.top + b.height * ratio; };
  const textIn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }); return w.nextNode(); };
  const boxOf = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { top: b.top - parseFloat(cs.marginTop), bottom: b.bottom + parseFloat(cs.marginBottom) }; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const facts = [...meta.children].filter((x) => !x.matches('.pas-meta, .pas-err')).map((el) => { const box = boxOf(el); const base = baseOf(textIn(el)); return { text: el.textContent.slice(0, 24), top: box.top, h: box.bottom - box.top, base, dy: base - box.top }; });
  // the reference: the first fact on one line
  const ref = facts.find((f) => f.h < 1.5 * facts.reduce((m, x) => Math.min(m, x.h), 1e9)) || facts[0];
  const grp = meta.querySelector('.pas-meta');
  const gbox = boxOf(grp);
  const sw = grp.querySelector('.hs-seg').getBoundingClientRect();
  const words = [grp.querySelector('#pas-l'), ...grp.querySelectorAll('.seg')].map((el) => { const base = baseOf(textIn(el)); return { text: el.textContent, base, dy: base - gbox.top }; });
  const fdy = ref.dy;
  const row = facts.filter((f) => Math.abs(f.top - gbox.top) < 0.5);
  return {
    ratio: r2(ratio),
    factDy: facts.map((f) => r2(f.dy - fdy)),
    wordDy: words.map((w) => [w.text, r2(w.dy - fdy)]),
    same: row.length ? words.map((w) => [w.text, r2(w.base - row[0].base)]) : null,
    sameWith: row.length ? row[0].text : null,
    centre: r2((sw.top + sw.height / 2) - (gbox.top + gbox.bottom) / 2),
    groupRowH: r2(gbox.bottom - gbox.top), factRowH: r2(ref.h),
    labelTop: r2(grp.querySelector('#pas-l').getBoundingClientRect().top), switchTop: r2(sw.top), labelRight: r2(grp.querySelector('#pas-l').getBoundingClientRect().right), switchLeft: r2(sw.left),
    metaH: r2(meta.getBoundingClientRect().height),
    metaHWithout: (() => { grp.style.display = 'none'; const h = meta.getBoundingClientRect().height; grp.style.display = ''; return r2(h); })(),
  };
}

async function metaSwitchChecks(browser, pb, PMC, SH) {
  const boatOf = () => JSON.parse(fs.readFileSync(path.join(PMC, 'projects.json'), 'utf8')).projects.find((x) => x.id === 'boat');
  const read = (pg) => pg.evaluate(() => {
    const meta = document.querySelector('#d-meta');
    const g = meta.querySelector('.pas-meta');
    return {
      label: g ? g.querySelector('#pas-l').textContent : null,
      btns: g ? [...g.querySelectorAll('[data-pas]')].map((b) => b.textContent + (b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(',') : null,
      groups: meta.querySelectorAll('.pas-meta').length,
      last: g ? g === meta.lastElementChild : false,
      err: (meta.querySelector('.pas-err') || {}).textContent || null,
      lvTag: (document.querySelector('.lv-h .as-tag') || {}).textContent || null,
    };
  });
  const errsAll = [];
  for (const [vp, tag] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 412, height: 915 }, '412'], [{ width: 390, height: 844 }, '390']]) {
    for (const theme of ['dark', 'light']) {
      if (tag === '390' && theme === 'light') continue;
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errsAll.push(e.message));
      await pg.goto(`${pb.base}/?theme=${theme}#boat`);
      await pg.waitForSelector('#d-meta .pas-meta');
      await pg.waitForFunction(() => document.querySelector('.lv-h .as-tag'), null, { timeout: 5000 }).catch(() => {});
      const st = await read(pg);
      const g = await pg.evaluate(metaGeometry);
      console.log(`      meta line at ${tag} ${theme}: ${JSON.stringify(g)}`);
      const words = g.wordDy.every(([, d]) => Math.abs(d) <= 1) && g.factDy.every((d) => Math.abs(d) <= 1);
      const same = !g.same || g.same.every(([, d]) => Math.abs(d) <= 1);
      if (theme === 'dark') {
        check(`page ${tag}: the meta line ends on "New sessions:" and the switch, on Paper Boat's own Codex`, st.label === 'New sessions:' && st.btns === 'Claude,Codex*' && st.groups === 1 && st.last, JSON.stringify(st));
        check(`page ${tag}: the label's and the switch's words sit on the facts' baseline (within 1px)`, words && same, `${JSON.stringify(g.wordDy)} same row as "${g.sameWith}": ${JSON.stringify(g.same)}`);
        check(`page ${tag}: the switch is centred on its line (within 1px), the label and the switch on one row`, Math.abs(g.centre) <= 1 && Math.abs(g.groupRowH - g.factRowH) <= 0.5 && Math.abs(g.labelTop - g.switchTop) < 6 && g.labelRight < g.switchLeft, `centre ${g.centre}, row ${g.groupRowH} vs ${g.factRowH}`);
        if (tag === '1440') check('page 1440: the meta line keeps its height with the switch', Math.abs(g.metaH - g.metaHWithout) <= 0.5 && g.metaHWithout === g.factRowH, `${g.metaHWithout} without, ${g.metaH} with`);
      }
      if (SH) {
        const box = await pg.evaluate(() => { const b = document.querySelector('#d-headbox').getBoundingClientRect(); return { x: Math.max(0, b.left - 16), y: Math.max(0, b.top + window.scrollY - 12), width: Math.min(window.innerWidth - Math.max(0, b.left - 16), b.width + 32), height: b.height + 24 }; });
        await pg.screenshot({ path: path.join(SH, `meta-switch-${tag}-${theme}.png`), clip: box });
      }
      if (tag === '1440' && theme === 'dark') {
        // A flip saves at once, shows at once, and leaves the running
        // session's tag alone.
        const tag0 = st.lvTag;
        await pg.click('#d-meta [data-pas="claude"]');
        const shown = await read(pg);
        for (let i = 0; i < 20 && boatOf().assistant !== 'claude'; i++) await sleep(100);
        check('page: Claude saves Paper Boat\'s assistant through POST /api/project/assistant, shown at once', boatOf().assistant === 'claude' && shown.btns === 'Claude*,Codex', `${boatOf().assistant} ${shown.btns}`);
        await sleep(1500);
        const st2 = await pb.state();
        const after = await read(pg);
        check('page: the board\'s state agrees and the switch stays on Claude', st2.projects.find((x) => x.id === 'boat').assistantWants === 'claude' && after.btns === 'Claude*,Codex', `${JSON.stringify(st2.projects.find((x) => x.id === 'boat').assistantWants)} ${after.btns}`);
        check('page: the running session keeps its tag', !!tag0 && after.lvTag === tag0, `${tag0} -> ${after.lvTag}`);
        await pg.click('#d-meta [data-pas="codex"]');
        for (let i = 0; i < 20 && boatOf().assistant !== 'codex'; i++) await sleep(100);
        check('page: and back to Codex', boatOf().assistant === 'codex');
        await sleep(600);
        // A failed save snaps back, with the error beside the switch.
        await pg.route('**/api/project/assistant', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not write projects.json (the disk is full)' }) }));
        await pg.click('#d-meta [data-pas="claude"]');
        await pg.waitForSelector('#d-meta .pas-err', { timeout: 3000 }).catch(() => {});
        const failed = await read(pg);
        check('page: a failed save snaps back to Codex with the error where the switch is', failed.btns === 'Claude,Codex*' && failed.err === 'Not saved: Could not write projects.json (the disk is full).' && boatOf().assistant === 'codex', JSON.stringify(failed));
        if (SH) {
          const box = await pg.evaluate(() => { const b = document.querySelector('#d-headbox').getBoundingClientRect(); return { x: b.left - 16, y: b.top + window.scrollY - 12, width: b.width + 32, height: b.height + 24 }; });
          await pg.screenshot({ path: path.join(SH, 'meta-switch-1440-dark-error.png'), clip: box });
        }
        await pg.unroute('**/api/project/assistant');
        // Kite is set to Claude.
        await pg.evaluate(() => { location.hash = '#kite'; });
        await pg.waitForFunction(() => /Kite/.test(document.querySelector('#d-head h1').textContent));
        const kite = await read(pg);
        check('page: Kite\'s switch shows its own Claude', kite.btns === 'Claude*,Codex' && !kite.err, JSON.stringify(kite));
      }
      await ctx.close();
    }
  }
  check('page: no page errors (the meta line switch)', !errsAll.length, errsAll.join(' | '));
}

async function pageChecks() {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP  the page: Playwright is not installed'); return; }
  const PMC = path.join(T, 'mc-page');
  fs.mkdirSync(PMC, { recursive: true });
  fs.writeFileSync(path.join(PMC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'projects'), repeatsAuto: false }, projects: [
    { id: 'boat', name: 'Paper Boat', folder: P('boat'), workspaces: ['ws-boat'], brief: 'BRIEF.md', assistant: 'codex' },
    { id: 'kite', name: 'Kite', folder: P('kite'), workspaces: ['ws-kite'], brief: 'BRIEF.md', assistant: 'claude' },
  ] }, null, 2));
  const PF = path.join(T, 'fake-cmux-page.json');
  const BODY = '\n⏺ Tilted the hull 4 degrees and ran the float test again: it holds for 40 s.\n\n✻ Worked for 1m 12s\n';
  const S1 = 'AAAAAAAA-0000-4000-8000-0000000000A1', S2 = 'BBBBBBBB-0000-4000-8000-0000000000B1';
  fs.writeFileSync(PF, JSON.stringify({ newSurfaces: true, workspaces: [
    { id: 'ws-boat', ref: 'workspace:1', title: 'Paper Boat', cwd: P('boat'), surfaces: [{ id: S1, ref: 'surface:1', title: '✳ Tilting the hull' }] },
    { id: 'ws-kite', ref: 'workspace:2', title: 'Kite', cwd: P('kite'), surfaces: [{ id: S2, ref: 'surface:2', title: '✳ Kite' }] },
  ], screens: {}, prompts: { [S1]: { body: BODY }, [S2]: { body: BODY } } }));
  // An idea whose thread has a Claude and a Codex reply and a Codex answer
  // still pending, and a plan Codex was drafting, when the board stopped.
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(PMC, 'ideas.json'), JSON.stringify({ version: 1, seededAt: at, ideas: [{ id: 'kite-idea', name: 'Kite race', stage: 'spark', pitch: 'Kites over the rooftops.', status: '', img: null, alt: null, created: at, updated: at,
    thread: [{ who: 'you', text: 'Which wind is best?', at }, { who: 'claude', text: 'A steady one from the sea.', at }, { who: 'you', text: 'And at dusk?', at }, { who: 'codex', text: 'Calmer, so smaller kites.', at }, { who: 'you', text: 'Pick one.', at }],
    pending: { startedAt: at, timeoutMs: 180000, who: 'codex' } }] }, null, 1));
  fs.mkdirSync(path.join(PMC, 'plans', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(PMC, 'plans', 'drafts', 'kite.json'), JSON.stringify({ id: 'd1', projectId: 'kite', mode: 'new', goal: 'Fly higher', title: null, thread: [{ who: 'you', text: 'Fly higher', at }], steps: [], questions: [], marks: {}, refs: [], busy: { since: at, what: 'draft', who: 'codex' }, error: null, calls: [], createdAt: at }));
  const pb = await startBoard({ port: 4696, mc: PMC, env: { CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: PF, MC_CODEX: '1', MC_CLAUDE: '1', MC_CODEX_HOME: BCXH } });
  const browser = await chromium.launch({ headless: true });
  const SH = SHOTS;
  try {
    const open = async (vp, theme, hash = 'boat') => {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(e.message));
      await pg.goto(`${pb.base}/?theme=${theme}#${hash}`);
      await pg.waitForSelector('#ns');
      await pg.waitForFunction(() => !document.querySelector('#send').disabled);
      return { ctx, pg, errs };
    };
    const regStart = () => JSON.parse(fs.readFileSync(path.join(PMC, 'projects.json'), 'utf8')).settings.startWith;
    for (const [vp, tag] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'phone']]) {
      for (const theme of ['dark', 'light']) {
        const first = tag === 'desktop' && theme === 'dark';
        const { ctx, pg, errs } = await open(vp, theme);
        // ---- Settings
        await pb.post('/api/settings/assistant', { startWith: 'claude' });
        await pg.click('#gear');
        await pg.waitForSelector('#hs-pop [data-as]');
        await pg.waitForFunction(() => document.querySelector('#hs-pop [data-as="claude"]').classList.contains('on'));
        const card = await pg.evaluate(() => {
          const body = document.querySelector('#hs-pop .hs-body');
          return { first: body.querySelector('.hs-sec').textContent, label: document.querySelector('#as-l').textContent, btns: [...body.querySelectorAll('[data-as]')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')), secs: [...body.querySelectorAll('.hs-sec')].map((x) => x.firstChild.textContent) };
        });
        if (first) {
          check('page: the Settings card opens on its Assistant section, before Hand-off', card.first.startsWith('Assistant') && card.secs[0] === 'Assistant' && card.secs[1] === 'Hand-off', JSON.stringify(card));
          check('page: "Start new sessions with" and a two-way switch, Claude (on, the default) and Codex', card.label === 'Start new sessions with' && card.btns.join(',') === 'Claude*,Codex', JSON.stringify(card.btns));
        }
        if (SH) await pg.screenshot({ path: path.join(SH, `settings-${tag}-${theme}.png`) });
        if (first) {
          await pg.click('#hs-pop [data-as="codex"]');
          await pg.waitForFunction(() => /New sessions start with Codex/.test(document.querySelector('#hs-foot').textContent));
          const after = await pg.evaluate(() => [...document.querySelectorAll('#hs-pop [data-as]')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(','));
          check('page: Codex saves startWith codex at once and says so', regStart() === 'codex' && after === 'Claude,Codex*', `${regStart()} ${after}`);
          const ctxw = await pg.evaluate(() => [...document.querySelectorAll('#hs-pop [data-hs="w200"], #hs-pop [data-hs="w1m"]')].some((b) => b.classList.contains('on')));
          check('page: the context window switch still shows its value', ctxw);
          await pg.click('#hs-pop [data-as="claude"]');
          await pg.waitForFunction(() => /New sessions start with Claude Code/.test(document.querySelector('#hs-foot').textContent));
          check('page: and back to Claude', regStart() === 'claude');
        }
        await pg.keyboard.press('Escape');
        // ---- New project
        await pb.post('/api/settings/assistant', { startWith: first ? 'codex' : 'claude' });
        await pg.evaluate(() => { location.hash = '#boat'; });
        await pg.waitForTimeout(400);
        await pg.click('#new-project');
        await pg.waitForSelector('#m-asst-row');
        await pg.fill('input[name="name"]', 'Garden planner');
        const np = await pg.evaluate(() => ({ prev: document.querySelector('#m-asst-row').previousElementSibling.id, btns: [...document.querySelectorAll('#m-asst-row [data-asst]')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(','), hint: document.querySelector('#m-asst-row .as-hint').textContent, foot: document.querySelector('#m-foot').textContent }));
        if (first) {
          check('page: New project has an Assistant row right under Folder, defaulting from Settings (Codex)', np.prev === 'm-folder-row' && np.btns === 'Claude,Codex*' && /From Settings \(Start new sessions with\)/.test(np.hint) && /with Codex reading it/.test(np.foot), JSON.stringify(np));
          await pg.click('#m-asst-row [data-asst="claude"]');
          const foot2 = await pg.textContent('#m-foot');
          check('page: picking Claude for this project changes the foot to Claude', /with Claude reading it/.test(foot2), foot2);
        } else if (tag === 'desktop') check('page: with Settings on Claude the row defaults to Claude', np.btns === 'Claude*,Codex', np.btns);
        if (SH) {
          await pg.evaluate(() => { const r = document.querySelector('#m-folder-row'); r.scrollIntoView({ block: 'start' }); const m = document.querySelector('.modal-back'); if (m) m.scrollTop = Math.max(0, m.scrollTop - 90); });
          await pg.screenshot({ path: path.join(SH, `newproject-${tag}-${theme}.png`) });
        }
        await pg.click('#modal-close');
        // ---- the New session switch's line
        await pg.click('#ns');
        await pg.fill('#compose', 'Fix the end screen on small phones');
        await pg.waitForFunction(() => !document.querySelector('#ns-hint').hidden);
        const hint = await pg.evaluate(() => document.querySelector('#ns-hint').textContent);
        if (first) check('page: in a Codex project the switch\'s line says it starts Codex', hint === `Opens a new cmux tab in ${'~' + P('boat').slice(os.homedir().length)} running Codex, this project's assistant.`, hint);
        if (SH) {
          await pg.evaluate(() => document.querySelector('#composer').scrollIntoView({ block: 'center' }));
          await pg.screenshot({ path: path.join(SH, `newsession-${tag}-${theme}.png`) });
        }
        if (first) {
          await pg.evaluate(() => { location.hash = '#kite'; });
          await pg.waitForTimeout(600);
          const kite = await pg.evaluate(() => ({ on: document.querySelector('#ns').classList.contains('on'), hidden: document.querySelector('#ns-hint').hidden }));
          if (!kite.on) { await pg.click('#ns'); }
          const kh = await pg.evaluate(() => document.querySelector('#ns-hint').hidden);
          check('page: in a Claude Code project the switch shows no new line', kh, JSON.stringify(kite));
          check('page: no page errors', !errs.length, errs.join(' | '));
        }
        await ctx.close();
      }
    }
    // ---- the meta line's "New sessions:" switch (docs/design/
    // ProjectAssistant.dc.html, round 2, A1): its state, a flip saving the
    // project's assistant, a failed save snapping back, and its words on
    // the meta line's baseline with the line's height unchanged.
    await metaSwitchChecks(browser, pb, PMC, SH);
    // ---- Ideas and Plans name the assistant running them
    await pb.post('/api/settings/assistant', { startWith: 'codex' });
    const iv = (await pb.get('/api/ideas')).ideas.find((x) => x.id === 'kite-idea');
    const restarted = iv.thread[iv.thread.length - 1];
    check('restart: an answer Codex was writing when the board stopped says Codex, under Codex\'s name', restarted.who === 'codex' && restarted.error && restarted.text === 'The board restarted before Codex answered. Send it again.', JSON.stringify(restarted));
    const pd = (await pb.get('/api/plan/draft?projectId=kite')).draft;
    check('restart: a plan Codex was drafting says Codex', pd && pd.error === 'The board restarted while Codex was drafting. Send it again.', JSON.stringify(pd && pd.error));
    for (const [vp, tag] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'phone']]) {
      for (const theme of ['dark', 'light']) {
        const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
        const pg = await ctx.newPage();
        const errs = [];
        pg.on('pageerror', (e) => errs.push(e.message));
        await pg.goto(`${pb.base}/?theme=${theme}&view=ideas&idea=kite-idea`);
        await pg.waitForSelector('#i-thread .msg.codex');
        await pg.waitForFunction(() => /Codex/.test(document.querySelector('#i-talk').textContent), null, { timeout: 5000 }).catch(() => {});
        const ip = await pg.evaluate(() => {
          const bg = (el) => el && getComputedStyle(el).backgroundColor;
          const c = document.querySelector('#i-thread .msg.claude');
          const x = document.querySelector('#i-thread .msg.codex');
          return { talk: document.querySelector('#i-talk').textContent, seed: document.querySelector('#seed').placeholder, same: bg(c) === bg(x) && getComputedStyle(c).marginRight === getComputedStyle(x).marginRight, codexText: x.textContent, err: document.querySelector('#i-thread .msg.err').textContent };
        });
        if (tag === 'desktop' && theme === 'dark') {
          check('page: a Codex reply in an idea\'s thread has the reply\'s element and style, as Claude\'s', ip.same && ip.codexText === 'Calmer, so smaller kites.', JSON.stringify(ip));
          check('page: the thread\'s card and the seed box name Codex when Plans and Ideas run on it', ip.talk === 'Talk it through with Codex' && /^Brainstorm with Codex:/.test(ip.seed), JSON.stringify(ip));
          check('page: the restart line names Codex', /The board restarted before Codex answered/.test(ip.err), ip.err);
          check('page: no page errors (Ideas)', !errs.length, errs.join(' | '));
        }
        if (SH) { await pg.evaluate(() => document.querySelector('#i-thread').scrollIntoView({ block: 'center' })); await pg.screenshot({ path: path.join(SH, `ideas-codex-${tag}-${theme}.png`) }); }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    pb.board.kill();
  }
}

await pageChecks().catch((e) => { console.error(e); fails++; });

// ------------------------------------------------------------ 7. --real

// New session on a scratch board on :4697 with the real cmux, startWith
// codex and the refusal the plan draft just measured: the board types
// `codex -m <fallback> '<words>'` into a new tab of a throwaway mc-test
// workspace (never focused; its CODEX_HOME, through cmux's --env, is the
// scratch one, which trusts the folder), Codex answers, the workspace is
// closed. Only that workspace is typed into.
async function liveLaunch(RH) {
  const CMUX = process.env.CMUX_BIN_REAL || '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cm = (a, json) => { const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...a] : a, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } }); return json ? JSON.parse(out) : out; };
  const tree = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces);
  const name = 'mc-test-codexstart-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir = path.join(T, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), '# Scratch\n\nGoal: A throwaway folder for the Codex launch check.\n\n## Hand-off\n');
  fs.appendFileSync(path.join(RH, 'config.toml'), `\n[projects."${dir}"]\ntrust_level = "trusted"\n`);
  const LMC = path.join(T, 'mc-live');
  fs.mkdirSync(LMC, { recursive: true });
  const known = path.join(process.env.RAVENRY_HOME, 'codex-model.json');
  if (fs.existsSync(known)) fs.copyFileSync(known, path.join(LMC, 'codex-model.json'));
  let ws = null;
  let lb = null;
  try {
    cm(['new-workspace', '--name', name, '--focus', 'false', '--cwd', dir, '--env', `CODEX_HOME=${RH}`]);
    for (let k = 0; k < 40 && !ws; k++) { await sleep(250); ws = tree().find((w) => w.title === name) || null; }
    if (!ws) throw new Error('the scratch workspace did not appear');
    fs.writeFileSync(path.join(LMC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), repeatsAuto: false, startWith: 'codex' }, projects: [{ id: name, name: 'Scratch', folder: dir, workspaces: [ws.id], brief: 'BRIEF.md' }] }, null, 2));
    lb = await startBoard({ port: 4697, mc: LMC, env: { MC_CODEX: '1', MC_CLAUDE: '1', MC_CODEX_HOME: RH } });
    const r = await lb.post('/api/project/revive', { projectId: name, text: 'Reply with exactly: board-ok' });
    const want = `codex -m ${(cx.modelState() || {}).using || 'gpt-6-luna'} 'Reply with exactly: board-ok'`;
    check('live: New session with startWith codex types codex with the fallback model and the words', r.status === 200 && r.j.assistant === 'codex' && r.j.command === want, `${r.status} ${JSON.stringify(r.j)}`);
    const read = (id) => cm(['read-screen', '--workspace', ws.id, '--surface', id, '--lines', '40']);
    let scr = '';
    for (let k = 0; k < 90; k++) { await sleep(1000); try { scr = read(r.j.surfaceId); } catch { scr = ''; } if (/•\s*board-ok/.test(scr)) break; }
    fs.writeFileSync(path.join(T, 'live-codex-tab.txt'), scr);
    check('live: Codex started in the new tab with the words as its first prompt and answered', /› Reply with exactly: board-ok/.test(scr) && /•\s*board-ok/.test(scr), scr.split('\n').filter((l) => l.trim()).slice(-8).join(' / '));
  } finally {
    if (lb) lb.board.kill();
    if (ws) { try { cm(['close-workspace', '--workspace', ws.id]); console.log('closed scratch workspace', ws.id); } catch (e) { console.log('could not close', ws.id, e.message); } }
    check('live: the scratch workspace is closed', !!ws && !tree().some((w) => w.id === ws.id));
  }
}

if (REAL) {
  const RH = path.join(T, 'codex-home-real');
  fs.mkdirSync(RH, { recursive: true });
  const realHome = path.join(os.homedir(), '.codex');
  try {
    fs.copyFileSync(path.join(realHome, 'auth.json'), path.join(RH, 'auth.json'));
    let realModel = null;
    try { realModel = (fs.readFileSync(path.join(realHome, 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || null; } catch { /* none */ }
    if (realModel) fs.writeFileSync(path.join(RH, 'config.toml'), `model = "${realModel}"\n`);
    const renv = { ...process.env, MC_CODEX_HOME: RH, MC_CODEX_BIN: '', STUB_CODEX_ARGV_FILE: '' };
    delete renv.MC_CODEX_BIN;
    const bin = cx.realBin({}, renv);
    check('real: the real codex binary, not cmux\'s shim', !!bin && !cx.isShim(bin), String(bin));
    const parse = (a) => spawnSync(bin, a, { env: { ...renv, CODEX_HOME: RH, CMUX_CODEX_HOOKS_DISABLED: '1' }, input: '', encoding: 'utf8', timeout: 15000 });
    const dash = parse(['-x hello']);
    const dashed = parse(['--', '-x hello']);
    check('real: `codex \'-x hello\'` is refused as an unknown argument', /unexpected argument/.test(dash.stderr + dash.stdout), (dash.stderr + dash.stdout).trim().split('\n')[0]);
    check('real: `codex -- \'-x hello\'` takes it as the prompt (it stops at "stdin is not a terminal")', /not a terminal/.test(dashed.stderr + dashed.stdout) && !/unexpected argument/.test(dashed.stderr + dashed.stdout), (dashed.stderr + dashed.stdout).trim().split('\n')[0]);
    process.env.MC_CODEX_HOME = RH;
    delete process.env.MC_CODEX_BIN;
    fs.rmSync(path.join(process.env.RAVENRY_HOME, 'codex-model.json'), { force: true });
    const planner = await import('../server/planner.mjs');
    const prompt = planner.draftPrompt({ project: { name: 'Scratch', folder: null }, brief: null, rules: [], goal: 'Add one line saying hello to the README' });
    const t0 = Date.now();
    const res = await planner.callModel({ printAssistant: 'codex', planTimeoutMs: 180000, printSettings: {} }, prompt, { key: 'real' });
    const v = res.ok ? planner.validateDraft(res.data) : null;
    check('real: codex exec drafts a plan the board\'s check accepts', res.ok && v && v.ok, JSON.stringify(res.ok ? v : res).slice(0, 300));
    console.log(`real: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${res.usage ? `${res.usage.in} tokens in, ${res.usage.out} out` : 'no usage'}, model ${res.usage && res.usage.model}${cx.modelState() ? `, configured ${cx.modelState().configured} refused, ran ${cx.modelState().using}` : ''}`);
    if (v && v.ok) console.log('real: ' + v.value.title + ' / ' + v.value.steps.map((s) => s.kind + ': ' + s.text).join(' / '));
    await liveLaunch(RH);
  } catch (e) {
    console.error(e);
    fails++;
  } finally {
    fs.rmSync(path.join(RH, 'auth.json'), { force: true });
    check('real: the copied auth.json is deleted', !fs.existsSync(path.join(RH, 'auth.json')));
  }
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
