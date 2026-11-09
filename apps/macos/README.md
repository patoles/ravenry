# Ravenry for macOS (native)

A native Mac app, Swift and AppKit with no web view, that draws its
terminal itself, the way Rex does: the daemon's screen (libghostty-vt in
`ravenryd`) is the only screen, the app draws the rows the daemon sends
with its own Metal renderer, and the daemon encodes the person's keys and
mouse for the program. There is no second terminal emulator to drift from
the daemon's, which is what made the first spike (GhosttyKit fed by
`ravenryd attach`) blink and leave prompt debris on a resize.

One window, one terminal, attached to a pane of ravenryd.

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
  daemon's unix socket, on a plain socket, with a reader thread.
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
  leaves the descent at the cell's bottom. The default is Menlo 12, 14 x
  28 px at 2x, Rex's cell. Cmd+= (or Cmd++), Cmd+- and Cmd+0 change the
  size from 6 to 72 points, in the View menu too; the size is kept for
  the next launch (never by the bench or the self-test). `--font` and
  `--font-size` pick another.
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
  cursor and only its committed text is sent. `--option-as-alt` makes
  Option act as Alt.
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

## Not done yet

- One window, one terminal: no tabs, splits, sidebar or settings.
- No images (Kitty graphics, sixel); OSC 52 clipboard and notifications
  are not forwarded. Find has no match-case or regular expression
  option (the daemon's search ignores the case of ASCII letters).
- The scrollbar shows the position but cannot be dragged.
- The app is signed ad hoc for local runs, for this Mac's architecture.
