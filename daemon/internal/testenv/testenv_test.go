package testenv

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestTheRealHomeIsRefused(t *testing.T) {
	home := realHome()
	tmp := t.TempDir()
	// The 2026-11-06 incident: the real HOME, only the runtime folder changed.
	p := Problems([]string{"HOME=" + home, "RAVENRY_RUNTIME_DIR=" + tmp})
	if len(p) != 2 || !strings.HasPrefix(p[0], "HOME is ") || !strings.Contains(p[1], "state folder") {
		t.Fatalf("incident: %q", p)
	}
	// No HOME is the account's.
	if p := Problems([]string{"RAVENRY_RUNTIME_DIR=" + tmp, "RAVENRY_STATE_DIR=" + tmp}); len(p) != 1 || !strings.HasPrefix(p[0], "HOME is "+home) {
		t.Fatalf("no HOME: %q", p)
	}
	// A test's HOME, its folders derived from it: fine.
	if p := Problems([]string{"HOME=" + tmp}); len(p) != 0 {
		t.Fatalf("scratch: %q", p)
	}
	// A test's HOME with the real state folder: refused.
	if p := Problems([]string{"HOME=" + tmp, "RAVENRY_STATE_DIR=" + filepath.Join(home, ".local", "state", "ravenry")}); len(p) != 2 {
		t.Fatalf("real state: %q", p)
	}
	// The repo's .tmp is a test root, though it is under the real home.
	if !IsTestPath(filepath.Join(repo(), "daemon", ".tmp", "x"), "") || IsTestPath(filepath.Join(repo(), "daemon", "x"), "") && inside(repo(), home) {
		t.Fatal("repo .tmp")
	}
	// An explicit root lets a folder of the real home through.
	if !IsTestPath(filepath.Join(home, "rv-test-root", "h"), filepath.Join(home, "rv-test-root")) {
		t.Fatal("explicit root")
	}
	if runtime.GOOS == "linux" {
		if p := Problems([]string{"HOME=" + tmp, "XDG_RUNTIME_DIR=/nonexistent"}); len(p) != 0 {
			t.Fatalf("missing XDG_RUNTIME_DIR: %q", p)
		}
	}
}

// Run from a Ravenry pane, a test binary keeps none of the pane's
// variables, and an environment naming the person's daemon or board is
// refused (hub/tools/live-guard-test.mjs runs this with them set, its
// stand-ins marked as the person's).
func TestThePersonsDaemonAndBoardAreOutOfReach(t *testing.T) {
	if left := liveDrops(os.LookupEnv); len(left) > 0 {
		t.Fatalf("still set, naming the person's daemon or board: %q", left)
	}
	if s := os.Getenv("RAVENRY_SOCKET"); s != "" && PersonSocket(s, nil) {
		t.Fatalf("RAVENRY_SOCKET=%s is still set", s)
	}
	tmp := t.TempDir()
	live := filepath.Join(realHome(), "Library", "Application Support", "Ravenry", "run", "ravenryd-1.0.0.sock")
	if p := Problems([]string{"HOME=" + tmp, "RAVENRY_SOCKET=" + live}); len(p) != 1 || !strings.Contains(p[0], "the person's own daemon") {
		t.Fatalf("the person's socket: %q", p)
	}
	if p := Problems([]string{"HOME=" + tmp, "RAVENRY_SOCKET=" + filepath.Join(tmp, "ravenryd-1.0.0.sock")}); len(p) != 0 {
		t.Fatalf("a test's socket: %q", p)
	}
	for _, u := range []string{"http://127.0.0.1:4600", "http://localhost:4600/", "http://[::1]:4600"} {
		if p := Problems([]string{"HOME=" + tmp, "RAVENRY_HUB_URL=" + u}); len(p) != 1 {
			t.Fatalf("the person's board %s: %q", u, p)
		}
	}
	if p := Problems([]string{"HOME=" + tmp, "RAVENRY_HUB_URL=http://127.0.0.1:9", "MC_BOARD_URL=http://192.168.1.50:4600"}); len(p) != 0 {
		t.Fatalf("a test's board: %q", p)
	}
	// A stand-in marked as the person's reads as theirs.
	mark := filepath.Join(tmp, "marked.sock")
	if p := Problems([]string{"HOME=" + tmp, "RAVENRY_SOCKET=" + mark, LiveSocketsVar + "=" + mark, "RAVENRY_HUB_URL=http://127.0.0.1:4719", LivePortsVar + "=4719"}); len(p) != 2 {
		t.Fatalf("marked stand-ins: %q", p)
	}
}

// What a test binary drops at its start is told by the value: the person's
// socket and board go, with the pane's own variables; a test's own socket,
// pane and board stay, as a program a test runs in its own daemon's pane
// (internal/testprog) is started with them.
func TestOnlyThePersonsVariablesAreDropped(t *testing.T) {
	tmp := t.TempDir()
	drops := func(env ...string) string {
		m := map[string]string{}
		for _, kv := range env {
			k, v, _ := strings.Cut(kv, "=")
			m[k] = v
		}
		out := liveDrops(func(k string) (string, bool) { v, ok := m[k]; return v, ok })
		sort.Strings(out)
		return strings.Join(out, " ")
	}
	live := filepath.Join(realHome(), "Library", "Application Support", "Ravenry", "run", "ravenryd-1.0.0.sock")
	own := filepath.Join(tmp, "run", "ravenryd-1.0.0.sock")
	pane := []string{"RAVENRY_PANE=pabc1234", "TERM_PROGRAM=ravenry", "TERM_PROGRAM_VERSION=0.1.0"}
	for _, c := range []struct {
		name string
		env  []string
		want string
	}{
		{"the person's pane", append([]string{"RAVENRY_SOCKET=" + live, "RAVENRY_HUB_URL=http://127.0.0.1:4600", "MC_BOARD_URL=http://localhost:4600"}, pane...), "MC_BOARD_URL RAVENRY_HUB_URL RAVENRY_PANE RAVENRY_SOCKET TERM_PROGRAM TERM_PROGRAM_VERSION"},
		{"a test's own pane", append([]string{"RAVENRY_SOCKET=" + own, "RAVENRY_HUB_URL=http://127.0.0.1:4719"}, pane...), ""},
		{"a pane with no socket", pane, "RAVENRY_PANE TERM_PROGRAM TERM_PROGRAM_VERSION"},
		{"a test's socket marked as the person's", append([]string{"RAVENRY_SOCKET=" + own, LiveSocketsVar + "=" + own}, pane...), "RAVENRY_PANE RAVENRY_SOCKET TERM_PROGRAM TERM_PROGRAM_VERSION"},
		{"a test's board marked as the person's", []string{"RAVENRY_HUB_URL=http://127.0.0.1:4719", LivePortsVar + "=1,4719"}, "RAVENRY_HUB_URL"},
		{"another terminal", []string{"TERM_PROGRAM=ghostty", "TERM_PROGRAM_VERSION=1.3"}, ""},
	} {
		if got := drops(c.env...); got != c.want {
			t.Errorf("%s: dropped %q, want %q", c.name, got, c.want)
		}
	}
}
