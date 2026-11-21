// Package testenv keeps the daemon's tests off the real user's data. It is
// the one helper for Go; tools/test-env.mjs is its twin for Node, with the
// same rule.
//
// On 2026-11-06 a test run started a daemon with the real HOME: with
// RAVENRY_RUNTIME_DIR set but no RAVENRY_STATE_DIR, the daemon kept its
// pane logs and shell files in ~/Library/Application Support/Ravenry, the
// real app's folder. So a test may start ravenryd (the binary, or a server
// and pane manager in its own process) only when every folder it would use
// is a test's: HOME, the runtime folder and the state folder, as
// internal/paths derives them from the environment the daemon gets.
//
// A folder is a test's when it is inside a test root (a `.tmp` folder of
// this repository, or a folder named in RAVENRY_TEST_ROOT, several joined
// with ":"), or outside the real user's home folder and runtime folder (the
// system's temporary folders, where os.MkdirTemp and t.TempDir make them).
package testenv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The person's own daemon and board: a test never reaches them, whatever
// shell it runs from (tools/test-env.mjs keeps the same rule for Node). On
// 2026-11-21 a client test run from a shell in a Ravenry pane opened a
// pane in the person's daemon through the RAVENRY_SOCKET it inherited. So
// every test binary that imports this package unsets, before its tests
// run, the variables that point a client at a running daemon or board
// (LiveVars), and Problems refuses an environment that names the person's
// daemon socket or board.

// LiveVars point a client at a running daemon or board.
var LiveVars = []string{"RAVENRY_SOCKET", "RAVENRY_PANE", "RAVENRY_HUB_URL", "MC_BOARD_URL"}

func init() { DropLiveVars() }

// DropLiveVars unsets LiveVars in this process, and TERM_PROGRAM with
// TERM_PROGRAM_VERSION when they say ravenry. It returns the names unset.
func DropLiveVars() []string {
	names := append([]string{}, LiveVars...)
	if os.Getenv("TERM_PROGRAM") == "ravenry" {
		names = append(names, "TERM_PROGRAM", "TERM_PROGRAM_VERSION")
	}
	var out []string
	for _, k := range names {
		if _, ok := os.LookupEnv(k); ok {
			os.Unsetenv(k)
			out = append(out, k)
		}
	}
	return out
}

// BoardPort is the person's board's port, besides the one their board
// wrote to ~/.ravenry/board.json.
const BoardPort = 4600

var loopback = regexp.MustCompile(`^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|::)$`)

// PersonBoard reports whether this address is the person's own board on
// this machine.
func PersonBoard(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || !loopback.MatchString(u.Hostname()) {
		return false
	}
	port, _ := strconv.Atoi(u.Port())
	if port == 0 {
		port = 80
		if u.Scheme == "https" {
			port = 443
		}
	}
	if port == BoardPort {
		return true
	}
	var b struct {
		Port int `json:"port"`
	}
	if data, err := os.ReadFile(filepath.Join(realHome(), ".ravenry", "board.json")); err == nil && json.Unmarshal(data, &b) == nil {
		return b.Port > 0 && b.Port == port
	}
	return false
}

// realHome is the account's home, from the user database (not HOME, which
// a test may have changed).
func realHome() string {
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	h, _ := os.UserHomeDir()
	return h
}

// realRuntime is the account's runtime folder on Linux (/run/user/<uid>):
// a daemon there shares the user's real sockets, though it is not in HOME.
func realRuntime() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	return fmt.Sprintf("/run/user/%d", os.Getuid())
}

// repo is this repository's root: two folders up from daemon/internal.
func repo() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(file))))
}

// resolved follows symlinks as far as the path exists.
func resolved(p string) string {
	p = filepath.Clean(p)
	rest := []string{}
	for cur := p; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			for i := len(rest) - 1; i >= 0; i-- {
				r = filepath.Join(r, rest[i])
			}
			return r
		}
		up := filepath.Dir(cur)
		if up == cur {
			return p
		}
		rest = append(rest, filepath.Base(cur))
		cur = up
	}
}

func inside(p, dir string) bool {
	for _, pair := range [][2]string{{filepath.Clean(p), filepath.Clean(dir)}, {resolved(p), resolved(dir)}} {
		r, err := filepath.Rel(pair[1], pair[0])
		if err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r) {
			return true
		}
	}
	return false
}

func inRepoTmp(p string) bool {
	root := repo()
	if root == "" {
		return false
	}
	for _, pair := range [][2]string{{filepath.Clean(p), root}, {resolved(p), resolved(root)}} {
		r, err := filepath.Rel(pair[1], pair[0])
		if err != nil || r == "." || strings.HasPrefix(r, "..") {
			continue
		}
		for _, seg := range strings.Split(r, string(filepath.Separator)) {
			if seg == ".tmp" {
				return true
			}
		}
	}
	return false
}

// IsTestPath reports whether a test may use this folder. roots is
// RAVENRY_TEST_ROOT.
func IsTestPath(p, roots string) bool {
	if !filepath.IsAbs(p) {
		return false
	}
	if inRepoTmp(p) {
		return true
	}
	for _, r := range strings.Split(roots, ":") {
		if filepath.IsAbs(r) && inside(p, r) {
			return true
		}
	}
	if inside(p, realHome()) {
		return false
	}
	if rr := realRuntime(); rr != "" && inside(p, rr) {
		return false
	}
	return true
}

func lookup(env []string) func(string) string {
	if env == nil {
		return os.Getenv
	}
	m := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return func(k string) string { return m[k] }
}

// Folders are the folders a daemon started with this environment would
// use (a nil env is this process's), as internal/paths derives them. A
// missing HOME is the account's home.
func Folders(env []string) map[string]string {
	get := lookup(env)
	home := get("HOME")
	if home == "" {
		home = realHome()
	}
	state := get("RAVENRY_STATE_DIR")
	if state == "" {
		switch {
		case runtime.GOOS == "darwin":
			state = filepath.Join(home, "Library", "Application Support", "Ravenry")
		case filepath.IsAbs(get("XDG_STATE_HOME")):
			state = filepath.Join(get("XDG_STATE_HOME"), "ravenry")
		default:
			state = filepath.Join(home, ".local", "state", "ravenry")
		}
	}
	run := get("RAVENRY_RUNTIME_DIR")
	if run == "" && runtime.GOOS == "linux" && filepath.IsAbs(get("XDG_RUNTIME_DIR")) {
		if fi, err := os.Stat(get("XDG_RUNTIME_DIR")); err == nil && fi.IsDir() {
			run = filepath.Join(get("XDG_RUNTIME_DIR"), "ravenry")
		}
	}
	if run == "" {
		run = filepath.Join(state, "run")
	}
	return map[string]string{"HOME": home, "the runtime folder (RAVENRY_RUNTIME_DIR)": run, "the state folder (RAVENRY_STATE_DIR)": state}
}

// Problems lists what is wrong with starting a daemon with this
// environment; empty when it is fine.
func Problems(env []string) []string {
	roots := lookup(env)("RAVENRY_TEST_ROOT")
	if r := os.Getenv("RAVENRY_TEST_ROOT"); r != "" {
		roots += ":" + r
	}
	var out []string
	for _, name := range []string{"HOME", "the runtime folder (RAVENRY_RUNTIME_DIR)", "the state folder (RAVENRY_STATE_DIR)"} {
		if d := Folders(env)[name]; !IsTestPath(d, roots) {
			out = append(out, fmt.Sprintf("%s is %s, inside the real user's folders", name, d))
		}
	}
	get := lookup(env)
	if s := get("RAVENRY_SOCKET"); s != "" && !IsTestPath(s, roots) {
		out = append(out, fmt.Sprintf("RAVENRY_SOCKET is %s, the person's own daemon", s))
	}
	for _, k := range []string{"RAVENRY_HUB_URL", "MC_BOARD_URL"} {
		if u := get(k); u != "" && PersonBoard(u) {
			out = append(out, fmt.Sprintf("%s is %s, the person's own board", k, u))
		}
	}
	return out
}

// Check stops the test before it starts a daemon with this environment
// when any of its folders is the real user's, or it names the person's own
// daemon or board.
func Check(t testing.TB, env []string) {
	t.Helper()
	if p := Problems(env); len(p) > 0 {
		t.Fatalf("refused to start ravenryd: a test keeps every folder of Ravenry's in a test root (a .tmp folder of this repository, RAVENRY_TEST_ROOT, or the system's temporary folders), never in the real user's, and reaches only its own daemon and board:\n  %s", strings.Join(p, "\n  "))
	}
}

// CheckDirs stops the test when a folder it hands a daemon in its own
// process (a log folder, a socket) is the real user's.
func CheckDirs(t testing.TB, dirs ...string) {
	t.Helper()
	roots := os.Getenv("RAVENRY_TEST_ROOT")
	for _, d := range dirs {
		if !IsTestPath(d, roots) {
			t.Fatalf("refused: %s is inside the real user's folders; a test keeps the daemon's files in a test root", d)
		}
	}
}

// LibraryProblem says why the libghostty-vt build a test binary was
// compiled with (vt.LibraryBuild) may not be this tree's: none named (a
// plain `go test` without scripts/libghostty.sh's flags, which links
// whatever Go's cache compiled last, perhaps without daemon/patches), or
// one named without the hash of the patches in daemonDir/patches, as
// scripts/libghostty.sh computes it. Empty when it is this tree's.
func LibraryProblem(build, daemonDir string) string {
	const how = "run `make test` in daemon/, or export PKG_CONFIG_PATH=$(scripts/libghostty.sh) and CGO_CPPFLAGS=-DRAVENRY_LIBGHOSTTY=<that build's folder name> (README, Build)"
	if build == "" {
		return "these tests were compiled without RAVENRY_LIBGHOSTTY, so the libghostty-vt linked is whatever Go's cache built last and may lack daemon/patches; " + how
	}
	patches, _ := filepath.Glob(filepath.Join(daemonDir, "patches", "*.patch"))
	if len(patches) == 0 {
		return ""
	}
	sort.Strings(patches)
	h := sha256.New()
	for _, p := range patches {
		b, err := os.ReadFile(p)
		if err != nil {
			return "reading " + p + ": " + err.Error()
		}
		h.Write(b)
	}
	want := "-p" + hex.EncodeToString(h.Sum(nil))[:8] + "-"
	if !strings.Contains(build, want) {
		return "these tests were compiled against libghostty-vt build " + build + ", not the one with this tree's daemon/patches (" + strings.Trim(want, "-") + "); " + how
	}
	return ""
}

// DaemonDir is the daemon module's folder (where go.mod is), found up
// from the current directory (a test runs in its package's folder).
func DaemonDir() string {
	d, _ := os.Getwd()
	for i := 0; i < 8 && d != "/"; i++ {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		d = filepath.Dir(d)
	}
	return ""
}
