// Command ravenryd is the Ravenry daemon and its command line: one daemon
// per machine owns the terminals (panes), their screens and their output,
// and speaks the Ravenry protocol (packages/protocol) on a unix socket.
// The same binary is the client: `ravenryd new`, `ravenryd capture` and the
// other commands below talk to the daemon.
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"ravenryd/internal/client"
)

// version is set at build time:
//
//	go build -ldflags "-X main.version=1.2.3" ./cmd/ravenryd
var version = "0.0.0-dev"

const usage = `ravenryd: the Ravenry daemon and its command line.

Daemon:
  ravenryd serve [--socket PATH] [--detach]   run the daemon for this machine
  ravenryd proxy [--socket PATH | --version V] bridge standard input and output
                                               to the daemon (ssh host ravenryd proxy)
  ravenryd daemons [--json]                   list the daemons running here
  ravenryd version [--json]

Panes:
  ravenryd new [--cwd DIR] [--env K=V]... [--size COLSxROWS] [--name NAME]
               [--hidden [--ttl 10m]] [--json] [-- COMMAND ARGS...]
  ravenryd ls [--all] [--json]
  ravenryd capture PANE [--styles] [--history N] [--vt] [--json]
  ravenryd send PANE INPUT... [--json]
  ravenryd settle PANE INPUT... [--quiet 300ms] [--timeout 10s] [--json]
  ravenryd wait PANE [--text REGEX [--screen]] [--quiet 800ms] [--exit]
               [--prompt] [--since MARK] [--timeout 30s] [--json]
  ravenryd read PANE --since MARK [--limit BYTES] [--raw] [--json]
  ravenryd resize PANE COLSxROWS [--json]
  ravenryd close PANE [--grace 1s] [--json]
  ravenryd process PANE [--json]          what runs in the foreground: pid,
                                          arguments, executable, directory
  ravenryd restart PANE [--grace 1s] [--json]
                                          close the pane and start its command
                                          again (same directory and env); prints
                                          the new pane's id
  ravenryd focus PANE [--json]            ask the windows that show panes to
                                          show this one

  INPUT, in order: --paste TEXT, --typed TEXT, --raw TEXT, --key NAME
  (--delay 10ms sets the pause between typed characters). Key names:
  Enter Tab Escape Backspace Delete Insert Home End PageUp PageDown Up Down
  Left Right Space F1-F12 or one character, with Ctrl+ Alt+ Shift+ Super+
  (or C- M- S-): Ctrl+C, Shift+Tab, M-x.

  wait exits with 0 when its condition held and 124 on timeout. --prompt
  holds when the shell starts its next prompt (OSC 133 shell integration).

Agents:
  ravenryd agents [--json]                the agent state of every pane
  ravenryd reports [PANE] [--since SEQ] [--limit N] [--follow] [--json]
                                          what agents reported, oldest first
  ravenryd hook --assistant claude|codex|NAME [--state STATE [--need KIND]]
               [--event NAME] [--decide] [--timeout 2s]
                                          the command an assistant's hooks run:
                                          reads the hook's JSON on standard
                                          input and reports it to the pane's
                                          daemon. It always lets the session
                                          go on unless the hub decides

Every command takes --socket PATH to talk to one daemon, and --no-start to
not start a daemon when none is running.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = cmdServe(args)
	case "proxy":
		err = cmdProxy(args)
	case "version", "--version", "-v":
		err = cmdVersion(args)
	case "daemons":
		err = cmdDaemons(args)
	case "new":
		err = cmdNew(args)
	case "ls", "list":
		err = cmdList(args)
	case "capture":
		err = cmdCapture(args)
	case "send":
		err = cmdSend(args, false)
	case "settle":
		err = cmdSend(args, true)
	case "wait":
		err = cmdWait(args)
	case "read":
		err = cmdRead(args)
	case "resize":
		err = cmdResize(args)
	case "close":
		err = cmdClose(args)
	case "process":
		err = cmdProcess(args)
	case "restart":
		err = cmdRestart(args)
	case "focus":
		err = cmdFocus(args)
	case "agents":
		err = cmdAgents(args)
	case "reports":
		err = cmdReports(args)
	case "hook":
		err = cmdHook(args)
	case "help", "--help", "-h":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "ravenryd: unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		var ex exitCode
		if errors.As(err, &ex) {
			os.Exit(int(ex))
		}
		var ce *client.Error
		if errors.As(err, &ce) {
			fmt.Fprintf(os.Stderr, "ravenryd %s: %s (%s)\n", cmd, ce.Message, ce.Code)
		} else {
			fmt.Fprintf(os.Stderr, "ravenryd %s: %v\n", cmd, err)
		}
		os.Exit(1)
	}
}

// exitCode ends the command with a status and no message.
type exitCode int

func (e exitCode) Error() string { return "exit " + strconv.Itoa(int(e)) }

// ------------------------------------------------------------ arguments

type flagKind int

const (
	boolFlag flagKind = iota
	valueFlag
	listFlag
)

// args is a parsed command line. Flags may come before or after the
// positional arguments; "--" ends the flags. ordered keeps every flag in
// the order given, for input flags whose order matters.
type args struct {
	pos     []string
	bools   map[string]bool
	values  map[string]string
	lists   map[string][]string
	ordered [][2]string
	g       global
}

func parse(in []string, spec map[string]flagKind) (*args, error) {
	a := &args{bools: map[string]bool{}, values: map[string]string{}, lists: map[string][]string{}}
	spec["socket"] = valueFlag
	spec["no-start"] = boolFlag
	spec["json"] = boolFlag
	for i := 0; i < len(in); i++ {
		s := in[i]
		if s == "--" {
			a.pos = append(a.pos, in[i+1:]...)
			break
		}
		if !strings.HasPrefix(s, "--") {
			a.pos = append(a.pos, s)
			continue
		}
		name, val, hasVal := strings.Cut(s[2:], "=")
		kind, ok := spec[name]
		if !ok {
			return nil, fmt.Errorf("unknown flag --%s", name)
		}
		if kind == boolFlag {
			if hasVal {
				return nil, fmt.Errorf("--%s takes no value", name)
			}
			a.bools[name] = true
			a.ordered = append(a.ordered, [2]string{name, ""})
			continue
		}
		if !hasVal {
			if i+1 >= len(in) {
				return nil, fmt.Errorf("--%s needs a value", name)
			}
			i++
			val = in[i]
		}
		if kind == listFlag {
			a.lists[name] = append(a.lists[name], val)
		} else {
			a.values[name] = val
		}
		a.ordered = append(a.ordered, [2]string{name, val})
	}
	a.g = global{socket: a.values["socket"], noStart: a.bools["no-start"], json: a.bools["json"]}
	return a, nil
}

// duration reads "800ms", "10s", "2m", or a bare number of milliseconds.
func duration(s string) (time.Duration, error) {
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return time.Duration(n) * time.Millisecond, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration (800ms, 10s, 2m)", s)
	}
	return d, nil
}

func size(s string) (int, int, error) {
	c, r, ok := strings.Cut(strings.ToLower(s), "x")
	cols, err1 := strconv.Atoi(c)
	rows, err2 := strconv.Atoi(r)
	if !ok || err1 != nil || err2 != nil {
		return 0, 0, fmt.Errorf("%q is not a size like 120x40", s)
	}
	return cols, rows, nil
}

func onePane(a *args, cmd string) (string, error) {
	if len(a.pos) != 1 {
		return "", fmt.Errorf("usage: ravenryd %s PANE ...", cmd)
	}
	return a.pos[0], nil
}
