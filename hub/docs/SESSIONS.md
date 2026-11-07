# Sessions and memory

Every Claude Code process holds a few hundred MB, and idle ones pile up in
cmux tabs (20 processes, 10.2 GB on 2026-11-03). The top bar shows what they
hold, and the Sessions page closes the idle ones.

Design: [docs/design/CloseIdle.dc.html](design/CloseIdle.dc.html), variant
C's page reached from variant A's top-bar readout (C was the clearest, a
section of its own, opened from A's top button rather than a new tab). Code: `server/sessions.mjs` (processes, mapping, rules, records),
`server/index.mjs` (`buildSessions`, `closeOne`, `reopenSession`),
`server/terminal.mjs` (`close`, to `server/cmux.mjs`, `server/iterm.mjs` or `server/rex.mjs`), `public/app.js` (`renderSessions`).

## Where it shows

- **Top bar:** "Sessions 10.2 GB | 14 idle" (Claude Code's and Codex's), before the light/dark button, on
  every view. It opens the Sessions page (`#/sessions`) in the main area and
  shows its "on" state there; no tab is highlighted, since Sessions has no
  tab. At phone width the same readout takes its own line under the tabs.
- **Sessions page:** the total, a memory bar split by state, the rule, then
  Handed off, No activity for 24 h or more and Left for you (ticked rows on
  the left), In use, Not in a project (sessions in use whose workspace no
  project lists, docs/STATE-RULES.md), Not mapped (only when there is one)
  and Recently closed on the right. Each row has its assistant's tag,
  "Claude" or "Codex". The button closes the ticked rows.
- **Project sheet:** "Memory 849 MB" next to Context in the strip, for the
  session the sheet shows, and a figure per session in the Sessions card.

## Memory

RSS of every running `claude` process, from
`ps -axww -o pid=,ppid=,rss=,lstart=,command=`, read once a minute (and right
after a close or reopen). Only a process whose argv[0] is named exactly
`claude` counts: the Claude desktop app and scripts that merely mention
claude in a path do not. Helpers are skipped: `--chrome-native-host` and the
`mcp`, `doctor`, `update`, `install`, `config` and `plugin` subcommands.
Every other claude process counts in the total, mapped or not. Figures are
1024-based (849 MB, 10.2 GB), like Activity Monitor.

## Which session a process holds

Tried in order; the first that answers wins, and the row's tooltip names it.
A process none of them names is listed as **not mapped** by its working
folder, counted in the total, and never closed.

1. **hook events (pid):** `hooks/events.mjs` records `claude_pid` on every
   event. Claude Code runs a hook through `sh -c`, which execs a single
   command, so the hook's parent is Claude itself (measured: the throwaway
   session's events named pid 85485, its claude process). The newest session
   that reported from that pid since the process started wins, so a `/clear`
   or `/resume` inside a process moves it to the new session.
2. **cmux hook record (pid):** `cmux sessions --json` keeps the pid as well.
   A record older than the process start belongs to an earlier process that
   had the same pid, and is skipped.
3. **its tab:** the process's cmux tab comes from `CMUX_SURFACE_ID` in its
   environment (`ps -E`, read once per process), or, outside cmux and tmux,
   its iTerm2 tab from `ITERM_SESSION_ID` or its Rex pane from `REX_BLOCK` (docs/TERMINALS.md), and the board's own mapping
   of that tab (docs/STATE-RULES.md, "Which session is in which tab") names
   the session, unless that mapping was one of its guesses.
4. **launch argument:** `--session-id <id>` or `--resume <id>` in argv. Last,
   because a `/clear` in the session moves on from it. A `--fork-session`
   argument names the parent, so it is not used.

The tab is never taken from the tty cmux reports: on 2026-11-03 the tty in
`cmux tree` was stale for 4 of the 14 tabs cmux restored at launch (one
tab said ttys017, its claude ran on ttys000), while `CMUX_SURFACE_ID`
in the environment matched cmux's hook records for every process.

Measured 2026-11-03 on one Mac's 20 processes: 14 by cmux hook record (pid),
6 by their tab (cmux resume binding), 0 unmapped. The hook pid takes over as
sessions report after the hook change.

## Which group a session goes in

- **In use:** working, a dialog open, a background agent on screen,
  background tasks at its last Stop, a scheduled loop (`session_crons`), or
  activity in the last `idleHours` (24): its newest hook event, or the
  transcript's last prompt, tool result, message or turn end.
- **Left for you** (listed, not ticked): otherwise idle, but its last message
  ends on a question ("Asked you a question"), or its prompt holds a
  half-typed reply ("Half-typed reply", read from the screen with the same
  check that stops the board typing into a tab: `parseScreen().draft` judged
  by `server/suggestion.mjs`, so Claude Code's dim suggested reply is not
  one; docs/STATE-RULES.md, "The suggested reply").
- **Handed off** (ticked): its hand-off marker is `written` or `resumed`
  (docs/HANDOFF.md), at any age.
- **No activity for 24 h or more** (ticked): the rest.

A row that cannot be ticked says why: no cmux, iTerm2 or Rex tab ("Outside cmux"), its tab
is gone, Claude is not on screen in its tab (suspended, say), it is the tab
this board runs in, or two Claude processes share the tab.

## Closing

Manual only: the button closes the ticked rows, one at a time. Right before
each one the server checks again, fresh:

- the process is still alive with the same start time, and its environment
  still names that tab;
- the tab's screen shows Claude at its prompt, not working, no dialog, no
  half-typed reply (unless the user ticked a "Half-typed reply" row
  themselves). Text in the prompt is checked with the styled read, else the
  probe (docs/STATE-RULES.md, "The suggested reply"): Claude's suggested
  reply does not stop a close, text the board cannot place does;
- its events, transcript and hand-off marker still put it in Handed off, No
  activity or Left for you.

Then it writes the record and closes the tab through the terminal interface
(server/terminal.mjs): in iTerm2, AppleScript `close` on that one session;
in Rex, `rex block close <block>` on that one pane;
in cmux, `cmux close-surface --workspace <uuid> --surface <uuid>`, which ends Claude
and keeps the transcript. Both ids are always passed and cmux's own
`CMUX_*_ID` variables are left out of its environment, because without
`--surface` cmux closes `$CMUX_SURFACE_ID` or the focused tab, and the board
itself runs in a cmux terminal. No pid is ever signalled. After closing:
"Closed N sessions and freed X GB. Claude now uses Y GB.", with Y from a
fresh read; anything left open is listed with its reason.

## Recently closed and Reopen

`~/.ravenry/closed/<sessionId>.json`: `id`, `cwd`, `workspaceId`,
`workspaceRef`, `workspace`, `surfaceId`, `term` (`cmux`, `iterm` or `rex`), `termSession` (Rex: its Rex session), `project`, `projectId`, `label`,
`lastLine`, `memKb`, `pid`, `closedAt`. Kept 14 days, then deleted when the
list is next read.

Reopen opens a NEW terminal tab (not focused) in the same workspace, or in the
workspace cmux shows now when that one is gone (a session closed in iTerm2:
a new tab in iTerm2's current window; in Rex: a new tab in its Rex session
while that is there, else a new Rex session), runs
`cd <cwd> && claude --resume <id>` there (`launchCommand` from the registry
settings, default `claude`), and drops the record.

## Settings and test switches

- `idleHours` in the registry `settings` (default 24).
- `MC_IDLE_OVERRIDE="<session id>=<minutes>"`: that session alone counts as
  idle sooner. For a test board's own throwaway session only.
- `MC_CLOSE_ALLOW="<session id>,..."`: the board closes and reopens these
  sessions and refuses every other. Set it on every test board.
- `MC_NO_AUTOSTART=1`: the board never opens hand-off sessions (a test board
  reading the real registry must not race the real one).

## Proof (2026-11-03)

On a test board (:4610, scratch `RAVENRY_HOME` with a copy of the registry and the
real events folder linked read-only, `MC_CLOSE_ALLOW` and `MC_IDLE_OVERRIDE`
set to one fresh uuid): a `mc-test-sessions` workspace (never auto-imported)
with a shell tab and a tab running `claude --session-id <uuid>` in a scratch
folder. One message, then idle after a minute; mapped by hook events (pid).
Close: record written, pid 85485 gone, tab gone, shell tab kept, transcript
kept, SessionEnd recorded. Reopen: a new tab in the same workspace ran
`cd ... && claude --resume <uuid>`, showed the earlier exchange, and its
SessionStart (`resume`) named the new pid 17194; the record was dropped.
Closed again the same way, then the workspace was closed. The total matched
a fresh `ps` sum within 112 KB of 10,752,016 KB. `node tools/sessions-test.mjs`
covers the parsers, the mapping order, the groups and the records.

## Known limits

- A half-typed reply is seen only in a tab whose screen cmux can read; a tab
  never shown since cmux started cannot be read, and is re-read right before
  a close, which refuses when it cannot.
- "Mid-turn" for a session with no screen (outside cmux) comes from its
  events and transcript only; those rows cannot be closed anyway.

## Worktrees

`POST /api/sessions/start` with `worktree: true` (and a `projectId`, and
optionally a `name`) starts a parallel session on its own branch, so two
sessions of one project never write the same files
(`server/worktrees.mjs`):

- The branch is `ravenry/<slug of the name>` (`ravenry/session-<id>`
  without one, `-2` and on when it is taken), from the repository's HEAD,
  in a sibling folder `<parent>/<repo folder>-<slug>`. The session starts in
  the same subfolder the project's folder is in, its pane is labelled
  `ravenry.worktree: <branch>`, and its first prompt says where it works and
  that the person reviews and merges the branch. On this computer only for
  now; a project on another machine is refused.
- `<RAVENRY_HOME>/worktrees.json` records each one: surface id, pane,
  project, repository, folder, branch, base commit and base branch, state
  (`open`, `merged`, `discarded`).
- **The review pane's API.** `GET /api/sessions/<id>/diff` (open): the
  session's work against the merge base with the branch it came from,
  committed, uncommitted and untracked, as unified diff text (2 MiB at
  most, `truncated` past it) and `files` with added and removed counts.
  `GET /api/sessions/<id>/worktree` gives the record. Person rows:
  `POST /api/sessions/<id>/comment { file, line?, text, side? }` types
  "Review comment on <file> line <n>: <text>" into the session through the
  composer's send path (tagged `review` in the pane's input log);
  `POST /api/sessions/<id>/merge { mode: "ff" | "merge", message? }` merges
  the branch into the base branch in the repository's main work tree, as a
  fast-forward or a merge commit, never a squash, so the agent's own
  commits stay in the history. It is refused, with the files named, while
  the session has uncommitted changes, on a conflict (checked first with
  `git merge-tree --write-tree`, which touches no work tree), and as a
  fast-forward once the base branch moved; then the worktree is removed
  and the branch kept until the person deletes it. The record gets
  `merged: { mode, commit, before, tip, at }` (`before`: the base branch's
  commit before the merge, `tip`: the session branch's).
  `POST /api/sessions/<id>/unmerge` undoes it: the base branch goes back
  to `before` with `git reset --keep` (which keeps the main work tree's
  own changes, and refuses when they are in the way), only while it still
  points at the merge and is checked out; then the worktree comes back on
  the branch in the same folder (the branch made again at `tip` if it was
  deleted) and the record is `open` again, with `unmerged_at`.
  `POST /api/sessions/<id>/delete-branch` deletes a merged session's
  branch (`git branch -d`) and records `branch_deleted_at`.
  `POST /api/sessions/<id>/discard` throws the worktree and the branch
  away. `<id>` is the surface id, URL-encoded.
- The diff carries `check: { clean, conflicts, moved, ahead }`: whether
  the branch merges cleanly into the base branch now (`git merge-tree`,
  with the files that would conflict), how many commits the base branch
  gained since the session's merge base and how many the session made.
- In the board's state each session with a record has `worktree: {
  branch, folder, base, baseBranch, state, merged?, unmerged_at?,
  branch_deleted_at? }`.
- Every git command runs without a shell, with a timeout.
  `node tools/worktree-test.mjs` covers it on scratch repositories.

## Files each session changed

`GET /api/projects/<id>/files` (open read, `server/filesview.mjs`): for
each session of the project, the files its pane's hooks named (ravenryd
`pane.files`, the paths a PostToolUse hook gave), relative to the
repository's top folder, with `added` and `removed` from `git diff
--numstat` in the folder it works in (its worktree against its diff base,
else the project's work tree against HEAD; an untracked file counts its
lines; `unchanged` when git shows no change for it now, as after a
commit); and `you`, what changed in the project's work tree that no
session's hooks named. `{ ok, project, root, sessions: [{ surfaceId,
topic, assistant, pane, worktree, folder, files: [{ path, added, removed,
at, unchanged? }] }], you: [{ path, added, removed }] }`. A session on
another machine lists no files. Nothing is cached.

## A pane's last seconds, to a session

`POST /api/sessions/<id>/filmstrip { pane, last_ms? }` (person): the
daemon that holds the pane draws its last `last_ms` (default 20000, 1000
to 60000) as an animated GIF (`pane.frames`), the hub writes it into the
project's inbox (`<project>/.inbox/`, kept out of git) and types into the
session, through the composer's send path, "The <pane name> pane's last
<n> seconds, as an animation: <path>". Answer `{ ok, path, sent }`.
