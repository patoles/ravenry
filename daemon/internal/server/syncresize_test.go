package server

import (
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/rframe"
)

// TestRenderSyncResize: a program that is in the middle of a synchronized
// update (mode 2026) when the window is resized gets its redraw at the new
// size shown at once: the update it ends after the resize ends the hold,
// so the render stream never waits out the second a program may hold the
// screen for (Claude Code draws every frame in synchronized output, and a
// person dragging the window's edge saw it redraw once a second,
// 2026-11-10). The resize itself no longer ends the hold
// (TestRenderDragSyncRedraw).
func TestRenderSyncResize(t *testing.T) {
	d := startDaemon(t)
	c := d.dial(client.Options{})
	// Opens an update and never closes it; at each new size it draws
	// itself in an update it closes, as Claude Code does. Made at the
	// stream's size: a stream at another one resizes the pane as it opens,
	// and the redraw for that erased "before" whenever the program had
	// drawn it first (TestRenderSyncResize on GitHub's runner, 2026-11-16).
	p := newPane(t, c, map[string]any{"cols": 100, "rows": 20, "command": []string{"/bin/sh", "-c",
		`trap 'printf "\033[?2026h\033[2J\033[Hredraw %s\033[?2026l" "$(stty size | tr " " x)"' WINCH
printf 'before\n\033[?2026hhalf'
while :; do sleep 0.01; done`}})
	// The program has drawn before the stream opens (a busy runner gets
	// there first anyway).
	waitFor(t, c, p.ID, `before`, 0)
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: 100, Rows: 20, FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("before")
	// The program holds the screen: "half" is not shown yet.
	time.Sleep(50 * time.Millisecond)
	for f := r.next(20 * time.Millisecond); f != nil; f = r.next(20 * time.Millisecond) {
	}
	if strings.Contains(strings.Join(r.scr.Text(), "\n"), "half") {
		t.Fatalf("a half-done update was shown:\n%s", strings.Join(r.scr.Text(), "\n"))
	}
	for i, cols := range []int{90, 80, 70, 60} {
		at := time.Now()
		call[map[string]any](t, c, "pane.resize", map[string]any{"pane": p.ID, "cols": cols, "rows": 20})
		want := "redraw 20x" + itoa(cols)
		var got *rframe.Frame
		deadline := at.Add(time.Second)
		for !strings.Contains(strings.Join(r.scr.Text(), "\n"), want) || got == nil || got.Flags&rframe.FlagHeld != 0 {
			if time.Now().After(deadline) {
				t.Fatalf("resize %d to %d columns: %q not shown unheld within 1 s:\n%s", i, cols, want, strings.Join(r.scr.Text(), "\n"))
			}
			if f := r.next(time.Until(deadline)); f != nil {
				got = f
			}
		}
		if took := time.Since(at); took > 300*time.Millisecond {
			t.Errorf("resize %d to %d columns: the redraw took %v to show, want well under the 1 s hold", i, cols, took)
		}
	}
}

func itoa(n int) string {
	var b []byte
	for n > 0 || len(b) == 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
