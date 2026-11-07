package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
	"ravenryd/internal/testprog"
)

// Only a person answers a checkpoint (PROTOCOL.md section 4, Who acts as
// the person): a program inside a pane is refused however it connects,
// and the checkpoint stays open; the test process, outside every pane,
// answers it.

func cpState(t *testing.T, c *client.Client, id string) string {
	t.Helper()
	for _, cp := range call[proto.CheckpointListResult](t, c, "checkpoint.list", map[string]any{"all": true}).Checkpoints {
		if cp.ID == id {
			return cp.State
		}
	}
	return "missing"
}

func TestOnlyAPersonAnswers(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	if !person.Hello.Person {
		t.Fatalf("the test process, outside every pane, is not the person: %+v", person.Hello)
	}
	cp := newCheckpoint(t, person, map[string]any{"kind": "approve", "title": "Delete the build folder", "command": "rm -rf build"})
	exe, _ := os.Executable()
	vars := "RAVENRY_TESTPROG=answer RAVENRY_TESTPROG_CP=" + cp.ID + " RAVENRY_TESTPROG_SOCKET=" + d.socket
	for _, tc := range []struct{ name, cmd string }{
		// The program asks over the socket the pane names.
		{"a program in the pane", "RAVENRY_TESTPROG=answer RAVENRY_TESTPROG_CP=" + cp.ID + " '" + exe + "'"},
		// A wiped environment: it still descends from the pane.
		{"with its environment wiped", "exec /usr/bin/env -i " + vars + " '" + exe + "'"},
		// Detached (its parent exits, so it belongs to init) with a wiped
		// environment: it is still in the pane's session.
		{"detached with its environment wiped", "(/usr/bin/env -i " + vars + " '" + exe + "' &); exec sleep 30"},
		// Double-forked: a shell in a session of its own starts it with
		// its environment wiped and exits, so it is a child of launchd or
		// init in the session of a process that is gone. The daemon saw
		// that shell while it lived (macOS: the fork watch), or the
		// program carries the pane's mark (Linux).
		{"double-forked with its environment wiped", "RAVENRY_TESTPROG=detach RAVENRY_TESTPROG_DETACH=\"/usr/bin/env -i " + vars + " '" + exe + "' 1>&2\" '" + exe + "'"},
		// Claiming to come over ssh with a key does not help either.
		{"claiming ssh with a key", "SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22' RAVENRY_TESTPROG_KEY=from-a-pane " + vars + " '" + exe + "'"},
	} {
		p := newPane(t, person, map[string]any{"command": []string{"/bin/sh", "-c", tc.cmd}})
		w := waitFor(t, person, p.ID, `person=\w+ answer=\w+ decide=\w+`, 0)
		if !strings.Contains(w.Output, "person=false answer=forbidden decide=forbidden") {
			t.Fatalf("%s: %q", tc.name, w.Output)
		}
		if s := cpState(t, person, cp.ID); s != "open" {
			t.Fatalf("%s: the checkpoint is %s", tc.name, s)
		}
	}
	if !strings.Contains(d.log.String(), "refused checkpoint.answer") {
		t.Fatalf("the refusals are not logged: %s", d.log.String())
	}
	// The person answers it.
	if a := answer(t, person, map[string]any{"checkpoint": cp.ID, "decline": true, "by": "desktop"}); a.State != "declined" {
		t.Fatalf("the person's answer: %+v", a)
	}
}

// Over ssh (ravenryd proxy), the daemon cannot see the machine the
// connection comes from: only a connection with the answer key this
// machine trusts acts as the person. The first key given is trusted; a
// key given from inside a pane is never kept.
func TestOverSSHOnlyTheTrustedKeyAnswers(t *testing.T) {
	d := startDaemon(t)
	keyFile := filepath.Join(d.dir, "state", "answer-key")
	os.MkdirAll(filepath.Dir(keyFile), 0o700)
	d.srv.keys.path = keyFile
	person := d.dial(client.Options{Name: "app"})
	exe, _ := os.Executable()
	run := func(cp, key string) string {
		t.Helper()
		// Started by the test process, not in a pane, as sshd would start
		// `ravenryd proxy`.
		c := exec.Command(exe)
		c.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + d.home, "RAVENRY_TESTPROG=answer", "RAVENRY_TESTPROG_SOCKET=" + d.socket,
			"RAVENRY_TESTPROG_CP=" + cp, "SSH_CONNECTION=10.0.0.1 50000 10.0.0.2 22"}
		testenv.Check(t, c.Env)
		if key != "" {
			c.Env = append(c.Env, "RAVENRY_TESTPROG_KEY="+key)
		}
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	approve := func() string {
		return newCheckpoint(t, person, map[string]any{"kind": "approve", "title": "Deploy", "command": "true"}).ID
	}
	// From a pane, with a key: refused, and the key is not kept.
	cp := approve()
	p := newPane(t, person, map[string]any{"command": []string{"/bin/sh", "-c", "SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22' RAVENRY_TESTPROG=answer RAVENRY_TESTPROG_KEY=pane-key RAVENRY_TESTPROG_CP=" + cp + " '" + exe + "'"}})
	if w := waitFor(t, person, p.ID, `person=\w+ answer=\w+`, 0); !strings.Contains(w.Output, "person=false answer=forbidden") {
		t.Fatalf("from a pane: %q", w.Output)
	}
	if _, err := os.Stat(keyFile); err == nil {
		t.Fatal("a key given from inside a pane was kept")
	}
	if got := run(cp, ""); got != "person=false answer=forbidden decide=forbidden" {
		t.Fatalf("over ssh with no key: %s", got)
	}
	if got := run(cp, "hub-key-one"); got != "person=true answer=ok decide=ok" {
		t.Fatalf("over ssh with the first key: %s", got)
	}
	if s := cpState(t, person, cp); s != "declined" {
		t.Fatalf("the hub's answer did not take: %s", s)
	}
	b, err := os.ReadFile(keyFile)
	fi, _ := os.Stat(keyFile)
	if err != nil || strings.Contains(string(b), "hub-key-one") || !strings.HasPrefix(string(b), "sha256:") || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the trusted key's file: %v %q %v", err, b, fi.Mode())
	}
	cp = approve()
	if got := run(cp, "another-key"); got != "person=false answer=forbidden decide=forbidden" {
		t.Fatalf("over ssh with another key: %s", got)
	}
	if s := cpState(t, person, cp); s != "open" {
		t.Fatalf("after another key: %s", s)
	}
	if got := run(cp, "hub-key-one"); got != "person=true answer=ok decide=ok" {
		t.Fatalf("over ssh with the trusted key again: %s", got)
	}
	// Deleting the file lets another hub pair.
	os.Remove(keyFile)
	if got := run(approve(), "another-key"); got != "person=true answer=ok decide=ok" {
		t.Fatalf("after deleting the file: %s", got)
	}
}

func TestPersonOnlyMethods(t *testing.T) {
	// The list the spec gives.
	want := []string{"agent.decide", "agent.decisions", "checkpoint.answer", "pane.revoke"}
	if len(personOnly) != len(want) {
		t.Fatalf("person-only methods: %v", personOnly)
	}
	for _, m := range want {
		if !personOnly[m] {
			t.Fatalf("%s is not person-only", m)
		}
	}
	_ = testprog.Env
}
