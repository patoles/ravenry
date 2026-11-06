package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/paths"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
	"ravenryd/internal/testprog"
)

// ------------------------------------------------------------ the schema

const schemaPath = "../../../packages/protocol/schema/v1.json"

var (
	schemaOnce sync.Once
	schemaErr  error
	defs       map[string]*jsonschema.Schema
	clientMsg  *jsonschema.Schema
	daemonMsg  *jsonschema.Schema

	seenMu sync.Mutex
	seen   = map[string]bool{}
)

func loadSchema() error {
	schemaOnce.Do(func() {
		f, err := os.Open(schemaPath)
		if err != nil {
			schemaErr = err
			return
		}
		defer f.Close()
		doc, err := jsonschema.UnmarshalJSON(f)
		if err != nil {
			schemaErr = err
			return
		}
		c := jsonschema.NewCompiler()
		c.AssertFormat()
		const id = "urn:ravenry:protocol:v1"
		if err := c.AddResource(id, doc); err != nil {
			schemaErr = err
			return
		}
		defs = map[string]*jsonschema.Schema{}
		for name := range doc.(map[string]any)["$defs"].(map[string]any) {
			s, err := c.Compile(id + "#/$defs/" + strings.ReplaceAll(name, "/", "~1"))
			if err != nil {
				schemaErr = fmt.Errorf("compile %s: %w", name, err)
				return
			}
			defs[name] = s
		}
		clientMsg, daemonMsg = defs["ClientMessage"], defs["DaemonMessage"]
	})
	return schemaErr
}

// messageDef names the schema definition a message belongs to.
func messageDef(dir string, m map[string]any) string {
	typ, _ := m["type"].(string)
	switch {
	case dir == "send" && typ == "ack":
		return "ack"
	case dir == "send":
		return "request." + typ
	case typ == "result":
		meth, _ := m["method"].(string)
		return "result." + meth
	case typ == "event":
		ev, _ := m["event"].(string)
		return "event." + ev
	}
	return typ
}

// sendingInvalid is set while a test sends requests that are invalid on
// purpose, to check that the daemon refuses them.
var sendingInvalid atomic.Bool

// validator checks every JSON message against the schema. Messages the
// test sends on purpose to be refused are marked with "x-invalid", or sent
// while sendingInvalid is set.
func validator(t *testing.T) func(dir string, text bool, data []byte) {
	return func(dir string, text bool, data []byte) {
		if dir == "send" && sendingInvalid.Load() {
			return
		}
		if !text {
			if len(data) < proto.FrameHeader || data[0] != proto.Version {
				t.Errorf("%s: bad binary frame header % x", dir, data[:min(len(data), proto.FrameHeader)])
			}
			return
		}
		if bytes.Contains(data, []byte(`"x-invalid"`)) {
			return
		}
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			t.Errorf("%s: not JSON: %s", dir, data)
			return
		}
		top := daemonMsg
		if dir == "send" {
			top = clientMsg
		}
		m, _ := inst.(map[string]any)
		name := messageDef(dir, m)
		def := defs[name]
		if def == nil {
			t.Errorf("%s: no schema definition %q for %s", dir, name, data)
			return
		}
		if err := def.Validate(inst); err != nil {
			t.Errorf("%s: %s does not match %s:\n%v", dir, data, name, err)
			return
		}
		if err := top.Validate(inst); err != nil {
			t.Errorf("%s: %s does not match the message union:\n%v", dir, data, err)
			return
		}
		seenMu.Lock()
		seen[name] = true
		seenMu.Unlock()
	}
}

func TestMain(m *testing.M) {
	testprog.Run()
	if err := loadSchema(); err != nil {
		fmt.Fprintln(os.Stderr, "schema:", err)
		os.Exit(1)
	}
	code := m.Run()
	// Only a full run can see every message type.
	full := flag.Lookup("test.run").Value.String() == "" && flag.Lookup("test.skip").Value.String() == ""
	if code == 0 && full && !testing.Short() {
		var missing []string
		for name := range defs {
			if strings.HasPrefix(name, "request.") || strings.HasPrefix(name, "result.") || strings.HasPrefix(name, "event.") || name == "ack" || name == "error" {
				if !seen[name] {
					missing = append(missing, name)
				}
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "FAIL: these messages of the schema never went over the wire in the tests: %v\n", missing)
			code = 1
		} else {
			fmt.Printf("schema: all %d message types seen and valid\n", len(seen))
		}
	}
	os.Exit(code)
}

// ------------------------------------------------------------ the daemon

type daemon struct {
	t      *testing.T
	mgr    *pane.Manager
	srv    *Server
	socket string
	home   string
	dir    string
	log    *lockedBuffer
}

// lockedBuffer holds what the daemon logs.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func startDaemon(t *testing.T, opts ...func(*pane.ManagerOptions)) *daemon {
	t.Helper()
	dir, err := os.MkdirTemp("", "rv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	home := filepath.Join(dir, "home")
	os.Mkdir(home, 0o700)
	sock := filepath.Join(dir, "d.sock")
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + home, "LANG=en_US.UTF-8"}
	testenv.Check(t, env)
	testenv.CheckDirs(t, dir)
	mo := pane.ManagerOptions{LogDir: dir, Socket: sock, Env: env}
	for _, o := range opts {
		o(&mo)
	}
	mgr := pane.NewManager(mo)
	lb := &lockedBuffer{}
	srv := New(Options{Version: "0.0.0-test", Manager: mgr, Socket: sock, Log: log.New(lb, "", 0)})
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	t.Cleanup(func() {
		srv.Close()
		mgr.Shutdown(time.Second)
	})
	return &daemon{t: t, mgr: mgr, srv: srv, socket: sock, home: home, dir: dir, log: lb}
}

func (d *daemon) dial(o client.Options) *client.Client {
	d.t.Helper()
	check := validator(d.t)
	if tap := o.OnMessage; tap != nil {
		o.OnMessage = func(dir string, text bool, data []byte) { check(dir, text, data); tap(dir, text, data) }
	} else {
		o.OnMessage = check
	}
	if o.Name == "" {
		o.Name = "test"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, d.socket, o)
	if err != nil {
		d.t.Fatal(err)
	}
	d.t.Cleanup(func() { c.Close() })
	return c
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return c
}

func call[T any](t *testing.T, c *client.Client, method string, params any) T {
	t.Helper()
	var out T
	if err := c.Call(ctx(t), method, params, &out); err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return out
}

func callErr(t *testing.T, c *client.Client, method string, params any) *client.Error {
	t.Helper()
	err := c.Call(ctx(t), method, params, nil)
	var e *client.Error
	if !errors.As(err, &e) {
		t.Fatalf("%s: want a protocol error, got %v", method, err)
	}
	return e
}

func newPane(t *testing.T, c *client.Client, params map[string]any) proto.Pane {
	t.Helper()
	return call[proto.PaneResult](t, c, "pane.new", params).Pane
}

func waitFor(t *testing.T, c *client.Client, id, re string, since uint64) proto.WaitResult {
	t.Helper()
	w := call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": id, "text": re, "since": since, "timeout_ms": 10000})
	if w.Condition != "text" {
		t.Fatalf("waiting for %q: %s; output %q", re, w.Condition, w.Output)
	}
	return w
}

// ------------------------------------------------------------ tests

func TestHelloComesFirst(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{SkipHello: true})
	if e := callErr(t, c, "pane.list", nil); e.Code != proto.CodeHelloRequired {
		t.Fatalf("code %s", e.Code)
	}
	h := call[proto.HelloResult](t, c, "hello", map[string]any{"client": map[string]any{"name": "t", "version": "1"}})
	if h.Protocol != 1 || h.Daemon.Version != "0.0.0-test" || h.Daemon.PID != os.Getpid() || len(h.Methods) != len(proto.Methods) {
		t.Fatalf("hello %+v", h)
	}
	// The home folder clients say this machine's folders against with ~.
	if want, _ := os.UserHomeDir(); h.Daemon.Home == "" || h.Daemon.Home != want {
		t.Fatalf("hello's home %q, want %q", h.Daemon.Home, want)
	}
	if e := callErr(t, c, "hello", map[string]any{"client": map[string]any{"name": "t"}}); e.Code != proto.CodeBadRequest {
		t.Fatalf("second hello: %s", e.Code)
	}
}

func TestPaneLifecycle(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	if err := c.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	p := newPane(t, c, map[string]any{
		"command": []string{"/bin/sh", "-c", `printf '\033]2;my title\007'; printf 'id=%s \033[1;31mred\033[0m \033[2mdim\033[0m\n' "$RAVENRY_PANE"; exec cat`},
		"cwd":     cwd, "env": map[string]string{"FOO": "bar"}, "cols": 60, "rows": 8, "name": "lifecycle",
	})
	if p.State != "running" || p.Cols != 60 || p.Name != "lifecycle" || p.Cwd != cwd {
		t.Fatalf("new %+v", p)
	}
	waitFor(t, c, p.ID, `id=`+p.ID, 0)

	list := call[proto.ListResult](t, c, "pane.list", map[string]any{})
	if len(list.Panes) != 1 || list.Panes[0].ID != p.ID || list.Panes[0].Title != "my title" {
		t.Fatalf("list %+v", list)
	}

	cp := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "styles": true, "vt": true, "history": 10})
	if cp.Lines[0].Text != "id="+p.ID+" red dim" || cp.Title != "my title" || cp.Cursor.Y != 1 || cp.VT == "" {
		t.Fatalf("capture %+v", cp)
	}
	sp := cp.Lines[0].Spans
	if len(sp) != 2 || !sp[0].Bold || sp[0].Text != "red" || sp[0].Fg != float64(1) || !sp[1].Dim {
		t.Fatalf("spans %+v", sp)
	}

	s := call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{
		{"text": "typed ", "mode": "typed", "delay_ms": 1}, {"text": "raw", "mode": "raw"}, {"key": "Enter"},
	}})
	waitFor(t, c, p.ID, `typed raw\n`, s.Mark)

	rd := call[proto.ReadResult](t, c, "pane.read", map[string]any{"pane": p.ID, "since": 0})
	if rd.Text == nil || !strings.Contains(*rd.Text, "typed raw") || rd.From != 0 || rd.Truncated {
		t.Fatalf("read %+v", rd)
	}
	raw := call[proto.ReadResult](t, c, "pane.read", map[string]any{"pane": p.ID, "since": 0, "limit": 64, "format": "raw"})
	b, _ := base64.StdEncoding.DecodeString(*raw.Data)
	if len(b) != 64 || !bytes.Contains(b, []byte("\x1b]2;my title")) {
		t.Fatalf("raw read %q", b)
	}

	st := call[proto.SettleResult](t, c, "pane.settle", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "settled\n", "mode": "paste"}}, "quiet_ms": 150})
	if st.Wait.Condition != "quiet" || len(st.Wait.Changes) == 0 {
		t.Fatalf("settle %+v", st)
	}

	rz := call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": 70, "rows": 9})
	if rz.Pane.Cols != 70 || rz.Pane.Rows != 9 {
		t.Fatalf("resize %+v", rz)
	}

	// A stream: a snapshot, then input through a binary frame, then its echo.
	stream, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{Ack: true})
	if err != nil {
		t.Fatal(err)
	}
	f := <-stream.Frames
	if !f.Snapshot || !bytes.Contains(f.Data, []byte("settled")) {
		t.Fatalf("first frame %+v", f)
	}
	stream.Ack(ctx(t), len(f.Data))
	stream.Input(ctx(t), []byte("via-frame"))
	got := ""
	for !strings.Contains(got, "via-frame") {
		f = <-stream.Frames
		if f.Snapshot {
			t.Fatal("unexpected snapshot")
		}
		got += string(f.Data)
		stream.Ack(ctx(t), len(f.Data))
	}
	if err := stream.Close(ctx(t)); err != nil {
		t.Fatal(err)
	}
	if e := callErr(t, c, "pane.unsubscribe", map[string]any{"channel": stream.Channel}); e.Code != proto.CodeNotFound {
		t.Fatalf("unsubscribe twice: %s", e.Code)
	}

	// A second stream that sees the pane end.
	stream2, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	closed := call[proto.CloseResult](t, c, "pane.close", map[string]any{"pane": p.ID, "grace_ms": 500})
	if closed.Pane.ID != p.ID || closed.Signalled < 1 || closed.Pane.State != "exited" {
		t.Fatalf("close %+v", closed)
	}
	for range stream2.Frames {
	}
	if stream2.End == nil {
		t.Fatal("no stream.end")
	}
	if e := callErr(t, c, "pane.capture", map[string]any{"pane": p.ID}); e.Code != proto.CodeNotFound {
		t.Fatalf("capture after close: %s", e.Code)
	}

	want := map[string]bool{"pane.created": false, "pane.title": false, "pane.exited": false, "pane.closed": false}
	deadline := time.After(5 * time.Second)
	for !(want["pane.created"] && want["pane.title"] && want["pane.exited"] && want["pane.closed"]) {
		select {
		case ev := <-c.Events():
			if ev.Pane != nil && ev.Pane.ID == p.ID {
				want[ev.Event] = true
			}
		case <-deadline:
			t.Fatalf("events seen: %v", want)
		}
	}
}

func TestWaitConditionsAndCancel(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "echo start; sleep 0.4; exit 7"}})
	w := call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "exit": true, "since": 0})
	if w.Condition != "exit" || w.Exit == nil || w.Exit.Code != 7 || !strings.Contains(w.Output, "start") {
		t.Fatalf("exit wait %+v", w)
	}
	w = call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "quiet_ms": 50})
	if w.Condition != "quiet" {
		t.Fatalf("quiet wait %+v", w)
	}
	w = call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "text": "never", "timeout_ms": 100})
	if w.Condition != "timeout" {
		t.Fatalf("timeout wait %+v", w)
	}
	w = call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "text": "(?m)^start$", "screen": true, "timeout_ms": 1000})
	if w.Condition != "text" || w.Match == nil || *w.Match != "start" {
		t.Fatalf("screen wait %+v", w)
	}

	// A long wait, cancelled from the same connection.
	p2 := newPane(t, c, map[string]any{"command": []string{"/bin/sleep", "30"}})
	cctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		errc <- c.Call(cctx, "pane.wait", map[string]any{"pane": p2.ID, "text": "never", "timeout_ms": 60000}, nil)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel() // the client sends cancel for it
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait: %v", err)
	}
	// And an explicit cancel through the protocol.
	done := make(chan *client.Error, 1)
	go func() {
		err := c.Call(context.Background(), "pane.wait", map[string]any{"pane": p2.ID, "text": "never"}, nil)
		var e *client.Error
		errors.As(err, &e)
		done <- e
	}()
	time.Sleep(100 * time.Millisecond)
	// The wait above is request id N; find it by asking to cancel ids
	// until one is running.
	cancelled := false
	for id := uint64(1); id < 200 && !cancelled; id++ {
		if c.Call(ctx(t), "cancel", map[string]any{"request": id}, nil) == nil {
			cancelled = true
		}
	}
	if !cancelled {
		t.Fatal("no running request found to cancel")
	}
	if e := <-done; e == nil || e.Code != proto.CodeCancelled {
		t.Fatalf("cancelled wait answered %v", e)
	}
}

func TestHiddenTTLPane(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sleep", "30"}, "hidden": true, "ttl_ms": 300, "scrollback": 100})
	if !p.Hidden || p.TTLMs != 300 {
		t.Fatalf("new %+v", p)
	}
	if l := call[proto.ListResult](t, c, "pane.list", map[string]any{}); len(l.Panes) != 0 {
		t.Fatalf("hidden pane listed: %+v", l)
	}
	if l := call[proto.ListResult](t, c, "pane.list", map[string]any{"hidden": true}); len(l.Panes) != 1 {
		t.Fatalf("hidden pane missing: %+v", l)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		l := call[proto.ListResult](t, c, "pane.list", map[string]any{"hidden": true})
		if len(l.Panes) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ttl did not close the pane")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestBadRequests(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}})
	cases := []struct {
		method string
		params map[string]any
		code   string
	}{
		{"pane.nope", nil, proto.CodeUnknownMethod},
		{"pane.capture", map[string]any{"pane": "pzzzzzzz"}, proto.CodeNotFound},
		{"pane.capture", map[string]any{}, proto.CodeBadRequest},
		{"pane.capture", map[string]any{"pane": p.ID, "x-invalid": 1}, proto.CodeBadRequest},
		{"pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "a"}}, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "a", "mode": "shout"}}, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "a", "mode": "raw", "key": "Enter"}}, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Hyper+Q"}}}, proto.CodeBadRequest},
		{"pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{}, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.wait", map[string]any{"pane": p.ID, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.wait", map[string]any{"pane": p.ID, "text": "(", "timeout_ms": 10}, proto.CodeBadRequest},
		{"pane.new", map[string]any{"ttl_ms": 100, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.new", map[string]any{"cols": 10, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.new", map[string]any{"command": []string{"/no/such/program"}}, proto.CodeFailed},
		{"pane.new", map[string]any{"command": []string{"no-such-program-anywhere"}}, proto.CodeFailed},
		{"pane.new", map[string]any{"cwd": "/no/such/dir"}, proto.CodeFailed},
		{"pane.read", map[string]any{"pane": p.ID, "x-invalid": 0}, proto.CodeBadRequest},
		{"pane.read", map[string]any{"pane": p.ID, "since": 1 << 40}, proto.CodeBadRequest},
		{"pane.subscribe", map[string]any{"pane": p.ID, "window": 10, "x-invalid": 0}, proto.CodeBadRequest},
		{"cancel", map[string]any{"request": 999999}, proto.CodeNotFound},
	}
	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	for _, tc := range cases {
		e := callErr(t, c, tc.method, tc.params)
		if e.Code != tc.code {
			t.Errorf("%s %v: code %s (%s), want %s", tc.method, tc.params, e.Code, e.Message, tc.code)
		}
	}
	// A message of another protocol version, and a binary frame for a
	// channel this connection does not have: errors without an id.
	c.WriteRaw(ctx(t), []byte(`{"v":2,"type":"pane.list","id":5000}`))
	c.WriteBinary(ctx(t), proto.AppendFrame(nil, proto.FrameInput, 77, 0))
	sendingInvalid.Store(false)
	// The connection still works.
	call[proto.ListResult](t, c, "pane.list", map[string]any{})
}

// ------------------------------------------------------------ latency and throughput

// TestEchoLatency measures a keystroke's echo through the daemon, end to
// end: the client sends one byte in a binary input frame, the daemon
// writes it to the pty, the kernel's tty echoes it, the daemon reads it,
// parses it and sends it in an output frame, and the client receives it.
func TestEchoLatency(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}})
	st, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{Ack: true})
	if err != nil {
		t.Fatal(err)
	}
	f := <-st.Frames
	st.Ack(ctx(t), len(f.Data))
	const n = 300
	samples := make([]time.Duration, 0, n)
	lone := 0
	for i := 0; i < n+20; i++ {
		key := []byte{byte('a' + i%26)}
		start := time.Now()
		if err := st.Input(ctx(t), key); err != nil {
			t.Fatal(err)
		}
		var got []byte
		frames := 0
		for !bytes.Contains(got, key) {
			select {
			case f = <-st.Frames:
			case <-time.After(5 * time.Second):
				t.Fatalf("no echo for %q", key)
			}
			frames++
			got = append(got, f.Data...)
			st.Ack(ctx(t), len(f.Data))
		}
		el := time.Since(start)
		if i >= 20 { // warm-up
			samples = append(samples, el)
			if frames == 1 && bytes.Equal(got, key) {
				lone++
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	q := func(f float64) time.Duration { return samples[int(f*float64(len(samples)-1))] }
	msg := fmt.Sprintf("echo latency through the daemon (%d keystrokes): median %v, p95 %v, p99 %v, max %v; %d of %d echoes came alone in their own frame",
		len(samples), q(0.5).Round(time.Microsecond), q(0.95).Round(time.Microsecond), q(0.99).Round(time.Microsecond),
		samples[len(samples)-1].Round(time.Microsecond), lone, len(samples))
	t.Log(msg)
	fmt.Println("MEASURE " + msg)
	if q(0.5) > 5*time.Millisecond {
		t.Errorf("median echo %v: a keystroke is being held back", q(0.5))
	}
	if lone < len(samples)*9/10 {
		t.Errorf("only %d of %d echoes were sent at once in their own frame", lone, len(samples))
	}
}

// TestBulkThroughput sends 100 MiB through a pane to a client that
// acknowledges what it processes, as the desktop app does: once a client
// that keeps up at once, and once a client that processes at the speed
// xterm.js parsed in the performance gate (52 MB/s), where output gathers
// into large frames while the client is busy.
func TestBulkThroughput(t *testing.T) {
	if testing.Short() {
		t.Skip("100 MiB")
	}
	d := startDaemon(t)
	c := d.dial(client.Options{})
	file := filepath.Join(d.home, "big.txt")
	line := []byte("0123456789 the quick brown fox jumps over the lazy dog 0123456789 ABCDEFGHIJ\n")
	var buf bytes.Buffer
	for buf.Len() < 1<<20 {
		buf.Write(line)
	}
	chunk := buf.Bytes()[:1<<20]
	fh, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		fh.Write(chunk)
	}
	fh.Close()

	for _, rate := range []float64{0, 52e6} {
		p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "read go; cat " + file + "; echo __END__; read x"}, "cols": 165, "rows": 49})
		st, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{Ack: true})
		if err != nil {
			t.Fatal(err)
		}
		f := <-st.Frames
		st.Ack(ctx(t), len(f.Data))
		pp, _ := d.mgr.Get(p.ID)
		readsBefore := pp.Reads()
		start := time.Now()
		call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Enter"}}})
		var total int64
		frames, snapshots, biggest := 0, 0, 0
		tail := []byte{}
		timeout := time.After(60 * time.Second)
		for !bytes.Contains(tail, []byte("__END__")) {
			select {
			case f = <-st.Frames:
			case <-timeout:
				t.Fatalf("no end after %d bytes", total)
			}
			frames++
			if f.Snapshot {
				snapshots++
			}
			biggest = max(biggest, len(f.Data))
			total += int64(len(f.Data))
			tail = append(tail, f.Data...)
			if len(tail) > 64 {
				tail = append(tail[:0], tail[len(tail)-64:]...)
			}
			if rate > 0 {
				time.Sleep(time.Duration(float64(len(f.Data)) / rate * float64(time.Second)))
			}
			st.Ack(ctx(t), len(f.Data))
		}
		el := time.Since(start)
		reads := pp.Reads() - readsBefore
		who := "a client that keeps up at once"
		if rate > 0 {
			who = fmt.Sprintf("a client processing at %.0f MB/s", rate/1e6)
		}
		msg := fmt.Sprintf("bulk: 100 MiB through the daemon to %s: %v (%.0f MB/s); %d frames for %d pty reads (largest %d KiB), %d snapshot resyncs, %d bytes",
			who, el.Round(time.Millisecond), float64(100<<20)/1e6/el.Seconds(), frames, reads, biggest>>10, snapshots, total)
		t.Log(msg)
		fmt.Println("MEASURE " + msg)
		if snapshots == 0 && total < 100<<20 {
			t.Errorf("only %d bytes arrived", total)
		}
		st.Close(ctx(t))
		call[proto.CloseResult](t, c, "pane.close", map[string]any{"pane": p.ID})
	}
}

// TestNewerDaemonDrainsTheOld runs two daemon versions in one runtime
// directory, as an update does: the old one tells its clients a newer one
// runs, keeps its pane until the pane ends, then reports it is drained.
func TestNewerDaemonDrainsTheOld(t *testing.T) {
	dir, err := os.MkdirTemp("", "rv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv("RAVENRY_RUNTIME_DIR", dir)
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + dir}
	testenv.Check(t, append(env, "RAVENRY_RUNTIME_DIR="+dir, "RAVENRY_STATE_DIR="+dir))
	start := func(version string, onDrained func()) (*Server, string) {
		sock, err := paths.SocketPath(version)
		if err != nil {
			t.Fatal(err)
		}
		mgr := pane.NewManager(pane.ManagerOptions{LogDir: dir, Socket: sock, Env: env})
		srv := New(Options{Version: version, Manager: mgr, Socket: sock, OnDrained: onDrained})
		ln, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close(); mgr.Shutdown(time.Second) })
		return srv, sock
	}
	drained := make(chan struct{})
	old, oldSock := start("0.1.0", func() { close(drained) })
	go old.WatchForNewer(50 * time.Millisecond)

	c, err := client.Dial(ctx(t), oldSock, client.Options{Name: "test", OnMessage: validator(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SubscribeEvents(ctx(t))
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "read x"}})

	start("0.2.0", nil)
	select {
	case ev := <-c.Events():
		for ev.Event != "daemon.draining" {
			ev = <-c.Events()
		}
		if ev.Newer != "0.2.0" {
			t.Fatalf("draining for %q", ev.Newer)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no daemon.draining event")
	}
	var h proto.HelloResult
	c2, err := client.Dial(ctx(t), oldSock, client.Options{Name: "test2", OnMessage: validator(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	h = c2.Hello
	if h.Daemon.Draining != "0.2.0" {
		t.Fatalf("hello on the old daemon: %+v", h.Daemon)
	}
	// The pane still runs, so the old daemon stays.
	select {
	case <-drained:
		t.Fatal("drained while a pane was running")
	case <-time.After(300 * time.Millisecond):
	}
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Enter"}}})
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("the old daemon did not drain after its last pane ended")
	}
}
