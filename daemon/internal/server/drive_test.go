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
