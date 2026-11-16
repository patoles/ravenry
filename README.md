# Ravenry app

This is the private development repository of the Ravenry terminal app: a
terminal built for coding agents, with the Ravenry board inside it. It stays
private while the app is built, and its whole history goes public at launch,
so nothing personal ever goes into a commit (see "The audit" below).

Repository: github.com/patoles/ravenry-app

## Layout

| Folder | What |
| --- | --- |
| `daemon/` | `ravenryd`, the Go daemon on every machine: terminals, screen state through libghostty-vt, waits and input for agents, the protocol server, and its command line. The hook command is still to come. |
| `hub/` | The hub, in Node: the board and the always-on server every app talks to. |
| `apps/macos/` | The native Mac app, Swift and AppKit, that draws the daemon's screen with its own Metal renderer. The app testers get. |
| `apps/ios/` | The iPhone and iPad app: a thin Swift shell around the phone board. |
| `apps/android/` | The Android app: a thin Kotlin shell around one WebView that shows the phone board. |
| `apps/phone/` | The phone board's own layer and pages, shared by the Android and iOS apps. |
| `apps/desktop/` | The Electron desktop app (macOS and Linux), behind the native Mac app on some features (see `docs/FEATURES.md`). |
| `shared/` | What every client shares: strings, icons, themes, design tokens, settings. |
| `site/` | The testers' download page, published with `tools/publish-testers.mjs`. |
| `packages/` | The protocol spec, the plugin SDK, specs and adapter contracts. `packages/protocol/` holds the draft of protocol v1 and its JSON Schema. |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md): the processes, the transports and what is frozen at launch. [FEATURES.md](docs/FEATURES.md): every feature and where each client stands. [PHONE.md](docs/PHONE.md): the contract between the hub and the phone apps. [RENDERING.md](docs/RENDERING.md): the render stream. [PUBLISHING.md](docs/PUBLISHING.md): the testers' release. |
| `tools/` | `audit.mjs`, the personal-data audit; `features-check.mjs`; `publish-testers.mjs`. |

Each app folder has its own README that says how to build and run it.

## Run the hub

Node 22 or later, on macOS.

```sh
cd hub
npm ci
npx playwright install chromium   # only for the headless tests and screenshots
npm start                         # the board on http://localhost:4600
```

Each hub test is a plain script run from `hub/`, for example
`node tools/sessions-test.mjs`. Every test keeps its data in `hub/.tmp/` and
runs its own board on a test port, never the real one on :4600.
[hub/docs/DEVELOPING.md](hub/docs/DEVELOPING.md) describes how the board
works and lists every test.

## Build the daemon

Go, Zig 0.17 or newer (it builds libghostty-vt, once) and git:

```sh
cd daemon
make          # ./ravenryd
make test
./ravenryd version
```

[daemon/README.md](daemon/README.md) says more.

## The audit

`node tools/audit.mjs` reads every file git would commit and fails on
personal data: personal terms, email addresses, home paths, keys and
tokens, real-looking UUIDs, text inside images, and more. Run it before
every commit; it must say CLEAN. CI runs it on every push and pull request,
with the personal term list taken from the `AUDIT_TERMS` repository secret.
The term list is never committed.

## CI

- **audit:** the personal-data audit, on every push and pull request.
- **cla:** the contributor licence agreement check on pull requests
  ([CLA.md](CLA.md)).
- **code:** for the daemon, libghostty-vt built with Zig (cached), then
  gofmt, `go vet`, `go build` and every Go test; for the hub, `node --check`
  over every script and the hub tests that run on Linux.

## Licence

GPL-3.0-only for everything outside `packages/`, Apache-2.0 for `packages/`,
and a commercial licence is available from the copyright holder. See
[LICENSING.md](LICENSING.md), [NOTICE](NOTICE) and
[TRADEMARK.md](TRADEMARK.md). Contributions come under [CLA.md](CLA.md);
[CONTRIBUTING.md](CONTRIBUTING.md) says how to send one.
