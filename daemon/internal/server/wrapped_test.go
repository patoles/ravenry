package server

import (
	"strings"
	"testing"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// TestCaptureWrapped: pane.capture says which rows run on into the next
// (a soft wrap), in the scrollback and on the screen, so a reader (the
// phone's live screen, through the hub) can join a line the width cut and
// lay it out again at its own width; a line that ends with a newline does
// not say so.
func TestCaptureWrapped(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	long := strings.Repeat("abcdefghij", 5)
	p := newPane(t, c, map[string]any{"cols": 20, "rows": 4, "command": []string{"/bin/sh", "-c", "printf '" + long + "\\nshort\\n" + long + "\\n'; exec sleep 600"}})
	waitFor(t, c, p.ID, "short", 0)
	var cap proto.CaptureResult
	for i := 0; i < 50; i++ {
		cap = call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 20})
		if strings.Count(strings.Join(texts(cap.Lines), "|"), "abcdefghij") >= 10 {
			break
		}
	}
	joined := []string{}
	cur := ""
	for _, l := range cap.Lines {
		cur += l.Text
		if !l.Wrapped {
			joined = append(joined, cur)
			cur = ""
		}
	}
	got := strings.Join(joined, "|")
	if !strings.Contains(got, long+"|short|"+long) {
		t.Fatalf("joined on wrapped rows: %q\nrows: %+v", got, cap.Lines)
	}
	for _, l := range cap.Lines {
		if l.Text == "short" && l.Wrapped {
			t.Fatalf("a line that ended with a newline says it wraps: %+v", cap.Lines)
		}
	}
}

func texts(ls []proto.Line) []string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = l.Text
	}
	return out
}
