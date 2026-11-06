package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
	"ravenryd/internal/server"
	"ravenryd/internal/vt"
)

func cmdServe(in []string) error {
	a, err := parse(in, map[string]flagKind{"detach": boolFlag})
	if err != nil {
		return err
	}
	if a.bools["detach"] {
		sock, err := startDaemon()
		if err != nil {
			return err
		}
		fmt.Println(sock)
		return nil
	}
	// A daemon started from inside a pane must not carry that pane's
	// marker, or closing the pane would end the daemon too.
	if os.Getenv("RAVENRY_PANE") != "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return syscall.Exec(exe, os.Args, cleanEnv())
	}
	sock := a.g.socket
	if sock == "" {
		if sock, err = paths.SocketPath(version); err != nil {
			return err
		}
	} else if err := paths.EnsurePrivateDir(filepath.Dir(sock)); err != nil {
		return err
	}
	if c, err := net.DialTimeout("unix", sock, time.Second); err == nil {
		c.Close()
		return fmt.Errorf("a daemon already answers on %s", sock)
	}
	os.Remove(sock) // a stale socket from a daemon that died
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", sock)
	syscall.Umask(old)
	if err != nil {
		return err
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(sock, 0o600); err != nil {
		return err
	}
	state, err := paths.StateDir()
	if err != nil {
		return err
	}
	logDir := filepath.Join(state, "panes")
	if err := paths.EnsurePrivateDir(logDir); err != nil {
		return err
	}
	logger := log.New(os.Stderr, "ravenryd: ", log.LstdFlags)
	mgr := pane.NewManager(pane.ManagerOptions{LogDir: logDir, Socket: sock, Env: cleanEnv()})
	var once sync.Once
	done := make(chan struct{})
	stop := func() { once.Do(func() { close(done) }) }
	srv := server.New(server.Options{Version: version, Manager: mgr, Socket: sock, Log: logger, OnDrained: stop})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
	go func() {
		select {
		case s := <-sig:
			logger.Printf("%v: closing every pane", s)
			stop()
		case <-done:
		}
	}()
	go srv.WatchForNewer(2 * time.Second)
	go func() {
		if err := srv.Serve(ln); err != nil {
			logger.Printf("serve: %v", err)
			stop()
		}
	}()
	logger.Printf("version %s, protocol %d, pid %d, socket %s", version, proto.Version, os.Getpid(), sock)
	<-done
	srv.Close()
	mgr.Shutdown(time.Second)
	// Remove the socket only if it is still ours.
	if fi, err := os.Lstat(sock); err == nil && fi.Mode()&os.ModeSocket != 0 {
		if c, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err != nil {
			os.Remove(sock)
		} else {
			c.Close()
		}
	}
	return nil
}

func cmdProxy(in []string) error {
	a, err := parse(in, map[string]flagKind{"version": valueFlag})
	if err != nil {
		return err
	}
	sock := pinned(a.g)
	if v := a.values["version"]; v != "" {
		if sock, err = paths.SocketPath(v); err != nil {
			return err
		}
	}
	if sock == "" {
		live := liveDaemons()
		switch {
		case len(live) > 0 && paths.CompareVersions(live[0].version, version) >= 0:
			sock = live[0].socket
		case a.g.noStart && len(live) > 0:
			sock = live[0].socket
		case a.g.noStart:
			return errors.New("no ravenryd is running (and --no-start was given)")
		default:
			if sock, err = startDaemon(); err != nil {
				return err
			}
		}
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return err
	}
	uc := conn.(*net.UnixConn)
	go func() {
		io.Copy(uc, os.Stdin)
		uc.CloseWrite()
	}()
	_, err = io.Copy(os.Stdout, uc)
	uc.Close()
	return err
}

func cmdVersion(in []string) error {
	a, err := parse(in, map[string]flagKind{})
	if err != nil {
		return err
	}
	if a.g.json {
		return printJSON(map[string]any{
			"version": version, "protocol": proto.Version, "os": runtime.GOOS, "arch": runtime.GOARCH,
			"libghostty_vt": vt.EngineVersion(), "go": runtime.Version(),
		})
	}
	fmt.Printf("ravenryd %s (protocol %d, libghostty-vt %s, %s/%s)\n", version, proto.Version, vt.EngineVersion(), runtime.GOOS, runtime.GOARCH)
	return nil
}

func cmdDaemons(in []string) error {
	a, err := parse(in, map[string]flagKind{})
	if err != nil {
		return err
	}
	type row struct {
		Version  string `json:"version"`
		Socket   string `json:"socket"`
		PID      int    `json:"pid"`
		Panes    int    `json:"panes"`
		Draining string `json:"draining,omitempty"`
	}
	rows := []row{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, d := range liveDaemons() {
		c, err := dial(ctx, d.socket)
		if err != nil {
			continue
		}
		var l proto.ListResult
		c.Call(ctx, "pane.list", map[string]any{"hidden": true}, &l)
		rows = append(rows, row{Version: c.Hello.Daemon.Version, Socket: d.socket, PID: c.Hello.Daemon.PID, Panes: len(l.Panes), Draining: c.Hello.Daemon.Draining})
		c.Close()
	}
	if a.g.json {
		return printJSON(rows)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "VERSION\tPID\tPANES\tSOCKET\tDRAINING")
	for _, r := range rows {
		fmt.Fprintf(w, "%s\t%d\t%d\t%s\t%s\n", r.Version, r.PID, r.Panes, r.Socket, r.Draining)
	}
	return w.Flush()
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// printJSONLine prints one JSON value on one line (for --follow).
func printJSONLine(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}
