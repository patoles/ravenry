package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/paths"
)

// How a client finds its daemon:
//
//  1. --socket <path>, or $RAVENRY_SOCKET (set inside every pane, so a
//     program in a pane talks to the daemon that runs it).
//  2. Otherwise the daemons in the runtime directory, one socket per
//     version (ravenryd-<version>.sock). A command about an existing pane
//     asks each live daemon, newest first, for that pane. A command that
//     starts something new uses the newest live daemon, unless this
//     binary is newer than all of them: then it starts its own version
//     beside them, so new panes go to the new version while the old one
//     keeps its panes until they end.
//  3. With no live daemon at all, it starts one (ravenryd serve --detach),
//     unless --no-start.

type global struct {
	socket  string
	noStart bool
	json    bool
}

type liveDaemon struct {
	socket  string
	version string
}

// liveDaemons lists the daemons that answer, newest first.
func liveDaemons() []liveDaemon {
	socks, _ := paths.Sockets()
	var out []liveDaemon
	for _, s := range socks {
		c, err := net.DialTimeout("unix", s.Path, time.Second)
		if err != nil {
			continue
		}
		c.Close()
		out = append(out, liveDaemon{socket: s.Path, version: s.Version})
	}
	return out
}

func dial(ctx context.Context, socket string) (*client.Client, error) {
	return client.Dial(ctx, socket, client.Options{Name: "ravenryd-cli", Version: version})
}

func pinned(g global) string {
	if g.socket != "" {
		return g.socket
	}
	return os.Getenv("RAVENRY_SOCKET")
}

// connectNewest connects to the daemon new work belongs to.
func connectNewest(ctx context.Context, g global) (*client.Client, error) {
	if s := pinned(g); s != "" {
		return dial(ctx, s)
	}
	live := liveDaemons()
	if len(live) > 0 && paths.CompareVersions(live[0].version, version) >= 0 {
		return dial(ctx, live[0].socket)
	}
	if g.noStart {
		if len(live) > 0 {
			return dial(ctx, live[0].socket)
		}
		return nil, errors.New("no ravenryd is running (and --no-start was given)")
	}
	sock, err := startDaemon()
	if err != nil {
		return nil, err
	}
	return dial(ctx, sock)
}

// connectFor connects to the daemon that holds a pane.
func connectFor(ctx context.Context, g global, pane string) (*client.Client, error) {
	if s := pinned(g); s != "" {
		return dial(ctx, s)
	}
	live := liveDaemons()
	for _, d := range live {
		c, err := dial(ctx, d.socket)
		if err != nil {
			continue
		}
		var r struct {
			Panes []struct {
				ID string `json:"id"`
			} `json:"panes"`
		}
		if c.Call(ctx, "pane.list", map[string]any{"hidden": true}, &r) == nil {
			for _, p := range r.Panes {
				if p.ID == pane {
					return c, nil
				}
			}
		}
		c.Close()
	}
	if len(live) == 0 {
		return nil, errors.New("no ravenryd is running")
	}
	return nil, fmt.Errorf("no running daemon has pane %s", pane)
}

// cleanEnv is the environment for a daemon this command starts: without
// the variables that tie a process to a pane, so closing the pane this
// command runs in does not take the daemon with it.
func cleanEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "RAVENRY_PANE=") || strings.HasPrefix(kv, "RAVENRY_SOCKET=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// startDaemon starts `ravenryd serve` for this version in its own session,
// detached from this terminal, and waits until it answers.
func startDaemon() (string, error) {
	sock, err := paths.SocketPath(version)
	if err != nil {
		return "", err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	state, err := paths.StateDir()
	if err != nil {
		return "", err
	}
	logPath := filepath.Join(state, "ravenryd-"+strings.TrimSuffix(strings.TrimPrefix(paths.SocketName(version), "ravenryd-"), ".sock")+".log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer logf.Close()
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return "", err
	}
	defer devnull.Close()
	cmd := exec.Command(exe, "serve")
	cmd.Env = cleanEnv()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	home, _ := os.UserHomeDir()
	cmd.Dir = home
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start ravenryd serve: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err == nil {
			c.Close()
			cmd.Process.Release()
			return sock, nil
		}
		select {
		case err := <-exited:
			// Another command may have started the same version first.
			if c, derr := net.DialTimeout("unix", sock, 200*time.Millisecond); derr == nil {
				c.Close()
				return sock, nil
			}
			return "", fmt.Errorf("ravenryd serve exited (%v); see %s", err, logPath)
		case <-time.After(25 * time.Millisecond):
		}
	}
	return "", fmt.Errorf("ravenryd serve did not answer on %s within 5 s; see %s", sock, logPath)
}
