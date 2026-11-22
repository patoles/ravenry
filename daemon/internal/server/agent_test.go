package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// nextEvent reads c's events until one named name for which match (nil:
// any) is true.
func nextEvent(t *testing.T, c *client.Client, name string, match func(proto.Event) bool) proto.Event {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-c.Events():
			if !ok {
				t.Fatalf("connection closed while waiting for %s", name)
			}
			if ev.Event == name && (match == nil || match(ev)) {
				return ev
			}
		case <-deadline:
			t.Fatalf("no %s event", name)
		}
	}
}

func noEvent(t *testing.T, c *client.Client, name string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case ev := <-c.Events():
			if ev.Event == name {
				t.Fatalf("unexpected %s: %+v", name, ev)
			}
		case <-deadline:
			return
		}
	}
}

func TestAgentReportsAndDecisions(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	call[proto.Empty](t, c, "events.subscribe", map[string]any{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}})

	r := call[proto.AgentReportResult](t, c, "agent.report", map[string]any{
		"pane": p.ID, "assistant": "claude", "event": "UserPromptSubmit", "session": "s1", "state": "working",
		"cwd": "/tmp", "pid": os.Getpid(), "data": map[string]any{"prompt": "hi", "hook_event_name": "UserPromptSubmit"},
	})
	if r.Seq != 1 || r.Asked != 0 || r.Reply != nil {
		t.Fatalf("report %+v", r)
	}
	ev := nextEvent(t, c, "agent.report", nil)
	if ev.Report.Seq != 1 || ev.Report.Source != "hook" || ev.Pane == nil || ev.Pane.Agent == nil || ev.Pane.Agent.State != "working" {
		t.Fatalf("agent.report event %+v", ev)
	}
	var data map[string]any
	// The daemon keeps only the fields the status and the hand-off read:
	// never the prompt.
	if json.Unmarshal(ev.Report.Data, &data) != nil || data["prompt"] != nil || data["hook_event_name"] != "UserPromptSubmit" {
		t.Fatalf("data %s", ev.Report.Data)
	}

	call[proto.AgentReportResult](t, c, "agent.report", map[string]any{
		"pane": p.ID, "assistant": "claude", "event": "Notification", "state": "needs_you",
		"need": map[string]any{"kind": "permission", "message": "Run ls?"}, "message": "Run ls?",
	})
	list := call[proto.ListResult](t, c, "pane.list", map[string]any{})
	if a := list.Panes[0].Agent; a == nil || a.State != "needs_you" || a.Need == nil || a.Need.Message != "Run ls?" || a.Session != "s1" {
		t.Fatalf("pane.list agent %+v", list.Panes[0].Agent)
	}

	// A report that cannot say which pane it runs in.
	call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"assistant": "codex", "event": "Stop", "state": "idle", "session": "c1"})
	ev = nextEvent(t, c, "agent.report", func(e proto.Event) bool { return e.Report.Assistant == "codex" })
	if ev.Pane != nil || ev.Report.Pane != "" {
		t.Fatalf("pane-less report %+v", ev)
	}

	// With no decider connected, a decision goes on at once.
	start := time.Now()
	r = call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true})
	if r.Asked != 0 || r.Reply != nil || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("no decider: %+v in %v", r, time.Since(start))
	}

	// Two deciders: the first that decides wins, one that passes does not.
	hub := d.dial(client.Options{Name: "hub"})
	call[proto.Empty](t, hub, "agent.decisions", nil)
	other := d.dial(client.Options{Name: "plugin"})
	call[proto.Empty](t, other, "agent.decisions", nil)
	go func() {
		ev := nextEvent(t, other, "agent.decision", nil)
		call[proto.Empty](t, other, "agent.decide", map[string]any{"request": *ev.Request})
	}()
	go func() {
		ev := nextEvent(t, hub, "agent.decision", nil)
		if ev.Report.Event != "Stop" || *ev.TimeoutMs != 3000 {
			t.Errorf("decision %+v", ev)
		}
		time.Sleep(50 * time.Millisecond)
		call[proto.Empty](t, hub, "agent.decide", map[string]any{"request": *ev.Request, "reply": map[string]any{"stdout": `{"decision":"block"}`, "exit_code": 0}})
	}()
	r = call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true, "timeout_ms": 3000})
	if r.Asked != 2 || r.Reply == nil || r.Reply.Stdout != `{"decision":"block"}` {
		t.Fatalf("decided %+v", r)
	}
	// Both pass: no reply, without waiting for the timeout.
	go func() {
		ev := nextEvent(t, other, "agent.decision", nil)
		call[proto.Empty](t, other, "agent.decide", map[string]any{"request": *ev.Request})
	}()
	go func() {
		ev := nextEvent(t, hub, "agent.decision", nil)
		call[proto.Empty](t, hub, "agent.decide", map[string]any{"request": *ev.Request})
		// Too late, or twice: not found.
		if e := callErr(t, hub, "agent.decide", map[string]any{"request": *ev.Request}); e.Code != proto.CodeNotFound {
			t.Errorf("second answer: %s", e.Code)
		}
	}()
	start = time.Now()
	r = call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true, "timeout_ms": 5000})
	if r.Asked != 2 || r.Reply != nil || time.Since(start) > 2*time.Second {
		t.Fatalf("both passed: %+v in %v", r, time.Since(start))
	}
	// A decider that leaves counts as passing.
	go func() {
		nextEvent(t, other, "agent.decision", nil)
		other.Close()
	}()
	go func() {
		ev := nextEvent(t, hub, "agent.decision", nil)
		call[proto.Empty](t, hub, "agent.decide", map[string]any{"request": *ev.Request})
	}()
	r = call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true, "timeout_ms": 5000})
	if r.Reply != nil {
		t.Fatalf("after a decider left: %+v", r)
	}
	// A decider that never answers: the report returns at its timeout.
	start = time.Now()
	r = call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "decide": true, "timeout_ms": 200})
	if r.Asked != 1 || r.Reply != nil || time.Since(start) < 200*time.Millisecond {
		t.Fatalf("timeout: %+v in %v", r, time.Since(start))
	}
	if e := callErr(t, hub, "agent.decide", map[string]any{"request": 999}); e.Code != proto.CodeNotFound {
		t.Fatalf("unknown decision: %s", e.Code)
	}

	ae := call[proto.AgentEventsResult](t, c, "agent.events", map[string]any{"pane": p.ID, "since": 1, "limit": 3})
	if len(ae.Reports) != 3 || ae.Reports[0].Seq != 2 || ae.Truncated || ae.Seq < 8 {
		t.Fatalf("agent.events %+v", ae)
	}
	all := call[proto.AgentEventsResult](t, c, "agent.events", nil)
	if len(all.Reports) != int(all.Seq) {
		t.Fatalf("all reports %d of %d", len(all.Reports), all.Seq)
	}

	// Bad reports are refused.
	sendingInvalid.Store(true)
	for _, bad := range []map[string]any{
		{"assistant": "Claude Code", "event": "Stop"},
		{"assistant": "claude", "event": ""},
		{"assistant": "claude", "event": "Stop", "state": "busy"},
		{"assistant": "claude", "event": "Stop", "state": "idle", "need": map[string]any{"kind": "question"}},
		{"assistant": "claude", "event": "Stop", "data": []int{1}},
		{"assistant": "claude", "event": "Stop", "timeout_ms": 10},
	} {
		if e := callErr(t, c, "agent.report", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
	sendingInvalid.Store(false)
	if e := callErr(t, c, "agent.report", map[string]any{"pane": "pnothere", "assistant": "claude", "event": "Stop"}); e.Code != proto.CodeNotFound {
		t.Fatalf("unknown pane: %s", e.Code)
	}

	// The pane's process exits: its agent ended.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Ctrl+D"}}})
	ev = nextEvent(t, c, "agent.report", func(e proto.Event) bool { return e.Report.Source == "daemon" })
	if ev.Report.Event != "exit" || ev.Report.State != "ended" || ev.Report.Assistant != "claude" {
		t.Fatalf("exit report %+v", ev.Report)
	}
}

func TestShellMarksAndProgramStatus(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	call[proto.Empty](t, c, "events.subscribe", nil)
	// A shell with OSC 133 marks: a prompt, then for each line a command
	// that runs, exits with status 3 and gives the prompt back.
	script := `printf '\033]133;A\007$ \033]133;B\007'
while read line; do
  printf '\033]133;C\007'
  code=3
  case "$line" in
    blocked) printf '\033]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHk/\033\\' ;;
    working) printf '\033]7501;state=working:app=terraform\033\\' ;;
    progress) printf '\033]7501;state=working:app=deploy:progress=60:msg=VXBsb2FkaW5n\033\\'; code=0 ;;
    done) printf '\033]7501;state=done:app=deploy:msg=RGVwbG95ZWQ=\033\\'; code=0 ;;
    *) echo "ran $line" ;;
  esac
  printf '\033]133;D;%s\007\033]133;A\007$ \033]133;B\007' "$code"
done`
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", script}})
	ev := nextEvent(t, c, "pane.prompt", func(e proto.Event) bool { return e.Pane.ID == p.ID })
	if ev.Pane.Shell == nil || ev.Pane.Shell.State != "prompt" {
		t.Fatalf("first prompt %+v", ev.Pane.Shell)
	}

	s := call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "make\n", "mode": "raw"}}})
	w := call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "prompt": true, "since": s.Mark, "timeout_ms": 5000})
	if w.Condition != "prompt" || w.Shell == nil || w.Shell.ExitCode == nil || *w.Shell.ExitCode != 3 || w.Shell.State != "prompt" {
		t.Fatalf("wait prompt %+v", w)
	}
	nextEvent(t, c, "pane.prompt", func(e proto.Event) bool { return e.Pane.Shell.State == "running" })
	nextEvent(t, c, "pane.prompt", func(e proto.Event) bool { return e.Pane.Shell.State == "prompt" && e.Pane.Shell.ExitCode != nil })
	// A wait from now sees no prompt until the next command ends.
	w = call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": p.ID, "prompt": true, "timeout_ms": 200})
	if w.Condition != "timeout" {
		t.Fatalf("no new prompt: %+v", w)
	}

	// The program's own status reports (OSC 7501) become agent reports.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "blocked\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "program" || r.Assistant != "terraform" || r.State != "needs_you" || r.Need == nil || r.Need.Kind != "permission" || r.Need.Message != "Apply?" {
		t.Fatalf("program report %+v", ev.Report)
	}
	if pr := ev.Report.Program; pr == nil || pr.State != "blocked" || pr.Kind != "permission" || pr.Progress != nil {
		t.Fatalf("program state in the report %+v", pr)
	}
	// Its command ended and the shell drew its prompt: no longer blocked,
	// and the command's status 3 says it failed.
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "daemon" || r.Event != "prompt" || r.State != "idle" || r.Program == nil || r.Program.State != "error" {
		t.Fatalf("after the prompt %+v", ev.Report)
	}
	if a := ev.Pane.Agent; a == nil || a.State != "idle" || a.Program == nil || a.Program.State != "error" || a.Program.Since == "" {
		t.Fatalf("pane agent after the prompt %+v", ev.Pane.Agent)
	}
	// A new command clears it.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "x\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "daemon" || r.Event != "command" || r.State != "" || r.Program == nil || r.Program.State != "clear" {
		t.Fatalf("a new command %+v", ev.Report)
	}
	if a := ev.Pane.Agent; a == nil || a.Program != nil {
		t.Fatalf("cleared %+v", ev.Pane.Agent)
	}
	// Progress, then the command ends with status 0: done.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "progress\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", func(e proto.Event) bool { return e.Report.Source == "program" })
	if r := ev.Report; r.State != "working" || r.Program == nil || r.Program.State != "working" || r.Program.Progress == nil || *r.Program.Progress != 60 || r.Program.Message != "Uploading" || r.Cwd == "" {
		t.Fatalf("progress %+v %+v", ev.Report, ev.Report.Program)
	}
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Event != "prompt" || r.Program == nil || r.Program.State != "done" {
		t.Fatalf("done by its status %+v", ev.Report)
	}
	// Its own done stays through the prompt, with its message, until the
	// next command.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "done\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "daemon" || r.Event != "command" {
		t.Fatalf("the done command clears the last one first %+v", ev.Report)
	}
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "program" || r.State != "idle" || r.Program == nil || r.Program.State != "done" || r.Program.Message != "Deployed" {
		t.Fatalf("its own done %+v", ev.Report)
	}
	nextEvent(t, c, "pane.prompt", func(e proto.Event) bool { return e.Pane.Shell.State == "prompt" })
	pl := call[proto.ListResult](t, c, "pane.list", nil)
	for _, x := range pl.Panes {
		if x.ID == p.ID && (x.Agent == nil || x.Agent.Program == nil || x.Agent.Program.State != "done" || x.Agent.Program.Message != "Deployed") {
			t.Fatalf("done kept at the prompt %+v", x.Agent)
		}
	}
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "y\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Event != "command" || r.Program == nil || r.Program.State != "clear" {
		t.Fatalf("done cleared by a new command %+v", ev.Report)
	}
	// A hook's agent that was working when the prompt came back ended.
	call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "UserPromptSubmit", "state": "working"})
	nextEvent(t, c, "agent.report", nil)
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "x\n", "mode": "raw"}}})
	ev = nextEvent(t, c, "agent.report", nil)
	if r := ev.Report; r.Source != "daemon" || r.State != "ended" || r.Assistant != "claude" {
		t.Fatalf("hook agent at the prompt %+v", ev.Report)
	}
}

func TestProcessRestartFocus(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	// An interactive shell, so the command it runs gets the terminal.
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-i"}, "cwd": dir, "env": map[string]string{"PS1": "$ "}})
	pr := call[proto.ProcessResult](t, c, "pane.process", map[string]any{"pane": p.ID})
	if pr.Foreground.PID != p.PID || pr.Foreground.Cwd != dir || len(pr.Foreground.Argv) == 0 {
		t.Fatalf("the shell %+v (pane pid %d, dir %s)", pr.Foreground, p.PID, dir)
	}
	sub := filepath.Join(dir, "sub")
	os.Mkdir(sub, 0o755)
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"text": "cd sub && sleep 30\n", "mode": "raw"}}})
	deadline := time.Now().Add(5 * time.Second)
	for {
		pr = call[proto.ProcessResult](t, c, "pane.process", map[string]any{"pane": p.ID})
		// Wait for the whole command line: just after exec, Linux can show
		// an empty /proc/<pid>/cmdline, and the name alone comes from comm.
		if len(pr.Foreground.Argv) == 2 && filepath.Base(pr.Foreground.Argv[0]) == "sleep" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("foreground is not sleep: %+v", pr.Foreground)
		}
		time.Sleep(20 * time.Millisecond)
	}
	f := pr.Foreground
	if f.PID == p.PID || f.Cwd != sub || len(f.Argv) != 2 || f.Argv[1] != "30" || f.Exe == "" || f.StartedAt == "" {
		t.Fatalf("sleep %+v", f)
	}

	// restart: the same command, directory and env, in a new pane.
	q := newPane(t, c, map[string]any{
		"command": []string{"/bin/sh", "-c", `echo "started $FOO in $(pwd)"; exec cat`},
		"cwd":     dir, "env": map[string]string{"FOO": "bar"}, "name": "dev", "cols": 70, "rows": 9,
	})
	waitFor(t, c, q.ID, "started bar in "+dir, 0)
	call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": q.ID, "cols": 90, "rows": 12})
	rs := call[proto.RestartResult](t, c, "pane.restart", map[string]any{"pane": q.ID, "grace_ms": 500})
	if rs.Replaced.ID != q.ID || rs.Pane.ID == q.ID || rs.Pane.Name != "dev" || rs.Pane.Cwd != dir || rs.Pane.Cols != 90 || rs.Replaced.State != "exited" {
		t.Fatalf("restart %+v", rs)
	}
	waitFor(t, c, rs.Pane.ID, "started bar in "+dir, 0)
	if e := callErr(t, c, "pane.process", map[string]any{"pane": q.ID}); e.Code != proto.CodeNotFound {
		t.Fatalf("old pane: %s", e.Code)
	}

	// focus reaches the connections that display panes, and only them.
	win := d.dial(client.Options{Name: "window"})
	call[proto.Empty](t, win, "events.subscribe", map[string]any{"display": true})
	plain := d.dial(client.Options{Name: "script"})
	call[proto.Empty](t, plain, "events.subscribe", nil)
	fr := call[proto.FocusResult](t, c, "pane.focus", map[string]any{"pane": rs.Pane.ID})
	if fr.Displays != 1 {
		t.Fatalf("focus %+v", fr)
	}
	ev := nextEvent(t, win, "pane.focus", nil)
	if ev.Pane.ID != rs.Pane.ID {
		t.Fatalf("focus event %+v", ev)
	}
	noEvent(t, plain, "pane.focus", 200*time.Millisecond)

	// An exited pane has no foreground.
	ex := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "exit 0"}})
	call[proto.WaitResult](t, c, "pane.wait", map[string]any{"pane": ex.ID, "exit": true, "timeout_ms": 5000})
	if e := callErr(t, c, "pane.process", map[string]any{"pane": ex.ID}); e.Code != proto.CodeFailed {
		t.Fatalf("exited pane: %s", e.Code)
	}
}
