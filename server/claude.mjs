// The Claude Code adapter (docs/ASSISTANTS.md). The board reaches it only
// through server/assistant.mjs, as it reaches cmux only through
// server/terminal.mjs. Its parts are the modules that were written for
// Claude Code before there was a second assistant, kept where they were:
//   server/screen.mjs      the screen: prompt box, spinner, dialogs, done line, the Live screen's trim
//   server/suggestion.mjs  Claude Code's dim suggested reply told apart from typed text
//   server/transcript.mjs  ~/.claude/projects/<cwd>/<session>.jsonl: context, model, last message
//   server/tasks.mjs       a Stop hook's background tasks (read by the hooks)
//   server/folders.mjs     sessionFolder: the repo a session's tool calls work in
//   server/pictures.mjs    the pictures a session showed (index.mjs, only for Claude sessions)
// What this file adds was moved here from server/index.mjs unchanged: the
// prompt verdict for each read (judgeRead, judgedScreen), the check before
// typing over a prompt (surePrompt, checkPrompt) and the "! command" send
// (typeMessage).

import * as term from './terminal.mjs';
import { parseScreen, parseTitle, trimScreen } from './screen.mjs';
import * as suggest from './suggestion.mjs';
import { findTranscript, newestTranscriptFor, readTranscript } from './transcript.mjs';
import { sessionFolder } from './folders.mjs';
import { firstPrompt } from './handoff.mjs';

export const KIND = 'claude';
export const NAME = 'Claude Code';
// The word the board puts before "session" for a session it cannot name.
export const SHORT = 'Claude';
// The rules file a session reads: the global one and each project's own.
export const RULES_FILE = 'CLAUDE.md';
// What the board shows for this assistant's sessions.
export const SUPPORTS = {
  suggestion: true,   // the dim suggested reply in the prompt
  pictures: true,     // the picture card and gallery
  backgroundTasks: true,
  processes: true,    // memory and Close idle on the Sessions page
  recap: true,
  handoff: true,
  codeSpans: true,    // the Live screen's code spans, from the transcript's text
};
// The agent name cmux's own hook store gives this assistant's sessions.
export const CMUX_AGENT = 'claude';

export { parseScreen, parseTitle, trimScreen };
export { findTranscript, newestTranscriptFor, readTranscript };
export const workFolder = (transcriptPath) => sessionFolder(transcriptPath);
export { firstPrompt };

// The command that starts a fresh session (the hand-off's).
export const launchCommand = (settings) => (settings && settings.handoffCommand) || 'claude';

// What each tab's prompt holds: Claude's suggested reply or typed text
// (server/suggestion.mjs). The history of reads per tab, and the last styled
// read per tab, kept while its prompt text stays the same.
const promptHistory = suggest.createTracker();
const styledSeen = new Map(); // surfaceId -> { text, styled }

export function forget(surfaceId) { promptHistory.forget(surfaceId); }

// The verdict on what a fresh read's prompt holds (server/suggestion.mjs):
// { text, kind, sure, by }. Every read goes into the tab's history; a prompt
// with text also gets a styled read (cmux only), unless one was taken while
// the prompt held the same text.
export async function judgeRead(tab, screen, at) {
  const history = promptHistory.see(tab.surfaceId, screen, at);
  const text = screen.claudeLive ? screen.draft : '';
  if (!text) { styledSeen.delete(tab.surfaceId); return { text: '', kind: 'empty', sure: true, by: 'screen' }; }
  const seen = styledSeen.get(tab.surfaceId);
  if (seen && seen.text === text) return { text, ...suggest.judgePrompt({ text, styled: seen.styled, history }) };
  const g = await term.readStyled(tab).catch(() => null);
  const styled = g ? suggest.gridPrompt(g) : null;
  const v = suggest.judgePrompt({ text, styled, history });
  // Kept only when it read this very text (the prompt can move between reads).
  if (v.by === 'style') styledSeen.set(tab.surfaceId, { text, styled }); else styledSeen.delete(tab.surfaceId);
  return { text, ...v };
}

// A tab's last read, parsed, with `draft` holding only typed text and
// Claude's suggestion in `suggestion` (server/suggestion.mjs, withPrompt).
// Every state rule reads its screen through this.
export function judgedScreen(x) {
  const screen = parseScreen(x ? x.text : null);
  return suggest.withPrompt(screen, x && x.prompt && x.prompt.text === screen.draft ? x.prompt : null);
}

// The parsed screen with a verdict applied (Close's re-check).
export const withPrompt = suggest.withPrompt;

// Before typing into a prompt that shows text, or closing its tab: is that
// text Claude's suggestion or a half-typed reply? A fresh styled read
// decides when the terminal has one (cmux); otherwise the probe types one
// character and reads the prompt again (server/suggestion.mjs, probePrompt).
// `bang`: the message is a "! command", so the probe's character is its
// "!", which stays typed over a suggestion (then `bash` is true).
// { kind: 'suggestion' | 'draft' | 'unknown', sure, by, bash?, error? }
export async function surePrompt(tab, screen, { bang = false } = {}) {
  const g = await term.readStyled(tab).catch(() => null);
  const v = suggest.judgePrompt({ text: screen.draft, styled: g ? suggest.gridPrompt(g) : null });
  if (v.sure) return v;
  const p = await suggest.probePrompt({
    read: () => term.readScreen(tab, 40),
    type: (c) => term.typeText(tab, c),
    key: (k) => term.pressKey(tab, k),
    old: screen.draft, bang,
  });
  return { kind: p.kind, sure: p.kind !== 'unknown', by: 'probe', bash: !!p.bash, keys: p.keys, error: p.error || null };
}

// Text in the prompt before a send: Claude's suggested reply (a typed
// character, a paste and a typed "!" all replace it) or a half-typed reply,
// which is never mixed in (server/suggestion.mjs). Returns { ok: true, bashOn }
// or the refusal; `project` names the project in the log line.
export async function checkPrompt(tab, screen, { text, choice, where, project }) {
  const half = { ok: false, status: 409, error: `There is half-typed text in its prompt. Finish it in ${where} so it is not mixed in.` };
  if (screen.dialog) return half;
  if (choice != null) return { ok: false, status: 409, error: 'No choice is open on screen any more, so nothing was pressed.' };
  const v = await surePrompt(tab, screen, { bang: /^!\s*\S/.test(String(text || '').trim()) });
  if (v.kind === 'draft') return half;
  if (v.kind !== 'suggestion') return { ok: false, status: 409, error: `The board could not tell whether the text in its prompt is Claude's suggestion or a half-typed reply (${v.error || 'no answer'}), so nothing was typed. Look at it in ${where}.` };
  console.log(`send: the prompt in ${project} held Claude's suggested reply (${v.by}${v.keys ? ': ' + v.keys.join(' ') : ''}), typing over it`);
  return { ok: true, bashOn: !!v.bash };
}

// Smart punctuation back to what a shell expects: em dash to "--", en dash
// to "-", curly quotes to straight ones, a no-break space to a space.
export function plainCommand(s) {
  return String(s)
    .replace(/—/g, '--').replace(/–/g, '-')
    .replace(/[“”„«»]/g, '"').replace(/[‘’‚]/g, "'")
    .replace(/ /g, ' ');
}

// Types the message and presses Enter. { ok: true } or { ok: false, status, error }.
export async function typeMessage(tab, msg, { bashOn = false, where }) {
  // "! command" is Claude Code's bash mode. The prompt only enters it on a
  // TYPED "!"; pasted, the "!" stays in the command and the shell reads it as
  // "negate" (`! cd x && gh ...` ran nothing and exited 1). So type the "!",
  // give the prompt a moment to switch, then paste the command after it.
  const bang = /^!\s*/.exec(msg);
  if (bang && msg.length > bang[0].length) {
    // The probe may have typed the "!" already (bash mode is on).
    if (!bashOn) {
      const k = await term.typeText(tab, '!');
      if (!k.ok) return { ok: false, status: 500, error: k.err || `${where} refused the text.` };
      await new Promise((r) => setTimeout(r, 150));
    }
    // A shell command must reach the shell as typed. Text fields (macOS
    // smart punctuation, phone keyboards) turn "--" into an em dash and
    // quotes into curly ones, which breaks the command ("—otp=..." was read
    // as a tag name), so put the plain characters back.
    msg = plainCommand(msg.slice(bang[0].length));
  }
  const a = await term.pasteText(tab, msg);
  if (!a.ok) return { ok: false, status: 500, error: a.err || `${where} refused the text.` };
  await new Promise((r) => setTimeout(r, 120));
  const b = await term.pressKey(tab, 'enter');
  if (!b.ok) return { ok: false, status: 500, error: b.err || `${where} refused Enter.` };
  return { ok: true };
}
