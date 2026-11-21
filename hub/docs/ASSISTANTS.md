# Assistants

The board follows the AI coding assistants its registry lists (below):
Claude Code, OpenAI Codex, Antigravity CLI and OpenCode. Everything particular to one assistant goes
through one interface,
`server/assistant.mjs`, the way every terminal call goes through
`server/terminal.mjs` (docs/TERMINALS.md); nothing else imports an
adapter. The adapters are `server/claude.mjs` (Claude Code, the first),
`server/codex.mjs` (Codex), `server/opencode.mjs` (OpenCode, below) and `server/antigravity.mjs` (Antigravity CLI, below). Which assistant a session is comes from its hook
events, as its terminal does. A session or event that names none is Claude
Code, so everything recorded before there was a second assistant reads as
it did.

## The registry

Which assistants there are is data the hub owns: `server/assistants.mjs`,
sent to every client, so a client draws the list it is sent and never
types a second one (docs/FEATURES.md SESS-057). Each entry:

| Field | What | Claude Code | Codex | OpenCode | Antigravity CLI |
| --- | --- | --- | --- | --- | --- |
| `id` | the kind stored everywhere: projects.json `assistant`, `startWith`, `models`, an event's `assistant` | `claude` | `codex` | `opencode` | `antigravity` |
| `name`, `short`, `chip` | what people call it ("Start Claude Code in ..."), a switch's word, the session tag | Claude Code, Claude, Claude | Codex, Codex, Codex | OpenCode (all three) | Antigravity CLI, Antigravity, Antigravity |
| `bin`, `home` | its command, found on the PATH or the usual install folders; its own folder | `claude`, `CLAUDE_CONFIG_DIR` or `~/.claude` | `codex`, `CODEX_HOME` or `~/.codex` | `opencode` (also `~/.opencode/bin`), `OPENCODE_CONFIG_DIR`, else `XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` | `agy` (`~/.local/bin`), `~/.gemini/antigravity-cli` |
| `signIn` | signed in when a key is in the environment or its login file is there | `ANTHROPIC_API_KEY`, `~/.claude.json` with `oauthAccount` | `OPENAI_API_KEY`, `<home>/auth.json` | none: it ships free models | `GEMINI_API_KEY`, or its login keychain item (service `gemini`, account `antigravity`), asked without reading the secret |
| `command` | `start`, and the words `resume`, `model` and `prompt` add | `claude`, `--resume <id>`, `--model <m>`, the prompt as a word | `codex`, `resume <id>`, `-m <m>`, the prompt as a word | `opencode`, `--session <id>`, `-m <provider/model>`, `--prompt <text>` | `agy`, `--conversation <id>`, `--model <id>`, `-i <text>` |
| `sessionId` | its session ids' pattern when they are not UUIDs | | | `ses_...`, case kept | UUIDs |
| `hooks` | how its hooks report, and so which installer `server/hookinstall.mjs` uses: `claude` (settings.json), `codex` (hooks.json and trust entries), `opencode` (a plugin file), `antigravity` (a group in `~/.gemini/config/hooks.json` of `ravenryd hook --state` commands), `state` (`ravenryd hook --assistant <id> --state <state>`, no installer yet) | `claude` | `codex` | `opencode` | `antigravity` |
| `skill`, `rules` | where the Ravenry skill goes under its folder; the rules file it reads | `skills/ravenry`, CLAUDE.md | `skills/ravenry`, AGENTS.md | `skills/ravenry`, AGENTS.md | `skills/ravenry`, AGENTS.md (it also reads GEMINI.md) |
| `caps` | `resume` (Continue, Move here, Resume all), `model` (New session's Model), `permission`, `context`, `handoff`, `print` (Plans, Ideas) | all | all | all but `print` | all but `print`; `permission` from its screen |

Where clients read it: `assistants.list` in `GET /api/state` and `GET
/api/settings/assistant` (the switches, the tag, the words that name an
assistant), `assistants` in `GET /api/setup/start` (New session's cards,
each with `found` and `signedIn`), the rows of `GET /api/setup/skills` and
`GET /api/setup/hooks` (`rows`, which `ravenry doctor` lists), and
`assistantName` on a push message's session (the Android app's alert).
Before the first state, and from an older hub, a client shows Claude Code
and Codex as before. A stored id the registry does not have (an assistant
a later build added) reads as unset and is never rewritten.

An assistant with an adapter of its own is read on screen as before
(`server/claude.mjs`, `server/codex.mjs`); any other registered one gets
the hook-only adapter (`server/hookonly.mjs`): the board reads no screen,
prompt or transcript of it, and its state comes from its hooks. One whose
`hooks` is `state` says its state in its hook command (`ravenryd hook
--assistant <id> --state working|needs_you|idle|ended [--need
permission|question]`), and the hub records each report as the board's
event of that meaning (`stateInput` in `server/assistanthook.mjs`:
UserPromptSubmit, a Notification, Stop or SessionStart, SessionEnd), so
every state rule reads it as it reads Claude Code's.

Three more fields say what is particular to one: `stopContinue` (the word
its Stop hook takes to carry on, Antigravity CLI's `continue` in place of
Claude Code's `block`; `stopReply`), `quietResume` (its hooks say nothing
when a conversation is opened again, so the board notes the opening
itself, as a SessionStart would) and `limits` (what the board cannot do
with its sessions although its caps say it follows them, in words people
read; sent to every client).

**The test assistant.** `fake` ("Stand-in Agent", command
`ravenry-stand-in`, hooks `state`, no Model menu, no print mode) is
registered only in a test's process that asks for it: `TEST_RAVENRY=1`,
which `server/home.mjs` refuses outside the repository's `.tmp`, and
`TEST_RAVENRY_ASSISTANT=fake`. It never appears for a real user.
`node tools/assistants-test.mjs [OUT]` proves it flows through: the hub
lists it third (the state, New session's answer, Settings), a project set
to it starts its command in a labelled pane with the brief to read, its
`ravenryd hook --state` reports move the session through Working, Needs
you, the hand-back and the end with its tag, Set up refuses to write
Claude Code's or Codex's hooks for it, and the board page at 390 px shows
its New session card and "Start Stand-in Agent in <project>".

**Adding an assistant** (as OpenCode was, SESS-054): its entry in
`server/assistants.mjs`; an adapter when the board should read its screen
or transcript (else the hook-only one serves); its hooks (an installer,
doctor state and uninstall in `server/hookinstall.mjs`, or `--state` in
the hook commands it is given); its skill path; its model menu
(`server/models.mjs startMenus`); resume words that take its session ids
(`server/sessionstart.mjs` refuses a resume id that is not a UUID); the
hand-off Stop hook when `caps.handoff`. Session ids that are not UUIDs
are the registry's `sessionId` pattern (`sessionIdOf`), and a first
message that is not a word of its own is its `prompt` words (`promptArgs`).

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
| Started by the board (New project, Revive, New session, a plan's start) | yes | yes, by `startWith` or the project's own (below) |
| Plans, the Ideas thread, Get 3 directions, idea mockups | `claude -p` | `codex exec` (below) |
| Suggested reply in the prompt | yes | not shown: Codex has none |
| Pictures the session showed | yes | not shown |
| Background tasks holding a hand-off | yes | not shown: Codex's hooks list none |
| Memory and Close idle (Sessions page) | yes | listed with their memory; Close idle ends Claude Code sessions only |
| Recap line | yes | not shown |
| Rules view (Your rules) | CLAUDE.md | AGENTS.md, beside CLAUDE.md (below) |
| Rule suggestions | its transcripts; written to CLAUDE.md | its rollouts; written to AGENTS.md (below) |

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
| `workFolder`, `firstPrompt`, `launchCommand` | the repo its tool calls work in; the first prompt; the hand-off's fresh session's command | `server/folders.mjs`; `claude` (`handoffCommand`) | none (the hook's cwd decides); `codex` (`codexCommand`), with `-m` once the configured model is refused (below) |
| `startCommand`, `installedAll`, `startChoice`, `continueChoice` | the command New project, Revive and New session run; which assistants are on this Mac; which one starts (below) | `claude` (`launchCommand`) | as `launchCommand` |
| `printWith`, `runCodex`, `codexModel` | which assistant the board's own model calls use; one `codex exec` run; the model Codex runs | the `claude -p` command lines in `server/config.mjs` | `server/codexexec.mjs` |

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
- The hook's parent is Codex (`codex_pid`, never mapped to a process), past
  the Mac app's Node relay as for Claude Code (docs/SESSIONS.md).

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

**Codex in iTerm2 and Rex.** The same holds there: decided on 2026-11-06,
a Codex session in a Rex tab is watch only, as in iTerm2, for the same
reason. Measured: `codex` (0.166.0) started in a throwaway Rex tab started
the shared daemon (`codex app-server --listen unix:// --managed-daemon`,
its parent that tab's Codex), so its hooks would carry the environment of
whichever Rex pane started the daemon, and `REX_BLOCK` could name another
session's pane. Rex can say which program runs in each pane (`rex block
call -b <block> process`: Codex and its folder), but not which Codex
session that is, and two Codex tabs in one folder could not be told apart,
so the board does not guess. Nothing in the board is particular to Claude
Code for Rex: a Codex hook that runs outside the daemon (none does on
0.166.0) records `REX_BLOCK` like Claude Code's, and that session is
driven exactly as Claude Code's is (its screen, its menus, a message).

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

## Starting sessions

The board starts an assistant in four places: New project, Revive, the
message box's New session switch and a plan's start with no session at its
prompt (all through `server/create.mjs`), besides the hand-off's fresh
session, which runs the assistant of the session it hands off from.

- **New project**: the form's `assistant` (`'claude'` or `'codex'`), else
  the registry setting `startWith` (`'claude'` or `'codex'`; Claude Code when
  unset). A form value is kept on the project as `assistant`.
- **A new session for a project** (Revive, which starts it from its brief,
  New session, a plan's start): the project's `assistant`, else
  `startWith`, else Claude Code. The project's sessions play no part:
  until 0.3.1 a project with no `assistant` took the assistant of its
  newest session, so a throwaway Codex check run in its folder made the
  next Revive start Codex under a Claude Code setting. The sheet's "New
  sessions:" switch shows this same choice, so it always shows what the
  next start runs.
- **A hand-off's fresh session** continues the same work, so it runs the
  assistant of the session it hands off from (its hook events, else its
  marker), whatever the project or `startWith` say.
- **Not installed**: when the chosen assistant is not on this Mac and the
  other one is, the board starts the other and the answer says so
  (`assistantNote`: "Codex is not installed on this Mac, so the board starts
  Claude Code instead."). With neither found it runs the chosen one's
  command as set, and says that. Installed means the real binary on PATH or
  where its installer puts it, never cmux's shims (`cmux-cli-shims/`, the
  app's `Contents/Resources/bin/`); `MC_CLAUDE=0|1` and `MC_CODEX=0|1`
  decide in tests, and a test counts Codex only with a scratch
  `MC_CODEX_HOME`.
- **The command**: Claude Code's is `launchCommand` (`claude` by default) as
  before; Codex's is `codexCommand`, else `codex`, plus `-m <model>` once the
  board has measured the model in Codex's `config.toml` refused (Print
  mode, below): a session started on a refused model fails its first turn.
  The prompt is one shell word either way: `shellWord` (single quotes,
  `'\''` for an apostrophe) when the line is typed into a new tab's shell,
  `quoteWord` for cmux's `--command`, and words that start with a dash go
  after `--`. Measured on Codex 0.166.0: `codex '-x hello'` is "error:
  unexpected argument '-x' found", `codex -- '-x hello'` takes it as the
  prompt.
- **The API**: `GET /api/settings/assistant` and `assistants` in
  `/api/state` and `/api/meta`: `{ startWith, codexModel, starts, installed:
  { claude, codex }, fallback, note, print, codex: { configured, refused,
  using, message, setting } }`. `POST /api/settings/assistant` with `{
  startWith }` and/or `{ codexModel }` (a model name, or empty to clear) is
  written through the registry's settings path (a backup first, only those
  keys) and refused without the board's write header. `/api/project/new`
  and `/api/project/revive` answer with `assistant` and, when there was one,
  `assistantNote`. `POST /api/project/assistant` with `{ projectId,
  assistant }` (`'claude'`, `'codex'`, or `null` to follow
  `startWith`) sets a project's own assistant after it was created, through the
  registry's write path (a backup, only that key), refused without the
  board's write header; it answers with what the project now starts. The
  next New session, Revive and plan start use it; running sessions are not
  touched. On the page it is the sheet's "New sessions:" switch (below).
  `/api/state` gives each project `assistant` (the one its next session
  starts), `assistantWants` (the one it is set to: its own, else `startWith`, else
  Claude Code) and `assistantNote` (the fallback's note when
  those differ because one is not installed).

- **The page** ([docs/design/CodexStage2.dc.html](design/CodexStage2.dc.html),
  section 3, variant A): the Settings card opens on an Assistant section,
  "Start new sessions with" and a Claude / Codex switch (short labels, so
  the switch takes less space) that saves at once, with the fallback's note under it when the chosen one is
  not installed; New project has an Assistant row under Folder, set from
  Settings and sent only when changed for this project; and in a project
  whose new sessions start Codex (`assistant` on each project in `/api/state`), the
  New session switch's line reads "Opens a new cmux tab in <folder> running
  Codex, this project's assistant."
- **A project's switch** ([docs/design/ProjectAssistant.dc.html](design/ProjectAssistant.dc.html),
  round 2, A1): the sheet's meta line (folder, kind, stage, session) ends
  on "New sessions:" and the Settings Claude / Codex switch at the meta
  line's size, showing `assistantWants` (its title carries
  `assistantNote`). A flip saves at once through `POST
  /api/project/assistant` and shows at once; a failed save snaps back with
  the error beside the switch. Running sessions and their tags stay as
  they are. It is always shown, as the Settings section is, except on a
  session that is not in a project. The label and the switch are one item
  that never wraps inside itself, so on a phone they move to a row of
  their own together; their words sit on the line's baseline and the
  switch's extra height is taken off its layout box by negative block
  margins, so the line keeps its height (measured in `node
  tools/start-with-test.mjs`: 0 px apart at 1440, 412 and 390, the line 15
  px with and without it).

Measured live on 2026-11-04: a scratch board on :4697 with the real cmux,
`startWith: 'codex'` and the measured refusal; New session typed `codex -m
gpt-6-luna 'Reply with exactly: board-ok'` into a new tab of a throwaway
`mc-test-codexstart-*` workspace (its `CODEX_HOME`, through cmux's `--env`,
a scratch one), and Codex answered `board-ok` there.

## Print mode

The board's own model calls (Plans' drafts and revisions, the Ideas thread,
Get 3 directions, idea mockups, the repeats detector's classify and draft
calls) follow `startWith` too, with the same fallback (`printWith`), so a
Codex-only user keeps them. A job records the assistant it started on
(`who` on an idea's pending reply, mockup round and brainstorm, `busy.who`
on a plan draft), so every busy, restart and error line names that one
("Codex is still answering the last one.", "The board restarted while
Codex was drafting."), and a reply in an idea's thread is stored with
`who` set to the assistant that wrote it (`'codex'`; replies stored before
stay `'claude'`); the page shows it in the same reply style. Claude Code's are
`claude -p` exactly as before (`printCommand`, `planCommand`,
`mockupCommand` in `server/config.mjs`). Codex's are one `codex exec` run
each, in `server/codexexec.mjs`. The repeats detector's calls on Codex
take its schemas in the strict form (`strictSchema`: every property
required, no others), at low effort, in `~/.ravenry/repeats`.

Measured on Codex 0.166.0 (2026-11-04, a scratch CODEX_HOME):

- **The command**: `codex exec [-i <picture>]... --json --ephemeral
  --skip-git-repo-check --sandbox read-only --disable hooks --disable
  shell_tool --disable unified_exec` (and `plugins`, `apps`, `multi_agent`,
  `browser_use`, `computer_use`, `image_generation`, `in_app_browser`,
  `goals`, `sleep_tool`, `tool_suggest`, `skill_search`) `-c
  web_search="disabled" -c model_reasoning_effort="<effort>" [-m <model>]
  [--output-schema <file>] -C <folder> -`, the prompt on stdin, the real
  binary (not cmux's shim) and `CMUX_CODEX_HOOKS_DISABLED=1`, so cmux's
  wrapper adds nothing. Pictures go first: `-i` takes several values.
- **No tools**: asked to `cat` a file with the shell off, Codex answered
  that it could not run commands. So a call reads only what its prompt
  carries: a plan's attached pictures go in with `-i` and the other files'
  text after the prompt (40 KB each at most); an idea's pictures with `-i`.
- **No hooks**: a scratch `hooks.json`'s SessionStart and UserPromptSubmit
  hooks fired on a run without `--disable hooks` and not with it, so a
  board call never reaches Ravenry's events hook (it would show as a
  session).
- **An unknown feature is an error** ("Unknown feature flag: x"), so a tool
  flag a later Codex drops is taken out and the call run again.
- **Output**: JSONL. The answer is the last `item.completed` whose item is
  an `agent_message` (`item.completed` of type `error` are warnings);
  `turn.completed` carries `usage` (`input_tokens`, which include
  `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`), and
  `turn.failed` the error. There is no cost on a ChatGPT login, so the board
  logs tokens only ("plans: draft for x in 11.5 s, 10989 tokens in, 310
  out"). A one-word answer reads about 11,800 tokens in: Codex's own
  instructions.
- **Plans**: the plan's `SCHEMA` (already in the strict form) as
  `--output-schema`, the system words first in the prompt (exec has no
  system prompt), the folder `~/.ravenry/plans` (or its empty folder when
  files are attached), effort medium. The draft and revise prompts are the
  same as Claude Code's except the files sentence. Three real drafts (three
  real projects' briefs with their real rules, 27 to 52 of them) all passed the board's check and were written into a copy of the
  brief and read back by the plan parser step for step; at low effort one
  Settings change had no picture gate and opened on a "done" step, at
  medium it had the gate (12 to 18 s, 11,000 to 17,000 tokens in, 300 to 500
  out).
- **Ideas**: the thread, Get 3 directions and mockups at low effort, no
  schema (the answers are text, or the JSON array their prompts ask for), in
  `~/.ravenry/ideas`. A mockup round drew three 800x500 variants from
  Codex's HTML (75 s, 27,541 tokens in, 3,711 out).
- **The model**: Codex's `config.toml` names it; a model the account
  refuses fails the turn at once, before any token ("The 'gpt-5.4' model is
  not supported when using Codex with a ChatGPT account."). The board then
  runs the call again with `codexModel` from the registry settings, else
  Codex's own default (the first listed model of `codex debug models` by
  priority, gpt-6-luna: what Codex ran with no model configured), and keeps
  that in `~/.ravenry/codex-model.json` while `config.toml` names the same
  model, so later calls and sessions start on it. It never edits Codex's
  config.

## Rules

Codex reads `AGENTS.md` where Claude Code reads `CLAUDE.md`
(`rulesFile`). Your rules shows each scope (every project, then each project
folder that has either file) as two columns, the CLAUDE.md (tag "Claude")
and the AGENTS.md (tag "Codex"), each whole with its path; a missing file
says so, and on a phone the columns stack
([docs/design/CodexStage2.dc.html](design/CodexStage2.dc.html), section 4,
variant A; `server/rulefiles.mjs`, read only). Which AGENTS.md, measured on
Codex 0.166.0 from the strings in its binary ("AGENTS.override.md" then
"AGENTS.md" as one folder's candidates, "Failed to read global AGENTS.md
instructions from", and its prompt's "the AGENTS.md file at the root of the
repo and any directories from the CWD up to the root"): for every project
`<CODEX_HOME>/AGENTS.override.md`, else `<CODEX_HOME>/AGENTS.md`; for a
project the same two at its folder. An empty AGENTS.override.md is passed
over.

**Rule suggestions** (`server/repeats.mjs`) read Codex's sessions beside
Claude Code's, with the same clustering and thresholds:

- The rollouts under `<CODEX_HOME>/sessions/YYYY/MM/DD/` (`codexSessions`
  in the config; `MC_CODEX_HOME` in a test, and none without it), read a
  few new bytes at a time with the same per-file offset, size and inode.
  One folder holds every project's, so a rollout goes to the rule source
  whose folder its `session_meta` cwd is, else the deepest one holding it
  (the projects root takes only sessions started in it).
- Only the user's own prompts: user messages that are not Codex's own
  (`<environment_context>`, `<hook_prompt>`, `<turn_aborted>`) nor another
  agent's (`<task>`); the VS Code extension's "# Context from my IDE
  setup:" is cut down to the request after "## My request for Codex:". A
  session another program drove is skipped: `originator` Claude Code (its
  Codex plugin), `codex exec`, Codex as an MCP server, a subagent. Stored
  with `assistant: 'codex'`; a message with none is Claude Code's.
- A row says whose sessions said it ("Said 3 times in 2 Codex sessions",
  "in 3 sessions (Claude Code and Codex)"). With Codex messages stored, a
  draft may also match a line of the global (A) or a project's (Q)
  AGENTS.md.
- Accepting writes to the rules file of each assistant whose sessions said
  it, in the same scope as before: Add rule and Add to every project append
  to the global `CLAUDE.md` and/or `AGENTS.md`; a Reword replaces the
  matched line in its own file (and the same line in the other's file of
  that scope, when it is there) and appends the reworded line to the
  other's; a memory reword appends to the project's `CLAUDE.md` and/or
  `AGENTS.md`. The scope test is the same for both: a Codex session in a
  project is in that project's scope. Every file is checked before any is
  written; each gets the same timestamped backup first
  (`global-AGENTS-before-board-rule-*.md` beside the CLAUDE ones) and the
  same append-only section and one-line replace guard. The card's sentence
  names every file ("Adds this line to ~/.claude/CLAUDE.md and
  ~/.codex/AGENTS.md. A backup of each is made first."). A cluster only
  Claude Code's sessions said writes exactly what it did before.

## The assistant tag

Every session carries a small neutral word tag, "Claude" or "Codex" (not
"Claude Code", which takes more room): the Sessions card rows, the Live
screen header (whose freshness tooltip names the assistant too), the
Sessions page rows and the folder rows of sessions not in a project. Project
rows stay unmarked, since a project can hold both
([docs/design/CodexStage2.dc.html](design/CodexStage2.dc.html), section 2,
variant A).

## Codex processes

The Sessions page counts a process whose argv[0] is named exactly `codex`
(the native binary the npm package execs; its node launcher never counts),
when it runs Codex's terminal interface: no subcommand, `resume` or `fork`
(`codex --help`, 0.166.0). Every other subcommand (`exec`, which Plans and
Ideas run, `review`, `app-server` for the daemon and VS Code, `mcp`,
`login`...) is a helper. A Codex process maps to its session by cmux's hook
record or its tab, as a Claude Code one does (docs/SESSIONS.md), and `codex
resume <id>` names its session. Close idle never ends one.

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

`node tools/start-with-test.mjs [--real]` (Starting sessions, Print mode):
the launch command per assistant and the words through `/bin/sh`,
`startWith` and its fallback, a project's new sessions, the settings' check,
`codex exec`'s argv and output, a refused model and a missing feature
against `tools/stub-codex.mjs`, then a test board on :4695 with the fake
cmux and the stub (the settings routes, Revive, New session and New project
typing the chosen assistant, a plan, an Ideas reply, Get 3 directions and a
mockup round on Codex, and on `claude -p` again with `startWith: 'claude'`),
a test board on :4694 with no `startWith` (a project whose newest session
is Codex Revives on Claude Code and its switch shows Claude, both say Codex
with `startWith: 'codex'`, a project set to Codex starts Codex, a Codex
session's hand-off continues on Codex), and the page on a test board on
:4696 (the Settings section, the New project row, the New session line; `--shots <dir>` saves each at 1440x900
and 390x844, dark and light).
`--real` measures the leading dash on the real `codex`, runs one plan draft
through the real `codex exec` (a scratch CODEX_HOME, auth.json copied in and
deleted after) and the live New session above.

`node tools/assistant-test.mjs` (no board, no Codex run): Claude Code's
reading unchanged on every captured screen, Codex's screens, a Codex menu
chosen with the arrows, the events hook on Codex's real hook inputs, the
state rules on them, a rollout, the trust hash against cmux's, setup and
uninstall on a scratch CODEX_HOME holding cmux's hooks, and the hand-off
hook for Codex. Touches only `.tmp/`.

Measured live on 2026-11-04 (Codex 0.166.0, GPT-5.6-Luna at low effort, a
throwaway `mc-test-codex` cmux workspace, a scratch CODEX_HOME and a scratch
board on :4699; docs/DEVELOPING.md has the steps).

## OpenCode

Measured on OpenCode 1.19.6 (`opencode-ai` on npm, 2026-11-21), with a
scratch HOME and its free model `opencode/deepseek-v4.1-flash-free`
(`node tools/opencode-test.mjs`, below).

- **Starting**: its full-screen interface takes the model as `-m
  provider/model`, the first message as `--prompt <text>` (a bare word is
  the folder to open; one that starts with a dash goes as
  `--prompt=<text>`) and a session to continue as `--session <id>`. Its
  ids are `ses_` and 26 letters and digits whose case matters, so the
  board keeps them as they are (a UUID is still lower-cased).
- **Its plugin** is its hooks: OpenCode loads every file in
  `<its folder>/plugins/`, so Set up writes `plugins/ravenry.js` there
  (`hooks/opencode-plugin.js` with the path of ravenryd in it; ours by its
  first line, `ravenry-opencode-plugin`), Remove deletes it, the doctor's
  row is `opencodeStatus` (missing, ok, stale when its ravenryd is gone or
  it is an older plugin, foreign when that file is someone else's), and
  the app's hub brings a stale one up to date at start. OpenCode installs
  its plugin package (`@opencode-ai/plugin`) beside it on its next start;
  that is OpenCode's own `package.json` and `node_modules` in its folder.
  The plugin runs in the interface's own process (measured: its pid is the
  pane's, and RAVENRY_PANE is the pane's), and does nothing outside a
  Ravenry pane. It reports with `ravenryd hook --assistant opencode
  --state ...` on its events: a session first seen (SessionStart, idle),
  `session.status` busy (working), `permission.asked` (needs_you,
  permission, "Run <command>"), `permission.replied` (working again unless
  refused), `session.idle` (Stop, idle; the hub may answer it with the
  hand-off), `session.deleted` (ended); a subagent's sessions are left out.
  When the pane's program ends, the daemon reports the session ended.
- **A permission from the board**: the screen shows "△ Permission
  required" and "Allow once   Allow always   Reject" in place of the prompt
  box, which `server/opencode.mjs` reads as a dialog with those three
  options, so it is Needs you with three answers. The plugin then asks the
  hub what to answer (`ravenryd hook --event PermissionWait --decide`, 25 s
  at a time, again until it is answered); the hub holds that wait and,
  when the person picks an option on the board, gives it "once", "always"
  or "reject", which the plugin sends through OpenCode's own API
  (`permission.reply`, `POST /permission/<id>/reply`, else the older
  `/session/<id>/permissions/<id>`). No key is pressed. An answer given in
  OpenCode itself ends the wait.
- **Its session file**: the plugin keeps one JSON file per session under
  `<XDG_STATE_HOME or ~/.local/state>/ravenry/opencode/<id>.json` (model,
  its display name, the context in use: the last reply's tokens with the
  cache, the model's own window from OpenCode's provider list, the last
  message, the prompts, the hand-off's reason kept apart from the person's
  prompts) and names it as `transcript_path` in every report, so the model
  chip, the context bar, the last turn and the hand-off read it as they read
  a transcript (`server/opencodesession.mjs`).
- **The hand-off**: at its Stop the hub's answer (`{"decision":"block",
  "reason"}`) becomes the session's next prompt (the plugin sends it with
  OpenCode's API), and the next Stop carries `stop_hook_active`; its words
  name OpenCode, and the fresh session is `opencode --prompt '<read the
  hand-off>'`. Hand off now types the request at its prompt as for the
  others.
- **Its models**: New session's Model lists OpenCode's default, then what
  `opencode models` prints (read in the background, at most every 10
  minutes; OpenRouter's `openrouter/...` among them once OpenCode has its
  key, through OPENROUTER_API_KEY or `opencode auth login`), then any other
  it ran. The chip says the model without its provider.
- **The skill**: `<its folder>/skills/ravenry`, as for the others. OpenCode
  also reads `~/.claude/skills`, so with Claude Code's installed too it
  sees the same skill twice, with the same words.
- **Not done**: Plans and Ideas never run on OpenCode (`caps.print` off:
  they use the first installed assistant that has a print mode); an
  OpenCode session outside a Ravenry pane (cmux, iTerm2, Rex) is not
  followed, since its plugin reports only through a pane's daemon; a remote
  machine gets no plugin. OpenCode 2, installed by its own installer and not
  on npm yet, has a new plugin interface that does not load this one: the
  plugin will need its V2 form then.

`node tools/opencode-test.mjs [--keep]` runs all of it on the real
`opencode` (skipped when it is not installed): the registry's words, the
screen reading, then a scratch board with a real ravenryd and a scratch
HOME (OpenCode's config asks before every shell command), Set up and the
doctor's row, New session's card and Model menu, a session started with its
model and first message, Working, the permission as Needs you answered
from the board (Allow once), the turn's end with its model chip, context
and last message, Hand off now (the brief's Hand-off written, its commit
allowed from the board, the fresh OpenCode session started), Continue by
its id in a new pane, and Remove.

## Antigravity CLI

Measured on Antigravity CLI 1.5.14 (`agy`, signed in with a personal
Google account), 2026-11-21, in a scratch HOME whose `Library/Keychains`
links the login keychain (agy keeps its sign-in there, service `gemini`,
account `antigravity`, so a scratch HOME without that link is signed out),
a scratch project and a ravenryd pane (`node tools/antigravity-test.mjs`,
below).

- **Its hooks**: `~/.gemini/config/hooks.json` maps a group's name to its
  events (`{"<group>": {"<Event>": [handlers]}}`; PreToolUse and
  PostToolUse take `{matcher, hooks}`). Events seen: SessionStart (a new
  conversation's first message, just before its first model call; never
  when a conversation is resumed), PreInvocation and PostInvocation (each
  model call), PreToolUse and PostToolUse, Stop (the model's loop ended).
  None for a permission prompt, an interrupt (Esc ends the turn with no
  Stop) or the program's end (no SessionEnd; another group's
  Notification, SessionEnd and turn-completion entries never ran). Input
  is camelCase: `hookEventName`, `conversationId` (a UUID), `cwd`,
  `transcriptPath`, `modelName` (`gemini-3.8-flash-high`),
  `lastUserInput`, `workspacePaths`, `artifactDirectoryPath`; Stop adds
  `executionNum`, `terminationReason` (`NO_TOOL_CALL`), `fullyIdle`,
  `error` and `continuationActive`, which stayed false on the Stop after a
  continue. A PreToolUse answer must name a decision: `{}` refused the
  tool ("tool call denied by pre-tool hook"), so Ravenry has none there.
- **Where a hook runs**: as a child of the session's own `agy` process,
  with the pane's environment (`RAVENRY_PANE`, `RAVENRY_SOCKET`, and
  `ANTIGRAVITY_CONVERSATION_ID`), in `~/.gemini/config`. No daemon: each
  session is one process with no children at rest, so a report always
  names its own pane.
- **Ravenry's group**, `ravenry`: `<ravenryd> hook --assistant antigravity
  --state working --event SessionStart`, the same with `--event
  PreInvocation`, and `--state idle --event Stop --decide --timeout 8s`
  (timeout 15 s). The daemon reads the camelCase fields as the board's
  (`CamelAliases`: conversationId as session_id, transcriptPath,
  modelName as model), and the hub records each report as the board's
  event of that meaning (`reportsByState`), as for the stand-in. Set up
  adds the group before the file's last brace and Remove takes the same
  text out, so every other group keeps its bytes (measured on a file
  another program wrote with ` : ` and `\/`: back byte for byte); a file
  rewritten in between is read and written as JSON. A group named
  `ravenry` that runs anything else is left alone. The doctor's row is
  `antigravityStatus` (missing, ok, stale when its ravenryd is gone or
  the group is older, off when its `enabled` is false, foreign); the
  app's hub brings a stale one up to date at start. A test reaches only
  `MC_ANTIGRAVITY_HOME`.
- **Its screen** (`server/antigravity.mjs`): the prompt between two
  rules, and a footer whose right end is the model and its effort
  ("Gemini 3.8 Flash · high", after "auto · " in Auto mode); "esc to
  cancel" at its left while a turn runs, "? for shortcuts" at rest. That
  footer is its own mark: a screen with it is read as Antigravity CLI's
  before Claude Code's reading is tried, since Claude Code's reading takes
  its numbered menus and "esc to cancel" for its own (no captured Claude
  Code screen has it). Auto mode's placeholder ("Auto mode: edits & safe
  commands auto-approved") is not a draft.
- **A permission** has no event, so it is read from the screen:
  "Requesting permission for:", what, "Run this command?", the numbered
  answers with `>` at the selected one ("1. Yes, run command" ... "4. No,
  cancel"), and "↑/↓ Navigate" under them. It is Needs you with those
  answers, and the board picks one with the arrows and Enter
  (`server/choose.mjs`), as for Claude Code. Agy's PreToolUse fires before
  the prompt shows, so it says nothing about one. With its default Auto
  mode, safe commands and edits run without asking; the test turns Auto
  mode off (`agentMode: ""`, `toolPermission: request-review`) so the
  prompt shows.
- **Its transcript**: `transcriptPath`, `<~/.gemini/antigravity-cli>/brain/
  <id>/.system_generated/logs/transcript_full.jsonl`, plain JSON lines
  (`server/antigravitysession.mjs`): USER_INPUT (the message inside
  `<USER_REQUEST>`), PLANNER_RESPONSE (model, input_tokens,
  cache_read_tokens, output_tokens, its words, tool_calls), SYSTEM_MESSAGE
  (a Stop hook's reason is "Stop hook blocked termination: <reason>"),
  GENERIC (a tool's run). The context in use is the last response's
  input, cache and output tokens; it records no window, so the context bar
  uses the one from Settings. The conversation itself is also in
  `conversations/<id>.db` (SQLite with protobuf blobs), which the board
  does not read. Its folders come from `cache/conversation_metadata.json`.
- **The hand-off**: its Stop takes `{"decision":"continue","reason"}`
  (`stopReply`), which agy carries on with as a system message, and the
  next Stop knows it from the transcript (the note since the person's
  last message), since `continuationActive` does not say. Measured end to
  end: Hand off now while a permission was open waited for the Stop, the
  Stop's answer carried the session on, it wrote the brief's Hand-off
  (its edit and its commit asked, answered from the board), and the fresh
  session started with `agy -i '<read the hand-off>'`.
- **Resume**: `agy --conversation <id>` opens it (on exit it prints `agy
  --conversation=<id>`, read as the screen's resume id). No hook fires
  until the next message, so the board notes the opening itself
  (`quietResume`) and the new pane shows the session at once; a message
  typed from the board was answered in the same conversation.
- **Its models**: `agy models` prints an id and its label a line
  (`gemini-3.8-flash-high	Gemini 3.8 Flash (High)`, `claude-sonnet-4-6`,
  `gpt-oss-120b-medium`), read in the background at most every 10
  minutes; New session's Model lists them by label, and the chip says the
  label. A model seen with its assistant goes only to that assistant's
  menu, so its `claude-sonnet-4-6` never lands in Claude Code's.
- **The skill**: `~/.gemini/antigravity-cli/skills/ravenry` ("Global
  skills" in `/skills`; `~/.gemini/skills` is its shared folder, and
  `~/.agents/skills` is not read).
- **Not done** (the registry's `limits`): Plans and Ideas never run on it
  (it has a print mode, `agy -p`, not measured); a session outside a
  Ravenry pane is not followed; Esc is seen only from the screen (at rest
  20 s after); the context window is the one from Settings.

`node tools/antigravity-test.mjs [--keep] (--model | --no-model) [OUT]` runs it on
the real `agy` only when asked (with neither flag, the part without a
board only; skipped when it is not installed or lists no models):
the registry's words, its screens, its transcript and the hooks file
without a board, then a scratch board with a real ravenryd and a scratch
HOME: Set up and the doctor's row, the skill listed by agy, New session's
card signed in and its Model menu, a start with its model and first
message, Working, the permission as Needs you answered from the board,
Hand off now and its Stop's "continue", the hand-off written and the
fresh session started, the model chip, context and last turns, Continue
by its id with a message from the board, Remove back to the file's bytes,
and no browser opened (a PATH shim stands in for `open`). About ten model
calls on the cheapest model it lists with `--model`; `--no-model` makes none.

Every other test finds only stand-ins: each assistant a test, its board,
its ravenryd or its app would find as the person's own (on the PATH or in
the install folders the hub and the Mac app look in) gets a stand-in first
on their PATH (`tools/test-env.mjs`, guardSpawns; `node tools/test-env.mjs
path` for selftest.sh), and the person's own binary named by its path is
refused. Only `opencode-test` (OpenCode) and `antigravity-test` (agy) opt
in, with `useRealAssistant`. `node tools/assistants-guard-test.mjs` fails
when a test board could reach a real assistant without that.
