# Assistants

The board follows two AI coding assistants: Claude Code and OpenAI Codex.
Everything particular to one assistant goes through one interface,
`server/assistant.mjs`, the way every terminal call goes through
`server/terminal.mjs` (docs/TERMINALS.md); nothing else imports an
adapter. The adapters are `server/claude.mjs` (Claude Code, the first) and
`server/codex.mjs` (Codex). Which assistant a session is comes from its hook
events, as its terminal does. A session or event that names none is Claude
Code, so everything recorded before there was a second assistant reads as
it did.

## What works for each

| | Claude Code | Codex |
| --- | --- | --- |
| State on the board (Needs you, Working, Idle) | yes | yes, from Codex's hooks, its screen and its transcript |
| Live screen | yes | yes |
| Answer from the board: a message, a "! command" | yes | yes |
| Pick a menu option (a permission, a question, the folder trust) | yes | yes: Codex's approvals and folder trust |
| Phone alerts and Mac notifications | yes | yes: a question, a hand-back, an approval waiting |
| Context bar | yes (window from Settings) | yes (the window the transcript records, 258,400 for GPT-5.6-Luna) |
| Hand-off at half context | yes | yes (below) |
| Suggested reply in the prompt | yes | not shown: Codex has none |
| Pictures the session showed | yes | not shown |
| Background tasks holding a hand-off | yes | not shown: Codex's hooks list none |
| Memory and Close idle (Sessions page) | yes | not shown: Codex sessions are not listed there |
| Recap line | yes | not shown |
| Rules view and rule suggestions | CLAUDE.md, memory, transcripts | not shown (below) |

"Not shown" means the board leaves it out for a Codex session; it never
shows Claude Code's data there instead.

## The interface

`server/assistant.mjs`, each call with the assistant's kind (`'claude'` or
`'codex'`):

| Call | What it gives | Claude Code | Codex |
| --- | --- | --- | --- |
| `kindOf(x)` | the assistant of a session, an event or a string; none is `'claude'` | | |
| `nameOf`, `supports(kind, what)`, `rulesFile` | "Claude Code"/"Codex"; what the board can show (`suggestion`, `pictures`, `backgroundTasks`, `processes`, `recap`, `handoff`, `codeSpans`); CLAUDE.md/AGENTS.md | | |
| `parseAny(text)`, `detect(text)` | which assistant a screen shows, and its reading | Claude Code's reading first, exactly as before | only on a screen Claude Code's reading does not claim |
| `parseScreen(text, kind)` | the screen in one shape (`claudeLive`, `working`, `busyLine`, `draft`, `dialog`, `done`, `resumeId`, `exited`, ...): `claudeLive` means "this assistant's interface is live" | `server/screen.mjs` | `server/codex.mjs` |
| `parseTitle`, `trimScreen` | the tab title; the Live screen's entries | `server/screen.mjs` | spinner glyph and thread name; Codex's own trim |
| `judgeRead`, `judgedScreen`, `forget` | what the prompt holds, per read and per tab | the suggested reply (`server/suggestion.mjs`) | typed text, or the placeholder |
| `checkPrompt`, `typeMessage` | the check before a send, the send | styled read or probe; "!" typed then the command pasted | text in the composer is never typed over; one paste, Enter |
| `chooseOption`, `readMenu` | a menu option by arrows and Enter (`server/choose.mjs`) | `❯` marks the option | `›` marks the option |
| `findTranscript`, `newestTranscriptFor`, `readTranscript` | the transcript, in `server/transcript.mjs`'s shape | `~/.claude/projects/<cwd>/<id>.jsonl` | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` (`server/codexrollout.mjs`) |
| `workFolder`, `firstPrompt`, `launchCommand` | the repo its tool calls work in; the first prompt; the fresh session's command | `server/folders.mjs`; `claude` (`handoffCommand`) | none (the hook's cwd decides); `codex` (`codexCommand`) |

The hook side, which must start fast, is `server/assistanthook.mjs` (no
imports, as `server/termenv.mjs` for the terminal): `assistantOf(argv)` reads
`--assistant=codex` from the hook's command, and `shape(assistant, input)`
gives a Codex event in the board's shape.

Codex is read only on a screen Claude Code's reading does not claim, so
every Claude Code screen reads as it did: `node tools/assistant-test.mjs`
checks every captured Claude Code screen (live, menus, prompts) against
`server/screen.mjs` as it was at 76873a4, before the interface. One
exception, measured: Claude Code's reading also takes Codex's approval menu
for a dialog ("esc to cancel", numbered options) but finds no option
selected in it, since Codex marks it with `›`; such a screen, when Codex's
reading shows its menu with one marked, is Codex's. Every Claude Code menu
marks its selected option with `❯`, so none moves. A tab whose live session
reported from it is read as that session's assistant.

## Codex's events

`hooks/events.mjs --assistant=codex` on SessionStart, SessionEnd,
UserPromptSubmit, Stop, PermissionRequest and Interrupt (Codex 0.166.0's
hooks reference, https://learn.chatgpt.com/docs/hooks, and its source at tag
rust-v0.166.0). Every line carries `assistant: "codex"`.

- **SessionStart** fires with the first prompt, not when Codex opens. Until
  then the tab is read from the screen only.
- **PermissionRequest** (an approval about to be asked) is recorded as Claude
  Code's `permission_prompt` Notification with the approval's reason as its
  message (`source_event: "PermissionRequest"`), so Needs you, the alert
  ("Waiting for permission") and the sheet read it the same.
- **Interrupt** (Esc, or No on an approval) is its own event: the turn ended
  without a Stop, at rest, nothing asked.
- **Stop** carries `last_assistant_message` and `stop_hook_active` as Claude
  Code's does; no `background_tasks`, so it records 0.
- A turn that ends in an error (an unsupported model) runs no Stop; the screen
  rule for a missing Stop covers it.
- The hook's parent is Codex (`codex_pid`, never mapped to a process).

**Codex's daemon.** Codex started outside cmux runs its sessions in one
shared app-server daemon (`codex app-server`), and its hooks run there with
the environment of whichever terminal started the daemon. Measured: a second
session opened in a new cmux tab reported the first tab's
`CMUX_SURFACE_ID`. So a hook whose parent is that daemon records no
terminal ids (`codex_daemon: true`), and the board finds the session's tab
from the screen and the folder (cmux), or shows it watch only. Inside cmux,
cmux's wrapper starts Codex with its hooks in the session's own process, and
the ids are the tab's own. On exit from the daemon the shell shows
"Disconnected from this task." and no SessionEnd comes; the board reads the
shell on the screen as the session gone.

## Codex's screen

docs/STATE-RULES.md, "Codex's screen", has the rules; captured screens are in
`tools/fixtures/codex/` (private).

## Codex's transcript

`server/codexrollout.mjs` reads a rollout into the shape of a Claude Code
transcript: context is the last request's `total_tokens` (input with cached,
and output) from the last `token_count` event, the window its
`model_context_window`, the model from `turn_context`, the last message from
the last assistant `output_text`, prompts from user messages that are not
Codex's own (`<environment_context>`, `<hook_prompt>`, `<turn_aborted>`),
turn ends from `task_complete` and `turn_aborted` (also an interrupt). A
rollout's tool calls are scripts, so the repo a session works in comes from
the hook's cwd.

## Hand-offs

Codex's Stop hook can hold a session: `{"decision":"block","reason":"..."}`
on stdout makes Codex carry on with the reason as its next prompt, and the
next Stop has `stop_hook_active: true` (Codex 0.166.0's reference; measured:
a scratch hook blocked once with "Reply with exactly:
BLOCKED-AND-CONTINUED", Codex showed "Blocked by hook" with the reason,
answered it, and the second Stop came with `stop_hook_active: true`). So
`hooks/handoff-stop.mjs --assistant=codex` runs the hand-off as for Claude
Code, with three differences: it reads the rollout's own context window,
its words name Codex ("let Codex compact", "a fresh Codex session"), and the
fresh session is `codex '<prompt>'` (`codexCommand` in the registry
settings). Measured end to end on a scratch board: Hand off now, the next
Stop blocked, Codex wrote the Hand-off section of the brief and asked to
commit (its sandbox keeps `.git` read only, so the commit is an approval,
answered from the board), the board saw it written, and its fresh session
opened in a new tab next to the old one.

## Rules

Codex reads `AGENTS.md` where Claude Code reads `CLAUDE.md`
(`rulesFile`). The Rules view and rule suggestions stay Claude Code's: they
read `~/.claude/CLAUDE.md`, Claude Code's memory and its transcripts.
Showing `AGENTS.md` there would be a new section of the page, which waits
for a picture first.

## Installing the hooks in Codex

`ravenry setup`, only when `codex` is on the PATH, shows the entries, asks,
backs both files up and writes:

- `<CODEX_HOME>/hooks.json` (`~/.codex/hooks.json`): one matcher group per
  event at the end of each event's list, `<node> <ravenry>/hooks/events.mjs
  --assistant=codex` on the six events (timeout 5 s, 3 s for SessionEnd and
  Interrupt, Codex's ceiling there) and `<node>
  <ravenry>/hooks/handoff-stop.mjs --assistant=codex` on Stop. Every other
  entry (cmux's) stays as it is, first in its list, so no other hook's index,
  and so its trust, moves.
- `<CODEX_HOME>/config.toml`: Codex runs a hook that is not managed only once
  it is trusted, `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]
  trusted_hash = "sha256:..."`, the SHA-256 of the hook's normalized identity
  as JSON with sorted keys (`trustHash` in `server/codexhooks.mjs`; it gives
  exactly the five hashes cmux wrote for its own hooks, which Codex
  accepted). Setup writes ours in one marked block (`# ravenry-codex-hook-trust
  begin` / `end`) and takes out any other table for one of our keys (one
  `/hooks` wrote). cmux starts Codex with `--dangerously-bypass-hook-trust`,
  so in cmux the entries are not needed; in any other terminal they are.
- `[features] hooks` is on by default in Codex 0.166.0 ("stable true"), so
  setup does not write it. A config that turns it off is left as it is, and
  setup and doctor say so.

`ravenry doctor` names a missing, partial, untrusted or stale Codex hook as a
note. `ravenry uninstall` takes out only our groups and the block, renaming
the trust keys of groups that came after ours; after a setup and an
uninstall, hooks.json has its hooks back and config.toml its exact bytes. A
test never reaches the real `~/.codex`: `MC_CODEX_HOME` names a scratch one,
and without it a test process counts Codex as not installed.

## Tests

`node tools/assistant-test.mjs` (no board, no Codex run): Claude Code's
reading unchanged on every captured screen, Codex's screens, a Codex menu
chosen with the arrows, the events hook on Codex's real hook inputs, the
state rules on them, a rollout, the trust hash against cmux's, setup and
uninstall on a scratch CODEX_HOME holding cmux's hooks, and the hand-off
hook for Codex. Touches only `.tmp/`.

Measured live on 2026-11-04 (Codex 0.166.0, GPT-5.6-Luna at low effort, a
throwaway `mc-test-codex` cmux workspace, a scratch CODEX_HOME and a scratch
board on :4699; docs/DEVELOPING.md has the steps).
