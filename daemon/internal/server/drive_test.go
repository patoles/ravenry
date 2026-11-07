package server

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
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
