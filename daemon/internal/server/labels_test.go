package server

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// nextEvent returns the next event named one of names about pane id (any
// pane when id is empty).
func eventAbout(t *testing.T, c *client.Client, id string, names ...string) proto.Event {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-c.Events():
			for _, n := range names {
				if ev.Event == n && (id == "" || (ev.Pane != nil && ev.Pane.ID == id) || (ev.Checkpoint != nil && ev.Checkpoint.ID == id)) {
					return ev
				}
			}
		case <-deadline:
			t.Fatalf("no %v event for %s", names, id)
		}
	}
}

func TestLabelsNameAndUpdate(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	if err := c.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	a := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}, "name": "Shell", "labels": map[string]string{"ravenry.kind": "shell", "app/x": "1"}})
	b := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}})
	if a.Labels["ravenry.kind"] != "shell" || b.Labels != nil {
		t.Fatalf("labels %v %v", a.Labels, b.Labels)
	}
	l := call[proto.ListResult](t, c, "pane.list", map[string]any{"labels": map[string]string{"ravenry.kind": "shell"}})
	if len(l.Panes) != 1 || l.Panes[0].ID != a.ID {
		t.Fatalf("filtered list %+v", l.Panes)
	}
	u := call[proto.PaneResult](t, c, "pane.update", map[string]any{"pane": b.ID, "name": "Renamed", "labels": map[string]any{"ravenry.kind": "shell"}})
	if u.Pane.Name != "Renamed" || u.Pane.Labels["ravenry.kind"] != "shell" {
		t.Fatalf("update %+v", u.Pane)
	}
	ev := eventAbout(t, c, b.ID, "pane.updated")
	if ev.Pane.Name != "Renamed" {
		t.Fatalf("updated event %+v", ev.Pane)
	}
	u = call[proto.PaneResult](t, c, "pane.update", map[string]any{"pane": a.ID, "labels": map[string]any{"app/x": nil}})
	if _, ok := u.Pane.Labels["app/x"]; ok || u.Pane.Labels["ravenry.kind"] != "shell" {
		t.Fatalf("remove label %+v", u.Pane.Labels)
	}
	if l = call[proto.ListResult](t, c, "pane.list", map[string]any{"labels": map[string]string{"ravenry.kind": "shell"}}); len(l.Panes) != 2 {
		t.Fatalf("both are shells now: %d", len(l.Panes))
	}
	// Restart keeps the name and labels as they are now.
	r := call[proto.RestartResult](t, c, "pane.restart", map[string]any{"pane": b.ID, "grace_ms": 200})
	if r.Pane.Name != "Renamed" || r.Pane.Labels["ravenry.kind"] != "shell" {
		t.Fatalf("restart %+v", r.Pane)
	}
	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	for _, bad := range []map[string]any{
		{"pane": a.ID},
		{"pane": a.ID, "labels": map[string]any{"Bad Key": "x"}},
		{"pane": a.ID, "labels": map[string]any{"k": "a\x01b"}},
		{"pane": a.ID, "name": strings.Repeat("n", 300)},
	} {
		if e := callErr(t, c, "pane.update", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
	if e := callErr(t, c, "pane.update", map[string]any{"pane": "pnothere", "name": "x"}); e.Code != proto.CodeNotFound {
		t.Fatalf("missing pane: %s", e.Code)
	}
}

func TestCwdFromOSC7(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	if err := c.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	start, next := t.TempDir(), t.TempDir()
	host, _ := os.Hostname()
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `read x; printf '\033]7;file://elsewhere.example/tmp\007'; printf '\033]7;file://%s%s\007' "$1" "$2"; echo moved; exec cat`, "sh", host, next}, "cwd": start})
	if p.Cwd != start {
		t.Fatalf("start cwd %q", p.Cwd)
	}
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Enter"}}})
	ev := eventAbout(t, c, p.ID, "pane.cwd")
	if ev.Pane.Cwd != next {
		t.Fatalf("cwd event %q, want %q (the other host's /tmp is not this pane's)", ev.Pane.Cwd, next)
	}
	l := call[proto.ListResult](t, c, "pane.list", map[string]any{})
	if l.Panes[0].Cwd != next {
		t.Fatalf("listed cwd %q", l.Panes[0].Cwd)
	}
	// Restart starts in the folder the pane is in now.
	r := call[proto.RestartResult](t, c, "pane.restart", map[string]any{"pane": p.ID, "grace_ms": 200})
	if r.Pane.Cwd != next {
		t.Fatalf("restart cwd %q", r.Pane.Cwd)
	}
}

func TestActivityForPanesNotStreamed(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	call[proto.Empty](t, c, "events.subscribe", map[string]any{"activity": true})
	quiet := d.dial(client.Options{})
	if err := quiet.SubscribeEvents(ctx(t)); err != nil {
		t.Fatal(err)
	}
	// A pane that prints ten times a second for two seconds.
	p := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `i=0; while [ $i -lt 20 ]; do echo tick $i; i=$((i+1)); sleep 0.1; done; exec cat`}})
	first := eventAbout(t, c, p.ID, "pane.activity")
	n := 1
	deadline := time.After(2500 * time.Millisecond)
loop:
	for {
		select {
		case ev := <-c.Events():
			if ev.Event == "pane.activity" && ev.Pane.ID == p.ID {
				n++
			}
		case <-deadline:
			break loop
		}
	}
	if n < 2 || n > 4 {
		t.Fatalf("%d activity events in about 2.5 s; want one a second (first at mark %d)", n, first.Pane.Mark)
	}
	// A connection that did not ask gets none.
	for len(quiet.Events()) > 0 {
		if ev := <-quiet.Events(); ev.Event == "pane.activity" {
			t.Fatal("activity to a connection that did not ask")
		}
	}
	// A pane this connection streams gets none: it sees the output itself.
	q := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}})
	st, err := c.Subscribe(ctx(t), q.ID, client.SubscribeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	<-st.Frames
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": q.ID, "input": []map[string]any{{"text": "hello\n", "mode": "raw"}}})
	waitFor(t, c, q.ID, "hello", 0)
	time.Sleep(1200 * time.Millisecond)
	for len(c.Events()) > 0 {
		if ev := <-c.Events(); ev.Event == "pane.activity" && ev.Pane.ID == q.ID {
			t.Fatal("activity about a pane this connection streams")
		}
	}
}

func TestFileStatAndRead(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	dir := t.TempDir()
	f := filepath.Join(dir, "t.jsonl")
	body := strings.Repeat("0123456789", 1000) // 10000 bytes
	os.WriteFile(f, []byte(body), 0o600)
	st := call[proto.FileStatResult](t, c, "file.stat", map[string]any{"paths": []string{f, dir, filepath.Join(dir, "none")}})
	if st.Files[0].Type != "file" || *st.Files[0].Size != 10000 || st.Files[1].Type != "dir" || st.Files[2].Type != "none" || st.Files[2].Size != nil {
		t.Fatalf("stat %+v", st.Files)
	}
	r := call[proto.FileReadResult](t, c, "file.read", map[string]any{"path": f, "tail": 25})
	if r.From != 9975 || r.To != 10000 || *r.Text != body[9975:] || r.Size != 10000 {
		t.Fatalf("tail %+v", r)
	}
	r = call[proto.FileReadResult](t, c, "file.read", map[string]any{"path": f, "offset": 10, "limit": 5, "format": "raw"})
	b, _ := base64.StdEncoding.DecodeString(*r.Data)
	if string(b) != "01234" || r.From != 10 || r.To != 15 {
		t.Fatalf("offset %+v %q", r, b)
	}
	// A tail longer than the limit keeps the file's last bytes.
	r = call[proto.FileReadResult](t, c, "file.read", map[string]any{"path": f, "tail": 5000, "limit": 3})
	if *r.Text != "789" || r.From != 9997 {
		t.Fatalf("tail with limit %+v", r)
	}
	if e := callErr(t, c, "file.read", map[string]any{"path": filepath.Join(dir, "none")}); e.Code != proto.CodeNotFound {
		t.Fatalf("missing: %s", e.Code)
	}
	if e := callErr(t, c, "file.read", map[string]any{"path": dir}); e.Code != proto.CodeFailed {
		t.Fatalf("a folder: %s", e.Code)
	}
	sendingInvalid.Store(true)
	defer sendingInvalid.Store(false)
	for _, bad := range []map[string]any{{"path": "relative"}, {"path": f, "tail": 1, "offset": 0}, {"path": f, "limit": 9 << 20}} {
		if e := callErr(t, c, "file.read", bad); e.Code != proto.CodeBadRequest {
			t.Fatalf("%v: %s", bad, e.Code)
		}
	}
	if e := callErr(t, c, "file.stat", map[string]any{"paths": []string{}}); e.Code != proto.CodeBadRequest {
		t.Fatalf("no paths: %s", e.Code)
	}
}

// A bell in a pane a window does not show: pane.bell, for its tab (the
// terminal-basics picture, F4). A BEL that ends an OSC sequence (a title)
// is not a bell; a program ringing in a loop gives one a second.
func TestBellForPanesNotStreamed(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	call[proto.Empty](t, c, "events.subscribe", map[string]any{"activity": true})
	title := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `printf '\033]0;a title\007'; printf '\033]2;another\007done\n'; exec cat`}})
	ring := newPane(t, c, map[string]any{"command": []string{"/bin/sh", "-c", `sleep 0.3; i=0; while [ $i -lt 10 ]; do printf '\007'; i=$((i+1)); sleep 0.05; done; exec cat`}})
	n := map[string]int{}
	deadline := time.After(2500 * time.Millisecond)
loop:
	for {
		select {
		case ev := <-c.Events():
			if ev.Event == "pane.bell" {
				n[ev.Pane.ID]++
			}
		case <-deadline:
			break loop
		}
	}
	if n[title.ID] != 0 {
		t.Fatalf("%d bells for a pane that only set its title", n[title.ID])
	}
	if n[ring.ID] < 1 || n[ring.ID] > 2 {
		t.Fatalf("%d bells for ten rings in half a second; want one a second", n[ring.ID])
	}
}

// A pane's scrollback: set at pane.new, changed with pane.update, said in
// the pane's info (the app's Scrollback setting, past the default 10,000).
func TestScrollbackSetAndChanged(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}, "scrollback": 20000})
	if p.Scrollback != 20000 {
		t.Fatalf("pane.new scrollback: %d", p.Scrollback)
	}
	r := call[proto.PaneResult](t, c, "pane.update", map[string]any{"pane": p.ID, "scrollback": 50000})
	if r.Pane.Scrollback != 50000 {
		t.Fatalf("pane.update scrollback: %d", r.Pane.Scrollback)
	}
	for _, lp := range call[proto.ListResult](t, c, "pane.list", map[string]any{}).Panes {
		if lp.ID == p.ID && lp.Scrollback != 50000 {
			t.Fatalf("pane.list scrollback: %d", lp.Scrollback)
		}
	}
	// Out of range (0, or over 1,000,000): the schema and the server refuse it.
	q := newPane(t, c, map[string]any{"command": []string{"/bin/cat"}})
	if q.Scrollback != 10000 {
		t.Fatalf("the default: %d", q.Scrollback)
	}
}
