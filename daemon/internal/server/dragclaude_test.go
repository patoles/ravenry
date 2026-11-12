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
	"ravenryd/internal/testprog"
)

// TestRenderDragClaude drags a pane's width the way a person drags a
// window's edge (a step every 8 to 16 ms, narrower, a pause, wider)
// over a program that draws as Claude Code does (testprog's redraw with
// RAVENRY_TESTPROG_REDRAW=claude): words at absolute columns (ESC[<col>G),
// rows one under the other, a redraw for every size it is told, in
// order, 120 to 200 ms after it. Busy, it also updates a spinner line 10
// times a second with relative moves. A client on the render stream
// must never see:
//
//   - bars: a lone character in the last column on many rows, what a
//     redraw laid out for a wider width gives on a narrower screen (each
//     word past the margin goes to the last column; the maintainer on 0.1.31:
//     "still blanks, and vertical bars of characters too now");
//   - a frame short of rows (a blank screen, a redraw half done);
//   - a frame that is not a screen the program drew for a size it was
//     told, cut or padded to the frame's size (a reflowed screen, a
//     redraw for one size on a screen of another);
//
// and after the drag the screen must be the program's at the last size,
// with nothing in the scrollback that is not a piece of the transcript.
func TestRenderDragClaude(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	for _, mode := range []string{"claude", "claude-busy"} {
		t.Run(mode, func(t *testing.T) { dragClaude(t, mode) })
	}
}

func dragClaude(t *testing.T, mode string) {
	busy := mode == "claude-busy"
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
	lines := strings.Split(strings.TrimRight(content.String(), "\n"), "\n")
	file := filepath.Join(d.home, "transcript.txt")
	if err := os.WriteFile(file, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	argv, env := testprog.Command("redraw")
	env["RAVENRY_TESTPROG_FILE"] = file
	env["RAVENRY_TESTPROG_REDRAW"] = mode
	wide, high, narrow := 150, 40, 60
	p := newPane(t, c, map[string]any{"command": argv, "env": env, "cols": wide, "rows": high})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{Cols: wide, Rows: high, FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	norm := func(rows []string) []string {
		out := make([]string, len(rows))
		for i, l := range rows {
			if strings.Contains(l, testprog.SpinnerText) {
				l = testprog.SpinnerText
			}
			out[i] = l
		}
		return out
	}
	// The screens the program draws, by width (the height stays).
	screens := map[int][]string{}
	screen := func(cols int) []string {
		if s, ok := screens[cols]; ok {
			return s
		}
		s := norm(testprog.ClaudeScreen(lines, cols, high, busy))
		screens[cols] = s
		return s
	}
	same := func(a, b []string) bool { return strings.Join(a, "\n") == strings.Join(b, "\n") }
	deadline := time.Now().Add(5 * time.Second)
	for !same(norm(r.scr.Text()), screen(wide)) {
		if time.Now().After(deadline) {
			t.Fatalf("the program never drew its screen at %dx%d:\n%s", wide, high, strings.Join(r.scr.Text(), "\n"))
		}
		r.next(time.Until(deadline))
	}
	time.Sleep(200 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}

	// Narrower by 1 to 3 columns a step, a pause, wider again; a step
	// every 8 to 16 ms, from one sender, so the sizes come in order.
	rng := rand.New(rand.NewSource(7))
	type step struct {
		cols  int
		pause time.Duration
	}
	var steps []step
	for w := wide; w > narrow; {
		w = max(narrow, w-1-rng.Intn(3))
		steps = append(steps, step{w, time.Duration(8+rng.Intn(9)) * time.Millisecond})
	}
	steps[len(steps)-1].pause = 300 * time.Millisecond
	for w := narrow; w < wide; {
		w = min(wide, w+1+rng.Intn(3))
		steps = append(steps, step{w, time.Duration(8+rng.Intn(9)) * time.Millisecond})
	}
	told := map[int]bool{wide: true}
	for _, s := range steps {
		told[s.cols] = true
	}
	done := make(chan time.Time, 1)
	go func() {
		next := time.Now()
		for i, s := range steps {
			b := fmt.Sprintf(`{"v":%d,"type":"pane.resize","id":%d,"pane":%q,"cols":%d,"rows":%d}`, proto.Version, 3_000_000+i, p.ID, s.cols, high)
			if err := c.WriteRaw(ctx(t), []byte(b)); err != nil {
				t.Error(err)
				break
			}
			next = next.Add(s.pause)
			time.Sleep(time.Until(next))
		}
		done <- time.Now()
	}()

	// bars counts the rows with a lone character in the last column.
	bars := func(rows []string, cols int) int {
		n := 0
		for _, l := range rows {
			rs := []rune(l)
			if len(rs) == cols && cols > 3 && rs[cols-1] != ' ' && rs[cols-2] == ' ' && rs[cols-3] == ' ' {
				n++
			}
		}
		return n
	}
	// cut is a screen cut or padded to cols x rows, its last rows kept.
	cut := func(s []string, cols, rows int) []string {
		s = s[max(0, len(s)-rows):]
		out := make([]string, rows)
		for y := range out {
			if y < len(s) {
				rs := []rune(s[y])
				out[y] = strings.TrimRight(string(rs[:min(len(rs), cols)]), " ")
			}
		}
		return out
	}
	drawn := func(text []string, cols, rows int) bool {
		for w := range told {
			if same(text, cut(screen(w), cols, rows)) {
				return true
			}
		}
		return false
	}
	var end time.Time
	frames, barred, short, other := 0, 0, 0, 0
	var shots []string
	shot := func(what string, text []string) {
		if len(shots) < 3 {
			shots = append(shots, fmt.Sprintf("%s at %dx%d:\n%s", what, r.scr.Cols, r.scr.Rows, strings.Join(text, "\n")))
		}
	}
	for end.IsZero() || time.Since(end) < 1500*time.Millisecond {
		select {
		case end = <-done:
		default:
		}
		f := r.next(20 * time.Millisecond)
		if f == nil {
			continue
		}
		frames++
		text := norm(r.scr.Text())
		blank := 0
		for _, l := range text {
			if l == "" {
				blank++
			}
		}
		switch {
		case bars(text, r.scr.Cols) >= 4:
			barred++
			shot("bars", text)
		case blank > 0:
			short++
			shot(fmt.Sprintf("%d rows blank", blank), text)
		case !drawn(text, r.scr.Cols, r.scr.Rows):
			other++
			shot("not a screen the program drew", text)
		}
	}
	last := steps[len(steps)-1].cols
	final := norm(r.scr.Text())
	cp := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 100000})
	whole := strings.Join(lines, "\n")
	junk := 0
	var junkRows []string
	for _, l := range cp.Lines[:cp.History] {
		l := strings.Join(strings.Fields(l.Text), " ")
		if l != "" && !strings.Contains(whole, l) {
			junk++
			if len(junkRows) < 5 {
				junkRows = append(junkRows, l)
			}
		}
	}
	msg := fmt.Sprintf("%s: %d steps at 8 to 16 ms (%d to %d columns, a 300 ms pause, back), %d frames: %d with bars, %d short of rows, %d not a screen the program drew; %d scrollback rows, %d not of the transcript",
		mode, len(steps), wide, narrow, frames, barred, short, other, cp.History, junk)
	t.Log(msg)
	fmt.Println("MEASURE " + msg)
	if barred+short+other > 0 {
		t.Errorf("%d of %d frames during the drag were wrong; the first:\n%s", barred+short+other, frames, strings.Join(shots, "\n\n"))
	}
	if r.scr.Cols != last || !same(final, screen(last)) {
		t.Errorf("after the drag, at %dx%d, the screen is not the program's at %d columns:\n%s\nwant:\n%s", r.scr.Cols, r.scr.Rows, last, strings.Join(final, "\n"), strings.Join(screen(last), "\n"))
	}
	if junk > 0 {
		t.Errorf("%d scrollback rows are not of the transcript: %q", junk, junkRows)
	}
}
