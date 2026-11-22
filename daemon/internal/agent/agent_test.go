package agent

import (
	"strings"
	"testing"
)

func TestStates(t *testing.T) {
	tr := New()
	if tr.Status("p1") != nil {
		t.Fatal("status before any report")
	}
	_, st := tr.Add(Report{Pane: "p1", Assistant: "claude", Session: "s1", Source: SourceHook, Event: "SessionStart", State: Idle})
	if st.State != Idle || st.Assistant != "claude" || st.Session != "s1" {
		t.Fatalf("%+v", st)
	}
	_, st = tr.Add(Report{Pane: "p1", Assistant: "claude", Source: SourceHook, Event: "UserPromptSubmit", State: Working})
	if st.State != Working || st.Session != "s1" {
		t.Fatalf("%+v", st)
	}
	since := st.Since
	_, st = tr.Add(Report{Pane: "p1", Assistant: "claude", Source: SourceHook, Event: "Notification"})
	if st.State != Working || st.Since != since || st.Event != "Notification" {
		t.Fatalf("a report without a state changes only the last event: %+v", st)
	}
	_, st = tr.Add(Report{Pane: "p1", Assistant: "claude", Source: SourceHook, Event: "Notification", State: NeedsYou, Need: &Need{Kind: "permission", Message: "Run ls?"}})
	if st.State != NeedsYou || st.Need == nil || st.Need.Message != "Run ls?" {
		t.Fatalf("%+v", st)
	}
	r, st := tr.Add(Report{Pane: "p1", Assistant: "claude", Source: SourceHook, Event: "Stop", State: Idle, Need: &Need{Kind: "other"}})
	if st.State != Idle || st.Need != nil || r.Need != nil {
		t.Fatalf("idle keeps no need: %+v %+v", st, r)
	}
	if _, _, ok := tr.Gone("p1", "prompt"); ok {
		t.Fatal("a prompt after an idle agent changes nothing")
	}
	tr.Add(Report{Pane: "p1", Assistant: "claude", Source: SourceHook, Event: "UserPromptSubmit", State: Working})
	r, st, ok := tr.Gone("p1", "exit")
	if !ok || st.State != Ended || r.Source != SourceDaemon || r.Assistant != "claude" {
		t.Fatalf("gone: %v %+v %+v", ok, st, r)
	}
	// A hook run from the shell itself: its process (the shell) still
	// runs, so the prompt that follows does not end it; the pane's exit
	// does.
	tr.Alive = func(pid int) bool { return pid == 4242 }
	tr.Add(Report{Pane: "p3", Assistant: "claude", Source: SourceHook, Event: "Notification", State: NeedsYou, PID: 4242})
	if _, _, ok := tr.Gone("p3", "prompt"); ok {
		t.Fatal("an agent whose process runs is not gone at a prompt")
	}
	tr.Add(Report{Pane: "p3", Assistant: "claude", Source: SourceHook, Event: "UserPromptSubmit", State: Working, PID: 77})
	if _, st, ok := tr.Gone("p3", "prompt"); !ok || st.State != Ended {
		t.Fatalf("an agent whose process ended is gone at the prompt: %+v", st)
	}
	tr.Forget("p3")
	tr.Alive = nil
	tr.Add(Report{Pane: "p2", Assistant: "cargo", Source: SourceProgram, Event: "status", State: Working})
	if _, st, ok := tr.Gone("p2", "prompt"); !ok || st.State != Idle {
		t.Fatalf("a program's working record ends at the prompt as idle: %+v", st)
	}
	r, st = tr.Add(Report{Assistant: "codex", Source: SourceHook, Event: "Stop", State: Idle})
	if st != nil || r.Pane != "" {
		t.Fatal("a report without a pane has no status")
	}
	all, last, trunc := tr.Since("", 0, 100)
	if len(all) != 13 || last != 13 || trunc {
		t.Fatalf("since: %d %d %v", len(all), last, trunc)
	}
	p2, _, _ := tr.Since("p2", 0, 100)
	if len(p2) != 2 {
		t.Fatalf("p2: %d", len(p2))
	}
	two, _, _ := tr.Since("", 3, 2)
	if len(two) != 2 || two[0].Seq != 4 {
		t.Fatalf("limit: %+v", two)
	}
	tr.Forget("p1")
	if tr.Status("p1") != nil {
		t.Fatal("forgotten")
	}
}

func TestRingCaps(t *testing.T) {
	tr := New()
	for i := 0; i < MaxReports+10; i++ {
		tr.Add(Report{Assistant: "a", Source: SourceHook, Event: "e"})
	}
	all, last, trunc := tr.Since("", 0, MaxReports+100)
	if len(all) != MaxReports || last != MaxReports+10 || !trunc || all[0].Seq != 11 {
		t.Fatalf("count cap: %d %d %v %d", len(all), last, trunc, all[0].Seq)
	}
	big := []byte(`{"x":"` + strings.Repeat("y", 1<<20) + `"}`)
	for i := 0; i < 40; i++ {
		tr.Add(Report{Assistant: "a", Source: SourceHook, Event: "e", Data: big})
	}
	all, _, _ = tr.Since("", 0, MaxReports+100)
	n := 0
	for _, r := range all {
		n += len(r.Data)
	}
	if n > MaxRingBytes {
		t.Fatalf("byte cap: %d", n)
	}
}

// PostToolUse keeps the paths a tool wrote, never what it wrote.
func TestHookDataToolFiles(t *testing.T) {
	in := `{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/w/a.go","old_string":"SECRET","new_string":"x"},"tool_response":{"filePath":"/w/a.go","content":"SECRET"}}`
	out := string(HookData([]byte(in)))
	if strings.Contains(out, "SECRET") || !strings.Contains(out, `"tool_files":["/w/a.go"]`) {
		t.Fatalf("Claude Code: %s", out)
	}
	codex := `{"hook_event_name":"PostToolUse","tool_name":"apply_patch","tool_input":{"command":["apply_patch","*** Begin Patch\n*** Add File: n.txt\n+SECRET\n*** Update File: m.go\n*** Move to: m2.go\n*** Delete File: old.go\n*** End Patch"]}}`
	out = string(HookData([]byte(codex)))
	if strings.Contains(out, "SECRET") || !strings.Contains(out, `"tool_files":["n.txt","m.go","m2.go","old.go"]`) {
		t.Fatalf("Codex: %s", out)
	}
	if again := string(HookData([]byte(out))); again != out {
		t.Fatalf("not idempotent: %s then %s", out, again)
	}
}

// A program's own record: done and error stay apart from idle, its
// outcome comes from the command's status when it said nothing, and a new
// command clears it.
func TestProgramRecord(t *testing.T) {
	tr := New()
	_, st := tr.Add(Report{Pane: "p1", Assistant: "deploy", Source: SourceProgram, Event: "status", State: Working, Program: &Program{State: "working", Progress: 60, Message: "Uploading"}})
	if st.Program == nil || st.Program.State != "working" || st.Program.Progress != 60 || st.Program.Since.IsZero() {
		t.Fatalf("working %+v", st.Program)
	}
	since := st.Program.Since
	_, st = tr.Add(Report{Pane: "p1", Assistant: "deploy", Source: SourceProgram, Event: "status", State: Working, Program: &Program{State: "working", Progress: 80}})
	if st.Program.Progress != 80 || !st.Program.Since.Equal(since) {
		t.Fatalf("the same state keeps its since %+v", st.Program)
	}
	if _, _, ok := tr.NewCommand("p1"); ok {
		t.Fatal("a working record is not cleared by a command start")
	}
	r, st, ok := tr.GoneExit("p1", "prompt", 2, true)
	if !ok || st.State != Idle || r.Program == nil || r.Program.State != "error" || st.Program == nil || st.Program.State != "error" {
		t.Fatalf("status 2 is error: %+v %+v", r.Program, st.Program)
	}
	if _, _, ok := tr.GoneExit("p1", "prompt", 0, true); ok {
		t.Fatal("an idle pane changes nothing at the next prompt")
	}
	r, st, ok = tr.NewCommand("p1")
	if !ok || r.Program.State != "clear" || st.Program != nil || r.State != "" {
		t.Fatalf("a new command clears it: %+v %+v", r, st)
	}
	tr.Add(Report{Pane: "p1", Source: SourceProgram, Event: "status", State: NeedsYou, Need: &Need{Kind: "auth"}, Program: &Program{State: "blocked", Kind: "auth"}})
	if _, st, _ := tr.GoneExit("p1", "prompt", 0, true); st.Program == nil || st.Program.State != "done" {
		t.Fatalf("status 0 is done: %+v", st.Program)
	}
	tr.NewCommand("p1")
	tr.Add(Report{Pane: "p1", Source: SourceProgram, Event: "status", State: Working, Program: &Program{State: "working"}})
	if _, st, _ := tr.GoneExit("p1", "prompt", 130, true); st.Program != nil {
		t.Fatalf("an interrupt clears it: %+v", st.Program)
	}
	tr.Add(Report{Pane: "p1", Source: SourceProgram, Event: "status", State: Working, Program: &Program{State: "working"}})
	if _, st, _ := tr.Gone("p1", "prompt"); st.Program != nil {
		t.Fatalf("no status known clears it: %+v", st.Program)
	}
	_, st = tr.Add(Report{Pane: "p1", Source: SourceProgram, Event: "status", State: Idle, Program: &Program{State: "done", Message: "Deployed"}})
	if st.State != Idle || st.Program == nil || st.Program.State != "done" {
		t.Fatalf("its own done: %+v", st)
	}
	if _, _, ok := tr.GoneExit("p1", "prompt", 1, true); ok {
		t.Fatal("its own done stays through the prompt")
	}
	_, st = tr.Add(Report{Pane: "p1", Source: SourceProgram, Event: "status", State: Idle, Program: &Program{State: "clear"}})
	if st.Program != nil {
		t.Fatalf("clear ends it: %+v", st.Program)
	}
}
