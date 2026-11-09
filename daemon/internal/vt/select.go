package vt

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	gt "go.mitchellh.com/libghostty"
)

// Selection, search and links for a client that draws the screen itself
// (RENDERING.md): the client says where the pointer is and what the
// person did; libghostty-vt decides what is selected (its selection
// gesture: a click, two for a word, three for a line, a drag, a block
// with Option) and finds text (its search), so every client selects and
// finds the same way.

// Range is a range of cells in screen coordinates (row 0 is the oldest row
// of the scrollback), from X0, Y0 to X1, Y1 inclusive, in reading order.
// Rect: a block, columns X0 to X1 on each row.
type Range struct {
	X0, Y0, X1, Y1 int
	Rect           bool
}

// SelectEvent is one step of a selection gesture.
type SelectEvent struct {
	// Action: press, drag, release, all (select everything), clear.
	Action string
	// X, Y: the cell under the pointer, in screen coordinates.
	X, Y int
	// PX, PY: the pointer from the grid's top left corner, and the cell's
	// size, in the client's units.
	PX, PY                float64
	CellWidth, CellHeight float64
	// Extend: Shift, the press extends the selection there. Rect: Option,
	// a block.
	Extend, Rect bool
	// Time of the event; zero is now. Two presses close in time and place
	// make a double click, three a triple.
	Time time.Time
}

// The gesture's units: the client's units times this, so a fraction of
// a point still counts.
const gestureScale = 16

// selection state of a ghostty screen.
type selState struct {
	g      *gt.SelectionGesture
	ev     map[gt.SelectionGestureEventType]*gt.SelectionGestureEvent
	extend *gt.Point // a Shift press's anchor while its drag lasts
	epoch  time.Time
}

func (s *ghostty) gestureEvent(kind gt.SelectionGestureEventType) (*gt.SelectionGestureEvent, error) {
	if s.sel.g == nil {
		g, err := gt.NewSelectionGesture()
		if err != nil {
			return nil, err
		}
		s.sel.g = g
		s.sel.ev = map[gt.SelectionGestureEventType]*gt.SelectionGestureEvent{}
		s.sel.epoch = time.Now()
	}
	if e := s.sel.ev[kind]; e != nil {
		return e, nil
	}
	e, err := gt.NewSelectionGestureEvent(kind)
	if err != nil {
		return nil, err
	}
	s.sel.ev[kind] = e
	return e, nil
}

func (s *ghostty) screenRef(x, y int) (*gt.GridRef, error) {
	history := s.history()
	x = max(0, min(x, s.cols-1))
	y = max(0, min(y, history+s.rows-1))
	return s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, X: uint16(x), Y: uint32(y)})
}

// history is the number of scrollback rows above the screen.
func (s *ghostty) history() int {
	sb, err := s.t.Scrollbar()
	if err != nil {
		return 0
	}
	return int(sb.Total) - int(sb.Len)
}

// Select applies one step of a selection gesture.
func (s *ghostty) Select(e SelectEvent) error {
	switch e.Action {
	case "clear":
		s.sel.extend = nil
		return s.t.SetSelection(nil)
	case "all":
		s.sel.extend = nil
		sel, err := s.t.SelectAll()
		if err != nil || sel == nil {
			return err
		}
		return s.t.SetSelection(sel)
	}
	ref, err := s.screenRef(e.X, e.Y)
	if err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	if e.Action == "press" && e.Extend {
		if cur, ok := s.Selection(); ok {
			// Shift: from the selection's start to here, and on with
			// the drag.
			a := gt.Point{Tag: gt.PointTagScreen, X: uint16(cur.X0), Y: uint32(cur.Y0)}
			if e.Y < cur.Y0 || (e.Y == cur.Y0 && e.X < cur.X0) {
				a = gt.Point{Tag: gt.PointTagScreen, X: uint16(cur.X1), Y: uint32(cur.Y1)}
			}
			s.sel.extend = &a
			return s.extendTo(e)
		}
	}
	if s.sel.extend != nil {
		switch e.Action {
		case "drag":
			return s.extendTo(e)
		case "release":
			s.sel.extend = nil
			return nil
		}
		s.sel.extend = nil
	}
	var kind gt.SelectionGestureEventType
	switch e.Action {
	case "press":
		kind = gt.SelectionGestureEventTypePress
	case "drag":
		kind = gt.SelectionGestureEventTypeDrag
	case "release":
		kind = gt.SelectionGestureEventTypeRelease
	default:
		return fmt.Errorf("vt: select: unknown action %q", e.Action)
	}
	ev, err := s.gestureEvent(kind)
	if err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	cw := max(1, uint32(e.CellWidth*gestureScale))
	ch := max(1, e.CellHeight*gestureScale)
	if err := ev.SetRef(ref); err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	ev.SetPosition(gt.SurfacePosition{X: e.PX * gestureScale, Y: e.PY * gestureScale})
	t := e.Time
	if t.IsZero() {
		t = time.Now()
	}
	ev.SetTimeNS(uint64(max(0, t.Sub(s.sel.epoch))))
	ev.SetRepeatIntervalNS(uint64(500 * time.Millisecond))
	ev.SetRepeatDistance(float64(cw))
	ev.SetBehaviors(gt.SelectionGestureBehaviors{
		SingleClick: gt.SelectionGestureBehaviorCell,
		DoubleClick: gt.SelectionGestureBehaviorWord,
		TripleClick: gt.SelectionGestureBehaviorLine,
	})
	ev.SetRectangle(e.Rect)
	ev.SetGeometry(gt.SelectionGestureGeometry{
		Columns: uint32(s.cols), CellWidth: cw, ScreenHeight: max(1, uint32(float64(s.rows)*ch)),
	})
	sel, err := s.sel.g.Event(s.t, ev)
	if err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	if sel != nil {
		return s.t.SetSelection(sel)
	}
	if kind == gt.SelectionGestureEventTypePress {
		// A click alone: nothing selected.
		return s.t.SetSelection(nil)
	}
	return nil
}

// extendTo sets the selection from the Shift press's anchor to the cell
// of e.
func (s *ghostty) extendTo(e SelectEvent) error {
	a, err := s.t.GridRef(*s.sel.extend)
	if err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	b, err := s.screenRef(e.X, e.Y)
	if err != nil {
		return fmt.Errorf("vt: select: %w", err)
	}
	return s.t.SetSelection(&gt.Selection{Start: *a, End: *b, Rectangle: e.Rect})
}

// Selection is the screen's selection, in screen coordinates, in reading
// order.
func (s *ghostty) Selection() (Range, bool) {
	sel, err := s.t.Selection()
	if err != nil || sel == nil {
		return Range{}, false
	}
	return s.span(sel)
}

func (s *ghostty) span(sel *gt.Selection) (Range, bool) {
	a, err := s.t.PointFromGridRef(&sel.Start, gt.PointTagScreen)
	if err != nil {
		return Range{}, false
	}
	b, err := s.t.PointFromGridRef(&sel.End, gt.PointTagScreen)
	if err != nil {
		return Range{}, false
	}
	sp := Range{X0: int(a.X), Y0: int(a.Y), X1: int(b.X), Y1: int(b.Y), Rect: sel.Rectangle}
	if sp.Y1 < sp.Y0 || (sp.Y1 == sp.Y0 && sp.X1 < sp.X0) {
		sp.X0, sp.Y0, sp.X1, sp.Y1 = sp.X1, sp.Y1, sp.X0, sp.Y0
	}
	if sp.Rect && sp.X1 < sp.X0 {
		sp.X0, sp.X1 = sp.X1, sp.X0
	}
	return sp, true
}

// SelectionText is the selection as a copy reads it: soft-wrapped rows
// joined, trailing spaces trimmed. Empty when nothing is selected.
func (s *ghostty) SelectionText() (string, error) {
	sp, ok := s.Selection()
	if !ok {
		return "", nil
	}
	return s.TextRange(sp.X0, sp.Y0, sp.X1, sp.Y1, sp.Rect)
}

// Find is a search of the screen and its scrollback, libghostty-vt's.
// Matching ignores the case of ASCII letters.
type Find struct {
	s      *ghostty
	search *gt.Search
	needle string
}

// NewFind starts a search with no needle.
func (s *ghostty) NewFind() (*Find, error) {
	sr, err := gt.NewSearch(s.t)
	if err != nil {
		return nil, fmt.Errorf("vt: search: %w", err)
	}
	sr.SetScrollPolicy(gt.SearchScrollPolicyNever)
	return &Find{s: s, search: sr}, nil
}

// SetNeedle sets what to find; empty clears the matches.
func (f *Find) SetNeedle(needle string) error {
	if needle == f.needle {
		return nil
	}
	f.needle = needle
	if err := f.search.SetNeedle([]byte(needle)); err != nil {
		return fmt.Errorf("vt: search: %w", err)
	}
	return nil
}

// Needle is what the search looks for.
func (f *Find) Needle() string { return f.needle }

// Update brings the matches up to date with the screen.
func (f *Find) Update() error {
	if f.needle == "" {
		return nil
	}
	if err := f.search.Run(); err != nil {
		return fmt.Errorf("vt: search: %w", err)
	}
	return nil
}

// Step selects the next match toward older output (dir > 0) or newer
// (dir < 0), and returns it.
func (f *Find) Step(dir int) (Range, bool, error) {
	if f.needle == "" {
		return Range{}, false, nil
	}
	var err error
	if dir < 0 {
		err = f.search.SelectPrevious()
	} else {
		err = f.search.SelectNext()
	}
	if err != nil {
		if e, ok := err.(*gt.Error); ok && e.Result == gt.ResultNoValue {
			return Range{}, false, nil
		}
		return Range{}, false, fmt.Errorf("vt: search: %w", err)
	}
	m, err := f.search.SelectedMatch()
	if err != nil || m == nil {
		return Range{}, false, err
	}
	sp, ok := f.s.span(m)
	return sp, ok, nil
}

// Matches returns the count of matches, the selected one's index (from
// the newest, -1 for none) and span, and the matches on screen rows top
// to top+rows-1.
func (f *Find) Matches(top, rows int) (count, index int, selected *Range, in []Range, err error) {
	index = -1
	if f.needle == "" {
		return 0, -1, nil, nil, nil
	}
	n, err := f.search.MatchCount()
	if err != nil {
		return 0, -1, nil, nil, fmt.Errorf("vt: search: %w", err)
	}
	count = int(n)
	if i, err := f.search.SelectedIndex(); err == nil && i != nil {
		index = int(*i)
		if m, err := f.search.SelectedMatch(); err == nil && m != nil {
			if sp, ok := f.s.span(m); ok {
				selected = &sp
			}
		}
	}
	all, err := f.search.Matches()
	if err != nil {
		return count, index, selected, nil, fmt.Errorf("vt: search: %w", err)
	}
	// Newest first: stop once the matches are above the rows.
	for i := range all {
		sp, ok := f.s.span(&all[i])
		if !ok {
			continue
		}
		if sp.Y0 >= top+rows {
			continue
		}
		if sp.Y1 < top {
			break
		}
		in = append(in, sp)
	}
	return count, index, selected, in, nil
}

// Close frees the search.
func (f *Find) Close() { f.search.Close() }

// Link is a link on the screen: a hyperlink (OSC 8) or a URL in the text.
type Link struct {
	URI  string
	Span Range
}

// urlPattern finds URLs in text: http, https and file.
var urlPattern = regexp.MustCompile(`(?:https?://|file://)[^\s<>"'` + "`" + `]+`)

// LinkAt is the link on the cell x, y (screen coordinates): the
// program's hyperlink there, or a URL written in the text, which may run
// over soft-wrapped rows.
func (s *ghostty) LinkAt(x, y int) (Link, bool) {
	history := s.history()
	total := history + s.rows
	if x < 0 || x >= s.cols || y < 0 || y >= total {
		return Link{}, false
	}
	ref, err := s.screenRef(x, y)
	if err != nil {
		return Link{}, false
	}
	if uri, err := ref.HyperlinkURI(); err == nil && uri != "" {
		return s.hyperlinkSpan(uri, x, y, total), true
	}
	// The logical line: rows joined by soft wraps.
	wraps := func(row int) bool {
		r, err := s.screenRef(0, row)
		if err != nil {
			return false
		}
		rw, err := r.Row()
		if err != nil {
			return false
		}
		w, _ := rw.Wrap()
		return w
	}
	top, bottom := y, y
	for top > 0 && y-top < 20 && wraps(top-1) {
		top--
	}
	for bottom < total-1 && bottom-y < 20 && wraps(bottom) {
		bottom++
	}
	var b strings.Builder
	type at struct{ x, y int }
	var pos []at // the cell of each byte of the text
	for row := top; row <= bottom; row++ {
		for col := 0; col < s.cols; col++ {
			r, err := s.screenRef(col, row)
			if err != nil {
				return Link{}, false
			}
			c, err := r.Cell()
			if err != nil {
				return Link{}, false
			}
			if w, _ := c.Wide(); w == gt.CellWideSpacerTail || w == gt.CellWideSpacerHead {
				continue
			}
			cps, _ := r.Graphemes()
			text := " "
			if len(cps) > 0 {
				rs := make([]rune, len(cps))
				for i, cp := range cps {
					rs[i] = rune(cp)
				}
				text = string(rs)
			}
			for range len(text) {
				pos = append(pos, at{col, row})
			}
			b.WriteString(text)
		}
	}
	text := b.String()
	for _, m := range urlPattern.FindAllStringIndex(text, -1) {
		end := trimURL(text[m[0]:m[1]]) + m[0]
		if end <= m[0] {
			continue
		}
		a, z := pos[m[0]], pos[end-1]
		if (y > a.y || (y == a.y && x >= a.x)) && (y < z.y || (y == z.y && x <= z.x)) {
			return Link{URI: text[m[0]:end], Span: Range{X0: a.x, Y0: a.y, X1: z.x, Y1: z.y}}, true
		}
	}
	return Link{}, false
}

// trimURL is the length of a URL found in text without the punctuation
// that ends a sentence or closes a bracket it did not open.
func trimURL(u string) int {
	n := len(u)
	for n > 0 {
		c := u[n-1]
		switch {
		case strings.IndexByte(".,;:!?'\"", c) >= 0:
			n--
			continue
		case c == ')' && strings.Count(u[:n], "(") < strings.Count(u[:n], ")"),
			c == ']' && strings.Count(u[:n], "[") < strings.Count(u[:n], "]"),
			c == '}' && strings.Count(u[:n], "{") < strings.Count(u[:n], "}"):
			n--
			continue
		}
		break
	}
	return n
}

// hyperlinkSpan is the run of cells around x, y that carry the same
// hyperlink, over soft-wrapped rows.
func (s *ghostty) hyperlinkSpan(uri string, x, y, total int) Link {
	same := func(cx, cy int) bool {
		r, err := s.screenRef(cx, cy)
		if err != nil {
			return false
		}
		u, err := r.HyperlinkURI()
		return err == nil && u == uri
	}
	x0, y0 := x, y
	for n := 0; n < 4096; n++ {
		px, py := x0-1, y0
		if px < 0 {
			px, py = s.cols-1, y0-1
		}
		if py < 0 || !same(px, py) {
			break
		}
		x0, y0 = px, py
	}
	x1, y1 := x, y
	for n := 0; n < 4096; n++ {
		nx, ny := x1+1, y1
		if nx >= s.cols {
			nx, ny = 0, y1+1
		}
		if ny >= total || !same(nx, ny) {
			break
		}
		x1, y1 = nx, ny
	}
	return Link{URI: uri, Span: Range{X0: x0, Y0: y0, X1: x1, Y1: y1}}
}
