// The assistant registry: every AI coding assistant the board knows, as
// data the hub owns and sends to every client (docs/ASSISTANTS.md, "The
// registry"). A client draws the list it is sent (New session's assistant
// cards, the project's "New sessions:" switch, Settings, the session tag,
// the setup and doctor rows) and never types a second list of its own.
// What is particular to one assistant's screen, transcript and typing stays
// in its adapter behind server/assistant.mjs; its hooks' files in
// server/hookinstall.mjs. Adding an assistant is one entry here, one
// adapter and its hooks.
//
// No imports at all: the desktop's renderer bundles it through
// server/cpwords.mjs, and the desktop app runs server/firstlaunch.mjs in
// process while the board is not up. Finding an assistant on this machine
// (its binary, its login, its folders) is server/assistantfind.mjs.
//
// An entry:
//
//   id       the kind stored everywhere (projects.json `assistant`,
//            `startWith`, `models`, an event's `assistant`); never renamed
//   name     what people call it: "Start Claude Code in paper-boat"
//   short    the switches' word, where room is short: "Claude"
//   chip     the session tag: "Claude"
//   bin      its command, found on the PATH or where its installer puts it
//   home     its own folder: { env, xdg, dir } (CLAUDE_CONFIG_DIR, else
//            ~/.claude; `xdg`: the folder's name under XDG_CONFIG_HOME)
//   signIn   signed in when one of `env` is set, or `file` (in its home
//            folder, else the home folder) exists and, with `match`, holds it;
//            null: nothing to sign in to
//   command  how it is started: `start` the command, `resume`, `model` and
//            `prompt` the words added ("{id}", "{model}", "{prompt}"
//            filled), null when it has none; no `prompt`: the first
//            message is a word of its own, after `--` when it starts with
//            a dash
//   sessionId  the pattern of its session ids, when they are not UUIDs
//   hooks    how its hooks report: 'claude' (Claude Code's settings.json),
//            'codex' (Codex's hooks.json and trust entries), 'state'
//            (`ravenryd hook --assistant <id> --state <state>`, the
//            daemon's table for an assistant it has no table for),
//            'opencode' (Ravenry's plugin in its plugins folder, which
//            reports with `--state`); the installers are in
//            server/hookinstall.mjs
//   skill    where the Ravenry skill goes, under its home folder, or null
//   rules    the rules file it reads (CLAUDE.md, AGENTS.md)
//   caps     what the board can do with its sessions: resume (Continue,
//            Move here, Resume all), model (New session's Model), permission
//            (its hooks say when it asks for a permission), context (the
//            context bar), handoff (the hand-off at half context), print
//            (the board's own model calls: Plans, Ideas)
//
// The test assistant (`fake`, "Stand-in") is registered only in a test's
// process (TEST_RAVENRY=1, which home.mjs refuses outside the repository's
// .tmp) that also asks for it (TEST_RAVENRY_ASSISTANT=fake), so it never
// appears for a real user. It proves a third assistant flows through: the
// hub lists it, the clients draw it, it starts with its command and its
// hook events drive its state (hub/tools/assistants-test.mjs).

const CLAUDE = {
  id: 'claude',
  name: 'Claude Code',
  short: 'Claude',
  chip: 'Claude',
  bin: 'claude',
  home: { env: 'CLAUDE_CONFIG_DIR', dir: '.claude' },
  // ~/.claude.json, beside the folder, holds the login.
  signIn: { env: ['ANTHROPIC_API_KEY'], file: '~/.claude.json', match: '"oauthAccount"\\s*:\\s*\\{' },
  command: { start: 'claude', resume: ['--resume', '{id}'], model: ['--model', '{model}'] },
  hooks: 'claude',
  skill: 'skills/ravenry',
  rules: 'CLAUDE.md',
  caps: { resume: true, model: true, permission: true, context: true, handoff: true, print: true },
};

const CODEX = {
  id: 'codex',
  name: 'Codex',
  short: 'Codex',
  chip: 'Codex',
  bin: 'codex',
  home: { env: 'CODEX_HOME', dir: '.codex' },
  signIn: { env: ['OPENAI_API_KEY'], file: 'auth.json' },
  command: { start: 'codex', resume: ['resume', '{id}'], model: ['-m', '{model}'] },
  hooks: 'codex',
  skill: 'skills/ravenry',
  rules: 'AGENTS.md',
  caps: { resume: true, model: true, permission: true, context: true, handoff: true, print: true },
};

// OpenCode (opencode-ai on npm; measured on 1.19.6): its full-screen
// interface takes the first message with --prompt (a bare word is the
// folder to open), the model as provider/model with -m, and a session id
// (ses_...) with --session. Its states come from Ravenry's plugin in its
// plugins folder (hooks/opencode-plugin.js), which reports through
// `ravenryd hook --state` and answers a permission through OpenCode's own
// API. Nothing to sign in to: it ships free models, and a provider's key
// (OpenRouter's, say) is OpenCode's own business.
const OPENCODE = {
  id: 'opencode',
  name: 'OpenCode',
  short: 'OpenCode',
  chip: 'OpenCode',
  bin: 'opencode',
  // OPENCODE_CONFIG_DIR, else <XDG_CONFIG_HOME>/opencode, else ~/.config/opencode.
  home: { env: 'OPENCODE_CONFIG_DIR', xdg: 'opencode', dir: '.config/opencode' },
  signIn: null,
  command: { start: 'opencode', prompt: ['--prompt', '{prompt}'], resume: ['--session', '{id}'], model: ['-m', '{model}'] },
  sessionId: '^ses_[A-Za-z0-9]{8,64}$',
  hooks: 'opencode',
  skill: 'skills/ravenry',
  rules: 'AGENTS.md',
  caps: { resume: true, model: true, permission: true, context: true, handoff: true, print: false },
};

// The stand-in: a program that reports through `ravenryd hook --state`,
// with no screen the board reads and no transcript.
const FAKE = {
  id: 'fake',
  name: 'Stand-in Agent',
  short: 'Stand-in',
  chip: 'Stand-in',
  bin: 'ravenry-stand-in',
  home: { env: 'RAVENRY_STAND_IN_HOME', dir: '.ravenry-stand-in' },
  signIn: null,
  command: { start: 'ravenry-stand-in', resume: ['--resume', '{id}'], model: null },
  hooks: 'state',
  skill: null,
  rules: 'AGENTS.md',
  caps: { resume: true, model: false, permission: true, context: false, handoff: false, print: false },
  test: true,
};

// The process's environment where there is one (not in a renderer's bundle).
const ENV = typeof process !== 'undefined' && process.env ? process.env : {};

/** Is the test assistant asked for, in a test's process? */
export const testAssistantOn = (env = ENV) => env.TEST_RAVENRY === '1' && env.TEST_RAVENRY_ASSISTANT === 'fake';

/** Every registered assistant, in the order clients list them: Claude Code first. */
export function list(env = ENV) {
  return testAssistantOn(env) ? [CLAUDE, CODEX, OPENCODE, FAKE] : [CLAUDE, CODEX, OPENCODE];
}

// Read once for the process: the env a hub starts with decides.
const ENTRIES = list();
export const DEFAULT = 'claude';
/** The ids, in order. */
export const IDS = ENTRIES.map((a) => a.id);
export const isId = (k) => typeof k === 'string' && IDS.includes(k);
/** The entry of an id, or null. */
export const get = (k) => ENTRIES.find((a) => a.id === k) || null;
/** The entry of an id, else Claude Code's (a session or event that names none is Claude Code). */
export const of = (k) => get(k) || CLAUDE;
export const all = () => ENTRIES.slice();
export const nameOf = (k) => (get(k) ? get(k).name : null);
export const shortOf = (k) => (get(k) ? get(k).short : null);
export const chipOf = (k) => (get(k) ? get(k).chip : null);
export const can = (k, cap) => !!(get(k) && get(k).caps[cap]);

/** "claude or codex", "claude, codex or fake": the ids for a refusal's words. */
export function idsSaid(ids = IDS) {
  return ids.length < 3 ? ids.join(' or ') : `${ids.slice(0, -1).join(', ')} or ${ids[ids.length - 1]}`;
}

/** "Claude Code and Codex", "Claude Code, Codex and Stand-in Agent". */
export function namesSaid(ids = IDS, conj = 'and') {
  const n = ids.map((k) => of(k).name);
  return n.length < 3 ? n.join(` ${conj} `) : `${n.slice(0, -1).join(', ')} ${conj} ${n[n.length - 1]}`;
}

/** The words a resume or a model adds to its command, filled; [] when it has none. */
export function words(k, what, value) {
  const w = of(k).command[what];
  return Array.isArray(w) ? w.map((x) => x.replace('{id}', value).replace('{model}', value)) : [];
}

/**
 * The words a first message adds to its command: the registry's `prompt`
 * words (OpenCode's `--prompt <text>`, as one `--prompt=<text>` when the
 * text starts with a dash), else the text as one word, after `--` when it
 * starts with a dash (`claude -- '-x'`, `codex -- '-x'`).
 */
export function promptArgs(k, text) {
  const t = String(text);
  const w = of(k).command.prompt;
  if (Array.isArray(w)) {
    if (t.startsWith('-') && w.length === 2 && w[1] === '{prompt}') return [`${w[0]}=${t}`];
    return w.map((x) => (x === '{prompt}' ? t : x));
  }
  return [...(t.startsWith('-') ? ['--'] : []), t];
}

// A Claude Code or Codex session id: a UUID, kept in lower case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A session id as the board keeps it, or null: a UUID in lower case, or
 * an id in a registered assistant's own pattern (OpenCode's ses_..., whose
 * case matters) as it is. `k` limits it to that assistant's form.
 */
export function sessionIdOf(x, k = null) {
  const s = typeof x === 'string' ? x.trim() : '';
  if (!s) return null;
  const pat = (a) => (a.sessionId ? new RegExp(a.sessionId) : null);
  if (k && get(k)) {
    const p = pat(get(k));
    return p ? (p.test(s) ? s : null) : (UUID.test(s) ? s.toLowerCase() : null);
  }
  if (UUID.test(s)) return s.toLowerCase();
  return ENTRIES.some((a) => pat(a) && pat(a).test(s)) ? s : null;
}

/**
 * What a client is sent of each one (GET /api/state `assistants.list`,
 * GET /api/setup/start `assistants`, GET /api/settings/assistant): the
 * data above with no functions; `skill` as people read it is the hub's
 * to say (server/skills.mjs).
 */
export function view(k) {
  const a = of(k);
  return { id: a.id, name: a.name, short: a.short, chip: a.chip, bin: a.bin, command: a.command, hooks: a.hooks, skill: a.skill, rules: a.rules, caps: { ...a.caps }, ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.test ? { test: true } : {}) };
}
export const views = () => IDS.map(view);
