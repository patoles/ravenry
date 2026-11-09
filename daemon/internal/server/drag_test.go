package server

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ravenryd/internal/client"
	"ravenryd/internal/pane"
	"ravenryd/internal/proto"
	"ravenryd/internal/testenv"
)

// TestRenderDragZsh drags a pane's size the way a person drags a
// window's edge, over a long multi-line command line at a zsh prompt,
// with a client that draws the render stream at 120 Hz. At each display
// tick it looks at the client's screen: a blank frame (the command line
// gone) or debris (a piece of an old prompt) fails. After each drag the
// pane settles wide, and its whole text, scrollback and screen, must be
// the prompt and the command line once each, with nothing else: no
// ">...." row (zsh's mark that the command line is taller than the
// screen) and no slice of a redraw at a narrower width. The client's
// last screen must be the daemon's.
//
// The drags: one column a display tick down to RAVENRY_DRAG_MIN columns
// (default 38, a 300 pt window in the Mac app) and back; then a fast
// one, a step every 2 ms (500 a second) jumping up to 50 columns (about
// 400 pt) and the height too, as narrow as 20 columns and 12 rows; then
// wide and taller. RAVENRY_DRAG_ROWS sets the height (default 40);
// RAVENRY_DRAG_ROUNDS runs the drags that many times (default 1);
// RAVENRY_DRAG_ONLY=smooth or fast runs one of them; RAVENRY_DRAG_KEEP
// names a folder for the pane's recording (log and timeline) when the
// test fails, to replay it.
func TestRenderDragZsh(t *testing.T) {
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("no zsh")
	}
	if testing.Short() {
		t.Skip("short")
	}
	shells := filepath.Join(t.TempDir(), "shell")
	testenv.CheckDirs(t, shells)
	d := startDaemon(t, func(o *pane.ManagerOptions) {
		o.ShellDir = shells
		o.Env = append(o.Env, "SHELL="+zsh)
	})
	rc := "skip_global_compinit=1\n"
	os.WriteFile(filepath.Join(d.home, ".zshenv"), []byte(rc), 0o600)
	os.WriteFile(filepath.Join(d.home, ".zshrc"), []byte("PROMPT='~ > '\n"+os.Getenv("RAVENRY_DRAG_ZSHRC")+"\n"), 0o600)
	c := d.dial(client.Options{})
	wide, rows, narrow, rounds := 150, 40, 38, 1
	if v := os.Getenv("RAVENRY_DRAG_MIN"); v != "" {
		fmt.Sscan(v, &narrow)
	}
	if v := os.Getenv("RAVENRY_DRAG_ROWS"); v != "" {
		fmt.Sscan(v, &rows)
	}
	if v := os.Getenv("RAVENRY_DRAG_ROUNDS"); v != "" {
		fmt.Sscan(v, &rounds)
	}
	p := newPane(t, c, map[string]any{"cols": wide, "rows": rows, "cwd": d.home})
	st, err := c.Render(ctx(t), p.ID, client.RenderOptions{FPS: 120})
	if err != nil {
		t.Fatal(err)
	}
	r := &renderClient{t: t, st: st}
	r.until("~ >")
	time.Sleep(300 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}
	promptScreen := strings.Join(r.scr.Text(), "\n")
	words := "the quick brown fox jumps over the lazy dog and keeps running past the river while the wind blows"
	var lines []string
	for i := range 10 {
		lines = append(lines, fmt.Sprintf("line %d: %s", i, strings.Repeat(words+" ", i%3+1)))
	}
	pasted := strings.Join(lines, "\n")
	if err := st.Events(ctx(t), []proto.RenderEvent{{Paste: &pasted}}); err != nil {
		t.Fatal(err)
	}
	r.until("line 9")
	time.Sleep(800 * time.Millisecond)
	for r.next(50*time.Millisecond) != nil {
	}
	flat := func(s string) string { return strings.Join(strings.Fields(s), "") }
	ink := func() int { return len(flat(strings.Join(r.scr.Text(), ""))) }
	whole := flat(promptScreen + pasted)
	fp := flat(promptScreen)
	debris := func(text string) bool {
		f := flat(text)
		switch {
		case strings.HasPrefix(f, fp+">...."):
			f = f[len(fp)+5:]
		case strings.HasPrefix(f, ">...."):
			f = f[5:]
		}
		return !strings.Contains(whole, f)
	}
	base := ink()
	if debris(strings.Join(r.scr.Text(), "\n")) {
		t.Fatalf("debris before the drag:\n%s", strings.Join(r.scr.Text(), "\n"))
	}

	// The pane's whole text, scrollback and screen, row by row, each row
	// read against the prompt and command line in order: a row that is
	// not their next piece is debris. A blank row above the last row of
	// text (in the scrollback or between rows) is a cleared prompt row
	// left behind, counted apart.
	type textCheck struct {
		debris, blank int
		whole, top    bool
		history       int
		rows          []string
		bad           []string
	}
	checkText := func() textCheck {
		cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 100000})
		var ck textCheck
		ck.history = cap.History
		pos, seen := 0, false
		run := 0
		for i, l := range cap.Lines {
			text := strings.TrimRight(l.Text, " ")
			ck.rows = append(ck.rows, text)
			f := flat(text)
			if f == "" {
				run++
				continue
			}
			if !seen {
				ck.top = strings.HasPrefix(f, "~>")
			}
			seen = true
			ck.blank += run
			run = 0
			if strings.HasPrefix(whole[pos:], f) {
				pos += len(f)
				continue
			}
			ck.debris++
			if len(ck.bad) < 8 {
				ck.bad = append(ck.bad, fmt.Sprintf("row %d of %d (history %d): %q", i, len(cap.Lines), cap.History, text))
			}
		}
		ck.whole = pos == len(whole)
		return ck
	}
	if ck := checkText(); ck.debris > 0 || !ck.whole {
		t.Fatalf("the text before the drag is not the prompt and command line: %+v", ck)
	}

	type size struct{ cols, rows int }
	type drag struct {
		name  string
		sizes []size
		step  time.Duration
	}
	smooth := drag{name: "smooth", step: time.Second / 120}
	for w := wide; w > narrow; w-- {
		smooth.sizes = append(smooth.sizes, size{w, rows})
	}
	for w := narrow; w <= wide; w++ {
		smooth.sizes = append(smooth.sizes, size{w, rows})
	}
	// The fast drag: a step every 2 ms, each a jump of up to 50 columns
	// and 12 rows, sweeping between narrow and wide, with runs of one
	// column a step in between; then wide and taller.
	fast := drag{name: "fast", step: 2 * time.Millisecond}
	rng := rand.New(rand.NewSource(7))
	cw, ch := wide, rows
	for i := range 400 {
		if i/40%2 == 0 {
			cw -= rng.Intn(50) + 1
		} else {
			cw += rng.Intn(50) + 1
		}
		if (i/40)%4 == 3 {
			cw += 1 - 2*(i%2)
		}
		ch += rng.Intn(25) - 12
		cw = max(20, min(wide+10, cw))
		ch = max(12, min(rows+20, ch))
		fast.sizes = append(fast.sizes, size{cw, ch})
	}
	for w := 20; w <= wide; w += 2 {
		fast.sizes = append(fast.sizes, size{w, 12})
	}
	fast.sizes = append(fast.sizes, size{wide, rows}, size{wide, rows + 20})

	tick := time.Second / 120
	// After a drag: narrowed and made short one step a display tick, so
	// the command line is taller than the screen and zsh shows only its
	// end under ">....", the start must be in the scrollback once: the
	// pane's rows read in order are the prompt and the command line,
	// ">...." only as the screen's first row, and the render stream
	// scrolled to the top shows the prompt's first row. Made wide again,
	// the text is as before the drag.
	narrowScroll := func(name string) {
		t.Helper()
		short := 12
		var steps []size
		for w, h := wide, rows; w > narrow || h > short; {
			w, h = max(narrow, w-1), max(short, h-1)
			steps = append(steps, size{w, h})
		}
		blank, bad := 0, 0
		for _, sz := range steps {
			c.Call(ctx(t), "pane.resize", map[string]any{"pane": p.ID, "cols": sz.cols, "rows": sz.rows}, nil)
			r.next(tick)
			text := strings.Join(r.scr.Text(), "\n")
			if ink() < min(base, r.scr.Cols*(r.scr.Rows-1))*3/10 {
				blank++
			}
			if debris(text) {
				bad++
			}
		}
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			r.next(50 * time.Millisecond)
		}
		cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID, "history": 100000})
		var all, screen []string
		for i, l := range cap.Lines {
			all = append(all, strings.TrimRight(l.Text, " "))
			if i >= cap.History {
				screen = append(screen, strings.TrimRight(l.Text, " "))
			}
		}
		once := oneCopy(all, cap.History, "~ > ", pasted)
		equal := strings.Join(screen, "\n") == strings.Join(r.scr.Text(), "\n")
		// Scrolled to the top, the client sees the prompt's first row.
		st.Scroll(ctx(t), cap.History)
		for i := 0; i < 50 && r.scr.Offset != cap.History; i++ {
			r.next(100 * time.Millisecond)
		}
		topRow := ""
		if len(r.scr.Text()) > 0 {
			topRow = r.scr.Text()[0]
		}
		st.Scroll(ctx(t), 0)
		for i := 0; i < 50 && r.scr.Offset != 0; i++ {
			r.next(100 * time.Millisecond)
		}
		// Wide again.
		c.Call(ctx(t), "pane.resize", map[string]any{"pane": p.ID, "cols": wide, "rows": rows}, nil)
		deadline = time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			r.next(50 * time.Millisecond)
		}
		ck := checkText()
		msg := fmt.Sprintf("zsh %s drag then narrowed to %dx%d in %d steps: blank %d, debris on screen %d; the start in the scrollback once: %v (history %d), scrolled to the top the first row is the prompt's: %v, client ends on the daemon's screen: %v; wide again: debris rows %d, blank rows %d, whole command line %v",
			name, narrow, short, len(steps), blank, bad, once == nil, cap.History, strings.HasPrefix(topRow, "~ > line 0"), equal, ck.debris, ck.blank, ck.whole)
		t.Log(msg)
		fmt.Println("MEASURE " + msg)
		if blank > 0 || bad > 0 {
			t.Errorf("%s narrowed: %d blank frames, %d with debris", name, blank, bad)
		}
		if once != nil {
			t.Errorf("%s narrowed: %v\n%s", name, once, strings.Join(all, "\n"))
		}
		if !strings.HasPrefix(topRow, "~ > line 0") {
			t.Errorf("%s narrowed: scrolled to the top, the first row is %q", name, topRow)
		}
		if !equal {
			t.Errorf("%s narrowed: the client's screen is not the daemon's", name)
		}
		if ck.debris > 0 || ck.blank > 0 || !ck.top || !ck.whole {
			t.Errorf("%s narrowed then wide: %d debris rows, %d blank rows, top row the prompt %v, whole %v:\n%s", name, ck.debris, ck.blank, ck.top, ck.whole, strings.Join(ck.rows, "\n"))
		}
	}
	failed := false
	for round := range rounds {
		for _, dr := range []drag{smooth, fast} {
			if only := os.Getenv("RAVENRY_DRAG_ONLY"); only != "" && only != dr.name {
				continue
			}
			blank, bad, ticks := 0, 0, 0
			var badShots []string
			var frameGaps []time.Duration
			lastFrame := time.Now()
			framesBefore := r.frames
			sample := func() {
				ticks++
				text := strings.Join(r.scr.Text(), "\n")
				if ink() < min(base, r.scr.Cols*(r.scr.Rows-1))*3/10 {
					blank++
					if len(badShots) < 2 {
						badShots = append(badShots, fmt.Sprintf("blank at %dx%d:\n%s", r.scr.Cols, r.scr.Rows, text))
					}
				}
				if debris(text) {
					bad++
					if len(badShots) < 2 {
						badShots = append(badShots, fmt.Sprintf("at %dx%d:\n%s", r.scr.Cols, r.scr.Rows, text))
					}
				}
			}
			// One sender, so the sizes reach the daemon in order, as a
			// window's do, without the drag waiting for each reply.
			sizes := make(chan size, len(dr.sizes))
			sent := make(chan struct{})
			go func() {
				defer close(sent)
				for sz := range sizes {
					c.Call(ctx(t), "pane.resize", map[string]any{"pane": p.ID, "cols": sz.cols, "rows": sz.rows}, nil)
				}
			}()
			start := time.Now()
			next := start
			nextTick := start.Add(tick)
			for _, sz := range dr.sizes {
				sizes <- sz
				next = next.Add(dr.step)
				for time.Now().Before(next) {
					until := next
					if nextTick.Before(until) {
						until = nextTick
					}
					if f := r.next(time.Until(until)); f != nil {
						frameGaps = append(frameGaps, time.Since(lastFrame))
						lastFrame = time.Now()
					}
					if !time.Now().Before(nextTick) {
						sample()
						nextTick = nextTick.Add(tick)
					}
				}
			}
			dragTime := time.Since(start)
			close(sizes)
			<-sent
			// Settle, then the client's screen must be the daemon's.
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				r.next(50 * time.Millisecond)
				sample()
			}
			cap := call[proto.CaptureResult](t, c, "pane.capture", map[string]any{"pane": p.ID})
			var daemonText []string
			for _, l := range cap.Lines {
				daemonText = append(daemonText, strings.TrimRight(l.Text, " "))
			}
			equal := strings.Join(daemonText, "\n") == strings.Join(r.scr.Text(), "\n")
			ck := checkText()
			sort.Slice(frameGaps, func(i, j int) bool { return frameGaps[i] < frameGaps[j] })
			p95 := time.Duration(0)
			if len(frameGaps) > 0 {
				p95 = frameGaps[len(frameGaps)*95/100]
			}
			last := dr.sizes[len(dr.sizes)-1]
			msg := fmt.Sprintf("zsh %s drag, round %d, %d steps in %v (%.0f a second) ending %dx%d: %d display ticks, %d frames (gap p95 %v), blank %d, debris on screen %d; after: debris rows %d, blank rows %d (history %d rows), top row the prompt: %v, whole command line: %v, client ends on the daemon's screen: %v",
				dr.name, round+1, len(dr.sizes), dragTime.Round(time.Millisecond), float64(len(dr.sizes))/dragTime.Seconds(), last.cols, last.rows,
				ticks, r.frames-framesBefore, p95.Round(100*time.Microsecond), blank, bad, ck.debris, ck.blank, ck.history, ck.top, ck.whole, equal)
			t.Log(msg)
			fmt.Println("MEASURE " + msg)
			for _, s := range badShots {
				t.Log("on screen " + s)
			}
			for _, s := range ck.bad {
				t.Log("debris " + s)
			}
			if os.Getenv("RAVENRY_DRAG_DUMP") != "" {
				t.Logf("text after:\n%s", strings.Join(ck.rows, "\n"))
			}
			if blank > 0 {
				t.Errorf("%s: %d blank frames", dr.name, blank)
			}
			if bad > 0 {
				t.Errorf("%s: %d frames with debris", dr.name, bad)
			}
			if ck.debris > 0 || ck.blank > 0 || !ck.top || !ck.whole {
				t.Errorf("%s: the text after the drag has %d debris rows and %d blank rows, top row the prompt %v, whole command line %v", dr.name, ck.debris, ck.blank, ck.top, ck.whole)
			}
			if !equal {
				t.Errorf("%s: the client's screen is not the daemon's:\nclient:\n%s\ndaemon:\n%s", dr.name, strings.Join(r.scr.Text(), "\n"), strings.Join(daemonText, "\n"))
			}
			if k := os.Getenv("RAVENRY_DRAG_KEEP"); k != "" && t.Failed() {
				for _, ext := range []string{".log", ".log.time"} {
					b, _ := os.ReadFile(filepath.Join(d.dir, p.ID+ext))
					os.WriteFile(filepath.Join(k, "pane"+ext), b, 0o600)
				}
			}
			narrowScroll(dr.name)
			failed = failed || t.Failed()
			if failed {
				return
			}
		}
	}
}
