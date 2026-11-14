package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// The tests build ravenryd twice, as two versions, and run them with a
// throwaway HOME, runtime and state directory, and /bin/sh as the shell.

var bins = map[string]string{}

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "rvbin")
	if err != nil {
		panic(err)
	}
	code := func() int {
		defer os.RemoveAll(dir)
		for _, v := range []string{"0.1.0", "0.2.0"} {
			out := filepath.Join(dir, "ravenryd-"+v)
			b, err := exec.Command("go", "build", "-ldflags", "-X main.version="+v, "-o", out, ".").CombinedOutput()
			if err != nil {
				fmt.Fprintf(os.Stderr, "build %s: %v\n%s", v, err, b)
				return 1
			}
			bins[v] = out
		}
		return m.Run()
	}()
	os.Exit(code)
}

type env struct {
	t    *testing.T
	dir  string
	vars []string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir, err := os.MkdirTemp("", "rv")
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "h")
	os.Mkdir(home, 0o700)
	e := &env{t: t, dir: dir, vars: []string{
		"HOME=" + home, "PATH=/usr/bin:/bin", "SHELL=/bin/sh", "LANG=en_US.UTF-8",
		"RAVENRY_RUNTIME_DIR=" + filepath.Join(dir, "run"), "RAVENRY_STATE_DIR=" + filepath.Join(dir, "state"),
	}}
	testenv.Check(t, e.vars)
	t.Cleanup(func() {
		// Stop every daemon this test started, then remove the files.
		ents, _ := os.ReadDir(filepath.Join(dir, "run"))
		for _, ent := range ents {
			out, _, _ := e.run("0.2.0", "daemons", "--json", "--no-start")
			var ds []struct {
				PID int `json:"pid"`
			}
			json.Unmarshal([]byte(out), &ds)
			for _, d := range ds {
				syscall.Kill(d.PID, syscall.SIGTERM)
			}
			_ = ent
			break
		}
		time.Sleep(200 * time.Millisecond)
		os.RemoveAll(dir)
	})
	return e
}

func (e *env) cmd(version string, args ...string) *exec.Cmd {
	c := exec.Command(bins[version], args...)
	c.Env = e.vars
	testenv.Check(e.t, c.Env)
	c.Dir = e.dir
	return c
}

func (e *env) run(version string, args ...string) (string, string, int) {
	var out, errb bytes.Buffer
	c := e.cmd(version, args...)
	c.Stdout, c.Stderr = &out, &errb
	err := c.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		e.t.Fatalf("run %v: %v", args, err)
	}
	return out.String(), errb.String(), code
}

func (e *env) ok(version string, args ...string) string {
	e.t.Helper()
	out, errs, code := e.run(version, args...)
	if code != 0 {
		e.t.Fatalf("ravenryd %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), code, out, errs)
	}
	return out
}

func jsonOut[T any](t *testing.T, s string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
	return v
}

// serve starts a daemon in the foreground of a child process.
func (e *env) serve(version string) *exec.Cmd {
	e.t.Helper()
	c := e.cmd(version, "serve")
	var logb bytes.Buffer
	c.Stderr = &logb
	if err := c.Start(); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() {
		c.Process.Signal(syscall.SIGTERM)
		c.Wait()
	})
	sock := filepath.Join(e.dir, "run", "ravenryd-"+version+".sock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if conn, err := net.Dial("unix", sock); err == nil {
			conn.Close()
			return c
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("serve %s did not answer; log:\n%s", version, logb.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCommands(t *testing.T) {
	e := newEnv(t)
	e.serve("0.1.0")

	// The socket and its directory are private.
	run := filepath.Join(e.dir, "run")
	if fi, _ := os.Stat(run); fi.Mode().Perm() != 0o700 {
		t.Fatalf("runtime dir mode %v", fi.Mode().Perm())
	}
	if fi, _ := os.Stat(filepath.Join(run, "ravenryd-0.1.0.sock")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v", fi.Mode().Perm())
	}

	v := jsonOut[map[string]any](t, e.ok("0.1.0", "version", "--json"))
	if v["version"] != "0.1.0" || v["protocol"] != float64(1) || !strings.HasPrefix(v["libghostty_vt"].(string), "0.") {
		t.Fatalf("version %v", v)
	}

	created := jsonOut[proto.PaneResult](t, e.ok("0.1.0", "new", "--json", "--size", "50x8", "--name", "cli", "--env", "GREETING=hi",
		"--", "/bin/sh", "-c", `printf '%s from %s\n' "$GREETING" "$RAVENRY_PANE"; exec cat`))
	id := created.Pane.ID
	if created.Pane.Cols != 50 || created.Pane.Name != "cli" {
		t.Fatalf("new %+v", created.Pane)
	}
	e.ok("0.1.0", "wait", id, "--text", "hi from "+id, "--since", "0", "--timeout", "5s")

	ls := jsonOut[[]map[string]any](t, e.ok("0.1.0", "ls", "--json"))
	if len(ls) != 1 || ls[0]["id"] != id || ls[0]["daemon"] != "0.1.0" {
		t.Fatalf("ls %v", ls)
	}
	if out := e.ok("0.1.0", "ls"); !strings.Contains(out, id) || !strings.Contains(out, "cli: /bin/sh") {
		t.Fatalf("ls table:\n%s", out)
	}

	mark := strings.TrimSpace(e.ok("0.1.0", "send", id, "--typed", "ab", "--delay", "1ms", "--raw", "cd", "--key", "Enter"))
	w := jsonOut[proto.WaitResult](t, e.ok("0.1.0", "wait", id, "--text", `abcd\n`, "--since", mark, "--json"))
	if w.Condition != "text" {
		t.Fatalf("wait %+v", w)
	}

	cp := jsonOut[proto.CaptureResult](t, e.ok("0.1.0", "capture", id, "--json", "--styles"))
	if cp.Lines[0].Text != "hi from "+id || cp.Cols != 50 {
		t.Fatalf("capture %+v", cp)
	}
	if out := e.ok("0.1.0", "capture", id); !strings.HasPrefix(out, "hi from "+id+"\nabcd\nabcd\n") {
		t.Fatalf("capture text %q", out)
	}
	if out := e.ok("0.1.0", "capture", id, "--vt"); !strings.HasPrefix(out, "\x1bc") {
		t.Fatalf("capture --vt %q", out)
	}

	if out := e.ok("0.1.0", "read", id, "--since", "0"); !strings.Contains(out, "hi from "+id) {
		t.Fatalf("read %q", out)
	}

	st := jsonOut[proto.SettleResult](t, e.ok("0.1.0", "settle", id, "--paste", "pasted\n", "--quiet", "150ms", "--json"))
	if st.Wait.Condition != "quiet" {
		t.Fatalf("settle %+v", st)
	}

	e.ok("0.1.0", "resize", id, "60x10")

	// clear: the prompt's row stays at the top, the rest and the history go.
	if c := jsonOut[proto.ClearResult](t, e.ok("0.1.0", "clear", id, "--json")); !c.Cleared || c.Pane.ID != id {
		t.Fatalf("clear %+v", c)
	}
	if cp := jsonOut[proto.CaptureResult](t, e.ok("0.1.0", "capture", id, "--history", "100", "--json")); cp.History != 0 || strings.Contains(cp.Lines[0].Text, "hi from") || cp.Cursor.Y != 0 {
		t.Fatalf("capture after clear %+v", cp)
	}

	// A wait that times out exits 124.
	if _, _, code := e.run("0.1.0", "wait", id, "--text", "never", "--timeout", "100ms"); code != 124 {
		t.Fatalf("timed-out wait exited %d", code)
	}
	// A hook command with no assistant says so and lets the session go on.
	if _, errs, code := e.run("0.1.0", "hook"); code != 0 || !strings.Contains(errs, "--assistant is required") {
		t.Fatalf("hook: %d %q", code, errs)
	}
	// Errors are reported with their code.
	if _, errs, code := e.run("0.1.0", "send", id, "--key", "Hyper+Q"); code != 1 || !strings.Contains(errs, "bad_request") {
		t.Fatalf("bad key: %d %q", code, errs)
	}

	cl := jsonOut[proto.CloseResult](t, e.ok("0.1.0", "close", id, "--json"))
	if cl.Pane.ID != id || cl.Signalled < 1 {
		t.Fatalf("close %+v", cl)
	}
	if _, errs, code := e.run("0.1.0", "capture", id); code != 1 || !strings.Contains(errs, "no running daemon has pane") {
		t.Fatalf("capture after close: %d %q", code, errs)
	}
}

func TestAutoStart(t *testing.T) {
	e := newEnv(t)
	if _, errs, code := e.run("0.1.0", "new", "--no-start", "--", "/bin/sleep", "30"); code != 1 || !strings.Contains(errs, "no ravenryd") {
		t.Fatalf("--no-start with no daemon: %d %q", code, errs)
	}
	id := strings.TrimSpace(e.ok("0.1.0", "new", "--", "/bin/sleep", "30"))
	ds := jsonOut[[]map[string]any](t, e.ok("0.1.0", "daemons", "--json"))
	if len(ds) != 1 || ds[0]["version"] != "0.1.0" || ds[0]["panes"] != float64(1) {
		t.Fatalf("daemons %v", ds)
	}
	// The detached daemon does not carry RAVENRY_PANE even when started from
	// inside a pane.
	e.vars = append(e.vars, "RAVENRY_PANE="+id)
	out := e.ok("0.1.0", "ls", "--json")
	if !strings.Contains(out, id) {
		t.Fatalf("ls %s", out)
	}
	if log, err := os.ReadFile(filepath.Join(e.dir, "state", "ravenryd-0.1.0.log")); err != nil || !strings.Contains(string(log), "protocol 1") {
		t.Fatalf("daemon log %v %q", err, log)
	}
}

// pipeConn is a net.Conn over a child process's standard input and output.
type pipeConn struct {
	io.Reader
	io.WriteCloser
}

func (pipeConn) LocalAddr() net.Addr                { return &net.UnixAddr{Name: "stdio", Net: "unix"} }
func (pipeConn) RemoteAddr() net.Addr               { return &net.UnixAddr{Name: "proxy", Net: "unix"} }
func (pipeConn) SetDeadline(t time.Time) error      { return nil }
func (pipeConn) SetReadDeadline(t time.Time) error  { return nil }
func (pipeConn) SetWriteDeadline(t time.Time) error { return nil }

// TestProxy speaks the protocol through `ravenryd proxy`, as a client does
// over `ssh host ravenryd proxy`.
func TestProxy(t *testing.T) {
	e := newEnv(t)
	e.serve("0.1.0")
	p := e.cmd("0.1.0", "proxy")
	stdin, _ := p.StdinPipe()
	stdout, _ := p.StdoutPipe()
	p.Stderr = os.Stderr
	if err := p.Start(); err != nil {
		t.Fatal(err)
	}
	defer p.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := client.DialWith(ctx, func(context.Context) (net.Conn, error) {
		return pipeConn{stdout, stdin}, nil
	}, client.Options{Name: "proxy-test"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Hello.Daemon.Version != "0.1.0" {
		t.Fatalf("hello %+v", c.Hello)
	}
	var r proto.PaneResult
	if err := c.Call(ctx, "pane.new", map[string]any{"command": []string{"/bin/sh", "-c", "echo over-the-proxy; exec cat"}}, &r); err != nil {
		t.Fatal(err)
	}
	var w proto.WaitResult
	if err := c.Call(ctx, "pane.wait", map[string]any{"pane": r.Pane.ID, "text": "over-the-proxy", "since": 0, "timeout_ms": 5000}, &w); err != nil || w.Condition != "text" {
		t.Fatalf("wait %v %+v", err, w)
	}
	st, err := c.Subscribe(ctx, r.Pane.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	f := <-st.Frames
	if !f.Snapshot || !bytes.Contains(f.Data, []byte("over-the-proxy")) {
		t.Fatalf("snapshot %q", f.Data)
	}
	st.Input(ctx, []byte("typed-through-proxy"))
	var got []byte
	for !bytes.Contains(got, []byte("typed-through-proxy")) {
		f = <-st.Frames
		got = append(got, f.Data...)
	}
	c.Close()
	stdin.Close()
}

// TestUpdateKeepsSessions starts a newer daemon beside an older one: the
// old one keeps its pane until the pane ends, new panes go to the new one,
// and the old one exits by itself when its last pane has ended.
func TestUpdateKeepsSessions(t *testing.T) {
	e := newEnv(t)
	old := e.serve("0.1.0")
	a := strings.TrimSpace(e.ok("0.1.0", "new", "--", "/bin/sh", "-c", "read x"))

	// The newer CLI starts its own daemon for new panes.
	b := strings.TrimSpace(e.ok("0.2.0", "new", "--", "/bin/sh", "-c", "read x"))
	ls := jsonOut[[]map[string]any](t, e.ok("0.2.0", "ls", "--json"))
	where := map[string]any{}
	for _, p := range ls {
		where[p["id"].(string)] = p["daemon"]
	}
	if where[a] != "0.1.0" || where[b] != "0.2.0" {
		t.Fatalf("panes by daemon: %v", where)
	}
	ds := jsonOut[[]map[string]any](t, e.ok("0.2.0", "daemons", "--json"))
	if len(ds) != 2 {
		t.Fatalf("daemons %v", ds)
	}

	// A command about pane a finds the old daemon.
	e.ok("0.2.0", "capture", a)
	time.Sleep(2500 * time.Millisecond) // the old daemon looks for newer ones every 2 s
	if old.ProcessState != nil {
		t.Fatal("the old daemon exited while its pane was running")
	}
	ds = jsonOut[[]map[string]any](t, e.ok("0.2.0", "daemons", "--json"))
	for _, d := range ds {
		if d["version"] == "0.1.0" && d["draining"] != "0.2.0" {
			t.Fatalf("old daemon not draining: %v", d)
		}
	}

	// End pane a: the old daemon exits and removes its socket.
	e.ok("0.2.0", "send", a, "--key", "Enter")
	done := make(chan error, 1)
	go func() { done <- old.Wait() }()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("the old daemon did not exit after its last pane ended")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "run", "ravenryd-0.1.0.sock")); !os.IsNotExist(err) {
		t.Fatalf("old socket left behind: %v", err)
	}
	// Pane b lives on in the new daemon.
	ls = jsonOut[[]map[string]any](t, e.ok("0.2.0", "ls", "--json"))
	if len(ls) != 1 || ls[0]["id"] != b || ls[0]["state"] != "running" {
		t.Fatalf("after the update: %v", ls)
	}
}

// A daemon started from inside another program's session (a Claude Code
// shell, a cmux tab, iTerm2, tmux) hands none of that session to its panes:
// on 2026-11-07 a Claude resumed in a pane saw CLAUDE_CODE_CHILD_SESSION
// and saved no transcript. A pane has the account's variables, the
// terminal's own and what its client asked for, nothing else.
func TestPaneEnvironmentIsCleanWhoeverStartedTheDaemon(t *testing.T) {
	e := newEnv(t)
	e.vars = append(e.vars,
		"CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CODE_SSE_PORT=5555",
		"CMUX_SURFACE_ID=E0F8", "CMUX_SOCKET_PATH=/tmp/cmux.sock", "ITERM_SESSION_ID=w0t0p0:x", "TERM_SESSION_ID=abc",
		"TERM_PROGRAM=iTerm.app", "TERM_PROGRAM_VERSION=3.5", "TMUX=/tmp/t,1,0", "OTEL_EXPORTER_OTLP_ENDPOINT=http://x",
		"CODEX_SANDBOX=seatbelt", "REX_BLOCK=block:y", "NODE_OPTIONS=--inspect", "STARTER_ONLY=1")
	id := strings.TrimSpace(e.ok("0.2.0", "new", "--env", "ASKED=yes", "--", "/bin/sh", "-c", `env | sort; echo END-OF-ENV; exec cat`))
	e.ok("0.2.0", "wait", id, "--text", "END-OF-ENV", "--since", "0", "--timeout", "5s")
	got := map[string]string{}
	for _, l := range strings.Split(e.ok("0.2.0", "read", id, "--since", "0"), "\n") {
		if k, v, ok := strings.Cut(strings.TrimRight(l, "\r"), "="); ok {
			got[k] = v
		}
	}
	for k := range got {
		if strings.HasPrefix(k, "CLAUDE") || strings.HasPrefix(k, "CMUX_") || strings.HasPrefix(k, "ITERM_") || strings.HasPrefix(k, "TMUX") ||
			strings.HasSuffix(k, "_SESSION_ID") || strings.HasPrefix(k, "CODEX_") || strings.HasPrefix(k, "REX_") || strings.HasPrefix(k, "OTEL_") ||
			k == "NODE_OPTIONS" || k == "STARTER_ONLY" || k == "TERM_PROGRAM_VERSION" {
			t.Errorf("%s=%s reached the pane", k, got[k])
		}
	}
	for _, k := range []string{"PATH", "HOME", "LANG", "SHELL"} {
		if got[k] == "" {
			t.Errorf("%s is missing from the pane", k)
		}
	}
	if got["TERM_PROGRAM"] != "ravenry" || got["RAVENRY_PANE"] != id || got["ASKED"] != "yes" || got["RAVENRY_SOCKET"] == "" {
		t.Errorf("pane env %v", got)
	}
}

// The guide says how to run it: as ravenry when that is this program, else
// by its quoted path (another ravenry on the PATH, or none).
func TestSkillRunIt(t *testing.T) {
	if s := runIt("/x/bin/ravenry", "/x/bin/ravenry", true); !strings.Contains(s, "run as written") || strings.Contains(s, "R=") {
		t.Errorf("same: %q", s)
	}
	s := runIt("/Users/someone/Library/Application Support/Ravenry/bin/ravenry", "/usr/local/bin/ravenry", false)
	for _, w := range []string{"another program (/usr/local/bin/ravenry)", `R="/Users/someone/Library/Application Support/Ravenry/bin/ravenry"`, `"$R" new`} {
		if !strings.Contains(s, w) {
			t.Errorf("other: no %q in %q", w, s)
		}
	}
	if s := runIt("/x/ravenryd", "", false); !strings.Contains(s, "no `ravenry` on your PATH") {
		t.Errorf("none: %q", s)
	}
}

// The guide says what Ravenry does, one line per area of FEATURES.md
// section 2 (tools/features-check.mjs checks the same against this
// source), and where an agent is: only this Mac's panes, another machine's
// over ssh.
func TestSkillWhatRavenryDoes(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "FEATURES.md"))
	if err != nil {
		t.Skip("no docs/FEATURES.md beside the daemon")
	}
	sec := strings.SplitN(string(doc), "\n## 2.", 2)[1]
	sec = strings.SplitN(sec, "\n## 3.", 2)[0]
	s := skillText()
	does := strings.SplitN(strings.SplitN(s, "## What Ravenry does", 2)[1], "\n## ", 2)[0]
	n := 0
	for _, l := range strings.Split(sec, "\n") {
		if a, ok := strings.CutPrefix(l, "### "); ok {
			n++
			if !strings.Contains(does, "- **"+strings.TrimSpace(a)+"**") {
				t.Errorf("What Ravenry does has no line for %q", a)
			}
		}
	}
	if n < 10 {
		t.Fatalf("only %d areas read from FEATURES.md", n)
	}
	for _, w := range []string{"Your commands reach only this Mac's panes", "ssh studio '~/.ravenry/bin/ravenry ls'", "Remote Login on", "no Tailscale", "Pair your phone", "Away from this Mac's Wi-Fi"} {
		if !strings.Contains(s, w) {
			t.Errorf("the guide misses %q", w)
		}
	}
}
