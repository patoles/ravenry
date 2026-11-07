// The switch from the npm board (`ravenry` from npm, ravenry-app 0.4.x) to
// the desktop app's hub, on the same data and port, and the way back. The
// desktop app runs it as Node from its own copy of the hub
// (apps/desktop/src/main/npmswitch.ts), and starts or stops its hub service
// itself around it:
//
//   node server/npmswitch.mjs detect [--app-data DIR]
//   node server/npmswitch.mjs switch --ravenryd BIN [--app-data DIR]
//   node server/npmswitch.mjs back
//
// Each prints one JSON object. --app-data is the app's data folder, whose
// versions/ hold the app's own hubs (never taken for the npm board).
//
// Why the app's hub never runs beside the npm board on the same data: both
// read, change and rewrite the same JSON files (projects.json, phone.json,
// rules.json, alerts.json) with no lock, so one loses what the other wrote,
// and the app's one-time move of ideas.json to pages/ideas/ leaves the npm
// board writing a file nothing reads any more. 0.4.0 is shipped and cannot
// learn to share, so the app's hub starts on the data only once the npm
// board is stopped (and server/ideasfiles.mjs migrate waits while another
// board's board.json names a live process).
//
// detect: what of the npm board is on this Mac, read only:
//   - a board serving this data: the live process this data's board.json
//     names, listening on its port and answering /api/state, a copy of
//     Ravenry outside the app's versions/ (never a port alone: findBoard)
//   - a login start: a LaunchAgent in ~/Library/LaunchAgents with one of
//     LOGIN_LABELS (the npm board's install-login, its name before the
//     rename, and the label this repository's install-login uses), or any
//     other that runs a copy of Ravenry's board
//   - its hooks: Claude Code's and Codex's entries that run hooks/*.mjs of
//     a copy of Ravenry outside the app's versions/
//
// switch: once the person agreed. Each step is recorded in
// <data>/switch.json before the next, so a stop half way can be undone:
//   1. each login start booted out of launchd, and its plist moved into
//      <data>/backups/switch-<when>/LaunchAgents/
//   2. the board stopped (SIGTERM; it removes its board.json and exits)
//   3. a copy of the data (every file but backups/, logs/ and the iTerm2
//      helper's Python) and of the hook settings into that backup, taken
//      once nothing writes the data any more
//   4. the hooks moved to the app's copy with `ravenryd hook` beside them
//      (hookinstall.mjs setupWithRavenryd: our entries only, each file
//      backed up next to itself)
// The app then starts its hub service on the same port; that hub runs its
// one-time moves (each backed up and safe to run twice) on start.
//
// back: once the app's hub is stopped (the app stops its service first):
//   1. ideas.json written again from pages/ideas/ (ideasfiles moveBack)
//   2. the hooks put back to the npm copy's exact commands (no ravenryd)
//   3. each login start's plist put back and loaded again, which starts the
//      board; a board run by hand is left for the person to start as before

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RAVENRY_HOME } from './home.mjs';
import * as hk from './hookinstall.mjs';
import * as cx from './codexhooks.mjs';
import * as ideasfiles from './ideasfiles.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The npm board's own labels, detected so the app can switch from it;
// never an id of the app's (tools/audit.mjs allows them here only).
export const LOGIN_LABELS = ['gg.ravenry.board', 'gg.missioncontrol.board', 'dev.ravenry.board'];
export const APP_SERVICE = 'dev.ravenry.hub';
export const RECORD = () => path.join(RAVENRY_HOME, 'switch.json');
const LAUNCHCTL = () => process.env.RAVENRY_LAUNCHCTL || '/bin/launchctl';
const UID = () => (process.getuid ? process.getuid() : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, dir) => { const r = path.relative(dir, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
export const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function run(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ------------------------------------------------------------ copies of Ravenry

/** The copy of Ravenry a file belongs to: { root, name, version }, from the
 * nearest package.json named ravenry-app (or mission-control), or null. */
export function copyOf(file) {
  if (!file || !path.isAbsolute(file)) return null;
  let dir = path.dirname(realOr(file));
  for (let i = 0; i < 4; i++) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && (pkg.name === 'ravenry-app' || pkg.name === 'mission-control')) return { root: dir, name: pkg.name, version: pkg.version || null };
    if (pkg) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** True for the app's own hub: this copy, or one in the app's versions/. */
export function isOwn(root, appData = null) {
  const r = realOr(root);
  if (r === realOr(ROOT)) return true;
  if (appData && inside(r, realOr(path.join(appData, 'versions')))) return true;
  return /[/\\]versions[/\\][^/\\]+[/\\]hub$/.test(r) && fs.existsSync(path.join(path.dirname(r), '.build.json'));
}

// A command line from ps, as words, keeping a path with spaces whole when
// it names an existing file.
export function psWords(cmd) {
  const t = String(cmd || '').trim().split(/ +/).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length;) {
    let took = 1;
    if (t[i].startsWith('/')) {
      for (let j = t.length; j > i + 1; j--) {
        const c = t.slice(i, j).join(' ');
        if (fs.existsSync(c)) { took = j - i; break; }
      }
    }
    out.push(t.slice(i, i + took).join(' '));
    i += took;
  }
  return out;
}

// The board a command line runs: { root, version, script } when one of its
// words is a copy of Ravenry's bin/ravenry(.mjs) (npm's bin link included)
// or server/index.mjs.
export function boardOf(words) {
  for (const w of words || []) {
    if (!path.isAbsolute(w) || !fs.existsSync(w)) continue;
    const real = realOr(w);
    if (!/[/\\](bin[/\\]ravenry(\.mjs)?|server[/\\]index\.mjs)$/.test(real)) continue;
    const c = copyOf(real);
    if (c) return { ...c, script: real };
  }
  return null;
}

// ------------------------------------------------------------ the board

async function stateAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && 'projects' in j ? j : null;
  } catch { return null; }
}

const listening = (port) => run('/usr/sbin/lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']).out.split('\n').map(Number).filter((n) => n > 0);
const commandOf = (pid) => run('/bin/ps', ['-o', 'command=', '-p', String(pid)]).out.split('\n')[0] || '';
const cwdOf = (pid) => (run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).out.split('\n').find((l) => l.startsWith('n')) || '').slice(1) || null;

/**
 * The board serving this data, or null: { port, pid, command, cwd, root,
 * version, own }. Only the board.json in this data folder says which board
 * that is (every board writes it on start and removes it on exit): never a
 * port alone, as a board on another person's or another test's data
 * answers there too, and its "~/.ravenry" names no home.
 */
export async function findBoard({ home = RAVENRY_HOME, appData = null } = {}) {
  const b = readJson(path.join(home, 'board.json'));
  if (!b || !Number.isInteger(b.port) || b.port <= 0 || !alive(b.pid)) return null;
  const st = await stateAt(b.port);
  if (!st) return null;
  if (st.registryPath && path.isAbsolute(st.registryPath) && realOr(st.registryPath) !== realOr(path.join(home, 'projects.json'))) return null;
  const holders = listening(b.port);
  if (holders.length && !holders.includes(b.pid)) return null;
  const command = commandOf(b.pid);
  const copy = boardOf(psWords(command));
  return { port: b.port, pid: b.pid, command, cwd: cwdOf(b.pid), root: copy ? copy.root : null, version: copy ? copy.version : null, own: copy ? isOwn(copy.root, appData) : false };
}

// ------------------------------------------------------------ login starts

const plistJson = (file) => {
  const r = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
};

/** The LaunchAgents that start a board of Ravenry at login (macOS). */
export function loginStarts({ home = os.homedir(), appData = null } = {}) {
  if (process.platform !== 'darwin') return [];
  const dir = path.join(home, 'Library', 'LaunchAgents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.plist')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const j = plistJson(file);
    if (!j || j.Label === APP_SERVICE) continue;
    const args = Array.isArray(j.ProgramArguments) ? j.ProgramArguments.map(String) : [];
    const copy = boardOf(args);
    if (copy && isOwn(copy.root, appData)) continue;
    if (!copy && !LOGIN_LABELS.includes(j.Label)) continue;
    const loaded = run(LAUNCHCTL(), ['print', `gui/${UID()}/${j.Label}`]).status === 0;
    out.push({ label: j.Label, plist: file, loaded, args, root: copy ? copy.root : null, version: copy ? copy.version : null });
  }
  return out;
}

// ------------------------------------------------------------ hooks

// Our script entries in a settings or hooks.json document that run a copy
// of Ravenry other than the app's: [{ event, script, command }].
export function foreignHooks(json, { appData = null, scripts = hk.OURS } = {}) {
  const out = [];
  for (const o of scripts) {
    for (const ev of o.events) {
      for (const g of ((json && json.hooks) || {})[ev] || []) {
        for (const h of (g && g.hooks) || []) {
          if (!hk.isOurs(h, o, { root: ROOT })) continue;
          const script = hk.commandWords(h.command)[1] || '';
          const copy = copyOf(script);
          if (copy && isOwn(copy.root, appData)) continue;
          if (!copy && /\/versions\/[^/]+\/hub\/hooks\//.test(script)) continue;
          out.push({ event: ev, script: o.script, command: h.command, root: copy ? copy.root : path.dirname(path.dirname(script)) });
        }
      }
    }
  }
  return out;
}

function hooksNow(appData) {
  const out = { claude: [], codex: [] };
  try { out.claude = foreignHooks(hk.readSettings().json, { appData }); } catch { /* unreadable: left alone */ }
  if (hk.codexInstalled()) { try { out.codex = foreignHooks(cx.readHooks().json, { appData, scripts: hk.CODEX_OURS }); } catch { /* unreadable */ } }
  return out;
}

// ------------------------------------------------------------ detect

export const readRecord = () => readJson(RECORD());
function writeRecord(rec) {
  fs.mkdirSync(path.dirname(RECORD()), { recursive: true });
  const tmp = `${RECORD()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, RECORD());
}

// The npm copy: { root, version, node } from the board, a login start or
// the hooks, in that order.
function npmCopy(board, login, hooks) {
  const node = (hooks.claude[0] || hooks.codex[0]) ? hk.commandWords((hooks.claude[0] || hooks.codex[0]).command)[0] : null;
  const from = (board && !board.own && board.root) ? board : login.find((l) => l.root) || null;
  const root = from ? from.root : (hooks.claude[0] || hooks.codex[0] || {}).root || null;
  const c = root ? copyOf(path.join(root, 'package.json')) : null;
  return root ? { root, version: c ? c.version : from && from.version, node } : null;
}

/** What of the npm board is here. `npm` says whether the app should offer the switch. */
export async function detect({ appData = null } = {}) {
  const board = await findBoard({ appData });
  const login = loginStarts({ appData });
  const hooks = hooksNow(appData);
  const record = readRecord();
  const foreignBoard = !!board && !board.own;
  const npm = foreignBoard || login.length > 0 || hooks.claude.length > 0 || hooks.codex.length > 0;
  return { ok: true, data: RAVENRY_HOME, npm, board, login, hooks, copy: npm ? npmCopy(board, login, hooks) : null, record };
}

// ------------------------------------------------------------ switch

// Everything in the data folder but backups/, logs/ and the iTerm2 helper's
// Python, copied as it is. Returns the number of files.
function copyData(from, to) {
  const skip = new Set(['backups', 'logs', 'iterm2-py']);
  let n = 0;
  const walk = (a, b) => {
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      if (a === from && skip.has(e.name)) continue;
      if (e.name.endsWith('.tmp')) continue;
      const x = path.join(a, e.name), y = path.join(b, e.name);
      if (e.isDirectory()) { fs.mkdirSync(y, { recursive: true }); walk(x, y); }
      else if (e.isFile()) { fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(x, y); n++; }
    }
  };
  walk(from, to);
  return n;
}

async function stopPid(pid, port) {
  if (!alive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 100; i++) { if (!alive(pid) && !(port && listening(port).includes(pid))) return true; await sleep(100); }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  for (let i = 0; i < 30; i++) { if (!alive(pid)) return true; await sleep(100); }
  return false;
}

/** The switch, once the person agreed. `ravenryd`: the app's ravenryd for the hooks. */
export async function doSwitch({ ravenryd, appData = null, log = () => {} } = {}) {
  const d = await detect({ appData });
  const prev = d.record;
  if (!d.npm && !(prev && prev.state === 'switching')) return { ok: false, error: 'There is no npm board here to switch from.' };
  if (d.board && d.board.own === false && !d.board.root) return { ok: false, error: `Something that is not a Ravenry board answers on :${d.board.port} with this data. Stop it first.` };
  const at = new Date();
  const dir = path.join(RAVENRY_HOME, 'backups', `switch-${stamp(at)}`);
  const half = prev && prev.state === 'switching' ? prev : null;
  const rec = {
    version: 1, state: 'switching', at: at.toISOString(),
    from: half ? half.from : { ...(d.copy || {}), board: d.board && !d.board.own ? { port: d.board.port, pid: d.board.pid, command: d.board.command, cwd: d.board.cwd } : null },
    port: half ? half.port : (d.board && !d.board.own ? d.board.port : (readJson(path.join(RAVENRY_HOME, 'board.json')) || {}).port || Number(process.env.PORT) || 4600),
    login: half ? [...half.login] : [],
    hooks: half ? half.hooks : { claude: d.hooks.claude, codex: d.hooks.codex },
    backup: path.relative(RAVENRY_HOME, dir),
  };
  if (!rec.from.node && rec.from.root) rec.from.node = half && half.from.node || null;
  fs.mkdirSync(dir, { recursive: true });
  writeRecord(rec);

  // 1. The login starts: out of launchd (which stops the board they
  // started), their files kept in the backup.
  for (const it of d.login) {
    const r = it.loaded ? run(LAUNCHCTL(), ['bootout', `gui/${UID()}/${it.label}`]) : null;
    if (r && r.status !== 0 && run(LAUNCHCTL(), ['print', `gui/${UID()}/${it.label}`]).status === 0) {
      return { ok: false, error: `launchd did not stop ${it.label}: ${r.out || r.status}`, record: rec };
    }
    const kept = path.join(dir, 'LaunchAgents', path.basename(it.plist));
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.copyFileSync(it.plist, kept);
    fs.rmSync(it.plist, { force: true });
    rec.login.push({ label: it.label, plist: it.plist, kept: path.relative(RAVENRY_HOME, kept), loaded: it.loaded });
    writeRecord(rec);
    log(`login start ${it.label}: off (its file is in ${rec.backup}/LaunchAgents)`);
  }

  // 2. The board, when it still runs (started by hand, or launchd was slow).
  const board = await findBoard({ appData });
  if (board && !board.own) {
    if (!board.root) return { ok: false, error: `Something that is not a Ravenry board answers on :${board.port}. Stop it first.`, record: rec };
    if (!(await stopPid(board.pid, board.port))) return { ok: false, error: `The npm board (pid ${board.pid}) did not stop.`, record: rec };
    log(`board: stopped pid ${board.pid} on :${board.port}`);
  }
  // A board that was killed leaves its board.json.
  const bj = readJson(path.join(RAVENRY_HOME, 'board.json'));
  if (bj && !alive(bj.pid)) fs.rmSync(path.join(RAVENRY_HOME, 'board.json'), { force: true });

  // 3. The copy, now that nothing writes the data.
  rec.copied = copyData(RAVENRY_HOME, path.join(dir, 'ravenry'));
  const outside = path.join(dir, 'outside');
  const keep = (file, as) => { if (file && fs.existsSync(file)) { fs.mkdirSync(outside, { recursive: true }); fs.copyFileSync(file, path.join(outside, as)); } };
  keep(hk.SETTINGS_FILE(), 'claude-settings.json');
  keep(cx.HOOKS_FILE(), 'codex-hooks.json');
  keep(cx.CONFIG_FILE(), 'codex-config.toml');
  writeRecord(rec);
  log(`backup: ${rec.copied} files in ${rec.backup}`);

  // 4. The hooks, to the app's copy.
  if (ravenryd) {
    const r = hk.setupWithRavenryd({ ravenryd });
    if (!r.ok) return { ok: false, error: `The hooks were not moved: ${r.error}`, record: rec };
    rec.hooksMoved = { claude: r.claude ? r.claude.changes.length : 0, codex: r.codex ? r.codex.changes.length : 0 };
    log(`hooks: ${rec.hooksMoved.claude} change(s) in Claude Code's settings, ${rec.hooksMoved.codex} in Codex's`);
  }
  rec.state = 'switched';
  rec.switchedAt = new Date().toISOString();
  writeRecord(rec);
  return { ok: true, record: rec };
}

// ------------------------------------------------------------ back

// The settings with our entries put back to the npm copy's commands (or,
// when it had none, taken out).
function hooksBack(rec) {
  const out = { claude: [], codex: [] };
  const root = rec.from && rec.from.root;
  const node = rec.from && rec.from.node;
  const cur = hk.readSettings();
  const p = rec.hooks.claude.length && root && node ? hk.plan(cur.json, { root, node, ravenryd: false, electron: false }) : hk.plan(cur.json, { remove: true });
  if (p.changes.length) { hk.writeSettings(cur.file, cur.raw, p.settings); out.claude = p.changes; }
  if (hk.codexInstalled()) {
    const cp = rec.hooks.codex.length && root && node ? hk.codexPlan({ root, node, ravenryd: false, electron: false }) : hk.codexPlan({ remove: true });
    if (cp.changes.length) { hk.codexWrite(cp); out.codex = cp.changes; }
  }
  return out;
}

/** The way back, once the app's hub is stopped. */
export async function goBack({ appData = null, log = () => {} } = {}) {
  const rec = readRecord();
  if (!rec || rec.state !== 'switched') return { ok: false, error: 'Ravenry was never switched from an npm board here.' };
  const board = await findBoard({ appData });
  if (board && board.own) return { ok: false, error: `The app's hub still runs (pid ${board.pid}). Stop it first.` };
  const root = rec.from && rec.from.root;
  if (rec.hooks.claude.length + rec.hooks.codex.length && root && !fs.existsSync(path.join(root, 'hooks', 'events.mjs'))) {
    return { ok: false, error: `The npm board's copy is not in ${root} any more. Install it again (npm i -g ravenry-app@${rec.from.version || 'latest'}), then go back.` };
  }
  const result = { ok: true, ideas: null, hooks: null, login: [], started: false, command: rec.from && rec.from.board ? rec.from.board.command : null, cwd: rec.from && rec.from.board ? rec.from.board.cwd : null, port: rec.port };
  result.ideas = ideasfiles.moveBack(RAVENRY_HOME, { log });
  result.hooks = hooksBack(rec);
  log(`hooks: back to ${root || 'none'} (${result.hooks.claude.length} change(s) in Claude Code's settings, ${result.hooks.codex.length} in Codex's)`);
  for (const it of rec.login) {
    const kept = path.join(RAVENRY_HOME, it.kept);
    if (!fs.existsSync(it.plist) && fs.existsSync(kept)) { fs.mkdirSync(path.dirname(it.plist), { recursive: true }); fs.copyFileSync(kept, it.plist); }
    let loaded = run(LAUNCHCTL(), ['print', `gui/${UID()}/${it.label}`]).status === 0;
    if (it.loaded && !loaded) {
      const r = run(LAUNCHCTL(), ['bootstrap', `gui/${UID()}`, it.plist]);
      loaded = r.status === 0;
      if (!loaded) log(`login start ${it.label}: launchd refused it: ${r.out}`);
    }
    result.login.push({ label: it.label, plist: it.plist, loaded });
    log(`login start ${it.label}: back${loaded ? ', loaded' : ''}`);
  }
  if (result.login.some((l) => l.loaded)) {
    for (let i = 0; i < 100 && !result.started; i++) { const b = await findBoard({ appData }); result.started = !!(b && !b.own); if (!result.started) await sleep(150); }
  }
  rec.state = 'back';
  rec.backAt = new Date().toISOString();
  writeRecord(rec);
  return result;
}

// ------------------------------------------------------------ command line

const isMain = process.argv[1] && realOr(process.argv[1]) === realOr(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const appData = opt('--app-data') || null;
  const lines = [];
  const log = (s) => { lines.push(s); process.stderr.write(s + '\n'); };
  const cmd = argv[0];
  const job = cmd === 'detect' ? detect({ appData })
    : cmd === 'switch' ? doSwitch({ ravenryd: opt('--ravenryd') || null, appData, log })
      : cmd === 'back' ? goBack({ appData, log })
        : Promise.resolve({ ok: false, error: `usage: npmswitch.mjs detect|switch|back` });
  job.then((r) => { process.stdout.write(JSON.stringify({ ...r, log: lines }) + '\n'); process.exit(r.ok ? 0 : 1); },
    (e) => { process.stdout.write(JSON.stringify({ ok: false, error: e.message, log: lines }) + '\n'); process.exit(1); });
}
