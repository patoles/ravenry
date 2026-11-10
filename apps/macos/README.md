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
  render stream's frames go to its own pane. One per daemon the window
  draws (`Daemons.swift`, "The daemon" below): each pane talks to its own.
- **Tabs and splits** (`Workspace.swift`, `TabBar.swift`, `Panes.swift`):
  the daemon's shells (`ravenry.kind: shell`) are the tabs, named as the
  Electron app names them (the pane's name, else its program's title,
  else the program, with its folder). Cmd+T or the + opens a shell,
  Cmd+W closes the pane with the keyboard, Cmd+1 to Cmd+9, Cmd+Shift+[
  and ], Ctrl+Tab and Ctrl+Shift+Tab pick a tab, a drag moves it, a
  middle click closes it. An agent's own pane (one it made from its
  pane with `ravenryd new`) opens as a split beside its owner's tab,
  without the keyboard, else as a tab right after it; while an agent holds
  a pane's lease a strip over it says who has it and who waits, with Hand
  it to and Take it back (`Lent.swift`). A tab not on screen shows a
  small bell when its pane rang, a quiet dot when it printed (the daemon's
  `pane.activity` and `pane.bell`), until it is opened; its dot takes the
  colour of Needs you or Working from what its agent reported or a
  question open in it; a lent pane's tab carries its holder's badge. One split per tab: Cmd+D right, Cmd+Shift+D
  down, Cmd+Option+arrows or a click move the keyboard, the divider is
  dragged (a double click or Cmd+Ctrl+= evens it), Cmd+Shift+Enter
  zooms the pane. A tab not in front has no render stream and draws
  nothing; brought back, its panes draw the rows they had at once and
  open their streams again (a pane never drawn waits under the tab in
  front for its first frame). The order, splits, tab in front and pinned
  sessions are kept by daemon (`Layout.swift`): on the Electron app's
  daemon in its `window.json`, so both apps restore the same tabs; on any
  other daemon in `window-<daemon>.json` beside it, so two clients on
  different daemons never write over each other. The window's size and
  place are kept in the same file as the Electron app keeps them
  (`bounds`), and come back on a screen that is still there, else the
  default size, centred. Closing the window leaves the panes running. The strip is in the title bar, in the Electron app's colours
  and sizes (`Design.swift`).
- **The hub** (`Hub.swift`): a small typed client of the board's server,
  as the Electron app reads it (`apps/desktop/src/main/hub.ts`): the
  server-sent events of `GET /api/events` (each `state` the whole board,
  read again after a drop), `GET` for the rest. Where: `RAVENRY_HUB_URL`,
  else the port in `<RAVENRY_HOME or ~/.ravenry>/board.json`, else 4600; a
  window off every screen reads a hub only when `RAVENRY_HUB_URL` names one.
  It posts only what the person clicked (an answer, Continue, Move here,
  Hand off now, Start), with `X-Ravenry: 1`, and nothing at all with
  `RAVENRY_MAC_HUB_READONLY=1`. It is the app's own stream (`?app=1`),
  which the hub sends Mac notifications to (`Notifier.swift`).
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
  does not draw (in cmux, iTerm2, Rex, or in a ravenryd without the render
  stream, before 0.1.23) read only in the middle with Open in and Move here (`Middle.swift`,
  its screen from `GET /api/live`), a project's page (Continue this
  conversation, New session, Open brief), New session (`StartView.swift`:
  a folder and an assistant, its own copy of the code when another session
  works there, and step 2 once per assistant), a page of the Electron app's own (the brief, the
  gallery, a plan, an idea, Alerts, the pages from files), or a page this
  window does not draw yet, named in a native placeholder. The middle's view is a tab
  after the others, as in the Electron app. A session in a pane of a
  daemon this window draws becomes or focuses its tab. The highlighted row, the
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
  a checkpoint's card in its `words` (`Cards.swift`: ask with its number
  keys, approve with Edit, the change tinted and the hub's guess rules at
  each keystroke, Refuse with a reason, a secret typed into a secure
  field in the card that is cleared when it loses the keyboard, drive, a
  pick's pictures small; answers posted to `POST /api/checkpoints/answer`
  as the desktop posts them; a pick opens side by side in the middle,
  `Picker.swift`, with Pick, a ring dragged on a picture with its note,
  and None of these) or the
  question with its quick answers (`POST /api/send`), the context with Hand
  off now, the hand-off, the latest picture, the brief (goal and Next from
  `brief.nextParts`), the plan, and Typed here (`pane.inputs`) for a pane
  of this daemon. Under 1180 points of window it folds, and opens over the
  terminal when a question arrives for what is in front (else a toast with
  Show); Cmd+Option+B shows and hides it. The words come from
  `shared/strings/en.json`, the colours and sizes from
  `shared/tokens/tokens.json`, the icons from `shared/icons/` (`Shared.swift`,
  `Views.swift`).
- **A worktree session** (`Review.swift`): in its panel, when it is done,
  the card that asks for a review (Review, Merge without reviewing), Its
  copy, after a merge what landed with Undo the merge and Delete the
  branch, and Files it changed (a file another session changed too in
  orange, with who, when and what that means; See all of the project opens
  the grid of who changed what). The review sits in the middle beside the
  panel: its files, the diff (the hub's `lines`), a comment on a line that
  waits until Send N comments, Take back, Merge into main (the hub's
  `mergeMode`). The hub does the git, the clashes and the grid
  (`hub/server/reviewview.mjs`).
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
  reflowed rows follow from the daemon. A step draws once: the frame set
  again at the same size (AppKit's layout pass after `RootView.place`
  sized the stage) draws nothing, and the stage, a pane's box and a
  split set their frames only when they change. Each draw takes a
  drawable as the first window did (`nextDrawable`, which on a screen
  can wait up to a refresh for the compositor to give one back), in
  Apple's order: commit, `waitUntilScheduled`, then `present()` on the
  main thread. The layer has three drawables, one on screen: a third
  draw in one uncommitted transaction would wait in `nextDrawable` for
  one only the commit frees (its 1 s timeout, the window frozen and the
  screen behind showing where it grew), so it is put off and done right
  after Core Animation's commit (`CommitWatch`, an observer of the run
  loop ordered after Core Animation's). 0.1.24 held a draw off while two
  drawables had not been reported shown (their presented handlers); on a
  screen those come 4 to 30 ms after the present and now and then
  never, so 18 to 24 steps of a drag went undrawn and one waited up to
  1.6 s (the on-screen bench below). The rounded sheet (its mask) costs
  nothing measurable there and stays. A tab not in front draws nothing
  and lets its drawables go (the layer's size set to 1 x 1 until it
  shows). While the edge is dragged the board only lays out (the
  panel's mode at each width, `Board.panelMode`); the sidebar and the
  panel render again when the panel comes or goes and when the drag
  ends.
- **Stalls leave a line** in `~/Library/Logs/Ravenry/app.log`
  (`DrawWatch`, at most one every 10 s, with the count since): a draw
  that waited over 50 ms for its drawable, a live resize's step not
  drawn at its size within one display refresh, the drawables out (taken
  and not reported shown) and those in the uncommitted transaction, and
  how many draws were put off.
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

## The app on its own: Ravenry on the Mac

On the Mac this app is Ravenry: it replaces the Electron app at
/Applications/Ravenry.app and does on its own what the Electron app's
main process did there (`apps/desktop/src/main`: main.ts, install.ts,
daemon.ts, npmswitch.ts). The Electron app stays the app for Linux and
Windows. What it takes over, and how:

- **The same app to macOS.** `scripts/package.mjs` makes Ravenry.app with
  the Electron app's bundle id (`dev.ravenry.app`), name, version and
  executable name (`Contents/MacOS/Ravenry`), signed with the same Apple
  Development identity (`apps/desktop/scripts/local-identity.mjs`, the
  keychain only read), the hardened runtime and the Electron app's
  entitlements, the words macOS shows when a pane asks for a guarded
  folder, the camera... (read from `electron-builder.config.mjs`). Its
  designated requirement is the Electron app's, word for word, so what
  the person allowed Ravenry (Documents, notifications, automation) still
  holds.
- **The version folders** (UPD-001). At launch, before it looks for a
  daemon, the app copies its ravenryd, hub and remote/ builds to
  `<data>/versions/<version>` unless that build is there, and links
  `<data>/bin/ravenryd` and `<data>/bin/ravenry` to it. `<data>` is
  `RAVENRY_DESKTOP_DATA`, else ~/Library/Application Support/Ravenry, the
  Electron app's folder: window.json, settings.json, themes/ and the
  version folders are shared as they are; the onboarding marks are the
  hub's (`/api/onboarding`).
- **The hub service** (HUB-001, UPD-005). Then, in the background, the
  launchd agent `dev.ravenry.hub` (~/Library/LaunchAgents) is installed or
  brought to this build, the new hub must answer before the old folder can
  go, a failed update is tried again at the next launch and stops after
  three (`<data>/update.json`), and a minute later the version folders
  nothing runs from are removed, their hook scripts left as stubs. Beside
  an npm board it installs nothing, and finishes a switch whose traces are
  left, as the Electron app does; the switch's screen itself is the
  Electron app's only.
- **One copy of that logic.** All of the above is the Electron app's own
  code (install.ts, npmswitch.ts), run on the app's Node:
  `install/setup.ts`, bundled by esbuild into `Resources/setup.mjs`, run
  by `Install.swift` (`stage`, `hub`, `prune`), each answering one line of
  JSON and writing what it did to ~/Library/Logs/Ravenry/app.log as the
  Electron app did.
- **Node** (Contents/MacOS/node): Node.js 24.22.2 for macOS arm64, the
  version Electron 45 carries, the official build from nodejs.org, its
  SHA-256 checked against the release's SHASUMS256.txt, signed again with
  the app. The hub, the setup and the hooks run on it; the window does not.
- **Its executable as Node** (`NodeRunner.swift`). Started with
  `ELECTRON_RUN_AS_NODE=1`, `Contents/MacOS/Ravenry` runs that Node with
  the same arguments, as its child, passing signals on and exiting as it
  exits. So the hub service keeps the program it had (the plist names the
  app's executable, as the Electron app wrote it), the hooks the Electron
  app wrote into ~/.claude/settings.json and ~/.codex/hooks.json
  (`ELECTRON_RUN_AS_NODE=1 .../Contents/MacOS/Ravenry
  <data>/current/hub/hooks/...`, read once by each running session) run
  unchanged, and macOS asks about the hub's reads of ~/Documents for the
  process responsible for it, the app's own executable, as before: the
  grant holds, and a new prompt would name Ravenry. Hooks the hub writes
  from now on name `Contents/MacOS/node` directly (no extra process).
- **The daemon** (HUB-006, UPD-004). With no `--socket`, the newest
  running daemon that has the render stream and is not draining, as the
  Electron app's DaemonLink finds it; none, and the app starts its own
  from the version folder (`ravenryd serve --detach`, its own process
  session); an older one, and its own starts beside it and the window
  opens on that, while the old one keeps its panes until they end.
  The window draws every running daemon that has the render stream
  (`Daemons.swift`): one connection each, the daemons in the runtime
  folder at the start and every 2 seconds after (a newer app's daemon
  that starts later joins), each with the hello as `ravenry-desktop`, so
  the daemon takes the app for the person on every one (the 0.1.23 daemon
  does as this one: its peer check is the same). Every pane of each is a
  normal tab over its own daemon's connection: keys, mouse, paste,
  resize, selection, links, bell, activity, titles, closing, its lease,
  Typed here (`pane.inputs`) and the panel go to the pane's own daemon.
  New panes (a new tab, a split, New session, Continue, Move here) go to
  the newest daemon that does not drain, as the hub's; a draining one's
  panes stay live tabs until they end, and a daemon that goes away takes
  its tabs. Pane ids are unique across daemons, so the tabs' order,
  splits and tab in front stay in the one layout file of the runtime
  folder (its daemons share it), as before. Read only in the middle, with
  Move here: sessions in a daemon without the render stream (0.1.22,
  0.1.10 and older) and sessions in other terminals (cmux, iTerm2, Rex).
- **macOS asking** (SIGN-005). While macOS asks whether Ravenry may read a
  protected folder, the hub answers 503 with the folder
  (hub/server/access.mjs), and the sidebar says the sessions show up once
  macOS lets Ravenry read it, with where to turn it on.
- **What it takes from its launch.** As the Electron release (gate.ts),
  the variables that name a program to run in place of the app's own or
  the hub's stand-ins (RAVENRYD, RAVENRY_LAUNCHCTL, NODE_OPTIONS, MC_*,
  STUB_*...) are dropped, unless `RAVENRY_SERVICE_LABEL` is a test's
  launchd label (`dev.ravenry.hub.test-<random>`), which the install check
  uses.
- **A start from a pane** (`Relaunch.swift`, the Electron app's
  relaunch.ts). macOS's `open` hands the caller's environment to the app,
  so an agent in a pane that runs `open -a Ravenry` starts it with
  `RAVENRY_PANE` and `RAVENRY_SOCKET`, and the daemon, which reads a
  process's first environment, takes the window for that pane's program:
  the person's typing and pastes went to the agent as its own ("Claude
  wants to type"), and the hub refused Move here, Focus and the alerts'
  answers (2026-11-10). Such a start of the packaged app, after
  ELECTRON_RUN_AS_NODE and `--older-hub-check` and before any window,
  daemon or hub, leaves the marker `relaunched-from-pane.json` in its data
  folder, starts a detached helper that waits for it to exit and runs
  `/usr/bin/open -n -a` on the bundle with the Electron app's clean
  environment (HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LANGUAGE, TZ,
  SSH_AUTH_SOCK, LC_*, __CF_USER_TEXT_ENCODING, PATH
  `/usr/bin:/bin:/usr/sbin:/sbin`) and no arguments, and exits 0. The
  relaunched app writes `launch: relaunched clean ... dropped: ...` to
  app.log; one that still has a pane's variables with a fresh marker (under
  a minute old) stays and says so (the loop guard). A development build, a
  window off every screen (`--offscreen` or `RAVENRY_OFFSCREEN=1`: the
  bench and the self-tests) and a test run (`RAVENRY_DESKTOP_DATA` or
  `RAVENRY_SERVICE_LABEL` set) never relaunch, unless
  `RAVENRY_RELAUNCH_TEST` asks with test folders, as in
  `scripts/relaunchcheck.mjs`. The app still removes `RAVENRY_PANE`,
  `RAVENRY_SOCKET` and `TERM_PROGRAM*` from its own environment, so a start
  that stays never passes them to what it starts.
- **Updates.** The local path: a newer Ravenry.app put in place of this
  one copies its version out at its next launch, rewrites the service and
  starts its daemon beside the old one; nothing running stops. Downloads
  from the releases (UPD-002) are the Electron app's only for now.

A development build (`scripts/build.sh`: RavenryMac.app, no build.json,
no Node) does none of this: it finds a running daemon and starts none.

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

## Package and the install check

```sh
node scripts/package.mjs [--app RavenryMac.app] [--zip OUT.zip]
node scripts/installcheck.mjs build/package/Ravenry.app ELECTRON_APP OLD_RAVENRYD [OUT]
```

`package.mjs` stages ravenryd (the desktop app's version), the hub,
remote/ and build.json as the Electron package does
(`apps/desktop/scripts/pack.mjs --stage-only`), builds the app
(`build.sh`) unless one is given, fetches and checks Node, and makes
build/package/Ravenry.app and its zip (above, "The same app to macOS").

```sh
node scripts/relaunchcheck.mjs [build/package/Ravenry.app] [OUT]
```

`relaunchcheck.mjs` starts a copy of the packaged app off every screen in
a throwaway HOME, data, runtime and state folder (no service, a hub nobody
answers) as an agent in a pane would, and checks it exits, a clean one
started by launchd runs with none of the pane's variables or the caller's
arguments (`ps eww`), app.log's lines, the loop guard, that a clean start
and `--older-hub-check` do not relaunch, about 20 seconds ("A start from
a pane" above).

`installcheck.mjs` runs the packaged app off every screen in throwaway
HOMEs, its hub service loaded into the real launchd under a test label
(`dev.ravenry.hub.test-<random>`, booted out at the end), with the hub's
stand-ins for ps, lsof, cmux, open and osascript, about two minutes:

- fresh: the version folder and links, the service run as the app's
  executable with the hub on its Node as its child, current/ pointed, its
  own daemon started, a shell opened and drawn, a typed line drawn, the
  hooks (as the hub writes them, and as the Electron app wrote them) run,
  app.log, and the window quit leaves the daemon and the hub running;
- update: over the Electron app's install (ELECTRON_APP, set up with its
  own resources and executable, its hub service running, its daemon with
  three shells, an older daemon from OLD_RAVENRYD with one, its hooks),
  the native app put at the same path: the Electron app's hooks run on it
  before its first launch; launched, it opens on the running daemon with
  the three shells as tabs in the saved order, rewrites the service so
  exactly one hub answers, on its Node, restages the version, starts no
  daemon, and the older daemon, its shell and its folder stay;
- access: while the hub waits for macOS's answer about ~/Documents, the
  sidebar says so.

Both checks run copies of the app, and macOS lists every bundle it has run
as an app of its own, which asks for the screen or the files under its own
name (2026-11-10: "Ravenry-electron-0.1.23 would like to record this
computer's screen and audio", from a copy in /private/tmp). So they take
their copies out of LaunchServices' list with `tools/launchservices.mjs`
before removing them, on exit, Ctrl+C and SIGTERM too, and fail at the end
naming any copy still listed ("The release check" in
apps/desktop/README.md). A copy made by hand: `node
tools/launchservices.mjs --clean` when done.

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

`node scripts/resizebench.mjs [DIR]` drags the whole window as the person
has it: a throwaway daemon and the demo hub (`apps/desktop/tools/demo-hub.mjs`),
the sidebar and the docked panel shown, four tabs, the one in front
printing about 30 lines a second, drawn through the window's Metal layer
with the window in a live resize (`--bench-resize`; AppKit's flag cannot
be set, so `TerminalWindow.simulatedLiveResize` stands for it). The width
goes from 1440 pt to 700 and back at 120 steps a second, each step a
`setFrame` with display. It prints each step's main-thread time, the
draws in each step and the steps not drawn at their size, the draws a
second and the longest gap, the waits for a drawable, the draws of the
tabs not in front, four draws asked in one turn (none may wait, the one
put off is done after), the lines the stall log wrote and whether it
writes one (a made-up stall at the end). On 2026-11-10,
before the fix: 2 to 4 draws a step, 17.7 ms a step (median, 149 of 213
steps over 16 ms), 4.29 s for the drag; after, in three runs: 1 draw a
step (12 to 18 of 212 steps also had a frame of the busy pane), 8.3 to
8.4 ms a step (4 to 12 over 16 ms), 1.88 to 1.93 s (the 120 steps a
second asked take 1.78 s), every step drawn at its size, the longest gap
between draws 17 to 18 ms, no draw of a tab not in front. Off every screen a
drawable taken in an uncommitted transaction is still given back at once
(its presented handler in under 2 ms), so this bench cannot show what a
screen does with them.

`node scripts/resizebench.mjs --onscreen` runs the same drag with the
window on the screen (it shows a window: only with the person's yes),
and prints the drawables out at each step, the time from a step to its
draw at its size and from a present to its presented handler. On
2026-11-10 (a 120 Hz screen, the window 1440 to 700 pt by 744 pt at 2x),
the hold on presented handlers of 0.1.24: 20 of 212 steps not drawn in
their step, 22 draws put off, a step drawn 1656 ms after it at worst;
presented handlers 7.8 ms after the present (median), up to 29 ms. The
same drag with the sheet's corners square changed nothing that counts
(18 not drawn, 18 put off). Taking a drawable at every step, as the first
window did: 0 not drawn, 0 put off, at most 25 to 27 ms from a step to
its draw. With the commit's gate (now): 0 not drawn, 0 put off, a step
drawn at its size 4.2 ms after it (median), 20.7 ms at most, waits for a
drawable 0.8 ms (median), 14.9 ms at most.

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
(`SelfTestScreens.swift`: `brief`, `gallery`, `plan`, `idea`, `alerts`, `pages`, `cards`, `panes`, `tabmarks`, `review`, `window`, `daemons`) on the demo hub with its plan, its
idea and a project whose brief has every shape a brief takes, and leaves
`native-NAME-{1280,900}-{dark,light}.png`.

`SIDETEST_OLD_RAVENRYD=PATH node scripts/sidetest.mjs --screen daemons [DIR]`
(`SelfTestDaemons.swift`) is the window on two daemons, as after an
update: an older release's ravenryd (PATH, 0.1.23 or later) with two
shells, one printing 30 lines a second, and the app on it with no
`--socket`; then this tree's ravenryd, built as the desktop app's version,
starts beside it with two shells of its own and drains the older. Every
shell of both must be a live tab on its own daemon's stream, take typed
keys as the person (its own input log says `person`, no drive question
on either daemon, the other shell gets none), take a resize on its own
daemon, a session in the older one opens as its tab, a new tab goes to
the newer, a closed pane ends in its own daemon, and the app started
again on both restores every tab in the saved order. `node
scripts/resizebench.mjs --daemons PATH [--front old|new]` drags the
whole window as the resize bench does with the busy tab in front in the
older daemon or the newer.

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

With no `--socket`, it opens on the newest running daemon that has the
render stream (protocol method `pane.render`) and draws every other one
that has it, those that start later too; the packaged app starts its
own when none runs, or beside an older one ("The daemon" above), a
development build never does. With `--socket`, that daemon only. Its shells are the tabs, a new one (the
login shell, or COMMAND) when it has none; the panes keep running when
the window closes. The packaged app started from a Ravenry pane relaunches
itself clean ("A start from a pane" above); a development build does not,
so launch it from outside a pane, or with `--offscreen`.

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

- One window: no New Window, or tab dragged to an edge to split.
- A program's steady block cursor reads as the default, so the
  settings' cursor style shows instead.
- Sidebar and panel: Learn's ticks come only from the phone card and
  Decisions (no hints, no filmstrip to tick), and its filmstrip card shows
  the busiest terminal; no session on another machine (MACH-005 to
  MACH-007); Decisions has no add, edit or remove (DEC-004, no client has them); a page's run button says its approval waits
  (the panel has no card of its own for a page's run yet), a page's form
  takes a date as text, and a sheet taller than the window is cut;
  a pinned session that runs outside gets no tab of its own; Typed here has no filters or whole log;
  no filmstrip.
- A session in a pane of a daemon without the render stream (before
  0.1.23) is shown read only, with Move here, as one outside.
- No images (Kitty graphics, sixel); OSC 52 clipboard and notifications
  are not forwarded. Find has no match-case or regular expression
  option (the daemon's search ignores the case of ASCII letters).
- The scrollbar shows the position but cannot be dragged.
- `build.sh` signs ad hoc for local runs; `package.mjs` signs with this
  Mac's Apple Development identity, for Apple silicon only, not notarized
  (SIGN-004), and makes no dmg.
- Taking over from the Electron app: no update from the releases
  (UPD-002) and no Check for Updates; a failed update is only in app.log
  (UPD-003 has no Try again); no screen for the npm board's switch (the
  app installs no hub beside an npm board, and says so in app.log); the
  panes of a daemon without the render stream (before 0.1.23) are read
  only in the window; opened from inside a
  pane, the app drops the pane's variables but does not relaunch itself
  (UPD-007).
