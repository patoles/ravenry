package pane

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/testenv"
)

// gitRepo makes a repository in a test folder with one commit made at
// base (the reflog's entry has that time too), its files dated base, and
// an executable dated base. It returns the folder, a function that runs
// git in it at a given time, and the executable's path.
func gitRepo(t *testing.T, base time.Time) (dir string, git func(at time.Time, args ...string) string, exe string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	dir = filepath.Join(root, "repo")
	os.MkdirAll(home, 0o700)
	os.MkdirAll(filepath.Join(dir, "src"), 0o700)
	testenv.CheckDirs(t, home, dir)
	git = func(at time.Time, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		date := fmt.Sprintf("%d +0000", at.Unix())
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "GIT_CONFIG_NOSYSTEM=1", "LC_ALL=C",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test",
			"GIT_COMMITTER_EMAIL=test@example.com", "GIT_AUTHOR_DATE=" + date, "GIT_COMMITTER_DATE=" + date}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(base, "init", "-q", "-b", "main")
	for name, body := range map[string]string{"README": "hello\n", "src/main.go": "package main\n"} {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte(body), 0o600)
		os.Chtimes(p, base, base)
	}
	git(base, "add", "-A")
	git(base, "commit", "-q", "-m", "first")
	exe = filepath.Join(root, "bin", "server")
	os.MkdirAll(filepath.Dir(exe), 0o700)
	os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o700)
	os.Chtimes(exe, base, base)
	return dir, git, exe
}

func TestCheckSource(t *testing.T) {
	// git as the daemon runs it reads HOME's config: a test's.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	base := time.Now().Add(-time.Hour).Truncate(time.Second)
	start := base.Add(10 * time.Minute)
	later := start.Add(5 * time.Minute)
	check := func(dir, exe string) *Process {
		pr := &Process{PID: 1, Exe: exe, Cwd: filepath.Join(dir, "src"), Started: start}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		CheckSource(ctx, pr)
		if pr.Git == nil {
			t.Fatalf("no git work tree found from %s", pr.Cwd)
		}
		return pr
	}
	sameDir := func(a, b string) bool {
		ra, _ := filepath.EvalSymlinks(a)
		rb, _ := filepath.EvalSymlinks(b)
		return ra == rb
	}

	t.Run("unchanged, and the HEAD it started on from the reflog", func(t *testing.T) {
		dir, git, exe := gitRepo(t, base)
		first := git(base, "rev-parse", "HEAD")
		pr := check(dir, exe)
		g := pr.Git
		if !sameDir(g.Root, dir) || g.Head != first || g.Branch != "main" || g.StartedOn != first || len(g.Edited) != 0 || g.Partial {
			t.Fatalf("git %+v (first %s)", g, first)
		}
		if !pr.Checked || len(pr.Changes) != 0 || !pr.ExeModified.Equal(base) {
			t.Fatalf("changed %v %v, exe modified %v", pr.Checked, pr.Changes, pr.ExeModified)
		}
	})

	t.Run("HEAD at start from a reflog with commits before and after", func(t *testing.T) {
		dir, git, exe := gitRepo(t, base)
		git(base.Add(time.Minute), "commit", "-q", "--allow-empty", "-m", "second")
		second := git(base, "rev-parse", "HEAD")
		git(later, "checkout", "-q", "-b", "next")
		git(later, "commit", "-q", "--allow-empty", "-m", "third")
		third := git(base, "rev-parse", "HEAD")
		pr := check(dir, exe)
		g := pr.Git
		if g.StartedOn != second || g.Head != third || g.Branch != "next" {
			t.Fatalf("git %+v (second %s, third %s)", g, second, third)
		}
		if !slices.Equal(pr.Changes, []string{ChangedHead}) {
			t.Fatalf("changes %v", pr.Changes)
		}
		// Before the first entry, the reflog cannot tell.
		early := &Process{PID: 1, Cwd: dir, Started: base.Add(-time.Minute)}
		CheckSource(context.Background(), early)
		if early.Git == nil || early.Git.StartedOn != "" || slices.Contains(early.Changes, ChangedHead) {
			t.Fatalf("started before the reflog: %+v %v", early.Git, early.Changes)
		}
		// Detached: no branch.
		git(later, "checkout", "-q", "--detach", second)
		if g := check(dir, exe).Git; g.Branch != "" || g.Head != second {
			t.Fatalf("detached %+v", g)
		}
	})

	t.Run("changed by a commit", func(t *testing.T) {
		dir, git, exe := gitRepo(t, base)
		first := git(base, "rev-parse", "HEAD")
		git(later, "commit", "-q", "--allow-empty", "-m", "fix")
		pr := check(dir, exe)
		if pr.Git.StartedOn != first || pr.Git.Head == first || !slices.Equal(pr.Changes, []string{ChangedHead}) {
			t.Fatalf("git %+v changes %v", pr.Git, pr.Changes)
		}
	})

	t.Run("changed by an edit", func(t *testing.T) {
		dir, _, exe := gitRepo(t, base)
		p := filepath.Join(dir, "src", "main.go")
		os.WriteFile(p, []byte("package main // fixed\n"), 0o600)
		os.Chtimes(p, later, later)
		// An untracked file is not the code the process runs.
		u := filepath.Join(dir, "notes.txt")
		os.WriteFile(u, nil, 0o600)
		os.Chtimes(u, later, later)
		pr := check(dir, exe)
		if !slices.Equal(pr.Git.Edited, []string{"src/main.go"}) || !slices.Equal(pr.Changes, []string{ChangedFiles}) {
			t.Fatalf("edited %v changes %v", pr.Git.Edited, pr.Changes)
		}
	})

	t.Run("changed by a rebuilt executable", func(t *testing.T) {
		dir, _, exe := gitRepo(t, base)
		os.Chtimes(exe, later, later)
		pr := check(dir, exe)
		if !slices.Equal(pr.Changes, []string{ChangedExe}) || !pr.ExeModified.Equal(later) {
			t.Fatalf("changes %v, exe modified %v", pr.Changes, pr.ExeModified)
		}
		// Built just before the start (within a second): not rebuilt.
		os.Chtimes(exe, start.Add(500*time.Millisecond), start.Add(500*time.Millisecond))
		if pr := check(dir, exe); len(pr.Changes) != 0 {
			t.Fatalf("within the slack: %v", pr.Changes)
		}
	})

	t.Run("outside a repository, and with no start time", func(t *testing.T) {
		out := t.TempDir()
		pr := &Process{PID: 1, Cwd: out, Started: start}
		CheckSource(context.Background(), pr)
		if pr.Git != nil || !pr.Checked || len(pr.Changes) != 0 {
			t.Fatalf("outside: %+v", pr)
		}
		dir, _, _ := gitRepo(t, base)
		pr = &Process{PID: 1, Cwd: dir}
		CheckSource(context.Background(), pr)
		if pr.Git == nil || pr.Git.StartedOn != "" || pr.Checked {
			t.Fatalf("no start: %+v", pr)
		}
	})
}

func TestReflogAt(t *testing.T) {
	a, b, c := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40)
	z := strings.Repeat("0", 40)
	log := z + " " + a + " Some One <one@example.com> 1000 +0100\tcommit (initial): first\n" +
		a + " " + b + " Some One <one@example.com> 2000 -0500\tcommit: second\n" +
		"garbage line\n" +
		b + " " + c + " Some One <one@example.com> 3000 +0000\tcheckout: moving from main to next\n"
	p := filepath.Join(t.TempDir(), "HEAD")
	os.WriteFile(p, []byte(log), 0o600)
	for at, want := range map[int64]string{999: "", 1000: a, 1999: a, 2000: b, 2500: b, 3000: c, 9999: c} {
		if got := reflogAt(p, time.Unix(at, 0)); got != want {
			t.Errorf("at %d: %q, want %q", at, got, want)
		}
	}
	if got := reflogAt(filepath.Join(t.TempDir(), "none"), time.Now()); got != "" {
		t.Errorf("no reflog: %q", got)
	}
}
