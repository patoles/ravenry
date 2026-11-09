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
  glyphs and lines (underline styles, strikethrough, cursor, selection).
  Glyphs come from a CoreText atlas, one per grapheme cluster and face
  (regular, bold, italic), wide characters over two cells, colour emoji
  as they are. Palette colours resolve with the app's theme (the desktop
  app's) and whatever the program changed. The shaders are compiled when
  the app starts, so the build needs no Metal Toolchain.
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
- **Mouse, scrolling, selection**: when the program asks for the mouse,
  clicks, drags and the wheel go to it (Shift selects anyway); otherwise
  the wheel scrolls the scrollback (`render.scroll`; on the alternate
  screen it sends arrow keys) and the mouse selects (two clicks a word,
  three a line, Option a block). Copy reads the selection from the
  daemon (`render.text`), so it works beyond the rows on screen.

## Build

Needs Xcode (27.2 here), Go, XcodeGen and Zig 0.17 (for the daemon's
libghostty-vt, `daemon/scripts/libghostty.sh`).

```sh
cd apps/macos
scripts/build.sh          # prints build/RavenryMac.app, signed ad hoc
scripts/bench.sh [DIR]    # the headless bench (below)
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
- for `seq`: the time to the prompt and the draws a second.

The daemon's own drag test (`daemon/internal/server/drag_test.go`) does
the same through the protocol with a Go client.

## Run

```sh
build/RavenryMac.app/Contents/MacOS/RavenryMac [--socket PATH] [--attach PANE] [--option-as-alt left|right|both] [-- COMMAND ARGS...]
```

With no `--attach`, it starts a new pane (the login shell, or COMMAND) in
the newest running daemon that has the render stream (protocol method
`pane.render`), never starting one, and closes the pane when the window
closes. Launch it with `open`, from outside a Ravenry pane or with the
pane's variables removed (the app removes `RAVENRY_PANE` and
`RAVENRY_SOCKET` from its own environment too).

## Not done yet

- One window, one terminal: no tabs, splits, sidebar or settings.
- Box-drawing and block characters come from the font, so with the
  1.15 line height there are gaps between rows; Ghostty draws them
  itself.
- No scrollbar; no link opening (links are in the frames); no images
  (Kitty graphics, sixel); OSC 52 clipboard and notifications are not
  forwarded.
- The app is signed ad hoc for local runs, for this Mac's architecture.
