// The assistant registry (server/assistants.mjs, docs/ASSISTANTS.md "The
// registry"): Claude Code and Codex read exactly as before, and a third
// assistant flows through the board with no code of its own beyond its
// entry. The third is the test-only stand-in (`fake`), registered only in a
// test's process that asks for it (TEST_RAVENRY=1 and
// TEST_RAVENRY_ASSISTANT=fake), so it never reaches a real user.
//
// Without a board: who is registered under which environment, the views
// clients are sent, the start, resume and model words of each, and the
// stand-in's state reports as the board's events.
//
// With a board and a real ravenryd (RAVENRYD_BIN, else ../daemon/ravenryd)
// on scratch data, the stand-in registered: the hub lists it (the state,
// New session's answer, Settings), a project set to it starts its command
// in a labelled pane, and its `ravenryd hook --assistant fake --state ...`
// reports move the session between Working, Needs you and Idle, tagged
// with its word. Then the board page at 390 px (headless Chromium, the
// board's loopback page at phone width) shows it in New session, and its
// picture goes to OUT.
//
//   node tools/assistants-test.mjs [OUT]
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}

// ------------------------------------------------------------ who is registered
// Each in a fresh process: the registry reads its environment once.
const idsUnder = (env) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const a = await import(process.argv[1]); console.log(JSON.stringify(a.IDS));", path.join(ROOT, 'server/assistants.mjs')], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return r.stderr; }
};
check('a real user: Claude Code and Codex, in that order', JSON.stringify(idsUnder({})) === '["claude","codex"]', JSON.stringify(idsUnder({})));
check('asking for the stand-in outside a test: not registered', JSON.stringify(idsUnder({ TEST_RAVENRY_ASSISTANT: 'fake' })) === '["claude","codex"]');
check('a test that does not ask: not registered', JSON.stringify(idsUnder({ TEST_RAVENRY: '1' })) === '["claude","codex"]');
check('a test that asks: registered third', JSON.stringify(idsUnder({ TEST_RAVENRY: '1', TEST_RAVENRY_ASSISTANT: 'fake' })) === '["claude","codex","fake"]');

// This process did not ask, so its registry is a real user's.
const reg = await import('../server/assistants.mjs');
const v = reg.views();
check('views: what each client is sent, Claude Code and Codex as their words were',
  v.length === 2 && v[0].id === 'claude' && v[0].name === 'Claude Code' && v[0].short === 'Claude' && v[0].chip === 'Claude' && v[0].rules === 'CLAUDE.md' && v[0].hooks === 'claude'
  && v[1].id === 'codex' && v[1].name === 'Codex' && v[1].short === 'Codex' && v[1].chip === 'Codex' && v[1].rules === 'AGENTS.md' && v[1].hooks === 'codex'
  && v.every((a) => a.caps.resume && a.caps.model && a.caps.permission && a.caps.context && a.caps.handoff && a.caps.print && !a.test), JSON.stringify(v));
check('words: resume and model as each CLI takes them', JSON.stringify([reg.words('claude', 'resume', 'x'), reg.words('codex', 'resume', 'x'), reg.words('claude', 'model', 'm'), reg.words('codex', 'model', 'm')]) === '[["--resume","x"],["resume","x"],["--model","m"],["-m","m"]]');
check('refusal words unchanged for two', reg.idsSaid() === 'claude or codex' && reg.namesSaid() === 'Claude Code and Codex');
{
  const ss = await import('../server/sessionstart.mjs');
  const launch = (p, k) => ({ kind: k || 'claude', command: k === 'codex' ? 'codex' : 'claude' });
  const id = '0f0f0f0f-0000-4000-8000-000000000001';
  const c = ss.plan({ folder: '/tmp/x', assistant: 'claude', resume: id }, { launch });
  const x = ss.plan({ folder: '/tmp/x', assistant: 'codex', resume: id }, { launch });
  check('resume lines unchanged: claude --resume, codex resume', c.line === `claude --resume ${id}` && JSON.stringify(c.args) === JSON.stringify(['--resume', id]) && x.line === `codex resume ${id}` && JSON.stringify(x.args) === JSON.stringify(['resume', id]), `${c.line} | ${x.line}`);
  const f = ss.plan({ folder: '/tmp/x', assistant: 'fake' }, { launch });
  check('a real user\'s hub refuses the stand-in', f.ok === false && f.status === 400 && f.error === 'assistant is claude or codex.', JSON.stringify(f));
  const m = await import('../server/models.mjs');
  check('model words unchanged', m.withModel('claude', 'claude', 'opus') === 'claude --model opus' && m.withModel('codex', 'codex', 'gpt-5.4') === 'codex -m gpt-5.4');
}
{
  const { stateInput } = await import('../server/assistanthook.mjs');
  const d = { session_id: 's1', cwd: '/tmp/x' };
  const ev = (state, extra = {}) => stateInput({ assistant: 'fake', event: 'Turn', state, data: d, ...extra });
  check('a state report as the board\'s event: working, needs you, idle, ended',
    ev('working').hook_event_name === 'UserPromptSubmit'
    && ev('needs_you', { need: { kind: 'permission', message: 'Run ls' } }).notification_type === 'permission_prompt' && ev('needs_you', { need: { kind: 'permission', message: 'Run ls' } }).message === 'Run ls'
    && ev('needs_you', { need: { kind: 'question' } }).notification_type === 'agent_needs_input'
    && ev('idle').hook_event_name === 'Stop' && stateInput({ assistant: 'fake', event: 'SessionStart', state: 'idle', data: d }).hook_event_name === 'SessionStart'
    && ev('ended').hook_event_name === 'SessionEnd' && ev(undefined) === null);
}

// ------------------------------------------------------------ a board with the stand-in
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(REPO, 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) {
  console.log(`SKIP  the board part: no ravenryd at ${BIN} (build it, or set RAVENRYD_BIN)`);
  process.exit(fails ? 1 : 0);
}
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : null;
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'assistants-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
const SBIN = path.join(T, 'bin');
for (const d of [MC, HOME, PROJ, SBIN, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Proj\n\nGoal: a test.\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
// The stand-in's command: writes what it was started with, then waits.
const RAN = path.join(T, 'stand-in-ran.txt');
fs.writeFileSync(path.join(SBIN, 'ravenry-stand-in'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${RAN}'\necho "stand-in agent for ravenry tests"\nexec sleep 600\n`, { mode: 0o755 });
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvas-'));
const RUN = path.join(D, 'run');
const PORT = 4792;
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const DENV = { HOME, PATH: `${SBIN}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let boardLog = '';
const env = {
  ...DENV, PATH: `${SBIN}:${process.env.PATH}`, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CLAUDE: '1', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  TEST_RAVENRY_ASSISTANT: 'fake',
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine(env), stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
let browser = null;
process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } });

const base = `http://localhost:${PORT}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const first = await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r.body : null; }, 20000);
check('the board answers', !!first, boardLog.slice(-800));
if (!first) process.exit(1);

// Listed by the hub, in the registry's order.
const list = first.assistants && first.assistants.list;
check('state: assistants.list is the registry, the stand-in third', Array.isArray(list) && list.map((a) => a.id).join() === 'claude,codex,fake' && list[2].name === 'Stand-in Agent' && list[2].short === 'Stand-in' && list[2].chip === 'Stand-in' && list[2].hooks === 'state' && list[2].test === true, JSON.stringify(list && list.map((a) => a.id)));
const sv = await get('/api/setup/start');
const sa = (sv.body.assistants || []).map((a) => `${a.kind}:${a.found}:${a.signedIn}`);
check('New session\'s answer lists it third, found and signed in (nothing to sign in to)', sa.length === 3 && sa[0].startsWith('claude:') && sa[1].startsWith('codex:') && sa[2] === 'fake:true:true' && sv.body.assistants[2].name === 'Stand-in Agent', sa.join());
check('New session\'s words name it', sv.body.words && sv.body.words.names && sv.body.words.names.fake === 'Stand-in Agent', JSON.stringify(sv.body.words && sv.body.words.names));
check('no Model menu for an assistant without one', sv.body.models && !('fake' in sv.body.models) && Array.isArray(sv.body.models.claude), JSON.stringify(Object.keys(sv.body.models || {})));
const as = await get('/api/settings/assistant');
check('Settings lists it', as.status === 200 && (as.body.list || []).map((a) => a.id).join() === 'claude,codex,fake');

// A project set to it: the next session starts its command.
const pa = await post('/api/project/assistant', { projectId: 'proj', assistant: 'fake' });
check('a project\'s "New sessions:" takes it', pa.status === 200, pa.text);
const p1 = await until(async () => (await get('/api/state')).body.projects.find((p) => p.id === 'proj' && p.assistantWants === 'fake'));
check('the project shows it as its assistant', !!p1);
const reg2 = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));
check('stored as its id, like claude and codex', reg2.projects[0].assistant === 'fake');
const st = await post('/api/sessions/start', { projectId: 'proj' });
check('start: the project\'s assistant, in a labelled pane', st.status === 200 && st.body.ok && st.body.pane && st.body.pane.labels['ravenry.session'] === 'fake' && st.body.pane.labels['ravenry.project'] === 'proj', st.text.slice(0, 400));
const ranLine = await until(async () => (fs.existsSync(RAN) ? fs.readFileSync(RAN, 'utf8').trim() : null), 15000);
check('it ran its command in the project\'s folder, with the brief to read', !!ranLine && ranLine.startsWith(`${fs.realpathSync(PROJ)}|`) || (ranLine || '').startsWith(`${PROJ}|`), ranLine);
check('with the brief prompt as its one word', /\|Read BRIEF\.md \(Hand-off section first\) and continue\./.test(ranLine || ''), ranLine);
const refused = await post('/api/sessions/start', { projectId: 'proj', assistant: 'nope' });
check('an assistant nobody registered is refused, naming the three', refused.status === 400 && refused.body.error === 'assistant is claude, codex or fake.', refused.text);

// Its hook events drive its state.
const PANE = st.body && st.body.pane ? st.body.pane.id : null;
const SOCK = fs.readdirSync(RUN).filter((n) => n.endsWith('.sock')).map((n) => path.join(RUN, n))[0];
const SID = '5a5a5a5a-0000-4000-8000-000000000001';
const hook = (state, extra = []) => spawnSync(BIN, ['hook', '--assistant', 'fake', '--state', state, '--event', 'Turn', ...extra], { input: JSON.stringify({ session_id: SID, cwd: PROJ }), env: { ...DENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: SOCK }, encoding: 'utf8' });
const session = async () => { const p = (await get('/api/state')).body.projects.find((x) => x.id === 'proj'); return p && p.sessions.find((s) => s.sessionId === SID); };
const groupIs = (g) => until(async () => { const s = await session(); return s && s.group === g ? s : null; }, 15000);
hook('idle', []);
const h0 = spawnSync(BIN, ['hook', '--assistant', 'fake', '--state', 'idle', '--event', 'SessionStart'], { input: JSON.stringify({ session_id: SID, cwd: PROJ }), env: { ...DENV, RAVENRY_PANE: PANE, RAVENRY_SOCKET: SOCK }, encoding: 'utf8' });
check('the hook exits 0 and prints nothing', h0.status === 0 && !h0.stdout, `${h0.status} ${h0.stdout} ${h0.stderr}`);
hook('working');
const w = await groupIs('work');
check('working: the session is Working, the stand-in\'s', !!w && w.assistant === 'fake', JSON.stringify(await session()));
hook('needs_you', ['--need', 'permission']);
const y = await groupIs('you');
check('needs_you: Needs you', !!y, JSON.stringify(await session()));
hook('idle');
const i = await until(async () => { const s = await session(); return s && s.state === 'handback' ? s : null; }, 15000);
check('idle: its turn ended and it hands back, as a Stop of Claude Code\'s does', !!i, JSON.stringify(await session()));
const sb = (await get('/api/state')).body.sidebar;
const row = sb && JSON.stringify(sb).includes('"assistant":"Stand-in"');
check('its tag is the registry\'s word', !!row, JSON.stringify(sb).slice(0, 400));
hook('ended');
const gone = await until(async () => { const s = await session(); return !s || s.state === 'none' ? true : null; }, 15000);
check('ended: the session is over', !!gone, JSON.stringify(await session()));

// ------------------------------------------------------------ the board page at phone width
let pw = null;
try { pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(ROOT, 'package.json'))('playwright'); } catch { pw = null; }
if (!pw) console.log('SKIP  the page: no Playwright');
else {
  browser = await pw.chromium.launch({ headless: true });
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + '/');
  await p.waitForSelector('[data-act="pn-new"]', { timeout: 20000 });
  await p.tap('[data-act="pn-new"]');
  await p.waitForSelector('.ps-newmenu', { timeout: 5000 });
  await p.tap('[data-act="pn-new-session"]');
  await p.waitForSelector('.ps-ac', { timeout: 10000 });
  const cards = await p.$$eval('.ps-ac', (xs) => xs.map((x) => `${x.dataset.psAsst}:${x.disabled ? 'off' : 'on'}:${x.innerText.replace(/\s+/g, ' ').trim()}`));
  check('New session at 390 px: a card per assistant the hub lists, the stand-in third', cards.length === 3 && cards[2] === 'fake:on:Stand-in Agent Signed in', cards.join(' | '));
  await p.tap('.ps-ac[data-ps-asst="fake"]');
  const go = await p.textContent('#ps-go');
  check('picked, Start names it', /^Start Stand-in Agent in /.test(go || ''), go);
  const noModel = await p.$('#ps-model');
  check('no Model menu for it', !noModel);
  if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await p.screenshot({ path: path.join(OUT, 'phone-new-session-stand-in.png') }); console.log(`picture: ${path.join(OUT, 'phone-new-session-stand-in.png')}`); }
  check('no page errors', !errs.length, errs.join(' | '));
  await browser.close();
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
