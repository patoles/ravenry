package vt

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func newScreen(t *testing.T, cols, rows int) (Screen, *[]byte) {
	t.Helper()
	var replies []byte
	s, err := New(Options{Cols: cols, Rows: rows, Scrollback: 1000, Reply: func(p []byte) { replies = append(replies, p...) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, &replies
}

func TestTextAndCursor(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	s.Write([]byte("hello\r\nworld"))
	lines, err := s.Text()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"hello", "world", "", ""}; !reflect.DeepEqual(lines, want) {
		t.Fatalf("text = %q, want %q", lines, want)
	}
	c, err := s.Capture(CaptureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if c.Cursor != (Cursor{X: 5, Y: 1, Visible: true}) {
		t.Fatalf("cursor = %+v", c.Cursor)
	}
	s.Write([]byte("\x1b[?25l"))
	c, _ = s.Capture(CaptureOptions{})
	if c.Cursor.Visible {
		t.Fatal("cursor still visible after DECTCEM off")
	}
}

func TestScrollbackHistory(t *testing.T) {
	s, _ := newScreen(t, 20, 3)
	for i := 0; i < 10; i++ {
		fmt.Fprintf(writer{s}, "line %d\r\n", i)
	}
	lines, _ := s.Text()
	if want := []string{"line 8", "line 9", ""}; !reflect.DeepEqual(lines, want) {
		t.Fatalf("visible = %q, want %q", lines, want)
	}
	c, _ := s.Capture(CaptureOptions{History: 2})
	if c.History != 2 || c.Lines[0].Text != "line 6" || c.Lines[2].Text != "line 8" {
		t.Fatalf("history capture = %d %+v", c.History, c.Lines)
	}
	c, _ = s.Capture(CaptureOptions{History: 100})
	if c.History != 8 || c.Lines[0].Text != "line 0" {
		t.Fatalf("all history = %d first %q", c.History, c.Lines[0].Text)
	}
}

type writer struct{ s Screen }

func (w writer) Write(p []byte) (int, error) { w.s.Write(p); return len(p), nil }

func TestStyles(t *testing.T) {
	s, _ := newScreen(t, 40, 3)
	s.Write([]byte("a \x1b[2mdim\x1b[0m \x1b[1;31mbold red\x1b[0m \x1b[38;2;1;2;3;48;5;200mrgb\x1b[0m \x1b[3;4;7;9mx\x1b[0m"))
	c, err := s.Capture(CaptureOptions{Styles: true})
	if err != nil {
		t.Fatal(err)
	}
	got := c.Lines[0].Spans
	want := []Span{
		{Col: 2, Width: 3, Text: "dim", Style: Style{Dim: true}},
		{Col: 6, Width: 8, Text: "bold red", Style: Style{Bold: true, Fg: Color{Kind: ColorPalette, Index: 1}}},
		{Col: 15, Width: 3, Text: "rgb", Style: Style{Fg: Color{Kind: ColorRGB, R: 1, G: 2, B: 3}, Bg: Color{Kind: ColorPalette, Index: 200}}},
		{Col: 19, Width: 1, Text: "x", Style: Style{Italic: true, Underline: true, Inverse: true, Strike: true}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("spans:\n got %+v\nwant %+v", got, want)
	}
	if c.Lines[0].Text != "a dim bold red rgb x" {
		t.Fatalf("text = %q", c.Lines[0].Text)
	}
}

func TestWideCharacters(t *testing.T) {
	s, _ := newScreen(t, 20, 2)
	s.Write([]byte("\x1b[1m日本\x1b[0mok"))
	c, _ := s.Capture(CaptureOptions{Styles: true})
	if c.Lines[0].Text != "日本ok" {
		t.Fatalf("text = %q", c.Lines[0].Text)
	}
	sp := c.Lines[0].Spans
	if len(sp) != 1 || sp[0].Text != "日本" || sp[0].Width != 4 || sp[0].Col != 0 {
		t.Fatalf("spans = %+v", sp)
	}
	if c.Cursor.X != 6 {
		t.Fatalf("cursor x = %d", c.Cursor.X)
	}
}

func TestQueryReplies(t *testing.T) {
	s, replies := newScreen(t, 20, 5)
	s.Write([]byte("ab\x1b[6n"))
	if string(*replies) != "\x1b[1;3R" {
		t.Fatalf("cursor position report = %q", *replies)
	}
	*replies = nil
	s.Write([]byte("\x1b[c"))
	if !strings.HasPrefix(string(*replies), "\x1b[?") {
		t.Fatalf("device attributes reply = %q", *replies)
	}
}

func TestTitle(t *testing.T) {
	s, _ := newScreen(t, 20, 5)
	s.Write([]byte("\x1b]2;my title\x07"))
	if s.Title() != "my title" {
		t.Fatalf("title = %q", s.Title())
	}
}

// roundTrip writes a snapshot into a fresh screen and checks that it reads
// back the same: text, styles, cursor, scrollback, alt screen.
func roundTrip(t *testing.T, src Screen) Screen {
	t.Helper()
	cols, rows := src.Size()
	snap, err := src.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(snap), "\x1bc") {
		t.Fatalf("snapshot does not start with a reset: %q", snap[:min(len(snap), 10)])
	}
	dst, _ := newScreen(t, cols, rows)
	dst.Write(snap)
	a, _ := src.Capture(CaptureOptions{Styles: true, History: 1000})
	b, _ := dst.Capture(CaptureOptions{Styles: true, History: 1000})
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("round trip differs:\nsrc %+v\ndst %+v", a, b)
	}
	return dst
}

func TestSnapshotRoundTrip(t *testing.T) {
	s, _ := newScreen(t, 30, 5)
	for i := 0; i < 12; i++ {
		fmt.Fprintf(writer{s}, "row %d \x1b[1;32mgreen\x1b[0m \x1b[2mdim\x1b[0m\r\n", i)
	}
	s.Write([]byte("$ \x1b[4mtyped\x1b[0m"))
	roundTrip(t, s)
}

func TestSnapshotEmptyRowsBelowCursor(t *testing.T) {
	s, _ := newScreen(t, 20, 6)
	s.Write([]byte("one\r\ntwo\r\n"))
	roundTrip(t, s)
}

func TestSnapshotAltScreen(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	for i := 0; i < 6; i++ {
		fmt.Fprintf(writer{s}, "shell %d\r\n", i)
	}
	s.Write([]byte("\x1b[?1049h\x1b[H\x1b[7m TUI \x1b[0m\x1b[3;5Hhere"))
	if !s.AltScreen() {
		t.Fatal("not on the alternate screen")
	}
	dst := roundTrip(t, s)
	if !dst.AltScreen() {
		t.Fatal("the copy is not on the alternate screen")
	}
	// Leaving the alternate screen brings back the shell's rows.
	s.Write([]byte("\x1b[?1049l"))
	dst.Write([]byte("\x1b[?1049l"))
	a, _ := s.Text()
	b, _ := dst.Text()
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("after leaving alt: src %q dst %q", a, b)
	}
	if a[0] != "shell 3" {
		t.Fatalf("primary screen not restored: %q", a)
	}
}

func TestSnapshotModes(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	s.Write([]byte("\x1b[?2004h\x1b[?1h"))
	dst := roundTrip(t, s)
	up, _ := ParseKey("Up")
	b, _ := dst.EncodeKey(up)
	if string(b) != "\x1bOA" {
		t.Fatalf("application cursor mode lost: Up = %q", b)
	}
	p, _ := dst.EncodePaste([]byte("x"))
	if string(p) != "\x1b[200~x\x1b[201~" {
		t.Fatalf("bracketed paste mode lost: %q", p)
	}
}

func TestEncodeKeys(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	cases := map[string]string{
		"Enter": "\r", "Tab": "\t", "Escape": "\x1b", "Backspace": "\x7f",
		"Up": "\x1b[A", "Down": "\x1b[B", "Right": "\x1b[C", "Left": "\x1b[D",
		"Ctrl+C": "\x03", "C-c": "\x03", "ctrl+d": "\x04", "Shift+Tab": "\x1b[Z",
		"Alt+x": "\x1bx", "M-x": "\x1bx", "Space": " ", "a": "a", "A": "A",
		"F1": "\x1bOP", "Home": "\x1b[H", "Delete": "\x1b[3~", "PageUp": "\x1b[5~",
		"é": "é", "?": "?", "Ctrl+Space": "\x00", "esc": "\x1b",
	}
	for name, want := range cases {
		k, err := ParseKey(name)
		if err != nil {
			t.Errorf("ParseKey(%q): %v", name, err)
			continue
		}
		b, err := s.EncodeKey(k)
		if err != nil {
			t.Errorf("EncodeKey(%q): %v", name, err)
			continue
		}
		if string(b) != want {
			t.Errorf("%s = %q, want %q", name, b, want)
		}
	}
	s.Write([]byte("\x1b[?1h"))
	k, _ := ParseKey("Up")
	if b, _ := s.EncodeKey(k); string(b) != "\x1bOA" {
		t.Errorf("Up in application cursor mode = %q", b)
	}
	for _, bad := range []string{"", "Ctrl+", "nope", "ab"} {
		if _, err := ParseKey(bad); err == nil {
			t.Errorf("ParseKey(%q) accepted", bad)
		}
	}
}

func TestPaste(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	p, _ := s.EncodePaste([]byte("ls\n"))
	if strings.Contains(string(p), "\x1b[200~") {
		t.Fatalf("bracketed without mode 2004: %q", p)
	}
	s.Write([]byte("\x1b[?2004h"))
	p, _ = s.EncodePaste([]byte("echo hi\n"))
	if !strings.HasPrefix(string(p), "\x1b[200~") || !strings.HasSuffix(string(p), "\x1b[201~") {
		t.Fatalf("not bracketed: %q", p)
	}
}

func TestResize(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	s.Write([]byte("abc"))
	if err := s.Resize(30, 6); err != nil {
		t.Fatal(err)
	}
	if c, r := s.Size(); c != 30 || r != 6 {
		t.Fatalf("size %dx%d", c, r)
	}
	lines, _ := s.Text()
	if len(lines) != 6 || lines[0] != "abc" {
		t.Fatalf("after resize %q", lines)
	}
}

func BenchmarkWrite(b *testing.B) {
	s, err := New(Options{Cols: 165, Rows: 49, Scrollback: 10000})
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	chunk := []byte(strings.Repeat("hello world \x1b[32mgreen\x1b[0m 0123456789 abcdefghijklmnopqrstuvwxyz\r\n", 200))
	b.SetBytes(int64(len(chunk)))
	for i := 0; i < b.N; i++ {
		s.Write(chunk)
	}
}
