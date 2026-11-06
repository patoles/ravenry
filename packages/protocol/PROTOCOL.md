# The Ravenry protocol, version 1

Status: **draft**. Version 1 is frozen at the public launch; until then it
can still change.

This is how a client (the hub, the desktop app, the phone, a script, a
client someone else writes) talks to `ravenryd`, the daemon that owns the
terminals on a machine. A client needs nothing beyond this document and
the JSON Schema beside it ([schema/v1.json](schema/v1.json)), which defines
every JSON message. ravenryd implements exactly this: its tests check every
message they exchange against the schema, in both directions, and fail if
a message type of the schema never went over the wire.

The key words "must", "must not", "should" and "may" are used as in
RFC 2119.

## Contents

1. [Connecting](#1-connecting)
2. [Messages](#2-messages)
3. [Panes, marks and the log](#3-panes-marks-and-the-log), shell
   marks, the agent in a pane, labels, secrets in output
4. [Methods](#4-methods): panes, agents, files, checkpoints, who acts
   as the person
5. [Streams and binary frames](#5-streams-and-binary-frames)
6. [Events](#6-events)
7. [Input and keys](#7-input-and-keys)
8. [Errors](#8-errors)
9. [Finding the daemon, and updates](#9-finding-the-daemon-and-updates)
10. [How the protocol changes](#10-how-the-protocol-changes)

## 1. Connecting

### Transports

The protocol is WebSocket (RFC 6455) over a byte stream. Two byte streams
exist in v1; there is no TCP listener.

- **The daemon's unix socket** on the same machine. The socket has mode
  0600 and lives in a directory with mode 0700 that belongs to the user,
  so only the user's own account can connect. Section 9 says where.
- **`ravenryd proxy`**, which connects to the daemon's socket and copies
  bytes between it and its own standard input and output. Over SSH this is
  `ssh host ravenryd proxy`: SSH does the authentication, honours
  `~/.ssh/config` and jump hosts, and no port is opened on the remote
  machine. The proxy does not read or change the bytes, so the client
  speaks exactly the same protocol, WebSocket handshake included, as over
  the socket. sshd runs the command through the remote login shell, whose
  startup files may print to standard output before the proxy starts (a
  `.bashrc` that echoes): a client over ssh skips what comes before the
  handshake's status line (`HTTP/1.1 `).

Every client of the user may use every method, except the few that act
as the person (answering a checkpoint, deciding for a hook): the daemon
refuses those to a program inside a pane, and over ssh to a connection
without the answer key (section 4, Who acts as the person).

### The handshake

The client sends an HTTP/1.1 upgrade request:

```
GET /v1 HTTP/1.1
Host: ravenryd
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <key>
Sec-WebSocket-Protocol: ravenry.v1
```

- The path is `/v1` and the subprotocol `ravenry.v1`. The daemon closes a
  connection that does not offer `ravenry.v1` (close code 1008).
- The Host header is not checked. A request that carries an Origin header
  for another host is refused, so a web page cannot reach the daemon
  through a forwarded socket.
- Compression (permessage-deflate) is not used.

### After the handshake

- **Text frames** carry JSON messages (section 2), UTF-8, one message per
  frame.
- **Binary frames** carry terminal bytes (section 5).
- **The first request must be `hello`.** Any other request before it fails
  with `hello_required`.
- A JSON message is at most 16 MiB.

## 2. Messages

Every JSON message is an object with `"v": 1` (the protocol version) and a
`type`.

**From the client:**

- **A request:** `type` is the method name, plus an `id` and the method's
  fields.

  ```json
  {"v": 1, "type": "pane.capture", "id": 7, "pane": "pk3m9q2x", "styles": true}
  ```

  `id` is an integer from 0 to 2^53 - 1, chosen by the client, unique among
  its requests that are still running on this connection.
- **An `ack`** (section 5), which has no reply.

**From the daemon:**

- **A result**, the reply to a request:

  ```json
  {"v": 1, "type": "result", "id": 7, "method": "pane.capture", "result": {...}}
  ```

- **An error**, the reply to a request that failed, or a report about a
  message that could not be tied to a request (then without `id`):

  ```json
  {"v": 1, "type": "error", "id": 7, "error": {"code": "not_found", "message": "no such pane"}}
  ```

- **An event** (section 6): `{"v": 1, "type": "event", "event": "pane.exited", ...}`.

**Strictness.** The daemon refuses a request with a field the method does
not define (`bad_request`), so a client never believes the daemon applied
something it ignored. A client must ignore fields it does not know in what
the daemon sends (section 10).

**Order.** The daemon starts requests in the order they arrive.

- Most requests answer at once, in order.
- `pane.wait`, `pane.settle`, `pane.close`, `pane.restart`, `pane.send`,
  `pane.process`, `checkpoint.wait` and `agent.report` with `decide` can take time (a send waits for
  earlier input of the connection, and typed text takes a pause per
  character). Other requests are handled meanwhile, so their results can
  arrive in another order. Match results to requests by `id`.
- Input keeps its order: the input of `pane.send`, `pane.settle` and
  binary input frames on one connection reaches the panes in the order it
  arrived, even when one of them takes time (typed text).

**Times** are RFC 3339 in UTC with milliseconds: `2026-11-06T14:03:07.250Z`.
**Durations** are integers in milliseconds, in fields ending in `_ms`.

## 3. Panes, marks and the log

**A pane** is a terminal: a pseudo-terminal, the process started on it
(with everything that process starts), and the screen the daemon keeps for
it.

- **Its id** is an opaque string. ravenryd's ids are "p" and seven random
  characters, so ids of two daemons do not collide in practice and a client
  with several daemons can key panes by id.
- **Its screen** is kept by the daemon whether or not any client is
  attached: text, cell styles, cursor, modes, title, and up to `scrollback`
  lines of history.
- **Its environment** is the daemon's, plus `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `TERM_PROGRAM=ravenry`, `RAVENRY_PANE=<id>` and
  `RAVENRY_SOCKET=<the daemon's socket>`, plus the `env` of `pane.new`.
  `RAVENRY_PANE` lets a hook say which pane it runs in; `RAVENRY_SOCKET`
  lets a program in the pane reach the daemon that runs it. Both also mark
  the pane's processes (below): closing the pane finds them by it, and the
  daemon refuses them what only a person may do (section 4, Who acts as
  the person).
- **Running and exited.** When the first process exits, the pane stays,
  with its screen, as `exited`, so its last screen can still be read. It is
  removed when a client closes it, or one hour after the exit.
- **Hidden** panes are left out of `pane.list` unless asked for. A hidden
  pane can have a TTL: it is closed that long after it started.
- **Which processes belong to a pane:** its first process; a child of
  one that belongs; one in a session or process group led by one that
  belongs or did (a program that moves to a session of its own leads it,
  and what it starts stays in that session after it has gone, which is
  what a double fork leaves); one the daemon saw belong while it lived,
  even after it left its parents for launchd or init; and one that
  carries the pane's mark: `RAVENRY_PANE` in its environment where the
  system shows it (Linux; macOS shows none of an Apple binary's, such as
  `/bin/sh` or `curl`), and on Linux its `RLIMIT_RTTIME` soft limit, set
  on the first process to 2^61 microseconds plus 48 bits of the pane's
  id, which every process inherits and a wiped environment keeps (`ulimit
  -R` in a pane shows it). The daemon walks the process table every
  second while panes exist, and on macOS also hears each fork of a
  process it knows as it happens (kqueue), so it sees the middle process
  of a double fork before it is gone. Never a process of another pane or
  outside every pane: a process joins only through one that belongs.
- **Closing** a pane ends every process that belongs to it, which
  catches programs that detached themselves. They get SIGHUP, then
  SIGTERM halfway through the grace period, then SIGKILL at its end.

**The daemon answers terminal queries.** When the program in a pane asks
the terminal something (device attributes, cursor position, and other
reports), the daemon's own screen answers on the pty, whether or not a
client is attached. A client that draws the pane must not answer such
queries itself, or the program gets two answers. (For xterm.js: register
parser handlers that swallow the queries, or drop what `onData` reports
for them.)

**Name and labels.** A pane's `name` is for people (a tab's title). Its
`labels` are key-value tags for programs: the app marks its plain shells
(`ravenry.kind: shell`), the hub the session it started, a plugin its
own panes. The daemon gives them no meaning; `pane.list` filters by them
and `pane.update` changes both. A key is 1 to 64 characters of `a-z`,
`0-9`, `.`, `_`, `/` and `-`, starting with a letter or digit; name it
after its owner (`ravenry.kind`, `myplugin/role`). A value is at most 256
bytes with no control characters, and a pane has at most 32 labels.

**Its working directory.** `cwd` is where the pane started, then the last
directory its program reported with OSC 7 (`file://host/path`, which the
shell integration sends at each prompt) when `host` is empty,
`localhost` or this machine's name. A directory reported for another
host (a shell reached through ssh inside the pane) is not the pane's and
is ignored. `pane.cwd` tells when it changes.

**A mark** is a position in a pane's output: the number of bytes the pane
had printed before that point. Marks only grow. Results carry marks so a
client can ask for what came after: `pane.send` returns the mark just
before its input, and `pane.wait` with `since` set to it sees exactly what
the input caused.

**Shell marks.** A shell with shell integration marks each step of a
command with OSC 133: `A` a prompt starts, `B` the prompt is drawn and
input starts, `C` a command runs, `D` it ended (`D;<status>` with its exit
status). Once a pane's program sent one, its Pane object has `shell`:

- `state`: `running` from a command's start (`C`) to its end (`D`), else
  `prompt`.
- `command`: the running or last command, when the shell sent it.
- `exit_code`: the last finished command's status, when the shell sent it.
- `mark` and `at`: when the state last changed.

`pane.wait` with `prompt` holds once a prompt starts (`A` or `B`) after
its `since`, so "send a command, wait for the next prompt" works whatever
the command prints. A shell without shell integration sends no marks;
`shell` then stays absent and a `prompt` wait times out.

**Shell integration.** The daemon gives zsh, bash and fish the marks
itself, when it starts one interactively in a pane (the default login
shell, or a `command` that is the shell with no script or `-c`): `A`, `B`,
`C` with the command line (`cmdline_url`) and `D` with the exit status,
and OSC 7 with the working folder. It injects them at start, as Ghostty
does, and never changes the user's files: zsh gets a `ZDOTDIR` whose
`.zshenv` gives `ZDOTDIR` back and runs the user's own; bash 4 and newer
starts with `--posix` and an `ENV` file that leaves POSIX mode and runs
the user's startup files as bash would have; bash 3.2 (macOS's
`/bin/bash`) gets a `PROMPT_COMMAND` that loads the integration at the
first prompt; fish gets `XDG_DATA_DIRS` with a `vendor_conf.d`. Each
puts the variables it used back before the user's files run, so the
shell's own commands do not inherit them. `RAVENRY_SHELL_INTEGRATION=0`
(or `off`, `no`, `false`) in `pane.new`'s `env`, or in the daemon's own
environment, starts the shell as it is. Other shells start as they
are.

**The agent in a pane.** The daemon keeps the state of the agent (a coding
assistant, or any program that reports on itself) running in each pane,
from the reports it gets (section 4, Agents):

- **From the agent's hooks.** An assistant runs `ravenryd hook` from its
  hooks (Claude Code's and Codex's, or any assistant that runs a command
  with a JSON object on its standard input), which sends `agent.report`.
- **From the program itself.** A program may print an OSC 7501 program
  status report (`ESC ] 7501 ; state=working:app=<name> ST`, and
  `blocked` with a `kind`, `idle`, `done`, `error`, `clear`; the
  libghostty program status protocol). Its own record (no `id`) becomes a
  report with the source `program`: `working` is working, `blocked` needs
  you (`kind` permission, question or auth), the others idle. The daemon
  also answers the program's support query (`ESC ] 7501 ; ? ST`).
- **From the daemon.** When the pane's process exits, or the shell draws
  its prompt again after a command (`D` then `A`), the agent that ran
  there is gone: an agent that was working or needed you ends (`ended`;
  `idle` for a program's own report, which the program status protocol
  drops at the next prompt). The source is `daemon`, the event `exit` or
  `prompt`. At a prompt, an agent whose last hook report named a process
  (`pid`) that still runs stays: that hook ran from the shell itself.

The state, in the Pane object's `agent` once an agent reported:

| Field | |
| --- | --- |
| `state` | `working` (busy, needs nobody), `needs_you` (waits for a person), `idle` (done with its turn, waits for the next prompt) or `ended` (its session ended, or it is gone). |
| `need` | With `needs_you`: `kind` (`permission`, `question`, `auth` or `other`) and `message`. |
| `since` | When it entered this state. |
| `assistant`, `session` | Who reports (`claude`, `codex`, ...), and the assistant's own session id. |
| `event`, `at`, `source`, `seq` | The last report: its event, time, source (`hook`, `program` or `daemon`) and number. |

A report that names no state (a notification that changes nothing) only
moves `event` and `at`. Messages are text from programs: show them as
text, never as markup.

**Secrets in output.** A secret a person typed for a program in a pane
(a `secret` checkpoint, section 4) is masked in everything that pane
prints from then on: each of its bytes becomes `*` before the screen,
the log, streams, waits and captures see the output. A secret split
across two reads is still masked: the end of a read that could start a
secret is held back until the next read, or for 30 ms. The daemon keeps
the secret in memory for the pane's life (at most 16 per pane) and
writes it nowhere. Masking is by bytes: a program that echoes a secret
as it was typed shows asterisks; one that redraws it with other bytes in
between is not covered, and a secret typed at a shell prompt lands in
the shell's history, so a secret is for a program that prompts for it.

**The log.** The daemon keeps each pane's raw output in a log file with a
size cap (16 MiB by default; it keeps between half and all of the cap of
the latest output). `pane.read` reads from it by mark, and a subscription
can start from a mark it still holds. The log of a pane that was not
hidden is kept after the pane closes, to search history, and removed when
the daemon starts and finds it more than seven days old. A hidden pane's
log is removed with the pane.

## 4. Methods

Every request has `v`, `type` and `id`; the fields below come in addition.
A field marked optional may be left out. The schema has the exact types
and limits of each field.

### hello

Must be the first request.

| Field | | |
| --- | --- | --- |
| `client.name` | string | Who the client is, for logs. |
| `client.version` | string, optional | |
| `answer_key` | string, optional | A hub's answer key, at most 256 bytes: over ssh, the key that lets this connection act as the person (Who acts as the person, below). |

Result: `protocol` (1), `daemon` (`version`, `pid`, `os`, `arch`,
`started_at`, `home`, the home folder of the user it runs as, which a
client shows as `~` in the folders of this machine, and `draining` when a newer daemon runs beside this one, see
section 9), `methods`, the methods this daemon supports, and `person`,
whether this connection may act as the person. A client checks `methods`
before using a method added after v1.0 (section 10).

### cancel

| Field | | |
| --- | --- | --- |
| `request` | id | A running `pane.wait`, `pane.settle`, `pane.close`, `pane.send` or `checkpoint.wait` on this connection. |

Result: `{}`. The cancelled request then fails with `cancelled`, except a
`pane.close`, which completes and answers as usual. Closing the
connection cancels everything it was waiting for.

### events.subscribe

| Field | | |
| --- | --- | --- |
| `display` | boolean, optional | This connection shows panes to a person (a terminal window, the phone), so it also gets `pane.focus`. |
| `activity` | boolean, optional | Also `pane.activity`, about the panes this connection does not stream (a tab strip's "something happened" dot). |

Result: `{}`. From then on the connection receives the pane, agent,
checkpoint and daemon events of section 6. Subscribing again updates
`display` and `activity`.

### pane.new

| Field | | |
| --- | --- | --- |
| `command` | array of strings, optional | Program and arguments. The program is looked up on the pane's `PATH`. Default: the user's login shell (`$SHELL`, else `/bin/sh`), started as a login shell. |
| `cwd` | string, optional | Default: the home directory. |
| `env` | object, optional | Variables to add or override. `RAVENRY_PANE` and `RAVENRY_SOCKET` cannot be overridden. `RAVENRY_SHELL_INTEGRATION=0` turns shell integration off (section 3). |
| `cols`, `rows` | integers, optional, together | 1 to 4096. Default 80 x 24. |
| `name` | string, optional | For people, at most 256 bytes. |
| `labels` | object, optional | For programs (section 3, Name and labels). |
| `hidden` | boolean, optional | |
| `ttl_ms` | integer, optional | Only with `hidden: true`. |
| `scrollback` | integer, optional | History lines, 0 to 1000000. Default 10000. |

Result: `pane`, a Pane object. Fails with `failed` when the program or the
directory does not exist.

**The Pane object:** `id`, `name` (when set), `labels` (when it has
some), `command`, `cwd` (where it works now, section 3), `pid` (the
first process, which leads the pane's session), `cols`, `rows`, `hidden`,
`ttl_ms` (when set), `created_at`, `title` (set by the program with OSC 0
or 2, else empty), `mark` (the end of its output so far), `last_output_at`
(once it printed), `state` (`running` or `exited`), and for an exited pane
`exit` (`code`, -1 when a signal ended it, and `signal`, such as
`SIGKILL`) and `exited_at`. Once known, `shell` (OSC 133 shell marks) and
`agent` (the agent's state), section 3.

### pane.list

| Field | | |
| --- | --- | --- |
| `hidden` | boolean, optional | Include hidden panes. |
| `labels` | object, optional | Only the panes that have every one of these labels with these values. |
| `processes` | boolean, optional | Also `pids` on each running pane: the processes that belong to it now (section 3), by their parents, their sessions and what the daemon saw. |

Result: `panes`, oldest first.

### pane.update

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `name` | string, optional | Its new name; empty clears it. |
| `labels` | object, optional | Each label set to a string is set, each set to `null` removed; the others stay. |

At least one of `name` and `labels`. Result: `pane`. When something
changed, event subscribers get `pane.updated`.

### pane.close

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `grace_ms` | integer, optional | 0 to 60000. Default 1000. |

Ends the pane's processes (section 3) and removes the pane. Result: `pane`
(as it was, with its exit) and `signalled`, how many processes were
signalled.

### pane.resize

`pane`, `cols`, `rows`. Result: `pane`.

### pane.capture

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `styles` | boolean, optional | Add each line's styled runs. |
| `history` | integer, optional | Add up to this many scrollback lines above the screen. |
| `vt` | boolean, optional | Add the VT sequences that rebuild the screen. |

Result:

- `mark`: the output position the capture shows.
- `cols`, `rows`, `cursor` (`x`, `y`, 0-based on the visible screen,
  `visible`), `alt_screen`, `title`.
- `history`: how many entries at the start of `lines` are scrollback.
- `lines`: one per row (history first, then each visible row). Each has
  `text` (trailing blanks removed) and, with `styles`, `spans`.
- A span is a run of cells whose style is not the default: `col`, `width`
  (in cells; a wide character covers two), `text`, and the attributes
  that are on (`bold`, `dim`, `italic`, `underline`, `blink`, `inverse`,
  `invisible`, `strike`) and the colours that are set (`fg`, `bg`: a
  palette index 0 to 255, or `"#rrggbb"`). Dim text is often information:
  a greyed suggestion rather than typed text.
- `vt`, with `vt: true`: the same VT a snapshot frame carries (section 5).

### pane.read

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `since` | mark | Where to start. |
| `limit` | integer, optional | Bytes, 1 to 8 MiB. Default 1 MiB. |
| `format` | optional | `text` (default): escape sequences and control characters removed, newlines and tabs kept. `raw`: the bytes, base64. |

Result: `from` and `to` (the marks the data covers), `end` (the end of the
pane's output now), `truncated` (true when the log no longer holds `since`
and the data starts later, at `from`), and `text` or `data`. Read on from
`to` to get the rest.

### pane.send

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `input` | array | Input items, in order (section 7). |

Every item is checked before anything is written. Result: `bytes` (written
to the pty) and `mark` (the output position just before the input).

### pane.wait

Returns when the first of its conditions holds. At least one of `text`,
`quiet_ms`, `exit: true` and `prompt: true` is required.

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `text` | string, optional | An RE2 regular expression, matched against the new output (escape sequences removed, newlines kept). |
| `screen` | boolean, optional | Match `text` against the visible screen instead (rows joined with newlines; use `(?m)` for `^` and `$` per row). It may hold at once. |
| `quiet_ms` | integer, optional | Holds once the pane printed nothing for this long, counted from the later of the start of the wait and its last output. |
| `exit` | boolean, optional | Holds once the first process exited and its output has been read to the end (at once if it already has). When a background process keeps the pty open, it holds 250 ms after the exit. |
| `prompt` | boolean, optional | Holds once the shell starts a prompt (OSC 133 `A` or `B`) after `since` (section 3, Shell marks). |
| `since` | mark, optional | Where new output starts. Default: now. A past mark makes the wait see output that came before it. |
| `timeout_ms` | integer, optional | Default 30000, at most 24 hours. |

The result says what happened and what changed:

- `condition`: `text`, `quiet`, `exit`, `prompt` or `timeout` (a timeout
  is a result, not an error).
- `since` and `mark`: the output the wait covered.
- `output`: that output as text, the last 64 KiB of it (`truncated` when
  cut).
- `match` and `groups` when the condition is `text`.
- `exit` when the process has exited.
- `changes`: the visible rows that differ from the start of the wait
  (`row`, `before`, `after`).
- `screen`: the visible rows now.
- `shell`: the pane's shell state (section 3), once its shell sent marks.
  After a `prompt` wait, `shell.exit_code` is the command's status when
  the shell sent it.

### pane.settle

Sends input, then waits until the pane is quiet, and says what changed.
It replaces press, sleep, read, compare.

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `input` | array | As in `pane.send`. |
| `quiet_ms` | integer, optional | Default 300. |
| `timeout_ms` | integer, optional | Default 10000. |

Result: `sent` (as `pane.send`) and `wait` (as `pane.wait`, with `since`
at the input and `changes` against the screen just before the input).

### pane.subscribe

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `since` | mark, optional | Start with the raw output from this mark instead of a snapshot, when the log still holds it and it fits in the window. Otherwise the stream starts with a snapshot. |
| `ack` | boolean, optional | The client will acknowledge what it processes (section 5). |
| `window` | integer, optional | Bytes, 64 KiB to 256 MiB. Default 4 MiB. |

Result: `pane` and `channel`. The stream's frames follow the result
(section 5). The result is always sent before the channel's first frame.

### pane.unsubscribe

`channel`. Result: `{}`. No frame of the channel follows the result.

### pane.process

`pane`. What runs in the pane's foreground now. Result: `pane` and
`foreground`, a Process: the leader of the terminal's foreground process
group, which is the shell at its prompt or the command it runs (when the
leader has exited and others of its group run on, the oldest of them).

**The Process object:** `pid`, `argv` (its arguments, `argv[0]` first),
and when the system tells them, `exe` (its executable's path), `cwd` (its
working directory now) and `started_at`. Fails with `failed` once the
pane's first process has exited.

**What changed since it started.** `pane.process` also says whether the
code the process runs is still the code on disk, so a client can tell a
server or board that needs a restart to load new code. It is worked out
when asked (git runs then, each command bounded by a timeout, the whole
by a few seconds), never tracked in the background. The foreground
Process gets:

- `exe_modified_at`: when its executable file was last modified (built
  or installed). Its version is not probed: the path and this time are
  what can be known of any program.
- `git`, when `cwd` is in a git work tree, a GitState: `root` (the work
  tree's top folder), `head` (the commit HEAD names now; left out with no
  commit yet), `branch` (left out when HEAD is detached), `started_on`
  (the commit HEAD named when the process started: the last entry of the
  HEAD reflog at or before `started_at`; left out when the reflog cannot
  tell), `edited` (tracked files modified more than a second after the
  start, relative to `root`, newest first, at most 20) and `partial`
  (`true` when not every tracked file was checked: at most 20000 are, and
  git must answer in time).
- `changed`, with `started_at` known: `true` when the code changed since
  the start, and then `changes` says why, in this order: `head` (HEAD
  names another commit than `started_on`), `files` (`edited` is not
  empty) and `exe` (`exe_modified_at` is more than a second after
  `started_at`: a rebuilt binary). The second of slack is there because
  Linux gives a start time against a boot time in whole seconds.

### pane.restart

| Field | | |
| --- | --- | --- |
| `pane` | id | |
| `grace_ms` | integer, optional | As in `pane.close`. |
| `shell_command` | boolean, optional | Keep the pane and start only the command its shell runs again (below). |

Closes the pane as `pane.close` does, then starts its command again in a
new pane: the same `command` (the login shell when none was given),
`env`, `hidden`, `ttl_ms` and `scrollback`, and the `cwd`, `name` and
`labels` the pane has now, at its current size, with the daemon's
environment as it is now. The environment a secret was given in
(checkpoints) is not kept. Result: `pane`, the new
pane (with a new id), and `replaced`, the old pane as it ended. The events
are those of a close and a new pane.

**Restarting the command a shell runs.** With `shell_command: true`,
the pane is kept and only the command its shell runs starts again: the
command line the shell reported when it started it (OSC 133 C, section
3). The daemon interrupts the command as Ctrl-C
does; when the shell's prompt has not come back after half of
`grace_ms`, it sends SIGTERM to the terminal's foreground process group,
and SIGKILL at the end of `grace_ms` (never to the group of the pane's
first process, the shell). Once the prompt is back, it types the same
command line (as a paste) and Enter. It fails with `failed` when the
shell sent no OSC 133 marks, is at its prompt, did not report the command
line, or did not draw its prompt again. Result: `pane` and `replaced`,
both the same pane as it is now (its id does not change), `command` (the
command line typed again), `mark` (the mark just before it was typed:
wait from it for what it prints) and `stopped_by` (`interrupt`, `SIGTERM`
or `SIGKILL`). The events are those of the shell's own state.

### pane.focus

`pane`. Asks the connections that display panes (`events.subscribe` with
`display: true`) to show this pane: each gets the `pane.focus` event.
Result: `displays`, how many were asked. With none, no window shows
panes now.

### Agents

The agent status channel (section 3, The agent in a pane), and hook
decisions: a hook that may hold its assistant (Claude Code's or Codex's
Stop, for a hand-off) asks the deciders, normally the hub, what to answer,
and lets the session go on when none answers in time.

#### agent.report

| Field | | |
| --- | --- | --- |
| `pane` | id, optional | The pane the agent runs in. Left out when the reporter cannot tell (a process shared by several panes, such as Codex's app-server). |
| `assistant` | string | `claude`, `codex`, or any name of 1 to 32 characters `a-z 0-9 . _ -`, starting with a letter or digit. |
| `event` | string | The assistant's own event name (`hook_event_name`), 1 to 64 characters. |
| `session` | string, optional | The assistant's session id. |
| `state` | optional | The state the event puts the agent in: `working`, `needs_you`, `idle` or `ended`. Left out, the state stays. |
| `need` | object, optional | With `needs_you`: `kind` and `message`. |
| `message` | string, optional | One line for people, at most 1000 bytes. |
| `cwd` | string, optional | |
| `pid` | integer, optional | The agent's process (a hook's parent). |
| `data` | object, optional | What the status and the hub's hand-off read of the hook's input, at most 256 KiB as JSON (below). The daemon keeps only those fields. |
| `decide` | boolean, optional | Ask the deciders what the hook answers. |
| `timeout_ms` | integer, optional | With `decide`: how long to wait, 1 to 60000. Default 2000. |

**Reports carry no prompt text.** Of a hook's input, `ravenryd hook`
forwards, and the daemon keeps from any reporter, only these fields of
`data` (each when present and of the right type):

- Every event: `hook_event_name`, `session_id`, `cwd`, `transcript_path`,
  `agent_id`, `source`, `reason`, `notification_type`, `tool_name`,
  `model` and `stop_hook_active`.
- `Notification`: `message` and `title`, each as one line (what the
  assistant asks of a person, such as a permission).
- `Stop`: `last_assistant_message` cut to the hand-off's marker line
  (`Hand-off deferred: ...`) or, when the last paragraph asks a question,
  to that paragraph (at most its last 2000 bytes), else empty;
  `background_tasks` as `id`, `type`, `status` and `agent_type`;
  `session_crons` as their `id`.

Everything else is dropped: the prompt a person typed, a tool's input and
output, the rest of what the assistant wrote. A need's line comes in
`message` and `need.message` instead: a notification's text, or for a
Codex approval its description or `Run <command>`.

The report is recorded with the next `seq` (each daemon numbers its
reports 1, 2, 3, ...), the pane's agent state is updated, and every
connection subscribed to events gets `agent.report`.

With `decide`, every connection that called `agent.decisions` gets
`agent.decision`. The result waits for the first reply that decides, or
until every decider passed, left or the timeout ran out.

Result: `seq`, `asked` (how many deciders were asked: 0 without `decide`
or with none connected) and `reply` when one decided: `stdout`, `stderr`
and `exit_code` (0 to 255, default 0), which `ravenryd hook` writes and
exits with as they are, so a decider speaks each assistant's own hook
format. Without `reply`, the hook prints nothing and exits 0, which
Claude Code and Codex take as "go on".

#### agent.events

| Field | | |
| --- | --- | --- |
| `pane` | id, optional | Only this pane's reports. |
| `since` | integer, optional | Reports after this `seq`. Default 0. |
| `limit` | integer, optional | 1 to 1000. Default 200. |

Result: `reports`, oldest first (AgentReport objects), `seq` (the newest
report's number) and `truncated` (the daemon no longer holds every report
after `since`). The daemon keeps the last 2048 reports, and at most 16 MiB
of them; the reports of a closed pane stay until they roll out. A client
that connects (the hub after a restart) reads what it missed from here,
then follows `agent.report`.

**The AgentReport object:** `seq`, `at`, `pane` (absent when unknown),
`assistant`, `source` (`hook`, `program` or `daemon`), `event`, and when
set `session`, `state`, `need`, `message`, `cwd`, `pid` and `data`.

#### agent.decisions

No fields. Result: `{}`. From then on this connection decides: it gets
`agent.decision` for every report sent with `decide`, until it closes.
Several connections may decide; the first reply that decides wins. A
decider speaks for the person (it may hold an assistant and tell it what
to do), so this and `agent.decide` fail with `forbidden` on a connection
that may not act as the person.

#### agent.decide

| Field | | |
| --- | --- | --- |
| `request` | integer | The `request` of an `agent.decision` event. |
| `reply` | object, optional | `stdout`, `stderr` (each at most 1 MiB) and `exit_code`. Left out: this connection passes. |

Result: `{}`. Fails with `not_found` when that decision is no longer
waiting for this connection (it timed out, or this connection answered
already).

### Files

Files on the daemon's machine, read as the user the daemon runs as: the
hub reads a remote session's transcript and brief through them for the
hand-off, since they are on the machine the session runs on. They give a
client nothing a program in a pane could not read itself. Paths are
absolute (at most 4096 bytes); `~` is not expanded.

#### file.stat

| Field | | |
| --- | --- | --- |
| `paths` | array | 1 to 64 absolute paths. |

Result: `files`, one per path in order: `path`, `type` (`file`, `dir`,
`other`, or `none` when nothing is there or it cannot be reached), and
for the others `size` (bytes) and `modified_at`.

#### file.read

| Field | | |
| --- | --- | --- |
| `path` | string | A regular file. |
| `offset` | integer, optional | Start here (default 0). |
| `tail` | integer, optional | Read the last this many bytes instead. Not with `offset`. |
| `limit` | integer, optional | Bytes, 1 to 8 MiB. Default 1 MiB. With `tail`, a smaller limit keeps the file's last bytes. |
| `format` | optional | `text` (default): UTF-8, invalid bytes replaced. `raw`: the bytes, base64. |

Result: `path`, `size` and `modified_at` (the file now), `from` and `to`
(the byte range read), and `text` or `data`. Fails with `not_found` when
there is no such file, `failed` for a directory or a file it cannot read.

### Checkpoints

A checkpoint is a point where an agent waits for a person. The agent
opens it (`ravenry ask`, `ravenry approve`, `ravenry secret` run
`checkpoint.new` on the daemon of the pane they run in, then
`checkpoint.wait`); whoever shows them to a person (the hub, which also
alerts the phone, and the app) follows `checkpoint.*` events and answers
with `checkpoint.answer`. Since each daemon holds its own, an agent on a
remote machine reaches the person through the connection the hub keeps
to that daemon.

Three kinds:

- **`ask`**: a question with buttons (`options`) and, with `free_text`,
  room to type an answer.
- **`approve`**: a `command` (and `why`, and the agent's own `warning`)
  that runs only once a person approves it. The person sees the exact
  text that runs, and may edit it first: then their text runs instead,
  and `answer.command` holds it, so the agent learns that it changed and
  what ran. It runs as `$SHELL -c <command>` in a new pane, in `cwd`,
  labelled `ravenry.checkpoint: <id>` so a window can show it; the
  checkpoint closes once it ended, with its exit and the end of its
  output.
- **`secret`**: a person types a secret, which goes where `secret.to`
  says and never to the agent: `input`, typed into a running pane
  (`secret.pane`, never the asking pane); `run`, typed into `command`,
  which starts in a new pane as for `approve`, once it printed its prompt
  and went quiet; or `env`, the variable `secret.env` of `command`. The
  pane masks it in its output from then on (section 3, Secrets in
  output). The checkpoint, events, reports and results never hold it:
  `answer.delivered` says it went. A client that shows checkpoints must
  not store or log it either.

States: `open` until a person answers, then `running` while an approved
command runs, then one of the closed states: `answered`, `declined` (a
person said no), `cancelled` (the agent withdrew it) or `expired` (no
answer before `expires_at`). A daemon holds every open checkpoint and the
last 64 closed ones, and at most 64 open at a time.

**The Checkpoint object:** `id` (ravenryd's are "c" and 7 characters),
`kind`, `state`, `title`, and when set `pane` (the asking pane),
`assistant` (the agent that ran there), `options`, `free_text`, `command`
(as the agent proposed it), `cwd`, `why`, `warning`, `env`, `secret` (`to`,
`pane`, `enter`, `env`), then `created_at`, `expires_at`, `closed_at`,
`reason` (why it was cancelled, or why an approved command did not run),
`answer` (`choice` and `option`, `text`, `approved`, `command` (the
command as the person edited it, only when it differs from the proposed
one: what ran), `delivered`, `declined`, `reason` (why they declined,
when they said), `by`, `at`) and `run` (`pane`, and once it ended `exit`,
`output`: the last 64 KiB as text, `truncated`).
A client that does not know a checkpoint's kind shows its title and
offers only to decline it.

`why` and `warning` are the agent's words. A client shows them as the
agent's, never as its own judgement, so a reassuring sentence cannot
stand in for the command. A client may add its own guess of what cannot
be undone; it shows that as its own, beside the agent's warning, and an
agent's warning never hides it.

Only a person answers: `checkpoint.answer` fails with `forbidden` on a
connection from inside a pane, so an agent cannot answer a checkpoint,
its own or another's, however it connects (Who acts as the person,
below). An agent opens, lists, waits on and cancels them.

#### checkpoint.new

| Field | | |
| --- | --- | --- |
| `kind` | string | `ask`, `approve` or `secret`. |
| `title` | string | What the person reads first, 1 to 1000 bytes; newlines allowed. |
| `pane` | id, optional | The pane the asking agent runs in (`RAVENRY_PANE`). |
| `options` | array, optional | ask: 1 to 8 buttons, each 1 to 100 bytes. |
| `free_text` | boolean, optional | ask: the person may type an answer. An ask needs `options`, `free_text` or both. |
| `command` | string, optional | approve, and secret with `to` `run` or `env`: the exact command line, 1 to 8 KiB. |
| `cwd` | string, optional | With `command`: where it runs. Default: the asking pane's `cwd`, else the home directory. |
| `why` | string, optional | approve: why it should run, at most 1000 bytes. |
| `warning` | string, optional | approve: what the agent warns the person about (what cannot be undone), at most 1000 bytes. |
| `env` | object, optional | approve: variables the command runs with, at most 16: names of letters, digits and `_` (not `RAVENRY_*`), values of one line, at most 1000 bytes. The person sees them beside the command. A page's run button passes an item's values this way, so they never go inside the command line. |
| `secret` | object, optional | secret: `to` (`input`, `run` or `env`), `pane` (input), `env` (env: a variable name, not `RAVENRY_*`), `enter` (input and run: end with Enter, default true). |
| `timeout_ms` | integer, optional | How long a person has, 1 to 24 hours. Default one hour. |

Result: `checkpoint`. Event subscribers get `checkpoint.opened`.

#### checkpoint.list

`all` (boolean, optional): also the closed ones the daemon holds. Result:
`checkpoints`, oldest first.

#### checkpoint.wait

| Field | | |
| --- | --- | --- |
| `checkpoint` | id | |
| `timeout_ms` | integer, optional | At most 24 hours. Default: until it closes. |

Result: `checkpoint` once it is closed, or as it is (`open` or `running`)
when `timeout_ms` ran out first. `cancel` stops it.

#### checkpoint.answer

A person's answer: exactly one of

| Field | | |
| --- | --- | --- |
| `choice` | integer | ask: an index into `options`. |
| `text` | string | ask with `free_text`: at most 4 KiB. |
| `approve` | `true` | approve: run it. |
| `secret` | string | secret: 4 to 4096 bytes on one line. Given, it is delivered (and for `run` and `env`, the command runs). |
| `decline` | `true` | Any kind: the person says no. |

plus `checkpoint` (id), `by` (optional, at most 64 bytes: where they
answered, for people: `desktop`, `phone`), and with some answers:

| Field | | |
| --- | --- | --- |
| `command` | string, optional | With `approve`: the command as the person edited it, 1 to 8 KiB. It runs instead of the proposed one, and `answer.command` holds it when it differs. |
| `reason` | string, optional | With `decline`: why, for the agent, at most 1000 bytes. |

Result: `checkpoint`, closed, or `running` for a command. Fails with
`not_found` when it is not open (answered elsewhere first, cancelled or
expired), and with `forbidden` when this connection may not act as the
person; the checkpoint then stays as it was. A daemon older than these
fields refuses them with `bad_request`, so an edited command never runs
as proposed by mistake: whoever passes an answer on (the hub) passes
every field or none.

#### checkpoint.cancel

`checkpoint`, and `reason` (optional). The agent withdraws an open
checkpoint. Result: `checkpoint`. Fails with `not_found` when it is not
open.

### Who acts as the person

A checkpoint exists so that a person answers it, and a hook decision is
the person's hub speaking. These methods act as the person:

- `checkpoint.answer`
- `agent.decisions` and `agent.decide`

The daemon refuses them with `forbidden` to a connection that does not
come from the person. Every other method stays open to every client,
agents included.

**How the daemon decides.** At `hello`, it asks the kernel which process
is at the other end of the socket (`LOCAL_PEERPID` on macOS,
`SO_PEERCRED` on Linux), then where that process comes from:

1. **Inside a pane: never the person.** The process, or one of its
   ancestors (by parent; and the leader of its session, with that
   leader's ancestors), is a pane's first process or the child of a
   ravenryd daemon (`ravenryd serve`), belongs to a pane by what the
   daemon saw while the pane lived or by the pane's mark, or started with
   `RAVENRY_SOCKET` (or `RAVENRY_PANE` alone) in its environment: what
   closing a pane looks for (section 3). The panes that count are those of the daemons
   of this daemon's runtime directory (section 9), the ones that share
   this machine's panes; a daemon in another runtime directory is another
   Ravenry (a test's). How the process connects does not matter: the
   command line, a raw call on the socket, a script, `ravenryd proxy`
   started in the pane.
2. **Over ssh: the person only with the answer key.** The process, or one
   of its ancestors, runs in an ssh session (`SSH_CONNECTION`,
   `SSH_CLIENT` or `SSH_TTY` in its environment, or an `sshd` ancestor):
   `ravenryd proxy` reached with `ssh host ravenryd proxy`, or anything
   else run over ssh. The daemon cannot see the machine such a connection
   comes from, so it cannot tell the person's hub from an agent there
   that runs ssh itself. Such a connection acts as the person only when
   its `hello` gives the answer key this machine trusts: the first key a
   connection over ssh gave, from outside every pane. The daemon keeps
   that key's SHA-256 in `<state>/answer-key` (section 9); a key given
   from inside a pane is never kept. To trust another hub, delete the
   file on that machine: the next hub that connects pairs. The hub gives
   its key (made once, kept in its data folder) on every connection, so
   it pairs with a machine when it first connects to it, which is when
   the person adds the machine.
3. **Otherwise: the person.** A process of the user's outside every pane
   and outside ssh: the desktop app, the hub, a shell in another terminal
   app where the person types.

A process the daemon cannot read (it has exited, or it is not the
user's) is not the person. `hello`'s `person` says what the daemon
decided for the connection.

**The hub** applies the same rule to the answers its HTTP API takes. A
request from the phone (another address, with the phone's token) is the
person. A request from this machine, on localhost or on one of its own
addresses, is judged by the process that holds the connection:
`ravenryd peer --tcp <its port> --to <the hub's port>` finds that process
(libproc on macOS, `/proc/net/tcp` and `/proc/*/fd` on Linux) and judges
it with the daemon's own code, with the processes each daemon counts in
its panes (`pane.list` with `processes`). So `curl` to the hub from a
pane is refused like a raw call on the socket, while the board page in a
browser and the desktop app answer as before. The hub refuses this way
every write that stands for a person's decision, not only answers
(hub/docs/PERSON.md lists them).

**Limits.** This closes every direct route an agent has to answering;
it is not a sandbox around agents.

- **Same-user processes outside every pane are the person.** A script the
  person runs in another terminal app, a cron job, a launchd or systemd
  service. So is a program an agent has another service start outside
  its pane (a terminal multiplexer server started earlier, `launchctl`,
  `systemd-run`, `at`, a ravenryd daemon of its own in another runtime
  directory). A program that moves to a new session of its own and
  leaves its parents (a double fork) with its environment wiped stays in
  the pane (section 3) as long as the daemon saw its middle process: on
  macOS the fork watch does unless the middle process is gone before the
  daemon reads its parent's children (in practice a few microseconds
  after the fork; it saw it in each of 200 runs of a C double fork that
  exits at once); on Linux the pane's mark carries over unless the
  program resets its own `RLIMIT_RTTIME`. (`ssh` to this machine does
  not help: what it runs is in an ssh session.)
- **Ravenry's secrets are the user's files.** The hub's answer key and
  the phone's sign-in key can be read by any program of the user, an
  agent included: with the first, it can answer over ssh as the hub;
  with the second, it can answer through the hub from another machine
  as the phone. The file of the key a machine trusts can be deleted over
  ssh, so the next connection pairs. Each is a deliberate attack, not a
  mistake; the agent's own permissions must keep it out of Ravenry's
  files.
- **UI automation is out of scope until per-pane permissions (phase
  2).** A program that clicks the app's buttons (`osascript`,
  accessibility APIs) acts with the person's hands, and so does input
  sent to a pane (`pane.send`, which agents use to drive other panes),
  for example into a pane where another assistant asks its own
  permission question.
- **A hub or an app started from inside a pane** (while developing them)
  is inside it, and cannot answer.

## 5. Streams and binary frames

### Frame layout

Every binary frame starts with a 14-byte header:

| Bytes | | |
| --- | --- | --- |
| 0 | version | 1 |
| 1 | kind | 1 output, 2 snapshot, 3 input |
| 2 to 5 | channel | unsigned, big-endian |
| 6 to 13 | mark | unsigned, big-endian |
| 14 on | payload | terminal bytes |

- **Output** (daemon to client): bytes the pane printed. `mark` is the
  position of the payload's first byte. Write them to the client's
  terminal as they are.
- **Snapshot** (daemon to client): the VT sequences that rebuild the
  pane's screen, scrollback, cursor and modes. `mark` is the position the
  snapshot shows; the output frames that follow continue from it. It
  starts with a full reset (`ESC c`), so the client writes it into its
  terminal, as it is, at any time. It leaves the client's colour theme
  alone (no palette changes). On the alternate screen, it first draws
  the primary screen, so the shell's history comes back when the program
  leaves the alternate screen.
- **Input** (client to daemon): bytes to write to the pane as they are,
  on a channel this connection subscribed. `mark` is ignored (send 0).
  This is the path for keystrokes from a person; `pane.send` is the path
  for agents.

### What a stream sends

1. A snapshot (or, with `since`, the output from that mark).
2. Output frames, as the pane prints.
3. When the pane's output ends (its pty closed, or the pane was closed),
   the `stream.end` event, after the last frame. The channel is then
   gone.

### Bundling and flow control

The daemon does not hold output back on a timer:

- **A client that is not behind gets new output at once,** so a
  keystroke's echo travels alone, without delay.
- **While earlier output is still on its way,** new output gathers into
  the next frame, so a flood becomes a few large frames rather than one
  frame per read. "On its way" means not yet written to the socket, or,
  for a client that acknowledges, not yet acknowledged.
- **A client that acknowledges** sends `{"v": 1, "type": "ack", "channel":
  <channel>, "bytes": <n>}` after it has processed n more payload bytes of
  the channel (output and snapshots; for xterm.js, in the `write`
  callback). It may acknowledge several frames at once.
- **A client never slows the pane.** When a client falls more than its
  `window` behind (bytes queued for it, plus bytes it has not acknowledged
  when it acknowledges), the daemon drops the output queued for it, and
  once it has caught up sends a fresh snapshot, then live output again. A
  terminal on screen then shows the current screen instead of replaying
  everything it missed, and a person's Ctrl+C is not stuck behind
  megabytes of old output. A client that needs every byte reads the log
  with `pane.read`, or asks for a larger `window`.

## 6. Events

After `events.subscribe`:

| Event | Fields | When |
| --- | --- | --- |
| `pane.created` | `pane` | A pane started. |
| `pane.title` | `pane` | A pane's title changed. |
| `pane.exited` | `pane` | A pane's first process exited. |
| `pane.closed` | `pane` | A pane was closed and removed. |
| `pane.prompt` | `pane` | A pane's shell state changed (its `shell`: a command started or ended). A prompt redrawn in the same state sends nothing. |
| `pane.cwd` | `pane` | A pane's working directory changed (OSC 7, section 3). |
| `pane.updated` | `pane` | A pane's name or labels changed (`pane.update`). |
| `checkpoint.opened` | `checkpoint` | An agent waits for a person: show it. |
| `checkpoint.running` | `checkpoint` | A person let its command run; `run.pane` shows it. |
| `checkpoint.closed` | `checkpoint` | It was answered, declined, cancelled or expired. |
| `agent.report` | `report`, `pane` | An agent report was recorded. `pane` is the pane as it is after it (with its `agent`), when the report names a pane that is still there. |
| `daemon.draining` | `newer` | A newer daemon version runs beside this one (section 9). |

On a connection that subscribed with `display: true`:

| Event | Fields | When |
| --- | --- | --- |
| `pane.focus` | `pane` | Someone asked to show this pane (`pane.focus`). |

On a connection that subscribed with `activity: true`:

| Event | Fields | When |
| --- | --- | --- |
| `pane.activity` | `pane` | A pane that this connection does not stream printed. At most one a second per pane: the first output after a quiet second at once, and one more at the end of the second when more came. |

On a connection that called `agent.decisions`:

| Event | Fields | When |
| --- | --- | --- |
| `agent.decision` | `request`, `report`, `timeout_ms` | A hook waits for a decision: answer with `agent.decide` within `timeout_ms`. |

On any connection with a stream, whether or not it subscribed to events:

| Event | Fields | When |
| --- | --- | --- |
| `stream.end` | `channel`, `mark` | The stream's pane output ended; `mark` is where. |

A client that does not read its events falls behind; when more than 1024
are queued for it, the daemon closes the connection rather than hold up
the panes.

## 7. Input and keys

An input item is one of:

- **Text with a mode,** which is always explicit:
  - `raw`: the text as it is, in one write.
  - `paste`: one paste, in one write. Unsafe control characters become
    spaces. When the program turned bracketed paste on (mode 2004), the
    text is wrapped in `ESC [200~` ... `ESC [201~`; otherwise newlines
    become carriage returns, as when a person pastes.
  - `typed`: one character at a time, with a pause between characters
    (`delay_ms`, default 10). Some programs treat input that arrives in
    one read as a paste and only react to keys typed one by one; typed
    input is never one read. A newline is sent as Enter (CR).
- **A key:** `{"key": "<name>"}`.

**Key names.** Modifiers joined with `+` before the key: `Ctrl`, `Alt`,
`Shift`, `Super` (also `Control`, `Option`, `Meta`, `Cmd`), or the short
forms `C-`, `M-`, `S-`. Then a named key or one character. Names are not
case sensitive.

- **Named keys:** `Enter` (`Return`), `Tab`, `Escape` (`Esc`),
  `Backspace`, `Delete` (`Del`), `Insert`, `Home`, `End`, `PageUp`,
  `PageDown`, `Up`, `Down`, `Left`, `Right`, `Space`, `F1` to `F12`.
- **Examples:** `Enter`, `Ctrl+C`, `C-c`, `Shift+Tab`, `Alt+Enter`, `M-x`,
  `Up`, `y`.
- **Encoding follows the program.** A key is encoded the way the program in
  the pane expects, given the modes it set: application cursor keys (Up
  is `ESC O A` instead of `ESC [ A`), the Kitty keyboard protocol, and
  the others the terminal tracks. A client sends a key name and does not
  need to know the program's modes.

## 8. Errors

| Code | Meaning |
| --- | --- |
| `bad_request` | The message is not valid: a missing or unknown field, a value out of range, a bad regular expression or key name, another protocol version. |
| `hello_required` | A request came before `hello`. |
| `unknown_method` | The daemon has no such method. |
| `not_found` | No such pane, channel, running request or waiting decision. |
| `pane_closed` | The pane was closed while the request ran. |
| `failed` | The request was valid but did not work, such as a program that does not exist. |
| `cancelled` | `cancel` stopped the request. |
| `shutting_down` | The daemon is stopping. |
| `internal` | A fault in the daemon. |
| `forbidden` | Only a person may do this, and this connection does not come from one (section 4, Who acts as the person). |

`message` is for people; clients branch on `code`.

## 9. Finding the daemon, and updates

### Where the socket lives

One daemon runs per user and version. Its socket is
`ravenryd-<version>.sock` in the runtime directory:

- `$RAVENRY_RUNTIME_DIR`, when set.
- **Linux:** `$XDG_RUNTIME_DIR/ravenry` when `XDG_RUNTIME_DIR` is set (a
  private tmpfs, `/run/user/<uid>`). Otherwise `<state>/run`.
- **macOS:** `<state>/run`.

The state directory, which also holds the pane logs (`<state>/panes`) and
the answer key the daemon trusts over ssh (`<state>/answer-key`):

- `$RAVENRY_STATE_DIR`, when set.
- **macOS:** `~/Library/Application Support/Ravenry`.
- **Linux:** `$XDG_STATE_HOME/ravenry`, or `~/.local/state/ravenry`.

Both are created with mode 0700, must belong to the user and be closed to
everyone else (the daemon refuses them otherwise), and are never under
`/tmp` or another directory everyone can write to. macOS's per-user
`$TMPDIR` is avoided too: the system cleans it of files it thinks are
unused, and SSH sessions do not always set it.

### How a client finds the right daemon

1. **A pinned socket.** Inside a pane, `RAVENRY_SOCKET` names the daemon
   that runs it; a program there uses it. A client may also be told a
   socket explicitly.
2. **Otherwise, list the runtime directory.** Every `ravenryd-*.sock` that
   accepts a connection is a running daemon, and its `hello` says its
   version.
   - **New panes** go to the newest daemon.
   - **Existing panes** are found by asking each daemon (`pane.list` with
     `hidden: true`). Ids are unique across daemons in practice.
   - **The board** shows the panes of every daemon together.
3. **None running:** `ravenryd` starts one (`ravenryd serve --detach`).

Over SSH:

- `ssh host ravenryd daemons --json` lists the remote daemons.
- `ssh host ravenryd proxy --version <v>` connects to one of them.
- `ssh host ravenryd proxy` connects to the newest. It starts a daemon of
  its own version when none runs, or when its version is newer than every
  running one.

### Updates never kill a session

1. A new version of ravenryd starts beside the old one, on its own socket.
2. The old daemon notices it (it looks every two seconds). It sends
   `daemon.draining` with the newer version to its event subscribers, and
   reports `draining` in `hello`.
3. Clients send new panes to the newer daemon. The old daemon keeps its
   panes and still serves them fully.
4. Once none of its panes is running, the old daemon closes what is left
   (exited panes), removes its socket and exits.

## 10. How the protocol changes

- **Until the public launch,** v1 is a draft and may change.
- **After the launch, v1 only grows by additions:**
  - new methods, listed in `hello`'s `methods`
  - new optional request fields
  - new result fields, events and error codes
  - new frame kinds
- **What clients and the daemon do with additions:**
  - **Clients:** ignore unknown fields in what the daemon sends, ignore
    events they do not know, and ignore binary frames of an unknown kind.
  - **The daemon:** keeps refusing unknown request fields. A client
    checks `methods` (and the daemon's version) before relying on
    something newer.
- **Anything that would break a v1 client is version 2:** the subprotocol
  `ravenry.v2` on path `/v2`, with `"v": 2` in its messages and 2 in the
  frame header. A daemon may serve both.
