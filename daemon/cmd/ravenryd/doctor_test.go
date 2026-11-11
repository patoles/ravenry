package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ravenry doctor with no data folder, then with one but no board: each says
// what to fix and exits 1. The board's side (hooks, skill) is checked on the
// app's package by apps/macos/scripts/setupmenucheck.mjs.
func TestDoctorSaysWhatToFix(t *testing.T) {
	e := newEnv(t)
	data := filepath.Join(e.dir, "data")
	e.vars = append(e.vars, "RAVENRY_DESKTOP_DATA="+data, "RAVENRY_HUB_URL=http://127.0.0.1:9", "RAVENRY_LAUNCHCTL=/usr/bin/false")
	out, _, code := runCmd(t, e.ravenry("0.2.0", "doctor"))
	if code != 1 || !strings.Contains(out, "fix   No data folder") {
		t.Fatalf("no data folder: exit %d\n%s", code, out)
	}
	os.MkdirAll(filepath.Join(data, "bin"), 0o700)
	os.Symlink(bins["0.2.0"], filepath.Join(data, "bin", "ravenryd"))
	os.Symlink(bins["0.2.0"], filepath.Join(data, "bin", "ravenry"))
	out, _, code = runCmd(t, e.ravenry("0.2.0", "doctor"))
	if code != 1 || !strings.Contains(out, "ok    ") || !strings.Contains(out, "fix   The board does not answer on :9") || !strings.Contains(out, "1 thing") && !strings.Contains(out, "things to fix") {
		t.Fatalf("no board: exit %d\n%s", code, out)
	}
}
