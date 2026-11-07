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

func main() {
	name := invokedAs(os.Args[0])
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usageText(name))
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	c := cmdByName(cmd)
	if c == nil {
		fmt.Fprintf(os.Stderr, "%s: unknown command %q\n\n%s", name, cmd, usageText(name))
		os.Exit(2)
	}
	if c.name == "help" {
		fmt.Print(usageText(name))
		return
	}
	err := c.run(args)
	if err != nil {
		var ex exitCode
		if errors.As(err, &ex) {
			os.Exit(int(ex))
		}
		var ce *client.Error
		if errors.As(err, &ce) {
			fmt.Fprintf(os.Stderr, "%s %s: %s (%s)\n", name, c.name, ce.Message, ce.Code)
		} else {
			fmt.Fprintf(os.Stderr, "%s %s: %v\n", name, c.name, err)
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
	// dash is how many positional arguments came before "--", or -1.
	dash int
}

func parse(in []string, spec map[string]flagKind) (*args, error) {
	a := &args{bools: map[string]bool{}, values: map[string]string{}, lists: map[string][]string{}, dash: -1}
	spec["socket"] = valueFlag
	spec["no-start"] = boolFlag
	spec["json"] = boolFlag
	for i := 0; i < len(in); i++ {
		s := in[i]
		if s == "-o" {
			if _, ok := spec["out"]; ok {
				s = "--out" // -o FILE, as cc and curl take it
			}
		}
		if s == "--" {
			a.dash = len(a.pos)
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
