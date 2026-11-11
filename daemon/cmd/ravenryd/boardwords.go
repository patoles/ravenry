package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// The npm board's own commands (hub/bin/ravenry.mjs: ravenry start, setup,
// doctor, uninstall, phone pair), which this program does not have. Once the
// Ravenry app's ravenry comes first on the PATH (the app's Ravenry menu,
// Install the ravenry Command), a person who still has the npm board
// (ravenry-app) and types one of them gets the npm board's, as before: it is
// run in this one's place, as typed, the next ravenry on the PATH that is
// not this program. With none, it says where the app does it.
var boardWords = map[string]bool{"start": true, "setup": true, "doctor": true, "uninstall": true, "phone": true}

// handBoardWord runs the npm board's ravenry for a board command, or says
// where the app does it; it returns only when cmd is not one.
func handBoardWord(name, cmd string) {
	if name != "ravenry" || !boardWords[cmd] {
		return
	}
	if other := otherRavenry(os.Getenv("PATH")); other != "" {
		argv := append([]string{"ravenry"}, os.Args[1:]...)
		err := syscall.Exec(other, argv, os.Environ())
		fmt.Fprintf(os.Stderr, "ravenry: could not run %s: %v\n", other, err)
		os.Exit(127)
	}
	fmt.Fprintf(os.Stderr, "ravenry %s is the npm board's command (ravenry-app), which is not installed here.\n"+
		"In the Ravenry app: Settings sets up the hooks and the skill; the Ravenry menu has Uninstall Ravenry.\n"+
		"Agents: ravenry skill.\n", cmd)
	os.Exit(2)
}

// otherRavenry is the first ravenry on path that is not this program (nor
// another ravenryd under that name), or "".
func otherRavenry(path string) string {
	self, _ := os.Executable()
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			continue
		}
		f := filepath.Join(dir, "ravenry")
		st, err := os.Stat(f)
		if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
			continue
		}
		if sameFile(f, self) {
			continue
		}
		if real, err := filepath.EvalSymlinks(f); err == nil && strings.HasPrefix(filepath.Base(real), "ravenryd") {
			continue
		}
		return f
	}
	return ""
}
