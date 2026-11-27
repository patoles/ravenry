<p align="center"><img src="hub/brand/ravenry/readme-logo.png" alt="Ravenry logo: a white raven with a blue eye" width="112"></p>

# Ravenry

Your coding agents are only as fast as your decisions. Run several at
once and it’s easy to miss the one that stopped to ask. **Ravenry is an
open-source terminal that brings every decision to one place**, in a
simple interface made for deciding fast. Answer from your Mac or your phone.

<p align="center"><img src="site/assets/og-image.png" alt="The Ravenry Mac app: the board of sessions beside a terminal, and the phone with the same question" width="720"></p>

## How it works

1. **Run your agents as usual.** Start Claude Code, Codex, OpenCode or
   Antigravity CLI in Ravenry on your Mac. Sessions on Linux and Mac
   machines connected over SSH appear on the same board. The terminals
   keep running when you quit or update the Mac app.
2. **Stop hunting through tabs.** Say Claude Code wants to commit a change
   while Codex is still writing tests. Ravenry uses agent events and the
   live terminal screen to put Claude’s request under **Needs you**, with
   the command and what led up to it.
3. **Decide on the spot.** Each request becomes a card made for that kind
   of decision: options as buttons, a command to approve or decline,
   designs side by side. Your response goes to the session that asked. You
   can also save a project decision for future sessions to check before
   they ask again.

[Watch the 30-second demo](docs/media/ravenry-30s.mp4).

## Download

Start with the Mac app (Apple silicon, macOS 13 or later) and a supported
coding agent installed and signed in. To answer away from your desk, pair
the Android or iPhone/iPad app over the same Wi-Fi or through Tailscale.
Ravenry is in early testing. The Mac app updates itself.
[Download Ravenry](https://patoles.github.io/ravenry/).

## Build from source

Each app's README has the details. You need Node 22 or later for all of
them, and `npm ci` at the root of the repository first.

| What | Needs | Build |
| --- | --- | --- |
| `ravenryd`, the daemon ([daemon/](daemon/README.md)) | Go, Zig 0.17 or later, git | `cd daemon && make && make test` |
| The Mac app ([apps/macos/](apps/macos/README.md)) | macOS 13 or later, Xcode, XcodeGen, Go, Zig | `cd apps/macos && scripts/build.sh` |
| The Linux desktop app ([apps/desktop/](apps/desktop/README.md)) | Linux or macOS, Go, Zig | `npm run desktop` to run it; `npm --workspace @ravenry/desktop run pack -- --linux` for an AppImage and a .deb |
| The Android app ([apps/android/](apps/android/README.md)) | Java 17, the Android SDK | `cd apps/android && ./gradlew assembleDebug` |
| The iPhone and iPad app ([apps/ios/](apps/ios/README.md)) | Xcode, XcodeGen | `cd apps/ios && scripts/build.sh` (the simulator) |
| The hub, the board's server ([hub/](hub/README.md)) | macOS | `cd hub && npm ci && npm start` (http://localhost:4600) |

## The repository

| Folder | What |
| --- | --- |
| `daemon/` | `ravenryd`, the Go daemon on every machine: terminals, screen state through libghostty-vt, waits and input for agents, the protocol server, and its command line. |
| `hub/` | The hub, in Node: the board and the always-on server every app talks to. |
| `apps/macos/` | The native Mac app, Swift and AppKit, drawing the daemon's screen with its own Metal renderer. |
| `apps/desktop/` | The Electron desktop app, for Linux. |
| `apps/android/`, `apps/ios/` | The phone apps: thin shells around the phone board. |
| `apps/phone/` | The phone board's own screens, shared by the phone apps. |
| `shared/` | What every client shares: words, icons, themes, design tokens, settings. |
| `packages/` | The protocol spec, the client libraries and the page format, for plugins and other clients. |
| `site/` | The download page. |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md), [FEATURES.md](docs/FEATURES.md) (every feature and where each app stands), [PHONE.md](docs/PHONE.md), [RENDERING.md](docs/RENDERING.md), [PUBLISHING.md](docs/PUBLISHING.md). |
| `tools/` | The repository's checks: the personal-data audit, the feature list check, the third-party notices. |

## Contributing

Issues and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md)
says how. Report a security problem privately, as
[SECURITY.md](SECURITY.md) says.

## Licence

Ravenry is free software. Everything outside `packages/` is under the GNU
General Public License, version 3 only ([LICENSE](LICENSE)); `packages/` is
under the Apache License, Version 2.0 ([packages/LICENSE](packages/LICENSE)),
so plugins and clients written against it can use any licence. A
commercial licence for the GPL parts is available from the copyright
holder. [LICENSING.md](LICENSING.md) has the details,
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) lists the projects the
apps include, and [TRADEMARK.md](TRADEMARK.md) covers the name and logo.
