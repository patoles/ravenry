package vt

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// A pane keeps 10,000 lines of history whatever its width. libghostty also
// has a byte limit, 10,000 bytes by default, rounded up to one page of
// about 400 KB: that page, not the line limit, used to decide, so a pane
// kept 600 or so lines at 100 columns and fewer when wider.
func TestScrollbackKeepsTenThousandLines(t *testing.T) {
	for _, cols := range []int{80, 200} {
		t.Run(strconv.Itoa(cols), func(t *testing.T) {
			s, err := New(Options{Cols: cols, Rows: 24, Scrollback: 10000})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			var b bytes.Buffer
			for i := 1; i <= 12000; i++ {
				fmt.Fprintf(&b, "%d\r\n", i)
			}
			s.Write(b.Bytes())
			c, err := s.Capture(CaptureOptions{History: 20000})
			if err != nil {
				t.Fatal(err)
			}
			first := firstNumber(t, c.Lines)
			t.Logf("%d columns: %d history rows, first kept line %d", cols, c.History, first)
			if first > 2000 {
				t.Fatalf("%d columns: the first kept line is %d, want at most 2000 (%d history rows)", cols, first, c.History)
			}
		})
	}
}

// The alternate screen's snapshot rebuilds the primary screen from a copy
// of the terminal; the copy keeps the whole history too.
func TestScrollbackKeptInAltScreenSnapshot(t *testing.T) {
	s, err := New(Options{Cols: 100, Rows: 24, Scrollback: 10000})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var b bytes.Buffer
	for i := 1; i <= 12000; i++ {
		fmt.Fprintf(&b, "%d\r\n", i)
	}
	s.Write(b.Bytes())
	s.Write([]byte("\x1b[?1049hTUI"))
	snap, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	dst, err := New(Options{Cols: 100, Rows: 24, Scrollback: 10000})
	if err != nil {
		t.Fatal(err)
	}
	defer dst.Close()
	dst.Write(snap)
	dst.Write([]byte("\x1b[?1049l"))
	c, err := dst.Capture(CaptureOptions{History: 20000})
	if err != nil {
		t.Fatal(err)
	}
	if first := firstNumber(t, c.Lines); first > 2000 {
		t.Fatalf("after the alt screen snapshot, the first kept line is %d, want at most 2000", first)
	}
}

func firstNumber(t *testing.T, lines []Line) int {
	t.Helper()
	for _, l := range lines {
		if n, err := strconv.Atoi(strings.TrimSpace(l.Text)); err == nil {
			return n
		}
	}
	t.Fatal("no numbered line")
	return 0
}

// pageRows is an upper bound on the rows of one libghostty page: with a
// line limit of zero, libghostty keeps at most one page of history (its
// floor for the line limit), so the history never passes that bound.
func TestPageRowsBound(t *testing.T) {
	for _, cols := range []int{1, 10, 80, 200, 500} {
		s, err := New(Options{Cols: cols, Rows: 4, Scrollback: 1})
		if err != nil {
			t.Fatal(err)
		}
		g := s.(*ghostty)
		zero := uint(0)
		if err := g.t.SetScrollbackMaxLines(&zero); err != nil {
			t.Fatal(err)
		}
		most := uint(0)
		for i := 0; i < 3*pageRows(cols); i++ {
			s.Write([]byte("x\r\n"))
			if h, _ := g.t.ScrollbackRows(); h > most {
				most = h
			}
		}
		s.Close()
		if most == 0 || most > uint(pageRows(cols)) {
			t.Fatalf("%d columns: a page held %d rows, pageRows says at most %d", cols, most, pageRows(cols))
		}
		t.Logf("%d columns: a page holds %d rows, bound %d", cols, most, pageRows(cols))
	}
}

// After a resize the screen still keeps its lines at the new width.
func TestScrollbackKeptAfterResize(t *testing.T) {
	s, err := New(Options{Cols: 80, Rows: 24, Scrollback: 10000})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Resize(30, 24); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	for i := 1; i <= 12000; i++ {
		fmt.Fprintf(&b, "%d\r\n", i)
	}
	s.Write(b.Bytes())
	c, err := s.Capture(CaptureOptions{History: 20000})
	if err != nil {
		t.Fatal(err)
	}
	if first := firstNumber(t, c.Lines); first > 2000 {
		t.Fatalf("after a resize to 30 columns, the first kept line is %d, want at most 2000", first)
	}
}

// A pane's scrollback can change while it runs (pane.update): a larger
// limit keeps more of what comes next, a smaller one drops the oldest.
func TestScrollbackChangesWhileRunning(t *testing.T) {
	s, err := New(Options{Cols: 80, Rows: 24, Scrollback: 1000})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	write := func(from, to int) {
		var b bytes.Buffer
		for i := from; i <= to; i++ {
			fmt.Fprintf(&b, "%d\r\n", i)
		}
		s.Write(b.Bytes())
	}
	write(1, 3000)
	if err := s.SetScrollback(20000); err != nil {
		t.Fatal(err)
	}
	write(3001, 18000)
	c, err := s.Capture(CaptureOptions{History: 40000})
	if err != nil {
		t.Fatal(err)
	}
	if c.History < 15000 {
		t.Fatalf("after raising the limit to 20,000: %d history rows, want the 15,000 written since", c.History)
	}
	if err := s.SetScrollback(500); err != nil {
		t.Fatal(err)
	}
	write(18001, 18100)
	c, err = s.Capture(CaptureOptions{History: 40000})
	if err != nil {
		t.Fatal(err)
	}
	if c.History > 2000 {
		t.Fatalf("after lowering the limit to 500: %d history rows kept", c.History)
	}
}
