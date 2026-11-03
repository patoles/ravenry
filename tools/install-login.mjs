#!/usr/bin/env node
// Start the board at login: writes a LaunchAgent and loads it.
//
//   node tools/install-login.mjs            install (or reinstall) and start
//   node tools/install-login.mjs --remove   stop it and delete the LaunchAgent
//   MC_LAUNCHD_DRYRUN=1 node tools/install-login.mjs [--remove]
//                                           print the plist and the commands only
//
// launchd starts jobs with a bare PATH, and the board runs cmux, git and
// claude, so the plist carries a PATH resolved here, at install time.
// MC_CMUX_SOCKET_PASSWORD=<pw> writes CMUX_SOCKET_PASSWORD into the job, for
// when cmux's socket is in password mode (see docs/DEVELOPING.md, "Run at login").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'gg.ravenry.board';
// The job's label from before the rename (the board was Mission Control):
// install and --remove take it away too, so two jobs never fight over :4600.
const OLD_LABEL = 'gg.missioncontrol.board';
const PORT = 4600;
const URL_ = `http://localhost:${PORT}`;
const CMUX_BIN_DIR = '/Applications/cmux.app/Contents/Resources/bin';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const OLD_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${OLD_LABEL}.plist`);
const LOG_DIR = path.join(HOME, '.ravenry', 'logs');
const UID = process.getuid();
const DOMAIN = `gui/${UID}`;
const DRY = process.env.MC_LAUNCHD_DRYRUN === '1' || process.argv.includes('--dry-run');
const REMOVE = process.argv.includes('--remove');

function say(s) { console.log(s); }
function fail(s) { console.error('install-login: ' + s); process.exit(1); }

// The server entry from package.json "start" ("node server/index.mjs").
function entry() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const start = (pkg.scripts && pkg.scripts.start) || '';
  const file = start.split(/\s+/).find((t) => /\.m?js$/.test(t));
  if (!file) fail(`cannot find the server file in package.json "start": ${start}`);
  const abs = path.resolve(REPO, file);
  if (!fs.existsSync(abs)) fail(`${abs} does not exist`);
  return abs;
}

// The folder `claude` lives in. Inside cmux, `which claude` first finds a
// per-session shim under the temp folder, which is gone after a restart, so
// those are skipped. The folder on PATH is kept (not the versioned target the
// symlink points at), so an update of claude does not break the job.
function claudeDir() {
  const tmp = fs.realpathSync(os.tmpdir());
  let found = [];
  try { found = execFileSync('/usr/bin/which', ['-a', 'claude'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
  found.push(path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'));
  for (const f of found) {
    if (f.includes('/cmux-cli-shims/')) continue;
    let real = f;
    try { real = fs.realpathSync(f); } catch { continue; }
    if (real.startsWith(tmp) || f.startsWith(os.tmpdir())) continue;
    return path.dirname(f);
  }
  return null;
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plistText({ node, server, envPath, password }) {
  const env = { PATH: envPath };
  if (password) env.CMUX_SOCKET_PASSWORD = password;
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(server)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(LOG_DIR, 'board.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(LOG_DIR, 'board.err.log'))}</string>
</dict>
</plist>
`;
}

function launchctl(args, { quiet = false } = {}) {
  if (DRY) { say('  [dry run] launchctl ' + args.join(' ')); return { status: 0, out: '' }; }
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!quiet && r.status !== 0) console.error((r.stderr || r.stdout || '').trim());
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function loaded(label = LABEL) {
  return spawnSync('/bin/launchctl', ['print', `${DOMAIN}/${label}`], { encoding: 'utf8' }).status === 0;
}

// Unloads and deletes the pre-rename job, when there is one.
function removeOldJob() {
  const isLoaded = loaded(OLD_LABEL);
  if (!isLoaded && !fs.existsSync(OLD_PLIST)) return;
  say(`Removing the job from before the rename, ${OLD_LABEL}.`);
  if (isLoaded) launchctl(['bootout', `${DOMAIN}/${OLD_LABEL}`], { quiet: true });
  if (DRY) say(`  [dry run] rm ${OLD_PLIST}`);
  else if (fs.existsSync(OLD_PLIST)) fs.unlinkSync(OLD_PLIST);
}

// Who listens on the port, with command line and working folder.
function listeners() {
  let pids = [];
  try { pids = execFileSync('/usr/sbin/lsof', ['-tiTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch {}
  return pids.map((pid) => {
    let command = '', cwd = '';
    try { command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
    try { cwd = (execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n')) || '').slice(1); } catch {}
    return { pid, command, cwd };
  });
}

// This board: its command line names the repo, or it is the relative
// `node server/index.mjs` that `npm start` runs from inside the repo.
function isThisBoard(l, server) {
  if (l.command.includes(REPO)) return true;
  const rel = path.relative(REPO, server);
  return l.cwd === REPO && l.command.includes(rel);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopStrayBoard(server) {
  const ls = listeners();
  if (!ls.length) { say(`Nothing listens on :${PORT}.`); return; }
  for (const l of ls) {
    if (!isThisBoard(l, server)) fail(`:${PORT} is held by pid ${l.pid} (${l.command}, in ${l.cwd || '?'}), which is not this board. Stop it yourself, then run this again.`);
  }
  for (const l of ls) {
    say(`Stopping the board already on :${PORT} (pid ${l.pid}: ${l.command}) so launchd can take the port.`);
    if (DRY) { say(`  [dry run] kill -TERM ${l.pid}`); continue; }
    try { process.kill(l.pid, 'SIGTERM'); } catch {}
  }
  if (DRY) return;
  for (let i = 0; i < 50 && listeners().length; i++) await sleep(100);
  for (const l of listeners()) { try { process.kill(l.pid, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 20 && listeners().length; i++) await sleep(100);
  if (listeners().length) fail(`:${PORT} is still taken after stopping the board.`);
}

async function get(p) {
  try {
    const r = await fetch(URL_ + p, { signal: AbortSignal.timeout(1500) });
    return { status: r.status, body: await r.text() };
  } catch { return { status: 0, body: '' }; }
}

async function waitUp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if ((await get('/')).status === 200) return true;
    await sleep(300);
  }
  return false;
}

async function remove() {
  say(`Removing ${LABEL}.`);
  if (DRY || loaded()) launchctl(['bootout', `${DOMAIN}/${LABEL}`]);
  if (DRY) say(`  [dry run] rm ${PLIST}`);
  else if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  removeOldJob();
  say(`Done. The board no longer starts at login; start it by hand with: cd ${REPO} && npm start`);
}

async function install() {
  const node = process.execPath;
  const server = entry();
  const cDir = claudeDir();
  const dirs = [path.dirname(node), cDir, CMUX_BIN_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean);
  const envPath = [...new Set(dirs)].join(':');
  const text = plistText({ node, server, envPath, password: process.env.MC_CMUX_SOCKET_PASSWORD || '' });

  if (!cDir) say('Warning: no claude found outside the cmux shim folder; the board will not find claude.');
  if (!fs.existsSync(path.join(CMUX_BIN_DIR, 'cmux'))) say(`Warning: ${CMUX_BIN_DIR}/cmux not found.`);

  if (DRY) {
    say(`[dry run] would write ${PLIST}:\n`);
    process.stdout.write(text);
    say('');
    say(`  [dry run] mkdir -p ${LOG_DIR}`);
  }

  // A job already loaded holds the port: unload it first.
  removeOldJob();
  if (DRY || loaded()) launchctl(['bootout', `${DOMAIN}/${LABEL}`], { quiet: true });
  if (!DRY) {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(PLIST, text, { mode: 0o600 });
    for (let i = 0; i < 30 && loaded(); i++) await sleep(100);
  }
  await stopStrayBoard(server);

  let r = launchctl(['bootstrap', DOMAIN, PLIST]);
  if (r.status !== 0 && !DRY) {
    say('bootstrap failed; trying unload + load.');
    launchctl(['unload', PLIST], { quiet: true });
    r = launchctl(['load', '-w', PLIST]);
    if (r.status !== 0) fail(`launchd would not load ${PLIST}. See: launchctl print ${DOMAIN}/${LABEL}`);
  }
  if (DRY) { say(`  [dry run] wait up to 10 s for ${URL_} to answer 200`); return; }

  if (!(await waitUp())) {
    fail(`${URL_} did not answer 200 within 10 s. Logs: ${path.join(LOG_DIR, 'board.err.log')}`);
  }
  say(`OK: ${URL_} answers 200, started by launchd (${LABEL}). It starts at every login and restarts if it crashes.`);

  // launchd's process is not a cmux child; make sure cmux still lets the board in.
  let state = null;
  for (let i = 0; i < 20 && !state; i++) {
    const s = await get('/api/state');
    try { const j = JSON.parse(s.body); if (j.generatedAt) state = j; } catch {}
    if (!state) await sleep(500);
  }
  if (!state) say('Note: could not read /api/state yet; open the board to check it lists your sessions.');
  else if (state.cmuxOk) say(`cmux: OK, the board sees ${state.projects.length} projects.`);
  else {
    say(`cmux: REFUSED (${state.error || 'no detail'}).`);
    say("cmux's socket is in \"cmux processes only\" mode, and a launchd job is not a cmux process.");
    say('Fix: cmux Settings > Automation, set socket access to Password, then rerun with');
    say(`  MC_CMUX_SOCKET_PASSWORD='<that password>' node ${path.join(REPO, 'tools', 'install-login.mjs')}`);
    say('or remove the login item (--remove) and keep starting the board with npm start inside cmux.');
  }
  say(`Logs: ${LOG_DIR}/board.out.log, board.err.log. Remove: node ${path.join(REPO, 'tools', 'install-login.mjs')} --remove`);
}

(REMOVE ? remove() : install()).catch((e) => fail(e.stack || e.message));
