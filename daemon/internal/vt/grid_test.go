package vt

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGridDefaults(t *testing.T) {
	s, _ := newScreen(t, 10, 3)
	g, err := s.Grid()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("default fg %v bg %v", g.Fg, g.Bg)
	if g.Fg == g.Bg {
		t.Fatalf("default colours are the same: %v", g.Fg)
	}
	if g.Cols != 10 || g.Rows != 3 || len(g.Cells) != 3 || len(g.Cells[0]) != 10 {
		t.Fatalf("grid is %dx%d with %d rows", g.Cols, g.Rows, len(g.Cells))
	}
	if !g.Cursor.Visible || g.Cursor.X != 0 || g.Cursor.Y != 0 || g.CursorStyle != "block" {
		t.Fatalf("cursor = %+v %s", g.Cursor, g.CursorStyle)
	}
	// A program's own colours win (OSC 10 and 11).
	s.Write([]byte("\x1b]10;rgb:ff/00/00\x1b\\\x1b]11;rgb:00/00/ff\x1b\\"))
	g, _ = s.Grid()
	if g.Fg != (RGB{255, 0, 0}) || g.Bg != (RGB{0, 0, 255}) {
		t.Fatalf("after OSC 10/11: fg %v bg %v", g.Fg, g.Bg)
	}
}

func TestGridCells(t *testing.T) {
	s, _ := newScreen(t, 12, 4)
	s.Write([]byte("\x1b[1;31mR\x1b[0m\x1b[48;2;1;2;3mB\x1b[0m\x1b[2mf\x1b[0m\x1b[7mi\x1b[0m\x1b[8mh\x1b[0m\x1b[4;9mu\x1b[0m\r\n"))
	s.Write([]byte("界x\r\n┌─┐\r\n\x1b[3 q"))
	g, err := s.Grid()
	if err != nil {
		t.Fatal(err)
	}
	r := g.Cells[0]
	if r[0].Text != "R" || !r[0].Bold || !r[0].HasFg || r[0].HasBg {
		t.Fatalf("bold red = %+v", r[0])
	}
	if r[1].Text != "B" || !r[1].HasBg || r[1].Bg != (RGB{1, 2, 3}) {
		t.Fatalf("rgb background = %+v", r[1])
	}
	if !r[2].Faint || !r[3].Inverse || !r[4].Invisible || !r[5].Underline || !r[5].Strike {
		t.Fatalf("attributes = %+v", r[2:6])
	}
	if r[6].Text != "" || r[6].HasFg {
		t.Fatalf("empty cell = %+v", r[6])
	}
	w := g.Cells[1]
	if w[0].Text != "界" || !w[0].Wide || !w[1].Spacer || w[1].Text != "" || w[2].Text != "x" {
		t.Fatalf("wide row = %+v", w[:3])
	}
	b := g.Cells[2]
	if b[0].Text+b[1].Text+b[2].Text != "┌─┐" {
		t.Fatalf("box row = %+v", b[:3])
	}
	if g.Cursor.Y != 3 || g.CursorStyle != "underline" {
		t.Fatalf("cursor = %+v %s", g.Cursor, g.CursorStyle)
	}
	// A palette colour is resolved: red is not the default foreground.
	if r[0].Fg == g.Fg {
		t.Fatalf("palette red resolved to the default %v", r[0].Fg)
	}
}

// TestGridCost prints what one Grid read costs at two sizes, a full screen
// of styled text. The daemon reads one up to ten times a second per pane
// that prints.
func TestGridCost(t *testing.T) {
	for _, sz := range [][2]int{{80, 24}, {200, 60}} {
		s, _ := newScreen(t, sz[0], sz[1])
		var b strings.Builder
		for y := 0; y < sz[1]; y++ {
			for x := 0; x < sz[0]; x++ {
				fmt.Fprintf(&b, "\x1b[38;5;%dm%c", (x+y)%256, 'a'+rune((x*7+y)%26))
			}
		}
		s.Write([]byte(b.String()))
		const n = 50
		start := time.Now()
		for i := 0; i < n; i++ {
			if _, err := s.Grid(); err != nil {
				t.Fatal(err)
			}
		}
		fmt.Printf("MEASURE vt.Grid %dx%d, every cell its own colour: %v per read\n", sz[0], sz[1], time.Since(start)/n)
		s.Write([]byte("\x1b[0m\x1b[H\x1b[2J"))
		for y := 0; y < sz[1]; y++ {
			s.Write([]byte(fmt.Sprintf("\x1b[%dH\x1b[32m$\x1b[0m %s", y+1, strings.Repeat("plain text ", sz[0]/12))))
		}
		start = time.Now()
		for i := 0; i < n; i++ {
			if _, err := s.Grid(); err != nil {
				t.Fatal(err)
			}
		}
		fmt.Printf("MEASURE vt.Grid %dx%d, a screen of text: %v per read\n", sz[0], sz[1], time.Since(start)/n)
	}
}

func BenchmarkGrid200x60(b *testing.B) {
	s, err := New(Options{Cols: 200, Rows: 60, Scrollback: 100})
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	s.Write([]byte(strings.Repeat("\x1b[31mhello \x1b[0mworld ", 1000)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Grid()
	}
}

// TestGridSlowPath checks that the packed read and the call-per-field read
// give the same grid.
func TestGridSlowPath(t *testing.T) {
	s, _ := newScreen(t, 16, 5)
	s.Write([]byte("\x1b[1;31mR\x1b[0m\x1b[48;5;22mB \x1b[0m\x1b[2;3mfi\x1b[0m\x1b[7mi\x1b[8mh\x1b[0m\r\n"))
	s.Write([]byte("界e\u0301x\x1b[38;2;10;20;30m👍\x1b[0m\r\n┌─┐\x1b[44m\x1b[K\x1b[0m\r\n\x1b]4;1;rgb:12/34/56\x1b\\\x1b[31mo\x1b[0m"))
	fast, err := s.Grid()
	if err != nil {
		t.Fatal(err)
	}
	slowGrid = true
	defer func() { slowGrid = false }()
	slow, err := s.Grid()
	if err != nil {
		t.Fatal(err)
	}
	for y := range fast.Cells {
		for x := range fast.Cells[y] {
			if !reflect.DeepEqual(fast.Cells[y][x], slow.Cells[y][x]) {
				t.Errorf("cell %d,%d: packed %+v, per field %+v", x, y, fast.Cells[y][x], slow.Cells[y][x])
			}
		}
	}
	if got := fast.Cells[1][2].Text; got != "e\u0301" {
		t.Errorf("cluster = %q", got)
	}
	if got := fast.Cells[3][0].Fg; got != (RGB{0x12, 0x34, 0x56}) {
		t.Errorf("OSC 4 palette red = %v", got)
	}
}
