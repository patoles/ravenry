// Ravenry's two Claude Code hooks in ~/.claude/settings.json, as a module:
// `ravenry setup`, `ravenry doctor` and `ravenry uninstall` (bin/ravenry.mjs)
// and tools/install-hook.mjs all go through it.
//
//   hooks/handoff-stop.mjs  on Stop (the clean hand-off, docs/HANDOFF.md)
//   hooks/events.mjs        on SessionStart, SessionEnd, UserPromptSubmit,
//                           Notification and Stop (docs/STATE-RULES.md)
//
// A hook command is `<node> <this copy>/hooks/<script>`, both absolute: a
// hook runs through `sh -c` with whatever PATH Claude Code was started
// with, so a bare `ravenry` or `node` may not be found there, and an extra
// launcher would cost every event a second process. `npm i -g ravenry-app`
// upgrades in place (same folder), so the path survives upgrades; what can
// go stale is Node itself (a removed nvm version, a Homebrew upgrade of a
// versioned path) or a copy that moved. stableNode() prefers a PATH entry
// over a versioned one, status() names each stale command, and plan()
// rewrites our entries in place.
//
// Only entries that run these two scripts are ever touched (matched by
// `ravenry/hooks/<script>` or the pre-rename `mission-control/hooks/<script>`
// in the command, or by a script of any other copy of Ravenry, such as
// npm's .../node_modules/ravenry-app/hooks/<script>); every other hook and
// setting stays as it is.
//
// Ravenry's own terminal adds a third command, `ravenryd hook --assistant
// claude|codex` (the daemon's hook, PROTOCOL.md section 4, agent.report):
// it reports a session in a ravenryd pane to its daemon, on any machine,
// with no Node. Installed with `ravenryd: <its path>` (the app's
// first-launch setup, POST /api/setup/hooks), it goes beside the two
// scripts, which then carry --ravenryd: inside a ravenryd pane they leave
// the event to the daemon, and everywhere else (cmux, iTerm2, Rex) they
// work as before. A plan without `ravenryd` keeps a ravenryd hook already
// there, and its --ravenryd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_FILE = () => process.env.MC_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');

export const OURS = [
  { script: 'handoff-stop.mjs', events: ['Stop'], timeout: 10, what: 'the clean hand-off at the context line' },
  { script: 'events.mjs', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop'], timeout: 5, what: "each session's state for the board" },
];

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// The Node to name in a hook: the first `node` on PATH (or in the usual
// install folders) that is this same binary, so a Homebrew upgrade that
// replaces /opt/homebrew/Cellar/node/<version> does not break the hook;
// else this process's own Node.
export function stableNode(execPath = process.execPath, envPath = process.env.PATH || '') {
  const want = realOr(execPath);
  const dirs = [...envPath.split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    const c = path.join(d, 'node');
    if (path.isAbsolute(c) && isExe(c) && realOr(c) === want) return c;
  }
  return execPath;
}

// Quoted only when it has to be, so commands written before stay byte for
// byte what they were.
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// The desktop app's hub runs on the app's own executable as Node
// (ELECTRON_RUN_AS_NODE=1, apps/desktop/src/main/install.ts). Started
// without that variable, as Claude Code or Codex would start a hook, that
// executable opens the app instead (or, with the app open, brings its
// window up), so the hooks of such a hub set it in front of the command.
// A hook runs through `sh -c`, which reads the assignment.
export const AS_NODE = 'ELECTRON_RUN_AS_NODE=1';
const onElectron = () => !!process.versions.electron;

export function hookCommand(o, { root = ROOT, node = stableNode(), electron = onElectron() } = {}) {
  const r = hookRoot(root);
  // The app's own executable runs a script only as Node: never named without the variable.
  if (path.basename(String(node)) === 'Ravenry') electron = true;
  return `${electron ? `${AS_NODE} ` : ''}${q(throughCurrent(node, root, r))} ${q(path.join(r, 'hooks', o.script))}`;
}

// ------------------------------------------------- the app's stable folder
//
// The desktop app's hub runs from <data>/versions/<version>/hub, and an
// update removes old version folders. Claude Code and Codex read their
// hooks once, when a session starts, so a session started before an
// update kept calling the old folder's scripts and showed "hook error" at
// every turn once it was gone (2026-11-07). So hooks name <data>/current,
// a link the service hub points at its own version folder when it starts
// (pointCurrent, an atomic rename), never a version folder; and a version
// folder an update removes leaves its hook scripts behind as stubs that
// run current's (apps/desktop/src/main/install.ts pruneVersions).

// Whether a hook script is named through <data>/current (`stable` is
// <data>/current/hub), whatever spelling the folders above have (/var or
// /private/var): by the real <data> and the word current.
function throughStable(script, stable) {
  const hub = path.dirname(path.dirname(script));
  return path.basename(hub) === 'hub' && path.basename(path.dirname(hub)) === 'current' && !!realOr(path.dirname(path.dirname(hub))) && realOr(path.dirname(path.dirname(hub))) === realOr(path.dirname(path.dirname(stable)));
}

/** <data>/current/hub for a hub in <data>/versions/<v>/hub, else null. */
export function appStableRoot(root = ROOT) {
  const versions = path.dirname(path.dirname(root));
  if (path.basename(root) !== 'hub' || path.basename(versions) !== 'versions') return null;
  return path.join(path.dirname(versions), 'current', 'hub');
}

/** The folder hooks name for this copy: current/hub when it is this copy. */
export function hookRoot(root = ROOT) {
  const st = appStableRoot(root);
  return st && realOr(st) && realOr(st) === realOr(root) ? st : root;
}

// A file inside this version folder (the runtime an AppImage's hub runs),
// named through current instead.
function throughCurrent(file, root, r) {
  if (r === root) return file;
  const vdir = path.dirname(root) + path.sep;
  return String(file).startsWith(vdir) ? path.join(path.dirname(r), String(file).slice(vdir.length)) : file;
}

/**
 * Points <data>/current at this hub's version folder, atomically (a new
 * link renamed over the old one), so a hook never finds it missing. Only
 * for the app's hub. Returns true when current now points here.
 */
export function pointCurrent(root = ROOT) {
  const st = appStableRoot(root);
  if (!st) return false;
  const link = path.dirname(st);
  const target = path.dirname(root);
  try {
    if (realOr(link) === realOr(target)) return true;
    const tmp = `${link}.${process.pid}.tmp`;
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
    return realOr(link) === realOr(target);
  } catch { return false; }
}

// Whether `script` is one of the hooks of a copy of Ravenry: its folder's
// package.json is ravenry-app's (npm's copy, a git checkout, the app's hub)
// or mission-control's (the name before the rename). Read once per folder.
const copies = new Map();
export function ravenryCopyScript(script, name) {
  if (!script || path.basename(script) !== name || path.basename(path.dirname(script)) !== 'hooks') return false;
  const dir = path.dirname(path.dirname(script));
  if (!copies.has(dir)) {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a package */ }
    copies.set(dir, !!pkg && (pkg.name === 'ravenry-app' || pkg.name === 'mission-control'));
  }
  return copies.get(dir);
}

// A hook command's words after its leading NAME=value assignments: the
// program, then its arguments.
export function commandWords(cmd) {
  const w = splitCommand(cmd);
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
  return w.slice(i);
}

// Why one of our script commands would not run this copy, or null.
function staleWhy(command, script0, root) {
  const [node, script] = commandWords(command);
  if (!node || !isExe(node)) return `its Node (${node}) is not there any more`;
  if (!script || !fs.existsSync(script)) return `its script (${script}) is not there any more`;
  if (realOr(script) !== realOr(path.join(root, 'hooks', script0))) return `it runs another copy of Ravenry (${path.dirname(path.dirname(script))})`;
  const r = hookRoot(root);
  if (r !== root && !throughStable(script, r)) return `it names a version folder (${path.dirname(path.dirname(script))}) that an update removes`;
  if (!splitCommand(command).includes(AS_NODE) && ((onElectron() && realOr(node) === realOr(process.execPath)) || path.basename(node) === 'Ravenry')) return `it starts the Ravenry app without ${AS_NODE}, which opens the app instead of running the hook`;
  return null;
}

// Whether a hook of ours already there does what `command` would: it runs
// (its Node or the app as Node, its script, this copy, through current),
// and it says the same about the daemon's hook (--ravenryd) and the
// assistant. Such an entry is kept as it is, whatever its spelling (the
// Electron app's ELECTRON_RUN_AS_NODE=1 .../Ravenry or the native app's
// .../node): setup never rewrites a working hook only because it would
// write it another way.
function scriptWorks(h, o, command, root) {
  if (!h || typeof h.command !== 'string') return false;
  const has = splitCommand(h.command), want = splitCommand(command);
  for (const flag of ['--ravenryd', '--assistant=codex']) if (has.includes(flag) !== want.includes(flag)) return false;
  return staleWhy(h.command, o.script, root) === null;
}
// The daemon's hook already there runs the ravenryd asked for: its binary
// is there and is that one, or is the app's stable link (<data>/bin/ravenryd,
// which an update moves to the newest copy, as the Electron app writes it).
// Another working copy (an app moved, an older one left behind) is moved to
// the one asked for.
function daemonWorks(h, assistant, want) {
  if (!isRavenrydHook(h, assistant)) return false;
  const w = splitCommand(h.command);
  const bin = w[w.indexOf('hook') - 1];
  if (!path.isAbsolute(bin) || !isExe(bin)) return false;
  if (realOr(bin) === realOr(want)) return true;
  try { return fs.lstatSync(bin).isSymbolicLink() && path.basename(path.dirname(bin)) === 'bin'; } catch { return false; }
}

// Matches this script wherever its copy was when it was installed, under
// the name ravenry or mission-control (the name before the rename), and
// this very copy's script whatever its folder is called (a git checkout in
// a folder of another name would otherwise add entries it never finds).
export function isOurs(h, o, { root = ROOT } = {}) {
  if (!h || typeof h.command !== 'string') return false;
  if (new RegExp(`(^|[/\\s"'])(ravenry|mission-control)/hooks/${o.script.replace('.', '\\.')}(["'\\s]|$)`).test(h.command)) return true;
  // The desktop app's hub, in any version folder of the app (an update
  // moves it to a new one).
  if (new RegExp(`/versions/[^/\\s"']+/hub/hooks/${o.script.replace('.', '\\.')}(["'\\s]|$)`).test(h.command)) return true;
  if (new RegExp(`/current/hub/hooks/${o.script.replace('.', '\\.')}(["'\\s]|$)`).test(h.command)) return true;
  const words = splitCommand(h.command);
  if (words.includes(path.join(root, 'hooks', o.script))) return true;
  // Any other copy of Ravenry (npm's installs in ravenry-app/, a checkout
  // may be named anything): left out, setup would add a second set beside
  // it and every event would be recorded twice.
  return commandWords(h.command).slice(1, 2).some((w) => path.isAbsolute(w) && ravenryCopyScript(w, o.script));
}

// The two paths a command names: [node, script], unquoted.
export function splitCommand(cmd) {
  const out = [];
  const re = /'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2] != null ? m[2] : m[3]);
  return out;
}

export function readSettings(file = SETTINGS_FILE()) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let json = {};
  if (raw != null && raw.trim()) {
    try { json = JSON.parse(raw); } catch (e) { const err = new Error(`${file} is not valid JSON (${e.message}), so Ravenry leaves it alone. Fix it, then run this again.`); err.code = 'EBADJSON'; throw err; }
  }
  return { file, raw, exists: raw != null, json };
}

// ------------------------------------------------------------ ravenryd hook

export const RAVENRYD_EVENTS = {
  claude: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop'],
  codex: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt'],
};

export function ravenrydCommand(bin, assistant) {
  return `${q(bin)} hook --assistant ${assistant}`;
}

// A `ravenryd hook` (or `ravenry hook`) entry for this assistant, wherever
// its binary is.
export function isRavenrydHook(h, assistant) {
  if (!h || typeof h.command !== 'string') return false;
  const w = splitCommand(h.command);
  const i = w.indexOf('hook');
  if (i < 1 || !/(^|\/)ravenryd?$/.test(w[i - 1])) return false;
  const a = w.slice(i + 1).join(' ');
  return new RegExp(`--assistant(=|\\s+)${assistant}(\\s|$)`).test(a);
}

// The ravenryd binary a settings file's hooks already run, or null.
export function ravenrydIn(json, assistant = 'claude') {
  for (const list of Object.values((json && json.hooks) || {})) {
    for (const e of Array.isArray(list) ? list : []) for (const h of (e && e.hooks) || []) {
      if (isRavenrydHook(h, assistant)) return splitCommand(h.command)[splitCommand(h.command).indexOf('hook') - 1];
    }
  }
  return null;
}

// Our entries for one assistant: the two scripts (with --ravenryd when the
// daemon's hook goes beside them, and --assistant=codex for Codex), and the
// daemon's hook. Each { script, events, timeout, command, match(h) }.
// `electron`: the commands run Node on the app's own executable (they set
// ELECTRON_RUN_AS_NODE=1); by default when this process is the app's.
export function oursFor(assistant, { root = ROOT, node, ravenryd = null, electron } = {}) {
  const scripts = assistant === 'codex' ? CODEX_OURS : OURS;
  const extra = (assistant === 'codex' ? ' --assistant=codex' : '') + (ravenryd ? ' --ravenryd' : '');
  const as = electron === undefined ? {} : { electron };
  const list = scripts.map((o) => {
    const command = hookCommand(o, { root, node, ...as }) + extra;
    return { ...o, command, match: (h) => isOurs(h, o, { root }), works: (h) => scriptWorks(h, o, command, root) };
  });
  if (ravenryd) list.push({ script: 'ravenryd hook', events: RAVENRYD_EVENTS[assistant], timeout: 10, what: 'sessions in Ravenry terminals, on any machine', command: ravenrydCommand(ravenryd, assistant), match: (h) => isRavenrydHook(h, assistant), works: (h) => daemonWorks(h, assistant, ravenryd) });
  return list;
}

// The settings with our hooks added, updated or removed, and what changed.
// `json` is not modified. `ravenryd`: the daemon's path to add its hook
// with (undefined keeps the one there; false removes it).
//
// A remote machine (server/remoteinstall.mjs) has no Node and no hub, so
// it gets the daemon's hook only: `scripts: false` leaves the two scripts
// out (and alone, when someone put them there), and `daemonMatch(h)` says
// which `ravenryd hook` entries are this install's (by default every one).
export function plan(json, { remove = false, root = ROOT, node, ravenryd, scripts = true, daemonMatch = null, electron } = {}) {
  const settings = JSON.parse(JSON.stringify(json || {}));
  const hadHooks = !!settings.hooks;
  settings.hooks = settings.hooks || {};
  const changes = [];
  const rv = ravenryd === undefined ? ravenrydIn(json, 'claude') : ravenryd || null;
  const isDaemon = (h) => isRavenrydHook(h, 'claude') && (!daemonMatch || daemonMatch(h));
  const ours = oursFor('claude', { root, node, ravenryd: remove ? null : rv, electron })
    .filter((o) => scripts || o.script === 'ravenryd hook')
    .map((o) => (o.script === 'ravenryd hook' ? { ...o, match: isDaemon } : o));
  // Removing (or dropping the daemon's hook): it goes too.
  if (remove || ravenryd === false) ours.push({ script: 'ravenryd hook', events: RAVENRYD_EVENTS.claude, remove: true, match: isDaemon });
  for (const o of ours) {
    const cmd = o.command;
    const drop = remove || o.remove;
    for (const ev of o.events) {
      const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
      let found = false;
      for (const entry of list) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        const before = entry.hooks.length;
        if (drop) {
          entry.hooks = entry.hooks.filter((h) => !o.match(h));
          if (entry.hooks.length !== before) changes.push(`${ev}: removed ${o.script}`);
          continue;
        }
        entry.hooks = entry.hooks.filter((h) => {
          if (!o.match(h)) return true;
          if (found) { changes.push(`${ev}: dropped a second ${o.script} (${h.command})`); return false; }
          found = true;
          // A working entry of another spelling is kept (oursFor's works).
          if (h.command !== cmd && !(o.works && o.works(h))) { changes.push(`${ev}: ${o.script} now runs ${cmd}`); h.command = cmd; }
          return true;
        });
      }
      // An entry that held only our hook goes with it; every other is kept.
      const kept = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
      if (!drop && !found) {
        kept.push({ hooks: [{ type: 'command', command: cmd, timeout: o.timeout }] });
        changes.push(`${ev}: added ${o.script}`);
      }
      if (kept.length) settings.hooks[ev] = kept;
      else if (ev in settings.hooks) delete settings.hooks[ev];
    }
  }
  // A file that had no "hooks" before we added ours gets none back.
  if (remove && !Object.keys(settings.hooks).length && !hadHooks) delete settings.hooks;
  return { settings, changes };
}

// What a settings file says about our hooks:
// { state: 'ok' | 'missing' | 'partial' | 'stale', scripts: [...], stale: [...] }
// stale lists each of our commands that would not run this copy: its Node
// is gone, its script is gone, or it runs another copy of Ravenry.
export function status(json, { root = ROOT } = {}) {
  const hooks = (json && json.hooks) || {};
  const scripts = [];
  const stale = [];
  for (const o of OURS) {
    const on = [];
    for (const ev of o.events) {
      const cmds = (Array.isArray(hooks[ev]) ? hooks[ev] : []).flatMap((e) => (e && Array.isArray(e.hooks) ? e.hooks : [])).filter((h) => isOurs(h, o)).map((h) => h.command);
      if (cmds.length) on.push(ev);
      for (const c of cmds) {
        const why = staleWhy(c, o.script, root);
        if (why) stale.push({ event: ev, script: o.script, command: c, why });
      }
    }
    scripts.push({ script: o.script, what: o.what, events: on, want: o.events });
  }
  const all = scripts.every((s) => s.events.length === s.want.length);
  const none = scripts.every((s) => !s.events.length);
  return { state: stale.length ? 'stale' : all ? 'ok' : none ? 'missing' : 'partial', scripts, stale, ravenryd: ravenrydStatus(json, 'claude') };
}

// Whether one assistant's sessions report to Ravenry: every event has a
// working hook of ours (status() ok, in whatever spelling runs), and the
// daemon's hook, when the scripts leave Ravenry's panes to it (--ravenryd),
// is on every one of its events with its binary there. What the Settings
// window's row, the panel's "This session" and GET /api/setup/hooks all
// say (one answer for every route). null: that assistant is not here.
export function hooksOn(kind, { root = ROOT } = {}) {
  const leaves = (json, ours) => Object.values((json && json.hooks) || {}).some((l) => (Array.isArray(l) ? l : []).some((e) => ((e && e.hooks) || []).some((h) => ours.some((o) => isOurs(h, o, { root })) && splitCommand(h.command).includes('--ravenryd'))));
  const daemonOk = (rv, json, ours) => rv.state === 'ok' || (rv.state === 'missing' && !leaves(json, ours));
  if (kind === 'claude') {
    const cur = readSettings();
    const s = status(cur.json, { root });
    return { file: cur.file, on: s.state === 'ok' && daemonOk(s.ravenryd, cur.json, OURS), state: s.state, daemon: s.ravenryd.state };
  }
  if (kind === 'codex') {
    if (!codexPresent()) return null;
    const s = codexStatus({ root });
    return { file: s.file, on: s.state === 'ok' && !s.hooksOff && daemonOk(s.ravenryd, cx.readHooks().json, CODEX_OURS), state: s.state, daemon: s.ravenryd.state };
  }
  return null;
}

// Whether the daemon's hook is there, on which events, and whether its
// binary still is: { state: 'ok' | 'missing' | 'partial' | 'stale', bin, events }.
export function ravenrydStatus(json, assistant = 'claude') {
  const hooks = (json && json.hooks) || {};
  const want = RAVENRYD_EVENTS[assistant];
  const on = want.filter((ev) => (Array.isArray(hooks[ev]) ? hooks[ev] : []).some((e) => e && Array.isArray(e.hooks) && e.hooks.some((h) => isRavenrydHook(h, assistant))));
  const bin = ravenrydIn(json, assistant);
  const state = !on.length ? 'missing' : bin && bin.startsWith('/') && !isExe(bin) ? 'stale' : on.length === want.length ? 'ok' : 'partial';
  return { state, bin, events: on };
}

// Writes `settings` to `file`, after a copy of `raw` (the file as it was)
// next to it. Returns the backup's path, or null when there was no file.
export function writeSettings(file, raw, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (raw != null) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);
  }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}

// The entries setup adds, as they will read in settings.json.
export function preview({ root = ROOT, node } = {}) {
  const out = {};
  for (const o of OURS) for (const ev of o.events) (out[ev] = out[ev] || []).push({ hooks: [{ type: 'command', command: hookCommand(o, { root, node }), timeout: o.timeout }] });
  return out;
}

// ------------------------------------------------------------ Codex
// The same two scripts in OpenAI Codex's hooks.json, with `--assistant=codex`
// so they record and answer as Codex's (docs/ASSISTANTS.md), on Codex's
// events: it has no Notification (PermissionRequest stands in) and an
// Interrupt event of its own. The trust entries Codex needs go in its
// config.toml (server/codexhooks.mjs). Only when Codex is installed.

import * as cx from './codexhooks.mjs';

export const CODEX_OURS = [
  { script: 'handoff-stop.mjs', events: ['Stop'], timeout: 10, what: 'the clean hand-off at the context line' },
  { script: 'events.mjs', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Interrupt'], timeout: 5, what: "each session's state for the board" },
];

export const codexInstalled = (env = process.env) => {
  // A test never reaches the real ~/.codex: it names a scratch one.
  if (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME) return false;
  return cx.codexInstalled(env);
};
// Codex's hooks are ours to keep up to date: Codex is installed, or its
// hooks.json already exists. Codex found on the PATH alone is not enough:
// an app started from the Finder has a short PATH that misses an nvm or
// npm-global codex, and on 2026-11-07 the switch from the npm board left
// the npm board's Codex hooks in place that way, so the next launch offered
// the switch again. MC_CODEX=0|1 decides in tests, as for codexInstalled.
export const codexPresent = (env = process.env) => {
  if (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME) return false;
  if (env.MC_CODEX === '0' || env.MC_CODEX === '1') return env.MC_CODEX === '1';
  if (cx.codexInstalled(env)) return true;
  try { return cx.readHooks().exists; } catch { return true; }
};
export const CODEX_HOOKS_FILE = cx.HOOKS_FILE;
export const CODEX_CONFIG_FILE = cx.CONFIG_FILE;

function codexOurs({ root = ROOT, node, ravenryd = null, electron } = {}) {
  return oursFor('codex', { root, node, ravenryd, electron });
}

// What setup or uninstall would write: { hooks: { file, raw, json }, config:
// { file, raw, text }, changes, hooksOff }. Reads both files; writes nothing.
// `ravenryd` as in plan().
export function codexPlan(opts = {}) {
  return codexPlanOf(cx.readHooks(), cx.readConfig(), opts);
}

// The same from files already read ({ file, raw, json } and { file, raw }),
// for a machine reached over ssh. `scripts` and `daemonMatch` as in plan():
// with `scripts: false` only the daemon's hook is added or removed, and the
// trust block keeps the entries of every other Ravenry hook still there.
export function codexPlanOf(h0, c, { remove = false, root = ROOT, node, ravenryd, scripts = true, daemonMatch = null, electron } = {}) {
  const h = { ...h0 };
  const rv = ravenryd === undefined ? ravenrydIn(h.json, 'codex') : ravenryd || null;
  const isDaemon = (x) => isRavenrydHook(x, 'codex') && (!daemonMatch || daemonMatch(x));
  const all = codexOurs({ root, node, ravenryd: remove ? null : rv, electron }).map((o) => (o.script === 'ravenryd hook' ? { ...o, match: isDaemon } : o));
  const ours = all.filter((o) => scripts || o.script === 'ravenryd hook');
  const gone = { script: 'ravenryd hook', events: RAVENRYD_EVENTS.codex, timeout: 10, command: '', match: isDaemon };
  if (remove || ravenryd === false) {
    // Taken out of hooks.json (and so out of the trust block) like the others.
    if (!remove || !scripts) {
      const p0 = cx.planHooks(h.json, [gone], (x, o) => o.match(x), { remove: true });
      h.dropped = cx.ourKeys(h.json, [gone], (x, o) => o.match(x), h.file).map((x) => x.key);
      h.json = p0.json;
      h.moves = p0.moves;
      h.changes0 = p0.changes;
    } else ours.push(gone);
  }
  const isO = (x, o) => o.match(x);
  const removeAll = remove && scripts;
  const p = cx.planHooks(h.json, removeAll ? ours : ours.filter((o) => !(remove && o.script === 'ravenryd hook')), isO, { remove: removeAll });
  // The trust block names every Ravenry hook in the file: with `scripts:
  // false` the scripts (and any other ravenryd hook) someone else put there
  // keep theirs.
  const trusted = scripts ? ours : [...codexOurs({ root, node, ravenryd: null, electron }), { ...gone, match: (x) => isRavenrydHook(x, 'codex') }];
  const drop = [...(h.dropped || []), ...cx.ourKeys(h.json, trusted, isO, h.file).map((x) => x.key)];
  const text = cx.planConfig(c.raw, p.json, trusted, isO, { file: h.file, moves: [...(h.moves || []), ...p.moves], remove: removeAll, drop });
  const changes = [...(h.changes0 || []), ...p.changes];
  if (text !== String(c.raw || '')) changes.push(removeAll || (remove && !scripts) ? `config.toml: removed the trust entries of Ravenry's hooks` : `config.toml: trust entries for Ravenry's hooks`);
  return { hooks: { file: h.file, raw: h.raw, json: p.json }, config: { file: c.file, raw: c.raw, text }, changes, hooksOff: cx.hooksDisabled(c.raw) };
}

// Writes a codexPlan, each file backed up first. Returns the backups.
export function codexWrite(plan) {
  const out = [];
  if (JSON.stringify(plan.hooks.json) !== JSON.stringify(plan.hooks.raw != null && plan.hooks.raw.trim() ? JSON.parse(plan.hooks.raw) : {})) out.push(cx.writeFile(plan.hooks.file, plan.hooks.raw, JSON.stringify(plan.hooks.json, null, 2) + '\n'));
  if (plan.config.text !== String(plan.config.raw || '')) out.push(cx.writeFile(plan.config.file, plan.config.raw, plan.config.text));
  return out.filter(Boolean);
}

// { state: 'ok' | 'missing' | 'partial' | 'untrusted' | 'stale', hooksOff, stale: [...] }
export function codexStatus({ root = ROOT } = {}) {
  const h = cx.readHooks();
  const ours = codexOurs({ root, ravenryd: ravenrydIn(h.json, 'codex') });
  const isO = (x, o) => o.match(x);
  const c = cx.readConfig();
  const st = cx.statusOf(h.json, c.raw, ours, isO, { file: h.file });
  // A command that would not run this copy, as for Claude Code's.
  const claudeShaped = { hooks: Object.fromEntries(Object.entries((h.json && h.json.hooks) || {})) };
  const stale = [];
  for (const o of ours.filter((x) => x.script !== 'ravenryd hook')) for (const ev of o.events) {
    for (const g of claudeShaped.hooks[ev] || []) for (const x of (g && g.hooks) || []) {
      if (!isO(x, o)) continue;
      const why = staleWhy(x.command, o.script, root);
      if (why) stale.push({ event: ev, script: o.script, command: x.command, why });
    }
  }
  return { ...st, state: stale.length ? 'stale' : st.state, stale, hooksOff: cx.hooksDisabled(c.raw), file: h.file, ravenryd: ravenrydStatus(h.json, 'codex') };
}

// ------------------------------------------------------------ first launch

// The app's first-launch setup: Ravenry's hooks in Claude Code's settings
// and, when Codex is installed, in Codex's, with the daemon's hook
// (`ravenryd`: the path of the ravenryd the app ships) beside the two
// scripts. Each file is backed up before it is written. `dry` only says
// what would change. Returns { ok, claude: { file, changes, backup },
// codex: { file, changes, backups } | null }.
export function setupWithRavenryd({ ravenryd, dry = false, remove = false, root = ROOT, node, only = null, undoFile = null } = {}) {
  if (!remove && (typeof ravenryd !== 'string' || !ravenryd.startsWith('/'))) return { ok: false, error: 'Give the absolute path of ravenryd.' };
  if (!remove && !isExe(ravenryd)) return { ok: false, error: `${ravenryd} is not an executable file.` };
  const out = { ok: true, claude: null, codex: null };
  if (only !== 'codex') {
    let cur;
    try { cur = readSettings(); } catch (e) { return { ok: false, error: e.message }; }
    const p = plan(cur.json, remove ? { remove: true, root, node } : { ravenryd, root, node });
    out.claude = { file: cur.file, changes: p.changes, backup: null };
    if (!dry && remove && undoFile && restoreExact([cur.file], undoFile)) out.claude.restored = true;
    else if (!dry && p.changes.length) {
      out.claude.backup = writeSettings(cur.file, cur.exists ? cur.raw : null, p.settings);
      if (undoFile) remember(undoFile, [[cur.file, cur.raw]], remove);
    }
  }
  if (only !== 'claude' && (only === 'codex' || codexPresent())) {
    const cp = codexPlan(remove ? { remove: true, root, node } : { ravenryd, root, node });
    out.codex = { file: cp.hooks.file, changes: cp.changes, backups: [], hooksOff: cp.hooksOff };
    if (!dry && remove && undoFile && restoreExact([cp.hooks.file, cp.config.file], undoFile)) out.codex.restored = true;
    else if (!dry && cp.changes.length) {
      out.codex.backups = codexWrite(cp);
      if (undoFile) remember(undoFile, [[cp.hooks.file, cp.hooks.raw], [cp.config.file, cp.config.raw]], remove);
    }
  }
  return out;
}

// ------------------------------------------------------------ an exact undo

// Removing what setup added puts each file back byte for byte as it was
// before (or gone, when setup made it), as long as nothing else changed it
// since: the undo file keeps, per file, its text before Ravenry's first
// write and its text after Ravenry's last. A file changed since (by the
// person, or the assistant) gets the plain removal instead: only Ravenry's
// entries out. Kept in Ravenry's own data folder (RAVENRY_HOME).
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function readUndo(undoFile) { try { return JSON.parse(fs.readFileSync(undoFile, 'utf8')) || {}; } catch { return {}; } }
function writeUndo(undoFile, u) {
  fs.mkdirSync(path.dirname(undoFile), { recursive: true });
  const tmp = `${undoFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2) + '\n');
  fs.renameSync(tmp, undoFile);
}
function remember(undoFile, files, removed) {
  const u = readUndo(undoFile);
  for (const [file, before] of files) {
    if (removed) { delete u[file]; continue; }
    const after = readText(file);
    if (after === before) continue;
    u[file] = { before: u[file] ? u[file].before : before, after };
  }
  writeUndo(undoFile, u);
}
function restoreExact(files, undoFile) {
  const u = readUndo(undoFile);
  const recs = files.map((f) => [f, u[f]]).filter(([, r]) => r);
  if (!recs.length || !recs.every(([f, r]) => readText(f) === r.after)) return false;
  for (const [f, r] of recs) {
    if (r.before == null) fs.rmSync(f, { force: true });
    else { const tmp = `${f}.tmp-${process.pid}`; fs.writeFileSync(tmp, r.before); fs.renameSync(tmp, f); }
    delete u[f];
  }
  writeUndo(undoFile, u);
  return true;
}

// ------------------------------------------------------------ app updates

// The desktop app's hub lives in <data>/versions/<version>/hub, so after an
// update the hooks it wrote name a version folder the app later removes,
// and hooks written before ELECTRON_RUN_AS_NODE was added open the app.
// At start, the app's hub (RAVENRY_HUB_SERVICE=1) rewrites our entries in
// place to this copy when every stale one is its own: a script of another
// version of this same app, or of this copy, or one whose Node or script
// is gone. Another copy of Ravenry (a git checkout, npm's) is left alone,
// and hooks the person never set up are never added. Each file is backed
// up first. Returns the changes per file.
export function refreshAppHooks({ root = ROOT, node } = {}) {
  const versions = path.dirname(path.dirname(root));
  pointCurrent(root);
  const stable = appStableRoot(root);
  const ownOrGone = (st) => st.stale.length > 0 && st.stale.every((x) => {
    const script = commandWords(x.command)[1] || '';
    // By real paths: the settings may spell a folder another way (/var or /private/var).
    return !fs.existsSync(script) || realOr(path.dirname(path.dirname(path.dirname(path.dirname(script))))) === realOr(versions) || (stable && throughStable(script, stable)) || realOr(script) === realOr(path.join(root, 'hooks', x.script));
  });
  const out = { claude: [], codex: [] };
  try {
    const cur = readSettings();
    if (ownOrGone(status(cur.json, { root }))) {
      const p = plan(cur.json, { root, node });
      if (p.changes.length) { writeSettings(cur.file, cur.raw, p.settings); out.claude = p.changes; }
    }
  } catch { /* unreadable: left as it is */ }
  try {
    if (codexPresent() && ownOrGone(codexStatus({ root }))) {
      const cp = codexPlan({ root, node });
      if (cp.changes.length) { codexWrite(cp); out.codex = cp.changes; }
    }
  } catch { /* unreadable: left as it is */ }
  return out;
}
