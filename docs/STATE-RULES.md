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
| Prompt box | `cmux read-screen` | `────` / `❯ text` / `────` near the bottom means Claude Code is running in that tab. Text after `❯` is a half-typed reply (Claude's dim `Try "..."` placeholder is ignored). |
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
   needs you (and the board refuses to type into it).
5. At an empty prompt after a finished turn:
   - **asked**: the last paragraph of Claude's last message asks a question,
     and the turn ended less than 14 days ago.
   - **handback**: the turn ended less than 36 hours ago.
   - **stale**: older than that.
   - **handed**: the session wrote its hand-off (docs/HANDOFF.md), so its
     last message is not a hand-back. Counts like stale.

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
