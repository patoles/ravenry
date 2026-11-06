package pane

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// RerunCommand in a zsh and a bash pane with shell integration: the
// command the shell runs is interrupted and typed again, in the same pane.
func TestRerunCommand(t *testing.T) {
	ran := 0
	for _, sh := range []string{"zsh", "bash"} {
		path, err := exec.LookPath(sh)
		if err != nil {
			t.Logf("%s: not installed, skipped", sh)
			continue
		}
		ran++
		t.Run(sh, func(t *testing.T) {
			home := shellHome(t)
			m := shellManager(t, home, path)
			dir := t.TempDir()
			p := newPane(t, m, Config{Command: []string{path}, Cwd: dir, Cols: 200})
			if r, err := p.Wait(context.Background(), WaitSpec{Prompt: true, Since: new(uint64), Timeout: 10 * time.Second}, nil); err != nil || r.Condition != "prompt" {
				t.Fatalf("no marked first prompt: %v %+v", err, r)
			}
			// At its prompt: nothing to restart.
			run(t, p, "true")
			if _, err := p.RerunCommand(context.Background(), time.Second); !errors.Is(err, ErrAtPrompt) {
				t.Fatalf("at the prompt: %v", err)
			}

			// A command that writes a line each time it starts, and runs on.
			log := filepath.Join(dir, "starts")
			line := `echo started >> starts; echo "server $((1+1)) up"; sleep 30`
			mark := p.Mark()
			if err := p.Input([]byte(line + "\r")); err != nil {
				t.Fatal(err)
			}
			waitText(t, p, "server 2 up", mark)
			runningAs(t, p, line)
			pid := foregroundPID(t, p)

			rr, err := p.RerunCommand(context.Background(), 2*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if rr.Command != line || rr.StoppedBy != "interrupt" {
				t.Fatalf("rerun %+v", rr)
			}
			waitText(t, p, "server 2 up", rr.Mark)
			runningAs(t, p, line)
			if b, _ := os.ReadFile(log); string(b) != "started\nstarted\n" {
				t.Fatalf("starts %q", b)
			}
			if again := foregroundPID(t, p); again == pid {
				t.Fatalf("the same process runs: %d", again)
			}

			// A command that ignores Ctrl-C ends by SIGTERM within the grace.
			stubborn := `sh -c 'trap "" INT; echo stubborn $((2+2)); while :; do sleep 0.1; done'`
			mark = p.Mark()
			p.Input([]byte("\x03"))
			if _, err := p.Wait(context.Background(), WaitSpec{Prompt: true, Since: &mark, Timeout: 10 * time.Second}, nil); err != nil {
				t.Fatal(err)
			}
			mark = p.Mark()
			p.Input([]byte(stubborn + "\r"))
			waitText(t, p, "stubborn 4", mark)
			runningAs(t, p, stubborn)
			began := time.Now()
			rr, err = p.RerunCommand(context.Background(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if rr.StoppedBy != "SIGTERM" || rr.Command != stubborn || time.Since(began) > 5*time.Second {
				t.Fatalf("rerun %+v after %v", rr, time.Since(began))
			}
			waitText(t, p, "stubborn 4", rr.Mark)
			// The shell itself was never signalled.
			if info := p.Info(); !info.Running() {
				t.Fatalf("the shell ended: %+v", info.Exit)
			}
		})
	}
	if ran == 0 {
		t.Skip("no zsh or bash")
	}
}

// A pane with no shell integration has no command line to type again.
func TestRerunCommandNeedsShellMarks(t *testing.T) {
	m := newManager(t)
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", "exec cat"}})
	if _, err := p.RerunCommand(context.Background(), time.Second); !errors.Is(err, ErrNoShellMarks) {
		t.Fatalf("no marks: %v", err)
	}
	// A shell that marks a command without its command line.
	q := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", `printf '\033]133;A\007$ \033]133;B\007\033]133;C\007'; exec cat`}})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if sh := q.Info().Shell; sh != nil && sh.State == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no C mark: %+v", q.Info().Shell)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := q.RerunCommand(context.Background(), time.Second); !errors.Is(err, ErrNoCmdline) {
		t.Fatalf("no command line: %v", err)
	}
}

// runningAs waits until the shell reports it runs line.
func runningAs(t *testing.T, p *Pane, line string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		sh := p.Info().Shell
		if sh != nil && sh.State == "running" && sh.Command == line {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the shell does not run %q: %+v", line, sh)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// foregroundPID waits until something other than the shell runs in the
// foreground, and returns its pid.
func foregroundPID(t *testing.T, p *Pane) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		fg, err := p.Foreground()
		if err == nil && fg.PID != p.pid && len(fg.Argv) > 0 && !strings.HasSuffix(fg.Argv[0], "sh") {
			return fg.PID
		}
		if time.Now().After(deadline) {
			t.Fatalf("no command in the foreground: %+v %v", fg, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
