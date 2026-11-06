package server

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// pane.process says what runs and whether its code changed since it
// started (a commit, a rebuilt executable), and pane.restart with
// shell_command starts the shell's command again in the same pane, after
// which nothing has changed.
func TestProcessChangedAndCommandRestart(t *testing.T) {
	shell := ""
	for _, sh := range []string{"zsh", "bash"} {
		if p, err := exec.LookPath(sh); err == nil {
			shell = p
			break
		}
	}
	if shell == "" {
		t.Skip("no zsh or bash")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	// git as the daemon runs it reads HOME's config: a test's.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	shells := filepath.Join(t.TempDir(), "shell")
	testenv.CheckDirs(t, shells)
	d := startDaemon(t, func(o *pane.ManagerOptions) { o.ShellDir = shells })
	for name, body := range map[string]string{
		".zshenv": "skip_global_compinit=1\n", ".zshrc": "PS1='$ '\n", ".bashrc": "PS1='$ '\n",
	} {
		os.WriteFile(filepath.Join(d.home, name), []byte(body), 0o600)
	}
	c := d.dial(client.Options{})

	// A repository with one commit an hour ago, and a server binary built
	// then.
	base := time.Now().Add(-time.Hour).Truncate(time.Second)
	repo := filepath.Join(d.dir, "repo")
	os.Mkdir(repo, 0o700)
	git := func(at time.Time, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		date := fmt.Sprintf("%d +0000", at.Unix())
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + d.home, "GIT_CONFIG_NOSYSTEM=1", "LC_ALL=C",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test",
			"GIT_COMMITTER_EMAIL=test@example.com", "GIT_AUTHOR_DATE=" + date, "GIT_COMMITTER_DATE=" + date}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(base, "init", "-q", "-b", "main")
	readme := filepath.Join(repo, "README")
	os.WriteFile(readme, []byte("hello\n"), 0o600)
	os.Chtimes(readme, base, base)
	git(base, "add", "-A")
	git(base, "commit", "-q", "-m", "first")
	first := git(base, "rev-parse", "HEAD")
	server := filepath.Join(d.dir, "bin", "server")
	os.Mkdir(filepath.Dir(server), 0o700)
	// This test binary, which sleeps as testprog's "sleep" (a copy of a
	// system binary does not run on macOS).
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	copyFile(t, self, server)
	os.Chtimes(server, base, base)
	var started time.Time

	p := newPane(t, c, map[string]any{"command": []string{shell}, "cwd": repo, "cols": 200, "rows": 24})
	w := call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "prompt": true, "since": 0, "timeout_ms": 10000})
	if w.Condition != "prompt" {
		t.Fatalf("no prompt: %+v", w)
	}
	// bash: the first command after start may not be marked.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "true", "mode": "paste"}, {"key": "Enter"}}})
	call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "prompt": true, "timeout_ms": 10000})
	// At its prompt there is no command to restart.
	if e := callErr(t, c, "pane.restart", map[string]any{"pane": p.ID, "shell_command": true}); e.Code != proto.CodeFailed || !strings.Contains(e.Message, "prompt") {
		t.Fatalf("at the prompt: %s %s", e.Code, e.Message)
	}

	line := "RAVENRY_TESTPROG=sleep " + server
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": line, "mode": "paste"}, {"key": "Enter"}}})
	f := foregroundOf(t, c, p.ID, server, 0)
	if f.ExeModifiedAt != stamp(base) || f.Git == nil || f.Git.Head != first || f.Git.Branch != "main" || f.Git.StartedOn != first ||
		f.Changed == nil || *f.Changed || len(f.Changes) != 0 {
		t.Fatalf("unchanged %+v git %+v", f, f.Git)
	}
	if real, _ := filepath.EvalSymlinks(repo); f.Git.Root != repo && f.Git.Root != real {
		t.Fatalf("root %q, want %q", f.Git.Root, repo)
	}
	started, err = time.Parse(time.RFC3339Nano, f.StartedAt)
	if err != nil {
		t.Fatal(err)
	}

	// A commit and a rebuild after it started. (Linux gives the start to
	// a second: wait past it, so the commit's reflog entry is after.)
	time.Sleep(time.Until(started.Add(2600 * time.Millisecond)))
	git(time.Now(), "commit", "-q", "--allow-empty", "-m", "fix")
	second := git(base, "rev-parse", "HEAD")
	rebuilt := started.Add(1500 * time.Millisecond)
	os.Chtimes(server, rebuilt, rebuilt)
	f = foregroundOf(t, c, p.ID, server, 0)
	if f.Changed == nil || !*f.Changed || !slices.Equal(f.Changes, []string{"head", "exe"}) || f.Git.StartedOn != first || f.Git.Head != second {
		t.Fatalf("after a commit and a rebuild %+v git %+v", f, f.Git)
	}

	// Restart the command in the same pane; it then runs the new code.
	time.Sleep(1100 * time.Millisecond)
	rs := call[proto.RestartResult](t, c, "pane.restart", map[string]any{"pane": p.ID, "shell_command": true, "grace_ms": 2000})
	if rs.Pane.ID != p.ID || rs.Replaced.ID != p.ID || rs.Command != line || rs.Mark == nil || rs.StoppedBy != "interrupt" {
		t.Fatalf("restart %+v", rs)
	}
	g := foregroundOf(t, c, p.ID, server, f.PID)
	if g.Changed == nil || *g.Changed || g.Git.StartedOn != second || g.Git.Head != second {
		t.Fatalf("after the restart %+v git %+v", g, g.Git)
	}

	// A pane with no shell marks cannot restart a command.
	q := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}})
	if e := callErr(t, c, "pane.restart", map[string]any{"pane": q.ID, "shell_command": true}); e.Code != proto.CodeFailed {
		t.Fatalf("no marks: %s %s", e.Code, e.Message)
	}
}

// foregroundOf waits until exe runs in the pane's foreground (as another
// process than not, when not is set) and returns pane.process's answer.
func foregroundOf(t *testing.T, c *client.Client, id, exe string, not int) proto.Process {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		pr := call[proto.ProcessResult](t, c, "pane.process", map[string]any{"pane": id})
		f := pr.Foreground
		if len(f.Argv) > 0 && f.Argv[0] == exe && f.PID != not {
			if f.Exe != exe {
				if a, _ := filepath.EvalSymlinks(f.Exe); a != exe {
					if b, _ := filepath.EvalSymlinks(exe); a != b {
						t.Fatalf("exe %q, want %q", f.Exe, exe)
					}
				}
			}
			return f
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s does not run in the foreground: %+v", exe, f)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	in, err := os.Open(from)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}
