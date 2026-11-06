# Ravenry desktop app

The Electron window: the board in a sidebar (what needs you first), real
terminals in the middle, and the session panel on the right. It ships as a
DMG for macOS (Apple silicon and Intel) and as an AppImage and a .deb for
Linux (x64 and arm64), with ravenryd and the hub inside.

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

## What the packaged app installs

Nothing outside the user's own folders, and nothing as root.

- **Its version of ravenryd and the hub, copied out of the app** on
  launch to `versions/<version>/` in the data folder
  (`~/Library/Application Support/Ravenry` on macOS,
  `~/.local/share/ravenry` on Linux), with `bin/ravenryd` and `bin/ravenry`
  linking to the newest. Daemons and the hub run from that copy, so
  replacing the app
  (an update, an AppImage unmounting) never pulls a running binary away. A
  version folder goes once nothing runs from it.
- **The hub as a user service**, always on, so alerts reach the phone with
  the window closed: a launchd agent (`~/Library/LaunchAgents/gg.ravenry.hub.plist`)
  or a systemd user unit (`~/.config/systemd/user/ravenry-hub.service`). It
  runs the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no
  Node is needed, on the copied hub, in Ravenry terminal mode. An AppImage
  runs from a folder it mounts only while it runs, and its launcher adds
  `--no-sandbox`, which Node refuses, so its hub runs a copy of the
  Electron runtime kept in `versions/<version>/runtime`. Written on
  first launch, rewritten and restarted when the app changes. When a board
  already runs (`ravenry` from npm) and no service of ours exists, nothing
  is installed and the app uses that board. `RAVENRY_SERVICE=off` turns it
  off; `dry-run` writes the file and runs no launchctl or systemctl.

## Updates

From the GitHub Releases of this repository (electron-updater). macOS and
the AppImage download a new version in the background and install it when
the app quits, or at once from the menu (Ravenry > Check for Updates on
macOS, Help on Linux). A .deb does not update itself and says so there.
A Mac update needs a signed app: an unsigned build cannot update.

**An update never ends a session.** Sessions live in ravenryd, not in the
app. On the next launch the new version's ravenryd starts beside the old
one: new panes go to it, and the old one keeps its panes and exits once
they end (../../packages/protocol/PROTOCOL.md section 9). The hub service is
restarted onto the new version; ravenryd runs in its own process session
and the service leaves it alone (`AbandonProcessGroup`, `KillMode=process`).

## Packaging

```sh
npm run pack                          # this machine: DMG and zip, or AppImage and .deb
npm run pack -- --dir                 # the unpacked app only
npm run pack -- --mac --arch arm64,x64 --ravenryd DIR   # ravenryd-<platform>-<arch> from DIR
node tools/package-check.mjs release/Ravenry-<version>-mac-arm64.dmg
```

`scripts/pack.mjs` stages ravenryd (built here by
`scripts/build-ravenryd.sh` when it is for this machine: static on Linux,
macOS 13 or newer on the Mac, the app's version), the hub and
`build.json`, then runs electron-builder (`electron-builder.config.mjs`).
`tools/package-check.mjs` checks a DMG, zip, AppImage, .deb or unpacked
app: what is inside, then the app offscreen beside an older ravenryd, the
hub service in dry-run mode in a throwaway HOME, and the hub run as that
service says. CI's release workflow (`.github/workflows/release.yml`)
builds every target on a machine of its own, checks every artifact and,
on a `v*` tag, uploads them to a draft release, never published by CI.

**Signing (macOS).** With a Developer ID certificate (`CSC_LINK`,
`CSC_KEY_PASSWORD`) the app is signed with the hardened runtime, and with
an App Store Connect API key (`APPLE_API_KEY` as the .p8's path,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) it is notarized. Without a
certificate it is signed ad hoc and the build says UNSIGNED loudly: it
runs on the machine that built it, macOS blocks it after a download, and
it cannot update itself. No keychain is ever searched for an identity.

## Layout

| Path | |
| --- | --- |
| `src/main/` | The main process: the window and menu, the daemon pipe, the hub feed, first-launch lookups. |
| `src/preload/` | The page's only door to the main process. |
| `src/renderer/` | The page: sidebar, tabs, terminal, panel, first launch. `model.ts` turns the hub's state into the sidebar (tested without a window). |
| `test/` | Unit tests (`npm test`). |
| `tools/` | The end-to-end smoke test, the packaged app's check, screenshots and the echo measurement, all offscreen. |
| `scripts/` | Packaging: `pack.mjs`, `build-ravenryd.sh`. |
| `build/` | electron-builder's resources (the Mac entitlements). |

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
