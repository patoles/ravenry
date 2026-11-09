# Architecture

Ravenry is a terminal built for coding agents. It runs as three kinds of
process, each with one job, and they talk over one protocol.

```
   desktop app        phone app        browser page
        \                 |                 /
         \                |                /
          +------- the hub (Node) --------+       one per person,
                    |            |                on the home machine
                    |            |
              ravenryd        ravenryd ...        one per machine
             (this Mac)     (a remote machine)
                 |               |
             terminals       terminals
```

## The three processes

### ravenryd: one per machine

A single static Go binary (`daemon/`), on the home machine and on every
remote machine Ravenry reaches.

- **It owns the terminals.** Every pane's process runs under ravenryd, not
  under a window, so sessions survive the app closing, restarting or
  updating.
- **It keeps each pane's screen** through libghostty-vt, and on attach sends
  a client the current screen, then the live bytes.
- **It stores what each pane prints,** so a client can ask for only what is
  new.
- **It is the hook command** that Claude Code and Codex run
  (`ravenryd hook --assistant claude|codex`). It needs no Node, so it works
  on a remote machine that has only the assistant installed.
- **It updates without killing a session.** A new version starts beside the
  old one; the old one keeps its sessions until they end.

### The hub: one per person

Node (`hub/`), on the home machine, always on (under launchd on macOS and
systemd on Linux, using the desktop app's own Node runtime, so users install
nothing more).

- **It holds the work:** the board's logic, the assistant and terminal
  adapters, the plugin host, plans, ideas, alerts and the decision ledger.
- **It connects to every ravenryd,** local and remote, and is what the
  clients talk to.
- **It runs apart from the window,** so closing the window does not stop
  alerts to the phone.
- **It answers hook decisions,** such as holding a session for a hand-off.
  A decision travels from the hook through ravenryd to the hub with a short
  timeout. If the hub cannot be reached, the session goes on.

Today the hub is the Ravenry board (0.4.x) moved into `hub/`: it already
follows Claude Code and Codex sessions in other terminals, and it grows into
the role above.

### The clients

- **The desktop app** (`apps/desktop/`): Electron with xterm.js panes.
- **The native Mac app** (`apps/macos/`, a spike): Swift and AppKit, its
  terminals drawn by Ghostty's embedding library. Each terminal runs
  `ravenry attach`, the daemon's own client, which carries a pane's bytes,
  keys and size; everything a later native client (Linux, Windows) needs
  again lives there, in Go, not in Swift.
- **The Android app** (`apps/android/`): Kotlin around a WebView that shows
  the phone board (`apps/phone/`), web code the iOS app will share
  ([PHONE.md](PHONE.md)).
- **The browser page** the hub serves, which works today.

A client holds no state that matters. It shows what the hub and ravenryd
send and passes on what the user types.

## The transports

The protocol is the same on every path: versioned messages over WebSocket,
JSON for control and binary frames for terminal bytes. Only the way it
travels changes.

- **On the same machine:** a unix socket with mode 0600, in a private
  directory, so only the user's own account can connect. No port is
  opened. Each daemon version has its own socket, which is how an update
  starts beside the running daemon ([PROTOCOL.md](../packages/protocol/PROTOCOL.md),
  section 9).
- **To a remote machine:** `ssh host ravenryd proxy`. The hub runs that
  command, and `ravenryd proxy` bridges SSH's standard input and output to
  the remote machine's own unix socket. It respects `~/.ssh/config` and
  jump hosts, needs no open port on the remote machine, and adds no login
  of its own: SSH does the authentication. The app installs ravenryd
  there the same way, in the remote user's home with no sudo: it carries
  the builds for macOS and Linux on arm64 and x86-64, and puts the daemon's
  hook in Claude Code's and Codex's settings there.
- **To the phone:** TLS, on the home Wi-Fi or a Tailscale interface, and
  only while phone access is on. Pairing is a QR code that carries the
  hub's public key; the phone pins that key, so a different server is
  refused even with a valid certificate. Each phone also holds its own
  token, which can be revoked on its own.

## Frozen at launch

Once the repository is public and other people build plugins, adapters,
clients and forks on it, some things can no longer change without breaking
them. These are decided before launch, with care:

- **The ravenryd protocol.** Versioned and documented from v1
  (`packages/protocol/`), and complete enough that any client needs
  nothing else.
- **The plugin, assistant and terminal contracts,** and their language:
  JavaScript or TypeScript in the hub's plugin host.
- **Plugin UI that does not depend on the shell.** Plugins never touch
  Electron or the page's DOM. They declare sections, rows and actions, or
  render inside a sandboxed web panel that talks to Ravenry only through
  messages.
- **The CLI, the agent status spec, and the data formats on disk.**

These stay internal and can change after launch: what draws the terminal,
the shell around the web interface, and how ravenryd stores things.

## Where the code lives

| Folder | What | Language | Licence |
| --- | --- | --- | --- |
| `daemon/` | ravenryd | Go | GPL-3.0-only |
| `hub/` | the hub, today's board | Node | GPL-3.0-only |
| `apps/desktop/` | the desktop app | Electron, xterm.js | GPL-3.0-only |
| `apps/macos/` | the native Mac app (spike) | Swift, AppKit, GhosttyKit | GPL-3.0-only |
| `apps/android/` | the Android app | Kotlin, WebView | GPL-3.0-only |
| `apps/phone/` | the phone board, the web code the phone apps show | TypeScript, xterm.js | GPL-3.0-only |
| `packages/` | the protocol spec, plugin SDK, specs, adapter contracts | | Apache-2.0 |
| `docs/` | this guide and others | | GPL-3.0-only |
| `tools/` | repository tools, such as the personal-data audit | Node | GPL-3.0-only |

[LICENSING.md](../LICENSING.md) explains the split.
