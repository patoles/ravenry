package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ravenryd/internal/tailnet"
)

// cmdTailnet puts Ravenry on the person's Tailscale as its own device
// (internal/tailnet, docs/PHONE.md section 2, Away from home). The hub
// runs it while phone access and Away from home are both on:
//
//	ravenryd tailnet --dir DIR --forward PORT
//
// It prints each change of state as a JSON line on standard output
// (tailnet.Event: starting, needs-login with the sign-in URL, running
// with its name, addresses and account, offline, error, and a refused
// caller), and reads commands as lines on standard input: `logout` signs
// it out (Tailscale takes the device off the tailnet, its keys are
// deleted), and the end of standard input (the hub gone) or SIGTERM
// takes it off the tailnet for now, its keys kept.
//
//	ravenryd tailnet --dir DIR --forward PORT --logout
//
// signs out a node that is not running: it starts from its keys without
// listening, logs out and deletes them.
func cmdTailnet(in []string) error {
	a, err := parse(in, specOf("tailnet"))
	if err != nil {
		return err
	}
	dir := a.values["dir"]
	if dir == "" {
		return errors.New("usage: ravenryd tailnet --dir DIR --forward PORT [--port PORT] [--hostname NAME] [--logout]")
	}
	port := func(name string) (int, error) {
		v := a.values[name]
		if v == "" {
			return 0, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 65535 {
			return 0, fmt.Errorf("--%s takes a port", name)
		}
		return n, nil
	}
	fwd, err := port("forward")
	if err != nil {
		return err
	}
	if fwd == 0 {
		return errors.New("--forward PORT: the hub's phone port is needed")
	}
	lport, err := port("port")
	if err != nil {
		return err
	}
	var out sync.Mutex
	enc := json.NewEncoder(os.Stdout)
	emit := func(e tailnet.Event) {
		out.Lock()
		defer out.Unlock()
		enc.Encode(e)
	}
	logf := func(f string, v ...any) { fmt.Fprintf(os.Stderr, f+"\n", v...) }
	cfg := tailnet.Config{Dir: dir, Hostname: a.values["hostname"], Forward: fwd, Port: lport, ControlURL: a.values["control-url"], Events: emit, Logf: logf}
	if os.Getenv("RAVENRY_TAILNET_DEBUG") == "1" {
		cfg.Debugf = logf
	}

	if a.bools["logout"] {
		if _, err := os.Stat(dir); err != nil {
			t := true
			emit(tailnet.Event{State: tailnet.StateSignedOut, Removed: &t})
			return nil
		}
		// Not listening: only the log-out goes out.
		cfg.Events = func(e tailnet.Event) {}
		cfg.Port = -1
		n, err := tailnet.Start(cfg)
		if err != nil {
			return err
		}
		return signOut(n, dir, emit)
	}

	n, err := tailnet.Start(cfg)
	if err != nil {
		return err
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	lines := make(chan string)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			lines <- strings.TrimSpace(sc.Text())
		}
	}()
	for {
		select {
		case <-sig:
			n.Close()
			return nil
		case l, ok := <-lines:
			if !ok {
				n.Close()
				return nil
			}
			switch l {
			case "logout":
				return signOut(n, dir, emit)
			case "":
			default:
				logf("tailnet: unknown command %q (logout, or end of input to stop)", l)
			}
		}
	}
}

// signOut logs out (at most 15 s to reach Tailscale) and deletes the keys.
func signOut(n *tailnet.Node, dir string, emit func(tailnet.Event)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	n.WaitReady(ctx)
	removed, err := n.Logout(ctx)
	if err != nil {
		emit(tailnet.Event{State: tailnet.StateError, Error: fmt.Sprintf("the keys in %s were not deleted: %v", dir, err)})
		return err
	}
	emit(tailnet.Event{State: tailnet.StateSignedOut, Removed: &removed})
	return nil
}
