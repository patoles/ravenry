package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// ravenry is the binary under its people-and-agents name.
func (e *env) ravenry(version string, args ...string) *exec.Cmd {
	link := filepath.Join(e.dir, "bin-"+version, "ravenry")
	if _, err := os.Lstat(link); err != nil {
		os.MkdirAll(filepath.Dir(link), 0o700)
		if err := os.Symlink(bins[version], link); err != nil {
			e.t.Fatal(err)
		}
	}
	c := exec.Command(link, args...)
	c.Env = e.vars
	testenv.Check(e.t, c.Env)
	c.Dir = e.dir
	return c
}

func runCmd(t *testing.T, c *exec.Cmd) (string, string, int) {
	t.Helper()
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	err := c.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), errb.String(), ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return out.String(), errb.String(), 0
}

func TestTwoNamesAndTheSkill(t *testing.T) {
	e := newEnv(t)
	people, _, _ := runCmd(t, e.ravenry("0.2.0", "help"))
	service := e.ok("0.2.0", "help")
	if !strings.Contains(people, "ravenry ask TITLE") || strings.Contains(people, "ravenry serve") {
		t.Fatalf("ravenry help:\n%s", people)
	}
	if !strings.Contains(service, "ravenryd serve") || !strings.Contains(service, "ravenryd hook") || strings.Contains(service, "ravenryd ask") {
		t.Fatalf("ravenryd help:\n%s", service)
	}
	skill, _, code := runCmd(t, e.ravenry("0.2.0", "skill"))
	if code != 0 || !strings.Contains(skill, "0.2.0") {
		t.Fatalf("skill exit %d", code)
	}
	// Every command an agent types, with every flag it accepts, is in the
	// skill: both come from the same table.
	for _, c := range commands {
		if c.service || c.name == "help" {
			continue
		}
		if !strings.Contains(skill, "`ravenry "+c.name) {
			t.Errorf("the skill misses %s", c.name)
		}
		for _, f := range c.flags {
			if !strings.Contains(skill, "`--"+f.name) {
				t.Errorf("the skill misses %s --%s", c.name, f.name)
			}
		}
	}
	if strings.ContainsRune(skill, '—') {
		t.Error("the skill has an em dash")
	}
	// The old form still works.
	e.ok("0.2.0", "ls", "--json")
}

// person answers the one open checkpoint the way an app would.
func person(t *testing.T, e *env, answer func(cp proto.Checkpoint) map[string]any) proto.Checkpoint {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	sock := filepath.Join(e.dir, "run", "ravenryd-0.2.0.sock")
	var c *client.Client
	for {
		var err error
		if c, err = client.Dial(ctx, sock, client.Options{Name: "test-person"}); err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer c.Close()
	for {
		var l proto.CheckpointListResult
		if err := c.Call(ctx, "checkpoint.list", map[string]any{}, &l); err != nil {
			t.Fatal(err)
		}
		if len(l.Checkpoints) == 1 {
			cp := l.Checkpoints[0]
			params := answer(cp)
			params["checkpoint"] = cp.ID
			var r proto.CheckpointResult
			if err := c.Call(ctx, "checkpoint.answer", params, &r); err != nil {
				t.Fatal(err)
			}
			return cp
		}
		if ctx.Err() != nil {
			t.Fatal("no checkpoint opened")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func startCmd(t *testing.T, c *exec.Cmd) func() (string, int) {
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = &out
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	return func() (string, int) {
		err := c.Wait()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return out.String(), ee.ExitCode()
		}
		return out.String(), 0
	}
}

func TestCheckpointCommands(t *testing.T) {
	e := newEnv(t)
	e.serve("0.2.0")

	done := startCmd(t, e.ravenry("0.2.0", "ask", "--wait", "Put on the headset", "--option", "Done", "--option", "Didn't work"))
	cp := person(t, e, func(proto.Checkpoint) map[string]any { return map[string]any{"choice": 1} })
	if out, code := done(); code != 0 || !strings.HasSuffix(out, "Didn't work\n") || cp.Options[1] != "Didn't work" {
		t.Fatalf("ask: %d %q", code, out)
	}

	done = startCmd(t, e.ravenry("0.2.0", "approve", "echo approved-run; exit 4", "--why", "a test"))
	cp = person(t, e, func(proto.Checkpoint) map[string]any { return map[string]any{"approve": true} })
	if out, code := done(); code != 4 || !strings.Contains(out, "approved-run") || cp.Command != "echo approved-run; exit 4" || cp.Why != "a test" {
		t.Fatalf("approve: %d %q %+v", code, out, cp)
	}

	done = startCmd(t, e.ravenry("0.2.0", "approve", "--cwd", e.dir, "--", "touch", "never ran"))
	cp = person(t, e, func(proto.Checkpoint) map[string]any { return map[string]any{"decline": true} })
	if out, code := done(); code != exitDeclined || cp.Command != "touch 'never ran'" {
		t.Fatalf("declined: %d %q %q", code, out, cp.Command)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "never ran")); err == nil {
		t.Fatal("a declined command ran")
	}

	// The agent's warning; the person edits the command, and the agent is
	// told it changed, with what ran; the proposed one never runs.
	done = startCmd(t, e.ravenry("0.2.0", "approve", "touch proposed-ran", "--cwd", e.dir, "--warn", "Publishing to npm can't be undone"))
	cp = person(t, e, func(proto.Checkpoint) map[string]any {
		return map[string]any{"approve": true, "command": "touch edited-ran && echo edited-output"}
	})
	if out, code := done(); code != 0 || !strings.Contains(out, "a person edited the command before approving it; it ran as:\ntouch edited-ran && echo edited-output") || !strings.Contains(out, "edited-output") || cp.Warning != "Publishing to npm can't be undone" {
		t.Fatalf("edited: %d %q %+v", code, out, cp)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "edited-ran")); err != nil {
		t.Fatal("the edited command did not run")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "proposed-ran")); err == nil {
		t.Fatal("the proposed command ran instead of the edited one")
	}
	// A decline with the person's reason.
	done = startCmd(t, e.ravenry("0.2.0", "approve", "touch never-ran-2", "--cwd", e.dir))
	person(t, e, func(proto.Checkpoint) map[string]any {
		return map[string]any{"decline": true, "reason": "Run the tests first"}
	})
	if out, code := done(); code != exitDeclined || !strings.Contains(out, ": Run the tests first") {
		t.Fatalf("declined with a reason: %d %q", code, out)
	}

	done = startCmd(t, e.ravenry("0.2.0", "secret", "Mail service API key", "--", "sh", "-c", "printf 'Enter a secret value: '; read v; echo stored-$v"))
	cp = person(t, e, func(proto.Checkpoint) map[string]any { return map[string]any{"secret": "abcd-1234-key"} })
	if out, code := done(); code != 0 || !strings.Contains(out, "stored-*************") || strings.Contains(out, "abcd-1234") || cp.Secret.To != "run" {
		t.Fatalf("secret: %d %q", code, out)
	}

	if out, _, code := runCmd(t, e.ravenry("0.2.0", "ask", "Anyone?", "--timeout", "200ms")); code != exitTimeout {
		t.Fatalf("timeout: %d %q", code, out)
	}
	id, _, code := runCmd(t, e.ravenry("0.2.0", "ask", "Later", "--no-wait"))
	if code != 0 || !strings.HasPrefix(id, "c") {
		t.Fatalf("no-wait: %d %q", code, id)
	}
	id = strings.TrimSpace(id)
	runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--cancel", "--reason", "not needed"))
	if _, _, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--wait")); code != exitDeclined {
		t.Fatalf("cancelled wait: %d", code)
	}
	if out := e.ok("0.2.0", "checkpoints", "--all", "--json"); !strings.Contains(out, id) {
		t.Fatalf("checkpoints: %s", out)
	}

	// The person answered in the terminal instead, and the hub withdrew the
	// card: the waiting ask exits 123 and says to read their message, not
	// that they declined.
	done = startCmd(t, e.ravenry("0.2.0", "ask", "Build it or not?", "--option", "Build it", "--option", "Not yet"))
	withdrawInTerminal(t, e)
	if out, code := done(); code != exitAnsweredInTerminal || !strings.Contains(out, "the person answered you in the terminal instead") || !strings.Contains(out, "read their message") || strings.Contains(out, "declined") {
		t.Fatalf("answered in the terminal: %d %q", code, out)
	}
}

// withdrawInTerminal withdraws the one open checkpoint as the hub does when
// the person answered the agent in its terminal.
func withdrawInTerminal(t *testing.T, e *env) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, filepath.Join(e.dir, "run", "ravenryd-0.2.0.sock"), client.Options{Name: "test-hub"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for {
		var l proto.CheckpointListResult
		if err := c.Call(ctx, "checkpoint.list", map[string]any{}, &l); err != nil {
			t.Fatal(err)
		}
		if len(l.Checkpoints) == 1 {
			var r proto.CheckpointResult
			if err := c.Call(ctx, "checkpoint.cancel", map[string]any{"checkpoint": l.Checkpoints[0].ID, "reason": "the person answered you in the terminal instead", "answered_in": "terminal"}, &r); err != nil {
				t.Fatal(err)
			}
			return
		}
		if ctx.Err() != nil {
			t.Fatal("no checkpoint opened")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Only a person answers (PROTOCOL.md section 4, Who acts as the person):
// `ravenry checkpoint ID --approve` from inside a pane says so and changes
// nothing; over ssh without the hub's key the daemon refuses it; from the
// test process, a terminal outside every pane, it answers.
func TestOnlyAPersonAnswersFromTheCommandLine(t *testing.T) {
	e := newEnv(t)
	e.serve("0.2.0")
	link := e.ravenry("0.2.0").Path
	id, _, code := runCmd(t, e.ravenry("0.2.0", "approve", "touch ran", "--cwd", e.dir, "--no-wait"))
	id = strings.TrimSpace(id)
	if code != 0 || !strings.HasPrefix(id, "c") {
		t.Fatalf("approve --no-wait: %d %q", code, id)
	}
	state := func() string {
		cp := jsonOut[proto.Checkpoint](t, e.ok("0.2.0", "checkpoint", id))
		return cp.State
	}
	p := jsonOut[proto.PaneResult](t, e.ok("0.2.0", "new", "--json", "--size", "300x10", "--", "/bin/sh", "-c",
		"'"+link+"' checkpoint "+id+" --approve; echo \"exit=$?\"; exec sleep 30"))
	e.ok("0.2.0", "wait", p.Pane.ID, "--text", `exit=\d`, "--since", "0", "--timeout", "10s")
	if out := e.ok("0.2.0", "capture", p.Pane.ID); !strings.Contains(out, "only a person can answer "+id+", in the Ravenry app or on the phone") || !strings.Contains(out, "exit=1") {
		t.Fatalf("from a pane:\n%s", out)
	}
	if s := state(); s != "open" {
		t.Fatalf("after the pane tried: %s", s)
	}
	// Outside every pane but over ssh, with no answer key: the daemon
	// refuses it.
	c := e.ravenry("0.2.0", "checkpoint", id, "--approve")
	c.Env = append(append([]string{}, e.vars...), "SSH_CONNECTION=10.0.0.1 50000 10.0.0.2 22")
	if _, errs, code := runCmd(t, c); code != 1 || !strings.Contains(errs, "the daemon refused this one") || !strings.Contains(errs, "ssh") {
		t.Fatalf("over ssh: %d %q", code, errs)
	}
	if s := state(); s != "open" {
		t.Fatalf("after ssh tried: %s", s)
	}
	// The person, at a terminal.
	if out, errs, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--approve")); code != 0 || strings.TrimSpace(out) != "running" {
		t.Fatalf("the person: %d %q %q", code, out, errs)
	}
	if _, _, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--wait", "--timeout", "10s")); code != 0 {
		t.Fatalf("the approved command: %d", code)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "ran")); err != nil {
		t.Fatal("the approved command did not run")
	}
	// The person edits it at the terminal, or declines with a reason.
	id, _, _ = runCmd(t, e.ravenry("0.2.0", "approve", "touch not-this", "--cwd", e.dir, "--no-wait"))
	id = strings.TrimSpace(id)
	if out, errs, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--approve", "--command", "touch this-instead")); code != 0 || strings.TrimSpace(out) != "running" {
		t.Fatalf("edited at the terminal: %d %q %q", code, out, errs)
	}
	runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--wait", "--timeout", "10s"))
	if _, err := os.Stat(filepath.Join(e.dir, "this-instead")); err != nil {
		t.Fatal("the command edited at the terminal did not run")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "not-this")); err == nil {
		t.Fatal("the proposed command ran")
	}
	id, _, _ = runCmd(t, e.ravenry("0.2.0", "approve", "true", "--no-wait"))
	id = strings.TrimSpace(id)
	if out, _, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--decline", "--reason", "Not today", "--json")); code != 0 || jsonOut[proto.CheckpointResult](t, out).Checkpoint.Answer.Reason != "Not today" {
		t.Fatalf("decline with a reason: %d %s", code, out)
	}
	// An ask, by an option's text; a secret is never typed here.
	id, _, _ = runCmd(t, e.ravenry("0.2.0", "ask", "Ready?", "--option", "Yes", "--option", "Not yet", "--no-wait"))
	id = strings.TrimSpace(id)
	if out, _, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--answer", "Not yet", "--json")); code != 0 || jsonOut[proto.CheckpointResult](t, out).Checkpoint.Answer.Option != "Not yet" {
		t.Fatalf("ask: %d %s", code, out)
	}
	id, _, _ = runCmd(t, e.ravenry("0.2.0", "secret", "Token", "--no-wait", "--", "sh", "-c", "read v"))
	id = strings.TrimSpace(id)
	if _, errs, code := runCmd(t, e.ravenry("0.2.0", "checkpoint", id, "--answer", "hunter22")); code != 1 || !strings.Contains(errs, "never on a command line") {
		t.Fatalf("secret: %d %q", code, errs)
	}
}
