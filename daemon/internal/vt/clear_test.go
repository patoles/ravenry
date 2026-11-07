package vt

import (
	"fmt"
	"testing"
)

func historyAndScreen(t *testing.T, s Screen) *Capture {
	t.Helper()
	c, err := s.Capture(CaptureOptions{History: 100000})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Cmd+K: the cursor's row moves to the top, everything above it and the
// whole history go, the cursor keeps its column.
func TestClearKeepsTheCursorRow(t *testing.T) {
	s, _ := newScreen(t, 40, 6)
	for i := 0; i < 50; i++ {
		fmt.Fprintf(writer{s}, "output %d\r\n", i)
	}
	s.Write([]byte("$ ls -l"))
	ok, err := s.Clear()
	if err != nil || !ok {
		t.Fatalf("clear = %v %v", ok, err)
	}
	c := historyAndScreen(t, s)
	if c.History != 0 {
		t.Fatalf("history after clear = %d rows, want 0", c.History)
	}
	want := []string{"$ ls -l", "", "", "", "", ""}
	for i, l := range c.Lines {
		if l.Text != want[i] {
			t.Fatalf("row %d = %q, want %q (all %+v)", i, l.Text, want[i], c.Lines)
		}
	}
	if c.Cursor.X != 7 || c.Cursor.Y != 0 {
		t.Fatalf("cursor = %+v, want 7,0", c.Cursor)
	}
	// Output goes on below the prompt as usual.
	s.Write([]byte("\r\ntotal 0\r\n$ "))
	lines, _ := s.Text()
	if lines[0] != "$ ls -l" || lines[1] != "total 0" || lines[2] != "$" {
		t.Fatalf("after more output: %q", lines)
	}
}

// With shell integration, a prompt of two rows stays whole.
func TestClearKeepsAMultiRowPrompt(t *testing.T) {
	s, _ := newScreen(t, 40, 8)
	for i := 0; i < 20; i++ {
		fmt.Fprintf(writer{s}, "output %d\r\n", i)
	}
	s.Write([]byte("\x1b]133;A\x07~/code main\r\n> \x1b]133;B\x07git st"))
	ok, err := s.Clear()
	if err != nil || !ok {
		t.Fatalf("clear = %v %v", ok, err)
	}
	c := historyAndScreen(t, s)
	if c.History != 0 || c.Lines[0].Text != "~/code main" || c.Lines[1].Text != "> git st" || c.Lines[2].Text != "" {
		t.Fatalf("after clear: history %d, rows %+v", c.History, c.Lines[:3])
	}
	if c.Cursor.X != 8 || c.Cursor.Y != 1 {
		t.Fatalf("cursor = %+v, want 8,1", c.Cursor)
	}
}

// A running command (not at a prompt) keeps only the cursor's row.
func TestClearWhileACommandRuns(t *testing.T) {
	s, _ := newScreen(t, 40, 6)
	s.Write([]byte("\x1b]133;A\x07$ \x1b]133;B\x07make\r\n\x1b]133;C\x07"))
	for i := 0; i < 10; i++ {
		fmt.Fprintf(writer{s}, "building %d\r\n", i)
	}
	s.Write([]byte("progress 50%"))
	if ok, err := s.Clear(); err != nil || !ok {
		t.Fatalf("clear = %v %v", ok, err)
	}
	c := historyAndScreen(t, s)
	if c.History != 0 || c.Lines[0].Text != "progress 50%" || c.Lines[1].Text != "" {
		t.Fatalf("after clear: history %d, rows %+v", c.History, c.Lines[:2])
	}
}

// On the alternate screen the full-screen program owns the screen: Clear
// changes nothing there.
func TestClearOnTheAltScreen(t *testing.T) {
	s, _ := newScreen(t, 20, 4)
	for i := 0; i < 10; i++ {
		fmt.Fprintf(writer{s}, "shell %d\r\n", i)
	}
	s.Write([]byte("\x1b[?1049h\x1b[Hvim"))
	before, _ := s.Snapshot()
	ok, err := s.Clear()
	if err != nil || ok {
		t.Fatalf("clear on the alt screen = %v %v, want false", ok, err)
	}
	after, _ := s.Snapshot()
	if string(before) != string(after) {
		t.Fatal("clear changed the alternate screen")
	}
}

// A snapshot after a clear rebuilds the cleared screen with no history.
func TestClearSnapshot(t *testing.T) {
	s, _ := newScreen(t, 30, 5)
	for i := 0; i < 40; i++ {
		fmt.Fprintf(writer{s}, "row %d\r\n", i)
	}
	s.Write([]byte("$ "))
	s.Clear()
	dst := roundTrip(t, s)
	c := historyAndScreen(t, dst)
	if c.History != 0 || c.Lines[0].Text != "$" {
		t.Fatalf("copy after clear: history %d, first %q", c.History, c.Lines[0].Text)
	}
}
