package server

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testprog"
)

// Who drives a pane (PROTOCOL.md section 4, Panes and who drives them):
// an agent drives the panes it created and asks for any other; the person
// answers once or for its session; every input is logged with its source;
// a lease keeps a pane to one driver, but never holds the person back.

// agentPane starts the test binary as an agent inside a pane, running
// steps ("METHOD JSON" lines, see testprog).
func agentPane(t *testing.T, c *client.Client, steps ...string) proto.Pane {
	t.Helper()
	argv, env := testprog.Command("agent")
	env["RAVENRY_TESTPROG_STEPS"] = strings.Join(steps, "\n")
	return newPane(t, c, map[string]any{"command": argv, "env": env, "name": "agent"})
}

func stepLine(t *testing.T, c *client.Client, pane string, n int) string {
	t.Helper()
	w := waitFor(t, c, pane, fmt.Sprintf(`step %d [^\r\n]*`, n), 0)
	return strings.TrimSpace(*w.Match)
}

func openDrive(t *testing.T, c *client.Client, target, agent string) proto.Checkpoint {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, cp := range call[proto.CheckpointListResult](t, c, "checkpoint.list", map[string]any{}).Checkpoints {
			if cp.Kind == "drive" && cp.Drive != nil && cp.Drive.Pane == target && cp.Drive.Agent.Pane == agent {
				return cp
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no drive checkpoint for %s from %s", target, agent)
	return proto.Checkpoint{}
}

func inputs(t *testing.T, c *client.Client, pane string) []proto.InputRecord {
	t.Helper()
	return call[proto.InputsResult](t, c, "pane.inputs", map[string]any{"pane": pane}).Inputs
}

func TestAgentDrivesItsOwnPanesAndAsksForOthers(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	call[proto.Empty](t, person, "events.subscribe", map[string]any{})
	target := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "name": "the person's shell"})
	if target.Creator == nil || target.Creator.Kind != "person" {
		t.Fatalf("a pane the person started: creator %+v", target.Creator)
	}
	send := func(pane, text string, extra string) string {
		return fmt.Sprintf(`pane.send {"pane":%q,"input":[{"text":%q,"mode":"raw"}]%s}`, pane, text, extra)
	}
	agent := agentPane(t, person,
		`pane.new {"command":["/bin/cat"]}`,
		send("$PANE", "mine\r", ""),
		send(target.ID, "first\r", `,"no_wait":true`),
		send(target.ID, "second\r", ""),
		send(target.ID, "third\r", ""),
		fmt.Sprintf(`pane.lease {"pane":%q,"ttl_ms":60000}`, target.ID),
		fmt.Sprintf(`pane.revoke {"grant":"gnothing"}`),
	)
	// Its own pane: no question.
	if l := stepLine(t, person, agent.ID, 1); !strings.HasPrefix(l, "step 1 ok") {
		t.Fatalf("an agent typing into its own pane: %s", l)
	}
	l0 := stepLine(t, person, agent.ID, 0)
	var made struct{ Pane proto.Pane }
	json.Unmarshal([]byte(strings.TrimPrefix(l0, "step 0 ok ")), &made)
	if made.Pane.Creator == nil || made.Pane.Creator.Kind != "agent" || made.Pane.Creator.Pane != agent.ID {
		t.Fatalf("a pane the agent started: %s", l0)
	}
	// Another's pane: refused at once with no_wait, with the checkpoint.
	l2 := stepLine(t, person, agent.ID, 2)
	if !regexp.MustCompile(`^step 2 forbidden c\w{7}$`).MatchString(l2) {
		t.Fatalf("an agent typing into the person's pane with no_wait: %s", l2)
	}
	cp := openDrive(t, person, target.ID, agent.ID)
	if cp.ID != strings.Fields(l2)[3] || cp.Drive.Agent.Kind != "agent" || !strings.Contains(cp.Title, "the person's shell") {
		t.Fatalf("the drive checkpoint: %+v (refusal %s)", cp, l2)
	}
	// The input never went in.
	for _, in := range inputs(t, person, target.ID) {
		t.Fatalf("input reached the pane before the person answered: %+v", in)
	}
	// An agent cannot answer it.
	other := agentPane(t, person, fmt.Sprintf(`checkpoint.answer {"checkpoint":%q,"approve":true,"allow":"session"}`, cp.ID))
	if l := stepLine(t, person, other.ID, 0); l != "step 0 forbidden" {
		t.Fatalf("an agent answering a drive: %s", l)
	}
	// The person lets it, for its session; the waiting send goes through.
	answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "allow": "session", "by": "desktop"})
	if l := stepLine(t, person, agent.ID, 3); !strings.HasPrefix(l, "step 3 ok") {
		t.Fatalf("the send waiting for the person: %s", l)
	}
	if l := stepLine(t, person, agent.ID, 4); !strings.HasPrefix(l, "step 4 ok") {
		t.Fatalf("the next send, with a grant: %s", l)
	}
	waitFor(t, person, target.ID, `third`, 0)
	// It holds the lease now; a second driver is refused.
	if l := stepLine(t, person, agent.ID, 5); !strings.HasPrefix(l, "step 5 ok") || !strings.Contains(l, agent.ID) {
		t.Fatalf("the lease: %s", l)
	}
	nextEvent(t, person, "pane.lease", func(ev proto.Event) bool { return ev.Pane.ID == target.ID && ev.Pane.Lease != nil })
	if l := stepLine(t, person, agent.ID, 6); l != "step 6 forbidden" {
		t.Fatalf("an agent revoking a grant: %s", l)
	}
	second := agentPane(t, person, send(target.ID, "fourth\r", `,"no_wait":true`), fmt.Sprintf(`pane.lease {"pane":%q,"no_wait":true}`, target.ID))
	if l := stepLine(t, person, second.ID, 0); l != "step 0 leased" {
		t.Fatalf("a second driver while the lease is held: %s", l)
	}
	// The person is never held back by a lease: the typing is marked.
	call[proto.SendResult](t, person, "pane.send", map[string]any{"pane": target.ID, "input": []map[string]any{{"text": "from the person\r", "mode": "raw"}}, "by": "composer"})
	waitFor(t, person, target.ID, `from the person`, 0)
	ins := inputs(t, person, target.ID)
	if len(ins) != 3 {
		t.Fatalf("the input log: %+v", ins)
	}
	for i, want := range []string{"second<Enter>", "third<Enter>", "from the person<Enter>"} {
		if ins[i].Text != want || ins[i].Kind != "send" {
			t.Fatalf("input %d: %+v", i, ins[i])
		}
	}
	if s := ins[0].Source; s.Kind != "agent" || s.Pane != agent.ID {
		t.Fatalf("the agent's input is not tagged with its pane: %+v", s)
	}
	if s := ins[2].Source; s.Kind != "person" || s.By != "composer" || ins[2].LeaseHolder == nil || ins[2].LeaseHolder.Pane != agent.ID {
		t.Fatalf("the person's input under the agent's lease: %+v", ins[2])
	}
	ev := nextEvent(t, person, "pane.input", func(ev proto.Event) bool { return ev.Input != nil && ev.Input.Source.Kind == "person" })
	if ev.Pane == nil || ev.Pane.ID != target.ID {
		t.Fatalf("pane.input: %+v", ev)
	}
	// The grant, and the person revokes it.
	gs := call[proto.GrantsResult](t, person, "pane.grants", map[string]any{"pane": target.ID}).Grants
	if len(gs) != 1 || gs[0].Agent.Pane != agent.ID || gs[0].Allow != "session" || gs[0].Checkpoint != cp.ID {
		t.Fatalf("grants: %+v", gs)
	}
	call[proto.RevokeResult](t, person, "pane.revoke", map[string]any{"grant": gs[0].ID})
	if gs := call[proto.GrantsResult](t, person, "pane.grants", map[string]any{}).Grants; len(gs) != 0 {
		t.Fatalf("after revoke: %+v", gs)
	}
	// The lease goes with the agent's pane; the person can end it too.
	call[proto.LeaseResult](t, person, "pane.lease", map[string]any{"pane": target.ID, "release": true})
	nextEvent(t, person, "pane.lease", func(ev proto.Event) bool { return ev.Pane.ID == target.ID && ev.Pane.Lease == nil })
	// Keystrokes from a display are the person's, gathered into one record.
	sub := call[proto.SubscribeResult](t, person, "pane.subscribe", map[string]any{"pane": target.ID})
	for _, k := range []string{"l", "s", "\r"} {
		frame := proto.AppendFrame(nil, proto.FrameInput, sub.Channel, 0)
		if err := person.WriteBinary(ctx(t), append(frame, k...)); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, person, target.ID, `ls`, 0)
	ins = inputs(t, person, target.ID)
	if last := ins[len(ins)-1]; last.Kind != "keys" || last.Text != "ls<Enter>" || last.Source.Kind != "person" || last.Bytes != 3 {
		t.Fatalf("keystrokes: %+v", last)
	}
}

func TestDriveOnceAndDecline(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	target := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}})
	send := fmt.Sprintf(`pane.send {"pane":%q,"input":[{"key":"Enter"}]}`, target.ID)
	agent := agentPane(t, person, send, send)
	cp := openDrive(t, person, target.ID, agent.ID)
	answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true})
	if l := stepLine(t, person, agent.ID, 0); !strings.HasPrefix(l, "step 0 ok") {
		t.Fatalf("approved once: %s", l)
	}
	// Once is once: the next input asks again, and a no is a no.
	cp2 := openDrive(t, person, target.ID, agent.ID)
	if cp2.ID == cp.ID {
		t.Fatal("the same checkpoint again")
	}
	answer(t, person, map[string]any{"checkpoint": cp2.ID, "decline": true, "reason": "not that one"})
	if l := stepLine(t, person, agent.ID, 1); l != "step 1 forbidden "+cp2.ID {
		t.Fatalf("declined: %s", l)
	}
	if gs := call[proto.GrantsResult](t, person, "pane.grants", map[string]any{}).Grants; len(gs) != 0 {
		t.Fatalf("a once leaves no grant: %+v", gs)
	}
}

// The files an agent touched: from its PostToolUse hook (paths only), and
// git status in its folder.
func TestFilesTouched(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	repo := filepath.Join(d.dir, "repo")
	os.Mkdir(repo, 0o700)
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = []string{"HOME=" + d.home, "PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git: %v %s", err, out)
		}
	}
	os.WriteFile(filepath.Join(repo, "new.txt"), []byte("x"), 0o600)
	p := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "cwd": repo})
	call[proto.AgentReportResult](t, person, "agent.report", map[string]any{
		"pane": p.ID, "assistant": "claude", "event": "PostToolUse",
		"data": map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Write", "cwd": repo,
			"tool_input": map[string]any{"file_path": "src/a.go", "content": "SECRET CONTENT"}},
	})
	call[proto.AgentReportResult](t, person, "agent.report", map[string]any{
		"pane": p.ID, "assistant": "codex", "event": "PostToolUse",
		"data": map[string]any{"hook_event_name": "PostToolUse", "tool_name": "apply_patch",
			"tool_input": map[string]any{"command": []any{"apply_patch", "*** Begin Patch\n*** Update File: /abs/b.go\n@@\n-x\n+y\n*** End Patch"}}},
	})
	evs := call[proto.AgentEventsResult](t, person, "agent.events", map[string]any{"pane": p.ID})
	for _, r := range evs.Reports {
		if strings.Contains(string(r.Data), "SECRET") || strings.Contains(string(r.Data), "+y") {
			t.Fatalf("a report kept a tool's input: %s", r.Data)
		}
	}
	fs := call[proto.FilesResult](t, person, "pane.files", map[string]any{"pane": p.ID})
	got := map[string]string{}
	for _, f := range fs.Files {
		got[f.Path] = strings.Join(f.Sources, ",")
	}
	real, _ := filepath.EvalSymlinks(repo)
	if got[filepath.Join(repo, "src/a.go")] != "hook" || got["/abs/b.go"] != "hook" {
		t.Fatalf("files from the hooks: %v", got)
	}
	if got[filepath.Join(real, "new.txt")] != "git" && got[filepath.Join(repo, "new.txt")] != "git" {
		t.Fatalf("files from git: %v (root %s)", got, fs.GitRoot)
	}
	if fs := call[proto.FilesResult](t, person, "pane.files", map[string]any{"pane": p.ID, "no_git": true}); len(fs.Files) != 2 || fs.GitRoot != "" {
		t.Fatalf("without git: %+v", fs)
	}
}

// Closing, restarting or setting test conditions on a pane outside the
// agent's own asks the person the same way; its own panes it closes freely.
func TestAgentAsksToCloseRestartOrOverride(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	target := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "name": "dev server"})
	other := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}})
	agent := agentPane(t, person,
		`pane.new {"command":["/bin/cat"]}`,
		`pane.close {"pane":"$PANE"}`,
		fmt.Sprintf(`pane.close {"pane":%q,"no_wait":true}`, target.ID),
		fmt.Sprintf(`pane.restart {"pane":%q,"no_wait":true}`, target.ID),
		fmt.Sprintf(`pane.restart {"pane":%q,"shell_command":true,"no_wait":true}`, target.ID),
		fmt.Sprintf(`pane.override {"pane":%q,"slow_bps":10,"no_wait":true}`, target.ID),
		fmt.Sprintf(`pane.close {"pane":%q}`, other.ID),
	)
	if l := stepLine(t, person, agent.ID, 1); !strings.HasPrefix(l, "step 1 ok") {
		t.Fatalf("closing its own pane: %s", l)
	}
	for n := 2; n <= 5; n++ {
		if l := stepLine(t, person, agent.ID, n); !regexp.MustCompile(fmt.Sprintf(`^step %d forbidden c\w{7}$`, n)).MatchString(l) {
			t.Fatalf("step %d on the person's pane: %s", n, l)
		}
	}
	actions := map[string]bool{}
	for _, cp := range call[proto.CheckpointListResult](t, person, "checkpoint.list", map[string]any{}).Checkpoints {
		if cp.Kind == "drive" && cp.Drive.Pane == target.ID {
			actions[cp.Drive.Action] = true
			if cp.Drive.Action == "close" && !strings.Contains(cp.Title, `close "dev server"`) {
				t.Fatalf("the close card's title: %q", cp.Title)
			}
		}
	}
	if !actions["close"] || !actions["restart"] || !actions["override"] || len(actions) != 3 {
		t.Fatalf("drive actions asked: %v", actions)
	}
	// Nothing happened to the person's pane.
	if got := call[proto.ListResult](t, person, "pane.list", map[string]any{}).Panes; len(got) < 3 {
		t.Fatalf("a pane went: %+v", got)
	}
	// The waiting close goes through once the person lets it, once.
	cp := openDriveAction(t, person, other.ID, agent.ID, "close")
	answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true})
	if l := stepLine(t, person, agent.ID, 6); !strings.HasPrefix(l, "step 6 ok") {
		t.Fatalf("the close after the person's yes: %s", l)
	}
	if e := callErr(t, person, "pane.wait", map[string]any{"pane": other.ID, "exit": true}); e.Code != "not_found" {
		t.Fatalf("the pane is still there: %+v", e)
	}
	// The person closes any pane without a question.
	call[proto.CloseResult](t, person, "pane.close", map[string]any{"pane": target.ID})
}

func openDriveAction(t *testing.T, c *client.Client, target, agent, action string) proto.Checkpoint {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, cp := range call[proto.CheckpointListResult](t, c, "checkpoint.list", map[string]any{}).Checkpoints {
			if cp.Kind == "drive" && cp.State == "open" && cp.Drive.Pane == target && cp.Drive.Agent.Pane == agent && cp.Drive.Action == action {
				return cp
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no %s checkpoint for %s", action, target)
	return proto.Checkpoint{}
}

// A lease is a queue: who waits shows on the lease, the person's release
// hands it to the first in line, and a person's release with
// refuse_waiting takes the pane back, failing the ones still waiting.
func TestLeaseQueue(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	call[proto.Empty](t, person, "events.subscribe", map[string]any{})
	target := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}, "name": "dev server"})
	lease := func(extra string) string { return fmt.Sprintf(`pane.lease {"pane":%q%s}`, target.ID, extra) }
	// Each agent asks to type first, and waits a while before the lease
	// (a pane.wait on the target for text that never comes), so all three
	// hold a grant
	// before anyone holds the lease.
	steps := func(name string, delay int, extra string) []string {
		return []string{
			fmt.Sprintf(`pane.send {"pane":%q,"input":[{"text":"%s\r","mode":"raw"}]}`, target.ID, name),
			fmt.Sprintf(`pane.wait {"pane":%q,"text":"never comes","timeout_ms":%d}`, target.ID, delay),
			lease(extra),
		}
	}
	allow := func(agent string) {
		cp := openDrive(t, person, target.ID, agent)
		answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "allow": "session", "by": "desktop"})
	}
	leaseOf := func() *proto.Lease {
		for _, p := range call[proto.ListResult](t, person, "pane.list", map[string]any{}).Panes {
			if p.ID == target.ID {
				return p.Lease
			}
		}
		return nil
	}
	waitLease := func(ok func(l *proto.Lease) bool, what string) *proto.Lease {
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			if l := leaseOf(); ok(l) {
				return l
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("the lease never showed %s: %+v", what, leaseOf())
		return nil
	}
	a := agentPane(t, person, steps("a", 1500, `,"ttl_ms":60000`)...)
	b := agentPane(t, person, steps("b", 3000, `,"ttl_ms":60000,"wait_ms":30000`)...)
	c := agentPane(t, person, steps("c", 8000, `,"wait_ms":30000`)...)
	allow(a.ID)
	allow(b.ID)
	allow(c.ID)
	if l := stepLine(t, person, a.ID, 2); !strings.HasPrefix(l, "step 2 ok") {
		t.Fatalf("the first lease: %s", l)
	}
	l := waitLease(func(l *proto.Lease) bool { return l != nil && len(l.Waiting) == 1 }, "the waiting driver")
	if l.Holder.Pane != a.ID || l.Waiting[0].Kind != "agent" || l.Waiting[0].Pane != b.ID {
		t.Fatalf("who holds and who waits: %+v", l)
	}
	// Hand it on: the person's release gives it to the first in line.
	call[proto.LeaseResult](t, person, "pane.lease", map[string]any{"pane": target.ID, "release": true})
	if s := stepLine(t, person, b.ID, 2); !strings.HasPrefix(s, "step 2 ok") || !strings.Contains(s, b.ID) {
		t.Fatalf("the waiting driver was not handed the lease: %s", s)
	}
	waitLease(func(l *proto.Lease) bool { return l != nil && l.Holder.Pane == b.ID && len(l.Waiting) == 0 }, "the second holder")
	// Take it back: the one waiting now is refused.
	waitLease(func(l *proto.Lease) bool { return l != nil && len(l.Waiting) == 1 && l.Waiting[0].Pane == c.ID }, "the third driver waiting")
	call[proto.LeaseResult](t, person, "pane.lease", map[string]any{"pane": target.ID, "release": true, "refuse_waiting": true})
	if s := stepLine(t, person, c.ID, 2); s != "step 2 leased" {
		t.Fatalf("a driver waiting when the person took the pane back: %s", s)
	}
	waitLease(func(l *proto.Lease) bool { return l == nil }, "no holder")
	// Only a person refuses the waiting ones.
	e := agentPane(t, person, lease(`,"release":true,"refuse_waiting":true`))
	if s := stepLine(t, person, e.ID, 0); s != "step 0 forbidden" {
		t.Fatalf("an agent refusing the waiting drivers: %s", s)
	}
}

// A display's keystrokes gather into one record, and subscribers get that
// record again, grown, once the keys pause: a window shows the whole line
// typed, never its first key alone (2026-11-07: "Typed here" showed "s"
// for "sleep 600<Enter>").
func TestGatheredKeysAreSentAgainGrown(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	call[proto.Empty](t, person, "events.subscribe", map[string]any{})
	p := newPane(t, person, map[string]any{"command": []string{"/bin/cat"}})
	sub := call[proto.SubscribeResult](t, person, "pane.subscribe", map[string]any{"pane": p.ID})
	for _, k := range []string{"s", "l", "e", "e", "p", " ", "6", "0", "0", "\r"} {
		frame := proto.AppendFrame(nil, proto.FrameInput, sub.Channel, 0)
		if err := person.WriteBinary(ctx(t), append(frame, k...)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	first := nextEvent(t, person, "pane.input", func(ev proto.Event) bool { return ev.Input != nil && ev.Pane.ID == p.ID })
	grown := nextEvent(t, person, "pane.input", func(ev proto.Event) bool {
		return ev.Input != nil && ev.Pane.ID == p.ID && ev.Input.Seq == first.Input.Seq
	})
	if grown.Input.Text != "sleep 600<Enter>" || grown.Input.Bytes != 10 {
		t.Fatalf("the record sent again: %+v (first %+v)", grown.Input, first.Input)
	}
	ins := inputs(t, person, p.ID)
	if len(ins) != 1 || ins[0].Text != "sleep 600<Enter>" {
		t.Fatalf("the input log: %+v", ins)
	}
}

// A display's reports to the program are not typing (2026-11-10: the
// panel's "Typed here" showed "You <Esc>[I", the focus report a window
// sends when it gains focus). The program gets every byte; the log only
// what was typed.
func TestDisplayReportsAreNotTyping(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	argv, env := testprog.Command("rawecho")
	p := newPane(t, person, map[string]any{"command": argv, "env": env})
	waitFor(t, person, p.ID, `ready`, 0)
	sub := call[proto.SubscribeResult](t, person, "pane.subscribe", map[string]any{"pane": p.ID})
	sent := []string{"\x1b[I", "\x1b[12;40R", "\x1b[?62;22c", "l", "s", "\r"}
	for _, k := range sent {
		frame := proto.AppendFrame(nil, proto.FrameInput, sub.Channel, 0)
		if err := person.WriteBinary(ctx(t), append(frame, k...)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, person, p.ID, `read "[^"]*\\r"`, 0)
	// The program read every byte, in order.
	rd := call[proto.ReadResult](t, person, "pane.read", map[string]any{"pane": p.ID, "since": 0})
	got := ""
	for _, m := range regexp.MustCompile(`read ("(?:[^"\\]|\\.)*")`).FindAllStringSubmatch(*rd.Text, -1) {
		u, err := strconv.Unquote(m[1])
		if err != nil {
			t.Fatal(err)
		}
		got += u
	}
	if want := strings.Join(sent, ""); got != want {
		t.Fatalf("the program read %q, want %q", got, want)
	}
	// The log: one record, the typing.
	var ins []proto.InputRecord
	for range 50 {
		if ins = inputs(t, person, p.ID); len(ins) == 1 && ins[0].Text == "ls<Enter>" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(ins) != 1 || ins[0].Text != "ls<Enter>" || ins[0].Shown != "ls" || ins[0].Source.Kind != "person" {
		t.Fatalf("the input log: %+v", ins)
	}

	// What Typed here shows: the line entered, edited; nothing for a lone
	// Esc or a menu answered with arrows. Text keeps every key.
	typeKeys := func(keys ...string) proto.InputRecord {
		t.Helper()
		before := len(inputs(t, person, p.ID))
		for _, k := range keys {
			frame := proto.AppendFrame(nil, proto.FrameInput, sub.Channel, 0)
			if err := person.WriteBinary(ctx(t), append(frame, k...)); err != nil {
				t.Fatal(err)
			}
			time.Sleep(20 * time.Millisecond)
		}
		for range 100 {
			if ins := inputs(t, person, p.ID); len(ins) > before && ins[len(ins)-1].Bytes == len(strings.Join(keys, "")) {
				return ins[len(ins)-1]
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("no record for %q: %+v", keys, inputs(t, person, p.ID))
		return proto.InputRecord{}
	}
	for _, c := range []struct {
		keys        []string
		text, shown string
	}{
		{[]string{"l", "s", "x", "\x7f", "\r"}, "lsx<Backspace><Enter>", "ls"},
		{[]string{"\x1b"}, "<Esc>", ""},
		{[]string{"\x1b[B", "\x1b[B", "\r"}, "<Down><Down><Enter>", ""},
	} {
		time.Sleep(2100 * time.Millisecond) // a new record, not gathered into the last
		if r := typeKeys(c.keys...); r.Text != c.text || r.Shown != c.shown {
			t.Errorf("typed %q: text %q shown %q, want %q and %q", c.keys, r.Text, r.Shown, c.text, c.shown)
		}
	}

	// A display that may not drive: its focus reports are dropped, with no
	// error and no question; its typing still asks.
	target := newPane(t, person, map[string]any{"command": argv, "env": env, "name": "target"})
	waitFor(t, person, target.ID, `ready`, 0)
	agent := agentPane(t, person,
		fmt.Sprintf(`pane.subscribe {"pane":%q}`, target.ID),
		fmt.Sprintf(`INPUT 1 %q`, "\x1b[I"),
		fmt.Sprintf(`INPUT 1 %q`, "\x1b[O\x1b[?1;2c"),
		`pane.list {}`,
		fmt.Sprintf(`INPUT 1 %q`, "x"),
		`pane.list {}`,
	)
	waitFor(t, person, agent.ID, `steps done`, 0)
	out := *call[proto.ReadResult](t, person, "pane.read", map[string]any{"pane": agent.ID, "since": 0}).Text
	if strings.Count(out, "async ") != 1 || !regexp.MustCompile(`step 4 ok\s+async forbidden`).MatchString(out) {
		t.Fatalf("the agent's display: only its typing is refused:\n%s", out)
	}
	cp := openDrive(t, person, target.ID, agent.ID)
	if cp.Drive.Input != "x" {
		t.Fatalf("the question: %+v", cp.Drive)
	}
	if ins := inputs(t, person, target.ID); len(ins) != 0 {
		t.Fatalf("the target's input log: %+v", ins)
	}
	if rd := call[proto.ReadResult](t, person, "pane.read", map[string]any{"pane": target.ID, "since": 0}); strings.Contains(*rd.Text, "read ") {
		t.Fatalf("the target read input from a display that may not drive:\n%s", *rd.Text)
	}
	cps := call[proto.CheckpointListResult](t, person, "checkpoint.list", map[string]any{}).Checkpoints
	if n := len(cps); n != 1 {
		t.Fatalf("checkpoints: %+v", cps)
	}
}

// TestTypedLineFollowsTheCursor: Typed here shows the line the shell ran
// when the cursor moved while it was typed (2026-11-11: `echo one`, Left,
// Left, X, Enter ran `echo oXne` and showed `echo oneX`), from pane.send's
// key items (an agent, ravenryd send) and from a display's keystrokes (the
// person in the app), at a real zsh.
func TestTypedLineFollowsTheCursor(t *testing.T) {
	d := startDaemon(t)
	person := d.dial(client.Options{Name: "app"})
	p := newPane(t, person, map[string]any{"command": []string{"/bin/zsh", "-f", "-i"}, "env": map[string]string{"PS1": "$ ", "EDITOR": "", "VISUAL": ""}})
	w := waitFor(t, person, p.ID, `\$ `, 0)
	last := func(n int) proto.InputRecord {
		t.Helper()
		for range 100 {
			if ins := inputs(t, person, p.ID); len(ins) == n {
				return ins[n-1]
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("not %d records: %+v", n, inputs(t, person, p.ID))
		return proto.InputRecord{}
	}
	// ravenryd send --typed 'echo one' --key Left --key Left --typed X --key Enter
	call[proto.SendResult](t, person, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{
		{"text": "echo one", "mode": "typed"}, {"key": "Left"}, {"key": "Left"}, {"text": "X", "mode": "typed"}, {"key": "Enter"},
	}})
	w = waitFor(t, person, p.ID, `(?m)^oXne\s`, w.Mark)
	if r := last(1); r.Shown != "echo oXne" {
		t.Fatalf("the shell ran echo oXne; Typed here shows %q (text %q)", r.Shown, r.Text)
	}
	// The person's keys: Option+Left (Esc b), Ctrl+K, Left as the terminal
	// sends it, Ctrl+E, Ctrl+A, Ctrl+F, Ctrl+D.
	sub := call[proto.SubscribeResult](t, person, "pane.subscribe", map[string]any{"pane": p.ID})
	for _, k := range []string{"e", "c", "h", "o", " ", "t", "w", "o", " ", "s", "k", "i", "p", "\x1bb", "\x0b", "\x1b[D", "\x1b[D", "\x1b[D", "\x1b[D", "o", "n", "e", " ", "\x05", "e", "n", "d", "\x01", "\x06", "\x04", "c", "\r"} {
		frame := proto.AppendFrame(nil, proto.FrameInput, sub.Channel, 0)
		if err := person.WriteBinary(ctx(t), append(frame, k...)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitFor(t, person, p.ID, `(?m)^one two end\s`, w.Mark)
	if r := last(2); r.Shown != "echo one two end" {
		t.Fatalf("the shell ran echo one two end; Typed here shows %q (text %q)", r.Shown, r.Text)
	}
}

func TestTermReports(t *testing.T) {
	for _, c := range []struct {
		in, want string
	}{
		{"\x1b[I\x1b[O", ""},
		{"\x1b[12;40R\x1b[?62;22c\x1b[>1;10;0c\x1b[?2004;1$y\x1b[?1u\x1b[0n\x1b[8;24;80t", ""},
		{"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\\x1b]10;rgb:ffff/ffff/ffff\x07", ""},
		{"\x1bP>|xterm(390)\x1b\\\x1bP1$r0m\x1b\\\x1b_Gi=1;OK\x1b\\", ""},
		{"\x1b[<0;10;5M\x1b[<0;10;5m\x1b[M !!\x1b[32;10;5M", ""},
		{"\x1b[Ils\r", "ls<Enter>"},
		{"\x1b[A\x1b[Z\x1b[97;5u\x1b", "<Up><Shift+Tab><Esc>[97;5u<Esc>"},
		{"\x1b]", "<Esc>]"},
		{"\x1bPa", "<Esc>Pa"},
	} {
		if got := visible([]byte(c.in)); got != c.want {
			t.Errorf("visible(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, c := range []struct{ in, want string }{
		{"lsx\x7f\r", "ls"},
		{"\x1b", ""},
		{"\x1b[B\x1b[B\r", ""},
		{"git commit -m wip\x17fix\r", "git commit -m fix"},
		{"rm -rf /\x15echo hi\recho\x03\r", "echo hi"},
		{"\x1b[200~one\rtwo\x1b[201~\r", "one\ntwo"},
		{"\x1b[27u\x1b[97;5uab\x1b[127u\x1b[13u", "a"},
		{"\x1bbcd\x1bOA\t\x1b[3~", "cd"},
		{"\x1b[I\x1b[<0;3;4Mhalf", "half"},
		// The cursor moves as the shell's: what is typed after it lands there.
		{"echo one\x1b[D\x1b[DX\r", "echo oXne"},
		{"echo one\x1bOD\x1bODX\r", "echo oXne"},
		{"ech one\x1b[H\x1b[C\x1b[C\x1b[Co\x1b[F!\r", "echo one!"},
		{"git push\x01sudo \x05 -f\r", "sudo git push -f"},
		{"cat a b\x02\x02\x7f\r", "cat  b"},
		{"echo abc\x1b[D\x1b[D\x1b[3~\r", "echo ac"},
		{"echo abc\x02\x02\x04\x06Z\r", "echo acZ"},
		{"echo one two\x1bb\x0b\r", "echo one"},
		{"echo one two\x1b[1;5D\x1b[1;3Dzero \r", "echo zero one two"},
		{"echo one two\x1bb\x1bb\x1bd\r", "echo  two"},
		{"echo one two\x1bb\x17\r", "echo two"},
		{"echo one\x1b[D\x1b[D\x1b\x7f\r", "echo ne"},
		{"ls\x1b[D\x1b[D\x1b[200~a b\x1b[201~ \r", "a b ls"},
		{"echo one\x1b[D\x1b[D\x1b[88u\r", "echo oXne"},
		{"echo one\x1b[97;5uX\x1b[101;5u!\r", "Xecho one!"},
	} {
		var e lineEditor
		e.feed([]byte(c.in))
		if got := e.String(); got != c.want {
			t.Errorf("shown of %q = %q, want %q", c.in, got, c.want)
		}
	}
	// pane.send's key items move it too.
	for _, c := range []struct {
		items []pane.InputItem
		want  string
	}{
		{[]pane.InputItem{{Text: "echo one"}, {Key: "Left"}, {Key: "Left"}, {Text: "X"}, {Key: "Enter"}}, "echo oXne"},
		{[]pane.InputItem{{Text: "push"}, {Key: "Home"}, {Text: "git "}, {Key: "End"}, {Key: "Space"}, {Text: "-f"}, {Key: "Return"}}, "git push -f"},
		{[]pane.InputItem{{Text: "echo one two"}, {Key: "Alt+B"}, {Key: "Ctrl+K"}, {Key: "Ctrl+A"}, {Key: "Delete"}, {Text: "E"}, {Key: "Enter"}}, "Echo one"},
		{[]pane.InputItem{{Text: "echo one two"}, {Key: "Ctrl+Left"}, {Key: "Backspace"}, {Key: "Right"}, {Key: "C-d"}, {Key: "Enter"}}, "echo oneto"},
		{[]pane.InputItem{{Text: "ls"}, {Key: "Up"}, {Key: "Tab"}, {Key: "Enter"}}, "ls"},
	} {
		var e lineEditor
		for _, it := range c.items {
			if it.Key != "" {
				e.key(it.Key)
			} else {
				e.feed([]byte(it.Text))
			}
		}
		if got := e.String(); got != c.want {
			t.Errorf("shown of %+v = %q, want %q", c.items, got, c.want)
		}
	}
	if !onlyAnswers([]byte("\x1b[I\x1b[1;1R")) || onlyAnswers([]byte("\x1b[<0;1;1M")) || onlyAnswers([]byte("\x1b[Ia")) || onlyAnswers(nil) {
		t.Error("onlyAnswers")
	}
}
