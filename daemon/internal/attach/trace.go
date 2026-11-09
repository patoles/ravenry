package attach

import (
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
)

// Trace records what an attach relays, one line per event, for finding
// out what a window was sent (RAVENRY_ATTACH_TRACE=<file>):
//
//	<ms of the wall clock, modulo 100000 s> out|snap|in <mark> <len> <bytes, Go-quoted>
//	<ms> resize <cols>x<rows>
//	<ms> hold on | hold off <bytes kept>
//
// A nil Trace records nothing.
type Trace struct {
	mu sync.Mutex
	f  *os.File
}

// OpenTrace opens path for a trace; an empty path, or one that cannot be
// opened, gives a nil Trace.
func OpenTrace(path string) *Trace {
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	return &Trace{f: f}
}

func (t *Trace) line(s string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	fmt.Fprintf(t.f, "%.1f %s\n", float64(time.Now().UnixMicro()%100000000)/1000, s)
	t.mu.Unlock()
}

// Frame records a frame written to the terminal.
func (t *Trace) Frame(snapshot bool, mark uint64, b []byte) {
	if t == nil {
		return
	}
	kind := "out"
	if snapshot {
		kind = "snap"
	}
	t.line(kind + " " + strconv.FormatUint(mark, 10) + " " + strconv.Itoa(len(b)) + " " + strconv.Quote(string(b)))
}

// Input records what the terminal wrote, before the filter.
func (t *Trace) Input(b []byte) {
	if t == nil {
		return
	}
	t.line("in 0 " + strconv.Itoa(len(b)) + " " + strconv.Quote(string(b)))
}

// Resize records a size sent to the pane.
func (t *Trace) Resize(cols, rows int) {
	t.line("resize " + strconv.Itoa(cols) + "x" + strconv.Itoa(rows))
}

// Hold records a resize hold starting, or ending with the bytes it kept.
func (t *Trace) Hold(on bool, kept int) {
	if on {
		t.line("hold on")
	} else {
		t.line("hold off " + strconv.Itoa(kept))
	}
}

// Close closes the trace file.
func (t *Trace) Close() {
	if t != nil {
		t.f.Close()
	}
}
