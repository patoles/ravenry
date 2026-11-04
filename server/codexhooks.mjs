// Ravenry's hooks in OpenAI Codex: <CODEX_HOME>/hooks.json and the trust
// entries Codex needs in <CODEX_HOME>/config.toml. `ravenry setup`, `doctor`
// and `uninstall` (bin/ravenry.mjs) reach it through server/hookinstall.mjs,
// and only when Codex is installed. docs/ASSISTANTS.md, "Installing the
// hooks in Codex".
//
// Measured on Codex 0.166.0 (its source, codex-rs/hooks discovery.rs and
// config fingerprint.rs, at tag rust-v0.166.0, and live):
// - hooks.json is { hooks: { <Event>: [ { matcher?, hooks: [ handler ] } ] } },
//   handler { type: "command", command, timeout (seconds) }.
// - A hook that is not managed runs only once trusted: config.toml holds
//   [hooks.state."<hooks.json path>:<event label>:<group index>:<handler index>"]
//   trusted_hash = "sha256:<hex>", the SHA-256 of the hook's normalized
//   identity as JSON with sorted keys (trustHash below; it gives exactly the
//   five hashes cmux wrote for its own hooks). `/hooks` in Codex trusts by
//   hand. cmux starts Codex with --dangerously-bypass-hook-trust, so in cmux
//   the trust entries are not needed, but in any other terminal they are.
// - [features] hooks is on by default ("stable true"). A config that turns it
//   off is left as the user set it; doctor says so.
//
// Every other entry in either file is kept as it is. Our groups are added at
// the end of each event's list, so no other hook's index (and trust) moves;
// removing ours renames the trust keys of groups after them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { codexHome } from './codexrollout.mjs';

export const HOOKS_FILE = () => path.join(codexHome(), 'hooks.json');
export const CONFIG_FILE = () => path.join(codexHome(), 'config.toml');

const LABEL = {
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact', PostCompact: 'post_compact', PreModelRequest: 'pre_model_request', PostModelRequest: 'post_model_request',
  SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'stop', Interrupt: 'interrupt',
};
const SHORT_EVENTS = new Set(['SessionEnd', 'Interrupt']); // timeout 1 s by default, 3 s at most

const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);

// Codex's trust hash of one command handler in its matcher group.
export function trustHash(event, group, handler) {
  let timeout = handler.timeout ?? (SHORT_EVENTS.has(event) ? 1 : 600);
  timeout = SHORT_EVENTS.has(event) ? Math.min(Math.max(timeout, 1), 3) : Math.max(timeout, 1);
  const h = { type: 'command', command: handler.command, timeout, async: !!handler.async };
  if (handler.statusMessage != null) h.statusMessage = handler.statusMessage;
  if (handler.additionalContextLimit != null && handler.additionalContextLimit !== 2500 && ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(event)) h.additionalContextLimit = handler.additionalContextLimit;
  const id = { event_name: LABEL[event], hooks: [h] };
  if (group && group.matcher != null && group.matcher !== '') id.matcher = group.matcher;
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortDeep(id))).digest('hex');
}

export const stateKey = (file, event, gi, hi) => `${file}:${LABEL[event]}:${gi}:${hi}`;

// Is Codex on this Mac? `codex` on PATH or in the usual folders, or a
// CODEX_HOME that already exists. MC_CODEX=0|1 decides in tests.
export function codexInstalled(env = process.env) {
  if (env.MC_CODEX === '0') return false;
  if (env.MC_CODEX === '1') return true;
  const dirs = [...String(env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  if (dirs.some((d) => { try { fs.accessSync(path.join(d, 'codex'), fs.constants.X_OK); return true; } catch { return false; } })) return true;
  return false;
}

// The installed Codex's version ("0.166.0"), or null.
export function codexVersion() {
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

export function readHooks(file = HOOKS_FILE()) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let json = {};
  if (raw != null && raw.trim()) {
    try { json = JSON.parse(raw); } catch (e) { const err = new Error(`${file} is not valid JSON (${e.message}), so Ravenry leaves it alone. Fix it, then run this again.`); err.code = 'EBADJSON'; throw err; }
  }
  return { file, raw, exists: raw != null, json };
}

export function readConfig(file = CONFIG_FILE()) {
  try { return { file, raw: fs.readFileSync(file, 'utf8'), exists: true }; } catch (e) { if (e.code !== 'ENOENT') throw e; return { file, raw: null, exists: false }; }
}

// Has the user turned Codex's hooks off ([features] hooks = false, or the
// old name codex_hooks)?
export function hooksDisabled(toml) {
  const t = String(toml || '');
  const m = t.match(/^\[features\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  return !!(m && /^\s*(hooks|codex_hooks)\s*=\s*false\b/m.test(m[1]));
}

const BEGIN = '# ravenry-codex-hook-trust begin';
const END = '# ravenry-codex-hook-trust end';
const BLOCK = new RegExp(`\\n?${BEGIN}\\n[\\s\\S]*?${END}\\n?`, 'g');

// hooks.json with our hooks added, updated or removed, and what changed.
// `ours` is [{ script, events, timeout, command }] (server/hookinstall.mjs);
// `isOurs(handler, o)` tells our handlers apart.
export function planHooks(json, ours, isOurs, { remove = false } = {}) {
  const out = JSON.parse(JSON.stringify(json || {}));
  const hadHooks = !!out.hooks;
  out.hooks = out.hooks || {};
  const changes = [];
  const moves = []; // { event, from, to }: groups whose index changed
  for (const o of ours) {
    for (const ev of o.events) {
      const timeout = SHORT_EVENTS.has(ev) ? Math.min(o.timeout, 3) : o.timeout;
      const list = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
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
          if (h.command !== o.command || h.timeout !== timeout) { changes.push(`${ev}: ${o.script} now runs ${o.command}`); h.command = o.command; h.timeout = timeout; }
          return true;
        });
      }
      const kept = [];
      list.forEach((e, i) => {
        if (e && Array.isArray(e.hooks) && e.hooks.length === 0) return;
        if (kept.length !== i) moves.push({ event: ev, from: i, to: kept.length });
        kept.push(e);
      });
      if (!remove && !found) {
        kept.push({ hooks: [{ type: 'command', command: o.command, timeout }] });
        changes.push(`${ev}: added ${o.script}`);
      }
      if (kept.length) out.hooks[ev] = kept;
      else if (ev in out.hooks) delete out.hooks[ev];
    }
  }
  if (remove && !Object.keys(out.hooks).length && !hadHooks) delete out.hooks;
  return { json: out, changes, moves };
}

// The trust keys of our handlers in a hooks.json.
export function ourKeys(hooksJson, ours, isOurs, file = HOOKS_FILE()) {
  const keys = [];
  for (const [ev, groups] of Object.entries((hooksJson && hooksJson.hooks) || {})) {
    (groups || []).forEach((g, gi) => (g && Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => {
      if (ours.some((o) => isOurs(h, o))) keys.push({ key: stateKey(file, ev, gi, hi), hash: trustHash(ev, g, h) });
    }));
  }
  return keys;
}

// Takes out the table [hooks.state."<key>"] and its key = value lines (one
// Codex's /hooks wrote for a hook of ours, say), so a key is never twice.
function dropTable(t, key) {
  const head = `[hooks.state."${key}"]`;
  const lines = t.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== head) { out.push(lines[i]); continue; }
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*\[/.test(lines[i + 1]) && !/^\s*#/.test(lines[i + 1])) i++;
  }
  return out.join('\n');
}

// config.toml with the trust entries for our handlers (one marked block,
// rewritten whole), the keys of other groups that moved renamed, and any
// other table for one of our keys (`drop`: the keys before the change too)
// taken out.
export function planConfig(toml, hooksJson, ours, isOurs, { file = HOOKS_FILE(), moves = [], remove = false, drop = [] } = {}) {
  let t = String(toml || '').replace(BLOCK, '\n');
  const mine = remove ? [] : ourKeys(hooksJson, ours, isOurs, file);
  for (const k of new Set([...drop, ...mine.map((x) => x.key)])) t = dropTable(t, k);
  for (const mv of moves) {
    const a = `[hooks.state."${file}:${LABEL[mv.event]}:${mv.from}:`;
    const b = `[hooks.state."${file}:${LABEL[mv.event]}:${mv.to}:`;
    t = t.split(a).join(b);
  }
  t = t.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  if (remove || !mine.length) return t ? t + '\n' : '';
  const block = [BEGIN, ...mine.flatMap((x) => [`[hooks.state."${x.key}"]`, `trusted_hash = "${x.hash}"`]), END].join('\n');
  return (t ? t + '\n\n' : '') + block + '\n';
}

// What a hooks.json and config.toml say about our hooks:
// { state: 'ok' | 'missing' | 'partial' | 'untrusted', events: [...], untrusted: [...] }
export function statusOf(hooksJson, toml, ours, isOurs, { file = HOOKS_FILE() } = {}) {
  const hooks = (hooksJson && hooksJson.hooks) || {};
  let want = 0; let have = 0;
  const untrusted = [];
  for (const o of ours) for (const ev of o.events) {
    want++;
    (hooks[ev] || []).forEach((g, gi) => (g && Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => {
      if (!isOurs(h, o)) return;
      have++;
      const key = stateKey(file, ev, gi, hi);
      const m = String(toml || '').split(`[hooks.state."${key}"]`)[1];
      const got = m ? (m.match(/^\s*trusted_hash\s*=\s*"([^"]+)"/m) || [])[1] : null;
      if (got !== trustHash(ev, g, h)) untrusted.push({ event: ev, script: o.script });
    }));
  }
  const state = have === 0 ? 'missing' : have < want ? 'partial' : untrusted.length ? 'untrusted' : 'ok';
  return { state, have, want, untrusted };
}

export function writeFile(file, raw, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (raw != null) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);
  }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return backup;
}
