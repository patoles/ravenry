package pane

import (
	"bytes"
	"time"
)

// A program's resizes (docs/RENDERING.md, Resize). A program that is not
// a shell at its prompt is told its new size (TIOCSWINSZ, a SIGWINCH)
// once per pause of a drag, not at each step, and the grid is resized
// with it, as Ghostty does (it sets the pty's size and the grid's
// together, "so its redraw cannot be parsed against the old terminal
// dimensions") and as kitty does (it waits for the resizes to stop).
//
// Claude Code redraws once for every size it is told, in order, 100 to
// 250 ms after it, placing its words at absolute columns (ESC[<col>G). A
// redraw laid out for a width the drag had already left landed on a
// narrower grid: every column past the margin went to the last one, a
// column of single letters at the right edge and the rest of the screen
// mostly empty (the maintainer on 0.1.31: "still blanks, and vertical bars of
// characters too now"; 17 of 180 frames of a recorded drag). Resizing
// the grid at each step without telling the program breaks it another
// way: its cursor moves, relative to rows that the reflow moved, land on
// the wrong rows and leave garbage in the scrollback.
//
// So during a drag the grid and the program's size stay as they are, and
// the frames go out at the size asked, the screen cut or padded to it
// (vt SetView). When the drag pauses, and at its end, both are resized
// once, to the latest size asked; the next size goes only once the
// program has drawn itself at that one. A resize on its own (a split, a
// font change, a window snapped) goes at once.

const (
	// dragPause: no step for this long and the drag has paused or ended.
	// Steps come every 8 to 17 ms; the recorded drags had gaps of up
	// to 55 ms within a movement.
	dragPause = 80 * time.Millisecond
	// redrawQuiet: a program that has written nothing for this long
	// since the resize, or since its last output, has drawn itself.
	redrawQuiet = 300 * time.Millisecond
	// redrawMax: the longest the next size waits for a redraw.
	redrawMax = time.Second
)

// redrawWatch follows a program's redraw after its grid was resized: it
// is done when the program ends a synchronized update (2026) that began
// after the resize and erased at least half the screen's rows (Claude
// Code's redraw erases every row; its spinner's updates erase none), or
// when its output has been quiet for redrawQuiet, or after redrawMax.
type redrawWatch struct {
	at      time.Time // when the grid was resized; zero: none to watch
	done    bool
	inBlock bool // in a synchronized update begun after the resize
	erased  int  // rows that update erased
	frozen  bool // the screen is frozen until the redraw (vt Freeze)
	tail    []byte
}

var (
	syncBegin = []byte("\x1b[?2026h")
	syncEnd   = []byte("\x1b[?2026l")
	eraseLine = [][]byte{[]byte("\x1b[2K"), []byte("\x1b[K"), []byte("\x1b[0K"), []byte("\x1b[1K")}
	eraseAll  = [][]byte{[]byte("\x1b[2J"), []byte("\x1b[J"), []byte("\x1b[0J")}
)

// scan reads a chunk of the program's output and reports whether it
// ended the redraw. rows is the screen's height.
func (w *redrawWatch) scan(b []byte, rows int) bool {
	buf := b
	if len(w.tail) > 0 {
		buf = append(w.tail, b...)
		w.tail = nil
	}
	for i := 0; i < len(buf); {
		j := bytes.IndexByte(buf[i:], 0x1b)
		if j < 0 {
			break
		}
		i += j
		rest := buf[i:]
		if len(rest) < len(syncBegin) && partial(rest) {
			w.tail = append([]byte(nil), rest...)
			break
		}
		switch {
		case bytes.HasPrefix(rest, syncBegin):
			w.inBlock, w.erased = true, 0
		case bytes.HasPrefix(rest, syncEnd):
			if w.inBlock && w.erased*2 >= rows {
				w.done = true
				return true
			}
			w.inBlock = false
		case hasAny(rest, eraseLine):
			w.erased++
		case hasAny(rest, eraseAll):
			w.erased += rows
		}
		i++
	}
	return false
}

// partial says whether b, the end of a chunk, may be the start of a
// sequence scan looks for.
func partial(b []byte) bool {
	for _, s := range [][]byte{syncBegin, syncEnd} {
		if bytes.HasPrefix(s, b) {
			return true
		}
	}
	return len(b) < 4
}

func hasAny(b []byte, set [][]byte) bool {
	for _, s := range set {
		if bytes.HasPrefix(b, s) {
			return true
		}
	}
	return false
}

// shellAtPrompt says whether a size goes the shell's way (resizeWhenDrawn,
// one step at a time, live): the cursor is at a prompt, the shell's
// output ended at it, or the shell is still drawing it after the last
// resize. The pane's lock is held.
func (p *Pane) shellAtPrompt(now time.Time) bool {
	if p.screen.AtPrompt() || p.atInput || p.pendingSize != nil {
		return true
	}
	if h := p.rhold; h != nil && h.prompt {
		held, _ := h.heldUntil(now)
		return held
	}
	return false
}

// resizeProgram takes a size asked for a program that is not a shell at
// its prompt; drag: it came within dragGap of the last one. The pane's
// lock is held.
func (p *Pane) resizeProgram(cols, rows int, drag bool, now time.Time) error {
	p.pendingSize = nil
	gc, gr := p.screen.Size()
	switch {
	case cols == gc && rows == gr:
		p.dropWant()
		return nil
	case !drag && p.want == nil && p.redrawDone(now):
		return p.applySize(cols, rows)
	}
	p.want = &[2]int{cols, rows}
	p.screen.SetView(cols, rows)
	// A step of a drag is drawn at once: no resize hold of the program's.
	if p.rhold != nil && !p.rhold.prompt {
		p.rhold = nil
	}
	p.renderChanged()
	p.armResize(now)
	return nil
}

// dropWant forgets a size not applied yet; the frames go out at the
// grid's size again. The pane's lock is held.
func (p *Pane) dropWant() {
	if p.want == nil {
		return
	}
	p.want = nil
	p.screen.SetView(0, 0)
	p.renderChanged()
}

// applySize resizes the grid and tells the program, and watches its
// redraw. A program that draws with synchronized output is shown as it
// was (cut or padded to the new size) until it has drawn itself again,
// not reflowed in between. The pane's lock is held.
func (p *Pane) applySize(cols, rows int) error {
	now := time.Now()
	frozen := p.redraw.frozen
	if p.syncSeen && !frozen {
		p.screen.Freeze()
		frozen = true
	}
	p.redraw = redrawWatch{at: now, frozen: frozen}
	err := p.resizeLocked(cols, rows)
	if frozen && p.rhold != nil && !p.rhold.prompt {
		// The frozen frame goes out at the new size at once; no resize
		// hold of the program's is needed to hide a reflow.
		p.rhold = nil
	}
	p.armResize(now)
	return err
}

// redrawDone says whether the program has drawn itself since the grid
// was last resized, and ends the freeze when it has. The pane's lock is
// held.
func (p *Pane) redrawDone(now time.Time) bool {
	w := &p.redraw
	if !w.done && !w.at.IsZero() {
		if !now.Before(w.at.Add(redrawMax)) || !now.Before(latest(w.at, p.lastOutput).Add(redrawQuiet)) {
			w.done = true
		}
	}
	if (w.done || w.at.IsZero()) && w.frozen {
		w.frozen = false
		p.screen.Thaw()
		p.renderChanged()
	}
	return w.done || w.at.IsZero()
}

// redrawOutput watches the program's output for the end of its redraw.
// The pane's lock is held.
func (p *Pane) redrawOutput(b []byte, now time.Time) {
	if !p.syncSeen && bytes.Contains(b, syncBegin) {
		p.syncSeen = true
	}
	w := &p.redraw
	if w.at.IsZero() || w.done {
		return
	}
	_, rows := p.screen.Size()
	if w.scan(b, rows) {
		p.redrawDone(now)
		p.armResize(now)
	}
}

// armResize sets the timer for what waits: the end of the freeze, and a
// size asked during a drag. The pane's lock is held.
func (p *Pane) armResize(now time.Time) {
	var at time.Time
	w := &p.redraw
	if !w.done && !w.at.IsZero() {
		at = minTime(w.at.Add(redrawMax), latest(w.at, p.lastOutput).Add(redrawQuiet))
	}
	if p.want != nil {
		pause := p.askedAt.Add(dragPause)
		if at.IsZero() || pause.After(at) {
			at = pause
		}
	}
	if at.IsZero() {
		return
	}
	wait := max(at.Sub(now), 0)
	if p.resizeT == nil {
		p.resizeT = time.AfterFunc(wait, p.resizeTick)
	} else {
		p.resizeT.Reset(wait)
	}
}

// resizeTick applies a size asked during a drag once the drag has paused
// and the program has drawn itself at the last one, always the latest
// size asked.
func (p *Pane) resizeTick() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	now := time.Now()
	done := p.redrawDone(now)
	if p.want != nil && p.ovr.Cols == 0 && done && !now.Before(p.askedAt.Add(dragPause)) {
		size := *p.want
		p.applySize(size[0], size[1])
		return
	}
	p.armResize(now)
}

func latest(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}
