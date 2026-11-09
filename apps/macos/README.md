# Ravenry for macOS (native spike)

A native Mac app, Swift and AppKit with no web view, whose terminals are
drawn by Ghostty's embedding library (GhosttyKit), as cmux does. This is
the first piece: one window, one terminal, attached to a pane of ravenryd.
It exists so the resize, typing and large output of a native terminal can
be judged against the Electron app.

Licence: GPL-3.0-only, like the other apps. It links GhosttyKit (MIT,
Mitchell Hashimoto and Ghostty contributors), fetched and built locally,
never committed. `TerminalView.swift` and `GhosttyRuntime.swift` are
adapted from Ghostty's own macOS app and say so.

## How it works

```
  RavenryMac (Swift)                     ravenryd (Go)
  +-------------------------+            +----------------------+
  | NSWindow                |            |  pane: pty, process, |
  |  TerminalView (NSView)  |            |  screen (libghostty- |
  |   Ghostty surface       |            |  vt), log            |
  |    pty <-> `ravenryd    | unix socket|                      |
  |            attach` -----+----------->|  pane.new/subscribe, |
  |                         |  protocol  |  input frames,       |
  +-------------------------+     v1     |  pane.resize         |
                                         +----------------------+
```

- **The surface's command is `ravenryd attach`** (bundled in the app beside
  its executable). Ghostty runs it on a pty of its own, as it would run a
  shell. Ghostty owns drawing, keys, the input method, selection and
  resize; the daemon owns the pane.
- **Bytes:** the pane's snapshot, then its live output, come over the
  protocol and are written to the pty as they are; what Ghostty writes
  (keys, pastes, mouse and focus reports) goes to the pane in input frames,
  as the person's keystrokes.
- **Resize:** the window resizes the view, Ghostty resizes its grid and its
  pty, `attach` gets SIGWINCH and sends `pane.resize` (the newest size
  wins while one is on its way). The program redraws, as in any terminal.
  Two things keep a drag from blinking or leaving debris:
  - Ghostty clears a shell's prompt on a resize, expecting the shell's
    redraw within microseconds, as on a local pty. Through the daemon it
    comes milliseconds later, and the command line vanished on each step
    of a drag. Keeping the prompt instead (OSC 133 `redraw=0`) is worse:
    zsh redraws from where it counted its prompt began at the old width,
    which the reflow moved, and a narrow window filled with old "~ >...."
    rows. So the window's Ghostty keeps the clear and holds its frames in
    synchronized output from that clear until the redraw ends it, with
    Ghostty's own 1 s reset timer (`patches/ghostty-hold-prompt-redraw.patch`).
  - The same patch makes the clear start at the prompt's first row. At
    this Ghostty pin it started at the cursor's own line when the command
    line has several lines that wrap (the rows a line wraps onto carry no
    prompt mark), so the rows above stayed and zsh's redraw doubled them.
    The daemon's libghostty-vt still has that, so its own screen can hold
    such rows during a drag at a narrow width; the window does not.
  - From the first change of size until the pane has the window's size and
    its output has been quiet for 8 ms, `attach` keeps the output back and
    then writes it as one synchronized update, so the window never draws a
    redraw half done; that update's end, even when it carried nothing, is
    what ends the hold above. Output is held at most 250 ms after the last
    change (`daemon/internal/attach`).
- **Queries:** Ghostty answers a program's terminal queries, and the
  daemon answers many of them too (PROTOCOL.md section 3), so a program
  would read two answers. They split by who knows: what the screen's state
  decides (device attributes, cursor position, modes, XTVERSION, the
  palette, Kitty keyboard and graphics) the daemon answers, and `attach`
  drops Ghostty's answer; what only the window knows (its colours, light
  or dark, its size in pixels, terminfo capabilities) Ghostty answers and
  the daemon does not. `attach` drops only what a keyboard cannot produce
  (`daemon/internal/attach`).
- **Panes outlive windows,** except the pane a window started for itself
  in this spike (`attach --new --close`): closing or killing the window
  closes it.

### What is shared, for the next native clients

Everything a Linux or Windows native client would need again is in Go, in
the daemon's binary, not in Swift:

- `ravenry attach` (`daemon/cmd/ravenryd/attach.go`): connecting, starting
  or finding the pane, the byte relay, resize, closing. Any terminal
  widget that runs a command on a pty (VTE on Linux, a ConPTY host on
  Windows) gets a Ravenry pane by running it.
- The query filter (`daemon/internal/attach`), with its tests.
- The protocol itself (`packages/protocol`), unchanged by this app.

The Swift side is only what is AppKit's: the window, the NSView that hosts
the surface, key events and the input method, mouse, clipboard. GhosttyKit
embeds on macOS and iOS only; on Linux the same `attach` works under any
terminal widget.

## Build

Needs Xcode (27.2 here), Zig 0.17 or newer (Ghostty's minimum at this pin
is 0.17.0), Go, git and XcodeGen.

```sh
cd apps/macos
scripts/build.sh          # prints build/RavenryMac.app, signed ad hoc
scripts/selftest.sh       # the headless check (below)
```

- `scripts/ghosttykit.sh` fetches Ghostty into `vendor/ghostty` and builds
  `vendor/GhosttyKit-<commit>-....xcframework` (about two minutes the first
  time). **One Ghostty pin for the repository:** it takes the commit from
  the go-libghostty version in `daemon/go.mod`, as
  `daemon/scripts/libghostty.sh` does, so the daemon's terminal state and
  the window that draws it come from the same Ghostty.
- Built with `-Dsentry=false`: Ghostty's crash reporter would keep files in
  Ghostty's own cache folder, shared with every app that embeds Ghostty.
- **The Metal Toolchain:** Ghostty compiles its shaders at build time with
  `xcrun metal`, an Xcode component downloaded on its own. Without it, the
  script applies `patches/ghostty-runtime-metal.patch`, which embeds the
  shader source and compiles it when a surface starts. Installing the
  toolchain (`xcodebuild -downloadComponent MetalToolchain`) gives
  Ghostty's own shader build.
- **Always applied:** `patches/ghostty-hold-prompt-redraw.patch` (two
  files of `src/termio` and `src/terminal/Screen.zig`), the resize hold
  and the prompt clear described under Resize above.
- `project.yml` is the XcodeGen spec; the `.xcodeproj` is generated by the
  build and not committed.

## The headless check

`scripts/selftest.sh` starts the app's own ravenryd as a throwaway daemon
(HOME, runtime and state folders in the repository's `.tmp/`, `/bin/sh` as
the shell), then the app with its window off every screen and no Dock
icon. The app (`SelfTest.swift`) types through its own key path, reads
what Ghostty shows, grows the window, prints 200000 lines, runs a program
that asks the terminal questions, and saves a picture of what Ghostty
drew. The script checks the daemon's side: the pane's input log has the
typed command as the person's, the pane took the window's size, the
program read one answer to each question, and a killed window's pane is
closed.

`scripts/drag-test.sh` drags the window over a long multi-line command
line at a zsh prompt (as a person pastes one) on a throwaway daemon. After
each of the 166 steps it measures how much text Ghostty's last frame
shows, then compares the window's final screen with the daemon's.
`attach` records what it sends the window (`RAVENRY_ATTACH_TRACE=<file>`),
and the script counts the snapshots and screen clears the window got.

## Run

```sh
build/RavenryMac.app/Contents/MacOS/RavenryMac [--socket PATH] [--attach PANE] [-- COMMAND ARGS...]
```

With no `--attach`, it starts a new pane (the login shell, or COMMAND) in
the newest running daemon, never starting one, and closes it when the
window closes. Launch it with `open`, from outside a Ravenry pane or with
the pane's variables removed (the app removes `RAVENRY_PANE` and
`RAVENRY_SOCKET` from its own environment too).

## Not done yet

- One window, one terminal: no tabs, splits, sidebar, settings or menus
  beyond Quit and Close.
- Copy and paste are text only; a program reading the clipboard (OSC 52)
  is refused; no confirmation dialogs.
- The palette query (OSC 4) gets the daemon's palette, not the window's
  theme. Two windows on one pane would both answer the window queries.
- Ghostty starts the command through `login(1)`, as for a shell, so each
  window is a login session (it shows in `who`).
- The app is signed ad hoc for local runs, for this Mac's architecture.
