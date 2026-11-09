package vt

import (
	"strings"
	"testing"
)

// rendered reads the screen's rows through Render into a map of row to
// encoded data (the rows reported).
func rendered(t *testing.T, s Screen, all bool) (map[int][]byte, RenderInfo, bool) {
	t.Helper()
	rows := map[int][]byte{}
	info, held, err := s.Render(all, func(y int, wrap bool, data []byte) {
		rows[y] = append([]byte(nil), data...)
	})
	if err != nil {
		t.Fatal(err)
	}
	return rows, info, held
}

// rowText decodes an encoded row's text (the wire format of RENDERING.md),
// without depending on package rframe.
func rowText(data []byte) string {
	var b strings.Builder
	for len(data) >= 18 {
		n := int(data[16])<<8 | int(data[17])
		data = data[18:]
		for range n {
			c := data[0]
			data = data[1:]
			switch {
			case c == 0:
				b.WriteByte(' ')
			case c == 0xff:
			default:
				l := int(c & 0x7f)
				b.Write(data[:l])
				data = data[l:]
			}
		}
	}
	return strings.TrimRight(b.String(), " ")
}

func TestRenderDirtyRows(t *testing.T) {
	s, _ := newScreen(t, 20, 5)
	s.Write([]byte("one\r\ntwo\r\nthree"))
	rows, info, _ := rendered(t, s, true)
	if len(rows) != 5 || rowText(rows[0]) != "one" || rowText(rows[2]) != "three" {
		t.Fatalf("all rows: %d rows, %q %q", len(rows), rowText(rows[0]), rowText(rows[2]))
	}
	if info.Cursor.X != 5 || info.Cursor.Y != 2 || !info.Cursor.InView {
		t.Errorf("cursor %+v", info.Cursor)
	}
	s.Write([]byte("!"))
	rows, _, _ = rendered(t, s, false)
	if len(rows) != 1 || rowText(rows[2]) != "three!" {
		t.Errorf("after a change on row 2, rows %v", keys(rows))
	}
	rows, _, _ = rendered(t, s, false)
	if len(rows) != 0 {
		t.Errorf("nothing changed, rows %v", keys(rows))
	}
}

func keys(m map[int][]byte) []int {
	var k []int
	for y := range m {
		k = append(k, y)
	}
	return k
}

// A program's synchronized update is never seen half done: until it
// ends, Render reports the last frame the program finished.
func TestRenderSyncHold(t *testing.T) {
	s, _ := newScreen(t, 20, 5)
	s.Write([]byte("before"))
	rendered(t, s, true)
	s.Write([]byte("\x1b[?2026h\x1b[H\x1b[2Jhalf"))
	rows, _, held := rendered(t, s, false)
	if !held || len(rows) != 0 {
		t.Fatalf("during the update: held %v, rows %v", held, keys(rows))
	}
	// Text, as a person sees it, is the last finished frame too.
	if txt, _ := s.Text(); txt[0] != "before" {
		t.Errorf("text during the update: %q", txt[0])
	}
	s.Write([]byte(" done\x1b[?2026l"))
	rows, _, held = rendered(t, s, false)
	if held || rowText(rows[0]) != "half done" {
		t.Errorf("after the update: held %v, row 0 %q", held, rowText(rows[0]))
	}
}

func TestRenderStyleRuns(t *testing.T) {
	s, _ := newScreen(t, 20, 2)
	s.Write([]byte("a\x1b[1;4:3;38;2;1;2;3mbc\x1b[0m\x1b[44m  \x1b[0m"))
	rows, _, _ := rendered(t, s, true)
	d := rows[0]
	// Run 1: "a" in the default style; run 2: "bc" bold, curly
	// underline, RGB 1,2,3; run 3: two blank cells on palette blue.
	if d[16] != 0 || d[17] != 1 {
		t.Fatalf("run 1 count %d", int(d[16])<<8|int(d[17]))
	}
	r2 := d[18+2:]
	if r2[0] != 2 || r2[1] != 1 || r2[2] != 2 || r2[3] != 3 {
		t.Errorf("run 2 fg % x", r2[0:4])
	}
	attrs := uint16(r2[12])<<8 | uint16(r2[13])
	if attrs&attrBold == 0 || attrs>>8&7 != 3 {
		t.Errorf("run 2 attrs %b", attrs)
	}
	r3 := r2[18+2+2:]
	if r3[4] != 1 || r3[5] != 4 || int(r3[16])<<8|int(r3[17]) != 2 {
		t.Errorf("run 3 % x", r3[:18])
	}
}

// A resize at a shell prompt whose command line has several lines that
// wrap clears the whole prompt, from its first row, for the shell to
// draw again (daemon/patches/ghostty-prompt-clear-top.patch). Before the
// patch the clear started at the cursor's line and the rows above stayed,
// so the shell's redraw doubled them.
func TestResizeClearsWholePrompt(t *testing.T) {
	s, _ := newScreen(t, 30, 12)
	s.Write([]byte("output\r\n\x1b]133;A;redraw=1\x07~ > \x1b]133;B\x07"))
	s.Write([]byte("echo " + strings.Repeat("a", 40) + "\r\n" + strings.Repeat("b", 40) + "\r\n" + strings.Repeat("c", 10)))
	if !s.AtPrompt() {
		t.Fatal("the cursor is not at the prompt")
	}
	if err := s.Resize(20, 12); err != nil {
		t.Fatal(err)
	}
	txt, _ := s.Text()
	all := strings.Join(txt, "\n")
	if !strings.Contains(all, "output") {
		t.Errorf("the output above the prompt went:\n%s", all)
	}
	for _, w := range []string{"~ >", "aaa", "bbb", "ccc"} {
		if strings.Contains(all, w) {
			t.Errorf("%q is still on screen after the resize:\n%s", w, all)
		}
	}
}

// Key events from a client that draws (render.input) are encoded for the
// program's modes.
func TestEncodeKeyEvent(t *testing.T) {
	s, _ := newScreen(t, 20, 5)
	enc := func(k KeyEvent) string {
		t.Helper()
		b, err := s.EncodeKeyEvent(k)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	cases := []struct {
		k    KeyEvent
		want string
	}{
		{KeyEvent{Code: "KeyA", Text: "a", Unshifted: 'a'}, "a"},
		{KeyEvent{Code: "KeyA", Text: "A", Unshifted: 'a', Mods: ModShift, Consumed: ModShift}, "A"},
		{KeyEvent{Code: "KeyC", Unshifted: 'c', Mods: ModCtrl}, "\x03"},
		{KeyEvent{Code: "Enter"}, "\r"},
		{KeyEvent{Code: "Backspace"}, "\x7f"},
		{KeyEvent{Code: "ArrowUp"}, "\x1b[A"},
		{KeyEvent{Code: "KeyB", Text: "b", Unshifted: 'b', Mods: ModAlt, OptionAsAlt: "both"}, "\x1bb"},
		{KeyEvent{Code: "KeyE", Text: "é", Unshifted: 'e', Mods: ModAlt, Consumed: ModAlt}, "é"},
		{KeyEvent{Code: "KeyA", Action: "release", Unshifted: 'a'}, ""},
		{KeyEvent{Code: "Lang1", Text: "x"}, "x"},
	}
	for _, c := range cases {
		if got := enc(c.k); got != c.want {
			t.Errorf("%+v: %q, want %q", c.k, got, c.want)
		}
	}
	// Application cursor keys, then the Kitty keyboard protocol.
	s.Write([]byte("\x1b[?1h"))
	if got := enc(KeyEvent{Code: "ArrowUp"}); got != "\x1bOA" {
		t.Errorf("application cursor Up: %q", got)
	}
	s.Write([]byte("\x1b[>1u"))
	if got := enc(KeyEvent{Code: "KeyA", Unshifted: 'a', Mods: ModCtrl}); got != "\x1b[97;5u" {
		t.Errorf("Kitty Ctrl+A: %q", got)
	}
}
