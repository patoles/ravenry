package vt

import (
	"encoding/binary"
	"fmt"
	"time"
	"unicode/utf8"

	gt "go.mitchellh.com/libghostty"
)

// The render stream's view of the screen (docs/RENDERING.md): rows
// encoded in the stream's wire format, read through libghostty's render
// state, which reports the rows that changed since the last read.

// RenderInfo is what a render frame carries besides its rows.
type RenderInfo struct {
	Cols, Rows int
	// History is the number of scrollback rows above the screen.
	History int
	// Offset is how many rows the rows read are scrolled up from the
	// bottom (0: the live screen).
	Offset int
	Cursor RenderCursor
	// Modes is a set of Mode* bits.
	Modes  uint16
	Title  string
	Colors RenderColors
}

// RenderCursor is the cursor of a render frame.
type RenderCursor struct {
	X, Y int
	// InView: the cursor is on one of the rows read (not when scrolled
	// away from it). Visible: the program shows it (DECTCEM).
	InView, Visible, Blink, WideTail, Password bool
	// Style is CursorBlock, CursorBar, CursorUnderline or CursorHollow.
	Style uint8
}

// Cursor styles of a render frame.
const (
	CursorBlock uint8 = iota
	CursorBar
	CursorUnderline
	CursorHollow
)

// Mode bits of a render frame: what a client needs to know of the
// program's modes. Keys, mouse reports and pastes are encoded by the
// daemon, so a client only needs to know whether to send them.
const (
	// ModeMouse: the program reports mouse clicks (modes 9, 1000, 1002,
	// 1003): clicks and wheel go to it, not to a selection.
	ModeMouse uint16 = 1 << iota
	// ModeMouseDrag: it also wants motion while a button is down (1002).
	ModeMouseDrag
	// ModeMouseMotion: it wants every motion (1003).
	ModeMouseMotion
	// ModeBracketedPaste: mode 2004.
	ModeBracketedPaste
	// ModeAltScreen: the alternate screen is active; it has no scrollback.
	ModeAltScreen
	// ModeFocus: the program wants focus in and out reports (1004).
	ModeFocus
	// ModeAppCursor: application cursor keys (DECCKM), for a client that
	// wants to know; the daemon encodes keys itself.
	ModeAppCursor
	// ModeAltScroll: on the alternate screen, the wheel is arrow keys
	// (mode 1007, on unless the program turned it off), as in Ghostty.
	ModeAltScroll
)

// RenderColors are the colours a program set. A client draws with its own
// theme and uses these where they are set.
type RenderColors struct {
	Fg, Bg, Cursor          RGB
	FgSet, BgSet, CursorSet bool
	// Palette lists the palette entries the program changed (OSC 4).
	Palette []PaletteEntry
}

// PaletteEntry is one changed palette entry.
type PaletteEntry struct {
	Index uint8
	Color RGB
}

// Wire layout of a row's style (RENDERING.md, Rows).
const styleSize = 16

// Attribute bits of a style.
const (
	attrBold uint16 = 1 << iota
	attrFaint
	attrItalic
	attrBlink
	attrInverse
	attrInvisible
	attrStrike
	attrOverline
)

// renderHoldMax is how long a program may hold the screen with
// synchronized output before the hold is ended for it, as Ghostty does.
const renderHoldMax = time.Second

var (
	modeMouseX10    = gt.NewMode(9, false)
	modeMouseNormal = gt.NewMode(1000, false)
	modeMouseButton = gt.NewMode(1002, false)
	modeMouseAny    = gt.NewMode(1003, false)
	modeFocus       = gt.NewMode(1004, false)
	modeBracketed   = gt.NewMode(2004, false)
	modeAppCursor   = gt.NewMode(1, false)
	modeSync        = gt.NewMode(2026, false)
	modeAltScroll   = gt.NewMode(1007, false)
)

// onRenderHold is libghostty's render hold callback: synchronized output
// started or ended. At the start, the terminal holds exactly the last
// frame the program finished, and the render state takes it then; it is
// not updated again until the hold ends.
func (s *ghostty) onRenderHold(held bool) {
	if held && !s.held {
		s.rs.Update(s.t)
		s.heldAt = time.Now()
	}
	s.held = held
}

// update brings the render state up to date, except during a render
// hold, which it ends after renderHoldMax. It reports whether the state
// is held.
func (s *ghostty) update() (bool, error) {
	if s.held && time.Since(s.heldAt) >= renderHoldMax {
		s.t.SetMode(modeSync, false)
		s.held = false
	}
	if s.held {
		return true, nil
	}
	if err := s.rs.Update(s.t); err != nil {
		return false, fmt.Errorf("vt: render state: %w", err)
	}
	return false, nil
}

// Held reports whether the program holds the screen (synchronized
// output), and since when.
func (s *ghostty) Held() (bool, time.Time) { return s.held, s.heldAt }

// AtPrompt reports whether the cursor is at a shell prompt: a resize then
// clears the prompt for the shell to draw it again.
func (s *ghostty) AtPrompt() bool {
	ok, err := s.t.CursorAtPrompt()
	return err == nil && ok
}

func (s *ghostty) Render(all bool, row func(y int, wrap bool, data []byte)) (RenderInfo, bool, error) {
	held, err := s.update()
	if err != nil {
		return RenderInfo{}, false, err
	}
	info, err := s.renderInfo(s.rs, 0)
	if err != nil {
		return info, held, err
	}
	dirty, err := s.rs.Dirty()
	if err != nil {
		return info, held, fmt.Errorf("vt: render state: %w", err)
	}
	if dirty == gt.RenderStateDirtyFalse && !all {
		return info, held, nil
	}
	if err := s.renderRows(s.rs, all || dirty == gt.RenderStateDirtyFull, row); err != nil {
		return info, held, err
	}
	// Grid reads every row and never needs the dirty flags: this is
	// their only reader.
	if err := s.rs.Clean(); err != nil {
		return info, held, fmt.Errorf("vt: render state: %w", err)
	}
	return info, held, nil
}

func (s *ghostty) RenderAt(offset int, row func(y int, wrap bool, data []byte)) (RenderInfo, error) {
	if s.hs == nil {
		hs, err := gt.NewRenderState()
		if err != nil {
			return RenderInfo{}, fmt.Errorf("vt: render state: %w", err)
		}
		s.hs = hs
	}
	// Only one render state may take the terminal's dirty flags: move
	// what changed into the live one first, so it still sees it.
	if _, err := s.update(); err != nil {
		return RenderInfo{}, err
	}
	sb, err := s.t.Scrollbar()
	if err != nil {
		return RenderInfo{}, fmt.Errorf("vt: scrollbar: %w", err)
	}
	history := int(sb.Total) - int(sb.Len)
	offset = max(0, min(offset, history))
	if err := s.t.ScrollViewportRow(uint(history - offset)); err != nil {
		return RenderInfo{}, fmt.Errorf("vt: scroll: %w", err)
	}
	err = s.hs.Update(s.t)
	if serr := s.t.ScrollViewportBottom(); err == nil && serr != nil {
		err = serr
	}
	if err != nil {
		return RenderInfo{}, fmt.Errorf("vt: render state: %w", err)
	}
	info, err := s.renderInfo(s.hs, offset)
	if err != nil {
		return info, err
	}
	info.History = history
	s.linkTop = history - offset
	err = s.renderRows(s.hs, true, row)
	s.linkTop = -1
	return info, err
}

// renderInfo reads the cursor, modes, colours and title.
func (s *ghostty) renderInfo(rs *gt.RenderState, offset int) (RenderInfo, error) {
	info := RenderInfo{Cols: s.cols, Rows: s.rows, Offset: offset, Title: s.title}
	if sb, err := s.t.Scrollbar(); err == nil {
		info.History = int(sb.Total) - int(sb.Len)
	}
	if cur, err := rs.Cursor(); err == nil {
		info.Cursor = RenderCursor{
			X: int(cur.ViewportX), Y: int(cur.ViewportY),
			InView: cur.ViewportHasValue, Visible: cur.Visible, Blink: cur.Blinking,
			WideTail: cur.WideTail, Password: cur.PasswordInput,
		}
		switch cur.VisualStyle {
		case gt.CursorStyleBar:
			info.Cursor.Style = CursorBar
		case gt.CursorStyleUnderline:
			info.Cursor.Style = CursorUnderline
		case gt.CursorStyleBlockHollow:
			info.Cursor.Style = CursorHollow
		}
	}
	mode := func(m gt.Mode, bit uint16) {
		if on, err := s.t.Mode(m); err == nil && on {
			info.Modes |= bit
		}
	}
	mode(modeMouseX10, ModeMouse)
	mode(modeMouseNormal, ModeMouse)
	mode(modeMouseButton, ModeMouse|ModeMouseDrag)
	mode(modeMouseAny, ModeMouse|ModeMouseDrag|ModeMouseMotion)
	mode(modeFocus, ModeFocus)
	mode(modeBracketed, ModeBracketedPaste)
	mode(modeAppCursor, ModeAppCursor)
	mode(modeAltScroll, ModeAltScroll)
	if scr, err := s.t.ActiveScreen(); err == nil && scr == gt.ScreenAlternate {
		info.Modes |= ModeAltScreen
	}
	c := &info.Colors
	if v, err := s.t.ColorForeground(); err == nil && v != nil {
		c.Fg, c.FgSet = rgb(*v), true
	}
	if v, err := s.t.ColorBackground(); err == nil && v != nil {
		c.Bg, c.BgSet = rgb(*v), true
	}
	if v, err := s.t.ColorCursor(); err == nil && v != nil {
		c.Cursor, c.CursorSet = rgb(*v), true
	}
	if colors, err := rs.Colors(); err == nil {
		for i := range colors.Palette {
			if v := rgb(colors.Palette[i]); v != s.defPal256[i] {
				c.Palette = append(c.Palette, PaletteEntry{uint8(i), v})
			}
		}
	}
	return info, nil
}

// renderRows encodes the rows of rs that are dirty, or all of them.
func (s *ghostty) renderRows(rs *gt.RenderState, all bool, row func(y int, wrap bool, data []byte)) error {
	if err := rs.RowIterator(s.ri); err != nil {
		return fmt.Errorf("vt: row iterator: %w", err)
	}
	nrows, err := rs.Rows()
	if err != nil {
		return fmt.Errorf("vt: render state: %w", err)
	}
	// Rows above the screen (overscan) come first: skip them.
	skip := 0
	if ov, err := rs.Overscan(); err == nil {
		skip = int(ov.Above)
	}
	_ = nrows
	y := -1
	for s.ri.Next() {
		y++
		if y < skip {
			continue
		}
		if !all {
			d, err := s.ri.Dirty()
			if err != nil {
				return fmt.Errorf("vt: row: %w", err)
			}
			if !d {
				continue
			}
		}
		wrap := false
		if raw, err := s.ri.Raw(); err == nil {
			wrap, _ = raw.Wrap()
		}
		b, err := s.encodeRow(y-skip, s.rbuf[:0])
		if err != nil {
			return err
		}
		s.rbuf = b
		if y-skip < s.rows {
			row(y-skip, wrap, b)
		}
	}
	return nil
}

// encodeRow encodes the iterator's row: runs of cells that share a
// style, trailing empty cells left out (RENDERING.md, Rows).
func (s *ghostty) encodeRow(y int, dst []byte) ([]byte, error) {
	if err := s.ri.Cells(s.rc); err != nil {
		return nil, fmt.Errorf("vt: row cells: %w", err)
	}
	view, err := s.ri.CellsRaw()
	if err != nil {
		return nil, fmt.Errorf("vt: row cells: %w", err)
	}
	lay := cellLayout()
	n := min(s.cols, view.Len())
	// The row's extent: the last cell that is not empty in the default
	// style.
	end := 0
	for x := n - 1; x >= 0; x-- {
		v := view.Cell(x).PackedValue()
		if lay == nil || !emptyCell(lay, v) {
			end = x + 1
			break
		}
	}
	clear(s.rstyles)
	var cur [styleSize]byte
	runAt := -1 // where the current run's count is
	count := 0
	for x := 0; x < end; x++ {
		v := view.Cell(x).PackedValue()
		var st [styleSize]byte
		var text []byte
		var wide, spacer bool
		if lay == nil {
			if st, text, wide, spacer, err = s.slowRenderCell(x); err != nil {
				return nil, err
			}
		} else {
			switch gt.CellWide(lay.wide.get(v)) {
			case gt.CellWideWide:
				wide = true
			case gt.CellWideSpacerTail, gt.CellWideSpacerHead:
				spacer = true
			}
			if id := lay.style.get(v); id != 0 {
				var ok bool
				if st, ok = s.rstyles[id]; !ok {
					if err := s.rc.Select(uint16(x)); err != nil {
						return nil, fmt.Errorf("vt: cell: %w", err)
					}
					sty, err := s.rc.Style()
					if err != nil {
						return nil, fmt.Errorf("vt: cell style: %w", err)
					}
					st = wireStyle(sty)
					s.rstyles[id] = st
				}
			}
			content := lay.content.get(v)
			switch gt.CellContentTag(lay.tag.get(v)) {
			case gt.CellContentCodepoint:
				if cp := rune(content & (1<<21 - 1)); cp != 0 && !spacer && utf8.ValidRune(cp) {
					text = utf8.AppendRune(s.tbuf[:0], cp)
				}
			case gt.CellContentCodepointGrapheme:
				if !spacer {
					if err := s.rc.Select(uint16(x)); err != nil {
						return nil, fmt.Errorf("vt: cell: %w", err)
					}
					b, err := s.rc.AppendGraphemes(s.tbuf[:0])
					if err != nil {
						return nil, fmt.Errorf("vt: cell text: %w", err)
					}
					s.tbuf = b
					text = b
				}
			case gt.CellContentBgColorPalette:
				st[4], st[5] = 1, uint8(content)
			case gt.CellContentBgColorRGB:
				st[4], st[5], st[6], st[7] = 2, uint8(content), uint8(content>>8), uint8(content>>16)
			}
			if lay.link.width > 0 && lay.link.get(v) != 0 {
				binary.BigEndian.PutUint16(st[14:], s.linkID(y, x))
			}
		}
		if runAt < 0 || st != cur || count == 0xffff {
			if runAt >= 0 {
				binary.BigEndian.PutUint16(dst[runAt:], uint16(count))
			}
			dst = append(dst, st[:]...)
			runAt = len(dst)
			dst = append(dst, 0, 0)
			cur, count = st, 0
		}
		count++
		switch {
		case spacer:
			dst = append(dst, 0xff)
		case len(text) == 0:
			dst = append(dst, 0)
		default:
			if len(text) > 0x7f {
				text = text[:lastRuneStart(text, 0x7f)]
			}
			b := byte(len(text))
			if wide {
				b |= 0x80
			}
			dst = append(dst, b)
			dst = append(dst, text...)
		}
	}
	if runAt >= 0 {
		binary.BigEndian.PutUint16(dst[runAt:], uint16(count))
	}
	return dst, nil
}

// lastRuneStart is the largest length up to n that ends on a whole rune.
func lastRuneStart(b []byte, n int) int {
	for n > 0 && !utf8.RuneStart(b[n]) {
		n--
	}
	return n
}

// emptyCell: a cell with no text, no style and no colour.
func emptyCell(lay *layout, v uint64) bool {
	if lay.style.get(v) != 0 || gt.CellWide(lay.wide.get(v)) != gt.CellWideNarrow {
		return false
	}
	switch gt.CellContentTag(lay.tag.get(v)) {
	case gt.CellContentCodepoint:
		return lay.content.get(v)&(1<<21-1) == 0
	}
	return false
}

// slowRenderCell reads one cell with a call per field, for a libghostty
// whose cell layout this code cannot read.
func (s *ghostty) slowRenderCell(x int) (st [styleSize]byte, text []byte, wide, spacer bool, err error) {
	if err = s.rc.Select(uint16(x)); err != nil {
		return st, nil, false, false, fmt.Errorf("vt: cell: %w", err)
	}
	raw, err := s.rc.Raw()
	if err != nil {
		return st, nil, false, false, fmt.Errorf("vt: cell: %w", err)
	}
	switch w, _ := raw.Wide(); w {
	case gt.CellWideWide:
		wide = true
	case gt.CellWideSpacerTail, gt.CellWideSpacerHead:
		spacer = true
	}
	if sty, err := s.rc.Style(); err == nil && sty != nil {
		st = wireStyle(sty)
	}
	switch tag, _ := raw.ContentTag(); tag {
	case gt.CellContentBgColorPalette:
		i, _ := raw.ColorPalette()
		st[4], st[5] = 1, i
	case gt.CellContentBgColorRGB:
		c, _ := raw.ColorRGB()
		st[4], st[5], st[6], st[7] = 2, c.R, c.G, c.B
	}
	if !spacer {
		b, err := s.rc.AppendGraphemes(s.tbuf[:0])
		if err != nil {
			return st, nil, false, false, fmt.Errorf("vt: cell text: %w", err)
		}
		s.tbuf = b
		text = b
	}
	return st, text, wide, spacer, nil
}

// wireStyle encodes a style: foreground, background and underline colour
// (kind, then the index or R, G, B), attributes, link id (set by the
// caller).
func wireStyle(st *gt.Style) (w [styleSize]byte) {
	if st == nil {
		return w
	}
	color := func(dst []byte, c gt.StyleColor) {
		switch c.Tag {
		case gt.StyleColorPalette:
			dst[0], dst[1] = 1, c.Palette
		case gt.StyleColorRGB:
			dst[0], dst[1], dst[2], dst[3] = 2, c.RGB.R, c.RGB.G, c.RGB.B
		}
	}
	color(w[0:4], st.FgColor())
	color(w[4:8], st.BgColor())
	color(w[8:12], st.UnderlineColor())
	var a uint16
	for _, f := range []struct {
		on  bool
		bit uint16
	}{
		{st.Bold(), attrBold}, {st.Faint(), attrFaint}, {st.Italic(), attrItalic}, {st.Blink(), attrBlink},
		{st.Inverse(), attrInverse}, {st.Invisible(), attrInvisible}, {st.Strikethrough(), attrStrike}, {st.Overline(), attrOverline},
	} {
		if f.on {
			a |= f.bit
		}
	}
	a |= uint16(underlineKind(st.Underline())) << 8
	binary.BigEndian.PutUint16(w[12:], a)
	return w
}

// underlineKind maps an underline style to its wire value: 0 none, 1
// single, 2 double, 3 curly, 4 dotted, 5 dashed.
func underlineKind(u gt.SGRUnderline) uint8 {
	switch u {
	case gt.UnderlineSingle:
		return 1
	case gt.UnderlineDouble:
		return 2
	case gt.UnderlineCurly:
		return 3
	case gt.UnderlineDotted:
		return 4
	case gt.UnderlineDashed:
		return 5
	}
	return 0
}

// linkID returns the id of the hyperlink (OSC 8) of a viewport cell: the
// same URI keeps its id for the screen's life (RENDERING.md, Links).
func (s *ghostty) linkID(y, x int) uint16 {
	pt := gt.Point{Tag: gt.PointTagViewport, X: uint16(x), Y: uint32(y)}
	if s.linkTop >= 0 {
		// A row of the scrollback: the viewport is back at the bottom.
		pt = gt.Point{Tag: gt.PointTagScreen, X: uint16(x), Y: uint32(s.linkTop + y)}
	}
	ref, err := s.t.GridRef(pt)
	if err != nil {
		return 0
	}
	uri, err := ref.HyperlinkURI()
	if err != nil || uri == "" {
		return 0
	}
	if id, ok := s.linkIDs[uri]; ok {
		return id
	}
	if len(s.links) >= 0xfffe {
		// Very many distinct links: start again. A client keeps the
		// URIs a frame sends, so an id reused here comes with its URI.
		s.links, s.linkIDs = s.links[:0], map[string]uint16{}
	}
	s.links = append(s.links, uri)
	id := uint16(len(s.links))
	s.linkIDs[uri] = id
	return id
}

// LinkURI returns the URI of a hyperlink id from a rendered row.
func (s *ghostty) LinkURI(id uint16) string {
	if id == 0 || int(id) > len(s.links) {
		return ""
	}
	return s.links[id-1]
}

// TextRange returns the text between two points of the screen, inclusive,
// in screen coordinates (row 0 is the oldest row of the scrollback):
// soft-wrapped rows are joined and trailing spaces trimmed, as a copy.
func (s *ghostty) TextRange(x0, y0, x1, y1 int, rect bool) (string, error) {
	if y1 < y0 || (y1 == y0 && x1 < x0) {
		x0, y0, x1, y1 = x1, y1, x0, y0
	}
	clampX := func(x int) uint16 { return uint16(max(0, min(x, s.cols-1))) }
	a, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, X: clampX(x0), Y: uint32(max(0, y0))})
	if err != nil {
		return "", fmt.Errorf("vt: text range start: %w", err)
	}
	b, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, X: clampX(x1), Y: uint32(max(0, y1))})
	if err != nil {
		return "", fmt.Errorf("vt: text range end: %w", err)
	}
	sel := &gt.Selection{Start: *a, End: *b, Rectangle: rect}
	f, err := gt.NewFormatter(s.t,
		gt.WithFormatterFormat(gt.FormatterFormatPlain),
		gt.WithFormatterTrim(true),
		gt.WithFormatterUnwrap(true),
		gt.WithFormatterSelection(sel),
	)
	if err != nil {
		return "", fmt.Errorf("vt: formatter: %w", err)
	}
	defer f.Close()
	return f.FormatString()
}
