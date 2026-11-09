package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"

	"ravenryd/internal/proto"
)

// A terminal for a test: the master side of the pty `ravenry attach` runs
// on, standing in for the Ghostty surface of the Mac app.
type testTerm struct {
	t   *testing.T
	cmd *exec.Cmd
	pty *os.File
	mu  sync.Mutex
	out bytes.Buffer
}

func (e *env) attach(t *testing.T, cols, rows uint16, args ...string) *testTerm {
	t.Helper()
	c := e.cmd("0.1.0", append([]string{"attach"}, args...)...)
	f, err := pty.StartWithSize(c, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		t.Fatal(err)
	}
	tt := &testTerm{t: t, cmd: c, pty: f}
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			tt.mu.Lock()
			tt.out.Write(buf[:n])
			tt.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		c.Process.Kill()
		c.Wait()
		f.Close()
	})
	return tt
}

func (tt *testTerm) waitFor(s string) {
	tt.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		tt.mu.Lock()
		ok := strings.Contains(tt.out.String(), s)
		tt.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	tt.mu.Lock()
	defer tt.mu.Unlock()
	tt.t.Fatalf("the terminal never showed %q; it shows %q", s, tt.out.String())
}

func (e *env) paneByLabel(t *testing.T, label string) proto.Pane {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ls := jsonOut[[]proto.Pane](t, e.ok("0.1.0", "ls", "--json", "--label", label))
		if len(ls) == 1 {
			return ls[0]
		}
		if time.Now().After(deadline) {
			t.Fatalf("panes with %s: %+v", label, ls)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAttach(t *testing.T) {
	e := newEnv(t)
	e.serve("0.1.0")

	// A new pane at the terminal's size; what is typed reaches it, what it
	// prints reaches the terminal.
	a := e.attach(t, 70, 20, "--new", "--label", "test=attach", "--close", "--", "/bin/sh")
	p := e.paneByLabel(t, "test=attach")
	if p.Cols != 70 || p.Rows != 20 {
		t.Fatalf("new pane is %dx%d, want 70x20", p.Cols, p.Rows)
	}
	a.pty.Write([]byte("echo hel''lo\r"))
	a.waitFor("hello")
	e.ok("0.1.0", "wait", p.ID, "--text", "hello", "--since", "0", "--timeout", "5s")

	// The terminal's answer to a query is dropped (the daemon answered it),
	// so the shell never reads it as typed text.
	a.pty.Write([]byte("\x1b[?62;22c\x1b]4;1;rgb:0000/0000/0000\x07echo after\r"))
	a.waitFor("after")
	cp := jsonOut[proto.CaptureResult](t, e.ok("0.1.0", "capture", p.ID, "--json"))
	for _, l := range cp.Lines {
		if strings.Contains(l.Text, "62;22") || strings.Contains(l.Text, "rgb:") {
			t.Fatalf("an answer reached the pane: %q", l.Text)
		}
	}

	// The terminal's size follows the window.
	pty.Setsize(a.pty, &pty.Winsize{Cols: 100, Rows: 30})
	deadline := time.Now().Add(5 * time.Second)
	for {
		p = e.paneByLabel(t, "test=attach")
		if p.Cols == 100 && p.Rows == 30 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pane is %dx%d after the resize, want 100x30", p.Cols, p.Rows)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A second terminal attaches to the same pane: the screen comes first.
	b := e.attach(t, 100, 30, p.ID)
	b.waitFor("hello")
	b.pty.Write([]byte("echo from-b\r"))
	a.waitFor("from-b")

	// The first terminal goes away: it started the pane with --close, so the
	// pane closes, and the second terminal's attach ends.
	a.cmd.Process.Signal(syscall.SIGHUP)
	done := make(chan error, 1)
	go func() { done <- b.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second attach: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the second attach did not end when the pane closed")
	}
	if ls := jsonOut[[]proto.Pane](t, e.ok("0.1.0", "ls", "--json", "--label", "test=attach")); len(ls) != 0 {
		t.Fatalf("the pane is still there: %+v", ls)
	}
}

func TestAttachUsage(t *testing.T) {
	e := newEnv(t)
	for _, args := range [][]string{{"attach"}, {"attach", "a", "b"}, {"attach", "p1", "--close"}} {
		if _, errs, code := e.run("0.1.0", args...); code == 0 || !strings.Contains(errs, "attach") {
			t.Fatalf("%v: exit %d, %q", args, code, errs)
		}
	}
}
