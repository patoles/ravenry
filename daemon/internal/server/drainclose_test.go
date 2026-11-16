package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// A daemon that goes after its last pane (drained for a newer version, or
// stopped) tells every client what happened to that pane first: the reply
// to the close, pane.exited and pane.closed, in that order, and only then
// closes the connections. It goes within its bound even when a client
// never reads.

// stopDaemon is what ravenryd serve does once it is drained or signalled.
func stopDaemon(srv *Server, _ *pane.Manager) {
	srv.Shutdown(time.Second)
}

type drainDaemon struct {
	srv     *Server
	mgr     *pane.Manager
	sock    string
	stopped chan struct{} // closed once stopDaemon returned
	took    time.Duration // how long stopDaemon took
}

func startDrainDaemon(t *testing.T, dir string, env []string, version string, drains bool) *drainDaemon {
	t.Helper()
	sock, err := paths.SocketPath(version)
	if err != nil {
		t.Fatal(err)
	}
	d := &drainDaemon{sock: sock, stopped: make(chan struct{})}
	d.mgr = pane.NewManager(pane.ManagerOptions{LogDir: dir, Socket: sock, Env: env})
	o := Options{Version: version, Manager: d.mgr, Socket: sock}
	if drains {
		o.OnDrained = func() { go d.stop() }
	}
	d.srv = New(o)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	go d.srv.Serve(ln)
	t.Cleanup(func() {
		select {
		case <-d.stopped:
		default:
			d.srv.Close()
			d.mgr.Shutdown(time.Second)
		}
	})
	if drains {
		// Often, to catch the old daemon at any moment of a close.
		go d.srv.WatchForNewer(2 * time.Millisecond)
	}
	return d
}

func (d *drainDaemon) stop() {
	start := time.Now()
	stopDaemon(d.srv, d.mgr)
	d.took = time.Since(start)
	close(d.stopped)
}

// collect reads a client's events until its connection ends.
func collect(t *testing.T, c *client.Client) []proto.Event {
	t.Helper()
	var evs []proto.Event
	timeout := time.After(15 * time.Second)
	for {
		select {
		case ev, ok := <-c.Events():
			if !ok {
				return evs
			}
			evs = append(evs, ev)
		case <-timeout:
			t.Fatalf("the connection did not end; events so far: %v", names(evs))
		}
	}
}

func names(evs []proto.Event) []string {
	var out []string
	for _, ev := range evs {
		n := ev.Event
		if ev.Pane != nil {
			n += " " + ev.Pane.ID
		}
		out = append(out, n)
	}
	return out
}

// muteClient says hello and subscribes to events, then never reads.
func muteClient(t *testing.T, sock string) {
	t.Helper()
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	ws, _, err := websocket.Dial(ctx(t), "ws://ravenryd"+proto.Path, &websocket.DialOptions{
		HTTPClient: hc, Subprotocols: []string{proto.Subprotocol}, CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	for _, m := range []map[string]any{
		{"v": proto.Version, "type": "hello", "id": 1, "client": map[string]any{"name": "mute"}},
		{"v": proto.Version, "type": "events.subscribe", "id": 2},
	} {
		b, _ := json.Marshal(m)
		if err := ws.Write(ctx(t), websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDrainedDaemonTellsTheLastPane(t *testing.T) {
	const ignoreHangup = `trap "" HUP TERM; exec cat`
	cases := []struct {
		name string
		// pane is the last pane's pane.new parameters.
		pane map[string]any
		// drain: a newer daemon starts, and the old one drains.
		drain bool
		// end makes the pane end; closeCall: through pane.close, whose
		// reply must come.
		end       func(t *testing.T, c *client.Client, d *drainDaemon, id string)
		closeCall bool
		slowReply bool
		mute      bool
	}{
		{name: "close, its program slow to end", drain: true, closeCall: true,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", ignoreHangup}}},
		{name: "close, the reply slow", drain: true, closeCall: true, slowReply: true,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}}},
		{name: "its program exits", drain: true,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", "read x"}},
			end: func(t *testing.T, c *client.Client, d *drainDaemon, id string) {
				call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": id, "input": []map[string]any{{"key": "Enter"}}})
			}},
		{name: "a hidden pane's ttl", drain: true,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", ignoreHangup}, "hidden": true, "ttl_ms": 300}},
		{name: "stopped with a pane running", drain: false,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}},
			end: func(t *testing.T, c *client.Client, d *drainDaemon, id string) {
				go d.stop()
			}},
		{name: "a client that never reads", drain: true, closeCall: true, mute: true,
			pane: map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "rv")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			t.Setenv("RAVENRY_RUNTIME_DIR", dir)
			env := []string{"PATH=/usr/bin:/bin", "HOME=" + dir}
			testenv.Check(t, append(env, "RAVENRY_RUNTIME_DIR="+dir, "RAVENRY_STATE_DIR="+dir))

			old := startDrainDaemon(t, dir, env, "0.1.0", tc.drain)
			var clients []*client.Client
			for _, name := range []string{"a", "b"} {
				c, err := client.Dial(ctx(t), old.sock, client.Options{Name: name, OnMessage: validator(t)})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { c.Close() })
				if err := c.SubscribeEvents(ctx(t)); err != nil {
					t.Fatal(err)
				}
				clients = append(clients, c)
			}
			if tc.mute {
				muteClient(t, old.sock)
			}
			a := clients[0]
			p := newPane(t, a, tc.pane)
			if tc.drain {
				startDrainDaemon(t, dir, env, "0.2.0", false)
				for _, c := range clients {
					waitEvent(t, c, "daemon.draining")
				}
			}
			if tc.slowReply {
				beforeCloseReply = func() { time.Sleep(300 * time.Millisecond) }
				t.Cleanup(func() { beforeCloseReply = nil })
			}
			if tc.end != nil {
				tc.end(t, a, old, p.ID)
			}
			if tc.closeCall {
				var res proto.CloseResult
				err := a.Call(ctx(t), "pane.close", map[string]any{"pane": p.ID, "grace_ms": 400}, &res)
				if err != nil {
					t.Errorf("pane.close got no reply: %v", err)
				} else if res.Pane.ID != p.ID {
					t.Errorf("pane.close replied for %q", res.Pane.ID)
				}
			}
			for i, c := range clients {
				evs := collect(t, c)
				exited, closed := -1, -1
				for j, ev := range evs {
					if ev.Pane == nil || ev.Pane.ID != p.ID {
						continue
					}
					switch ev.Event {
					case "pane.exited":
						exited = j
					case "pane.closed":
						closed = j
					}
				}
				who := []string{"a", "b"}[i]
				switch {
				case closed < 0:
					t.Errorf("client %s: no pane.closed before the connection ended: %s", who, strings.Join(names(evs), ", "))
				case exited < 0:
					t.Errorf("client %s: no pane.exited before the connection ended: %s", who, strings.Join(names(evs), ", "))
				case exited > closed:
					t.Errorf("client %s: pane.closed came before pane.exited: %s", who, strings.Join(names(evs), ", "))
				}
			}
			select {
			case <-old.stopped:
			case <-time.After(10 * time.Second):
				t.Fatal("the old daemon did not stop")
			}
			t.Logf("the old daemon stopped in %v", old.took.Round(time.Millisecond))
			if old.took > 4*time.Second {
				t.Errorf("stopping took %v", old.took)
			}
		})
	}
}

// waitEvent waits for a client's next event of that name.
func waitEvent(t *testing.T, c *client.Client, name string) proto.Event {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-c.Events():
			if !ok {
				t.Fatalf("the connection ended before %s", name)
			}
			if ev.Event == name {
				return ev
			}
		case <-timeout:
			t.Fatalf("no %s", name)
		}
	}
}
