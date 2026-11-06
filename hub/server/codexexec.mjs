// Codex's print mode (docs/ASSISTANTS.md, "Print mode"): the board's own
// model calls (Plans, the Ideas thread, "Get 3 directions", idea mockups)
// as one `codex exec` run each, for a user whose new sessions start with
// Codex. Claude Code's print mode stays `claude -p` (server/config.mjs);
// this is the Codex half, reached only through server/codex.mjs and
// server/assistant.mjs.
//
// Measured on Codex 0.166.0 (2026-11-04, a scratch CODEX_HOME):
//
// - `codex exec --json ... -` reads the prompt on stdin and prints JSONL:
//   thread.started, turn.started, item.completed (agent_message: the text;
//   error: a warning), then turn.completed with `usage` (input_tokens, which
//   include cached_input_tokens, output_tokens, reasoning_output_tokens) or
//   turn.failed with `error.message`. No cost: a ChatGPT login has none, so
//   the board logs tokens only.
// - `--output-schema <file>` makes the last agent_message the JSON the
//   schema describes (the plan's SCHEMA is already in the strict form).
// - `--sandbox read-only` and `--disable shell_tool --disable unified_exec`
//   (and the other tools below): asked to `cat` a file, Codex answered that
//   it has no way to run commands. So a call reads only what its prompt
//   carries; pictures go in with `-i`.
// - `--disable hooks`: a scratch hooks.json's SessionStart and
//   UserPromptSubmit hooks fired without it and did not with it, so a board
//   call never reaches the user's own hooks (Ravenry's events hook would
//   show it as a session). CMUX_CODEX_HOOKS_DISABLED=1 keeps cmux's wrapper
//   from adding its own, and the binary is the real one, not cmux's shim.
// - An unknown feature name is an error ("Unknown feature flag: x"), so a
//   flag a later Codex drops is taken out and the call run again.
// - `--ephemeral` saves no rollout, `--skip-git-repo-check` runs in the
//   board's own folders, `-C` is the working folder.
// - A model the account refuses fails the turn at once, before any token:
//   "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
//   account." Codex's own default, with no model configured, was
//   gpt-6-luna (its rollout's turn_context), the first listed model of
//   `codex debug models` by priority. So the board uses the model in
//   Codex's config.toml, and when that is refused it runs the call again
//   with `codexModel` from the registry settings, else that default, and
//   remembers the refusal (<RAVENRY_HOME>/codex-model.json) while the
//   config names the same model.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

import { RAVENRY_HOME } from './home.mjs';
import { codexHome } from './codexrollout.mjs';

const H = os.homedir();
const MODEL_FILE = () => path.join(RAVENRY_HOME, 'codex-model.json');
// A model name the board may put on a command line.
export const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/;

// Tools a board call has no use for: the shell (so nothing outside the
// prompt is readable), and what reaches past this Mac or the screen.
export const NO_TOOLS = ['shell_tool', 'unified_exec', 'plugins', 'apps', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'goals', 'sleep_tool', 'tool_suggest', 'skill_search'];

// cmux puts shims for `codex` and `claude` first on a tab's PATH; they start
// its wrapper, which adds cmux's hooks to the run. The board wants the real
// binary.
export const isShim = (p) => /\/cmux-cli-shims(\/|$)/.test(p) || /\/Contents\/Resources\/bin\/[^/]+$/.test(p);

// The real `codex`: MC_CODEX_BIN, the setting, else the first one on PATH
// (or in the usual folders) that is not cmux's shim. null when none.
export function realBin(settings = {}, env = process.env) {
  if (env.MC_CODEX_BIN) return env.MC_CODEX_BIN;
  if (settings && settings.codexBin) return settings.codexBin;
  const dirs = [...String(env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', path.join(H, '.local', 'bin')];
  for (const d of dirs) {
    const p = path.join(d, 'codex');
    if (isShim(p)) continue;
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
}

// Is Codex on this Mac, for starting sessions and print mode? MC_CODEX=0|1
// decides in tests, and a test never counts the real one without naming a
// scratch CODEX_HOME (MC_CODEX_HOME), as setup does (server/hookinstall.mjs).
export function installed(settings = {}, env = process.env) {
  if (env.MC_CODEX === '0') return false;
  if (env.MC_CODEX === '1') return true;
  if (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME) return false;
  return !!realBin(settings, env);
}

// The model Codex's config.toml names at its top level, or null.
export function configuredModel(env = process.env) {
  // A test never reads the real ~/.codex.
  if (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME) return null;
  let txt = '';
  try { txt = fs.readFileSync(path.join(codexHome(env), 'config.toml'), 'utf8'); } catch { return null; }
  for (const line of txt.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*model\s*=\s*"([^"]*)"/);
    if (m) return m[1] || null;
  }
  return null;
}

// Codex's own default: the first listed model of `codex debug models` by
// priority (measured: what Codex picks with no model configured).
export function defaultModel(bin, env = process.env) {
  try {
    const out = execFileSync(bin, ['debug', 'models'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(env) });
    const j = JSON.parse(out);
    const ms = (Array.isArray(j) ? j : j.models || []).filter((m) => m && m.slug && m.visibility !== 'hide');
    ms.sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
    return ms.length && MODEL_RE.test(ms[0].slug) ? ms[0].slug : null;
  } catch { return null; }
}

// The environment of a Codex run: cmux's wrapper adds nothing, and a test's
// scratch CODEX_HOME is the one Codex reads.
export function childEnv(env = process.env, extra = {}) {
  const e = { ...env, CMUX_CODEX_HOOKS_DISABLED: '1', ...extra };
  if (env.MC_CODEX_HOME) e.CODEX_HOME = env.MC_CODEX_HOME;
  return e;
}

// ------------------------------------------------------------ the model

// What the board knows about the configured model: { configured, refused,
// message, using, at } while config.toml names `configured`, else null.
export function modelState(env = process.env) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(MODEL_FILE(), 'utf8')); } catch { return null; }
  if (!j || j.configured !== configuredModel(env)) return null;
  return j;
}

function rememberRefusal(rec) {
  try { fs.mkdirSync(RAVENRY_HOME, { recursive: true }); fs.writeFileSync(MODEL_FILE(), JSON.stringify(rec, null, 1) + '\n'); } catch { /* best effort */ }
}

// The model to run when the configured one is refused: the board's
// `codexModel` setting, else Codex's default.
function fallbackModel(settings, bin, env) {
  const own = settings && settings.codexModel;
  if (own && MODEL_RE.test(own)) return { model: own, from: 'codexModel' };
  const d = defaultModel(bin, env);
  return d ? { model: d, from: 'Codex default' } : null;
}

// The model a call starts with: null (Codex's configured one) unless that
// one is known to be refused.
export function startModel(settings = {}, env = process.env) {
  const st = modelState(env);
  if (!st || !st.refused) return null;
  const own = settings && settings.codexModel;
  return own && MODEL_RE.test(own) ? own : st.using || null;
}

// A failed turn whose message says the account cannot use the model.
export function isRefusal(msg) {
  return /model is not supported|not supported when using Codex|model[^.]*does not exist|unknown model|model_not_found|invalid model/i.test(String(msg || ''));
}

// ------------------------------------------------------------ one run

// The argv after the binary. `images` go first: `-i` takes several values,
// so a flag right after it ends the list before the "-" (stdin) prompt.
export function execArgs({ model = null, schemaFile = null, images = [], cwd, effort = 'low', drop = [] } = {}) {
  const args = ['exec'];
  for (const f of images) args.push('-i', f);
  args.push('--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'hooks');
  for (const f of NO_TOOLS) if (!drop.includes(f)) args.push('--disable', f);
  args.push('-c', 'web_search="disabled"');
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (model) args.push('-m', model);
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (cwd) args.push('-C', cwd);
  args.push('-');
  return args;
}

// Codex's JSONL into { ok, text, usage, error, refused }: the text is the
// last agent_message, usage the last turn.completed's.
export function parseExec(stdout) {
  let text = null;
  let usage = null;
  let error = null;
  let started = false;
  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (e.type === 'thread.started') started = true;
    if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
    if (e.type === 'turn.completed' && e.usage) {
      const u = e.usage;
      usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cached: u.cached_input_tokens || 0, thinking: u.reasoning_output_tokens || 0, cost: null };
    }
    if (e.type === 'turn.failed') error = (e.error && e.error.message) || 'the turn failed';
    else if (e.type === 'error' && !error) error = e.message || 'an error';
  }
  if (error && text == null) return { ok: false, error, refused: isRefusal(error), usage, started };
  if (text == null) return { ok: false, error: error || 'no answer', refused: false, usage, started };
  return { ok: true, text, usage, started };
}

const UNKNOWN_FLAG = /Unknown feature flag:\s*([\w.-]+)/;

// One `codex exec` run: { ok, text, usage, model, error, refused, stopped }.
// `schema` (an object) is written to a temp file for --output-schema.
// `onChild(child)` gets the process (for Stop); `stopped()` says it was
// stopped on purpose. A refused configured model is run again once with the
// fallback (fallbackModel), and remembered.
export async function run({ prompt, schema = null, images = [], cwd, timeoutMs = 3 * 60 * 1000, settings = {}, env = process.env, envExtra = {}, onChild = null, stopped = () => false, what = 'call', effort = 'low' }) {
  const bin = realBin(settings, env) || 'codex';
  let schemaFile = null;
  let tmp = null;
  if (schema) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-codex-'));
    schemaFile = path.join(tmp, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
  }
  const imgs = images.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  try {
    let model = startModel(settings, env);
    const drop = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const args = execArgs({ model, schemaFile, images: imgs, cwd, drop, effort });
      const r = await once(bin, args, { prompt, cwd, timeoutMs, env: childEnv(env, envExtra), onChild });
      if (r.stopped || stopped()) return { ok: false, stopped: true, error: 'Stopped.', model };
      if (r.timedOut) return { ok: false, error: `No answer after ${Math.round(timeoutMs / 1000)} s, so it was stopped.`, timedOut: true, model };
      if (r.spawnError) return { ok: false, error: `Could not run ${path.basename(bin)}: ${r.spawnError}`, model };
      const flag = (r.stderr.match(UNKNOWN_FLAG) || r.stdout.match(UNKNOWN_FLAG) || [])[1];
      if (flag && NO_TOOLS.includes(flag) && !drop.includes(flag)) { drop.push(flag); console.log(`codex: this Codex has no feature "${flag}", running the ${what} without that flag`); continue; }
      const p = parseExec(r.stdout);
      if (!p.ok && !p.started && r.code !== 0) {
        const why = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() || `exit ${r.code}`;
        return { ok: false, error: why.slice(0, 200), model };
      }
      if (!p.ok && p.refused && !model) {
        const fb = fallbackModel(settings, bin, env);
        const configured = configuredModel(env);
        if (!fb || fb.model === configured) return { ...p, model: configured };
        rememberRefusal({ configured, refused: true, message: p.error, using: fb.model, from: fb.from, at: new Date().toISOString() });
        console.log(`codex: the configured model ${configured || '(none)'} was refused ("${p.error}"), using ${fb.model} (${fb.from}) for the board's calls`);
        model = fb.model;
        continue;
      }
      return { ...p, model: model || configuredModel(env) };
    }
    return { ok: false, error: 'Codex did not run.', model: null };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function once(bin, args, { prompt, cwd, timeoutMs, env, onChild }) {
  return new Promise((resolve) => {
    if (cwd) fs.mkdirSync(cwd, { recursive: true });
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ spawnError: e.message }); return; }
    if (onChild) onChild(child);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      finish({ timedOut: true, stdout: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ spawnError: e.message, stdout: out, stderr: err }));
    child.on('close', (code, signal) => finish({ code, signal, stopped: signal === 'SIGTERM' && !timedOut, stdout: out, stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
