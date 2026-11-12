package server

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/proto"
	"ravenryd/internal/rframe"
	"ravenryd/internal/testprog"
)

// TestRenderDragSyncRedraw drags a pane's width the way a person drags a
// window's edge (a step every 8 to 16 ms) over a program that redraws
// the way Claude Code does after each SIGWINCH (testprog's redraw): it
// starts a synchronized update (mode 2026), erases every row from the
// top, draws the rows again over several writes with pauses between
// them, and ends the update. Every frame the client gets must have every row filled: the
// screen is always full, so a frame with fewer rows shows the erased
// screen or a redraw half done. libghostty ends synchronized output on
// a resize, and a drag step that landed in the middle of the redraw sent
// such a frame out (the maintainer's long Claude tab blanked on every resize,
// 2026-11-11).
//
// The program draws with autowrap off, so a redraw it finishes for a
// width the drag has already left fills every row too: rows laid out
// for an old width are another matter than the one checked here.
func TestRenderDragSyncRedraw(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	d := startDaemon(t)
	c := d.dial(client.Options{})
	var content strings.Builder
	words := strings.Fields("the quick brown fox jumps over the lazy dog while the build runs and the tests pass one by one")
	for i := range 600 {
		fmt.Fprintf(&content, "%04d", i)
		for j := range 2 + i%40 {
			content.WriteString(" " + words[(i+j)%len(words)])
		}
		content.WriteString("\n")
	}
	file := filepath.Join(d.home, "transcript.txt")
	if err := os.WriteFile(file, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	argv, env := testprog.Command("redraw")
	env["RAVENRY_TESTPROG_FILE"] = file
	p := newPane(t, c, map[string]any{"command": argv, "env": env})
	wide, high, narrow := 150, 40, 60
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: wide, Rows: high, FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	// Rows with text, a row that goes on a filled row wrapped into it
	// counted with it: a full row reflowed one column narrower leaves its
	// last cell, maybe a space, on the next row.
	filled := func() int {
		n, above := 0, false
		for y, l := range r.scr.Text() {
			f := l != "" || above && y > 0 && r.scr.Wraps[y-1]
			if f {
				n++
			}
			above = f
		}
		return n
	}
	deadline := time.Now().Add(5 * time.Second)
	for filled() < high || r.scr.Cols != wide {
		if time.Now().After(deadline) {
			t.Fatalf("the program never drew a full screen at %dx%d:\n%s", wide, high, strings.Join(r.scr.Text(), "\n"))
		}
		r.next(time.Until(deadline))
	}
	time.Sleep(200 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}

	// Narrower by 1 to 3 columns a step, then wider again, a step every
	// 8 to 16 ms. One sender, so the sizes reach the daemon in order
	// without the drag waiting for each reply.
	rng := rand.New(rand.NewSource(11))
	var widths []int
	for w := wide; w > narrow; {
		w = max(narrow, w-1-rng.Intn(3))
		widths = append(widths, w)
	}
	for w := narrow; w < wide; {
		w = min(wide, w+1+rng.Intn(3))
		widths = append(widths, w)
	}
	done := make(chan time.Time, 1)
	go func() {
		next := time.Now()
		for i, w := range widths {
			b := fmt.Sprintf(`{"v":%d,"type":"pane.resize","id":%d,"pane":%q,"cols":%d,"rows":%d}`, proto.Version, 2_000_000+i, p.ID, w, high)
			if err := c.WriteRaw(ctx(t), []byte(b)); err != nil {
				t.Error(err)
				break
			}
			next = next.Add(time.Duration(8+rng.Intn(9)) * time.Millisecond)
			time.Sleep(time.Until(next))
		}
		done <- time.Now()
	}()
	var end time.Time
	frames, short, held := 0, 0, 0
	var shots []string
	for end.IsZero() || time.Since(end) < time.Second {
		select {
		case end = <-done:
		default:
		}
		f := r.next(20 * time.Millisecond)
		if f == nil {
			continue
		}
		frames++
		if f.Flags&rframe.FlagHeld != 0 {
			held++
		}
		if n := filled(); n < r.scr.Rows {
			short++
			if len(shots) < 3 {
				shots = append(shots, fmt.Sprintf("%d of %d rows at %dx%d (held %v):\n%s", n, r.scr.Rows, r.scr.Cols, r.scr.Rows, f.Flags&rframe.FlagHeld != 0, strings.Join(r.scr.Text(), "\n")))
			}
		}
	}
	msg := fmt.Sprintf("%d steps at 8 to 16 ms, %d frames: %d with fewer rows than the screen, %d held (the last frame the program finished)",
		len(widths), frames, short, held)
	t.Log(msg)
	fmt.Println("MEASURE " + msg)
	if short > 0 {
		t.Errorf("%d of %d frames during the drag showed the erased screen or a redraw half done; the first:\n%s", short, frames, strings.Join(shots, "\n\n"))
	}
	if r.scr.Cols != wide || filled() != high {
		t.Errorf("after the drag: %dx%d with %d rows filled, want %dx%d full", r.scr.Cols, r.scr.Rows, filled(), wide, high)
	}
}
