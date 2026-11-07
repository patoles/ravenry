# Terminals

The board drives three terminals: cmux, iTerm2 and Rex. Every terminal
call goes through one interface, `server/terminal.mjs`; nothing else
imports an adapter. The adapters are `server/cmux.mjs` (the only code that
runs the cmux CLI), `server/iterm.mjs` (the only code that talks to
iTerm2) and `server/rex.mjs` (the only code that runs Rex's `rex` command).
Which terminal a session runs in is recorded per session by the events hook
from its environment. A session in any other terminal is watch only.

## The board's terminal: cmux mode, iTerm2 mode and Rex mode

The board itself runs in one terminal, `term.BOARD` in `server/terminal.mjs`,
and that is where it opens new work. It is decided once, at start, from
where the board was started:

| Started | Mode |
| --- | --- |
| `RAVENRY_TERMINAL=cmux`, `=iterm` (`iTerm2` too) or `=rex` | that one |
| in a cmux tab (`CMUX_SURFACE_ID` or `CMUX_WORKSPACE_ID`) | cmux |
| in a Rex tab (`REX_SESSION` or `REX_BLOCK`, unless `ITERM_SESSION_ID` is set with a `TERM_PROGRAM` other than `rex`: a Rex server started from iTerm2 hands iTerm2's variables to every Rex pane, and an iTerm2 tab started from a Rex pane gets Rex's) | Rex |
| in an iTerm2 tab (`ITERM_SESSION_ID`, or `TERM_PROGRAM=iTerm.app`) | iTerm2 |
| anywhere else (launchd, another terminal) | cmux when cmux is installed, else iTerm2 when it is, else Rex when its `rex` command is found, else iTerm2 (with none of them every session is watch only, and iTerm2 mode never needs its app) |

The `ravenry` command (bin/ravenry.mjs) decides before the board loads:
in a cmux tab it runs the board there (cmux mode) and opens the page in a
cmux browser pane above it; in an iTerm2 tab it opens the Ravenry tab
(below); in a Rex tab it sets `RAVENRY_TERMINAL=rex`, runs the board there
and opens the page in the default browser; anywhere else it sets
`RAVENRY_TERMINAL=iterm`, because cmux's socket refuses a process started
outside cmux, and opens the default browser.

A Mac has one of them in practice, so the modes do not mix:

- **cmux mode** is the board as it was: cmux workspaces are projects, and
  iTerm2 and Rex sessions are driven too while some session runs there.
- **iTerm2 mode** never runs the cmux CLI: `term.cmux` is a stand in that
  answers "no workspaces", "no hook records", and refuses to open a
  workspace, without starting a process, and `canDrive('cmux')` is false.
  New project and Revive open a NEW iTerm2 tab (Revive in the window of the
  project's own iTerm2 session, else iTerm2's current window) and type
  `cd <folder> && claude '<prompt>'` into it; Reopen and a hand-off's fresh
  session whose terminal is not known go to iTerm2; "Open in iTerm2" brings
  a session's tab forward and, for a project with no tab, says "<Project>
  has no open iTerm2 tab. Revive it to start one."; Mac notifications are
  always `osascript display notification`. A Claude session in an iTerm2
  tab, or in a terminal the board can only watch (with an event in the
  last 7 days and no SessionEnd), whose folder no project holds becomes a
  project of its repo folder (no workspaces), the way a new cmux workspace does in cmux mode
  (`autoImport: false` turns both off). A session whose events say cmux is
  watch only: "This session runs in cmux, and this board runs in iTerm2, so
  it only shows what the session's hook events say. Answer it in cmux."
  It stays in the project of its cmux workspace, as in cmux mode, and its
  Live card says "Watch only" where a read session says how fresh its
  screen is. A session started in a too-broad folder (the projects root)
  working in no repo gets a card of its own named from its topic, never a
  project named after that folder. The snapshot carries `board: { kind, name }`, and the page uses that name
  wherever it said cmux (New project's "Start in iTerm2", "Open in
  iTerm2", the Sessions page, toasts).
- **Rex mode** is iTerm2 mode with Rex in its place: no cmux call (the same
  stand in), and every rule above with Rex's name. Only where a new tab
  opens differs: New project opens a NEW Rex session named after the
  project, in its folder; Revive opens a new tab in the Rex session of the
  project's own Rex tab, else a new Rex session named after the project;
  a hand-off's fresh session opens a new tab in the old tab's Rex session;
  Reopen opens a new tab in the closed tab's Rex session while it is
  there, else a new Rex session. Each runs `cd <folder> && claude ...`
  typed into its shell, as in iTerm2. Nothing is shown in the Rex app:
  `rex new` and `rex window new --focus=false` change nothing on screen.
  iTerm2 sessions are still driven in Rex mode, as in cmux mode, and Rex
  sessions in iTerm2 mode.

There is no `npm run rex` beside `npm run iterm`: that tool exists to put
the page in iTerm2's own browser pane, and Rex (Beta 0.1.0) has no browser
block (`rex api call block_creator.list` lists the terminal and the
onboarding walkthrough only). `npm start` or `ravenry` in a Rex tab is Rex
mode, with the page in the default browser.

## Opening the board in iTerm2

`npm run iterm` (`tools/open-in-iterm.mjs`) is iTerm2's pinned "Ravenry"
workspace: one tab named Ravenry, the board page on top in iTerm2's own web
browser and an 8-row terminal below it running `npm start` in the repo,
which makes that board an iTerm2-mode board.

- **Ours only.** The two sessions carry the session variable
  `user.ravenryBoard` (`<port>:page`, `<port>:server`). The tool looks for
  them first: found, it brings that tab forward and, when its board does not
  answer, types the start command into its terminal again; it never reads,
  types into or closes a session without that variable. `--close` closes
  the two (one AppleScript call each: a session list walked while one of
  its sessions closes goes stale, and the second close was lost) and waits
  for the board to stop.
- **The page** is a Web Browser profile written to
  `~/Library/Application Support/iTerm2/DynamicProfiles/ravenry.json`
  (`"Custom Command": "Browser"`, `"Initial URL"` the board), "Ravenry
  board" for :4600 and "Ravenry board :<port>" for another port. iTerm2
  loads the file on its own; the tool retries "Can't find a profile" for 6
  s while it does. A data: URL as the first page loaded nothing (measured),
  and a browser session loads its first page once, so the terminal starts
  first and the page is split in when the board answers: through
  `tools/iterm-board-split.py` (the Python API's `split_pane(before=True)`,
  then the terminal set to 8 rows and the page grown by the same height,
  since a preferred size on the terminal alone shrank the window), else
  AppleScript's `split horizontally`, which can only put it below.
- **Browser Plugin.** iTerm2's browser needs `iTermBrowserPlugin.app`
  (bundle `com.googlecode.iterm2.iTermBrowserPlugin`, in /Applications per
  https://iterm2.com/browser-plugin.html). Without it, asking iTerm2 for a
  browser session puts up a modal "Browser Plugin Missing" alert, and
  while that alert is up iTerm2's Python API does not answer at all (seen
  on 2026-11-03). So the tool asks macOS for the plugin first
  (`NSWorkspace URLForApplicationWithBundleIdentifier`) and, without it,
  opens only the terminal in iTerm2 and the page in the default browser,
  saying why in one line.
- **A board already on the port** (cmux, launchd, by hand): only the page.
  Something else on the port: it says so and stops.
- **The command** is `cd <repo> && PORT=... npm start`, with every
  `RAVENRY_*` and `MC_*` variable set where the tool ran (not its own test
  hooks), so a scratch board stays a scratch board.
- A new window (`--window`, or when iTerm2 has none) is set to 1280 by 860
  points: a profile's 80 by 25 cells left the page a strip.

## The interface

A tab is `{ kind, surfaceId, workspaceId? }`. A cmux tab keeps the board's
old id, cmux's surface UUID, with its workspace UUID; an iTerm2 tab is
`iterm:<UUID>`, the session's unique ID; a Rex tab is `rex:<uuid>`, the
pane's block id (`REX_BLOCK` is `block:<uuid>`; Rex's ids are lower case,
iTerm2's upper). `kindOf(surfaceId)` tells them apart by the prefix, so the
page and the routes pass surface ids as before. In Rex a tab is a window
of a session and a pane is a block in a window; the board's "tab" is the
pane Claude runs in.

| Operation | `terminal.mjs` | cmux | iTerm2 | Rex | What the board uses it for |
| --- | --- | --- | --- | --- | --- |
| **List tabs** | `cmux.listWorkspaces()`, `listTabs('iterm')`, `listTabs('rex')` | `tree --all`: workspaces and their tabs | AppleScript: every window, tab and session (unique ID, window, tty, name) | `rex ls --json`, then `rex window ls -s <session> --json` per session (its windows and the blocks in their layers), then `rex block call -b <block> title` per terminal block | Finding each session's tab and its title (Claude's `✳ Topic`) |
| **Read screen** | `readScreen(tab, lines)` | `read-screen` (scrollback too) | AppleScript `contents` of the session: the visible screen only, trailing spaces and blank rows trimmed | `rex capture -b <block> --trim`: the screen and its whole scrollback, of which the board keeps the last lines, trailing spaces and blank rows trimmed | The screen rules (docs/STATE-RULES.md), the Live screen, the checks before typing |
| **Send text** | `pasteText(tab, text)` | paste buffer, so newlines arrive as written | AppleScript `write text ... newline no`; text with a line break goes as one bracketed paste (`ESC[200~ ... ESC[201~`) so it is not sent line by line | `rex send -b <block> -- <text>` (exact bytes, so a line break would be Enter): text with a line break goes as one bracketed paste, as in iTerm2 | The composer, quick answers, the command in a new tab |
| **Keys** | `pressKey(tab, 'enter' \| 'up' \| 'down')` | `send-key` | Enter: AppleScript `write text "" newline yes`. Up and Down: iTerm2's Python API (`server/iterm-keys.py`, `async_send_text` of `ESC[A` / `ESC[B`) | `rex send-key -b <block> enter\|up\|down\|backspace` (the arrows arrive as `ESC[A` / `ESC[B`) | Enter after a message; a dialog's option chosen with the arrows and Enter, read back after each step (server/choose.mjs) |
| **Focus** | `focus(tab)` | `select-workspace`, `focus-panel` | AppleScript `select` on the window, tab and session, then `activate` | `rex focus -s <session> <block>` (the session's active window and focus, on the server), then the Rex app (the client whose `info.kind` is `app` in `rex client ls --json`) is asked `rex -C <client> do session.select session_id=<session> window_id=<window>` | "Open in cmux" / "Open in iTerm2" / "Open in Rex" |
| **Open tab** | `openTab(kind, opts)` | `new-surface` in the workspace, next to the old pane, in the folder, not focused | AppleScript `create tab with default profile` in the old session's window (else the current window, else a new window); iTerm2 selects the new tab in that window but is not brought forward | `rex window new -s <session> <label> -c <folder> --focus=false --json` in the Rex session of `near` (a pane), else of `session`; with neither open, `rex new <label> -c <folder> --json`, a new Rex session. Neither shows anything in the app | The hand-off's fresh session; Reopen; New project and Revive outside cmux mode |
| **Close** | `close(tab)` | `close-surface` with both ids, the board's own tab variables left out | AppleScript `close` on that session | `rex block close <block>`; the Rex session stays, empty when that was its last tab (Reopen opens its tab there again) | Close idle sessions |

The board then types the command into the new tab and presses Enter, the
same for every terminal. A new iTerm2 tab starts where its profile says, so
its command is `cd <folder> && claude ...`; a Rex tab opens in the folder
already, and gets the same command line.

Every `rex` call passes `--autostart=false`, so the board never starts a
Rex server. A full block id needs no `-s <session>` (measured), so the
reads and writes name the block only.

cmux also has extras the board uses when they are there and does without
otherwise: `listHookSessions()` (cmux's own hook store), `resumeBinding()`,
`sidebarState()` (folder and branch per workspace), `watchEvents()` (a hint
to refresh sooner), `newWorkspace()` and `currentWorkspace()` (New project,
Revive, Reopen's fallback) and `notify()` (Mac notifications). They are
reached as `terminal.cmux.*`. Rex's extras are `rexCheck()` (`rex whoami
--json`: the command found, the server answering, its API revision; below)
and `rexWatch(sessions, onEvent)`: one `rex events -s <session> --json` per
Rex session holding a tab the board reads (block events come only per
session), whose `title_changed`, `bell`, `desktop_notification`,
`process_changed` and `child_exited` make the next refresh come sooner, as
cmux's events do; nothing is decided from them. The board ends the streams
when it exits (seen: a stream with no event to write ran on after its
board stopped). The registry still names cmux workspace UUIDs per
project; iTerm2 and Rex sessions join projects by folder, like any session
the events report (below). New project and Revive open cmux workspaces in
cmux mode, iTerm2 tabs in iTerm2 mode and Rex sessions or tabs in Rex mode
(above).

## Which terminal a session runs in

`hooks/events.mjs` records `terminal` (and `terminal_id` when the terminal
has one) on every event, from the environment Claude Code runs in
(`server/termenv.mjs`):

| Environment | `terminal` | `terminal_id` |
| --- | --- | --- |
| `CMUX_SURFACE_ID` (checked first: a cmux tab may inherit another terminal's variables) | `cmux` | none; `surface_id` and `workspace_id` as before |
| `TMUX` | `tmux` (watch only: the outer terminal's ids would name the tmux client, not the pane) | none; `pane` is `TMUX_PANE` |
| `REX_BLOCK`, unless `ITERM_SESSION_ID` is set with a `TERM_PROGRAM` other than `rex` (checked before iTerm2: a Rex server started from an iTerm2 tab hands `ITERM_SESSION_ID` to every Rex pane; Rex sets `TERM_PROGRAM=rex`) | `rex` | `block:<uuid>`; `terminal_session` is `REX_SESSION` (`session:<uuid>`) |
| `ITERM_SESSION_ID` | `iterm` | `w0t1p0:<UUID>`; the UUID is the session's unique ID in AppleScript and the Python API |
| `TERM_PROGRAM=Apple_Terminal` and `TERM_SESSION_ID` | `apple-terminal` | `TERM_SESSION_ID` |
| `WEZTERM_PANE`, `KITTY_WINDOW_ID`, else `TERM_PROGRAM` (vscode, ghostty, WezTerm, ...) | that name | none |

`server/events.mjs` keeps the latest `terminal` (and `terminalSession`)
per session. The Sessions page reads `ITERM_SESSION_ID` and `REX_BLOCK`
from a claude process's environment too (outside cmux and tmux, by the
same rule as above when both are set), so an idle iTerm2 or Rex session can
be closed from there.

## What the board does with each

- **cmux**: as before. Tabs come from cmux's tree; events, cmux's hook
  store, resume bindings and the screen map them to sessions.
- **iTerm2**: the board asks iTerm2 for its sessions only while some
  session's events place it in iTerm2 (not ended, seen in the last week) or
  a claude process runs there, so with no iTerm2 session it never calls
  osascript, and it never launches iTerm2 (every script checks that it is
  running). Each open tab of such a session is read every tick. The session
  shows in the project its events place it in (docs/STATE-RULES.md, "Which
  project a session seen only through its events is in"), with its tab's title as topic,
  its screen, the Live screen, the composer, a dialog's options, "Open in
  iTerm2", Hand off now, and Close idle sessions. One session per tab: a
  `/clear` starts a new session id in the same tab, and only the newest
  shows. A written hand-off opens its fresh session in a new tab in the old
  tab's window. A session closed from the Sessions page reopens in a new
  iTerm2 tab.
- **Rex**: as iTerm2, through `rex`. The board asks Rex only while some
  session's events place it in Rex (not ended, seen in the last week) or a
  claude process's environment names a Rex pane, so a Mac without Rex
  never runs `rex`. Its title as topic, its screen, the Live screen, the
  composer, a dialog's options, "Open in Rex", Hand off now, Close idle
  sessions, one session per tab. A written hand-off opens its fresh
  session in a new tab of the old tab's Rex session; a session closed from
  the Sessions page reopens in a new tab of its Rex session while that is
  there, else in a new Rex session. Before the first call, and again every
  15 s (5 s after a failure), `rex whoami --json` is asked: with no `rex`
  command, no server answering or an API revision this board was not built
  for (it knows 11), every Rex session is watch only, and says why: "The
  board could not reach Rex: Rex is not running (no Rex server answered).
  Until it can, it only shows what this session's hook events say.",
  "...: Rex's rex command is not on this Mac...", "...: Rex's server speaks
  API revision 12, and this board was built for revision 11. Update
  Ravenry to drive this Rex...".
- **Any other terminal, tmux, or no terminal known**: watch only. The
  session shows with what its hook events and transcript say (state,
  question, context, hand-backs), and its controls say why they are off in
  plain words: the composer "This session runs in VS Code, so the board
  cannot type into it. Answer it in VS Code.", the Live screen "This session
  runs in VS Code. The board cannot read or type into VS Code yet, so it
  only shows what the session's hook events say. Answer it in VS Code." An
  iTerm2 session whose tab the board cannot find,
  or an iTerm2 that cannot be asked, says that instead. A hand-off written
  there opens no fresh session; its card says to start one there.

## Rex setup

- Nothing to install beyond Rex. The `rex` command is found, in this
  order: the PATH, `REX_BIN_DIR` (set in every Rex pane), Rex's copy under
  `~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`,
  then `/Applications/Rex*.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`
  (Rex Beta does not put it on the PATH). `RAVENRY_REX_BIN` overrides it
  (`none` stands for a Mac without Rex).
- "Open in Rex" needs Rex's Remote Control setting on (Rex's Settings; off
  by default): `session.select` is a client action, and Rex refuses client
  actions until it is on. The board never changes the setting. With it
  off, "Open in Rex" still makes the tab its session's active window on the
  server, and says "Turn on Remote Control in Rex's Settings so the board
  can show sessions in Rex." (when Rex's refusal names Remote Control or a
  permission; any other refusal is passed on as "Rex did not show the tab:
  <Rex's words>"). Everything else works without it.
- `ravenry doctor` says whether Rex is installed, where its command is,
  whether its server answers and which revision it speaks, with the Remote
  Control note; `ravenry setup` in a Rex tab says the board answers
  sessions in Rex.

Measured on 2026-11-06 (Rex Beta 0.1.0, build 1829, server API revision
11, through server/rex.mjs on a throwaway session): `whoami` 37 ms, a new
session 72 ms, a new tab in it 90 ms, listing one session with two panes
and their titles 113 ms, a read 33 ms, a text 32 ms, a key 29 ms, a close
27 ms. Each `rex` call is a process of about 40 ms, so a listing costs
two calls per Rex session and one per pane. A capture holds the whole
scrollback: 20,000 lines (1.4 MB) took 0.1 s. A new Rex session not shown
in the app is 80 columns wide, so its lines wrap there.

Live the same day, a test board on :4698 in Rex mode started a real
`claude` (2.1.319) with Revive, in a new Rex session: the board found the
tab, read its title ("BRIEF.md hand-off section") and screen, typed a
one-line message and a three-line one (each arrived as one prompt: three
UserPromptSubmit events for three messages, and Claude answered "Your
message had three lines."), chose "Blue", the third option of an
AskUserQuestion menu, with Down, Down, Enter, opened the hand-off's fresh
session in a second tab of the old Rex session (the active tab did not
change), chose "Not now" in its first menu, closed it through Close idle,
reopened it with `claude --resume` in a new tab of the same Rex session,
and closed both. The folder-trust prompt took Down and Enter through `rex
send-key`. `session.select` was not run against the real app (it would
switch what the Rex window shows); it is proven against tools/fake-rex.mjs.

## Ravenry's own panes (ravenryd)

`server/ravenryd.mjs` drives the panes of `ravenryd`, Ravenry's own
terminal daemon, over protocol v1 (`packages/protocol/PROTOCOL.md`) on its
unix socket, through `@ravenry/node-client`. It talks to every daemon in the
runtime folder (one per version, PROTOCOL.md section 9). A pane is
`ravenry:<pane id>`; `RAVENRY_PANE` in a process's environment names it
while `TERM_PROGRAM` is `ravenry` (server/termenv.mjs, server/sessions.mjs).

| Operation | ravenryd |
| --- | --- |
| List tabs | `pane.list` on each daemon: the title, name, folder, and the pane's agent and shell state |
| Read screen | `pane.capture` with `history`, trailing blanks and blank rows trimmed |
| Send text | `pane.send` in `paste` mode (bracketed when the program asked); `typed` mode for the `!` of bash mode |
| Keys | `pane.send` with named keys (`Enter`, `Up`, `Down`, `Backspace`, `Escape`, `Tab`), encoded for the program's modes by the daemon |
| Focus | `pane.focus`: the windows that show panes (the Ravenry app) show it; with none open, "The Ravenry app is not open" |
| Open tab | `pane.new` with the folder and a name, on the daemon of `near` or the newest one; with none running, `ravenryd serve --detach` (`RAVENRY_DAEMON_BIN`, else `ravenryd` on the PATH) |
| Close | `pane.close`, which ends every process of the pane |

The board runs in Ravenry mode with `RAVENRY_TERMINAL=ravenry`, or when it
starts in a ravenryd pane.

**Sessions in other terminals, from Ravenry mode.** The desktop app's hub
runs in Ravenry mode, under launchd, and follows the sessions the person
still runs elsewhere. iTerm2 and Rex are followed as in the other modes.
cmux is too (`term.CMUX_OUTSIDE`, Ravenry mode with cmux installed): its
tabs are listed (`tree --all`) only while a session's events or a claude
process place a session there, the session is tied to its tab by the
surface id its events and its process's `CMUX_SURFACE_ID` carry, its screen
is read, the Sessions page says it is in cmux, and Open in cmux focuses its
tab. It is a read-only mirror: in this mode the board never types into a
cmux tab, closes one or opens one (`canDrive('cmux')` is false and the cmux
adapter's writes refuse whatever the caller checked), so a send is refused
with "Answer it in cmux, or continue it in Ravenry", and Close idle leaves
it ("In cmux").

cmux's socket, in its default mode, answers only programs cmux started
("Access denied - only processes started inside cmux can connect"), and
launchd, not cmux, starts the app's hub. The npm board read cmux only
because it was started by hand in a cmux tab. The hub never works around
that: until the person allows it in cmux (Settings > Automation: a socket
password, which the cmux command reads from cmux's settings or
`CMUX_SOCKET_PASSWORD`, or a wider access mode), the session shows from its
events with one line saying so ("cmux shows its tabs only to programs it
started..."), its conversation comes from its transcript (the session's
`conversation`: its last turns, what was asked and the answer), cmux is
asked again every 30 s, and Open in cmux brings the cmux app forward (`open
-b com.cmuxterm.app`, no socket needed).

**One session, one row.** A session id is one row however many processes
hold it: a process in a ravenryd pane comes first (its pane is the
session's tab, in a daemon of any version in the runtime folder, so panes
made before an update stay until they end), even when another terminal's
process on the same session wrote its last events or ended; that other
process is the session's `alsoOpen`. A ravenryd pane is the innermost
terminal while TERM_PROGRAM says ravenry, whatever cmux, iTerm2 or Rex
variables it inherited, and ravenryd no longer hands those variables to
its panes: a pane takes only the account's variables from the daemon's
environment (HOME, USER, SHELL, PATH, LANG, LC_*, TZ, TMPDIR, the ssh
agent, the desktop session on Linux), so nothing of the session that
started the daemon (Claude Code's CLAUDE_CODE_*, cmux's, iTerm2's, tmux's)
reaches it. RAVENRY_PANE_PASS names more by name, for a test's prompt.

**Continue in Ravenry.** A session on this machine in a terminal outside
Ravenry carries `outside: { name, open, resumable }`: `open` is whether its
process still runs there (its hook's pid, one `ps -p` per tick; else the
last process list). `POST /api/sessions/resume { projectId, sessionId,
cols, rows }` resumes it in a Ravenry pane in its folder, through ravenryd
as any session the app starts, with `claude --resume <id>` or `codex resume
<id>` (Claude Code 2.1.319's and Codex 0.166.0's `--help`). It reads the
processes again first and never starts a second process on a session id:
while one still runs outside, it answers 409 with "It is still open in
cmux. Close it there first, then continue it here." and `open: true`; one
in a Ravenry pane is answered with that pane, as is a second ask for one it
resumed. This endpoint never ends the outside process; Move here does.

**Move here.** One click puts a conversation in one place. `POST
/api/sessions/move { projectId, sessionId, keep, cols, rows }`, keep
`ravenry` (Move here) or `outside` (Keep it in cmux):
- `ravenry`: every process on that session id ends, in the other terminal
  and a stale copy in Ravenry, then it resumes in a new pane of the current
  daemon (`/api/sessions/resume`), never an old one: an old pane's shell
  may carry what its daemon inherited (CLAUDECODE, CMUX_*), and a Claude
  resumed there saves no transcript. The answer names the old panes
  (`replaced`); the app puts the new pane in their tab's place, and the
  hub closes them 2 s later, only when the resume worked. The other
  terminal's tab keeps its shell.
- `outside`: the Ravenry copy ends and its pane closes; the other
  terminal's goes on.
- A process ends only when the session is not mid-turn by its hook state
  (the last event a UserPromptSubmit with no Stop after it). Mid-turn the
  answer is `{ waiting: true, name }`, the session carries `moving`, and
  the tick does the move once the turn ends.
- Each process is checked again just before it is signalled (alive, the
  same start time, still on this session id; else it is left alone), gets
  SIGTERM, and SIGKILL after 5 s only if it is still there. The hub logs
  each one (`sessions: move <id>: ended <pid> in cmux with SIGTERM in N
  ms`); the app logs each move in app.log. The last move shows on the
  session as `moved` for a minute.
- A session in a Ravenry pane carries `movedOn: { name }` when the latest
  hook event came from another process after the pane's started and it is
  not mid-turn: the conversation went on elsewhere, and the pane is stale.

A hand-off's fresh session of a
session in a terminal the board cannot open tabs in goes to a Ravenry pane
in this mode (`term.freshTerminal`); the other modes keep it where it ran.

**The agent status channel.** In a ravenryd pane, an assistant's hooks can
run `ravenryd hook --assistant claude|codex` instead of the Node scripts
(a remote machine may have no Node). The daemon keeps what they report, and
the board follows each daemon (`events.subscribe`, then `agent.events` for
what it missed): a report becomes the same record `hooks/events.mjs` writes
(server/hookrecord.mjs), which `server/events.mjs` reads beside the files.
A pane whose process exits while its agent works gives the session its
SessionEnd. The board is also the daemon's decider (`agent.decisions`): at a
Stop, the hand-off's rules (server/handoffstop.mjs) answer through the
daemon, and with no board, or no answer within 2 s, the session goes on.
When a pane's hooks run both, the Node scripts carry `--ravenryd` and stand
down in ravenryd panes, so nothing is recorded or held twice.

**Setting the hooks up.** The app's first launch calls `POST
/api/setup/hooks` with `{ ravenryd: <its path> }` (`dry: true` to preview,
`remove: true` to take them out). server/hookinstall.mjs
`setupWithRavenryd` then puts `ravenryd hook --assistant claude` in Claude
Code's settings.json and `--assistant codex` in Codex's hooks.json (with
the trust entries Codex needs in config.toml), beside the two Node
scripts, which get `--ravenryd`. Each file is backed up first; every
other hook stays. `GET /api/setup/hooks` reports both.

**Remote machines.** server/machines.mjs keeps one connection per machine
in the registry's `settings.machines` (`[{ name, host, command }]`), with
`ssh -T -o BatchMode=yes <host> -- <command> proxy`: ssh does the login and
reads ~/.ssh/config (aliases, jump hosts), nothing listens on the machine,
and ssh never asks a question (BatchMode) since nobody would answer. A
dropped connection is tried again after 1, 2, 5, 10, then every 30
seconds; the daemon there keeps its panes. Those daemons join the local
ones here: their panes keep the `ravenry:<id>` tab ids, the status
channel, hook decisions and checkpoints work the same, and every pane,
record, session, project and checkpoint says its `machine` (null on this
one). The hand-off of a session there reads its transcript and brief on
that machine through the daemon's `file.stat` and `file.read`
(`remoteIo`: the transcript's last 4 MiB, `.git`, `BRIEF.md` and
`HANDOFF.md` from its folder up), and its fresh session opens there.
The API: `GET /api/machines` (each machine's state and error, and on the
Mac the hosts of ~/.ssh/config), `POST /api/machines/add` `{ host, name,
command }` and `/remove` `{ name }` (the Mac only), `/retry` `{ name }`.

**Versions on a machine.** Each machine in `GET /api/machines` says its
daemon's `version`, `os`, `arch` and `protocol` (from its hello), `ours`
(the version of ravenryd this app carries) and `compare`: `older`, `same`,
`newer`, `missing` (its command exits 127: ravenryd is not there) or
`protocol` (it does not speak protocol 1; the hub asks `<command> version
--json` and keeps its answer in `remote`). An older or newer machine keeps
working: the app says so on the Machines page, puts a dot on its mark and
says it once in a toast, and offers the installer. After an update, the
older daemon keeps its panes until they end, and the hub reaches it with
`<command> proxy --version <v>` beside the new one (`older` lists them).

**Installing on a machine** (server/remoteinstall.mjs). `POST
/api/machines/install` `{ name, replaceHooks }` and `/uninstall` `{ name,
endSessions }` (the Mac only, person routes) answer at once; the steps
show in `job` on `GET /api/machines`. Over ssh with BatchMode, never with
sudo, and only inside the remote user's home: it finds the system with
uname, copies the app's build for it to `~/.ravenry/bin/ravenryd` (checked
by SHA-256 there and run once before it goes into place; a `ravenry` link
beside it), puts `ravenryd hook --assistant claude|codex` in Claude Code's
settings and, when Codex is there, Codex's hooks and trust entries,
through server/hookinstall.mjs's plan() with `scripts: false` (no Node and
no hub there), each file backed up and written only if it did not change
meanwhile; it writes what it did to `~/.ravenry/remote-install.json`,
points the machine's command at the installed path and checks that the
board reaches that version. Hooks someone set up by hand (a `ravenryd
hook` of another binary) are left alone with a warning, unless
`replaceHooks`; uninstall then puts them back. Run again, it changes
nothing that is right already. Uninstall stops the daemons there (it asks
first while sessions run, `endSessions` ends them), takes out exactly the
hooks and files the record names, and takes the machine off the list; the
daemon's state folder (pane logs) stays. The builds: the packaged app
carries all four (macOS and Linux, arm64 and x86-64), gzipped, with their
SHA-256 in `remote/builds.json` (apps/desktop/scripts/pack.mjs), copied
beside its ravenryd at launch, where the hub finds them; in development,
the repo's daemon/ravenryd for this machine's system. A failure says what
happened and what to do: ssh wanting a password (with `ssh-copy-id`), a
system with no build, a full disk (checked with df first, and while
copying), a settings file that is not JSON.
`tools/remote-install-test.mjs` proves it through a fake ssh.
`tools/remote-install-docker.mjs` runs it against real sshd in Linux
containers (Docker; desktop.yml runs it on every push, about two minutes;
by hand: `RAVENRY_LINUX_BUILDS=<folder with ravenryd-linux-arm64 and/or
-x64> node tools/remote-install-docker.mjs [--assistants]`): users whose
login shell is bash, zsh or fish and whose startup files print on stdout,
Alpine's BusyBox, a home on a 12 MB tmpfs and a `~/.ravenry` on a 6 MB one,
a machine behind a ProxyJump host, and on an arm64 Docker the linux-x64
build under emulation (under Rosetta its daemon trips Rosetta's own
assertion, so that case stops at the hooks; desktop.yml proves the x64
daemon natively). `--assistants` also runs the real Claude Code and Codex
from npm, with no account, on the hook entries the installer writes, and
checks they run them. ssh there uses a throwaway key, known_hosts and
`-F` config; sshd listens on 127.0.0.1 only; the containers and images
it makes are removed. A login shell that prints before `ravenryd proxy`
starts is fine: the hub skips what comes before the handshake's status
line (machines.mjs `skipBanner`), and reads JSON after it.

**Starting a session.** `POST /api/sessions/start` `{ projectId, folder,
machine, assistant, text, cols, rows }` (server/sessionstart.mjs) opens a
pane in the folder, here or on the machine, labelled `ravenry.session` and
`ravenry.project`, and types the assistant's line once the shell drew its
prompt: the project's brief to read first, or `text` as the first message.
The app calls it instead of `pane.new`, so the hooks, the brief and the
hand-off apply. On this machine, the folder the assistant's binary is in
goes first on the pane's `PATH`: the board finds Claude Code where its
installer puts it (~/.local/bin) even when the person's shell files do not
add that folder, and a daemon started by the app has the Finder's short
`PATH`.

**Checkpoints.** server/checkpoints.mjs keeps every daemon's open
checkpoints (and the last 100 closed in checkpoints.json), in the state as
`checkpoints` and at `GET /api/checkpoints` (`?all` with the closed ones).
One that opens alerts the phone and the Mac once (server/alerts.mjs
checkpointAlert: who and what kind, never the agent's text). `POST
/api/checkpoints/answer` `{ id, choice | text | approve | secret | decline }`
answers it through the daemon that holds it. A secret goes only there: it
is never stored, put in the state, echoed in an error or logged.

**Only a person answers** (server/person.mjs, PROTOCOL.md section 4, Who
acts as the person), and only a person makes any other decision through
the API: docs/PERSON.md lists every write with its class and why. The
answer API takes a request from the phone (its
token, from another address); one from this machine only when the
process that sent it runs outside every ravenryd pane and outside ssh,
which `ravenryd peer --tcp <its port> --to <ours>` tells with the
daemon's own code. An agent's `curl` gets 403 and the checkpoint stays
open; the desktop app and the board page answer as before. The hub gives
its answer key (`<RAVENRY_HOME>/answer-key`, mode 0600) in `hello` on
every daemon connection: a machine reached over ssh takes answers and
hook decisions only from the connection with the key it trusts, the
first one it was given, so the hub pairs with a machine when it first
connects; `GET /api/machines` says `answers: true` once it has. To pair
another hub, delete `answer-key` in that machine's ravenryd state folder.

A test board (RAVENRY_HOME or MC_HOME set) reaches a daemon only when
RAVENRY_RUNTIME_DIR names the test's own folder. `tools/ravenryd-test.mjs`
proves all of the above against a real daemon (RAVENRYD_BIN), and
`tools/machines-test.mjs` (a second daemon behind a fake ssh),
`tools/hub-api-test.mjs` (the API on a real board),
`tools/person-routes-test.mjs` (every person route from inside a pane)
and `tools/hookinstall-ravenryd-test.mjs` the rest.

## iTerm2 setup

- iTerm2 with the Python API on (Settings > General > Magic > Enable Python
  API). AppleScript needs nothing more.
- `node tools/install-iterm.mjs` makes `~/.ravenry/iterm2-py`, a private
  venv with the `iterm2` package, for the arrow keys (`--check` only says
  whether it is ready). `RAVENRY_ITERM_PYTHON` overrides the Python;
  without the venv the adapter also finds the runtime iTerm2 installs for
  its own scripts. The `iterm2` package gets its cookie from iTerm2 through
  AppleScript by itself.
- The first time the board talks to iTerm2, macOS may ask once to let it
  control iTerm2 (System Settings > Privacy & Security > Automation). A
  refusal shows on the session as "macOS has not allowed the board to
  control iTerm2".

Measured on 2026-11-03 (iTerm2 3.7.6, a tab the check opened and closed):
listing the sessions 0.3 s, reading a screen 0.3 s, a new tab 1.5 s, an
arrow key through the Python API 0.4 to 0.7 s, close 0.5 s (with `cat`
running in the tab, no confirmation), and no permission prompt on this Mac.
`ITERM_SESSION_ID` in the new tab (`w1t1p0:<UUID>`) named the same UUID
AppleScript gave it. AppleScript's `write text` also delivers escape
sequences (an `ESC[A` written with it arrived as `^[[A` in `cat -v`), so
the arrows could go that way too; the Python API is used for them as
agreed.

## Unsupported terminals: suggest iTerm2 (decided)

Decided 2026-11-03, on whether to build Terminal.app: better to tell the
user to install a proper terminal first. The package's v0.1
supported cmux and iTerm2 fully and no third terminal; 0.4.0 adds Rex,
whose `rex` command reads a pane and types into it without bringing it
forward. The first run detects
the terminal the board and its sessions run in. In any other terminal
(Terminal.app, VS Code, Warp, Ghostty and the rest) sessions stay watch only,
and the board says once, in one line, that answering from the board needs
iTerm2 (free), cmux or Rex, with a link to install iTerm2. Watch only keeps
working meanwhile, so the person sees their sessions from the first minute.
Built for 0.1: `ravenry setup` and `ravenry doctor` print that line, and an
empty board on a Mac with neither app shows it under "No Claude Code
sessions yet" (`snapshot.board.installed`).

Why not Terminal.app: its scripting has no session id (the tab would be found
by its tty), and `do script` always adds Return, so menu choices need System
Events keystrokes to the frontmost window: every Yes or No from the board
would bring the tab in front of the user, and needs the Accessibility
permission. That defeats answering from elsewhere.

If a fourth terminal is ever worth it, WezTerm (`wezterm cli get-text` /
`send-text`) and Kitty (`kitty @ get-text` / `send-text`) come first: both
read a tab and type into it without bringing it forward.

## Tests

`node tools/iterm-mode-test.mjs` proves the mode table, `npm run iterm`
against the fake (its `board-*` scripts and the split helper), and a test
board on :4682 in iTerm2 mode whose `CMUX_BIN` is a tripwire that logs any
call (none may happen).

`node tools/outside-terminal-test.mjs` (with `RAVENRYD_BIN` for the
resume) proves the above on a test board in Ravenry mode with
`tools/fake-cmux.mjs` and the stand-in ps: the session tied to its cmux tab
and its screen read, inCmux on the Sessions page, a send refused, Open
focusing the tab, nothing ever written to cmux; with cmux refusing the
board, the one line, the transcript's conversation and the cmux app
brought forward; then its process ended, Continue in Ravenry running
`<claude> --resume <id>` in a real pane in its folder, and a second ask
answered with the same pane.

`node tools/iterm-test.mjs` proves the detection, the hook's lines, the
adapter against `tools/fake-iterm.mjs` (which plays both osascript and the
Python helper from a JSON fixture, so no test reaches the real iTerm2), and
a test board on :4680 with an iTerm2 session, a VS Code session and an
iTerm2 session whose tab is gone. A test board (RAVENRY_HOME or MC_HOME
set) never runs the real osascript or Python for iTerm2 without
`MC_ITERM_REAL=1`.

`node tools/rex-test.mjs` proves the detection (with iTerm2's and Rex's
variables inherited both ways), the board's mode, where `rex` is found, a
process's `REX_BLOCK`, the hook's lines, the adapter's operations against
`tools/fake-rex.mjs` (which plays `rex` from a JSON fixture and logs every
call, so no test reaches the real Rex; `--autostart=false` on every call),
watch only with no command, no server and API revision 12, then test boards
on :4671 (cmux mode: a Rex session's title, screen, Live screen, messages,
a menu, Open in Rex refused and shown, a hand-off, Close idle, Reopen),
:4672 and :4678 (watch only, and why) and :4673 (Rex mode with a cmux
tripwire: New project, Revive, the page). A test board never runs the real
`rex` without `MC_REX_REAL=1` or `RAVENRY_REX_BIN`.
