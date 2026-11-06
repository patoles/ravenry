// Package paths says where ravenryd keeps its socket and its pane logs,
// and how a client finds the daemons that are running.
//
// The runtime directory holds the sockets:
//
//   - $RAVENRY_RUNTIME_DIR, when set
//   - Linux: $XDG_RUNTIME_DIR/ravenry when XDG_RUNTIME_DIR is set (systemd
//     makes it a private tmpfs, /run/user/<uid>); otherwise <state>/run
//   - macOS: <state>/run
//
// The state directory holds the pane logs:
//
//   - $RAVENRY_STATE_DIR, when set
//   - macOS: ~/Library/Application Support/Ravenry
//   - Linux: $XDG_STATE_HOME/ravenry, or ~/.local/state/ravenry
//
// Both are created with mode 0700 and must belong to the current user and
// be closed to group and others; ravenryd refuses to use them otherwise.
// Neither is ever under /tmp or another world-writable directory. macOS's
// per-user $TMPDIR is avoided too: the system cleans it of files it thinks
// are unused, and SSH sessions do not always set it.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// StateDir returns the directory for pane logs, creating it.
func StateDir() (string, error) {
	d, err := stateDir()
	if err != nil {
		return "", err
	}
	return d, EnsurePrivateDir(d)
}

func stateDir() (string, error) { return stateDirFor(os.Getenv) }

func stateDirFor(getenv func(string) string) (string, error) {
	if d := getenv("RAVENRY_STATE_DIR"); d != "" {
		return d, nil
	}
	home := getenv("HOME")
	if home == "" {
		return "", errors.New("paths: no home directory: $HOME is not defined")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Ravenry"), nil
	}
	if x := getenv("XDG_STATE_HOME"); filepath.IsAbs(x) {
		return filepath.Join(x, "ravenry"), nil
	}
	return filepath.Join(home, ".local", "state", "ravenry"), nil
}

// RuntimeDir returns the directory for sockets, creating it.
func RuntimeDir() (string, error) {
	d, err := runtimeDir()
	if err != nil {
		return "", err
	}
	return d, EnsurePrivateDir(d)
}

func runtimeDir() (string, error) { return RuntimeDirFor(os.Getenv) }

// RuntimeDirFor is the runtime directory of a process with this
// environment (another daemon's, read from the process table).
func RuntimeDirFor(getenv func(string) string) (string, error) {
	if d := getenv("RAVENRY_RUNTIME_DIR"); d != "" {
		return d, nil
	}
	if runtime.GOOS == "linux" {
		if x := getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(x) {
			if fi, err := os.Stat(x); err == nil && fi.IsDir() {
				return filepath.Join(x, "ravenry"), nil
			}
		}
	}
	s, err := stateDirFor(getenv)
	if err != nil {
		return "", err
	}
	return filepath.Join(s, "run"), nil
}

// EnsurePrivateDir creates dir (and its parents) with mode 0700 and checks
// that it is a real directory owned by this user and closed to others.
func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("paths: create %s: %w", dir, err)
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("paths: %w", err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("paths: %s is not a directory (a symlink is refused)", dir)
	}
	if uid, ok := owner(fi); ok && uid != os.Getuid() {
		return fmt.Errorf("paths: %s belongs to uid %d, not to this user (%d)", dir, uid, os.Getuid())
	}
	if fi.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("paths: %s is open to other users and cannot be closed: %w", dir, err)
		}
	}
	return nil
}

// MaxSocketPath is the longest socket path the platform accepts
// (sizeof(sun_path) minus the terminating NUL).
func MaxSocketPath() int {
	if runtime.GOOS == "linux" {
		return 107
	}
	return 103
}

var unsafeVersion = regexp.MustCompile(`[^A-Za-z0-9._+-]`)

// SocketName is the socket file name of a daemon version. Each version has
// its own socket, so a new version starts beside an old one.
func SocketName(version string) string {
	return "ravenryd-" + unsafeVersion.ReplaceAllString(version, "_") + ".sock"
}

// SocketPath returns the socket path for a daemon version in the runtime
// directory, checking its length.
func SocketPath(version string) (string, error) {
	dir, err := RuntimeDir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, SocketName(version))
	if len(p) > MaxSocketPath() {
		return "", fmt.Errorf("paths: socket path %s is %d bytes, over the limit of %d; set RAVENRY_RUNTIME_DIR to a shorter private directory", p, len(p), MaxSocketPath())
	}
	return p, nil
}

// Socket is a daemon socket found in the runtime directory.
type Socket struct {
	Path    string
	Version string
}

// Sockets lists the daemon sockets in the runtime directory, newest
// version first. It does not check that a daemon answers on them.
func Sockets() ([]Socket, error) {
	dir, err := runtimeDir()
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("paths: %w", err)
	}
	var out []Socket
	for _, e := range ents {
		n := e.Name()
		if !strings.HasPrefix(n, "ravenryd-") || !strings.HasSuffix(n, ".sock") || e.Type()&os.ModeSocket == 0 {
			continue
		}
		out = append(out, Socket{Path: filepath.Join(dir, n), Version: strings.TrimSuffix(strings.TrimPrefix(n, "ravenryd-"), ".sock")})
	}
	sort.SliceStable(out, func(i, j int) bool { return CompareVersions(out[i].Version, out[j].Version) > 0 })
	return out, nil
}

// CompareVersions compares two daemon versions in semver order:
// MAJOR.MINOR.PATCH, and a version with a pre-release suffix ("-dev",
// "-rc.1") sorts before the same version without one. It returns -1, 0
// or 1.
func CompareVersions(a, b string) int {
	ac, ap := splitVersion(a)
	bc, bp := splitVersion(b)
	for i := 0; i < 3; i++ {
		if ac[i] != bc[i] {
			if ac[i] < bc[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case ap == bp:
		return 0
	case ap == "":
		return 1
	case bp == "":
		return -1
	case comparePre(ap, bp) < 0:
		return -1
	default:
		return 1
	}
}

func splitVersion(v string) ([3]int, string) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	pre := ""
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v, pre = v[:i], v[i+1:]
	}
	var core [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(part)
		core[i] = n
	}
	return core, pre
}

func comparePre(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		switch {
		case aerr == nil && berr == nil:
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
		case aerr == nil:
			return -1
		case berr == nil:
			return 1
		default:
			if c := strings.Compare(as[i], bs[i]); c != 0 {
				return c
			}
		}
	}
	return len(as) - len(bs)
}
