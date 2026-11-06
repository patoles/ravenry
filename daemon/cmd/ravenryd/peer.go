package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
)

// cmdPeer tells whether a process may act as the person (PROTOCOL.md
// section 4, Who acts as the person): read, not inside a pane and not in
// an ssh session. The hub runs it with --tcp and --to about the process
// that sent an answer to its HTTP API from this machine, so the daemon
// and the hub judge with the same code. With --tcp it judges every
// process that holds the connection; none found is not a person.
func cmdPeer(in []string) error {
	a, err := parse(in, specOf("peer"))
	if err != nil {
		return err
	}
	num := func(name string) (int, error) {
		n, err := strconv.Atoi(a.values[name])
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("--%s takes a number", name)
		}
		return n, nil
	}
	var pids []int
	switch {
	case a.values["pid"] != "":
		pid, err := num("pid")
		if err != nil {
			return err
		}
		pids = []int{pid}
	case a.values["tcp"] != "":
		local, err := num("tcp")
		if err != nil {
			return err
		}
		to, err := num("to")
		if err != nil {
			return err
		}
		if pids, err = pane.TCPOwners(local, to); err != nil {
			return err
		}
	default:
		return errors.New("usage: ravenryd peer (--pid PID | --tcp PORT --to PORT) [--json]")
	}
	type row struct {
		Person bool   `json:"person"`
		PIDs   []int  `json:"pids"`
		Pane   string `json:"pane,omitempty"`
		Why    string `json:"why,omitempty"`
	}
	r := row{Person: len(pids) > 0, PIDs: pids}
	if len(pids) == 0 {
		r.Why = "no process of this user holds that connection"
	}
	var whys []string
	roots, members := panesHere()
	sc := pane.Scope{Roots: roots, Member: func(pid int) (string, bool) { id, ok := members[pid]; return id, ok }}
	sc.Dir, _ = paths.RuntimeDirFor(os.Getenv)
	for _, pid := range pids {
		o := pane.OriginOf(pid, sc)
		if !o.Person() {
			r.Person = false
			whys = append(whys, o.Why())
			if o.Pane && r.Pane == "" {
				r.Pane = firstOf(o.PaneID, "?")
			}
		}
	}
	if len(whys) > 0 {
		r.Why = strings.Join(whys, "; ")
	}
	if a.g.json {
		return printJSON(r)
	}
	if r.Person {
		fmt.Println("the person")
	} else {
		fmt.Println("not the person: " + r.Why)
	}
	return nil
}

// panesHere maps the first process of every running pane of every daemon
// here to its pane, and every process that belongs to one now (pane.list
// with processes: what the daemon saw while the pane lived included), so a
// process is placed in its pane even where its environment cannot be read
// (macOS hides the environment of its own programs, /bin/sh and curl
// among them) and after it left its parents.
func panesHere() (roots, members map[int]string) {
	roots, members = map[int]string{}, map[int]string{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, d := range liveDaemons() {
		c, err := dial(ctx, d.socket)
		if err != nil {
			continue
		}
		var l proto.ListResult
		if c.Call(ctx, "pane.list", map[string]any{"hidden": true, "processes": true}, &l) != nil {
			// A daemon from before pane.list took processes.
			c.Call(ctx, "pane.list", map[string]any{"hidden": true}, &l)
		}
		for _, p := range l.Panes {
			if p.State == "running" && p.PID > 0 {
				roots[p.PID] = p.ID
			}
			for _, pid := range p.PIDs {
				members[pid] = p.ID
			}
		}
		c.Close()
	}
	return roots, members
}
