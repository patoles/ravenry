package vt

import (
	"fmt"
	"strings"
	"testing"
)

// viewRows reads every row of the render stream at the view's size.
func viewRows(t *testing.T, s Screen, rows int) ([]string, RenderInfo, bool) {
	t.Helper()
	out := make([]string, rows)
	info, held, err := s.Render(true, func(y int, _ bool, d []byte) {
		if y < rows {
			out[y] = rowText(d)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	return out, info, held
}

// TestRenderView: a view narrower and shorter than the grid shows its
// rows cut and its last rows, the cursor moved up with them; a wider and
// taller one pads them; the grid itself is not touched.
func TestRenderView(t *testing.T) {
	s, _ := newScreen(t, 40, 10)
	for y := range 10 {
		fmt.Fprintf(writer{s}, "\x1b[%d;1Hrow %d %s", y+1, y, strings.Repeat("x", 30))
	}
	fmt.Fprintf(writer{s}, "\x1b[9;5H")
	s.SetView(20, 6)
	got, info, _ := viewRows(t, s, 6)
	if info.Cols != 20 || info.Rows != 6 {
		t.Fatalf("info %dx%d, want 20x6", info.Cols, info.Rows)
	}
	if got[0] != "row 4 "+strings.Repeat("x", 14) || got[5] != "row 9 "+strings.Repeat("x", 14) {
		t.Fatalf("narrower and shorter: %q", got)
	}
	if info.Cursor.Y != 4 || info.Cursor.X != 4 || !info.Cursor.InView {
		t.Errorf("cursor %+v, want row 4 column 4 in view", info.Cursor)
	}
	if c, r := s.Size(); c != 40 || r != 10 {
		t.Errorf("the grid is %dx%d, want 40x10", c, r)
	}
	s.SetView(60, 14)
	got, info, _ = viewRows(t, s, 14)
	if info.Cols != 60 || got[0] != "row 0 "+strings.Repeat("x", 30) || got[9] != "row 9 "+strings.Repeat("x", 30) || got[13] != "" {
		t.Fatalf("wider and taller: %q", got)
	}
	s.SetView(0, 0)
	if _, info, _ = viewRows(t, s, 10); info.Cols != 40 || info.Rows != 10 {
		t.Errorf("back to the grid: %dx%d", info.Cols, info.Rows)
	}
}

// TestRenderFreeze: a frozen screen is read as it was when frozen,
// across a resize and output, until thawed.
func TestRenderFreeze(t *testing.T) {
	s, _ := newScreen(t, 40, 10)
	for y := range 10 {
		fmt.Fprintf(writer{s}, "\x1b[%d;1Hrow %d %s", y+1, y, strings.Repeat("x", 30))
	}
	viewRows(t, s, 10)
	s.Freeze()
	if err := s.Resize(20, 10); err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("\x1b[H\x1b[2Jnew"))
	got, _, held := viewRows(t, s, 10)
	if !held || got[0] != "row 0 "+strings.Repeat("x", 14) || got[9] != "row 9 "+strings.Repeat("x", 14) {
		t.Fatalf("frozen: held %v %q", held, got)
	}
	// A program's synchronized update while frozen does not take the
	// frame either.
	s.Write([]byte("\x1b[?2026h\x1b[2;1Hmore\x1b[?2026l"))
	if got, _, _ = viewRows(t, s, 10); got[1] != "row 1 "+strings.Repeat("x", 14) {
		t.Fatalf("frozen through an update: %q", got)
	}
	s.Thaw()
	got, _, held = viewRows(t, s, 10)
	if held || got[0] != "new" || got[1] != "more" || got[9] != "" {
		t.Fatalf("thawed: held %v %q", held, got)
	}
}
