package pane

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What changed since a process started: whether the code it runs is still
// the code on disk. It is worked out when asked, never tracked: the git
// repository of the process's working directory (its HEAD now, and the
// HEAD it started on from the HEAD reflog), the tracked files modified
// since it started, and its executable file's modification time (a
// rebuilt binary).

// Git is the git work tree a process works in.
type Git struct {
	// Root is the work tree's top folder.
	Root string
	// Head is the commit HEAD names now; empty in a repository with no
	// commit yet.
	Head string
	// Branch is the branch HEAD is on; empty when detached.
	Branch string
	// StartedOn is the commit HEAD named when the process started, from
	// the HEAD reflog; empty when the reflog cannot tell.
	StartedOn string
	// Edited are tracked files modified after the process started,
	// relative to Root, newest first, at most maxEdited.
	Edited []string
	// Partial: not every tracked file was checked (there were more than
	// maxStat, or git or the check ran out of time).
	Partial bool
}

// Reasons a process's code changed since it started.
const (
	ChangedHead  = "head"  // HEAD names another commit than it started on
	ChangedFiles = "files" // a tracked file was modified after it started
	ChangedExe   = "exe"   // its executable file was modified after it started
)

const (
	// gitTimeout bounds each git command.
	gitTimeout = 2 * time.Second
	// maxStat is how many tracked files are checked at most.
	maxStat = 20000
	// maxEdited is how many edited files are named at most.
	maxEdited = 20
	// reflogTail is how much of the end of the HEAD reflog is read.
	reflogTail = 1 << 20
	// changeSlack: a file counts as modified after the start only when it
	// was modified more than this after started_at. Linux gives a
	// process's start against a boot time in whole seconds, so a binary
	// built just before the start could otherwise look rebuilt.
	changeSlack = time.Second
)

// CheckSource fills what changed since the process started: ExeModified,
// Git, and Changes (with Checked set when the start time is known). It
// takes at most about the context's time; what it could not learn in it
// is left out.
func CheckSource(ctx context.Context, pr *Process) {
	exe := pr.Exe
	if exe != "" && !filepath.IsAbs(exe) && pr.Cwd != "" {
		exe = filepath.Join(pr.Cwd, exe)
	}
	if exe != "" {
		if fi, err := os.Stat(exe); err == nil {
			pr.ExeModified = fi.ModTime()
		}
	}
	if pr.Cwd != "" {
		pr.Git = checkGit(ctx, pr.Cwd, pr.Started)
	}
	if pr.Started.IsZero() {
		return
	}
	pr.Checked = true
	pr.Changes = nil
	if g := pr.Git; g != nil {
		if g.StartedOn != "" && g.Head != g.StartedOn {
			pr.Changes = append(pr.Changes, ChangedHead)
		}
		if len(g.Edited) > 0 {
			pr.Changes = append(pr.Changes, ChangedFiles)
		}
	}
	if after(pr.ExeModified, pr.Started) {
		pr.Changes = append(pr.Changes, ChangedExe)
	}
}

// after reports whether t is more than changeSlack after start.
func after(t, start time.Time) bool {
	return !t.IsZero() && t.Sub(start) > changeSlack
}

func checkGit(ctx context.Context, cwd string, started time.Time) *Git {
	out, err := gitRun(ctx, cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir")
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 || lines[0] == "" || lines[1] == "" {
		return nil
	}
	g := &Git{Root: lines[0]}
	gitDir := lines[1]
	if h, err := gitRun(ctx, g.Root, "rev-parse", "-q", "--verify", "HEAD"); err == nil {
		g.Head = strings.TrimSpace(h)
	}
	if b, err := gitRun(ctx, g.Root, "symbolic-ref", "-q", "--short", "HEAD"); err == nil {
		g.Branch = strings.TrimSpace(b)
	}
	if started.IsZero() {
		return g
	}
	g.StartedOn = reflogAt(filepath.Join(gitDir, "logs", "HEAD"), started)
	g.Edited, g.Partial = editedSince(ctx, g.Root, started)
	return g
}

// reflogAt reads a reflog and returns the commit of its last entry at or
// before t, or "" when no entry is.
func reflogAt(path string, t time.Time) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return ""
	}
	start := int64(0)
	if fi.Size() > reflogTail {
		start = fi.Size() - reflogTail
	}
	b, err := io.ReadAll(io.NewSectionReader(f, start, fi.Size()-start))
	if err != nil {
		return ""
	}
	if start > 0 {
		// The first line read is likely cut.
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			b = b[i+1:]
		}
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		commit, at, ok := parseReflog(lines[i])
		if ok && !at.After(t) {
			return commit
		}
	}
	return ""
}

// parseReflog reads one reflog line: "OLD NEW Name <email> SECONDS TZ\tmessage".
func parseReflog(line string) (commit string, at time.Time, ok bool) {
	head, _, _ := strings.Cut(line, "\t")
	f := strings.Fields(head)
	if len(f) < 4 || !isHex(f[1]) {
		return "", time.Time{}, false
	}
	gt := strings.LastIndexByte(head, '>')
	if gt < 0 {
		return "", time.Time{}, false
	}
	rest := strings.Fields(head[gt+1:])
	if len(rest) < 1 {
		return "", time.Time{}, false
	}
	sec, err := strconv.ParseInt(rest[0], 10, 64)
	if err != nil {
		return "", time.Time{}, false
	}
	return f[1], time.Unix(sec, 0), true
}

func isHex(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// editedSince lists the tracked files of the work tree at root modified
// after started (newest first, at most maxEdited), checking at most
// maxStat of them; partial says some were not checked.
func editedSince(ctx context.Context, root string, started time.Time) (edited []string, partial bool) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := gitCommand(ctx, root, "ls-files", "-z")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, true
	}
	if err := cmd.Start(); err != nil {
		return nil, true
	}
	type hit struct {
		path string
		at   time.Time
	}
	var hits []hit
	r := bufio.NewReaderSize(out, 64<<10)
	n := 0
	for {
		name, err := r.ReadString(0)
		if err != nil {
			break
		}
		if n >= maxStat || ctx.Err() != nil {
			partial = true
			break
		}
		n++
		name = strings.TrimSuffix(name, "\x00")
		fi, err := os.Lstat(filepath.Join(root, name))
		if err == nil && after(fi.ModTime(), started) {
			hits = append(hits, hit{name, fi.ModTime()})
		}
	}
	if partial {
		cmd.Process.Kill()
	}
	io.Copy(io.Discard, out)
	if err := cmd.Wait(); err != nil && !partial {
		partial = true
	}
	slices.SortStableFunc(hits, func(a, b hit) int { return b.at.Compare(a.at) })
	for i, h := range hits {
		if i == maxEdited {
			break
		}
		edited = append(edited, h.path)
	}
	return edited, partial
}

func gitRun(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := gitCommand(ctx, dir, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	return out.String(), err
}

// gitCommand is a git command that only reads: no optional locks, no
// file system monitor, no prompt, and none of the GIT_ variables of the
// daemon's own environment.
func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	bin := gitBinary()
	if bin == "" {
		bin = "git-not-found"
	}
	full := append([]string{"--no-optional-locks", "-c", "core.fsmonitor=false", "-C", dir}, args...)
	cmd := exec.CommandContext(ctx, bin, full...)
	env := []string{"LC_ALL=C", "GIT_TERMINAL_PROMPT=0"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") && !strings.HasPrefix(kv, "LC_ALL=") {
			env = append(env, kv)
		}
	}
	cmd.Env = env
	cmd.WaitDelay = 500 * time.Millisecond
	return cmd
}

var (
	gitOnce sync.Once
	gitPath string
)

// gitBinary finds git on PATH or in the usual places. On macOS,
// /usr/bin/git is a stub that asks to install the developer tools in a
// window when they are missing, so it is used only when they are there.
func gitBinary() string {
	gitOnce.Do(func() {
		cands := []string{}
		if p, err := exec.LookPath("git"); err == nil {
			cands = append(cands, p)
		}
		cands = append(cands, "/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git")
		for _, p := range cands {
			if fi, err := os.Stat(p); err != nil || fi.IsDir() {
				continue
			}
			if runtime.GOOS == "darwin" && p == "/usr/bin/git" && !appleDevTools() {
				continue
			}
			gitPath = p
			return
		}
	})
	return gitPath
}

// appleDevTools reports whether macOS's developer tools are installed,
// so /usr/bin/git runs git instead of asking to install them.
func appleDevTools() bool {
	dirs := []string{"/Library/Developer/CommandLineTools"}
	if d, err := os.Readlink("/var/db/xcode_select_link"); err == nil {
		dirs = append([]string{d}, dirs...)
	}
	if d := os.Getenv("DEVELOPER_DIR"); d != "" {
		dirs = append([]string{d}, dirs...)
	}
	for _, d := range dirs {
		if _, err := os.Stat(filepath.Join(d, "usr", "bin", "git")); err == nil {
			return true
		}
	}
	return false
}
