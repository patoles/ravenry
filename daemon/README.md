# ravenryd

The Ravenry daemon: one Go binary on every machine Ravenry reaches, the Mac
itself and each remote machine. It is the only process that owns
terminals, so sessions survive the app closing, restarting or updating.
The same binary is its command line client.

**One binary, two names.** `ravenry` is what people and agents type: the
pane commands, waits, input, checkpoints and `ravenry skill`. `ravenryd`
is its service side: `serve`, `proxy` (`ssh host ravenryd proxy`), `hook`
(what Claude Code's and Codex's hooks run) and `daemons`. It is one
multi-call binary that picks its side from the name it runs under;
`ravenry` is a link to `ravenryd` (`make` makes it, and the app ships
both). Each name runs every command, so `ravenryd new` keeps working;
`help` lists each name's own side. These names and their commands are a
frozen contract from the public launch.

Licence: GPL-3.0-only ([LICENSING.md](../LICENSING.md)). It speaks the
Ravenry protocol, [packages/protocol](../packages/protocol/PROTOCOL.md).

## What it does

- **Panes.** Each pane is a process on a pty (creack/pty, macOS and Linux;
  Windows later), with an id, a command, a working directory and an
  environment that names the pane (`RAVENRY_PANE`) and its daemon
  (`RAVENRY_SOCKET`). Closing a pane ends its whole process tree, including
  programs that detached themselves. A hidden pane can have a TTL.
- **Screens.** Every pane's output goes through libghostty-vt, which keeps
  its screen: text, cell styles (bold, dim, colours, ...), cursor, modes,
  title. A capture returns them, and a client that attaches gets VT that
  rebuilds the screen in xterm.js, then the live bytes. The daemon also
  answers the program's terminal queries, so a pane works with no client
  attached.
- **Output.** A capped log per pane, read by mark (`since`). Streams to
  clients are bundled by backlog: a keystroke's echo goes out alone and at
  once, a flood gathers into large frames, and a client that falls behind
  gets a fresh snapshot instead of slowing the pane.
- **Agents.** Waits for a condition (text, quiet, exit, the shell's next
  prompt) that say what changed; input with explicit modes (paste, typed,
  raw) and named keys encoded for the program's modes; send-and-settle,
  which sends keys, waits for the screen to settle and returns the diff.
- **The agent status channel.** The state of the agent in each pane
  (working, needs you, idle, ended, which assistant, its last event), fed
  by the assistant's hooks through `ravenryd hook`, by OSC 7501 program
  status reports, and by what the daemon sees (the process exited, the
  shell's prompt came back). Clients read it in `pane.list` and
  `agent.events` and get `agent.report` as it happens. OSC 133 shell
  marks give each pane's shell state and the last command's exit status.
- **Hook decisions.** `ravenryd hook` replaces the Node hook scripts on
  any machine, since a remote machine may have no Node. For the events
  that may hold a session (Stop, for the hand-off), the daemon asks the
  hub and waits a short while (2 s by default); with no hub, no daemon or
  no answer in time, the hook prints nothing and exits 0, so the session
  goes on.
- **What runs in a pane, and restart.** The foreground process with its
  arguments, executable, working directory and start time; restart
  starts the pane's command again with the same directory and env.
- **Updates that never kill a session.** Each version listens on its own
  socket. A new version starts beside the old one, new panes go to it, and
  the old one keeps its panes and exits once none of them is running.
  PROTOCOL.md section 9 says how clients find the right daemon.
- **Labels, working folder, activity.** Panes carry a name for people
  and labels for programs (`pane.update` changes both); `cwd` follows
  OSC 7; a client can ask for `pane.activity` about the panes it does
  not stream, at most once a second each.
- **Checkpoints.** An agent waits for a person: `ravenry ask` (buttons
  or text), `ravenry approve` (a command that runs only once a person
  approves the exact text, in a new pane, and gives the agent its output
  and status) and `ravenry secret` (a secret typed by a person that goes
  into a program's input or a command's environment, never to the agent,
  and is masked in the pane's output). The hub shows them, alerts the
  phone and answers with `checkpoint.answer`. Only a person answers: the
  daemon refuses `checkpoint.answer` (and deciding for hooks) to any
  program inside a pane, and over ssh to a connection without the hub's
  answer key (PROTOCOL.md section 4, Who acts as the person).
  `ravenryd peer` gives the hub the same judgement about who sent an
  answer to its HTTP API.
- **Files.** `file.stat` and `file.read`, so the hub can read a remote
  session's transcript and brief for the hand-off.
- **Shell integration.** zsh, bash and fish started in a pane send OSC 133
  prompt marks (with the command line and its exit status) and OSC 7,
  injected at start the way Ghostty does it, without touching the user's
  files (`internal/pane/shell`, PROTOCOL.md section 3).
  `RAVENRY_SHELL_INTEGRATION=0` turns it off.

Not built yet: a TCP listener for the phone, Windows.

## Layout

| Package | |
| --- | --- |
| `cmd/ravenryd` | The command line, both names. `commands.go` is the one table of commands and flags that parsing, `help` and `ravenry skill` all read. |
| `internal/vt` | The terminal state engine. The only package that imports go-libghostty, behind a small `Screen` interface. |
| `internal/pane` | Panes: pty, process tree, log, streams, waits, input, shell marks, the foreground process. |
| `internal/agent` | The agent reports and each pane's agent state. |
| `internal/server` | The protocol server. |
| `internal/client` | A Go client of the protocol (the CLI and the tests use it). |
| `internal/proto` | The protocol's wire types. |
| `internal/paths` | Where the socket and the logs live, and finding daemons. |
| `internal/testprog` | Programs the tests run inside panes. |

The Go module is named `ravenryd`. Nothing outside this folder imports its
packages (they are all internal), so the name does not need to be a
download path, and it stays the same when the repository moves at launch.

## Build

ravenryd links libghostty-vt statically through cgo. Building it needs Go
(the version in `go.mod`), Zig 0.17 or newer and git:

```sh
cd daemon
make            # builds libghostty-vt once (about two minutes), then ./ravenryd
make test       # every test, as CI runs them
./ravenryd version
```

`scripts/libghostty.sh` builds libghostty-vt into `.deps/` and prints its
pkg-config folder. It takes the ghostty commit from the go-libghostty
version in `go.mod` (that module pins the commit its bindings were written
for), so there is one pin. Without make:

```sh
export PKG_CONFIG_PATH=$(scripts/libghostty.sh)
go test ./...
go build -ldflags "-X main.version=1.2.3" -o ravenryd ./cmd/ravenryd
```

Tests start shells with a throwaway HOME, a fixed PATH and `/bin/sh`, never
the user's own shell setup, and use their own runtime and state folders.
They print two measurements (`go test -v -run 'Echo|Bulk' ./internal/server`):
the echo latency of a keystroke through the daemon, and 100 MiB of output
through the daemon to a client.

## Run

```sh
ravenryd serve &                          # or let any command start it
id=$(ravenry new -- /bin/sh)
mark=$(ravenry send "$id" --raw 'ls' --key Enter)
ravenry wait "$id" --quiet 300ms --since "$mark"
ravenry capture "$id" --styles --json
ravenry settle "$id" --paste 'git status' --key Enter   # prints the rows that changed
ravenry wait "$id" --prompt              # the next prompt (with shell integration)
ravenry process "$id"                     # what runs there: pid, argv, cwd
ravenry agents                            # the agent state of every pane
ravenry close "$id"

ravenry ask --wait "Put on the headset and open the game" --option Done --option "Didn't work"
ravenry approve 'git push && npm publish' --why "Release 0.4.1"
ravenry secret "Mail service API key" -- npx wrangler secret put MAIL_API_KEY
ravenry skill                             # the guide for agents
```

Checkpoint commands wait for the answer by default and exit 0 when
answered (for a command, with its own status), 124 when nobody answered
in time, 125 when a person declined.

### The hook

In Claude Code's `settings.json` (Codex's `hooks.json` takes the same
command with `--assistant codex`):

```json
{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "ravenryd hook --assistant claude"}]}]}}
```

It reads the hook's JSON on standard input and reports it to the daemon of
its pane (`RAVENRY_PANE`, `RAVENRY_SOCKET`). Outside a ravenryd pane it does
nothing. It forwards only what the status and the hand-off read (the event,
session, folder, transcript path, a need's line, the question a turn ended
on, PROTOCOL.md section 4): never the prompt, a tool's input or output. Any other assistant names the state each event means:
`ravenryd hook --assistant gemini --state working`.

`ravenry help` and `ravenryd help` list each side's commands; every
command takes `--json`.
