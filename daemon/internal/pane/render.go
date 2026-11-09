package pane

import (
	"bytes"
	"context"
	"io"
	"slices"
	"time"

	"ravenryd/internal/rframe"
	"ravenryd/internal/vt"
)

// The render stream (docs/RENDERING.md): the pane's screen as frames of
// changed rows, for a client that draws the screen itself. The daemon's
// screen is the only screen; a client keeps a copy of the rows it was
// sent and draws them.

// renderView is the live screen as the render stream sends it: each row
// encoded, and the generation it last changed in. The pane's lock guards
// it.
type renderView struct {
	cols, rows int
	data       [][]byte
	wraps      []bool
	gen        []uint64
	next       uint64
	info       vt.RenderInfo
	held       bool
	ok         bool
}

// update reads what changed on the screen into the view. The pane's lock
// is held.
func (p *Pane) renderUpdate() {
	v := &p.rview
	cols, rows := p.screen.Size()
	all := !v.ok || cols != v.cols || rows != v.rows
	if all {
		v.cols, v.rows = cols, rows
		v.data = make([][]byte, rows)
		v.wraps = make([]bool, rows)
		v.gen = make([]uint64, rows)
		v.next++
		for y := range v.gen {
			v.gen[y] = v.next
		}
		v.ok = true
	}
	info, held, err := p.screen.Render(all, func(y int, wrap bool, data []byte) {
		if y >= len(v.data) || (v.wraps[y] == wrap && bytes.Equal(v.data[y], data) && v.data[y] != nil) {
			return
		}
		v.data[y] = append(v.data[y][:0:0], data...)
		v.wraps[y] = wrap
		v.next++
		v.gen[y] = v.next
	})
	if err == nil {
		v.info, v.held = info, held
	}
}

// resizeHold keeps the render stream's frames back after a resize until
// the program has drawn itself at the new size, so a client never draws
// the screen between the resize and the program's redraw. At a shell
// prompt that matters most: the resize clears the prompt for the shell
// to draw again (as Ghostty does), and the shell's redraw comes
// milliseconds later.
type resizeHold struct {
	at, start  time.Time
	prompt     bool // the cursor was at a prompt
	output     bool // output came after the resize
	inputStart bool // the shell's prompt was drawn again (OSC 133 B)
	more       bool // the program is most likely still writing (Pane.writing)
	last       time.Time
}

// How long a resize holds frames back.
const (
	// holdQuiet: output came and has been quiet this long.
	holdQuiet = 6 * time.Millisecond
	// holdQuietPrompt: the shell drew its prompt again and has been
	// quiet this long (the command line follows the prompt).
	holdQuietPrompt = 4 * time.Millisecond
	// holdQuietMore: the program is most likely still writing
	// (Pane.writing); on a busy machine its next write came up to 10 ms
	// later (zsh drawing a long command line during a fast drag).
	holdQuietMore = 30 * time.Millisecond
	// holdNoOutput: no output came at all, at a prompt and elsewhere.
	holdNoOutputPrompt = 120 * time.Millisecond
	holdNoOutput       = 30 * time.Millisecond
	// holdMax: the longest from the last resize, and from the first of a
	// run of them.
	holdMax      = 250 * time.Millisecond
	holdMaxTotal = 500 * time.Millisecond
	// holdMaxProgram: a program that is not a shell at a prompt redraws
	// on its own schedule (a spinner may never be quiet).
	holdMaxProgram = 100 * time.Millisecond
)

// heldUntil says whether the resize hold still holds at now, and if so
// until when at the latest (the caller looks again then, or at the next
// output).
func (h *resizeHold) heldUntil(now time.Time) (bool, time.Time) {
	deadline := minTime(h.at.Add(holdMax), h.start.Add(holdMaxTotal))
	if !h.prompt {
		deadline = minTime(deadline, h.at.Add(holdMaxProgram))
	}
	switch {
	case h.more:
		deadline = minTime(deadline, h.last.Add(holdQuietMore))
	case h.inputStart:
		deadline = minTime(deadline, h.last.Add(holdQuietPrompt))
	case h.output:
		deadline = minTime(deadline, h.last.Add(holdQuiet))
	case h.prompt:
		deadline = minTime(deadline, h.at.Add(holdNoOutputPrompt))
	default:
		deadline = minTime(deadline, h.at.Add(holdNoOutput))
	}
	return now.Before(deadline), deadline
}

// inputStartMark starts the shell's input start mark (OSC 133 B), ended
// by BEL or ST.
var inputStartMark = []byte("\x1b]133;B")

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// resized starts or extends the resize hold. The pane's lock is held;
// atPrompt is read before the screen was resized.
func (p *Pane) resized(atPrompt bool) {
	now := time.Now()
	if p.rhold == nil {
		p.rhold = &resizeHold{start: now}
	}
	h := p.rhold
	h.at, h.prompt, h.output, h.inputStart, h.more = now, atPrompt, false, false, false
	for s := range p.rsubs {
		s.signal()
	}
}

// resizeWhenDrawn resizes the pane, or, while the shell at a prompt is
// still drawing itself after the last resize, keeps the size for when it
// is done. A shell that gets a resize in the middle of its redraw counts
// its prompt's rows from a screen that changed under it, and leaves
// pieces of the old prompt behind; one resize at a time, each when the
// shell is idle again, never does. The pane's lock is held.
func (p *Pane) resizeWhenDrawn(cols, rows int) error {
	if c, r := p.screen.Size(); c == cols && r == rows && p.pendingSize == nil {
		return nil
	}
	if wait, _ := p.resizeWait(time.Now()); wait {
		p.pendingSize = &[2]int{cols, rows}
		p.armPendingResize()
		return nil
	}
	p.pendingSize = nil
	return p.resizeLocked(cols, rows)
}

// resizeWait says whether a size asked for now waits, and until when at
// the latest: while the shell at a prompt draws itself after the last
// resize, and while it is still writing (its last output filled the
// pty's buffer), even once the hold has ended. A shell's redraw cut in
// two by a resize leaves its rows where the next one does not look for
// them: blank rows scrolled into the scrollback, or a copy of the
// prompt above the next. The pane's lock is held.
func (p *Pane) resizeWait(now time.Time) (bool, time.Time) {
	if h := p.rhold; h != nil && h.prompt {
		if held, until := p.renderHeld(now); held {
			return true, until
		}
	}
	if p.writing() && p.screen.AtPrompt() {
		if until := p.lastOutput.Add(holdQuietMore); now.Before(until) {
			return true, until
		}
	}
	return false, time.Time{}
}

// writing says whether the program is most likely still writing: its
// last read filled the pty's buffer (1 KiB on macOS; it is blocked in a
// write), or it is a shell whose output stopped at its input start (OSC
// 133 B) while its command line has text: zsh writes the prompt and the
// command line apart, and on a busy machine the command line came 6 ms
// after the prompt (measured in TestRenderDragZsh). The pane's lock is
// held.
func (p *Pane) writing() bool {
	return p.lastFull || p.atInput && p.cmdLine
}

// armPendingResize sets the timer that applies a pending size when the
// resize hold ends. The pane's lock is held.
func (p *Pane) armPendingResize() {
	if p.pendingSize == nil {
		return
	}
	held, until := p.resizeWait(time.Now())
	if !held {
		until = time.Now()
	}
	wait := max(time.Until(until), 0)
	if p.pendingT == nil {
		p.pendingT = time.AfterFunc(wait, p.applyPendingResize)
	} else {
		p.pendingT.Reset(wait)
	}
}

func (p *Pane) applyPendingResize() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.pendingSize == nil {
		return
	}
	if wait, _ := p.resizeWait(time.Now()); wait {
		p.armPendingResize()
		return
	}
	size := *p.pendingSize
	p.pendingSize = nil
	if p.ovr.Cols == 0 {
		p.resizeLocked(size[0], size[1])
	}
}

// renderHeld says whether frames are held back now, and until when at
// the latest. The pane's lock is held.
func (p *Pane) renderHeld(now time.Time) (bool, time.Time) {
	if p.rhold != nil {
		if held, until := p.rhold.heldUntil(now); held {
			return true, until
		}
		if p.rhold.inputStart && p.atInput {
			// The redraw ended at the prompt: the command line is empty.
			p.cmdLine = false
		}
		p.rhold = nil
	}
	return false, time.Time{}
}

// RenderOptions configures a render stream.
type RenderOptions struct {
	// FPS is the most frames a second the client draws (its display's
	// rate). Zero means 60.
	FPS int
	// Window is how many frames may be sent and not yet acknowledged.
	// Zero means 2.
	Window int
}

// RenderSub is one client's render stream of a pane.
type RenderSub struct {
	p        *Pane
	wake     chan struct{}
	interval time.Duration
	window   uint32

	// Guarded by the pane's lock.
	seq, acked uint32
	lastSent   time.Time
	full       bool // the next frame carries every row
	sentGen    []uint64
	sentCols   int
	sentRows   int
	sentInfo   vt.RenderInfo
	sentTitle  *string
	sentColors *vt.RenderColors
	sentLinks  map[uint16]bool
	sentBell   uint32
	ended      bool
	closed     bool

	// A scrolled view (Scroll): its top row in the screen's coordinates
	// (row 0 the oldest kept), and the rows last sent of it.
	scrolled bool
	top      int
	histData [][]byte
	histWrap []bool
	histDue  bool

	stats RenderStats
}

// RenderStats counts what a render stream sent.
type RenderStats struct {
	Frames, Full, Rows int
	Bytes              int64
	Held               int
}

// Render starts a render stream of the pane.
func (p *Pane) Render(o RenderOptions) (*RenderSub, error) {
	fps := o.FPS
	if fps <= 0 {
		fps = 60
	}
	fps = min(max(fps, 1), 240)
	w := o.Window
	if w <= 0 {
		w = 2
	}
	s := &RenderSub{p: p, wake: make(chan struct{}, 1), interval: time.Second / time.Duration(fps), window: uint32(min(w, 64)), full: true, sentLinks: map[uint16]bool{}}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrClosed
	}
	s.ended = p.ended
	if p.rsubs == nil {
		p.rsubs = map[*RenderSub]struct{}{}
	}
	p.rsubs[s] = struct{}{}
	s.signal()
	return s, nil
}

func (s *RenderSub) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Ack records that the client drew the frames up to seq.
func (s *RenderSub) Ack(seq uint32) {
	s.p.mu.Lock()
	if int32(seq-s.acked) > 0 && int32(s.seq-seq) >= 0 {
		s.acked = seq
	}
	s.p.mu.Unlock()
	s.signal()
}

// Scroll shows the screen scrolled offset rows up into the scrollback (0:
// the live screen). Output that comes while scrolled does not move the
// view; the frames say where it is.
func (s *RenderSub) Scroll(offset int) {
	p := s.p
	p.mu.Lock()
	if offset <= 0 {
		if s.scrolled {
			s.scrolled, s.full, s.histData, s.histWrap = false, true, nil, nil
		}
	} else {
		p.renderUpdate()
		hist := p.rview.info.History
		s.scrolled = true
		s.top = max(0, hist-offset)
		s.histDue = true
	}
	p.mu.Unlock()
	s.signal()
}

// Redraw makes the next frame carry every row.
func (s *RenderSub) Redraw() {
	s.p.mu.Lock()
	s.full = true
	s.p.mu.Unlock()
	s.signal()
}

// Stats returns what the stream has sent so far.
func (s *RenderSub) Stats() RenderStats {
	s.p.mu.Lock()
	defer s.p.mu.Unlock()
	return s.stats
}

// Close ends the stream.
func (s *RenderSub) Close() {
	s.p.mu.Lock()
	delete(s.p.rsubs, s)
	s.closed = true
	s.p.mu.Unlock()
	s.signal()
}

// renderChanged wakes the render streams after the screen changed. The
// pane's lock is held.
func (p *Pane) renderChanged() {
	for s := range p.rsubs {
		if s.scrolled {
			s.histDue = true
		}
		s.signal()
	}
}

// Next waits for the next frame and returns its payload (RENDERING.md).
// It returns io.EOF once the pane's output has ended and the last frame
// was sent.
func (s *RenderSub) Next(ctx context.Context) ([]byte, error) {
	p := s.p
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		var wait time.Duration
		p.mu.Lock()
		if s.closed {
			p.mu.Unlock()
			return nil, ErrSubClosed
		}
		now := time.Now()
		switch held, until := p.renderHeld(now); {
		case p.closed:
			p.mu.Unlock()
			return nil, io.EOF
		case s.seq-s.acked >= s.window:
			// The client has not drawn what it has: an ack wakes us.
			wait = -1
		case now.Before(s.lastSent.Add(s.interval)):
			wait = s.lastSent.Add(s.interval).Sub(now)
		case held:
			s.stats.Held++
			wait = until.Sub(now)
		default:
			if b := s.frame(now); b != nil {
				p.mu.Unlock()
				return b, nil
			}
			if s.ended {
				p.mu.Unlock()
				return nil, io.EOF
			}
			if p.rview.held {
				// A program's render hold: look again when it would
				// time out, if no output ends it first.
				wait = renderHoldMax / 4
			} else {
				wait = -1
			}
		}
		if p.ended {
			s.ended = true
		}
		p.mu.Unlock()
		var tc <-chan time.Time
		if wait >= 0 {
			if timer == nil {
				timer = time.NewTimer(wait)
			} else {
				timer.Reset(wait)
			}
			tc = timer.C
		}
		select {
		case <-s.wake:
		case <-tc:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if timer != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}
}

// renderHoldMax matches the screen's own timeout for a program's render
// hold (vt).
const renderHoldMax = time.Second

// frame builds the next frame, or nil when nothing changed. The pane's
// lock is held.
func (s *RenderSub) frame(now time.Time) []byte {
	p := s.p
	p.renderUpdate()
	v := &p.rview
	f := rframe.Frame{Cols: v.cols, Rows: v.rows}
	info := v.info
	if v.held {
		f.Flags |= rframe.FlagHeld
	}
	full := s.full || s.sentCols != v.cols || s.sentRows != v.rows
	var rows []rframe.Row
	if s.scrolled {
		if !s.histDue && !full {
			info.Offset = s.sentInfo.Offset
		} else {
			offset := max(0, info.History-s.top)
			hinfo, err := p.screen.RenderAt(offset, func(y int, wrap bool, data []byte) {
				if y >= v.rows {
					return
				}
				if len(s.histData) != v.rows {
					s.histData, s.histWrap = make([][]byte, v.rows), make([]bool, v.rows)
					full = true
				}
				if !full && s.histWrap[y] == wrap && s.histData[y] != nil && bytes.Equal(s.histData[y], data) {
					return
				}
				d := append([]byte(nil), data...)
				s.histData[y], s.histWrap[y] = d, wrap
				rows = append(rows, rframe.Row{Y: y, Wrap: wrap, Data: d})
			})
			if err == nil {
				info.Cursor = hinfo.Cursor
				info.Offset = hinfo.Offset
				info.History = hinfo.History
				s.top = hinfo.History - hinfo.Offset
			}
			s.histDue = false
		}
	} else {
		if full || len(s.sentGen) != v.rows {
			s.sentGen = make([]uint64, v.rows)
			full = true
		}
		for y := 0; y < v.rows; y++ {
			if full || s.sentGen[y] != v.gen[y] {
				rows = append(rows, rframe.Row{Y: y, Wrap: v.wraps[y], Data: v.data[y]})
				s.sentGen[y] = v.gen[y]
			}
		}
	}
	if full {
		f.Flags |= rframe.FlagFull
	}
	f.Lines = rows
	f.History, f.Offset, f.Cursor, f.Modes, f.Bell = info.History, info.Offset, info.Cursor, info.Modes, p.bells
	if full || s.sentTitle == nil || *s.sentTitle != info.Title {
		t := info.Title
		f.Title, s.sentTitle = &t, &t
	}
	if full || s.sentColors == nil || !sameColors(*s.sentColors, info.Colors) {
		c := info.Colors
		f.Colors, s.sentColors = &c, &c
	}
	if full {
		clear(s.sentLinks)
	}
	for _, r := range rows {
		for _, id := range rowLinks(r.Data) {
			if !s.sentLinks[id] {
				s.sentLinks[id] = true
				f.Links = append(f.Links, rframe.Link{ID: id, URI: p.screen.LinkURI(id)})
			}
		}
	}
	changed := full || len(rows) > 0 || f.Title != nil || f.Colors != nil ||
		f.Cursor != s.sentInfo.Cursor || f.Modes != s.sentInfo.Modes ||
		f.History != s.sentInfo.History || f.Offset != s.sentInfo.Offset || f.Bell != s.sentBell
	if !changed {
		return nil
	}
	s.seq++
	f.Seq = s.seq
	b := f.Append(nil)
	s.full = false
	s.sentCols, s.sentRows = v.cols, v.rows
	s.sentInfo = vt.RenderInfo{Cursor: f.Cursor, Modes: f.Modes, History: f.History, Offset: f.Offset}
	s.sentBell = f.Bell
	s.lastSent = now
	s.stats.Frames++
	s.stats.Rows += len(rows)
	s.stats.Bytes += int64(len(b))
	if full {
		s.stats.Full++
	}
	return b
}

func sameColors(a, b vt.RenderColors) bool {
	return a.Fg == b.Fg && a.Bg == b.Bg && a.Cursor == b.Cursor && a.FgSet == b.FgSet &&
		a.BgSet == b.BgSet && a.CursorSet == b.CursorSet && slices.Equal(a.Palette, b.Palette)
}

// rowLinks lists the hyperlink ids an encoded row uses.
func rowLinks(data []byte) []uint16 {
	var ids []uint16
	for len(data) >= 18 {
		if id := uint16(data[14])<<8 | uint16(data[15]); id != 0 && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
		n := int(data[16])<<8 | int(data[17])
		data = data[18:]
		for range n {
			if len(data) == 0 {
				return ids
			}
			b := data[0]
			l := 0
			if b != 0 && b != 0xff {
				l = int(b & 0x7f)
			}
			data = data[min(len(data), 1+l):]
		}
	}
	return ids
}

// TextRange returns the text between two points of the screen, in screen
// coordinates (row 0 the oldest scrollback row kept), as a copy.
func (p *Pane) TextRange(x0, y0, x1, y1 int, rect bool) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return "", ErrClosed
	}
	return p.screen.TextRange(x0, y0, x1, y1, rect)
}

// EncodeInput encodes a client's input event with the screen's encoders
// (vt.Screen EncodeKeyEvent, EncodeMouse, EncodeFocus, EncodePaste).
func (p *Pane) EncodeInput(f func(vt.Screen) ([]byte, error)) ([]byte, error) {
	return p.encode(f)
}
