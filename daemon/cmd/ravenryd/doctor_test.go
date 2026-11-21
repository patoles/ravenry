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

// The hooks' lines follow the board's rows, one per assistant its registry
// lists with hooks Ravenry installs: Claude Code's and Codex's read as they
// did, and a third assistant gets its own line in the same words.
func TestDoctorHookRows(t *testing.T) {
	home, _ := os.UserHomeDir()
	got := hookLines([]hookRow{
		{Kind: "claude", Name: "Claude Code", State: "ok", On: true, Daemon: "ok"},
		{Kind: "codex", Name: "Codex", State: "missing", File: filepath.Join(home, ".codex", "hooks.json")},
		{Kind: "fake", Name: "Stand-in Agent", State: "ok", On: true},
		{Kind: "fake2", Name: "Second Stand-in", State: "partial", File: "/tmp/x/hooks.json"},
	})
	want := []doctorLine{
		{"ok", "Claude Code's hooks are set up"},
		{"fix", "Codex's hooks are missing (~/.codex/hooks.json): Ravenry's Settings, Skills, Set up puts them right."},
		{"ok", "Stand-in Agent's hooks are set up"},
		{"fix", "Second Stand-in's hooks are partial (/tmp/x/hooks.json): Ravenry's Settings, Skills, Set up puts them right."},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: got %v, want %v", i, got[i], want[i])
		}
	}
	stale := hookLines([]hookRow{{Kind: "claude", Name: "Claude Code", State: "ok", On: false, Daemon: "stale"}})
	if len(stale) != 1 || stale[0].text != "Claude Code's hooks are stale (~/.claude/settings.json): Ravenry's Settings, Skills, Set up puts them right." {
		t.Errorf("Claude Code's daemon hook stale: %v", stale)
	}
}
