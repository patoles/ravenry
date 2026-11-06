package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

func newCheckpoint(t *testing.T, c *client.Client, params map[string]any) proto.Checkpoint {
	t.Helper()
	return call[proto.CheckpointResult](t, c, "checkpoint.new", params).Checkpoint
}

func answer(t *testing.T, c *client.Client, params map[string]any) proto.Checkpoint {
	t.Helper()
	return call[proto.CheckpointResult](t, c, "checkpoint.answer", params).Checkpoint
}

// waitCheckpoint is the agent's side: it blocks until a person answered.
func waitCheckpoint(t *testing.T, c *client.Client, id string) <-chan proto.Checkpoint {
	out := make(chan proto.Checkpoint, 1)
	go func() {
		var r proto.CheckpointResult
		cctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := c.Call(cctx, "checkpoint.wait", map[string]any{"checkpoint": id}, &r); err != nil {
			t.Errorf("checkpoint.wait: %v", err)
		}
		out <- r.Checkpoint
	}()
	return out
}

func TestCheckpointAskWaitsForAPerson(t *testing.T) {
	d := startDaemon(t)
	agent := d.dial(client.Options{Name: "agent"})
	person := d.dial(client.Options{Name: "app"})
	if err := person.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	p := newPane(t, agent, map[string]any{"command": []string{"/bin/cat"}})
	cp := newCheckpoint(t, agent, map[string]any{"kind": "ask", "pane": p.ID, "title": "Put on the headset and open the game", "options": []string{"Done", "Didn't work"}, "free_text": true})
	if cp.State != "open" || cp.ID[0] != 'c' || cp.ExpiresAt == "" {
		t.Fatalf("new %+v", cp)
	}
	got := waitCheckpoint(t, agent, cp.ID)
	if ev := eventAbout(t, person, cp.ID, "checkpoint.opened"); ev.Checkpoint.Title != cp.Title {
		t.Fatalf("opened %+v", ev.Checkpoint)
	}
	l := call[proto.CheckpointListResult](t, person, "checkpoint.list", map[string]any{})
	if len(l.Checkpoints) != 1 || l.Checkpoints[0].ID != cp.ID {
		t.Fatalf("list %+v", l)
	}
	select {
	case <-got:
		t.Fatal("the agent went on before anyone answered")
	case <-time.After(300 * time.Millisecond):
	}
	a := answer(t, person, map[string]any{"checkpoint": cp.ID, "choice": 1, "by": "phone"})
	if a.State != "answered" || a.Answer.Option != "Didn't work" || *a.Answer.Choice != 1 || a.Answer.By != "phone" {
		t.Fatalf("answer %+v", a)
	}
	if w := <-got; w.State != "answered" || w.Answer.Option != "Didn't work" {
		t.Fatalf("the agent got %+v", w)
	}
	eventAbout(t, person, cp.ID, "checkpoint.closed")
	// Answered once: a second answer is refused.
	if e := callErr(t, person, "checkpoint.answer", map[string]any{"checkpoint": cp.ID, "choice": 0}); e.Code != proto.CodeNotFound {
		t.Fatalf("second answer: %s", e.Code)
	}
	if l = call[proto.CheckpointListResult](t, person, "checkpoint.list", map[string]any{"all": true}); len(l.Checkpoints) != 1 {
		t.Fatalf("list all %+v", l)
	}

	// Free text, declining, cancelling, expiring.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "What broke?", "free_text": true})
	if a = answer(t, person, map[string]any{"checkpoint": cp.ID, "text": "the lobby\nhangs"}); *a.Answer.Text != "the lobby\nhangs" {
		t.Fatalf("text %+v", a)
	}
	cp = newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "Ship it?", "options": []string{"Yes"}})
	if a = answer(t, person, map[string]any{"checkpoint": cp.ID, "decline": true}); a.State != "declined" || !a.Answer.Declined {
		t.Fatalf("decline %+v", a)
	}
	cp = newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "Still there?", "options": []string{"Yes"}})
	if c := call[proto.CheckpointResult](t, agent, "checkpoint.cancel", map[string]any{"checkpoint": cp.ID, "reason": "found it myself"}).Checkpoint; c.State != "cancelled" || c.Reason != "found it myself" {
		t.Fatalf("cancel %+v", c)
	}
	cp = newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "Quick?", "options": []string{"Yes"}, "timeout_ms": 150})
	if w := <-waitCheckpoint(t, agent, cp.ID); w.State != "expired" {
		t.Fatalf("expire %+v", w)
	}
	// A wait with its own timeout returns the checkpoint still open.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "Later?", "options": []string{"Yes"}})
	if w := call[proto.CheckpointResult](t, agent, "checkpoint.wait", map[string]any{"checkpoint": cp.ID, "timeout_ms": 100}); w.Checkpoint.State != "open" {
		t.Fatalf("wait timeout %+v", w)
	}

	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	for _, bad := range []map[string]any{
		{"kind": "ask", "title": "no options"},
		{"kind": "ask", "title": "x", "options": []string{"a"}, "command": "ls"},
		{"kind": "approve", "title": "x"},
		{"kind": "secret", "title": "x", "secret": map[string]any{"to": "input", "pane": p.ID}, "pane": p.ID},
		{"kind": "secret", "title": "x", "secret": map[string]any{"to": "env", "env": "RAVENRY_X"}, "command": "ls"},
		{"kind": "nope", "title": "x"},
		{"kind": "ask", "title": "", "options": []string{"a"}},
	} {
		if e := callErr(t, agent, "checkpoint.new", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
	if e := callErr(t, person, "checkpoint.answer", map[string]any{"checkpoint": cp.ID, "choice": 0, "decline": true}); e.Code != proto.CodeBadRequest {
		t.Fatalf("two answers at once: %s", e.Code)
	}
	if e := callErr(t, person, "checkpoint.answer", map[string]any{"checkpoint": cp.ID, "approve": true}); e.Code != proto.CodeBadRequest {
		t.Fatalf("approve an ask: %s", e.Code)
	}
}

func TestCheckpointApproveRunsTheExactCommand(t *testing.T) {
	d := startDaemon(t)
	agent := d.dial(client.Options{Name: "agent"})
	person := d.dial(client.Options{Name: "app"})
	if err := person.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cmd := `echo "ran in $(pwd)" && touch approved.txt && exit 3`
	cp := newCheckpoint(t, agent, map[string]any{"kind": "approve", "title": "Publish", "command": cmd, "why": "release", "cwd": dir})
	got := waitCheckpoint(t, agent, cp.ID)
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, "approved.txt")); err == nil {
		t.Fatal("ran before anyone approved")
	}
	a := answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "by": "desktop"})
	if a.State != "running" || a.Run == nil || a.Run.Pane == "" || a.Command != cmd {
		t.Fatalf("approve %+v", a)
	}
	eventAbout(t, person, cp.ID, "checkpoint.running")
	w := <-got
	if w.State != "answered" || w.Run.Exit == nil || w.Run.Exit.Code != 3 || !strings.Contains(w.Run.Output, "ran in ") || !*w.Answer.Approved {
		t.Fatalf("result %+v %+v", w, w.Run)
	}
	if _, err := os.Stat(filepath.Join(dir, "approved.txt")); err != nil {
		t.Fatal("the command did not run in its folder")
	}
	// The run pane is labelled with its checkpoint.
	l := call[proto.ListResult](t, person, "pane.list", map[string]any{"labels": map[string]string{"ravenry.checkpoint": cp.ID}})
	if len(l.Panes) != 1 || l.Panes[0].ID != w.Run.Pane {
		t.Fatalf("run pane %+v", l.Panes)
	}
}

// TestCheckpointApproveEditedRunsTheEdit: the person edits the command
// before approving it. Their text runs, the proposed one never does, and
// the agent's result says it changed and holds the final text. A decline
// carries the person's reason, and the agent's warning is kept as its own.
func TestCheckpointApproveEditedRunsTheEdit(t *testing.T) {
	d := startDaemon(t)
	agent := d.dial(client.Options{Name: "agent"})
	person := d.dial(client.Options{Name: "app"})
	dir := t.TempDir()
	proposed := `touch proposed.txt`
	edited := `touch edited.txt && echo "edited ran"`
	cp := newCheckpoint(t, agent, map[string]any{"kind": "approve", "title": "Publish", "command": proposed, "cwd": dir, "warning": "Publishing to npm can't be undone"})
	if cp.Warning != "Publishing to npm can't be undone" {
		t.Fatalf("warning %+v", cp)
	}
	got := waitCheckpoint(t, agent, cp.ID)
	a := answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "command": edited, "by": "desktop"})
	if a.State != "running" || a.Answer == nil || a.Answer.Command != edited || a.Command != proposed {
		t.Fatalf("approve edited %+v %+v", a, a.Answer)
	}
	w := <-got
	if w.State != "answered" || w.Run == nil || w.Run.Exit == nil || w.Run.Exit.Code != 0 || !strings.Contains(w.Run.Output, "edited ran") || w.Answer.Command != edited {
		t.Fatalf("result %+v %+v", w, w.Run)
	}
	if _, err := os.Stat(filepath.Join(dir, "edited.txt")); err != nil {
		t.Fatal("the edited command did not run")
	}
	if _, err := os.Stat(filepath.Join(dir, "proposed.txt")); err == nil {
		t.Fatal("the proposed command ran instead of the edited one")
	}
	l := call[proto.ListResult](t, person, "pane.list", map[string]any{"labels": map[string]string{"ravenry.checkpoint": cp.ID}})
	if len(l.Panes) != 1 || l.Panes[0].Command[len(l.Panes[0].Command)-1] != edited {
		t.Fatalf("run pane %+v", l.Panes)
	}

	// The same text as proposed is no edit: answer.command stays empty.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "approve", "title": "x", "command": "true", "cwd": dir})
	got = waitCheckpoint(t, agent, cp.ID)
	if a = answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "command": "true"}); a.Answer.Command != "" {
		t.Fatalf("unchanged edit %+v", a.Answer)
	}
	<-got

	// A decline with a reason: the agent reads it.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "approve", "title": "x", "command": "touch nope.txt", "cwd": dir})
	got = waitCheckpoint(t, agent, cp.ID)
	if a = answer(t, person, map[string]any{"checkpoint": cp.ID, "decline": true, "reason": "Run the tests first"}); a.State != "declined" || a.Answer.Reason != "Run the tests first" {
		t.Fatalf("decline %+v", a.Answer)
	}
	if w = <-got; w.Answer.Reason != "Run the tests first" {
		t.Fatalf("the agent got %+v", w.Answer)
	}

	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	cp = newCheckpoint(t, agent, map[string]any{"kind": "approve", "title": "x", "command": "touch nope.txt", "cwd": dir})
	for _, bad := range []map[string]any{
		{"checkpoint": cp.ID, "command": "ls"},                        // command without approve
		{"checkpoint": cp.ID, "decline": true, "command": "ls"},       // command with decline
		{"checkpoint": cp.ID, "approve": true, "reason": "x"},         // reason without decline
		{"checkpoint": cp.ID, "approve": true, "command": ""},         // empty command
		{"checkpoint": cp.ID, "approve": true, "command": "ls\x00rm"}, // a control character
		{"checkpoint": cp.ID, "decline": true, "reason": strings.Repeat("r", 1001)},
	} {
		if e := callErr(t, person, "checkpoint.answer", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "nope.txt")); err == nil {
		t.Fatal("a refused answer ran the command")
	}
	ask := newCheckpoint(t, agent, map[string]any{"kind": "ask", "title": "x", "options": []string{"a"}})
	if e := callErr(t, person, "checkpoint.answer", map[string]any{"checkpoint": ask.ID, "choice": 0, "command": "ls"}); e.Code != proto.CodeBadRequest {
		t.Fatalf("command on an ask: %s", e.Code)
	}
	for _, bad := range []map[string]any{
		{"kind": "ask", "title": "x", "options": []string{"a"}, "warning": "careful"},
		{"kind": "approve", "title": "x", "command": "ls", "warning": strings.Repeat("w", 1001)},
	} {
		if e := callErr(t, agent, "checkpoint.new", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
}

// TestSecretNeverLeaks gives a secret three ways (into a program's input,
// into a command it starts, into a command's environment) to programs
// that echo it, then looks for it everywhere a client or a file could
// see it: pane.read (text and raw), pane.capture (with history, styles
// and VT), a stream's snapshot and output frames, agent reports, every
// checkpoint and event, every message on the wire, the daemon's log and
// every file in its state folder.
func TestSecretNeverLeaks(t *testing.T) {
	const typed = "s3cr3t-0tp-847261"
	d := startDaemon(t)
	var wire bytes.Buffer
	var wireMu = make(chan struct{}, 1)
	wireMu <- struct{}{}
	tap := func(dir string, text bool, data []byte) {
		<-wireMu
		wire.Write(data)
		wireMu <- struct{}{}
	}
	agent := d.dial(client.Options{Name: "agent", OnMessage: tap})
	person := d.dial(client.Options{Name: "app", OnMessage: tap})
	if err := person.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	asker := newPane(t, agent, map[string]any{"command": []string{"/bin/cat"}})

	// 1. Into a running program that echoes what it reads.
	prompt := newPane(t, agent, map[string]any{"command": []string{"/bin/sh", "-c", `printf 'code: '; read x; echo "got [$x]"; exec cat`}})
	stream, err := person.Subscribe(ctx(t), prompt.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, agent, prompt.ID, "code: ", 0)
	cp := newCheckpoint(t, agent, map[string]any{"kind": "secret", "pane": asker.ID, "title": "npm one-time code", "secret": map[string]any{"to": "input", "pane": prompt.ID}})
	got := waitCheckpoint(t, agent, cp.ID)
	a := answer(t, person, map[string]any{"checkpoint": cp.ID, "secret": typed})
	if a.State != "answered" || !a.Answer.Delivered {
		t.Fatalf("answer %+v", a)
	}
	if w := <-got; !w.Answer.Delivered {
		t.Fatalf("the agent got %+v", w)
	}
	w := waitFor(t, agent, prompt.ID, `got \[\*+\]`, 0)
	if !strings.Contains(w.Output, "got [*****************]") {
		t.Fatalf("not masked: %q", w.Output)
	}
	var frames bytes.Buffer
	deadline := time.After(3 * time.Second)
	for !bytes.Contains(frames.Bytes(), []byte("got [")) {
		select {
		case f := <-stream.Frames:
			frames.Write(f.Data)
		case <-deadline:
			t.Fatalf("stream: %q", frames.String())
		}
	}

	// 2. Typed into a command it starts, once it waits for input.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "secret", "title": "Mail service API key", "command": `printf 'Enter a secret value: '; read v; echo "stored [$v]"`, "secret": map[string]any{"to": "run"}})
	got = waitCheckpoint(t, agent, cp.ID)
	answer(t, person, map[string]any{"checkpoint": cp.ID, "secret": typed})
	run := <-got
	if run.Run == nil || run.Run.Exit == nil || run.Run.Exit.Code != 0 || !strings.Contains(run.Run.Output, "stored [*****************]") {
		t.Fatalf("run %+v %+v", run, run.Run)
	}

	// 3. In a command's environment.
	cp = newCheckpoint(t, agent, map[string]any{"kind": "secret", "title": "npm token", "command": `echo "token=$NPM_TOKEN"`, "secret": map[string]any{"to": "env", "env": "NPM_TOKEN"}})
	got = waitCheckpoint(t, agent, cp.ID)
	answer(t, person, map[string]any{"checkpoint": cp.ID, "secret": typed})
	env := <-got
	if env.Run == nil || !strings.Contains(env.Run.Output, "token=*****************") {
		t.Fatalf("env run %+v", env.Run)
	}
	// Restarting that pane must not bring the secret back.
	rs := call[proto.RestartResult](t, agent, "pane.restart", map[string]any{"pane": env.Run.Pane, "grace_ms": 100})
	waitFor(t, agent, rs.Pane.ID, `token=(\r|\n)`, 0)

	// Now look everywhere.
	look := func(where, s string) {
		t.Helper()
		if strings.Contains(s, typed) || strings.Contains(s, typed[:12]) {
			t.Errorf("the secret is in %s", where)
		}
	}
	for _, id := range []string{prompt.ID, run.Run.Pane, rs.Pane.ID} {
		rd := call[proto.ReadResult](t, agent, "pane.read", map[string]any{"pane": id, "since": 0})
		look("pane.read text of "+id, *rd.Text)
		raw := call[proto.ReadResult](t, agent, "pane.read", map[string]any{"pane": id, "since": 0, "format": "raw"})
		b, _ := base64.StdEncoding.DecodeString(*raw.Data)
		look("pane.read raw of "+id, string(b))
		cp := call[proto.CaptureResult](t, agent, "pane.capture", map[string]any{"pane": id, "history": 1000, "styles": true, "vt": true})
		j, _ := json.Marshal(cp)
		look("pane.capture of "+id, string(j))
		if id == prompt.ID {
			pr := call[proto.ProcessResult](t, agent, "pane.process", map[string]any{"pane": id})
			j, _ = json.Marshal(pr)
			look("pane.process of "+id, string(j))
		}
	}
	look("the stream", frames.String())
	snap, err := agent.Subscribe(ctx(t), prompt.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	f := <-snap.Frames
	look("a snapshot", string(f.Data))
	ae := call[proto.AgentEventsResult](t, agent, "agent.events", map[string]any{})
	j, _ := json.Marshal(ae)
	look("agent.events", string(j))
	l := call[proto.CheckpointListResult](t, agent, "checkpoint.list", map[string]any{"all": true})
	j, _ = json.Marshal(l)
	look("checkpoint.list", string(j))
	panes := call[proto.ListResult](t, agent, "pane.list", map[string]any{"hidden": true})
	j, _ = json.Marshal(panes)
	look("pane.list", string(j))

	// The wire: only the person's own checkpoint.answer requests carry it.
	<-wireMu
	all := wire.String()
	wireMu <- struct{}{}
	if n := strings.Count(all, typed); n != 3 {
		t.Errorf("the secret went over the wire %d times; want 3 (the three answers)", n)
	}
	look("the daemon's log", d.log.String())
	filepath.WalkDir(d.dir, func(p string, e fs.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			if b, err := os.ReadFile(p); err == nil {
				look(p, string(b))
			}
		}
		return nil
	})
}

// TestCheckpointApproveEnv: a page's run button passes an item's values as
// variables, never inside the command line. The person sees them on the
// checkpoint, the command reads them from its environment, and a value
// that looks like shell is only ever a value.
func TestCheckpointApproveEnv(t *testing.T) {
	d := startDaemon(t)
	hub := d.dial(client.Options{Name: "hub"})
	person := d.dial(client.Options{Name: "app"})
	dir := t.TempDir()
	evil := `Lake District $(touch pwned.txt) "; touch pwned2.txt; echo "`
	cp := newCheckpoint(t, hub, map[string]any{"kind": "approve", "title": "Map tiles: Rebuild tiles", "command": `printf '%s|' "$REGION" > region.txt`, "cwd": dir, "env": map[string]string{"REGION": evil}})
	if cp.Env["REGION"] != evil {
		t.Fatalf("env not on the checkpoint: %+v", cp.Env)
	}
	got := waitCheckpoint(t, hub, cp.ID)
	answer(t, person, map[string]any{"checkpoint": cp.ID, "approve": true, "by": "desktop"})
	w := <-got
	if w.State != "answered" || w.Run.Exit == nil || w.Run.Exit.Code != 0 {
		t.Fatalf("result %+v %+v", w, w.Run)
	}
	b, err := os.ReadFile(filepath.Join(dir, "region.txt"))
	if err != nil || string(b) != evil+"|" {
		t.Fatalf("region.txt %q %v", b, err)
	}
	for _, f := range []string{"pwned.txt", "pwned2.txt"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Fatalf("%s: a value ran as shell", f)
		}
	}
	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	for _, bad := range []map[string]any{
		{"kind": "approve", "title": "x", "command": "true", "env": map[string]string{"RAVENRY_PANE": "p1"}},
		{"kind": "approve", "title": "x", "command": "true", "env": map[string]string{"A B": "1"}},
		{"kind": "approve", "title": "x", "command": "true", "env": map[string]string{"A": "one\ntwo"}},
		{"kind": "ask", "title": "x", "options": []string{"Yes"}, "env": map[string]string{"A": "1"}},
	} {
		var r proto.CheckpointResult
		err := hub.Call(ctx(t), "checkpoint.new", bad, &r)
		var ce *client.Error
		if !errors.As(err, &ce) || ce.Code != proto.CodeBadRequest {
			t.Fatalf("taken, or refused for another reason: %+v: %v", bad, err)
		}
	}
}
