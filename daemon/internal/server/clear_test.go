package server

import (
	"bytes"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// nextFrame reads the stream's next frame, acknowledging it.
func nextFrame(t *testing.T, s *client.Stream) client.Frame {
	t.Helper()
	select {
	case f, ok := <-s.Frames:
		if !ok {
			t.Fatal("the stream ended")
		}
		s.Ack(ctx(t), len(f.Data))
		return f
	case <-time.After(10 * time.Second):
		t.Fatal("no frame")
	}
	return client.Frame{}
}

// pane.clear: the prompt's row moves to the top, the rest of the screen
// and the history go, every stream gets a fresh snapshot, and a stream
// from a mark before the clear starts with a snapshot too.
func TestPaneClear(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	p := newPane(t, c, map[string]any{"cols": 40, "rows": 10, "command": []string{"/bin/sh", "-c",
		`i=0; while [ $i -lt 200 ]; do echo "line $i"; i=$((i+1)); done; printf 'PROMPT> '; read x; printf '\033[?1049h\033[HFULL'; sleep 30`}})
	waitFor(t, c, p.ID, `PROMPT> `, 0)

	st, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{Ack: true})
	if err != nil {
		t.Fatal(err)
	}
	if f := nextFrame(t, st); !f.Snapshot || !bytes.Contains(f.Data, []byte("line 150")) {
		t.Fatalf("first frame: snapshot %v, %d bytes", f.Snapshot, len(f.Data))
	}

	r := call[proto.ClearResult](t, c, "pane.clear", map[string]any{"pane": p.ID})
	if !r.Cleared || r.Pane.ID != p.ID {
		t.Fatalf("clear %+v", r)
	}
	f := nextFrame(t, st)
	if !f.Snapshot || bytes.Contains(f.Data, []byte("line ")) || !bytes.Contains(f.Data, []byte("PROMPT> ")) {
		t.Fatalf("after clear: snapshot %v, %q", f.Snapshot, f.Data)
	}
	cp := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 1000})
	if cp.History != 0 || cp.Lines[0].Text != "PROMPT>" || cp.Cursor.Y != 0 || cp.Cursor.X != 8 {
		t.Fatalf("capture after clear: history %d, first %q, cursor %+v", cp.History, cp.Lines[0].Text, cp.Cursor)
	}

	// A stream from mark 0 would replay the cleared lines: it gets a
	// snapshot instead.
	zero := uint64(0)
	st2, err := c.Subscribe(ctx(t), p.ID, client.SubscribeOptions{Ack: true, Since: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if f := nextFrame(t, st2); !f.Snapshot || bytes.Contains(f.Data, []byte("line ")) {
		t.Fatalf("stream since 0 after clear: snapshot %v, %q", f.Snapshot, f.Data)
	}

	// On the alternate screen nothing changes.
	call[proto.SendResult](t, c, "pane.send", map[string]any{"pane": p.ID, "input": []map[string]any{{"key": "Enter"}}})
	waitFor(t, c, p.ID, `FULL`, 0)
	if r := call[proto.ClearResult](t, c, "pane.clear", map[string]any{"pane": p.ID}); r.Cleared {
		t.Fatalf("clear on the alternate screen %+v", r)
	}
	if cp := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID}); cp.Lines[0].Text != "FULL" {
		t.Fatalf("alternate screen after clear: %q", cp.Lines[0].Text)
	}
	if e := callErr(t, c, "pane.clear", map[string]any{"pane": "nopane00"}); e.Code != proto.CodeNotFound {
		t.Fatalf("clear of no pane: %s", e.Code)
	}
}
