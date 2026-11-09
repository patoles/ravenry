package vt

import (
	"fmt"
	"strings"
	"testing"
)

// A shell that redraws its prompt on a resize (OSC 133 redraw=1) moves
// up the rows it drew the prompt on, at the old width, and draws again
// from there. After each resize and redraw the whole text, scrollback and
// screen, must be the output above and the prompt once, with no blank row
// between them and nothing of an old prompt anywhere
// (daemon/patches/ghostty-prompt-clear-top.patch: the prompt is cleared
// before the reflow and the cursor put where the shell's move up lands
// on its first row). Upstream, a narrower width left blank rows above
// the redraw, then pushed them into the scrollback, and a wider one drew
// the prompt over the output above it.
func TestResizeRedrawLandsOnPrompt(t *testing.T) {
	s, _ := newScreen(t, 80, 24)
	var out []string
	for i := range 8 {
		out = append(out, fmt.Sprintf("output %d %s", i, strings.Repeat("x", 30+i*9)))
	}
	cmd := []string{"echo " + strings.Repeat("a", 70), strings.Repeat("b", 45), "cc"}
	s.Write([]byte(strings.Join(out, "\r\n") + "\r\n"))
	abs := func() int {
		c, err := s.Capture(CaptureOptions{History: 100000})
		if err != nil {
			t.Fatal(err)
		}
		return c.History + c.Cursor.Y
	}
	// draw writes the prompt and command line from the cursor's row and
	// returns the rows from its first row to the cursor's, as a shell
	// counts them.
	draw := func() int {
		top := abs()
		s.Write([]byte("\r\x1b]133;A;redraw=1\x07~ > \x1b]133;B\x07\x1b[J" + strings.Join(cmd, "\r\n")))
		return abs() - top
	}
	up := draw()
	want := strings.Join(strings.Fields(strings.Join(out, " ")+" ~ > "+strings.Join(cmd, " ")), "")
	for _, sz := range [][2]int{{60, 24}, {40, 24}, {33, 24}, {50, 24}, {80, 24}, {120, 24}, {120, 12}, {45, 12}, {45, 30}, {90, 30}, {28, 10}, {100, 40}} {
		if err := s.Resize(sz[0], sz[1]); err != nil {
			t.Fatal(err)
		}
		if up > 0 {
			s.Write([]byte(fmt.Sprintf("\x1b[%dA", up)))
		}
		up = draw()
		c, err := s.Capture(CaptureOptions{History: 100000})
		if err != nil {
			t.Fatal(err)
		}
		var got strings.Builder
		blank, seen, gap := 0, false, 0
		for _, l := range c.Lines {
			f := strings.Join(strings.Fields(l.Text), "")
			if f == "" {
				if seen {
					gap++
				}
				continue
			}
			seen = true
			blank += gap
			gap = 0
			got.WriteString(f)
		}
		var rows []string
		for _, l := range c.Lines {
			rows = append(rows, l.Text)
		}
		if got.String() != want || blank > 0 {
			t.Fatalf("at %dx%d: %d blank rows between, text:\n%s", sz[0], sz[1], blank, strings.Join(rows, "\n"))
		}
	}
}
