// The one assistant interface (docs/ASSISTANTS.md). The rest of the board
// reaches what is particular to one AI coding assistant only through this
// module, as it reaches a terminal only through server/terminal.mjs: how its
// screen reads (prompt, spinner, dialogs, done line), what its prompt holds,
// its transcripts (context, model, last message), how a reply is typed, its
// menus, its rules file and what it can show at all. Nothing else imports an
// adapter.
//
// Adapters: server/claude.mjs (Claude Code, the first) and server/codex.mjs
// (OpenAI Codex). A session carries `assistant` ('claude' | 'codex') from
// its hook events (hooks/events.mjs), the way it carries `terminal`; a
// session or event with none is Claude Code, so every session recorded
// before there was a second assistant reads as it did.
//
// A tab's screen is read before the board knows its session, so the screen
// itself says which assistant draws it (detect): Claude Code's reading
// first, exactly as before, and Codex's only for a screen Claude Code's
// reading does not claim.

import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { chooseOption as choose, readMenu as menuOf } from './choose.mjs';
import { tailLines } from './screen.mjs';

const ADAPTERS = { claude, codex };
// Tried in this order on a screen no session names.
const ORDER = ['claude', 'codex'];

export const DEFAULT = 'claude';
export const KINDS = Object.keys(ADAPTERS);

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
export const chooseOption = (kind, opts) => choose({ ...opts, parse: of(kind).parseScreen });
export const readMenu = (kind, text) => menuOf(text, of(kind).parseScreen);

// ------------------------------------------------------------ transcripts

export const findTranscript = (kind, sessionId, cwd) => of(kind).findTranscript(sessionId, cwd);
export const newestTranscriptFor = (kind, cwd, exclude) => of(kind).newestTranscriptFor(cwd, exclude);
export const readTranscript = (kind, file) => of(kind).readTranscript(file);
// The repo a session works in, from its transcript's tool calls, or null.
export const workFolder = (kind, file) => of(kind).workFolder(file);
// The first thing typed into a session (a hand-off's fresh session starts
// with "Read the Hand-off section of").
export const firstPrompt = (kind, file) => of(kind).firstPrompt(file);
// The command that starts a fresh session of this assistant.
export const launchCommand = (kind, settings) => of(kind).launchCommand(settings);
