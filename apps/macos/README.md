# Ravenry for macOS (native)

A native Mac app, Swift and AppKit with no web view, that draws its
terminal itself, the way Rex does: the daemon's screen (libghostty-vt in
`ravenryd`) is the only screen, the app draws the rows the daemon sends
with its own Metal renderer, and the daemon encodes the person's keys and
mouse for the program. There is no second terminal emulator to drift from
the daemon's, which is what made the first spike (GhosttyKit fed by
`ravenryd attach`) blink and leave prompt debris on a resize.

One window of tabs and splits, each pane of ravenryd drawn by the app,
as the Electron app's terminal area has them, with the Electron app's
sidebar and session panel around them, drawn from the hub's state.

Licence: GPL-3.0-only, like the other apps. No third-party code: the
renderer, the WebSocket client and the key table are this app's.

## How it works

```
  RavenryMac (Swift)                       ravenryd (Go)
  +----------------------------+           +--------------------------------+
  | TerminalView (NSView)      |  render   | pane: pty, libghostty-vt       |
  |  Screen: the rows it was   |<----------|  render state -> changed rows  |
  |   sent, cursor, modes      |  frames   |  frames paced to the display,  |
  |  Renderer: Metal, CoreText |           |  acked, never mid-update       |
  |   glyph atlas              |           |  resize: vt + pty together,    |
  |  NSTextInputClient, mouse, |  events   |  held until the shell redrew   |
  |   selection, clipboard     |---------->|  key, mouse, paste encoders    |
  +----------------------------+           +--------------------------------+
            unix socket, protocol v1 (pane.render, render.input, ...)
```

The frame format, the pacing and the client's duties are in
[docs/RENDERING.md](../../docs/RENDERING.md); the messages in
[PROTOCOL.md](../../packages/protocol/PROTOCOL.md) section 4, "The render
stream".

- **Connection** (`Connection.swift`): the protocol's WebSocket over the
  daemon's unix socket, on a plain socket, with a reader thread; each
  render stream's frames go to its own pane.
- **Tabs and splits** (`Workspace.swift`, `TabBar.swift`, `Panes.swift`):
  the daemon's shells (`ravenry.kind: shell`) are the tabs, named as the
  Electron app names them (the pane's name, else its program's title,
  else the program, with its folder). Cmd+T or the + opens a shell,
  Cmd+W closes the pane with the keyboard, Cmd+1 to Cmd+9, Cmd+Shift+[
  and ], Ctrl+Tab and Ctrl+Shift+Tab pick a tab, a drag moves it, a
  middle click closes it. One split per tab: Cmd+D right, Cmd+Shift+D
  down, Cmd+Option+arrows or a click move the keyboard, the divider is
  dragged (a double click or Cmd+Ctrl+= evens it), Cmd+Shift+Enter
  zooms the pane. A tab not in front has no render stream and draws
  nothing; brought back, its panes draw the rows they had at once and
  open their streams again (a pane never drawn waits under the tab in
  front for its first frame). The order, splits, tab in front and pinned
  sessions are kept by daemon (`Layout.swift`): on the Electron app's
  daemon in its `window.json`, so both apps restore the same tabs; on any
  other daemon in `window-<daemon>.json` beside it, so two clients on
  different daemons never write over each other. Closing the window
  leaves the panes running. The strip is in the title bar, in the Electron app's colours
  and sizes (`Design.swift`).
- **The hub** (`Hub.swift`): a small typed client of the board's server,
  as the Electron app reads it (`apps/desktop/src/main/hub.ts`): the
  server-sent events of `GET /api/events` (each `state` the whole board,
  read again after a drop), `GET` for the rest. Where: `RAVENRY_HUB_URL`,
  else the port in `<RAVENRY_HOME or ~/.ravenry>/board.json`, else 4600; a
  window off every screen reads a hub only when `RAVENRY_HUB_URL` names one.
  It posts only what the person clicked (an answer, Continue, Move here,
  Hand off now, Start), with `X-Ravenry: 1`, and nothing at all with
  `RAVENRY_MAC_HUB_READONLY=1`. It is not the app's own stream (no
  `?app=1`): the Mac notifications stay the Electron app's.
- **The sidebar** (`Sidebar.swift`): `state.sidebar` as it comes (the
  sections, their colours and counts, the mix bar, a project's header in
  each section it has a session in, a row a session with its assistant,
  context percent, pin and its line or mark, an idle project on one line),
  then the pages of `state.pages` and Decisions, and the foot (Settings,
  phone, Alerts, Learn, Machines, the memory line). A click on a row opens
  what it stands for. View > Hide Sidebar (Cmd+Ctrl+S) folds it and its
  right edge is dragged from 220 to 420 points (both kept), which the
  Electron app does not have.
- **What is in front** (`Board.swift`): a tab, else a session this window
  does not draw (in cmux, iTerm2, Rex, or in a ravenryd this window is not
  on) read only in the middle with Open in and Move here (`Middle.swift`,
  its screen from `GET /api/live`), a project's page (Continue this
  conversation, New session, Open brief), New session (a folder and an
  assistant, for now), a page of the Electron app's own (the brief, the
  gallery, a plan, an idea, Alerts, the pages from files), or a page this
  window does not draw yet, named in a native placeholder. The middle's view is a tab
  after the others, as in the Electron app. A session in a pane of this
  window's daemon becomes or focuses its tab. The highlighted row, the
  panel and the tab in front always name the same thing.
- **The brief** (`BriefPage.swift`, `BriefDoc.swift`): a project's brief as
  a page beside the session it was opened from (the panel stays on it),
  read from `GET /api/brief` when it shows and again at most every 4
  seconds, drawn again only when its text changed. The Markdown is drawn
  as text in one text view (TextKit 1), never as HTML: the fields before
  the first section, headings, paragraphs, nested lists, checklists with
  their marks, code blocks, inline code, bold, italics, links and bare
  URLs, the Plan's count and the Next step's dated entries (`nextParts`,
  the newest open, a press on a row opens or closes it). Links open in the
  browser (http, https and file only), Edit opens BRIEF.md in the
  person's editor (`Outside.swift`; off every screen both are recorded,
  never opened). The place scrolled to, the selection and the entries
  opened stay through the hub's refreshes and a resize.
- **The Electron app's own pages** (`InApp.swift`): over the middle and
  the right columns, the strip and the panel folded away, with a head
  (back, title, the line under it, Close, which goes back to what was in
  front).
- **The gallery** (`Gallery.swift`): a project's pictures as the hub lists
  them (`brief.gallery`, newest first), a grid of cards (the one the viewer
  came from ringed), and one picture large with Previous, Next, the strip
  and Show in Finder (`POST /api/project/reveal-picture`). A click zooms in
  around the point (to its own size, or twice the fitted size) and out
  again; a trackpad pinch and two fingers are the scroll view's own
  magnification and pan; the zoom and the place stay through the hub's
  refreshes. The panel's latest picture opens it large, its Gallery the grid.
- **The pages from files** (`FilePage.swift`, `FilePageViews.swift`,
  `PageFmt.swift`): Objectives, Plans, Ideas, Rules, Ship and any page a
  person or a project added, drawn from the hub's `drawn` page (`GET
  /api/pages/page?key=&tab=`, `hub/server/pagedraw.mjs`): its rows already
  filtered, sorted, limited and grouped, the tabs' counts and the stats, as
  lists, cards, a board (a list of lanes under 240 points a lane), a table,
  stats and documents, with Ravenry's own views (brainstorm, rules from
  project memory, sessions, objectives' and plans' rows). A tab picked is
  sent and drawn when the hub answers; the page is read again when its
  sidebar row's rev moves and after each write. Every button posts the
  route the Electron app posts, through the same sheets (confirm, the
  address, the approval, the item, See what changed from the hub's
  `changed`, the form, a rule); a note dragged to another lane is moved
  there; a project's page stays off until trusted (sha256 of its text, with
  CryptoKit), a page with a mistake shows its last good version under the
  problem. An idea opens its thread, a plan its page, a project its session.
- **Settings** (`SettingsWindow.swift`, `Settings.swift`): Cmd+, and the
  sidebar's foot open a 720-wide window with the Electron app's three
  tabs. Appearance: the font (the installed monospace families) and its
  size, a preview in the theme in use, Follow the system with the dark
  and light themes (or one), Import iTerm2 or Ghostty theme (the hub
  reads the file, `POST /api/settings/theme-import`, and the theme is
  saved in the data folder's `themes/`, as the Electron app's), the cursor
  and Blink; Behavior: Option as
  Meta, copy on select, links, the scrollback (red when not a number in
  its range), the bell and the Dock, closing a busy tab; Skills: the
  hub's rows with their hooks (`GET /api/setup/skills?ravenryd=`),
  Install, Remove and Set up. Every control writes settings.json in the
  data folder (`RAVENRY_DESKTOP_DATA`, else the Electron app's), its keys
  from `shared/settings/settings.json`, the themes from `shared/themes/`;
  the window follows the file when the other app writes it.
  A file that is not JSON is kept beside as settings.json.broken and the
  defaults read; an older app's file is migrated (the old one kept as
  settings.v0.json), a newer app's read for what this one knows (kept as
  settings.v<N>.json).
- **Decisions** (`DecisionsPage.swift`): the sidebar's fixed row opens
  what the hub sends for the page (`GET /api/decisions?page=1&show=&only=
  &search=`, `hub/server/decisions.mjs` page()): the person's words in
  days, newest first, with when, the project, where it was said or "you
  added it", what an entry replaced crossed out under it, a replaced one
  crossed out with when, how often agents read it, Undo in an agent's
  minute; the project menu, the search (sent as typed) and Holds now,
  Replaced and All. The row counts the active ones with a dot while one
  can be undone (read every 3 s), and an agent's save (the stream's
  `decision` event) is a toast with Undo and Show.
- **The panel** (`Panel.swift`): the head (project, assistant, pin,
  hide), the state since when, the setup lines (`GET /api/setup/skills`),
  a checkpoint's card in its `words` (ask, approve, drive; answers posted
  to `POST /api/checkpoints/answer` as the desktop posts them) or the
  question with its quick answers (`POST /api/send`), the context with Hand
  off now, the hand-off, the latest picture, the brief (goal and Next from
  `brief.nextParts`), the plan, and Typed here (`pane.inputs`) for a pane
  of this daemon. Under 1180 points of window it folds, and opens over the
  terminal when a question arrives for what is in front (else a toast with
  Show); Cmd+Option+B shows and hides it. The words come from
  `shared/strings/en.json`, the colours and sizes from
  `shared/tokens/tokens.json`, the icons from `shared/icons/` (`Shared.swift`,
  `Views.swift`).
- **Screen** (`Screen.swift`): applies each frame to the rows it holds;
  that is all the terminal state the app has.
- **Renderer** (`Renderer.swift`): instanced quads for backgrounds,
  glyphs and lines (underline styles, strikethrough, cursor, selection,
  find matches), and over them the scrollbar and the bell's flash.
  Glyphs come from a CoreText atlas, one per grapheme cluster and face
  (regular, bold, italic), wide characters over two cells, colour emoji
  as they are, no ligatures. Palette colours resolve with the app's
  theme (the desktop app's) and whatever the program changed. The
  shaders are compiled when the app starts, so the build needs no Metal
  Toolchain.
- **Fonts**: the cell is the font's own, as Ghostty (and so Rex)
  computes it: the advance of "M" wide, ascent, descent and line gap
  high, each rounded to a pixel, no extra line spacing; the baseline
  leaves the descent at the cell's bottom. The font and its size are the
  shared settings' (Menlo 13 by default, 16 x 30 px at 2x; Rex's Menlo 12
  is 14 x 28), a family that is not here falling back to the settings'
  list. Cmd+= (or Cmd++), Cmd+- and Cmd+0 change the size from 8 to 32
  points, in the View menu too, written to the shared settings file as
  the Electron app's. `--font` and `--font-size` pick another for one run,
  until the setting changes.
- **The shared settings** (`TermLook.swift`): every terminal applies the
  settings file both apps share, at once on each change (Settings, the
  other app, or a hand edit) and on the system's appearance: the font
  and size, the theme (the tab in front, the panes' heads and the sheet
  take its colours), the cursor style and blink while the program leaves
  a block, Option as Meta, copy on select, links on a plain click, the
  scrollback the daemon keeps (`pane.update`), the bell (a flash, a sound
  or off, the Dock bouncing while the app is not in front, for a pane not
  on screen too) and closing a busy shell (a sheet: Close, Cancel, Don't
  ask again).
- **Characters drawn, not taken from the font** (`Sprites.swift`): box
  drawing (light, heavy, double, dashed, rounded corners, diagonals),
  block elements (halves, eighths, quadrants, shades), braille and the
  Powerline triangles fill their cell exactly, so lines join across
  cells and rows.
- **Drawing**: a frame is drawn as soon as it comes when no draw happened
  in the display's current refresh interval (a keystroke's echo goes out
  at once), otherwise at the next one, so draws never outrun the display
  (120 Hz on ProMotion). During a live resize each step is drawn in the
  window's own transaction (`presentsWithTransaction`) with the rows it
  has, at the new size, so the content never lags the frame; the
  reflowed rows follow from the daemon.
- **Resize**: the view's grid size goes to `pane.resize`; the daemon
  resizes the screen and the pty together, and at a shell prompt holds
  frames until the shell has drawn itself again (RENDERING.md).
- **Keys** (`KeyCodes.swift`, `TerminalView.swift`): each press, repeat
  and release as the physical key (a W3C code), the modifiers, the text
  and the unshifted character; the daemon encodes them (legacy, Kitty
  keyboard protocol). An input method's marked text is drawn at the
  cursor and only its committed text is sent. Option acts as Alt as the
  settings' Option as Meta says (`--option-as-alt` for one run).
- **Scrolling**: every wheel and trackpad movement goes to the daemon in
  rows (`wheel`: a trackpad's points over the cell's height, momentum
  included; a wheel's notch three rows), and the daemon decides, as
  Ghostty does, whether the program gets it, it becomes arrow keys on
  the alternate screen, or the view scrolls. Typing brings the view
  back (the daemon does). A macOS-style overlay scrollbar shows while
  the view scrolls and fades out a second after. Cmd+Home and Cmd+End go
  to the top and the bottom.
- **Selection and copy**: when the program does not take the mouse (or
  with Shift), a press, drags and the release go as `select` events with
  the cell under the pointer; the daemon's gesture (libghostty-vt's)
  counts the clicks (two a word, three a line), Shift extends, Option
  makes a block, and the frames carry the selection the app draws. A
  drag past the top or the bottom scrolls and selects on. Cmd+A selects
  everything, Cmd+C copies with `render.copy`, so it reaches beyond the
  rows on screen. A right click has Copy, Paste, Select All, Clear and
  Find.
- **Paste and drop**: Cmd+V pastes (bracketed by the daemon when the
  program asked); files dropped on the view are pasted as their paths,
  which the daemon quotes, and dropped text as a paste.
- **Links**: while Cmd is held the app asks the daemon for the link
  under the pointer (`render.link`: a program's hyperlink or a URL in
  the text), underlines it and shows the pointing hand; Cmd+click opens
  it (http, https and file only). A plain click never opens.
- **Find** (`FindBar.swift`): Cmd+F opens a small bar at the top right;
  the search is the daemon's (`render.find`), and the frames carry the
  matches, drawn soft yellow, the selected one orange. Enter or Cmd+G is
  the next older match, Shift+Enter or Cmd+Shift+G the newer one, Esc
  closes it.
- **The rest**: the cursor in the program's style (block, bar,
  underline), blinking when it asks, a hollow block when the window is
  not focused; the window's title is the program's; the bell flashes
  the view; Clear (Cmd+K) is `pane.clear`; for VoiceOver the view is a
  text area whose value is the visible rows.

## Build

Needs Xcode (27.2 here), Go, XcodeGen and Zig 0.17 (for the daemon's
libghostty-vt, `daemon/scripts/libghostty.sh`).

```sh
cd apps/macos
scripts/build.sh          # prints build/RavenryMac.app, signed ad hoc
scripts/bench.sh [DIR]    # the headless bench (below)
scripts/selftest.sh [DIR] # the headless self-test (below)
node scripts/sidetest.mjs [DIR] # the sidebar's and the panel's (below)
```

`ravenryd` is built from `daemon/` and goes in the app beside its
executable: the app asks it which daemons run (`ravenryd daemons`).

## The headless bench

`scripts/bench.sh` starts the app's own ravenryd as a throwaway daemon
(HOME, runtime and state folders in the repository's `.tmp/`, zsh at a
`~ > ` prompt), then the app with its window off every screen and no
Dock icon, drawing into an offscreen texture with the same renderer
(`BENCH_LAYER=1`: through the window's Metal layer instead). The app
(`Bench.swift`) draws a line of styles and wide characters, types 40
keys, pastes a 10-line command line and drags the window from 1200 pt to
300 pt (`BENCH_MIN`) and back at 120 steps a second, then runs
`seq 1 2000000`. It writes `bench.json` and pictures, and the script
prints:

- key to drawn echo;
- for the drag: steps whose screen went blank (the command line gone) or
  held debris (a piece of an old prompt), whether the window ends on the
  daemon's screen, draws a second and the frame time (CPU to build and
  encode, plus GPU);
- for `seq`: the time to the prompt and the draws a second;
- the grid of the app's first window (900 x 560 pt at 2x) with its cell,
  beside what Rex's cell (14 x 28 px) makes of it.

The daemon's own drag test (`daemon/internal/server/drag_test.go`) does
the same through the protocol with a Go client.

## The headless self-test

`scripts/selftest.sh` starts a throwaway daemon the same way, then the
app with its window off every screen (`--selftest`), a private
pasteboard of its own (the person's clipboard is never written), the
font size never saved and links recorded rather than opened. The app
(`SelfTest.swift`) drives the view's own handlers with real events:
keys and shortcuts, precise and wheel scroll events made from CGEvents,
clicks, double and triple clicks, drags with Shift and Option and past
the top edge, Cmd with the pointer on a URL, a drop of files and text,
the find bar's field. Each check reads what the view applied (the
frames' offset, selection and find sections, the grid, the link, the
pasteboard, the accessibility value, the bell's flash, the scrollbar)
and, for the drawing, the pixels it drew: box lines that join, the link
underline, the find colours, the cursor's shape. It prints a line a
check, writes `selftest.json` and pictures, and exits 1 when a check
failed.

## The sidebar's and the panel's self-test

`node scripts/sidetest.mjs [DIR]` starts a throwaway daemon and the demo
hub of the desktop's screenshots (`apps/desktop/tools/demo-hub.mjs`, made-up
projects, a cmux that refuses every write), then the app off every screen
on both (`--sidetest`, `SelfTestBoard.swift`). It checks every row the hub
sent is drawn, a press on a row opens it (highlight, panel and middle on
the same session), the pin, Hand off now, Open brief, the picture large,
Move here, an idle project's page, a page's placeholder, New session and
Start, Cmd+Shift+N, Cmd+Ctrl+S, Cmd+Option+B, the sidebar's edge, the
panel folding at 900 points and opening over the terminal when a question
arrives; posts go to the demo hub only. It leaves pictures at 1440, 1280
(dark and light) and 900 points. The bench and the terminal's self-test
start with the sidebar and panel folded (`RAVENRY_MAC_SIDEBAR=1` shows
them).

`node scripts/sidetest.mjs --screen NAME [DIR]` runs one screen's checks
(`SelfTestScreens.swift`: `brief`, `gallery`, `plan`, `idea`, `alerts`, `pages`) on the demo hub with its plan, its
idea and a project whose brief has every shape a brief takes, and leaves
`native-NAME-{1280,900}-{dark,light}.png`.

`node scripts/launchcheck.mjs [APP]` launches the app off every screen on a
throwaway daemon of three shells and the demo hub, with a saved layout
that lists one of them, a split whose guest is gone and a tab in front
that is gone, and passes when it still runs 8 seconds later with the three
shells in its saved order.

## Run

```sh
build/RavenryMac.app/Contents/MacOS/RavenryMac [--socket PATH] [--attach PANE] [--option-as-alt left|right|both]
    [--font NAME] [--font-size POINTS] [-- COMMAND ARGS...]
```

With no `--attach`, it starts a new pane (the login shell, or COMMAND) in
the newest running daemon that has the render stream (protocol method
`pane.render`), never starting one, and closes the pane when the window
closes. Launch it with `open`, from outside a Ravenry pane or with the
pane's variables removed (the app removes `RAVENRY_PANE` and
`RAVENRY_SOCKET` from its own environment too).

## The event log

The app always keeps a small log of its scroll events at
`~/Library/Logs/RavenryMac/events.log` (started again past 4 MB): for each
one, the view the window hit-tested it to, the first responder, the
event's phase, momentum phase, precise or not, `deltaY` and
`scrollingDeltaY`, the rows sent, the pane's scrollback and offset then,
the daemon's answer, and the offset the frames show after. A window off
every screen (the bench, the self-test) writes only to
`RAVENRY_MAC_EVENTS_LOG` when it is set, never to the person's Library.

## Not done yet

- One window: no New Window, bell marks or activity on hidden tabs, or
  tab dragged to an edge to split.
- A program's steady block cursor reads as the default, so the
  settings' cursor style shows instead.
- Sidebar and panel: Learn's ticks come only from the phone card and
  Decisions (no hints, no filmstrip to tick), and its filmstrip card shows
  the busiest terminal; no session on another machine (MACH-005 to
  MACH-007); Decisions has no add, edit or remove (DEC-004, no client has them); a page's run button says its approval waits
  (the panel has no card of its own for a page's run yet), a page's form
  takes a date as text, and a sheet taller than the window is cut; New session is a
  folder and an assistant, without the setup step or the worktree choice;
  a pinned session that runs outside gets no tab of its own; the secret
  and pick cards say to answer in the Ravenry app; the approve card has no
  Edit; no number keys on a card; Typed here has no filters or whole log;
  no review, files changed, panes it uses or lent-pane strip; no
  filmstrip; a shell's panel has no "opened by" or who can type here.
- A session in a ravenryd pane of another daemon (the board's, when the
  window runs on its own) is shown read only, as one outside: the window
  draws only its own daemon's panes.
- No images (Kitty graphics, sixel); OSC 52 clipboard and notifications
  are not forwarded. Find has no match-case or regular expression
  option (the daemon's search ignores the case of ASCII letters).
- The scrollbar shows the position but cannot be dragged.
- The app is signed ad hoc for local runs, for this Mac's architecture.
