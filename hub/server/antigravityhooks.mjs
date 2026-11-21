// Ravenry's hooks in Antigravity CLI (docs/ASSISTANTS.md, "Antigravity
// CLI"): one group, "ravenry", in its global hooks file,
// <~/.gemini>/config/hooks.json, which maps a group's name to its events:
//
//   { "ravenry": { "SessionStart": [ { "type": "command", "command": ..., "timeout": 10 } ],
//                  "PreInvocation": [ ... ], "Stop": [ ... ] },
//     "<another group>": { ... } }
//
// Each command is `<ravenryd> hook --assistant antigravity --state ...`:
// measured on agy 1.5.14, a hook runs as a child of the session's own
// process with the pane's environment (RAVENRY_PANE, RAVENRY_SOCKET), and
// its input names its fields in camelCase, which the daemon reads as the
// board's (conversationId as session_id, transcriptPath, modelName).
//
//   SessionStart   a new conversation's first message, just before its
//                  first model call (never a resumed one): Working
//   PreInvocation  before each model call: Working
//   Stop           the model's loop ended: at rest; the hub may answer
//                  {"decision":"continue","reason"} for the hand-off
//
// No PreToolUse: its answer must name a decision, and `{}` (or nothing)
// refuses the tool (measured: "tool call denied by pre-tool hook").
//
// Other groups are never touched: the group is added before the file's
// last brace and taken out the same way, so their bytes stay as they are;
// only when the file was rewritten in between is it read and written as
// JSON. A group named "ravenry" whose commands are not Ravenry's is left
// alone. A test never reaches the real folder: MC_ANTIGRAVITY_HOME names a
// scratch ~/.gemini, and a test without it counts Antigravity CLI as not
// there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROUP = 'ravenry';
export const ASSISTANT = 'antigravity';
export const EVENTS = [
  { event: 'SessionStart', args: ['--state', 'working', '--event', 'SessionStart'], timeout: 10 },
  { event: 'PreInvocation', args: ['--state', 'working', '--event', 'PreInvocation'], timeout: 10 },
  { event: 'Stop', args: ['--state', 'idle', '--event', 'Stop', '--decide', '--timeout', '8s'], timeout: 15 },
];

const isTest = (env) => env.TEST_RAVENRY === '1' || env.MC_TEST === '1';
const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** Its ~/.gemini folder (MC_ANTIGRAVITY_HOME in a test). */
export function geminiDir(env = process.env) {
  return env.MC_ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini');
}
export const hooksFile = (env = process.env) => path.join(geminiDir(env), 'config', 'hooks.json');

export function commandFor(ravenryd, e) {
  return `${q(ravenryd)} hook --assistant ${ASSISTANT} ${e.args.join(' ')}`;
}

/** Our group for this ravenryd. */
export function groupFor(ravenryd) {
  return Object.fromEntries(EVENTS.map((e) => [e.event, [{ type: 'command', command: commandFor(ravenryd, e), timeout: e.timeout }]]));
}

// The words of a shell command (single quotes as q() writes them).
function words(cmd) {
  const out = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2]);
  return out;
}
const isOurCommand = (cmd) => { const w = words(cmd); const i = w.indexOf('hook'); return i >= 1 && /(^|\/)ravenryd?$/.test(w[i - 1]) && w[i + 1] === '--assistant' && w[i + 2] === ASSISTANT; };
const commandsOf = (g) => Object.values(g && typeof g === 'object' ? g : {}).flatMap((l) => (Array.isArray(l) ? l : [])).flatMap((h) => (h && Array.isArray(h.hooks) ? h.hooks : [h])).filter((h) => h && typeof h.command === 'string');
/** Is this group Ravenry's? Every command it runs is our ravenryd hook. */
export const isOurs = (g) => { const c = commandsOf(g); return c.length > 0 && c.every((h) => isOurCommand(h.command)); };
/** The ravenryd our group runs, or null. */
export function ravenrydOf(g) {
  for (const h of commandsOf(g)) if (isOurCommand(h.command)) { const w = words(h.command); return w[w.indexOf('hook') - 1]; }
  return null;
}

/** { file, raw, exists, json }; throws (code EBADJSON) when the file is not JSON. */
export function read(env = process.env) {
  const file = hooksFile(env);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let json = {};
  if (raw != null && raw.trim()) {
    try { json = JSON.parse(raw); } catch (e) { const err = new Error(`${file} is not valid JSON (${e.message}), so Ravenry leaves it alone. Fix it, then run this again.`); err.code = 'EBADJSON'; throw err; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) { const err = new Error(`${file} is not a JSON object, so Ravenry leaves it alone.`); err.code = 'EBADJSON'; throw err; }
  }
  return { file, raw, exists: raw != null, json };
}

/** Antigravity CLI is here: its binary, or its hooks file holds our group. */
export function present({ env = process.env, findBin = () => null } = {}) {
  if (isTest(env) && !env.MC_ANTIGRAVITY_HOME) return false;
  if (env.MC_ANTIGRAVITY === '0' || env.MC_ANTIGRAVITY === '1') return env.MC_ANTIGRAVITY === '1';
  if (findBin()) return true;
  try { return isOurs(read(env).json[GROUP]); } catch { return false; }
}

// { file, state: 'ok' | 'missing' | 'stale' | 'off' | 'foreign', ravenryd, why }:
// stale when its ravenryd is gone or the group is an older one; off when
// someone set its "enabled" to false.
export function status({ env = process.env } = {}) {
  const r = read(env);
  const g = r.json[GROUP];
  if (g == null) return { file: r.file, state: 'missing', ravenryd: null };
  if (!isOurs(g)) return { file: r.file, state: 'foreign', ravenryd: null };
  const rv = ravenrydOf(g);
  if (g.enabled === false) return { file: r.file, state: 'off', ravenryd: rv, why: 'its group is turned off ("enabled": false)' };
  if (!rv || !isExe(rv)) return { file: r.file, state: 'stale', ravenryd: rv, why: `${rv || 'its ravenryd'} is gone` };
  if (JSON.stringify(g) !== JSON.stringify(groupFor(rv))) return { file: r.file, state: 'stale', ravenryd: rv, why: 'an older group' };
  return { file: r.file, state: 'ok', ravenryd: rv };
}

// The group as it is written into the file: two spaces in, after a comma.
const blockOf = (group) => `\n  ${JSON.stringify(GROUP)}: ${JSON.stringify(group, null, 2).split('\n').join('\n  ')}`;

// The text with our group added (or replaced) before the last brace, or
// taken out, leaving every other byte as it was; null when the text does
// not take it that way (the caller writes JSON then).
function splice(raw, json, group) {
  const text = raw == null ? '' : raw;
  const had = json[GROUP];
  // Taking out, or replacing: our block exactly as we wrote it.
  if (had != null) {
    const old = blockOf(had);
    const at = text.lastIndexOf(old);
    if (at < 0) return null;
    const before = text.slice(0, at);
    const after = text.slice(at + old.length);
    if (group) return before + blockOf(group) + after;
    // Its comma (it came after another group), else the one after it.
    if (/,\s*$/.test(before)) return before.replace(/,\s*$/, '') + after;
    return before + after.replace(/^\s*,/, '');
  }
  if (!group) return text;
  if (!text.trim()) return `{${blockOf(group)}\n}\n`;
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  const head = text.slice(0, end).replace(/\s*$/, '');
  const empty = /\{$/.test(head);
  return `${head}${empty ? '' : ','}${blockOf(group)}\n${text.slice(end)}`;
}

/**
 * What setup or uninstall would do: { file, raw, text (null: none to
 * write), json, changes, foreign }. Writes nothing. `ravenryd` undefined
 * keeps the one in place.
 */
export function plan({ remove = false, ravenryd, env = process.env } = {}) {
  // A test that names no scratch ~/.gemini never plans on the person's.
  if (isTest(env) && !env.MC_ANTIGRAVITY_HOME) return { file: hooksFile(env), raw: null, text: null, json: {}, changes: [] };
  const r = read(env);
  const had = r.json[GROUP];
  if (had != null && !isOurs(had)) return { file: r.file, raw: r.raw, text: r.raw, json: r.json, changes: [], foreign: true };
  let want;
  if (remove) want = null;
  else {
    const rv = ravenryd === undefined ? ravenrydOf(had) : ravenryd;
    if (!rv) return { file: r.file, raw: r.raw, text: r.raw, json: r.json, changes: [] };
    want = groupFor(rv);
  }
  if (remove && had == null) return { file: r.file, raw: r.raw, text: r.raw, json: r.json, changes: [] };
  if (!remove && had != null && JSON.stringify(had) === JSON.stringify(want)) return { file: r.file, raw: r.raw, text: r.raw, json: r.json, changes: [] };
  const json = { ...r.json };
  if (want) json[GROUP] = want; else delete json[GROUP];
  let text = splice(r.raw, r.json, want);
  // The spliced text must read as the JSON meant; else it is written as JSON.
  try { if (text == null || JSON.stringify(JSON.parse(text)) !== JSON.stringify(json)) text = null; } catch { text = null; }
  if (text == null) text = JSON.stringify(json, null, 2) + '\n';
  const changes = [remove ? 'hooks.json: removed Ravenry\'s group' : had == null ? 'hooks.json: Ravenry\'s group (SessionStart, PreInvocation, Stop)' : 'hooks.json: Ravenry\'s group brought up to date'];
  return { file: r.file, raw: r.raw, text, json, changes };
}

/** Writes a plan, the file backed up first (beside it). Returns the backup's path or null. */
export function write(p) {
  if (p.foreign || !p.changes.length) return null;
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  let backup = null;
  if (p.raw != null) {
    backup = `${p.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, p.raw);
  }
  const tmp = `${p.file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, p.text);
  fs.renameSync(tmp, p.file);
  return backup;
}
