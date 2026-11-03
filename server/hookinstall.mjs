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
// in the command); every other hook and setting stays as it is.

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

export function hookCommand(o, { root = ROOT, node = stableNode() } = {}) {
  return `${q(node)} ${q(path.join(root, 'hooks', o.script))}`;
}

// Matches this script wherever its copy was when it was installed, under
// the name ravenry or mission-control (the name before the rename), and
// this very copy's script whatever its folder is called (a git checkout in
// a folder of another name would otherwise add entries it never finds).
export function isOurs(h, o, { root = ROOT } = {}) {
  if (!h || typeof h.command !== 'string') return false;
  if (new RegExp(`(^|[/\\s"'])(ravenry|mission-control)/hooks/${o.script.replace('.', '\\.')}(["'\\s]|$)`).test(h.command)) return true;
  return splitCommand(h.command).includes(path.join(root, 'hooks', o.script));
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

// The settings with our hooks added, updated or removed, and what changed.
// `json` is not modified.
export function plan(json, { remove = false, root = ROOT, node } = {}) {
  const settings = JSON.parse(JSON.stringify(json || {}));
  const hadHooks = !!settings.hooks;
  settings.hooks = settings.hooks || {};
  const changes = [];
  for (const o of OURS) {
    const cmd = hookCommand(o, { root, node });
    for (const ev of o.events) {
      const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
      let found = false;
      for (const entry of list) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        const before = entry.hooks.length;
        if (remove) {
          entry.hooks = entry.hooks.filter((h) => !isOurs(h, o));
          if (entry.hooks.length !== before) changes.push(`${ev}: removed ${o.script}`);
          continue;
        }
        entry.hooks = entry.hooks.filter((h) => {
          if (!isOurs(h, o)) return true;
          if (found) { changes.push(`${ev}: dropped a second ${o.script} (${h.command})`); return false; }
          found = true;
          if (h.command !== cmd) { changes.push(`${ev}: ${o.script} now runs ${cmd}`); h.command = cmd; }
          return true;
        });
      }
      // An entry that held only our hook goes with it; every other is kept.
      const kept = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
      if (!remove && !found) {
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
        const [node, script] = splitCommand(c);
        let why = null;
        if (!node || !isExe(node)) why = `its Node (${node}) is not there any more`;
        else if (!script || !fs.existsSync(script)) why = `its script (${script}) is not there any more`;
        else if (realOr(script) !== realOr(path.join(root, 'hooks', o.script))) why = `it runs another copy of Ravenry (${path.dirname(path.dirname(script))})`;
        if (why) stale.push({ event: ev, script: o.script, command: c, why });
      }
    }
    scripts.push({ script: o.script, what: o.what, events: on, want: o.events });
  }
  const all = scripts.every((s) => s.events.length === s.want.length);
  const none = scripts.every((s) => !s.events.length);
  return { state: stale.length ? 'stale' : all ? 'ok' : none ? 'missing' : 'partial', scripts, stale };
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
