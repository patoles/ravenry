// OpenCode end to end (docs/ASSISTANTS.md, "OpenCode"; docs/FEATURES.md
// SESS-054): the real `opencode` in a real ravenryd pane under a scratch
// board, on one of OpenCode's free models, with a scratch HOME (OpenCode's
// config, Ravenry's plugin and its session files), a scratch project and
// a scratch Ravenry data folder. Nothing of the person's is read or written.
//
// Without a board: the registry's words for OpenCode, its screen reading on
// captured screens, the plugin's text. With the board: Set up writes the
// plugin (and the doctor's rows say so), New session lists OpenCode with
// its models (`opencode models`), a session starts with its model and first
// message, the turn reads Working then a permission prompt as Needs you,
// answered from the board (Allow once) through OpenCode's own API, the turn
// ends at rest with its model chip and context, Hand off now writes the
// hand-off and the fresh OpenCode session starts, and the first session
// resumes by its id in a new pane. Uninstall takes the plugin out.
//
// Skips cleanly (exit 0) when opencode or ravenryd is not on this machine.
// A model call goes to OpenCode's free model (OPENCODE_TEST_MODEL, else
// the first "-free" one it lists).
//
// The board page at 390 px (headless Chromium, the board's loopback page)
// shows New session with OpenCode picked and its Model menu, and the
// permission's Needs you card; with OUT, their pictures go there.
//
//   node tools/opencode-test.mjs [--keep] [OUT]
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
const oc = await import('../server/opencode.mjs');
{
  const a = reg.get('opencode');
  check('registered: OpenCode, last, with its own words', reg.IDS.join() === 'claude,codex,antigravity,opencode' && a && a.name === 'OpenCode' && a.hooks === 'opencode' && a.caps.resume && a.caps.model && a.caps.handoff && !a.caps.print, reg.IDS.join());
  check('its first message goes after --prompt, a dash one as --prompt=',
    JSON.stringify(reg.promptArgs('opencode', 'Read BRIEF.md')) === '["--prompt","Read BRIEF.md"]' && JSON.stringify(reg.promptArgs('opencode', '-x')) === '["--prompt=-x"]'
    && JSON.stringify(reg.promptArgs('claude', '-x')) === '["--","-x"]' && JSON.stringify(reg.promptArgs('codex', 'hi')) === '["hi"]');
  check('its session ids keep their case; a UUID is lower-cased', reg.sessionIdOf('ses_e00e9c388ffeKqQqwQI7njs4i5') === 'ses_e00e9c388ffeKqQqwQI7njs4i5' && reg.sessionIdOf('0F0F0F0F-0000-4000-8000-000000000001') === '0f0f0f0f-0000-4000-8000-000000000001' && reg.sessionIdOf('ses_bad id') === null && reg.sessionIdOf('ses_e00e9c388ffeKqQqwQI7njs4i5', 'claude') === null);
  check('resume and model words', JSON.stringify(reg.words('opencode', 'resume', 'ses_x')) === '["--session","ses_x"]' && JSON.stringify(reg.words('opencode', 'model', 'opencode/big-pickle')) === '["-m","opencode/big-pickle"]');
  const perm = ['', '  ┃', '  ┃  Run ls', '  ┃', '     $ ls -la', '', '  ┃', '  ┃  △ Permission required', '  ┃    # Shell command', '  ┃', '  ┃  $ ls -la', '  ┃', '  ┃', '  ┃   Allow once   Allow always   Reject                ctrl+f fullscreen  ⇆ select  enter confirm', '  ┃', ''].join('\n');
  const s = oc.parseScreen(perm);
  check('its permission prompt reads as a dialog with three options', s.claudeLive && s.dialog && s.dialog.options.map((o) => o.label).join('|') === 'Allow once|Allow always|Reject' && /ls -la/.test(s.dialog.question), JSON.stringify(s.dialog));
  const work = ['  ┃  Build · DeepSeek V4.1 Flash Free OpenCode', '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '   ⬝⬝⬝⬝■■  esc interrupt            8.3K (4%)  ctrl+p commands'].join('\n');
  const w = oc.parseScreen(work);
  check('a turn running reads as working, no dialog', w.claudeLive && w.working && !w.dialog);
  const idle = ['  ┃', '  ┃  Build · DeepSeek V4.1 Flash Free OpenCode', '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '   ~/proj                         8.4K (4%) ctrl+p', '                                  commands'].join('\n');
  const i = oc.parseScreen(idle);
  check('at rest: live, not working, nothing typed', i.claudeLive && !i.working && !i.dialog && i.draft === '');
  const shell = 'me@host proj % ls\nBRIEF.md\nme@host proj % ';
  check('a shell is not OpenCode', !oc.parseScreen(shell).claudeLive);
  const scr = await import('../server/screen.mjs');
  check('Claude Code\'s reading does not claim OpenCode\'s screens', !scr.parseScreen(perm).claudeLive && !scr.parseScreen(work).claudeLive && !scr.parseScreen(idle).claudeLive);
  const hk = await import('../server/hookinstall.mjs');
  const t = hk.opencodePluginText('/opt/x/ravenryd');
  check('the plugin names its ravenryd and is marked as Ravenry\'s', t.includes('const RAVENRYD = "/opt/x/ravenryd";') && t.split('\n')[0].includes(hk.OPENCODE_MARK));
}

// ------------------------------------------------------------ the board
const findOn = (bin) => { for (const d of String(process.env.PATH || '').split(':')) { const p = path.join(d, bin); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } } return null; };
const OC = process.env.OPENCODE_BIN || findOn('opencode') || [path.join(os.homedir(), '.opencode', 'bin', 'opencode')].find((p) => fs.existsSync(p));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(REPO, 'daemon', 'ravenryd'));
if (!OC) { console.log('SKIP  the board part: opencode is not installed here'); process.exit(fails ? 1 : 0); }
if (!fs.existsSync(BIN)) { console.log(`SKIP  the board part: no ravenryd at ${BIN}`); process.exit(fails ? 1 : 0); }
const KEEP = process.argv.includes('--keep');
const OUT = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ? path.resolve(process.argv.slice(2).filter((a) => !a.startsWith('--'))[0]) : null;
let pw = null;
try { pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(ROOT, 'package.json'))('playwright'); } catch { pw = null; }
let browser = null;
// The board page at phone width, dark.
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

const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'opencode-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
const OCHOME = path.join(HOME, '.config', 'opencode');
for (const d of [MC, HOME, PROJ, OCHOME, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
const NODE_DIR = path.dirname(process.execPath);
const OC_DIR = path.dirname(fs.realpathSync(OC)) === path.dirname(OC) ? path.dirname(OC) : path.dirname(OC);
const PATHS = [...new Set([OC_DIR, NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
// Its model: a free one.
const listed = spawnSync(OC, ['models'], { env: { HOME, PATH: PATHS, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8', timeout: 60000 }).stdout || '';
const free = oc.parseModels(listed).filter((m) => /-free$/.test(m));
const MODEL = process.env.OPENCODE_TEST_MODEL || (free.includes('opencode/deepseek-v4.1-flash-free') ? 'opencode/deepseek-v4.1-flash-free' : free[0]);
console.log(`opencode ${spawnSync(OC, ['--version'], { env: { HOME, PATH: PATHS }, encoding: 'utf8' }).stdout.trim()} at ${OC}, model ${MODEL}`);
if (!MODEL) { console.log('SKIP  the board part: OpenCode lists no free model'); process.exit(fails ? 1 : 0); }
// Its config: every shell command asks, so the turn shows a permission prompt.
fs.writeFileSync(path.join(OCHOME, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', permission: { bash: 'ask', edit: 'allow' } }, null, 2));
// The project: a git repo with a brief.
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Proj\n\nGoal: a scratch project for the OpenCode test.\n\n## Hand-off\n\n## Next step\n\n- Nothing yet\n');
fs.writeFileSync(path.join(PROJ, 'notes.txt'), 'one\ntwo\nthree\n');
const git = (...a) => execFileSync('git', a, { cwd: PROJ, env: { HOME, PATH: PATHS, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, stdio: 'ignore' });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'start');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, handoffAutoStart: true }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvoc-'));
const RUN = path.join(D, 'run');
const PORT = 4793;
const base = `http://localhost:${PORT}`;
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const DENV = { HOME, PATH: PATHS, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', OPENCODE_DISABLE_AUTOUPDATE: '1', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let boardLog = '';
const env = {
  ...DENV, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CLAUDE: '1', MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1',
  MC_OPENCODE: '1', MC_OPENCODE_HOME: OCHOME, MC_OPENCODE_BIN: OC,
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine(env), stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
const cleanup = () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } if (!KEEP && !fails) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ } } };
process.on('exit', cleanup);

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const state = async () => (await get('/api/state')).body;
const proj = async () => (await state()).projects.find((x) => x.id === 'proj');
const first = await until(async () => { const r = await get('/api/state'); return r.body && r.body.generatedAt ? r.body : null; }, 20000);
check('the board answers', !!first, boardLog.slice(-800));
if (!first) process.exit(1);
check('state lists OpenCode last', (first.assistants.list || []).map((a) => a.id).join() === 'claude,codex,antigravity,opencode');

// Set up: the plugin in OpenCode's plugins folder, and the doctor's row.
const PLUGIN = path.join(OCHOME, 'plugins', 'ravenry.js');
const su = await post('/api/setup/hooks', { ravenryd: BIN, only: 'opencode' });
check('Set up for OpenCode writes its plugin, and only that', su.status === 200 && fs.existsSync(PLUGIN) && su.body.claude === null && su.body.codex === null && fs.readFileSync(SETTINGS, 'utf8') === '{}', su.text);
const rows = (await get('/api/setup/hooks')).body.rows || [];
const orow = rows.find((r) => r.kind === 'opencode');
check('the doctor\'s rows: OpenCode on', !!orow && orow.on === true && orow.state === 'ok', JSON.stringify(rows));

// New session: OpenCode found, its models listed.
// (`opencode models` takes 15 s and more while OpenCode sets its plugins folder up.)
const sv = await until(async () => { const r = await get('/api/setup/start'); return r.body.models && (r.body.models.opencode || []).some((m) => m.id === MODEL) ? r.body : null; }, 150000, 1000);
const card = sv && (sv.assistants || []).find((a) => a.kind === 'opencode');
check('New session lists OpenCode, found, nothing to sign in to', !!card && card.found && card.signedIn && card.name === 'OpenCode', JSON.stringify(sv && sv.assistants));
check('its Model menu: the default, then `opencode models` (the free model among them)', !!sv && sv.models.opencode[0].id === '' && sv.models.opencode.some((m) => m.id === MODEL), JSON.stringify(sv && sv.models.opencode.slice(0, 6)));

// The Ravenry skill, in OpenCode's own skills folder; OpenCode lists it once,
// also with Claude Code's beside it (it reads ~/.claude/skills too).
{
  const sk = await post('/api/setup/skills', { kind: 'opencode', on: true, ravenryd: BIN, version: '0.0.0-test' });
  const row = sk.body && (sk.body.skills || []).find((r) => r.kind === 'opencode');
  check('the skill installs for OpenCode, in its folder', sk.status === 200 && fs.existsSync(path.join(OCHOME, 'skills', 'ravenry', 'SKILL.md')) && row && row.installed && row.ours, sk.text.slice(0, 400));
  const skills = () => spawnSync(OC, ['debug', 'skill'], { cwd: PROJ, env: { HOME, PATH: PATHS, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8', timeout: 60000 }).stdout || '';
  const one = skills();
  check('OpenCode lists it', /ravenry/.test(one), one.slice(0, 600));
  await post('/api/setup/skills', { kind: 'claude', on: true, ravenryd: BIN, version: '0.0.0-test' });
  const two = skills();
  const n = (two.match(/"name":\s*"ravenry"|^ravenry\b|\bname: ravenry\b/gm) || []).length;
  check('with Claude Code\'s too, OpenCode still lists one ravenry skill', fs.existsSync(path.join(HOME, '.claude', 'skills', 'ravenry', 'SKILL.md')) && n === 1, `${n}: ${two.slice(0, 800)}`);
  await post('/api/setup/skills', { kind: 'claude', on: false });
}

// The phone's New session: OpenCode's card, picked, its Model menu.
{
  const p = await phonePage();
  if (!p) console.log('SKIP  the page: no Playwright');
  else {
    await p.waitForSelector('[data-act="pn-new"]', { timeout: 20000 });
    await p.tap('[data-act="pn-new"]');
    await p.waitForSelector('.ps-newmenu', { timeout: 5000 });
    await p.tap('[data-act="pn-new-session"]');
    await p.waitForSelector('.ps-ac[data-ps-asst="opencode"]', { timeout: 10000 });
    await p.tap('.ps-ac[data-ps-asst="opencode"]');
    await sleep(300);
    const go = await p.textContent('#ps-go');
    const opts = await p.$$eval('#ps-model option', (xs) => xs.map((x) => x.value));
    check('phone, 390 px: OpenCode\'s card picked, Start names it, its Model menu lists the free model', /^Start OpenCode in /.test(go || '') && opts[0] === '' && opts.includes(MODEL), `${go} ${opts.slice(0, 5)}`);
    const look = await p.$eval('.ps-ac[data-ps-asst="opencode"]', (x) => { const cs = getComputedStyle(x); return { tap: cs.webkitTapHighlightColor, radius: cs.borderTopLeftRadius, ring: cs.boxShadow }; });
    check('its card when picked: the outline the others use, round corners, no tap fill', look.tap === 'rgba(0, 0, 0, 0)' && look.radius === '10px' && /2px/.test(look.ring), JSON.stringify(look));
    await shot(p, 'phone-new-session-opencode.png');
    check('no page errors', !p.errs.length, p.errs.join(' | '));
    await p.context().close();
  }
}

// A session: its model and first message.
const PROMPT = 'Use your bash tool to run exactly this command: wc -l notes.txt. Then reply with one short sentence saying how many lines it has.';
const st = await post('/api/sessions/start', { projectId: 'proj', assistant: 'opencode', model: MODEL, text: PROMPT, cols: 120, rows: 40 });
check('start: OpenCode in a labelled pane, with -m and --prompt', st.status === 200 && st.body.pane && st.body.pane.labels['ravenry.session'] === 'opencode' && st.body.command.includes(`-m ${MODEL}`) && st.body.command.includes('--prompt'), st.text.slice(0, 600));
const SURF = st.body && st.body.surfaceId;
const sess = async () => { const p = await proj(); return p && p.sessions.find((s) => s.surfaceId === SURF); };
const w1 = await until(async () => { const s = await sess(); return s && s.sessionId && /^ses_/.test(s.sessionId) && (s.state === 'working' || s.dialog) ? s : null; }, 90000, 300);
check('its plugin reports the session: an OpenCode session id, Working (or already asking)', !!w1 && w1.assistant === 'opencode', JSON.stringify(await sess()));
const SID = w1 && w1.sessionId;
const asking = await until(async () => { const p = await proj(); const s = p && p.sessions.find((x) => x.surfaceId === SURF); return s && s.dialog && p.quick && p.quick.length === 3 ? p : null; }, 120000, 400);
check('the permission prompt is Needs you, with its three answers', !!asking && asking.quick.map((q) => q.label).join('|') === 'Allow once|Allow always|Reject' && /wc -l notes.txt/.test(asking.headline || ''), JSON.stringify(asking && { quick: asking.quick, headline: asking.headline, line: asking.line }));
// The phone's board: the permission as Needs you, with its three answers.
{
  const p = await phonePage();
  if (p) {
    await p.waitForSelector('text=Allow once', { timeout: 20000 }).catch(() => null);
    const txt = await p.evaluate(() => document.body.innerText);
    check('phone, 390 px: Needs you shows the permission and its answers', /Allow once/.test(txt) && /Allow always/.test(txt) && /Reject/.test(txt), txt.slice(0, 600));
    await shot(p, 'phone-board-opencode-permission.png');
    await p.context().close();
  }
}
const evFile = path.join(MC, 'events', `${SID}.jsonl`);
const ans = await post('/api/send', { projectId: 'proj', surfaceId: SURF, choice: 1 });
check('answered from the board: Allow once, through the plugin (no key pressed)', ans.status === 200 && ans.body.sent === 'Allow once', ans.text);
const done = await until(async () => { const s = await sess(); return s && !s.dialog && s.state !== 'working' && s.ctx ? s : null; }, 120000, 500);
check('the turn ends at rest', !!done && ['handback', 'asked', 'idle'].includes(done.state), JSON.stringify(done || (await sess())));
check('its model chip: the model it ran', !!done && done.model === MODEL && done.modelName === MODEL.split('/').pop() && done.modelShort === 'OpenCode', JSON.stringify(done && { model: done.model, name: done.modelName, short: done.modelShort }));
check('its context: tokens of the model\'s own window', !!done && done.ctx && done.ctx.tokens > 0 && done.ctx.window > 0 && done.ctx.window !== 1000000 && done.ctx.pct > 0, JSON.stringify(done && done.ctx));
const sf = path.join(HOME, '.local', 'state', 'ravenry', 'opencode', `${SID}.json`);
const sj = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : null;
check('its last turn: the answer, in its session file', !!sj && /\b3\b|three/i.test(sj.lastText || ''), JSON.stringify(sj && sj.lastText));
check('the shell command really ran', !!sj && sj.lastTool && sj.lastTool.name === 'bash', JSON.stringify(sj && sj.lastTool));
check('the answer went through OpenCode\'s permission.reply', !!sj && sj.lastAnswer && sj.lastAnswer.route === 'permission.reply' && sj.lastAnswer.reply === 'once', JSON.stringify(sj && sj.lastAnswer));
void evFile;

// Hand off now: the hand-off is written, and a fresh OpenCode session opens.
const ho = await post('/api/handoff', { projectId: 'proj', surfaceId: SURF });
check('Hand off now is taken', ho.status === 200, ho.text);
// Its commit asks for the shell: every prompt is answered from the board.
const handed = await until(async () => {
  const p = await proj();
  const s = p && p.sessions.find((x) => x.surfaceId === SURF);
  if (s && s.dialog && p.quick && p.quick.length === 3) await post('/api/send', { projectId: 'proj', surfaceId: SURF, choice: 2 });
  const m = path.join(MC, 'handoffs', `${SID}.json`);
  const mk = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : null;
  return mk && ['written', 'resumed'].includes(mk.state) ? mk : null;
}, 300000, 1500);
check('the hand-off is written in the brief', !!handed && /## Hand-off\n\n- \d{4}-\d{2}-\d{2}/.test(fs.readFileSync(path.join(PROJ, 'BRIEF.md'), 'utf8')), JSON.stringify(handed) + ' ' + fs.readFileSync(path.join(PROJ, 'BRIEF.md'), 'utf8').slice(0, 600));
const fresh = await until(async () => {
  const p = await proj();
  return p && p.sessions.find((x) => x.surfaceId !== SURF && x.assistant === 'opencode' && x.sessionId && x.sessionId !== SID);
}, 120000, 1000);
check('the fresh session is OpenCode, in a new pane, reading the hand-off', !!fresh, JSON.stringify((await proj()).sessions.map((s) => ({ s: s.surfaceId, id: s.sessionId, a: s.assistant, st: s.state }))));

// Resume: the first session, by its id, in a new pane.
const paneOf = SURF ? SURF.replace(/^ravenry:/, '') : null;
const SOCK = fs.readdirSync(RUN).filter((n) => n.endsWith('.sock')).map((n) => path.join(RUN, n))[0];
spawnSync(BIN, ['close', '--socket', SOCK, paneOf], { env: DENV, encoding: 'utf8' });
await until(async () => { const s = await sess(); return !s || s.state === 'none'; }, 30000, 500);
const rs = await post('/api/sessions/resume', { projectId: 'proj', sessionId: SID, cols: 120, rows: 40 });
check('Continue: OpenCode --session <its id>, in a new pane', rs.status === 200 && rs.body.command && rs.body.command.includes(`--session ${SID}`) && rs.body.surfaceId !== SURF, rs.text);
const back = await until(async () => { const p = await proj(); return p && p.sessions.find((x) => x.sessionId === SID && x.surfaceId === rs.body.surfaceId); }, 90000, 500);
check('the resumed session is the same one, in its new pane', !!back, JSON.stringify((await proj()).sessions.map((s) => ({ s: s.surfaceId, id: s.sessionId }))));

// Uninstall: the plugin goes, nothing else.
const un = await post('/api/setup/hooks', { remove: true, only: 'opencode' });
check('removing takes the plugin out', un.status === 200 && !fs.existsSync(PLUGIN) && fs.existsSync(path.join(OCHOME, 'opencode.json')), un.text);

if (browser) await browser.close();
if (fails) console.log(`\nkept for a look: ${T}\n--- board log (end) ---\n${boardLog.slice(-3000)}`);
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
