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
| `hub/` | The hub, in Node: today's Ravenry board (0.4.x), which becomes the always-on hub the apps talk to. |
| `apps/desktop/` | The Electron desktop app. Placeholder. |
| `apps/android/` | The Android app, Kotlin and WebView. Placeholder. |
| `packages/` | The protocol spec, the plugin SDK, specs and adapter contracts. `packages/protocol/` holds the draft of protocol v1 and its JSON Schema. |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md): the processes, the transports and what is frozen at launch. |
| `tools/` | `audit.mjs`, the personal-data audit. |

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
