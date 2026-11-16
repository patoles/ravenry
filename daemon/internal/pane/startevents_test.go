package pane

import (
	"testing"
	"time"
)

// A program's first output and its exit are told even when they come
// before Manager.New is done with the pane. On a busy two-core Linux
// runner a title printed at once was read before the pane's callbacks
// were set, so pane.title never came (TestPaneLifecycle, 2026-11-16); an
// exit that early lost pane.exited and the pane was never closed. Here a
// pause after the program starts stands in for that scheduler.
func TestEventsFromTheFirstOutput(t *testing.T) {
	afterStart = func() { time.Sleep(300 * time.Millisecond) }
	t.Cleanup(func() { afterStart = nil })
	m := newManager(t)
	evs := make(chan Event, 64)
	defer m.Watch(func(ev Event) { evs <- ev })()
	p := newPane(t, m, Config{Command: []string{"/bin/sh", "-c", `printf '\033]2;first title\007'; exit 3`}})
	var seen []string
	title, exited := false, false
	deadline := time.After(5 * time.Second)
	for !title || !exited {
		select {
		case ev := <-evs:
			if ev.Pane.ID != p.ID() {
				continue
			}
			seen = append(seen, ev.Type)
			switch ev.Type {
			case "title":
				title = ev.Pane.Title == "first title"
			case "exited":
				exited = ev.Pane.Exit != nil && ev.Pane.Exit.Code == 3
			}
		case <-deadline:
			t.Fatalf("events %v: want title %q and exited with 3", seen, "first title")
		}
	}
	if seen[0] != "created" {
		t.Fatalf("events %v: want created first", seen)
	}
}
