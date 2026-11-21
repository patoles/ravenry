package testenv

import (
	"os"
	"path/filepath"
	"runtime"
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
// refused (hub/tools/live-guard-test.mjs runs this with them set).
func TestThePersonsDaemonAndBoardAreOutOfReach(t *testing.T) {
	for _, k := range LiveVars {
		if v, ok := os.LookupEnv(k); ok {
			t.Fatalf("%s=%s is still set", k, v)
		}
	}
	if os.Getenv("TERM_PROGRAM") == "ravenry" {
		t.Fatal("TERM_PROGRAM=ravenry is still set")
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
}
