# Ravenry desktop app

The Electron window: the board in a sidebar (what needs you first), real
terminals in the middle, and the session panel on the right. Still to come:
the signed and notarized DMG with auto-update on macOS, and the Linux build.

It holds no terminals itself. Sessions live in `ravenryd` (../../daemon), so
they survive the window closing, restarting or updating. The window talks
to the daemon over protocol v1 (../../packages/protocol) through
`@ravenry/client` (../../packages/client), and reads sessions from the hub
(../../hub).

Licence: GPL-3.0-only (../../LICENSING.md).

## Run it

```sh
npm install                      # at the repository root
cd daemon && make && cd ..       # ravenryd (daemon/README.md)
npm run desktop                  # builds dist/ and opens the window
```

The app finds the newest running daemon (PROTOCOL.md section 9) and starts
`ravenryd serve --detach` when none runs: `RAVENRYD`, else the one shipped
in the app, else `daemon/ravenryd` in this repository, else the `PATH`. The
board comes from the hub the running board wrote to `~/.ravenry/board.json`
(`RAVENRY_HUB_URL` overrides it). The top of src/main/main.ts lists every
setting.

## How it is built

- **Electron 45.2.2, pinned exactly.** 45.2.3 draws xterm.js's WebGL text
  tiny (xterm.js #6297, electron/electron#55616). Check a screenshot on every
  Electron bump.
- **xterm.js 6 with the WebGL addon**, one instance for the pane on screen.
  Tabs that are not on screen run no xterm.js at all: the daemon keeps their
  screens, and showing one subscribes again, which starts with a fresh
  snapshot.
- **The daemon answers terminal queries**, so xterm.js must not: its query
  replies are swallowed (`suppressTerminalQueries` in @ravenry/client).
- **Acks:** each frame is acknowledged in xterm.js's write callback, so the
  daemon bundles output by backlog and a slow window never slows a pane.
- **Paste** goes to the daemon as one paste (`pane.send`, mode `paste`): it
  is bracketed when the program asked for it, and unsafe control
  characters are made harmless.
- **The page is sandboxed.** It reaches the daemon through a MessagePort
  that the main process pipes to the daemon's unix socket, and the hub
  through the main process.

## Layout

| Path | |
| --- | --- |
| `src/main/` | The main process: the window and menu, the daemon pipe, the hub feed, first-launch lookups. |
| `src/preload/` | The page's only door to the main process. |
| `src/renderer/` | The page: sidebar, tabs, terminal, panel, first launch. `model.ts` turns the hub's state into the sidebar (tested without a window). |
| `test/` | Unit tests (`npm test`). |
| `tools/` | The end-to-end smoke test, screenshots and the echo measurement, all offscreen. |

## Shortcuts

| macOS | Linux | |
| --- | --- | --- |
| ⌘T | Ctrl+Shift+T | New shell |
| ⌘N | Ctrl+Shift+N | New session |
| ⌘W | Ctrl+Shift+W | Close the tab (ends the shell and everything it started) |
| ⌘1 to ⌘9 | Alt+1 to Alt+9 | Go to a tab |
| Ctrl+Tab, ⌘⇧] | Ctrl+Tab | Next tab |
| ⌘⌥B | Ctrl+Shift+B | Show or hide the session panel |
| ⌘C, ⌘V | Ctrl+Shift+C, Ctrl+Shift+V | Copy, paste |

## Checks

```sh
npm run typecheck && npm test
RAVENRYD=../../daemon/ravenryd npm run smoke          # the app end to end, offscreen
RAVENRYD=../../daemon/ravenryd npm run shots -- out   # screenshots and keystroke echo
```

The smoke test and the screenshots never put a window on screen: the
window renders offscreen and is captured. They run with a throwaway HOME,
app data folder and daemon runtime folder, and the screenshots use a demo
board (`tools/demo-hub.mjs`) whose projects are made up.
