# Terminals

The board drives two terminals: cmux and iTerm2. Every terminal call goes
through one interface, `server/terminal.mjs`; nothing else imports an
adapter. The adapters are `server/cmux.mjs` (the only code that runs the
cmux CLI) and `server/iterm.mjs` (the only code that talks to iTerm2).
Which terminal a session runs in is recorded per session by the events hook
from its environment. A session in any other terminal is watch only.

## The board's terminal: cmux mode and iTerm2 mode

The board itself runs in one terminal, `term.BOARD` in `server/terminal.mjs`,
and that is where it opens new work. It is decided once, at start, from
where the board was started:

| Started | Mode |
| --- | --- |
| `RAVENRY_TERMINAL=cmux` or `=iterm` (`iTerm2` too) | that one |
| in a cmux tab (`CMUX_SURFACE_ID` or `CMUX_WORKSPACE_ID`) | cmux |
| in an iTerm2 tab (`ITERM_SESSION_ID`, or `TERM_PROGRAM=iTerm.app`) | iTerm2 |
| anywhere else (launchd, another terminal) | cmux when cmux is installed, else iTerm2 (installed or not: with neither app every session is watch only, and iTerm2 mode never needs its app) |

The `ravenry` command (bin/ravenry.mjs) decides before the board loads:
in a cmux tab it runs the board there (cmux mode) and opens the page in a
cmux browser pane above it; in an iTerm2 tab it opens the Ravenry tab
(below); anywhere else it sets `RAVENRY_TERMINAL=iterm`, because cmux's
socket refuses a process started outside cmux, and opens the default browser.

A Mac has one of them in practice, so the two modes do not mix:

- **cmux mode** is the board as it was: cmux workspaces are projects, and
  iTerm2 sessions are driven too while some session runs there.
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
`iterm:<UUID>`, the session's unique ID. `kindOf(surfaceId)` tells them
apart, so the page and the routes pass surface ids as before.

| Operation | `terminal.mjs` | cmux | iTerm2 | What the board uses it for |
| --- | --- | --- | --- | --- |
| **List tabs** | `cmux.listWorkspaces()`, `listTabs('iterm')` | `tree --all`: workspaces and their tabs | AppleScript: every window, tab and session (unique ID, window, tty, name) | Finding each session's tab and its title (Claude's `✳ Topic`) |
| **Read screen** | `readScreen(tab, lines)` | `read-screen` (scrollback too) | AppleScript `contents` of the session: the visible screen only, trailing spaces and blank rows trimmed | The screen rules (docs/STATE-RULES.md), the Live screen, the checks before typing |
| **Send text** | `pasteText(tab, text)` | paste buffer, so newlines arrive as written | AppleScript `write text ... newline no`; text with a line break goes as one bracketed paste (`ESC[200~ ... ESC[201~`) so it is not sent line by line | The composer, quick answers, the command in a new tab |
| **Keys** | `pressKey(tab, 'enter' \| 'up' \| 'down')` | `send-key` | Enter: AppleScript `write text "" newline yes`. Up and Down: iTerm2's Python API (`server/iterm-keys.py`, `async_send_text` of `ESC[A` / `ESC[B`) | Enter after a message; a dialog's option chosen with the arrows and Enter, read back after each step (server/choose.mjs) |
| **Focus** | `focus(tab)` | `select-workspace`, `focus-panel` | AppleScript `select` on the window, tab and session, then `activate` | "Open in cmux" / "Open in iTerm2" |
| **Open tab** | `openTab(kind, opts)` | `new-surface` in the workspace, next to the old pane, in the folder, not focused | AppleScript `create tab with default profile` in the old session's window (else the current window, else a new window); iTerm2 selects the new tab in that window but is not brought forward | The hand-off's fresh session; Reopen |
| **Close** | `close(tab)` | `close-surface` with both ids, the board's own tab variables left out | AppleScript `close` on that session | Close idle sessions |

The board then types the command into the new tab and presses Enter, the
same for both terminals. A new iTerm2 tab starts where its profile says, so
its command is `cd <folder> && claude ...`.

cmux also has extras the board uses when they are there and does without
otherwise: `listHookSessions()` (cmux's own hook store), `resumeBinding()`,
`sidebarState()` (folder and branch per workspace), `watchEvents()` (a hint
to refresh sooner), `newWorkspace()` and `currentWorkspace()` (New project,
Revive, Reopen's fallback) and `notify()` (Mac notifications). They are
reached as `terminal.cmux.*`. The registry still names cmux workspace UUIDs
per project; iTerm2 sessions join projects by folder, like any session the
events report (below). New project and Revive open cmux workspaces in cmux mode and iTerm2 tabs in iTerm2 mode (above).

## Which terminal a session runs in

`hooks/events.mjs` records `terminal` (and `terminal_id` when the terminal
has one) on every event, from the environment Claude Code runs in
(`server/termenv.mjs`):

| Environment | `terminal` | `terminal_id` |
| --- | --- | --- |
| `CMUX_SURFACE_ID` (checked first: a cmux tab may inherit another terminal's variables) | `cmux` | none; `surface_id` and `workspace_id` as before |
| `TMUX` | `tmux` (watch only: the outer terminal's ids would name the tmux client, not the pane) | none; `pane` is `TMUX_PANE` |
| `ITERM_SESSION_ID` | `iterm` | `w0t1p0:<UUID>`; the UUID is the session's unique ID in AppleScript and the Python API |
| `TERM_PROGRAM=Apple_Terminal` and `TERM_SESSION_ID` | `apple-terminal` | `TERM_SESSION_ID` |
| `WEZTERM_PANE`, `KITTY_WINDOW_ID`, else `TERM_PROGRAM` (vscode, ghostty, WezTerm, ...) | that name | none |

`server/events.mjs` keeps the latest `terminal` per session. The Sessions
page reads `ITERM_SESSION_ID` from a claude process's environment too
(outside cmux and tmux), so an idle iTerm2 session can be closed from there.

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
supports cmux and iTerm2 fully and no third terminal. The first run detects
the terminal the board and its sessions run in. In any other terminal
(Terminal.app, VS Code, Warp, Ghostty and the rest) sessions stay watch only,
and the board says once, in one line, that answering from the board needs
iTerm2 (free) or cmux, with a link to install iTerm2. Watch only keeps
working meanwhile, so the person sees their sessions from the first minute.
Built for 0.1: `ravenry setup` and `ravenry doctor` print that line, and an
empty board on a Mac with neither app shows it under "No Claude Code
sessions yet" (`snapshot.board.installed`).

Why not Terminal.app: its scripting has no session id (the tab would be found
by its tty), and `do script` always adds Return, so menu choices need System
Events keystrokes to the frontmost window: every Yes or No from the board
would bring the tab in front of the user, and needs the Accessibility
permission. That defeats answering from elsewhere.

If a third terminal is ever worth it, WezTerm (`wezterm cli get-text` /
`send-text`) and Kitty (`kitty @ get-text` / `send-text`) come first: both
read a tab and type into it without bringing it forward.

## Tests

`node tools/iterm-mode-test.mjs` proves the mode table, `npm run iterm`
against the fake (its `board-*` scripts and the split helper), and a test
board on :4682 in iTerm2 mode whose `CMUX_BIN` is a tripwire that logs any
call (none may happen).

`node tools/iterm-test.mjs` proves the detection, the hook's lines, the
adapter against `tools/fake-iterm.mjs` (which plays both osascript and the
Python helper from a JSON fixture, so no test reaches the real iTerm2), and
a test board on :4680 with an iTerm2 session, a VS Code session and an
iTerm2 session whose tab is gone. A test board (RAVENRY_HOME or MC_HOME
set) never runs the real osascript or Python for iTerm2 without
`MC_ITERM_REAL=1`.
