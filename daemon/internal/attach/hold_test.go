package attach

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuf struct {
	mu     sync.Mutex
	b      bytes.Buffer
	writes int
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// During a resize the window gets nothing of the program's redraw, which
// comes in pieces; once the pane has the size and the output is quiet, it
// gets the whole redraw in one write, as one synchronized update.
func TestHoldKeepsTheRedrawWhole(t *testing.T) {
	w := &syncBuf{}
	h := &Hold{W: w, Quiet: 30 * time.Millisecond, Max: time.Second}
	h.Write([]byte("before"))
	h.Resize()
	h.Resize() // the window changes again before the pane answers
	h.Settled()
	h.Write([]byte("\x1b[18A\x1b[J~ > "))
	time.Sleep(10 * time.Millisecond)
	h.Write([]byte("the command line"))
	if got := w.String(); got != "before" {
		t.Fatalf("the window got part of the redraw: %q", got)
	}
	time.Sleep(80 * time.Millisecond)
	want := "before" + SyncStart + "\x1b[18A\x1b[J~ > the command line" + SyncEnd
	if got := w.String(); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if w.writes != 2 || h.Holds != 1 {
		t.Fatalf("writes %d, holds %d", w.writes, h.Holds)
	}
	h.Write([]byte("after"))
	if !strings.HasSuffix(w.String(), SyncEnd+"after") {
		t.Fatalf("output after the hold: %q", w.String())
	}
}

// Until the pane has the window's size, the output stays kept, up to Max.
func TestHoldWaitsForThePaneThenMax(t *testing.T) {
	w := &syncBuf{}
	h := &Hold{W: w, Quiet: 10 * time.Millisecond, Max: 100 * time.Millisecond}
	h.Resize()
	h.Write([]byte("x"))
	time.Sleep(50 * time.Millisecond)
	if w.String() != "" {
		t.Fatal("let go before the pane had the size")
	}
	time.Sleep(100 * time.Millisecond)
	if w.String() != SyncStart+"x"+SyncEnd {
		t.Fatalf("held past Max: %q", w.String())
	}
}

// A hold that kept Limit bytes lets them go at once.
func TestHoldLimit(t *testing.T) {
	w := &syncBuf{}
	h := &Hold{W: w, Quiet: time.Second, Max: time.Second, Limit: 4}
	h.Resize()
	h.Write([]byte("ab"))
	h.Write([]byte("cd"))
	if w.String() != SyncStart+"abcd"+SyncEnd {
		t.Fatalf("%q", w.String())
	}
}

// Output with no resize goes straight through, unwrapped.
func TestHoldPassesOutput(t *testing.T) {
	w := &syncBuf{}
	h := &Hold{W: w, Quiet: 10 * time.Millisecond, Max: 100 * time.Millisecond}
	h.Write([]byte("abc"))
	if w.String() != "abc" {
		t.Fatalf("%q", w.String())
	}
}

// A hold that kept nothing still ends synchronized output: the window's
// terminal may have turned it on itself when the resize cleared a prompt.
func TestHoldEndsSyncWhenEmpty(t *testing.T) {
	w := &syncBuf{}
	h := &Hold{W: w, Quiet: 10 * time.Millisecond, Max: 100 * time.Millisecond}
	h.Resize()
	h.Settled()
	time.Sleep(50 * time.Millisecond)
	if w.String() != SyncEnd {
		t.Fatalf("%q", w.String())
	}
}
