// A throwaway HOME as a person who uses the npm board (ravenry-app 0.4.0)
// has it: the package installed from npm, `ravenry setup --yes` run (its
// hooks in Claude Code's and Codex's settings), the board running on a test
// port, and through its own API a project, sessions (its events hook, fed
// the way Claude Code feeds it), ideas with a picture, a plan in the brief,
// a rule taken from Claude's memory, a hand-off setting and a note. With
// `login: true` the board starts at login too: the LaunchAgent the npm
// board's tools/install-login.mjs writes (taken from its dry run, so no
// launchd command runs) is in HOME/Library/LaunchAgents and the board is
// started by tools/fake-launchctl.mjs, as launchd would.
//
// Never the real ~/.ravenry, ~/.claude, ~/.codex, LaunchAgents or :4600:
// every folder is under `root` (a test root: tools/test-env.mjs), and the
// port is a spare one.
import { guardSpawns, isTestPath } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
export const NPM_VERSION = '0.4.0';
// The login label the npm board 0.4.0's install-login writes (tools/audit.mjs
// allows it here only; never an id of the app's).
export const NPM_LOGIN_LABEL = 'gg.ravenry.board';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sparePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/** ravenry-app@0.4.0 from npm, installed once into `dir`. Returns the package's folder. */
export function installNpmBoard(dir) {
  const pkg = path.join(dir, 'node_modules', 'ravenry-app');
  try { if (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version === NPM_VERSION) return pkg; } catch { /* install */ }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}\n');
  execFileSync('npm', ['install', `ravenry-app@${NPM_VERSION}`, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, stdio: 'ignore', env: { ...process.env, npm_config_cache: path.join(dir, '.npm-cache') } });
  // install-login.mjs is in the npm board's repository, not its package:
  // the copy in hub/tools is the same script but for the label the app
  // renamed (dev.ravenry.board), so the npm one's label is put back.
  const src = fs.readFileSync(path.join(REPO, 'hub', 'tools', 'install-login.mjs'), 'utf8');
  fs.mkdirSync(path.join(pkg, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'tools', 'install-login.mjs'), src.replace("const LABEL = 'dev.ravenry.board'", `const LABEL = '${NPM_LOGIN_LABEL}'`));
  return pkg;
}

/**
 * The environment every Ravenry process of the test gets: the throwaway
 * HOME and data folder, a plain PATH with this Node first, and stand-ins
 * for every app on the screen (cmux, iTerm2, Rex, notifications, Finder).
 */
export function testEnv(home, port, more = {}) {
  return {
    PATH: `${path.join(home, '.local', 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, LANG: 'en_US.UTF-8',
    RAVENRY_HOME: path.join(home, '.ravenry'),
    PORT: String(port),
    RAVENRY_TERMINAL: 'iterm', MC_APPS: 'none',
    CMUX_BIN: '/usr/bin/false', ITERM_OSASCRIPT_BIN: '/usr/bin/false', RAVENRY_REX_BIN: 'none',
    MC_OSASCRIPT_BIN: '/usr/bin/true', MC_OPEN_COMMAND: '["/usr/bin/true"]', RAVENRY_OPEN_BIN: '/usr/bin/true', RAVENRY_NO_OPEN: '1',
    MC_CODEX: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    // ps and lsof stand-ins: a test board never lists this Mac's own processes.
    MC_PS_BIN: path.join(REPO, 'hub', 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(REPO, 'hub', 'tools', 'stub-ps.mjs'),
    MC_PLAN_COMMAND: JSON.stringify([process.execPath, path.join(REPO, 'hub', 'tools', 'stub-plan-claude.mjs')]),
    ...more,
  };
}

async function waitUp(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url + '/api/state', { signal: AbortSignal.timeout(1500) }); if (r.ok) { const j = await r.json(); if (j && 'projects' in j) return j; } } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error(`${url} did not answer`);
}

export async function api(url, method, p, body, headers = {}) {
  const res = await fetch(url + p, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1', ...headers }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
  return j;
}

/** Starts the npm board as its owner does (`ravenry --no-open`), in the background. */
export function startNpmBoard(pkg, env, log) {
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(pkg, 'bin', 'ravenry.mjs'), '--no-open'], { env, cwd: env.HOME, stdio: ['ignore', out, out], detached: true });
  child.unref();
  return child;
}

// One Claude Code event through the npm board's own hook command, read
// from the settings file as Claude Code would run it.
export function hookEvent(home, env, ev, payload) {
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const cmds = (settings.hooks[ev] || []).flatMap((e) => e.hooks || []).map((h) => h.command).filter((c) => /hooks\/events\.mjs/.test(c));
  for (const c of cmds) {
    const r = spawnSync('/bin/sh', ['-c', c], { input: JSON.stringify({ hook_event_name: ev, ...payload }), env, timeout: 5000 });
    if (r.status !== 0) throw new Error(`hook ${c}: ${r.status} ${r.stderr}`);
  }
  return cmds.length;
}

/**
 * Makes the person's Mac in `root`: { home, pkg, port, url, env, board,
 * project, ideas, plan, rule }. `login`: the board starts at login, through
 * fake-launchctl.mjs (whose state folder is root/launchd).
 */
export async function makeNpmUser(root, { pkgDir, login = false, port: wantPort = null, log = () => {} } = {}) {
  if (!isTestPath(root)) throw new Error(`not a test folder: ${root}`);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = wantPort || (await sparePort());
  if (port === 4600) throw new Error('refusing :4600');
  const pkg = installNpmBoard(pkgDir || path.join(root, 'npm'));
  const launchd = path.join(root, 'launchd');
  const env = testEnv(home, port, { RAVENRY_LAUNCHCTL: path.join(HERE, 'fake-launchctl.mjs'), RAVENRY_FAKE_LAUNCHD: launchd });

  // What a Mac with Claude Code and Codex has before Ravenry: a settings
  // file with a hook of the person's own, which must stay, a project, and a
  // rule in Claude's memory for that project.
  const proj = path.join(home, 'code', 'weather-api');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# weather-api\n');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# weather-api\n\n- Use the metric system.\n');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine', timeout: 3 }] }] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Global\n\n- Short answers.\n');
  const mem = path.join(home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9-]/g, '-'), 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'feedback_pictures.md'), '---\nname: pictures-first\ndescription: Show a picture before building anything visual\ntype: feedback\n---\nShow a picture first.\n');
  // Claude Code (a stand-in: no account, no quota) and Codex.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'stand-in-claude.sh'), path.join(home, '.local', 'bin', 'claude'));
  fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');

  // ravenry setup --yes: the hooks in both settings files, setup.json.
  const setup = spawnSync(process.execPath, [path.join(pkg, 'bin', 'ravenry.mjs'), 'setup', '--yes'], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
  if (setup.status !== 0) throw new Error(`ravenry setup: ${setup.status}\n${setup.stdout}\n${setup.stderr}`);
  log('npm: ravenry setup --yes done');

  // The board: at login (launchd starts it), or by hand.
  const logDir = path.join(home, '.ravenry', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  let board = null;
  // What launchd's jobs get besides the plist's own variables: this test's
  // HOME, port and stand-ins (launchd would give the real HOME).
  fs.mkdirSync(launchd, { recursive: true });
  fs.writeFileSync(path.join(launchd, 'env.json'), JSON.stringify(env));
  if (login) {
    // install-login's dry run prints the LaunchAgent it would write; the
    // fixture writes that file, then "launchd" loads it.
    const dry = spawnSync(process.execPath, [path.join(pkg, 'tools', 'install-login.mjs'), '--dry-run'], { env: { ...env, MC_LAUNCHD_DRYRUN: '1' }, cwd: home, encoding: 'utf8' });
    const m = /(<\?xml[\s\S]*?<\/plist>\n)/.exec(dry.stdout || '');
    if (!m) throw new Error(`install-login dry run: ${dry.stdout}${dry.stderr}`);
    const plist = path.join(home, 'Library', 'LaunchAgents', `${NPM_LOGIN_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, m[1], { mode: 0o600 });
    const r = spawnSync(process.execPath, [path.join(HERE, 'fake-launchctl.mjs'), 'bootstrap', `gui/${process.getuid()}`, plist], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fake launchctl bootstrap: ${r.stdout}${r.stderr}`);
  } else {
    board = startNpmBoard(pkg, env, path.join(logDir, 'board.out.log'));
  }
  const url = `http://127.0.0.1:${port}`;
  await waitUp(url);
  log(`npm: the board answers on ${url}${login ? ' (started at login)' : ''}`);

  // A project in the existing folder (the iTerm2 tab it would open is a
  // stand-in, so it is made with "partial").
  const np = await api(url, 'POST', '/api/project/new', { name: 'weather-api', existingFolder: proj, goal: 'A small weather API with a daily forecast.', kind: 'code' });
  const projectId = np.id;
  // Two sessions, as Claude Code runs the hooks: one working, one ended.
  const transcript = path.join(home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9-]/g, '-'), 'sess-one-aaaaaa.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add the forecast endpoint' }, timestamp: new Date().toISOString() }) + '\n');
  const sessions = ['sess-one-aaaaaa', 'sess-two-bbbbbb'];
  for (const sid of sessions) {
    hookEvent(home, env, 'SessionStart', { session_id: sid, cwd: proj, transcript_path: transcript, source: 'startup' });
    hookEvent(home, env, 'UserPromptSubmit', { session_id: sid, cwd: proj, transcript_path: transcript, prompt: 'Add the forecast endpoint' });
  }
  hookEvent(home, env, 'Stop', { session_id: sessions[1], cwd: proj, transcript_path: transcript, last_assistant_message: 'Done. The endpoint is in.' });
  hookEvent(home, env, 'SessionEnd', { session_id: sessions[1], cwd: proj, transcript_path: transcript, reason: 'exit' });
  // Ideas: three, one with a picture, one archived.
  const ideas = [];
  for (const [name, pitch] of [['Rain alerts', 'Push a note when rain starts within the hour.'], ['Wind map', 'A map of the wind for sailors.'], ['Pollen count', 'Daily pollen levels by city.']]) {
    ideas.push({ id: (await api(url, 'POST', '/api/ideas/add', { name, pitch })).id, name });
  }
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2c8f1a10000000049454e44ae426082', 'hex');
  await api(url, 'POST', `/api/ideas/${ideas[0].id}/image`, png, { 'Content-Type': 'image/png', 'X-Filename': 'rain.png' });
  await api(url, 'POST', `/api/ideas/${ideas[2].id}/kill`, {});
  // A plan, written into the brief (it cannot reach a session here, which
  // the board says after writing it).
  await api(url, 'POST', '/api/plan/own', { projectId, text: 'Research long notes, show me a picture, then build the trail.' });
  const settled = async () => {
    for (let i = 0; i < 200; i++) { const d = (await api(url, 'GET', `/api/plan/draft?projectId=${projectId}`)).draft; if (d && !d.busy && d.steps && d.steps.length) return d; await sleep(100); }
    throw new Error('the plan draft never settled');
  };
  for (const q of (await settled()).questions || []) {
    if (q.answer != null) continue;
    await api(url, 'POST', '/api/plan/edit', { projectId, answer: { id: q.id, option: q.options[0] } });
    await settled();
  }
  const started = await fetch(url + '/api/plan/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ projectId }) }).then((r) => r.json());
  const planTitle = started.title || started.written;
  if (!planTitle) throw new Error(`the plan was not written: ${JSON.stringify(started)}`);
  // A rule from Claude's memory, made a rule of every project.
  const rules = await api(url, 'GET', '/api/rules?fresh=1');
  const rule = (rules.rules || []).find((r) => r.id === 'feedback_pictures');
  if (!rule) throw new Error(`no rule to take: ${JSON.stringify(rules)}`);
  await api(url, 'POST', '/api/rules/feedback_pictures', { action: 'global' });
  // A setting and a note in the brief.
  await api(url, 'POST', '/api/settings/handoff', { handoffThreshold: 55 });
  await api(url, 'POST', '/api/note', { projectId, text: 'Ask about the rate limit.' });
  // Let the board settle (its first tick writes what it writes).
  await sleep(2500);
  log(`npm: made a project, ${sessions.length} sessions, ${ideas.length} ideas, the plan "${planTitle}", a rule and settings`);
  return { home, pkg, port, url, env, board, launchd, projectId, project: proj, sessions, ideas, planTitle, rule: rule.id };
}

/** Stops a board started by hand (its pid from board.json). */
export function stopBoard(home) {
  try { const b = JSON.parse(fs.readFileSync(path.join(home, '.ravenry', 'board.json'), 'utf8')); process.kill(b.pid, 'SIGTERM'); } catch { /* none */ }
}
