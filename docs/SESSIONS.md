# Sessions and memory

Every Claude Code process holds a few hundred MB, and idle ones pile up in
cmux tabs (20 processes, 10.2 GB on 2026-11-03). The top bar shows what they
hold, and the Sessions page closes the idle ones.

Design: [docs/design/CloseIdle.dc.html](design/CloseIdle.dc.html), variant
C's page reached from variant A's top-bar readout (C was the clearest, a
section of its own, opened from A's top button rather than a new tab). Code: `server/sessions.mjs` (processes, mapping, rules, records),
`server/index.mjs` (`buildSessions`, `closeOne`, `reopenSession`),
`server/terminal.mjs` (`close`, to `server/cmux.mjs` or `server/iterm.mjs`), `public/app.js` (`renderSessions`).

## Where it shows

- **Top bar:** "Claude 10.2 GB | 14 idle", before the light/dark button, on
  every view. It opens the Sessions page (`#/sessions`) in the main area and
  shows its "on" state there; no tab is highlighted, since Sessions has no
  tab. At phone width the same readout takes its own line under the tabs.
- **Sessions page:** the total, a memory bar split by state, the rule, then
  Handed off, No activity for 24 h or more and Left for you (ticked rows on
  the left), In use, Not mapped (only when there is one) and Recently closed
  on the right. The button closes the ticked rows.
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
   its iTerm2 tab from `ITERM_SESSION_ID` (docs/TERMINALS.md), and the board's own mapping
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

A row that cannot be ticked says why: no cmux or iTerm2 tab ("Outside cmux"), its tab
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
in cmux, `cmux close-surface --workspace <uuid> --surface <uuid>`, which ends Claude
and keeps the transcript. Both ids are always passed and cmux's own
`CMUX_*_ID` variables are left out of its environment, because without
`--surface` cmux closes `$CMUX_SURFACE_ID` or the focused tab, and the board
itself runs in a cmux terminal. No pid is ever signalled. After closing:
"Closed N sessions and freed X GB. Claude now uses Y GB.", with Y from a
fresh read; anything left open is listed with its reason.

## Recently closed and Reopen

`~/.ravenry/closed/<sessionId>.json`: `id`, `cwd`, `workspaceId`,
`workspaceRef`, `workspace`, `surfaceId`, `term` (`cmux` or `iterm`), `project`, `projectId`, `label`,
`lastLine`, `memKb`, `pid`, `closedAt`. Kept 14 days, then deleted when the
list is next read.

Reopen opens a NEW terminal tab (not focused) in the same workspace, or in the
workspace cmux shows now when that one is gone (a session closed in iTerm2:
a new tab in iTerm2's current window), runs
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
