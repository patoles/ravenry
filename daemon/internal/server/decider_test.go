package server

import (
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// A decider counts from the moment its agent.decisions result is out: a
// report sent right after it, on another connection, asks it. On a busy
// two-core Linux runner the result went out before the connection was
// counted, and such a report found no decider (packages/node-client's
// daemon test, asked 0, 2026-11-16). A pause after the result stands in
// for that scheduler.
func TestDeciderCountsOnceItsAnswerIsOut(t *testing.T) {
	afterDecisionsReply = func() { time.Sleep(300 * time.Millisecond) }
	t.Cleanup(func() { afterDecisionsReply = nil })
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", "exec cat"}})
	hub := d.dial(client.Options{Name: "hub"})
	call[proto.Empty](t, hub, "agent.decisions", nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ev := nextEvent(t, hub, "agent.decision", nil)
		call[proto.Empty](t, hub, "agent.decide", map[string]any{"request": *ev.Request, "reply": map[string]any{"stdout": "held " + ev.Report.Event}})
	}()
	r := call[proto.AgentReportResult](t, c, "agent.report", map[string]any{"pane": p.ID, "assistant": "claude", "event": "Stop", "state": "idle", "decide": true, "timeout_ms": 3000})
	if r.Asked != 1 || r.Reply == nil || r.Reply.Stdout != "held Stop" {
		t.Fatalf("report right after agent.decisions: %+v", r)
	}
	<-done
}
