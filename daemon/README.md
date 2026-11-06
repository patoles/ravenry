# ravenryd

The Ravenry daemon: one static Go binary on every machine Ravenry reaches,
the Mac itself and each remote machine. It is the only process that owns
terminals, so sessions survive the app closing, restarting or updating.

Go module: `github.com/patoles/ravenry-app/daemon` (it follows the
repository to its public home at launch). Licence: GPL-3.0-only
([LICENSING.md](../LICENSING.md)).

## What it will own

- **Terminals.** It starts and holds every pane's process through a pty
  library (creack/pty on macOS and Linux; a ConPTY wrapper on Windows
  later), and kills a pane's whole process tree when the pane closes.
- **Screen state.** It keeps each pane's screen through libghostty-vt (via
  go-libghostty), pinned to one version and wrapped behind a small Go
  interface of our own, so its API can change without reaching the rest of
  the code. On attach it sends a client the current screen, then the live
  bytes.
- **Output.** It stores what each pane prints, so a client can ask for only
  what is new, or for a pane's log.
- **The hook command.** `ravenryd hook --assistant claude|codex` is what
  Claude Code's and Codex's hooks run. It needs no Node, so it works on a
  remote machine that has only the assistant installed. Hook decisions go
  through ravenryd to the hub, with a short timeout; if the hub cannot be
  reached, the session goes on.
- **The protocol server.** It speaks the Ravenry protocol
  ([packages/protocol](../packages/protocol)) to the hub and the clients, on
  a unix socket (mode 0600), and through `ravenryd proxy` over SSH for a
  remote machine.
- **Updates that never kill a session.** A new version starts beside the
  old one; the old one keeps its sessions until they end, and new sessions
  go to the new one.

None of this is written yet. Today `ravenryd` only prints its version.

## Build and run

```sh
cd daemon
go vet ./...
go build -o ravenryd ./cmd/ravenryd
./ravenryd version
```

The version comes from the build: `go build -ldflags "-X main.version=1.2.3"`.
