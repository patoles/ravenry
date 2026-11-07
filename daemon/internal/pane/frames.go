package pane

import (
	"slices"
	"time"

	"ravenryd/internal/vt"
)

// A pane's filmstrip (pane.frames): its recent screens, so a flicker, a
// half-drawn menu or a spinner that stalls can be seen after the fact.
//
// A frame is taken when the pane prints, at most every frameEvery: at
// once when the last frame is older than that, else once at the end of
// the interval. A frame equal to the one before is not kept. Frames older
// than frameWindow go, and so do the oldest past frameBytes. Rows that
// did not change are shared with the frame before, so a spinner costs one
// row a frame, not a screen.

const (
	frameEvery  = 100 * time.Millisecond
	frameWindow = 20 * time.Second
	frameBytes  = 4 << 20
	// cellBytes is what a cell costs in memory, roughly.
	cellBytes = 48
)

type frameRow struct {
	cells []vt.Cell
	refs  int
}

type frame struct {
	at          time.Time
	mark        uint64
	cols, rows  int
	lines       []*frameRow
	cursor      vt.Cursor
	cursorStyle string
	fg, bg      vt.RGB
	cursorColor *vt.RGB
}

// frameRing is guarded by the pane's lock.
type frameRing struct {
	frames []*frame
	bytes  int
	last   time.Time
	timer  *time.Timer
	off    bool
}

func newFrameRing() *frameRing { return &frameRing{} }

// changed is called with the pane's lock held, after output.
func (r *frameRing) changed(p *Pane, now time.Time) {
	if r.off || r.timer != nil {
		return
	}
	if wait := frameEvery - now.Sub(r.last); wait > 0 {
		r.timer = time.AfterFunc(wait, func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			r.timer = nil
			if !p.closed {
				r.take(p, time.Now())
			}
		})
		return
	}
	r.take(p, now)
}

// take adds the screen now, unless it equals the last frame. The pane's
// lock is held.
func (r *frameRing) take(p *Pane, now time.Time) {
	r.last = now
	g, err := p.screen.Grid()
	if err != nil {
		return
	}
	var prev *frame
	if n := len(r.frames); n > 0 {
		prev = r.frames[n-1]
	}
	f := &frame{
		at: now, mark: p.offset, cols: g.Cols, rows: g.Rows, cursor: g.Cursor, cursorStyle: g.CursorStyle,
		fg: g.Fg, bg: g.Bg, cursorColor: g.CursorColor, lines: make([]*frameRow, len(g.Cells)),
	}
	same := prev != nil && prev.cols == f.cols && prev.rows == f.rows && prev.cursor == f.cursor &&
		prev.fg == f.fg && prev.bg == f.bg && prev.cursorStyle == f.cursorStyle
	for i, cells := range g.Cells {
		if prev != nil && prev.cols == f.cols && i < len(prev.lines) && slices.Equal(prev.lines[i].cells, cells) {
			f.lines[i] = prev.lines[i]
			f.lines[i].refs++
			continue
		}
		same = false
		f.lines[i] = &frameRow{cells: cells, refs: 1}
		r.bytes += len(cells) * cellBytes
	}
	if same {
		r.release(f)
		return
	}
	r.frames = append(r.frames, f)
	r.prune(now)
}

func (r *frameRing) release(f *frame) {
	for _, l := range f.lines {
		l.refs--
		if l.refs == 0 {
			r.bytes -= len(l.cells) * cellBytes
		}
	}
}

func (r *frameRing) prune(now time.Time) {
	drop := 0
	for drop < len(r.frames)-1 && (now.Sub(r.frames[drop].at) > frameWindow || r.bytes > frameBytes) {
		r.release(r.frames[drop])
		drop++
	}
	if drop > 0 {
		r.frames = slices.Delete(r.frames, 0, drop)
	}
}

func (r *frameRing) drop() {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.off = true
	r.frames, r.bytes = nil, 0
}

// ScreenFrame is one of a pane's recent screens.
type ScreenFrame struct {
	At   time.Time
	Mark uint64
	Grid *vt.Grid
}

// Frames returns the pane's screens of the last stretch of time (all it
// holds when last is zero), oldest first, ending with the screen now.
func (p *Pane) Frames(last time.Duration) ([]ScreenFrame, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	r := p.frames
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	now := time.Now()
	// The screen now, so the strip ends where the pane is.
	r.take(p, now)
	var out []ScreenFrame
	for _, f := range r.frames {
		if last > 0 && now.Sub(f.at) > last {
			continue
		}
		g := &vt.Grid{Cols: f.cols, Rows: f.rows, Cursor: f.cursor, CursorStyle: f.cursorStyle, Fg: f.fg, Bg: f.bg, CursorColor: f.cursorColor}
		g.Cells = make([][]vt.Cell, len(f.lines))
		for i, l := range f.lines {
			g.Cells[i] = l.cells
		}
		out = append(out, ScreenFrame{At: f.at, Mark: f.mark, Grid: g})
	}
	if len(out) == 0 && len(r.frames) > 0 {
		f := r.frames[len(r.frames)-1]
		g := &vt.Grid{Cols: f.cols, Rows: f.rows, Cursor: f.cursor, CursorStyle: f.cursorStyle, Fg: f.fg, Bg: f.bg, CursorColor: f.cursorColor}
		for _, l := range f.lines {
			g.Cells = append(g.Cells, l.cells)
		}
		out = append(out, ScreenFrame{At: f.at, Mark: f.mark, Grid: g})
	}
	return out, nil
}

// Grid returns the screen now, cell by cell, and its mark.
func (p *Pane) Grid() (*vt.Grid, uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, 0, ErrClosed
	}
	g, err := p.screen.Grid()
	return g, p.offset, err
}

// GridAt returns the screen as it would look at another size: the
// pane's screen rebuilt in a fresh terminal and resized there, which
// reflows its text. The program is not told and does not redraw; for
// that, change the pane's size (pane.resize, or pane.override).
func (p *Pane) GridAt(cols, rows int) (*vt.Grid, uint64, error) {
	p.mu.Lock()
	snap, err := p.screen.Snapshot()
	c0, r0 := p.screen.Size()
	mark := p.offset
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return nil, 0, ErrClosed
	}
	if err != nil {
		return nil, 0, err
	}
	s, err := vt.New(vt.Options{Cols: c0, Rows: r0, Scrollback: 2000})
	if err != nil {
		return nil, 0, err
	}
	defer s.Close()
	s.Write(snap)
	if err := s.Resize(cols, rows); err != nil {
		return nil, 0, err
	}
	g, err := s.Grid()
	return g, mark, err
}
