package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// `ravenry doctor` for the app's install (HUB-019): what works and what does
// not, one line each (ok, note, fix), exit 1 when something needs fixing.
// The npm board's `ravenry doctor` knows its own install (~/.ravenry, its
// login item); this one knows the app's: its data folder (the version
// folders, bin/ and current), the hub service, the board and its port, the
// daemons, the hooks and the skill for Claude Code and Codex (as the board
// reads them: GET /api/setup/hooks and /api/setup/skills, the same answers
// Settings shows), and whether `ravenry` in a terminal is this program.
//
// Test runs: RAVENRY_DESKTOP_DATA, a test's launchd label
// (RAVENRY_SERVICE_LABEL dev.ravenry.hub.test-...), RAVENRY_LAUNCHCTL and
// RAVENRY_HUB_URL, as the app and its setup read them.

type doctorLine struct{ kind, text string }

func cmdDoctor(in []string) error {
	a, err := parse(in, specOf("doctor"))
	if err != nil {
		return err
	}
	lines := doctorLines()
	fixes := 0
	for _, l := range lines {
		if l.kind == "fix" {
			fixes++
		}
	}
	if a.g.json {
		out := []map[string]string{}
		for _, l := range lines {
			out = append(out, map[string]string{"kind": l.kind, "text": l.text})
		}
		printJSON(map[string]any{"ok": fixes == 0, "lines": out})
	} else {
		for _, l := range lines {
			fmt.Printf("  %-5s %s\n", l.kind, l.text)
		}
		if fixes > 0 {
			fmt.Printf("\n%d thing%s to fix.\n", fixes, map[bool]string{true: "s", false: ""}[fixes > 1])
		} else {
			fmt.Println("\nAll good.")
		}
	}
	if fixes > 0 {
		return exitCode(1)
	}
	return nil
}

func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home+"/") {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}

func appDataDir() string {
	if d := os.Getenv("RAVENRY_DESKTOP_DATA"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Ravenry")
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "ravenry")
	}
	return filepath.Join(home, ".local", "share", "ravenry")
}

var testLabelRe = regexp.MustCompile(`^dev\.ravenry\.hub\.test-[a-z0-9]{4,32}$`)

func serviceLabel() string {
	if l := os.Getenv("RAVENRY_SERVICE_LABEL"); testLabelRe.MatchString(l) {
		return l
	}
	return "dev.ravenry.hub"
}

// hookRow is one assistant's hooks as the board says them (GET
// /api/setup/hooks `rows`, one per assistant of its registry whose hooks
// Ravenry installs).
type hookRow struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	State  string `json:"state"`
	On     bool   `json:"on"`
	File   string `json:"file"`
	Daemon string `json:"daemon"`
}

// hookLines is the doctor's line for each assistant's hooks, in the
// board's order.
func hookLines(rows []hookRow) []doctorLine {
	var out []doctorLine
	add := func(kind, f string, a ...any) { out = append(out, doctorLine{kind, fmt.Sprintf(f, a...)}) }
	for _, r := range rows {
		if r.Kind == "claude" {
			// Claude Code's also count the daemon's hook beside its own.
			if r.On && (r.Daemon == "" || r.Daemon == "ok") {
				add("ok", "Claude Code's hooks are set up")
			} else {
				state := r.State
				if state == "ok" && r.Daemon != "" {
					state = r.Daemon
				}
				add("fix", "Claude Code's hooks are %s (~/.claude/settings.json): Ravenry's Settings, Skills, Set up puts them right.", state)
			}
			continue
		}
		if r.On {
			add("ok", "%s's hooks are set up", r.Name)
		} else {
			add("fix", "%s's hooks are %s (%s): Ravenry's Settings, Skills, Set up puts them right.", r.Name, r.State, tildePath(r.File))
		}
	}
	return out
}

func getJSON(url string, v any) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if v != nil {
		json.NewDecoder(res.Body).Decode(v)
	}
	return res.StatusCode, nil
}

func doctorLines() []doctorLine {
	var out []doctorLine
	add := func(kind, f string, a ...any) { out = append(out, doctorLine{kind, fmt.Sprintf(f, a...)}) }
	self, _ := os.Executable()
	add("ok", "This ravenry: Ravenry %s (%s)", version, tildePath(self))

	// The app.
	if runtime.GOOS == "darwin" {
		app := "/Applications/Ravenry.app"
		if b, err := exec.Command("/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", filepath.Join(app, "Contents", "Info.plist")).Output(); err == nil {
			add("ok", "The app: %s %s", app, strings.TrimSpace(string(b)))
		} else {
			add("note", "No Ravenry.app in /Applications (an app elsewhere works the same).")
		}
	}

	// The data folder: the version folders, bin/ and current.
	data := appDataDir()
	if _, err := os.Stat(data); err != nil {
		add("fix", "No data folder at %s: open the Ravenry app once, it sets this Mac up.", tildePath(data))
		return out
	}
	for _, n := range []string{"ravenryd", "ravenry"} {
		l := filepath.Join(data, "bin", n)
		if t, err := filepath.EvalSymlinks(l); err == nil {
			add("ok", "%s runs %s", tildePath(l), tildePath(t))
		} else {
			add("fix", "%s is missing or points at nothing: open the Ravenry app, it links it again.", tildePath(l))
		}
	}
	if t, err := filepath.EvalSymlinks(filepath.Join(data, "current")); err == nil {
		add("ok", "The hooks run the hub in %s (current)", tildePath(t))
	} else {
		add("note", "No current folder yet: the hub service makes it when it starts.")
	}

	// `ravenry` in a terminal.
	if p, err := exec.LookPath("ravenry"); err != nil {
		add("note", "No ravenry on your PATH: agents type its whole path. The Ravenry menu has Install the ravenry Command.")
	} else if sameFile(p, self) {
		add("ok", "ravenry on your PATH is this program (%s)", tildePath(p))
	} else {
		add("note", "ravenry on your PATH is another program (%s): agents' commands fail there. The Ravenry menu has Install the ravenry Command.", tildePath(p))
	}

	// The hub service.
	label := serviceLabel()
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		plist := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
		if _, err := os.Stat(plist); err != nil {
			add("fix", "The hub service is not installed (%s): open the Ravenry app, it installs it.", tildePath(plist))
		} else {
			lc := os.Getenv("RAVENRY_LAUNCHCTL")
			if lc == "" {
				lc = "/bin/launchctl"
			}
			if exec.Command(lc, "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)).Run() == nil {
				add("ok", "The hub service %s is loaded", label)
			} else {
				add("fix", "The hub service %s is installed but not loaded: open the Ravenry app, it starts it.", label)
			}
		}
	}

	// The board.
	url := hubURL()
	port := url[strings.LastIndex(url, ":")+1:]
	code, err := getJSON(url+"/api/state", nil)
	up := false
	switch {
	case err == nil && code == 200:
		add("ok", "The board answers on :%s", port)
		up = true
	case err == nil && code == 503:
		add("note", "The board on :%s is starting (or waits for macOS to let it read a folder).", port)
	default:
		add("fix", "The board does not answer on :%s. Its log: ~/Library/Logs/Ravenry/hub.log", port)
	}

	// The daemons.
	ds := liveDaemons()
	if len(ds) == 0 {
		add("note", "No daemon runs: the app starts one when it opens.")
	} else {
		add("ok", "%d daemon%s running", len(ds), map[bool]string{true: "s", false: ""}[len(ds) > 1])
	}

	// The hooks and the skill, as the board reads them.
	if !up {
		add("note", "The hooks and the skill are read from the board: run ravenry doctor again once it answers.")
		return out
	}
	// Each assistant's hooks, one row per assistant the board's registry
	// lists with hooks Ravenry installs (`rows`, in its order); a board
	// from before the registry sends only `claude` and `codex`.
	var hooks struct {
		Claude *struct {
			State    string `json:"state"`
			On       bool   `json:"on"`
			Ravenryd *struct {
				State string `json:"state"`
			} `json:"ravenryd"`
		} `json:"claude"`
		Codex *struct {
			State string `json:"state"`
			On    bool   `json:"on"`
			File  string `json:"file"`
		} `json:"codex"`
		Rows []hookRow `json:"rows"`
	}
	getJSON(url+"/api/setup/hooks", &hooks)
	rows := hooks.Rows
	if rows == nil {
		if c := hooks.Claude; c != nil {
			rd := ""
			if c.Ravenryd != nil {
				rd = c.Ravenryd.State
			}
			rows = append(rows, hookRow{Kind: "claude", Name: "Claude Code", State: c.State, On: c.On, Daemon: rd})
		}
		if c := hooks.Codex; c != nil {
			rows = append(rows, hookRow{Kind: "codex", Name: "Codex", State: c.State, On: c.On, File: c.File})
		}
	}
	out = append(out, hookLines(rows)...)
	var skills struct {
		Skills []struct {
			Name      string `json:"name"`
			Found     bool   `json:"found"`
			Installed bool   `json:"installed"`
			Ours      bool   `json:"ours"`
			Dir       string `json:"dir"`
		} `json:"skills"`
	}
	getJSON(url+"/api/setup/skills", &skills)
	for _, s := range skills.Skills {
		switch {
		case !s.Found:
		case s.Ours:
			add("ok", "The Ravenry skill for %s (%s)", s.Name, s.Dir)
		case s.Installed:
			add("note", "%s has a ravenry skill Ravenry did not write (%s)", s.Name, s.Dir)
		default:
			add("note", "No Ravenry skill for %s: Settings, Skills installs it.", s.Name)
		}
	}
	return out
}
