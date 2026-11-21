// The one assistant interface (docs/ASSISTANTS.md). The rest of the board
// reaches what is particular to one AI coding assistant only through this
// module, as it reaches a terminal only through server/terminal.mjs: how its
// screen reads (prompt, spinner, dialogs, done line), what its prompt holds,
// its transcripts (context, model, last message), how a reply is typed, its
// menus, its rules file and what it can show at all. Nothing else imports an
// adapter.
//
// Which assistants there are is the registry's (server/assistants.mjs: ids,
// names, commands, capabilities, as data the clients are sent). Adapters:
// server/claude.mjs (Claude Code, the first), server/codex.mjs (OpenAI
// Codex) and server/opencode.mjs (OpenCode); a registered assistant with no adapter of its own gets the
// hook-only one (server/hookonly.mjs). A session carries `assistant` (a
// registry id) from its hook events (hooks/events.mjs, `ravenryd hook`),
// the way it carries `terminal`; a session or event with none, or with an
// id the registry does not have, is Claude Code, so every session recorded
// before there was a second assistant reads as it did.
//
// A tab's screen is read before the board knows its session, so the screen
// itself says which assistant draws it (detect): Claude Code's reading
// first, exactly as before, and Codex's only for a screen Claude Code's
// reading does not claim.

import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as hookonly from './hookonly.mjs';
import * as opencode from './opencode.mjs';
import * as registry from './assistants.mjs';
import { chooseOption as choose, readMenu as menuOf } from './choose.mjs';
import { tailLines } from './screen.mjs';

// The adapters written for one assistant; every other registered one is
// followed by its hooks alone.
const OWN = { claude, codex, opencode: opencode.adapter };
const ADAPTERS = Object.fromEntries(registry.IDS.map((k) => [k, OWN[k] || hookonly.make(k)]));
// Tried in this order on a screen no session names: Claude Code first.
const ORDER = registry.IDS;

export const DEFAULT = registry.DEFAULT;
export const KINDS = registry.IDS;

// The assistant of a session summary, an event line, or a kind string;
// anything unknown or missing is Claude Code.
export function kindOf(x) {
  const k = typeof x === 'string' ? x : x && x.assistant;
  return ADAPTERS[k] ? k : DEFAULT;
}

export function of(kind) {
  return ADAPTERS[kindOf(kind)];
}

export const nameOf = (kind) => of(kind).NAME;
// The registry's data of it (server/assistants.mjs): short, chip, caps, command.
export const entryOf = (kind) => registry.of(kindOf(kind));
export const can = (kind, cap) => registry.can(kindOf(kind), cap);
// What the clients are sent: every registered assistant, in order.
export const views = registry.views;
// What the board can show for this assistant's sessions (SUPPORTS in each
// adapter): suggestion, pictures, backgroundTasks, processes, recap, handoff.
export const supports = (kind, what) => !!of(kind).SUPPORTS[what];
export const rulesFile = (kind) => of(kind).RULES_FILE;
export const cmuxAgent = (kind) => of(kind).CMUX_AGENT;

// ------------------------------------------------------------ the screen

// Which assistant a screen shows, or null when none is live on it.
export function detect(text) {
  for (const k of ORDER) if (ADAPTERS[k].parseScreen(text).claudeLive) return k;
  return null;
}

// A read whose assistant is not known yet: { kind, screen } for the first
// assistant whose interface is live on it, else Claude Code's reading of it
// (a shell, an unreadable tab), exactly what the board read before.
//
// One exception: Claude Code's reading also takes Codex's approval menu for
// a dialog ("esc to cancel", numbered options), but never sees which option
// is selected there, since Codex marks it with "›" and Claude Code with "❯".
// A dialog of Claude Code's with no option marked, on a screen Codex's
// reading shows as its menu with one marked, is Codex's. Every Claude Code
// menu measured marks its selected option, so none of them moves.
export function parseAny(text) {
  const first = ADAPTERS[ORDER[0]].parseScreen(text);
  if (first.claudeLive && !(first.dialog && !first.dialog.options.some((o) => o.selected) && codexMenu(text))) return { kind: ORDER[0], screen: first };
  for (const k of ORDER.slice(1)) {
    const s = ADAPTERS[k].parseScreen(text);
    if (s.claudeLive) return { kind: k, screen: s };
  }
  return { kind: ORDER[0], screen: first };
}

function codexMenu(text) {
  const s = ADAPTERS.codex.parseScreen(text);
  return s.claudeLive && s.dialog && s.dialog.options.some((o) => o.selected) ? s : null;
}

// What a screen shows, in Claude Code's shape (server/screen.mjs): every
// adapter answers with the same fields. `claudeLive` is "this assistant's
// interface is live in the tab", whichever assistant it is.
export const parseScreen = (text, kind) => of(kind).parseScreen(text);
export const parseTitle = (title, kind) => of(kind).parseTitle(title);
export const trimScreen = (text, kind) => of(kind).trimScreen(text);
// The last n lines of a read, as `cmux read-screen --lines n` returns them.
export { tailLines };

// The prompt verdict for a fresh read of `tab`, kept with the read.
export const judgeRead = (kind, tab, screen, at) => of(kind).judgeRead(tab, screen, at);
// A tab's last read (`{ text, prompt }`) parsed, with `draft` holding only
// what the user typed.
export const judgedScreen = (kind, x) => of(kind).judgedScreen(x);
export function forget(surfaceId) { for (const a of Object.values(ADAPTERS)) a.forget(surfaceId); }

// ------------------------------------------------------------ typing

// Before a send into a prompt that holds text: { ok: true, bashOn } or a refusal.
export const checkPrompt = (kind, tab, screen, opts) => of(kind).checkPrompt(tab, screen, opts);
// Types a message and presses Enter.
export const typeMessage = (kind, tab, msg, opts) => of(kind).typeMessage(tab, msg, opts);
// The check before closing a tab whose prompt holds text (Claude Code only:
// the Sessions page closes Claude processes).
export const surePrompt = (kind, tab, screen, opts) => of(kind).surePrompt(tab, screen, opts);
export const withPrompt = (kind, screen, v) => of(kind).withPrompt(screen, v);

// A menu's option chosen with the arrows and Enter (server/choose.mjs), read
// with this assistant's screen reading.
// An assistant that answers a menu its own way (OpenCode: through its
// plugin and OpenCode's API, server/opencode.mjs) is given the session id.
export const chooseOption = (kind, opts) => (of(kind).chooseOption ? of(kind).chooseOption({ ...opts, parse: of(kind).parseScreen }) : choose({ ...opts, parse: of(kind).parseScreen }));
// A hook that waits on the hub for something only its adapter knows
// (OpenCode's plugin waiting for the board's answer to a permission):
// a promise of { stdout } or null; undefined when no adapter decides it.
export function decide(report) {
  const k = report && report.assistant;
  if (!k || kindOf(k) !== k || !ADAPTERS[k].decide) return undefined;
  return ADAPTERS[k].decide(report);
}
// OpenCode's models as `opencode models` lists them (New session's Model).
export const opencodeModels = (env) => opencode.modelList(env);
export const readMenu = (kind, text) => menuOf(text, of(kind).parseScreen);

// ------------------------------------------------------------ transcripts

export const findTranscript = (kind, sessionId, cwd) => of(kind).findTranscript(sessionId, cwd);
export const newestTranscriptFor = (kind, cwd, exclude) => of(kind).newestTranscriptFor(cwd, exclude);
export const readTranscript = (kind, file) => of(kind).readTranscript(file);
// Every conversation of a folder, as { path, sessionId } (not in order).
export const transcriptsFor = (kind, cwd) => (of(kind).transcriptsFor ? of(kind).transcriptsFor(cwd) : []);
// The repo a session works in, from its transcript's tool calls, or null.
export const workFolder = (kind, file) => of(kind).workFolder(file);
// The first thing typed into a session (a hand-off's fresh session starts
// with "Read the Hand-off section of").
export const firstPrompt = (kind, file) => of(kind).firstPrompt(file);
// The command that starts a fresh session of this assistant.
export const launchCommand = (kind, settings) => of(kind).launchCommand(settings);

// ------------------------------------------------------------ starting sessions
// Which assistant the board starts (docs/ASSISTANTS.md, "Starting
// sessions"): `startWith` in the registry settings for a new project (a
// registry id, 'claude' or 'codex'; Claude Code when unset), the New project form's choice over
// it; a new session for a project (Revive, start from brief, New session, a
// plan's start, and the sheet's "New sessions:" switch that shows it) is the
// project's own `assistant`, else startWith, else Claude Code. Never the
// assistant of the project's newest session: that one may be a throwaway
// check run in its folder. A hand-off's fresh session is not a new start:
// it continues with the assistant of the session it hands off from
// (server/index.mjs, the hand-off), not through here. A chosen assistant
// that is not installed gives way to the one that is, and the choice says
// so in `note`.

// The command New project, Revive and New session run, the prompt appended.
export const startCommand = (kind, settings) => of(kind).startCommand(settings || {});

// { claude, codex, ... }: which assistants are on this Mac, one key per
// registered one. Read at most every 30 s (the board asks on every tick).
let seen = { at: 0, key: '', value: null };
export function installedAll(settings = {}, env = process.env) {
  const key = JSON.stringify([settings.claudeBin || '', settings.codexBin || '', env.PATH || '', env.MC_CLAUDE || '', env.MC_CODEX || '', env.MC_OPENCODE || '', env.MC_CLAUDE_BIN || '', env.MC_CODEX_BIN || '', env.MC_CODEX_HOME || '', KINDS.join()]);
  if (seen.value && seen.key === key && Date.now() - seen.at < 30000) return seen.value;
  const value = Object.fromEntries(KINDS.map((k) => [k, !!ADAPTERS[k].installed(settings, env)]));
  seen = { at: Date.now(), key, value };
  return value;
}

export const isKind = (k) => KINDS.includes(k);

// The assistant to start: `wanted` (a form's choice, a project's), else
// startWith, else Claude Code; the installed one when it is missing.
// { kind, wanted, from, installed, fallback, note }.
export function startChoice(settings = {}, wanted = null, { from = null, installed = installedAll(settings) } = {}) {
  const set = isKind(settings.startWith) ? settings.startWith : DEFAULT;
  const want = isKind(wanted) ? wanted : set;
  const src = isKind(wanted) ? from || 'form' : isKind(settings.startWith) ? 'startWith' : 'default';
  const out = { kind: want, wanted: want, from: src, installed, fallback: false, note: null };
  if (installed[want]) return out;
  const other = KINDS.find((k) => k !== want && installed[k]);
  if (other) return { ...out, kind: other, fallback: true, note: `${nameOf(want)} is not installed on this Mac, so the board starts ${nameOf(other)} instead.` };
  const none = KINDS.length === 2 ? `Neither ${nameOf(KINDS[0])} nor ${nameOf(KINDS[1])} was found` : `None of ${registry.namesSaid(KINDS, 'or')} was found`;
  return { ...out, note: `${none} on this Mac; the board runs ${nameOf(want)}'s command as set.` };
}

// The assistant a new session for a project starts (Revive, New session, a
// plan's start) and the one its "New sessions:" switch shows: the project's
// own `assistant`, else startWith, else Claude Code. The project's sessions
// play no part, so the switch always shows what the next start runs.
export function continueChoice(settings = {}, project = null, opts = {}) {
  if (project && isKind(project.assistant)) return startChoice(settings, project.assistant, { ...opts, from: 'project' });
  return startChoice(settings, null, opts);
}

// ------------------------------------------------------------ print mode
// The board's own model calls (Plans, the Ideas thread, Get 3 directions,
// idea mockups) follow startWith too. Claude Code's are the `claude -p`
// command lines in server/config.mjs, unchanged; Codex's are one `codex
// exec` run each (server/codexexec.mjs): { ok, text, usage, model, error }.
// An assistant with no print mode (caps.print) gives way to the first
// installed one that has one, else Claude Code.
export function printWith(settings = {}) {
  const ch = startChoice(settings);
  if (registry.can(ch.kind, 'print')) return ch.kind;
  return KINDS.find((k) => registry.can(k, 'print') && ch.installed[k]) || DEFAULT;
}
export const runCodex = (opts) => codex.print(opts);
// What the board knows about Codex's model: the one config.toml names and,
// once a call found it refused, the one the board uses instead.
export function codexModel(settings = {}) {
  const st = codex.modelState();
  return { configured: codex.configuredModel(), refused: !!(st && st.refused), using: st && st.refused ? (settings.codexModel || st.using) : null, message: st ? st.message || null : null, setting: settings.codexModel || null };
}
