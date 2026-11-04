# How the board decides a state

Every project gets one of four states: **Needs you**, **Working**, **Waiting
on others**, **Idle**. The state comes from its Claude Code sessions, and each
session's state comes from several signals combined, because no single
signal is reliable on its own.

Code: `hooks/events.mjs` (the board's own Claude Code hook),
`server/events.mjs` (reads its events), `server/screen.mjs` (reads the
screen), `server/transcript.mjs` (reads the transcript), `server/state.mjs`
(decides: `eventState` first, `sessionState` as the fallback). The line under
the status on each project sheet names the source ("From hook events" or
"Read from the screen") and the reasons behind the current state.

## Events first, screen second

Reading terminal screens is fragile (cmux's own status was stale for four
workspaces on 2026-11-02), so the board has its own Claude Code hook,
`hooks/events.mjs`, separate from Agent Flow's. It runs on five events only,
SessionStart, SessionEnd, UserPromptSubmit, Notification and Stop (no
per-tool events, so it costs one Node start per event: about 37 ms here,
29 ms of which is Node itself). Each event appends one line to
`~/.ravenry/events/<session_id>.jsonl`:

```json
{"at":"2026-11-03T00:10:42.120Z","event":"Stop","session_id":"...","cwd":"...","transcript_path":"...","workspace_id":"<CMUX_WORKSPACE_ID>","surface_id":"<CMUX_SURFACE_ID>","ends_on_question":true,"question":"Should I wire the installer next?","background_tasks":0}
```

Every line also carries `claude_pid`, the Claude process that ran the hook
(its parent), which ties a process and its memory to a session
(docs/SESSIONS.md). Per event it also keeps: SessionStart `source` and `model`; SessionEnd
`reason`; Notification `notification_type`, `message` and `title` (capped);
Stop `ends_on_question`, `question`, `background_tasks` (entries still
running, server/tasks.mjs), `crons`, `stop_hook_active`, and `deferred` when the last
message is the hand-off hook's deferral line. The prompt text is never
stored. Then it POSTs the line to `http://127.0.0.1:4600/api/hook-event`
(300 ms at most, over a plain socket) so the board looks at once instead of
at its next 2 s tick; the board refuses that POST without its
`X-Ravenry` header. The hook never prints and always exits 0, the
board down or not. A file past 128 KB is cut to its last 200 lines, and files
untouched for 14 days are deleted at the next SessionStart.

Install: `node tools/install-hook.mjs` (both Ravenry hooks; see
docs/HANDOFF.md, Install).

### Which tab an event belongs to

1. **Surface id**: `CMUX_SURFACE_ID`, which Claude Code passes to its hooks.
   The newest session that reported from a tab is that tab's session, so a
   `/clear` or `/resume` in the same tab moves the tab to the new session.
2. **Session id**: when a tab's session is known some other way (the list in
   "Which session is in which tab" below), its events are found by id.
3. **Folder (guess)**: a tab with no session yet takes the newest live
   session whose hook `cwd` is the project folder and that reported from no
   open tab, before the newest-transcript guess.

A session whose events name no open cmux tab (another terminal, a board in
iTerm2 mode, or cmux not answering) is still shown, as "hook events, no
terminal tab", in "Which project a session seen only through its events is
in" (below). It has no screen, and the board cannot type into it.

### Events to states

| Last event | Session state |
| --- | --- |
| UserPromptSubmit | **working** |
| Notification `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | **dialog** (needs you), with the notification's message as the line |
| Notification `idle_prompt` | at rest, from the last Stop (below) |
| Stop with `background_tasks` > 0 | **working** (waiting on its tasks) |
| Stop | at rest: **asked** if it ends on a question and is under `questionHours` old, else **handback** under `handbackHours`, else **stale** (the same windows as below) |
| SessionStart (`startup`, `resume`, `clear`, `fork`) | at rest from the transcript's last finished turn; **stale** when nothing was asked yet |
| SessionStart `compact` | ignored (compaction can happen mid-turn) |
| SessionEnd | **none** (session gone) |

Other notification types (`auth_success`, `elicitation_complete`,
`elicitation_response`, `agent_completed`, `quota_auto_resume_*`,
`plugin_notification`) are recorded and change nothing.

### What the transcript and the screen still add

Events decide; these only fill what the hooks cannot see:

- **Transcript moved on.** Activity in the transcript more than 10 s after a
  Stop or a needs-you notification means Claude is working again: a stop
  hook continued the turn, or the permission was answered. (10 s, because
  the last message can land in the transcript just after Stop.)
- **Esc.** An interrupted turn runs no Stop hook. The transcript records
  `[Request interrupted by user]`; after a prompt event that means at rest.
- **A dialog on screen** counts at once; its Notification comes about 6 s
  later. A question dialog may never raise one at all.
- **A half-typed reply** on screen makes an at-rest session **draft**.
  Claude Code's suggested reply is not one ("The suggested reply", below).
- **A missing Stop.** A screen read more than 20 s after a prompt event that
  shows Claude at rest (no spinner, no `esc to interrupt`, no agents, no
  busy title) means the turn ended without a Stop.
- **A missing SessionEnd.** A shell on screen after the last event means
  Claude died without one: **none**. The other way round, Claude still on
  screen more than 20 s after a SessionEnd means a session the hook never
  saw, and that tab falls back to the screen rules.
- **No terminal at all.** A prompt event with no event and no transcript
  activity for `eventWorkingHours` (3 h) reads as **stale**, since nothing
  can show the turn ended.

A session with no events at all (started before the hook was installed, or in
a terminal where it is not installed) is read from the screen exactly as
below.

## Why not trust cmux's status

cmux's sidebar shows `claude_code=Running` or `Needs input`, and its hook
store records a lifecycle per surface. Measured on 2026-11-02 across the 18
workspaces, both were wrong often enough to be useless alone:

- A game project said **Running**; the screen showed Claude finished at 7:15 PM,
  ending on "Is E the direction, or do you prefer B or C?".
- A web project said **Running** for sessions that had been at an empty prompt for
  days.
- A VR project said **Running** while nothing in it worked: one tab held a
  half-typed reply, one had finished on Oct 11, one was a shell where Claude
  had exited.
- Agent-flow said **Needs input** for a session finished 4 days earlier with
  nothing asked.

So the cmux status is shown as a reason but never decides anything by itself.

## Signals

| Signal | Source | What it tells |
| --- | --- | --- |
| Prompt box | `cmux read-screen` | `────` / `❯ text` / `────` near the bottom means Claude Code is running in that tab. Text after `❯` is either a half-typed reply or Claude Code's dim suggested reply, which a plain read cannot tell apart; `server/suggestion.mjs` decides ("The suggested reply", below). Claude's dim `Try "..."` placeholder is ignored. |
| Prompt styles | `cmux rpc terminal.replay` | The render grid, a style per span. Faint text after `❯` is Claude Code's suggestion or placeholder; typed text is not faint. cmux only. |
| Shell below it | screen | A line like `Resume this session with:`, `➜  folder`, or `user@host:path %` after the box means Claude exited and a shell owns the tab. The `claude --resume <id>` line still names the last session. |
| Spinner line | screen | `· Beaming…`, `✻ Thinking…`, `✻ Waiting for 1 background agent to finish` above the box, or `esc to interrupt` in the footer, means working. |
| Background agents | screen footer | `◯ general-purpose ...` rows mean subagents are still running. |
| Done line | screen | `✻ Worked for 1h 7m · done 1:09 AM` means the last turn finished. The time has no date for the past week, so it is not used for age; the transcript is. |
| Dialog | screen | `Enter to confirm`, `Enter to select`, `Esc to cancel`, numbered `❯ 1.` options without a prompt box: a permission prompt or a question is open. |
| Title | `cmux tree` | Claude Code titles its tab `✳ Topic` at rest and a spinner glyph while busy. |
| Transcript | `~/.claude/projects/<cwd>/<session>.jsonl` | Last assistant text and time, last turn end (`turn_duration`), recap (`away_summary`), context use, whether activity came after the last turn end. File mtime is not used: idle sessions still get records appended. |
| Hook record | `cmux sessions --json` | Maps a surface to its session id; lifecycle shown, not trusted. |

## Session state

The screen rules, used for a session with no hook events (above).
Checked in this order; the first that matches wins.

1. **none**: no prompt box (or a shell below it). Not counted as a live session.
2. **dialog**: a dialog is open. Needs you.
3. **working**: spinner line, `esc to interrupt`, a running background agent,
   a spinner in the title, or the transcript is mid-turn and changed in the
   last 10 minutes.
4. **draft**: the prompt holds half-typed text. You started an answer, so it
   needs you (and the board refuses to type into it). Claude Code's
   suggested reply is not typed text: a prompt that shows one reads as the
   empty prompt below, and the reasons line says "the prompt shows Claude's
   suggested reply".
5. At an empty prompt after a finished turn:
   - **asked**: the last paragraph of Claude's last message asks a question,
     and the turn ended less than 14 days ago.
   - **handback**: the turn ended less than 36 hours ago.
   - **stale**: older than that.
   - **handed**: the session wrote its hand-off (docs/HANDOFF.md), so its
     last message is not a hand-back. Counts like stale.

## The suggested reply

After a turn ends, Claude Code (setting `promptSuggestionEnabled`, on by
default) shows a dim grey suggested reply after the `❯`, 2 to 6 s after the
done line (3.3 s measured on Claude Code 2.1.318). `cmux read-screen` and
iTerm2's AppleScript `contents` are plain text, so it reads exactly like a
half-typed reply; on 2026-11-04 a reply from the board was refused with
"There is half-typed text in its prompt" because of one.
`server/suggestion.mjs` is the one place that tells them apart; every rule
that reads `screen.draft` (the states above, the Sessions page's tags, the
composer, Send, Close, the plan runs) gets a screen it has judged, with
typed text in `draft` and a suggestion in `suggestion`.

Measured on 2.1.318 in cmux 0.64.20: a typed character, a paste, and a
typed `!` (bash mode) all replace the suggestion; Backspace to an empty
prompt brings it back; `?` on that prompt opens the shortcuts help instead
of typing.

Three signals, strongest first:

1. **The styled read** (cmux): `cmux rpc terminal.replay` returns the screen
   as a render grid with a style per span. The suggestion's spans are
   `faint`; typed text is not. Read only when the prompt holds text, and
   once per text (about 30 ms, like a read-screen). Definitive.
2. **The history of reads** (any terminal, no keystrokes), per tab: a turn
   is seen ending when a read shows the session working and a later one at
   rest, or when the done line changes. The text is a suggestion when it was
   not in the prompt while the turn ran, first showed up within 30 s of the
   turn's end, and has not changed since; a suggestion that comes back after
   the user typed and deleted their text is known by its text. Any other
   text is a draft. Not definitive, so only shown, never acted on.
3. **The probe** (only on a path that is about to type or close): the board
   types `1` and reads the prompt again. Over a suggestion the prompt holds
   just `1`; over typed text it holds the old text with the `1` in it
   (wherever the cursor was). Either way Backspace takes it back. For a
   `! command` the probe's character is the command's own `!`: over a
   suggestion bash mode opens empty and the command follows; over typed text
   the `!` is taken back. A digit, because in vim mode's NORMAL state a
   letter is a command that edits the text and a digit is only a count; when
   the prompt does not take the character, nothing more is pressed and the
   board says it could not tell. Definitive.

Send and Close use the styled read, else the probe; they never act on the
history. A board started while a session sat at rest has no history for it
and, in iTerm2, no styled read: the text then shows as **not** a draft,
because almost every session at rest holds a suggestion, and calling them all
half typed would flag most of the board after a restart; Send and Close still
probe before they act, so typed text is never mixed in or closed.

## Codex's screen

A Codex session (docs/ASSISTANTS.md) is read by `server/codex.mjs` into the
same fields, and the session rules above apply to it unchanged. Its events
come from Codex's hooks: PermissionRequest is recorded as a
`permission_prompt` Notification (dialog), and Interrupt (Esc, or No on an
approval) is at rest, "turn interrupted". A screen is Codex's only when
Claude Code's reading does not claim it, or when a live Codex session
reported from that tab. Measured on Codex 0.166.0 in cmux 0.64.20
(`tools/fixtures/codex/`); Codex draws on the alternate screen, so a read
holds the visible screen only, whatever lines are asked for.

| Signal | What it looks like | What it tells |
| --- | --- | --- |
| Composer | `› text` at column 0, its wrapped lines indented 2, a blank row, then 1 to 4 indented footer lines (`GPT-5.6-Luna low · ~/folder · Thread`, `← for agents · ? for shortcuts`, `tab to queue message`) | Codex is live in the tab. The text is typed text, except its dim placeholder `Ask Codex to do anything` (or `Ask a follow-up question`), fixed text in 0.166.0, which reads as empty. A `!` marker is shell mode (typed text). A `›` line followed by Codex's output is a prompt in the history, not the composer. |
| Spinner | `• Working (4s • esc to interrupt) · 1 background terminal running · ...` above the composer | working; the first part is the busy line |
| Done line | `  Worked for 1s • 12:04` | the last turn finished (time without a date) |
| Menu | numbered options with `›` on the selected one and a hint line: `Press enter to confirm or esc to cancel` (an approval), `enter continue · esc quit` (folder trust), `enter to submit answer` (a question) | dialog; its options are offered on the board, and chosen with the arrows and Enter |
| Exit | `To continue this session, run:` / `codex resume <id>`, or with Codex's daemon `Disconnected from this task.` / `To reconnect, run:`, then a shell prompt | none; the id names the last session. The daemon sends no SessionEnd, so this is how the board sees it gone. |
| Title | `⠙ Thread | folder` while it works (a braille spinner glyph), `[ ! ] Action Required | ...` while an approval waits, `Thread | folder` at rest | working when the glyph is there; the thread is the topic |

Codex has no suggested reply, so nothing in its composer is ever typed
over: text there is half typed, and Send refuses it as for Claude Code.
Claude Code's reading also takes Codex's approval menu for a dialog but sees
no option selected in it (`❯` against Codex's `›`); such a screen is Codex's
when Codex's reading shows its menu with one selected.

## Project state

1. **Needs you** if any session is dialog, asked or draft.
2. **Working** if any session is working.
3. **Waiting on others** if the project has a `waitingOn` in
   `~/.ravenry/projects.json` or a `Waiting on:` line in its brief.
   This is a manual flag; the board never guesses it.
4. **Needs you** if any session is a recent handback.
5. **Idle** otherwise. A project with no Claude tab is idle; its "last
   touched" time comes from the newest transcript its tabs name.

The session that set the state is the one the sheet shows first (its context,
its screen, the target of the composer). With several sessions in a project, a
Sessions card lists them and any can be picked.

The time windows live in the registry's `settings` (`handbackHours`,
`questionHours`, `workingMinutes`, and `eventWorkingHours` for events).

## Which session is in which tab

Tried in order, and the sheet says which one was used:

0. **hook events (surface id)**: the newest session that reported from this
   tab through `hooks/events.mjs` (see "Events first, screen second").
1. **cmux hook record**: `cmux sessions --json` lists the surface id with its
   session id and transcript path.
2. **cmux resume binding**: `cmux surface resume show --json` gives the
   `claude --resume <id>` command cmux would use to restart the tab.
3. **resume line on screen**: for a tab where Claude exited, the
   `claude --resume <id>` line it printed.
4. **hook events in the same folder (guess)**: a live session that reported
   from this folder and from no open tab.
5. **newest transcript in the folder (guess)**: last resort for a live prompt
   with nothing else.

## Which project a tab is in

cmux reports the folder Claude was started in, and many sessions start in
a projects folder such as `~/projects` and then work in one repo below it. So a tab's
project comes from where its session really works (`server/folders.mjs`):
every path its tool calls name (`file_path`, `path`, `notebook_path`, `cd`
and `git -C` targets, the cwd of a shell call without a path) is mapped to
its git repo root (a worktree counts as the repo it came from), and the repo
with more than half of the last 400 hits (at least 5) is the session's real
folder. When the tool calls name no clear repo, the repo around the `cwd`
its hook events report is used. Transcripts are read back from the end in growing chunks and then
only the bytes added since, cached per transcript.

When several projects list a workspace, each tab goes to, in order:

1. the project whose `surfaces` names the tab;
2. the project whose folder is the session's real folder, or the closest one
   around or inside it;
3. the workspace's home project, the one that names none of its tabs.

The hand-off hook resolves the same way (surface id from `CMUX_SURFACE_ID`,
real folder from the transcript), so a hand-off lands in the brief of the
tab's own project. The sheet shows a session's real folder in its payload as
`workFolder`.

### Not in a project

A cmux workspace no project lists is not left off the board
([docs/design/CodexStage2.dc.html](design/CodexStage2.dc.html), section 1,
variant C). Every tick its tabs are read like a project's, with the same
state, screen and transcript rules, and the workspace becomes a card of its
own (`unownedWorkspaces` in `server/index.mjs`): keyed `ws:<workspace id>`,
named after its folder (the sidebar's cwd, else a hook's or an event's, as an
imported workspace is named), with no brief, plan or notes, and nothing
written to the registry. It is on the board only while a session runs in it.

- One that needs you (a question, a menu or dialog such as Codex's "Trust
  this folder?", a hand-back) sits in Needs you by its folder name with a
  folder glyph; the quiet ones (working, idle) go to a "Not in a project"
  group under Idle. On a phone it is a dashed chip in its state's place, and
  an idle one joins the idle chip.
- Never shown: a workspace a hidden project lists, one in
  `ignoreWorkspaces`, one the board is opening right now for a project, and,
  on a real board, the tests' own `mc-test*` workspaces (a test board shows
  them). A folder too broad to hold a project (below) is never its folder,
  so no session is guessed into it by folder; the card is then named after
  the workspace.
- Its sheet answers like any project's (the Live screen, the menu's options,
  the message box without Add as note and the New session switch). **Add to
  a project** (`POST /api/project/add-workspace`, `registry.addWorkspace`)
  appends the workspace to the project picked, after a registry backup, and
  is refused when the project is gone or hidden or some project lists the
  workspace by then. **New project from this folder** opens New project with
  the name, Existing on that folder and the session's assistant filled in;
  the new project lists the workspace and nothing is opened
  (`createProject` with `adopt`).
- With `autoImport` on (the default), a new workspace becomes a project on
  the first tick, so this card mostly shows workspaces a registry with
  `autoImport: false` leaves out.

### Too-broad folders

A folder too broad to be one project's own never holds a session by folder:
`/`, `/Users`, the home folder and every folder above it, `~/Documents`,
`~/Desktop`, `~/Downloads`, `~/Library` and the like, the projects root, and
a folder in no git repo that holds other projects' folders
(`isBroadFolder` in `server/folders.mjs`). A project whose folder is one of
them (one was imported from a cmux workspace that sat in
`~/projects`) gets sessions only through its workspace ids. A
cmux workspace sitting in such a folder is imported with no folder, and a
hand-off never writes a HANDOFF.md into one.

### Which project a session seen only through its events is in

1. **Its workspace**: when a project lists the cmux workspace its events
   name, that project, exactly as in cmux mode (several: the order above).
2. **By folder**, never through a too-broad folder: the project closest
   around its hook `cwd`, where Claude was started, unless the project of the
   repo its tool calls work in sits deeper inside that one; with no project
   around the `cwd` (started in the projects root), the project closest
   around the repo it works in. So a session started in a project's repo
   that works mostly in another repo stays with that project.
3. **None**: in iTerm2 mode, an iTerm2 session whose folder no project holds
   becomes a project of its repo; started in a too-broad folder and working
   in no repo, it gets a card of its own for as long as it runs, named from
   its topic, with no folder, and nothing is written to the registry.

A project with no folder (`"folder": null`, an idea with no repo) keeps an
absolute brief; Open folder says it has none, and Revive opens a tab in its
cmux workspace, or in iTerm2 mode says there is nowhere to start one.

Measured 2026-11-02 on one Mac: a workspace's test tab worked in another
project's repo (142 of 142 hits) and its video tab in a third; a workspace
sitting in the projects folder held two unrelated tabs; another workspace
held a tab working in a sibling repo.

## Context

From the last assistant message with `usage` in the transcript:
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
(one session read 155,863 on 2026-11-02). The window is
`settings.contextWindow`, 1,000,000 by default, since the transcript does not
record it. The bar has a tick at 50%, the hand-off line.

## Known limits

- Hook events start with sessions that start (or resume) after the hook is
  installed; a session already running keeps the screen rules until then.

- A question asked mid-paragraph, not in the last paragraph, reads as a
  handback, not as "asked".
- A screen that cmux cannot read (tabs never opened since cmux started report
  `Failed to read terminal text`) falls back to the title only.
- An older cmux build (0.64.20 here) has no `surface.input_state`, so the
  board does its own check for a half-typed prompt or an open dialog before
  typing; see `sendMessage` in `server/index.mjs`.
- `terminal.replay` is not in cmux's CLI help (its mobile app uses it). A
  cmux without it gives no styled read, and the board falls back to the
  history and the probe.
- In iTerm2, a reply typed within 30 s of a turn's end in one go, between
  two reads, shows as a suggestion until it changes. Send and Close still
  probe first.
- parseScreen sees no prompt box while bash mode is on (`!` replaces the
  `❯`), so such a tab reads as "no Claude on screen" for that moment.
