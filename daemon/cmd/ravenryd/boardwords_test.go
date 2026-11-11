package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The app's ravenry first on the PATH, the npm board's launcher after it:
// an agent's command is the app's, a board command is handed to the npm
// board's as typed (its output and exit status), and with no npm board the
// board command says where the app does it.
func TestBoardWordsGoToTheNpmBoard(t *testing.T) {
	e := newEnv(t)
	npm := filepath.Join(e.dir, "npm-bin")
	os.MkdirAll(npm, 0o700)
	script := "#!/bin/sh\necho \"npm board: $*\"\nexit 7\n"
	if err := os.WriteFile(filepath.Join(npm, "ravenry"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	app := e.ravenry("0.2.0", "version") // makes bin-0.2.0/ravenry, the app's link
	appDir := filepath.Dir(app.Path)
	withPath := func(p string) {
		for i, v := range e.vars {
			if strings.HasPrefix(v, "PATH=") {
				e.vars[i] = "PATH=" + p
			}
		}
	}
	withPath(appDir + ":" + npm + ":/usr/bin:/bin")
	out, _, code := runCmd(t, e.ravenry("0.2.0", "setup", "--yes"))
	if code != 7 || strings.TrimSpace(out) != "npm board: setup --yes" {
		t.Fatalf("ravenry setup: exit %d, %q", code, out)
	}
	out, _, code = runCmd(t, e.ravenry("0.2.0", "help"))
	if code != 0 || !strings.Contains(out, "ravenry pick TITLE") {
		t.Fatalf("ravenry help went elsewhere: exit %d, %q", code, out)
	}
	// ravenryd under its own name never hands anything on.
	_, errOut, code := runCmd(t, e.cmd("0.2.0", "phone"))
	if code != 2 || !strings.Contains(errOut, "unknown command") {
		t.Fatalf("ravenryd phone: exit %d, %q", code, errOut)
	}
	withPath(appDir + ":/usr/bin:/bin")
	_, errOut, code = runCmd(t, e.ravenry("0.2.0", "setup"))
	if code != 2 || !strings.Contains(errOut, "the npm board's command") || !strings.Contains(errOut, "Uninstall Ravenry") {
		t.Fatalf("ravenry setup with no npm board: exit %d, %q", code, errOut)
	}
}
