package vt

import (
	"fmt"
	"strings"
	"testing"
)

// claudeRedraw is what Claude Code writes after a SIGWINCH, as recorded
// from a long session (2026-11-11): it starts a synchronized update (mode
// 2026), erases every row from the top (ESC[2K ESC[1B), draws the rows
// again top to bottom over several reads, and ends the update. The
// screen is lines laid out at cols, the last rows of them. It returns
// the writes, the first being the erase.
func claudeRedraw(lines []string, cols, rows, parts int) [][]byte {
	var laid []string
	for _, l := range lines {
		for len(l) > cols {
			laid = append(laid, l[:cols])
			l = l[cols:]
		}
		laid = append(laid, l)
	}
	laid = laid[max(0, len(laid)-rows):]
	out := [][]byte{[]byte("\x1b[?2026h\x1b[H" + strings.Repeat("\x1b[2K\x1b[1B", rows))}
	per := (len(laid) + parts - 1) / parts
	for i := 0; i < len(laid); i += per {
		var b strings.Builder
		for y := i; y < min(i+per, len(laid)); y++ {
			fmt.Fprintf(&b, "\x1b[%d;1H%s", y+1, laid[y])
		}
		out = append(out, []byte(b.String()))
	}
	out[len(out)-1] = append(out[len(out)-1], "\x1b[?2026l"...)
	return out
}

// busyLines is a long transcript: lines of every length, none empty.
func busyLines(n int) []string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("%04d %s", i, strings.Repeat("lorem ipsum dolor ", 1+i%9))
	}
	return lines
}

// renderView reads frames the way the pane's render stream does
// (pane.renderUpdate): every row again at a new size, the changed rows
// otherwise.
type renderView struct {
	t          *testing.T
	s          Screen
	cols, rows int
	data       [][]byte
}

func (v *renderView) frame() (filled int, info RenderInfo, held bool) {
	v.t.Helper()
	cols, rows := v.s.Size()
	all := cols != v.cols || rows != v.rows
	if all {
		v.cols, v.rows, v.data = cols, rows, make([][]byte, rows)
	}
	info, held, err := v.s.Render(all, func(y int, _ bool, d []byte) {
		if y < len(v.data) {
			v.data[y] = append([]byte(nil), d...)
		}
	})
	if err != nil {
		v.t.Fatal(err)
	}
	for _, d := range v.data {
		if rowText(d) != "" {
			filled++
		}
	}
	return filled, info, held
}

// A drag over a program in the middle of its redraw never shows the
// erased screen, nor a redraw half done: libghostty ends synchronized
// output on a resize, and Claude Code's redraw after a SIGWINCH erases
// every row first, so frames during a drag were blank or showed a few
// rows (140 of 234 frames of a recorded drag, 830 of 1740 of four). Each
// frame now has every row of the last frame the program finished, as
// many as the screen has.
func TestRenderHoldAcrossResize(t *testing.T) {
	lines := busyLines(400)
	for _, tc := range []struct {
		name  string
		sizes [][2]int
	}{
		{"width", func() (z [][2]int) {
			for i := range 60 {
				z = append(z, [2]int{100 - i, 30}) // narrower,
			}
			for i := range 80 {
				z = append(z, [2]int{40 + i, 30}) // then wider
			}
			return
		}()},
		{"height", func() (z [][2]int) {
			for i := range 12 {
				z = append(z, [2]int{100 - i, 30 - i}) // shorter,
			}
			for i := range 24 {
				z = append(z, [2]int{88 + i, 18 + i}) // then taller
			}
			return
		}()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newScreen(t, 100, 30)
			for _, b := range claudeRedraw(lines, 100, 30, 1) {
				s.Write(b)
			}
			v := &renderView{t: t, s: s}
			if n, _, held := v.frame(); n != 30 || held {
				t.Fatalf("first frame: %d rows filled, held %v", n, held)
			}
			// The program redraws at the size it saw at its SIGWINCH, in
			// four writes, one between each step of the drag, and again
			// at the size the drag reached. A frame while it redraws has
			// every row of the frame shown before it began, as many as
			// fit.
			last := 30 // rows filled of the last frame shown while it was idle
			var pending [][]byte
			frames, short := 0, 0
			check := func(what string) {
				n, _, _ := v.frame()
				if len(pending) == 0 {
					// Idle: this is the frame it finished, laid out for
					// the size it saw (stale after a drag step, which is
					// not what this test is about).
					last = n
					return
				}
				frames++
				if want := min(last, v.rows); n < want {
					short++
					if short <= 3 {
						t.Errorf("%s at %dx%d during a redraw: %d rows filled, want %d (the last finished frame)", what, v.cols, v.rows, n, want)
					}
				}
			}
			for _, sz := range tc.sizes {
				if err := s.Resize(sz[0], sz[1]); err != nil {
					t.Fatal(err)
				}
				check("resize")
				if len(pending) == 0 {
					cols, rows := s.Size()
					pending = claudeRedraw(lines, cols, rows, 4)
				}
				s.Write(pending[0])
				pending = pending[1:]
				check("output")
			}
			for len(pending) > 0 {
				s.Write(pending[0])
				pending = pending[1:]
				check("output")
			}
			if short > 0 {
				t.Errorf("%d of %d frames during a redraw had fewer rows than the last finished frame", short, frames)
			}
			// The last redraw is shown whole, at the drag's last size.
			cols, rows := s.Size()
			for _, b := range claudeRedraw(lines, cols, rows, 3) {
				s.Write(b)
			}
			if n, _, held := v.frame(); n != rows || held {
				t.Errorf("after the drag: %d of %d rows filled, held %v", n, rows, held)
			}
		})
	}
}

// A hold carried across a resize is still the program's: its frame is
// the one taken when the update began (shown from the bottom when the
// screen got shorter, as Text shows it), and it still ends renderHoldMax
// after it began for a program that never ends it.
func TestRenderHoldResizeBounded(t *testing.T) {
	s, _ := newScreen(t, 40, 10)
	for y := range 10 {
		fmt.Fprintf(writer{s}, "\x1b[%d;1Hrow %d", y+1, y)
	}
	g := s.(*ghostty)
	v := &renderView{t: t, s: s}
	v.frame()
	s.Write([]byte("\x1b[?2026h\x1b[H" + strings.Repeat("\x1b[2K\x1b[1B", 10) + "\x1b[1;1Hhalf"))
	held, at := g.Held()
	if !held {
		t.Fatal("the update did not hold the screen")
	}
	if err := s.Resize(30, 6); err != nil {
		t.Fatal(err)
	}
	if h, a := g.Held(); !h || !a.Equal(at) {
		t.Fatalf("after the resize: held %v since %v, want since %v", h, a, at)
	}
	n, info, h := v.frame()
	if !h || n != 6 {
		t.Fatalf("held frame at 30x6: held %v, %d rows filled", h, n)
	}
	if got := rowText(v.data[0]); got != "row 4" {
		t.Errorf("held frame at 30x6: row 0 %q, want %q (the bottom rows)", got, "row 4")
	}
	if info.Cursor.Y != 5 || !info.Cursor.InView {
		t.Errorf("held frame at 30x6: cursor %+v, want on row 5", info.Cursor)
	}
	if txt, _ := s.Text(); txt[0] != "row 4" || txt[5] != "row 9" {
		t.Errorf("text during the hold: %q", txt)
	}
	// The program never ends its update: the hold ends a second after
	// it began, not after the resize.
	g.heldAt = at.Add(-renderHoldMax)
	n, _, h = v.frame()
	if h || n != 1 || rowText(v.data[0]) != "half" {
		t.Errorf("after renderHoldMax: held %v, %d rows filled, row 0 %q", h, n, rowText(v.data[0]))
	}
	// A resize with no update going on holds nothing.
	if err := s.Resize(40, 10); err != nil {
		t.Fatal(err)
	}
	if h, _ := g.Held(); h {
		t.Error("a resize after the hold ended started one")
	}
}
