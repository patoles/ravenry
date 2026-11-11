package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// TestResizeCoalesce: a program that is not a shell at its prompt is
// told a resize on its own at once, and, during a drag, only the size
// the drag paused or ended at, never a size the drag had left (the
// program writes each size it is told to a file).
func TestResizeCoalesce(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	d := startDaemon(t)
	c := d.dial(client.Options{})
	sizes := filepath.Join(d.home, "sizes")
	p := newPane(t, c, map[string]any{"cols": 120, "rows": 30, "command": []string{"/bin/sh", "-c",
		`trap 'stty size >> "$1"' WINCH; echo ready; while :; do sleep 0.01; done`, "sh", sizes}})
	waitFor(t, c, p.ID, "ready", 0)
	told := func() []string {
		b, _ := os.ReadFile(sizes)
		return strings.Fields(strings.ReplaceAll(strings.TrimSpace(string(b)), " ", "x"))
	}
	resize := func(cols int) proto.Pane {
		return call[proto.PaneResult](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": cols, "rows": 30}).Pane
	}
	drag := func(from, to int) {
		step := 1
		if to < from {
			step = -1
		}
		for w := from + step; ; w += step {
			b := fmt.Sprintf(`{"v":%d,"type":"pane.resize","id":%d,"pane":%q,"cols":%d,"rows":30}`, proto.Version, 4_000_000+w, p.ID, w)
			if err := c.WriteRaw(ctx(t), []byte(b)); err != nil {
				t.Fatal(err)
			}
			if w == to {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	settle := func(want []string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for strings.Join(told(), " ") != strings.Join(want, " ") {
			if time.Now().After(deadline) {
				t.Fatalf("the program was told %v, want %v", told(), want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	// A resize on its own: at once.
	if got := resize(100); got.Cols != 100 {
		t.Fatalf("a resize on its own: the pane is %d columns, want 100 at once", got.Cols)
	}
	settle([]string{"30x100"})
	time.Sleep(400 * time.Millisecond)

	// A drag: its first step at once (it may be a resize on its own),
	// then only where it ended.
	drag(100, 70)
	if got := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID}); got.Cols != 99 {
		t.Errorf("during the drag the pane is %d columns, want 99 (its first step)", got.Cols)
	}
	settle([]string{"30x100", "30x99", "30x70"})

	// Another drag at once, out and back, a pause shorter than the
	// program's redraw wait in the middle: the size it ends at only.
	drag(70, 90)
	time.Sleep(30 * time.Millisecond)
	drag(90, 80)
	settle([]string{"30x100", "30x99", "30x70", "30x80"})
	time.Sleep(500 * time.Millisecond)
	if got := told(); len(got) != 4 {
		t.Errorf("after the drags the program was told %v", got)
	}
}
