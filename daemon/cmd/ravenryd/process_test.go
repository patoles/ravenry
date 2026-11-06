package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/proto"
)

// `ravenry process` says what runs and whether its code changed since it
// started; `ravenry restart --command` starts the shell's command again
// in the same pane and prints the mark before it.
func TestProcessAndRestartCommand(t *testing.T) {
	shell := ""
	for _, sh := range []string{"/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"} {
		if _, err := os.Stat(sh); err == nil {
			shell = sh
			break
		}
	}
	if shell == "" {
		t.Skip("no zsh or bash")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	e := newEnv(t)
	home := strings.TrimPrefix(e.vars[0], "HOME=")
	for name, body := range map[string]string{
		".zshenv": "skip_global_compinit=1\n", ".zshrc": "PS1='$ '\n", ".bashrc": "PS1='$ '\n",
	} {
		os.WriteFile(filepath.Join(home, name), []byte(body), 0o600)
	}
	e.serve("0.1.0")

	base := time.Now().Add(-time.Hour).Truncate(time.Second)
	repo := filepath.Join(e.dir, "repo")
	os.Mkdir(repo, 0o700)
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		date := fmt.Sprintf("%d +0000", base.Unix())
		cmd.Env = append(append([]string{}, e.vars...), "GIT_CONFIG_NOSYSTEM=1", "LC_ALL=C",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test",
			"GIT_COMMITTER_EMAIL=test@example.com", "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "-b", "main")
	readme := filepath.Join(repo, "README")
	os.WriteFile(readme, []byte("hello\n"), 0o600)
	os.Chtimes(readme, base, base)
	git("add", "-A")
	git("commit", "-q", "-m", "first")
	head := git("rev-parse", "HEAD")[:12]

	id := jsonOut[proto.PaneResult](t, e.ok("0.1.0", "new", "--json", "--cwd", repo, "--", shell)).Pane.ID
	e.ok("0.1.0", "wait", id, "--prompt", "--since", "0", "--timeout", "10s")
	// bash: the first command after start may not be marked.
	mark := strings.TrimSpace(e.ok("0.1.0", "send", id, "--paste", "true", "--key", "Enter"))
	e.ok("0.1.0", "wait", id, "--prompt", "--since", mark, "--timeout", "10s")

	line := `echo up $((1+2)); sleep 30`
	mark = strings.TrimSpace(e.ok("0.1.0", "send", id, "--paste", line, "--key", "Enter"))
	e.ok("0.1.0", "wait", id, "--text", "up 3", "--since", mark, "--timeout", "10s")
	var out string
	for deadline := time.Now().Add(10 * time.Second); ; {
		out = e.ok("0.1.0", "process", id)
		if strings.Contains(out, "sleep 30") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sleep is not in the foreground:\n%s", out)
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, want := range []string{"\nhead\t" + head + " on main\n", "\nstarted-on\t" + head + "\n", "\nchanged\tno\n", "\nexe-modified\t"} {
		if !strings.Contains(out, want) {
			t.Fatalf("process: no %q in\n%s", want, out)
		}
	}

	// An edit after it started.
	later := time.Now().Add(time.Minute)
	os.WriteFile(readme, []byte("fixed\n"), 0o600)
	os.Chtimes(readme, later, later)
	out = e.ok("0.1.0", "process", id)
	if !strings.Contains(out, "\nchanged\tyes: tracked files were edited since it started; restart it to run the new code\n") ||
		!strings.Contains(out, "\nedited\tREADME\n") {
		t.Fatalf("process after an edit:\n%s", out)
	}
	pr := jsonOut[proto.ProcessResult](t, e.ok("0.1.0", "process", id, "--json"))
	if f := pr.Foreground; f.Changed == nil || !*f.Changed || len(f.Changes) != 1 || f.Changes[0] != "files" || f.Git == nil || f.Git.Edited[0] != "README" {
		t.Fatalf("process --json %+v", pr.Foreground)
	}

	// Restart the command: the same pane, the mark before the typed line.
	out = strings.TrimSpace(e.ok("0.1.0", "restart", id, "--command"))
	if _, err := strconv.ParseUint(out, 10, 64); err != nil {
		t.Fatalf("restart --command printed %q", out)
	}
	e.ok("0.1.0", "wait", id, "--text", "up 3", "--since", out, "--timeout", "10s")
	ls := jsonOut[[]map[string]any](t, e.ok("0.1.0", "ls", "--json"))
	if len(ls) != 1 || ls[0]["id"] != id {
		t.Fatalf("ls after restart --command %v", ls)
	}
	// At the prompt it fails, and says why.
	mark = strings.TrimSpace(e.ok("0.1.0", "send", id, "--key", "Ctrl+c"))
	e.ok("0.1.0", "wait", id, "--prompt", "--since", mark, "--timeout", "10s")
	if _, errs, code := e.run("0.1.0", "restart", id, "--command"); code != 1 || !strings.Contains(errs, "at its prompt") {
		t.Fatalf("restart --command at the prompt: %d %q", code, errs)
	}
}
