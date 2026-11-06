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

	done = startCmd(t, e.ravenry("0.2.0", "approve", "--", "touch", "never ran"))
	cp = person(t, e, func(proto.Checkpoint) map[string]any { return map[string]any{"decline": true} })
	if out, code := done(); code != exitDeclined || cp.Command != "touch 'never ran'" {
		t.Fatalf("declined: %d %q %q", code, out, cp.Command)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "never ran")); err == nil {
		t.Fatal("a declined command ran")
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
}
