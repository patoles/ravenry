package pane

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"ravenryd/internal/testprog"
)

// The scope is a runtime directory of this test's own, so panes of a
// Ravenry that runs these tests (a real one) do not count.
func TestOriginOf(t *testing.T) {
	dir := t.TempDir()
	if o := OriginOf(os.Getpid(), Scope{Dir: dir}); !o.Known || o.Pane || !o.Person() && !o.SSH {
		t.Fatalf("the test process: %+v (%s)", o, o.Why())
	}
	if o := OriginOf(os.Getpid(), Scope{Dir: dir, Roots: map[int]string{os.Getppid(): "pfake"}}); !o.Pane || o.PaneID != "pfake" || o.Person() {
		t.Fatalf("a child of a pane's first process: %+v", o)
	}
	if o := OriginOf(1<<22+12345, Scope{Dir: dir}); o.Known || o.Person() {
		t.Fatalf("no such process: %+v", o)
	}
	// The environment a process started with (this test binary's, which
	// macOS shows; it hides that of its own programs).
	for _, tc := range []struct {
		env       []string
		pane, ssh bool
		paneID    string
		desc      string
	}{
		{[]string{"RAVENRY_SOCKET=" + filepath.Join(dir, "ravenryd-1.0.0.sock"), "RAVENRY_PANE=pabc"}, true, false, "pabc", "a pane of a daemon of the scope"},
		{[]string{"RAVENRY_SOCKET=/elsewhere/ravenryd-1.0.0.sock", "RAVENRY_PANE=pabc"}, false, false, "", "a pane of another runtime directory"},
		{[]string{"RAVENRY_PANE=pabc"}, true, false, "pabc", "RAVENRY_PANE alone"},
		{[]string{"SSH_CONNECTION=10.0.0.1 50000 10.0.0.2 22"}, false, true, "", "an ssh session"},
		{nil, false, false, "", "neither"},
	} {
		c := exec.Command(os.Args[0])
		c.Env = append([]string{"PATH=/usr/bin:/bin", "HOME=" + dir, testprog.Env + "=sleep"}, tc.env...)
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		o := OriginOf(c.Process.Pid, Scope{Dir: dir})
		c.Process.Kill()
		c.Wait()
		if !o.Known || o.Pane != tc.pane || o.PaneID != tc.paneID || (o.SSH && !tc.ssh) || (tc.ssh && !o.SSH) {
			t.Errorf("%s: %+v", tc.desc, o)
		}
	}
}

func TestTCPOwners(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:0", "[::1]:0"} {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			t.Logf("%s: %v", addr, err)
			continue
		}
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		s, err := ln.Accept()
		if err != nil {
			t.Fatal(err)
		}
		local, server := c.LocalAddr().(*net.TCPAddr).Port, ln.Addr().(*net.TCPAddr).Port
		got, err := TCPOwners(local, server)
		if err != nil || !slices.Contains(got, os.Getpid()) {
			t.Fatalf("%s: the client of %d -> %d: %v %v", addr, local, server, got, err)
		}
		// The connection's other end (the server's side) is not a client
		// from that port.
		if got, _ := TCPOwners(server, local+1); slices.Contains(got, os.Getpid()) {
			t.Fatalf("%s: a connection that does not exist: %v", addr, got)
		}
		c.Close()
		s.Close()
		ln.Close()
	}
}
