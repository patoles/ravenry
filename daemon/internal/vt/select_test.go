package vt

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func newTestScreen(t *testing.T, cols, rows int) Screen {
	t.Helper()
	s, err := New(Options{Cols: cols, Rows: rows, Scrollback: 1000})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// press, drag and release at a cell, with cells 10 by 20 units.
func gesture(t *testing.T, s Screen, action string, x, y int, at time.Time, mods ...string) {
	t.Helper()
	e := SelectEvent{Action: action, X: x, Y: y, PX: float64(x)*10 + px(action), PY: float64(y)*20 + 5, CellWidth: 10, CellHeight: 20, Time: at}
	for _, m := range mods {
		switch m {
		case "shift":
			e.Extend = true
		case "option":
			e.Rect = true
		}
	}
	if err := s.Select(e); err != nil {
		t.Fatal(err)
	}
}

func selText(t *testing.T, s Screen) string {
	t.Helper()
	text, err := s.SelectionText()
	if err != nil {
		t.Fatal(err)
	}
	return text
}

// TestSelectGesture: a drag, two clicks a word, three a line, Shift
// extends, Option makes a block, and a selection that runs into the
// scrollback; soft-wrapped rows are joined in the copy.
func TestSelectGesture(t *testing.T) {
	s := newTestScreen(t, 20, 5)
	s.Write([]byte("hello world foo\r\nsecond line here\r\nthird"))
	t0 := time.Now()

	// A drag from "world" to "second".
	gesture(t, s, "press", 6, 0, t0)
	gesture(t, s, "drag", 7, 0, t0.Add(10*time.Millisecond))
	gesture(t, s, "drag", 5, 1, t0.Add(20*time.Millisecond))
	gesture(t, s, "release", 5, 1, t0.Add(30*time.Millisecond))
	if got := selText(t, s); got != "world foo\nsecond" {
		t.Errorf("drag: %q", got)
	}

	// Two clicks: the word.
	t1 := t0.Add(2 * time.Second)
	for i := range 2 {
		at := t1.Add(time.Duration(i) * 100 * time.Millisecond)
		gesture(t, s, "press", 8, 0, at)
		gesture(t, s, "release", 8, 0, at.Add(20*time.Millisecond))
	}
	if got := selText(t, s); got != "world" {
		t.Errorf("double click: %q", got)
	}
	// Three: the line.
	at := t1.Add(200 * time.Millisecond)
	gesture(t, s, "press", 8, 0, at)
	gesture(t, s, "release", 8, 0, at.Add(20*time.Millisecond))
	if got := selText(t, s); got != "hello world foo" {
		t.Errorf("triple click: %q", got)
	}

	// A click alone selects nothing.
	t2 := t1.Add(3 * time.Second)
	gesture(t, s, "press", 2, 1, t2)
	gesture(t, s, "release", 2, 1, t2.Add(20*time.Millisecond))
	if r, ok := s.Selection(); ok {
		t.Errorf("a click left a selection: %+v", r)
	}

	// Shift extends from the selection's start.
	t3 := t2.Add(3 * time.Second)
	gesture(t, s, "press", 0, 0, t3)
	gesture(t, s, "drag", 4, 0, t3.Add(10*time.Millisecond))
	gesture(t, s, "release", 4, 0, t3.Add(20*time.Millisecond))
	gesture(t, s, "press", 5, 1, t3.Add(time.Second), "shift")
	gesture(t, s, "release", 5, 1, t3.Add(time.Second+20*time.Millisecond), "shift")
	if got := selText(t, s); got != "hello world foo\nsecond" {
		t.Errorf("shift click: %q", got)
	}

	// Option: a block, columns 0 to 4 of rows 0 to 2.
	t4 := t3.Add(3 * time.Second)
	gesture(t, s, "press", 0, 0, t4, "option")
	gesture(t, s, "drag", 4, 2, t4.Add(10*time.Millisecond), "option")
	gesture(t, s, "release", 4, 2, t4.Add(20*time.Millisecond), "option")
	r, ok := s.Selection()
	if !ok || !r.Rect {
		t.Fatalf("option drag: %+v %v", r, ok)
	}
	if got := selText(t, s); got != "hello\nsecon\nthird" {
		t.Errorf("block: %q", got)
	}

	// Select all, then clear.
	if err := s.Select(SelectEvent{Action: "all"}); err != nil {
		t.Fatal(err)
	}
	if got := selText(t, s); !strings.HasPrefix(got, "hello world foo") || !strings.Contains(got, "third") {
		t.Errorf("select all: %q", got)
	}
	s.Select(SelectEvent{Action: "clear"})
	if _, ok := s.Selection(); ok {
		t.Error("clear left a selection")
	}

	// Into the scrollback: 30 lines on 5 rows; a drag from screen row 2
	// to the last row, and a soft-wrapped line joined.
	s2 := newTestScreen(t, 10, 5)
	for i := range 30 {
		fmt.Fprintf(sw{s2}, "line%d\r\n", i)
	}
	s2.Write([]byte("abcdefghijklmnop"))
	gesture(t, s2, "press", 0, 2, t0)
	gesture(t, s2, "drag", 9, 31, t0.Add(10*time.Millisecond))
	gesture(t, s2, "release", 9, 31, t0.Add(20*time.Millisecond))
	got := selText(t, s2)
	if !strings.HasPrefix(got, "line2\nline3\n") || !strings.HasSuffix(got, "line29\nabcdefghijklmnop") {
		t.Errorf("into the scrollback, wrapped joined: %q", got)
	}
	// The selection stays on its text while output comes.
	r1, _ := s2.Selection()
	s2.Write([]byte("\r\nmore\r\nmore\r\n"))
	r2, _ := s2.Selection()
	if r2.Y0 != r1.Y0 || !strings.HasPrefix(selText(t, s2), "line2\n") {
		t.Errorf("output moved the selection: %+v to %+v", r1, r2)
	}
}

// TestFind finds text in the screen and the scrollback, steps through the
// matches and reads those on a range of rows.
func TestFind(t *testing.T) {
	s := newTestScreen(t, 30, 5)
	for i := range 40 {
		if i%10 == 3 {
			fmt.Fprintf(sw{s}, "row %d has the Needle\r\n", i)
		} else {
			fmt.Fprintf(sw{s}, "row %d\r\n", i)
		}
	}
	f, err := s.NewFind()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	f.SetNeedle("needle", FindOptions{})
	if err := f.Update(); err != nil {
		t.Fatal(err)
	}
	count, index, _, _, err := f.Matches(0, 5)
	if err != nil || count != 4 || index != -1 {
		t.Fatalf("count %d index %d err %v", count, index, err)
	}
	// Next goes toward older output: rows 33, 23, 13, 3, then wraps.
	var rows []int
	for range 5 {
		m, ok, err := f.Step(1)
		if err != nil || !ok {
			t.Fatalf("step: %v %v", ok, err)
		}
		rows = append(rows, m.Y0)
	}
	if fmt.Sprint(rows) != "[33 23 13 3 33]" {
		t.Errorf("next: rows %v", rows)
	}
	m, _, _ := f.Step(-1)
	if m.Y0 != 3 {
		t.Errorf("previous: row %d", m.Y0)
	}
	_, index, sel, in, _ := f.Matches(10, 10)
	if index != 3 || sel == nil || sel.Y0 != 3 || len(in) != 1 || in[0].Y0 != 13 || in[0].X0 != 15 || in[0].X1 != 20 {
		t.Errorf("index %d selected %+v in rows 10 to 19 %+v", index, sel, in)
	}
	// New output is searched too.
	s.Write([]byte("needle again\r\n"))
	f.Update()
	if count, _, _, _, _ := f.Matches(0, 1); count != 5 {
		t.Errorf("after output: %d matches", count)
	}
	f.SetNeedle("", FindOptions{})
	if count, _, _, _, _ := f.Matches(0, 50); count != 0 {
		t.Errorf("cleared: %d matches", count)
	}
}

// TestLinkAt finds hyperlinks and URLs written in the text, across a
// soft wrap, without the punctuation after them.
func TestLinkAt(t *testing.T) {
	s := newTestScreen(t, 20, 5)
	s.Write([]byte("see https://example.com/a/very/long/path, ok\r\n"))
	s.Write([]byte("\x1b]8;;https://ravenry.dev/x\x1b\\click\x1b]8;;\x1b\\ here\r\n"))
	s.Write([]byte("(file:///tmp/a b)"))
	l, ok := s.LinkAt(5, 1) // row 1 is the wrapped rest of the URL
	if !ok || l.URI != "https://example.com/a/very/long/path" || l.Span.X0 != 4 || l.Span.Y0 != 0 || l.Span.Y1 != 1 || l.Span.X1 != 19 {
		t.Errorf("URL: %+v %v", l, ok)
	}
	if _, ok := s.LinkAt(1, 0); ok {
		t.Error("a link on \"see\"")
	}
	// Row 3: the hyperlink "click".
	l, ok = s.LinkAt(2, 3)
	if !ok || l.URI != "https://ravenry.dev/x" || l.Span.X0 != 0 || l.Span.X1 != 4 || l.Span.Y0 != 3 {
		t.Errorf("hyperlink: %+v %v", l, ok)
	}
	if _, ok := s.LinkAt(7, 3); ok {
		t.Error("a link on \"here\"")
	}
	l, ok = s.LinkAt(3, 4)
	if !ok || l.URI != "file:///tmp/a" {
		t.Errorf("file URL in brackets: %+v %v", l, ok)
	}
}

// TestAltScrollMode: mode 1007 is on unless the program turns it off.
func TestAltScrollMode(t *testing.T) {
	s := newTestScreen(t, 20, 5)
	_, info, _ := rendered(t, s, true)
	if info.Modes&ModeAltScroll == 0 {
		t.Error("mode 1007 off by default")
	}
	s.Write([]byte("\x1b[?1007l"))
	_, info, _ = rendered(t, s, true)
	if info.Modes&ModeAltScroll != 0 {
		t.Error("mode 1007 still on")
	}
}

type sw struct{ s Screen }

func (w sw) Write(p []byte) (int, error) { w.s.Write(p); return len(p), nil }

// px is where in its cell the pointer is: a press on the cell's left
// half, a drag past its middle, so the cell is in the selection.
func px(action string) float64 {
	if action == "press" {
		return 3
	}
	return 7
}

// TestCaptureLinks: a capture with Links gives each row's hyperlinks (OSC
// 8) with their text, start and width, over a soft wrap too; plain URLs
// in the text are not hyperlinks, and without Links no row has any.
func TestCaptureLinks(t *testing.T) {
	s := newTestScreen(t, 20, 5)
	s.Write([]byte("see https://x.io ok\r\n"))
	s.Write([]byte("a \x1b]8;;https://ravenry.dev/x\x1b\\click\x1b]8;;\x1b\\ and \x1b]8;;file:///tmp/a.txt\x1b\\a.txt\x1b]8;;\x1b\\\r\n"))
	s.Write([]byte("0123456789012345\x1b]8;;https://ravenry.dev/long\x1b\\wrapped\x1b]8;;\x1b\\"))
	c, err := s.Capture(CaptureOptions{Links: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Lines[0].Links) != 0 {
		t.Errorf("a plain URL taken for a hyperlink: %+v", c.Lines[0].Links)
	}
	got := c.Lines[1].Links
	if len(got) != 2 || got[0] != (LineLink{Col: 2, Width: 5, Text: "click", URI: "https://ravenry.dev/x"}) || got[1] != (LineLink{Col: 12, Width: 5, Text: "a.txt", URI: "file:///tmp/a.txt"}) {
		t.Errorf("row 1: %+v", got)
	}
	if a, b := c.Lines[2].Links, c.Lines[3].Links; len(a) != 1 || a[0].Text != "wrap" || a[0].Col != 16 || len(b) != 1 || b[0].Text != "ped" || b[0].URI != "https://ravenry.dev/long" || !c.Lines[2].Wrapped {
		t.Errorf("wrapped: %+v %+v", a, b)
	}
	plain, err := s.Capture(CaptureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for i, l := range plain.Lines {
		if l.Links != nil {
			t.Errorf("row %d has links without Links: %+v", i, l.Links)
		}
	}
}
