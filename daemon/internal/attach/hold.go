package attach

import (
	"io"
	"sync"
	"time"
)

// Hold keeps a window from drawing a program's redraw half done while the
// window is resized.
//
// When the window changes size, the program in the pane redraws for the
// new size, and most programs do not mark a redraw as one update. zsh, for
// one, moves up to its prompt, clears everything below it (ESC [ J), then
// writes its command line again in pieces of about 1 KiB. Through the
// daemon these pieces arrive up to milliseconds apart, Ghostty reads its
// pty 1 KiB at a time, and it draws at once on each change of the window's
// size, about every 8 ms in a drag. A frame drawn between the clear and
// the rest shows the command line gone. Synchronized output (mode 2026)
// alone cannot stop that: a terminal turns the mode off on each resize.
//
// So while the window is being resized, Hold keeps the pane's output back
// instead of writing it: the window's terminal never holds a half-done
// redraw, and whatever it draws on a size change is a whole screen. Once
// the pane has the window's size (Settled) and its output has been quiet
// for Quiet, Hold writes what it kept in one write, wrapped in synchronized
// output so the terminal draws it once, whole. Max bounds a hold after the
// last change of size (a program that never goes quiet), and Limit the
// bytes kept.
//
// Every hold ends with the end of synchronized output, even one that kept
// nothing. The Mac app's Ghostty turns synchronized output on itself when
// a resize clears the shell's prompt for the shell to redraw
// (apps/macos/patches/ghostty-hold-prompt-redraw.patch), so it never draws
// the cleared prompt; the end of the hold is what lets it draw again.
type Hold struct {
	// W is the window's terminal; every write to it goes through Hold.
	W     io.Writer
	Quiet time.Duration
	Max   time.Duration
	Limit int

	mu      sync.Mutex
	on      bool
	since   time.Time // the last change of size
	last    time.Time // the last output kept, or the last change of size
	settled bool      // the pane has the window's size
	kept    []byte
	timer   *time.Timer
	// OnSwitch, when set, hears each hold start (true) and end (false),
	// with the bytes it kept (for traces).
	OnSwitch func(on bool, kept int)
	Holds    int // how many holds there were (for tests and traces)
}

// SyncStart and SyncEnd begin and end synchronized output (mode 2026): the
// terminal draws what comes between them once, whole.
const (
	SyncStart = "\x1b[?2026h"
	SyncEnd   = "\x1b[?2026l"
)

// Write writes output from the pane to the window, or keeps it during a
// hold.
func (h *Hold) Write(b []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.on {
		return h.W.Write(b)
	}
	h.kept = append(h.kept, b...)
	h.last = time.Now()
	if h.Limit > 0 && len(h.kept) >= h.Limit {
		if err := h.release(); err != nil {
			return 0, err
		}
	}
	return len(b), nil
}

// Resize says the window's size changed: output is kept until the pane
// has the new size (Settled) and its redraw is in.
func (h *Hold) Resize() {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := time.Now()
	if !h.on {
		h.on = true
		h.Holds++
		if h.OnSwitch != nil {
			h.OnSwitch(true, 0)
		}
	}
	h.since = t
	h.last = t
	h.settled = false
	h.arm(h.Quiet)
}

// Settled says the pane has the window's current size (the daemon answered
// the pane.resize for it, or will never).
func (h *Hold) Settled() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.settled = true
	h.last = time.Now()
	h.arm(h.Quiet)
}

// arm schedules the next look at whether the hold can end. h.mu is held.
func (h *Hold) arm(d time.Duration) {
	if !h.on {
		return
	}
	if h.timer == nil {
		h.timer = time.AfterFunc(d, h.check)
	} else {
		h.timer.Reset(d)
	}
}

func (h *Hold) check() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.on {
		return
	}
	t := time.Now()
	if (h.settled && t.Sub(h.last) >= h.Quiet) || t.Sub(h.since) >= h.Max {
		h.release()
		return
	}
	wait := h.Quiet - t.Sub(h.last)
	if wait <= 0 {
		wait = h.Quiet
	}
	if rest := h.Max - t.Sub(h.since); rest < wait {
		wait = rest
	}
	h.arm(wait)
}

// release ends the hold, writing what it kept as one update. h.mu is held.
func (h *Hold) release() error {
	h.on = false
	kept := h.kept
	h.kept = nil
	if h.OnSwitch != nil {
		h.OnSwitch(false, len(kept))
	}
	if len(kept) == 0 {
		_, err := h.W.Write([]byte(SyncEnd))
		return err
	}
	buf := make([]byte, 0, len(SyncStart)+len(kept)+len(SyncEnd))
	buf = append(append(append(buf, SyncStart...), kept...), SyncEnd...)
	_, err := h.W.Write(buf)
	return err
}
