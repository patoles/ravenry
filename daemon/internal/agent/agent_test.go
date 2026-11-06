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
	tr.Add(Report{Pane: "p2", Assistant: "cargo", Source: SourceProgram, Event: "status", State: Working})
	if _, st, ok := tr.Gone("p2", "prompt"); !ok || st.State != Idle {
		t.Fatalf("a program's working record ends at the prompt as idle: %+v", st)
	}
	r, st = tr.Add(Report{Assistant: "codex", Source: SourceHook, Event: "Stop", State: Idle})
	if st != nil || r.Pane != "" {
		t.Fatal("a report without a pane has no status")
	}
	all, last, trunc := tr.Since("", 0, 100)
	if len(all) != 10 || last != 10 || trunc {
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
