package vt

import (
	"encoding/json"
	"fmt"
	"sync"
	"unicode/utf8"

	gt "go.mitchellh.com/libghostty"
)

// The default colours of a picture when the screen has none. A pane's
// terminal is given no default colours (the window that shows it brings
// its own theme), so libghostty reports white on black until a program
// sets them with OSC 10 and 11; a picture uses a fixed dark theme instead.
var (
	defaultBg = RGB{0x1d, 0x1f, 0x21}
	defaultFg = RGB{0xc5, 0xc8, 0xc6}
)

// Grid reads the visible rows through libghostty's render state. A call
// into libghostty costs far more than the work it does, so it reads each
// row's cells as one packed array and decodes them here, with the layout
// libghostty describes (cellLayout): the text of a one-codepoint cell, its
// width and its style id come from that array. libghostty is asked again
// only for a multi-codepoint cluster's text and once per distinct style of
// a row (style ids are only known to be the same style within a page, and
// a row is always in one page), and colours are resolved with the screen's
// palette here. A screen of plain text costs four calls per row.
func (s *ghostty) Grid() (*Grid, error) {
	// During a program's render hold this is the last frame it
	// finished, as on a screen.
	if _, err := s.update(); err != nil {
		return nil, err
	}
	g := &Grid{Cols: s.cols, Rows: s.rows, Fg: defaultFg, Bg: defaultBg, CursorStyle: "block"}
	if c, err := s.t.ColorForeground(); err == nil && c != nil {
		g.Fg, g.FgSet = rgb(*c), true
	}
	if c, err := s.t.ColorBackground(); err == nil && c != nil {
		g.Bg, g.BgSet = rgb(*c), true
	}
	if c, err := s.t.ColorCursor(); err == nil && c != nil {
		cc := rgb(*c)
		g.CursorColor = &cc
	}
	colors, err := s.rs.Colors()
	if err != nil {
		return nil, fmt.Errorf("vt: colours: %w", err)
	}
	pal := &colors.Palette
	for i := range g.PaletteSet {
		g.PaletteSet[i] = rgb(pal[i]) != s.defPal[i]
	}
	if cur, err := s.rs.Cursor(); err == nil {
		g.Cursor = Cursor{X: int(cur.ViewportX), Y: int(cur.ViewportY), Visible: cur.Visible && cur.ViewportHasValue}
		switch cur.VisualStyle {
		case gt.CursorStyleBar:
			g.CursorStyle = "bar"
		case gt.CursorStyleUnderline:
			g.CursorStyle = "underline"
		case gt.CursorStyleBlockHollow:
			g.CursorStyle = "block_hollow"
		}
	}
	lay := cellLayout()
	if slowGrid {
		lay = nil
	}
	if err := s.rs.RowIterator(s.ri); err != nil {
		return nil, fmt.Errorf("vt: row iterator: %w", err)
	}
	var rows [][]Cell
	styles := map[uint64]Cell{}
	for s.ri.Next() {
		if err := s.ri.Cells(s.rc); err != nil {
			return nil, fmt.Errorf("vt: row cells: %w", err)
		}
		view, err := s.ri.CellsRaw()
		if err != nil {
			return nil, fmt.Errorf("vt: row cells: %w", err)
		}
		clear(styles)
		row := newRow(s.cols)
		n := min(s.cols, view.Len())
		for x := 0; x < n; x++ {
			c := &row[x]
			v := view.Cell(x).PackedValue()
			if lay == nil {
				if err := s.slowCell(c, x); err != nil {
					return nil, err
				}
				continue
			}
			switch gt.CellWide(lay.wide.get(v)) {
			case gt.CellWideWide:
				c.Wide = true
			case gt.CellWideSpacerTail, gt.CellWideSpacerHead:
				c.Spacer = true
			}
			if id := lay.style.get(v); id != 0 {
				st, ok := styles[id]
				if !ok {
					if err := s.rc.Select(uint16(x)); err != nil {
						return nil, fmt.Errorf("vt: cell: %w", err)
					}
					sty, err := s.rc.Style()
					if err != nil {
						return nil, fmt.Errorf("vt: cell style: %w", err)
					}
					st = styleCell(sty, pal)
					styles[id] = st
				}
				c.Fg, c.HasFg, c.Bg, c.HasBg = st.Fg, st.HasFg, st.Bg, st.HasBg
				c.FgIndex, c.BgIndex = st.FgIndex, st.BgIndex
				c.Bold, c.Faint, c.Italic, c.Underline = st.Bold, st.Faint, st.Italic, st.Underline
				c.Strike, c.Inverse, c.Invisible = st.Strike, st.Inverse, st.Invisible
			}
			content := lay.content.get(v)
			switch gt.CellContentTag(lay.tag.get(v)) {
			case gt.CellContentCodepoint:
				if cp := rune(content & (1<<21 - 1)); cp != 0 && !c.Spacer && utf8.ValidRune(cp) {
					if cp < 128 {
						c.Text = ascii[cp]
					} else {
						c.Text = string(cp)
					}
				}
			case gt.CellContentCodepointGrapheme:
				if c.Spacer {
					break
				}
				if err := s.rc.Select(uint16(x)); err != nil {
					return nil, fmt.Errorf("vt: cell: %w", err)
				}
				b, err := s.rc.AppendGraphemes(s.buf[:0])
				if err != nil {
					return nil, fmt.Errorf("vt: cell text: %w", err)
				}
				s.buf = b
				c.Text = string(b)
			case gt.CellContentBgColorPalette:
				c.Bg, c.HasBg, c.BgIndex = rgb(pal[uint8(content)]), true, int16(uint8(content))
			case gt.CellContentBgColorRGB:
				c.Bg, c.HasBg = RGB{uint8(content), uint8(content >> 8), uint8(content >> 16)}, true
			}
		}
		rows = append(rows, row)
	}
	// The render state may hold rows above the screen (overscan): the last
	// s.rows rows are the visible ones.
	if len(rows) > s.rows {
		rows = rows[len(rows)-s.rows:]
	}
	for len(rows) < s.rows {
		rows = append(rows, newRow(s.cols))
	}
	g.Cells = rows
	return g, nil
}

// newRow is a row of empty cells, in the default colours.
func newRow(n int) []Cell {
	row := make([]Cell, n)
	for i := range row {
		row[i].FgIndex, row[i].BgIndex = -1, -1
	}
	return row
}

// slowCell reads one cell with a call per field, for a libghostty whose
// cell layout this code cannot read.
func (s *ghostty) slowCell(c *Cell, x int) error {
	if err := s.rc.Select(uint16(x)); err != nil {
		return fmt.Errorf("vt: cell: %w", err)
	}
	raw, err := s.rc.Raw()
	if err != nil {
		return fmt.Errorf("vt: cell: %w", err)
	}
	switch w, _ := raw.Wide(); w {
	case gt.CellWideWide:
		c.Wide = true
	case gt.CellWideSpacerTail, gt.CellWideSpacerHead:
		c.Spacer = true
	}
	var st gt.RenderCellStyle
	if err := s.rc.StyleInto(&st); err != nil {
		return fmt.Errorf("vt: cell style: %w", err)
	}
	if st.HasStyling {
		c.Bold, c.Faint, c.Italic = st.Bold, st.Faint, st.Italic
		c.Underline, c.Strike, c.Inverse = st.Underline, st.Strikethrough, st.Inverse
		if sty, err := s.rc.Style(); err == nil && sty != nil {
			c.Invisible = sty.Invisible()
		}
	}
	if st.HasForeground {
		c.Fg, c.HasFg = rgb(st.Foreground), true
	}
	if st.HasBackground {
		c.Bg, c.HasBg = rgb(st.Background), true
	}
	if sty, err := s.rc.Style(); err == nil && sty != nil {
		if fc := sty.FgColor(); fc.Tag == gt.StyleColorPalette {
			c.FgIndex = int16(fc.Palette)
		}
		if bc := sty.BgColor(); bc.Tag == gt.StyleColorPalette {
			c.BgIndex = int16(bc.Palette)
		}
	}
	if tag, err := raw.ContentTag(); err == nil && tag == gt.CellContentBgColorPalette {
		if i, err := raw.ColorPalette(); err == nil {
			c.BgIndex = int16(i)
		}
	}
	if c.Spacer {
		return nil
	}
	b, err := s.rc.AppendGraphemes(s.buf[:0])
	if err != nil {
		return fmt.Errorf("vt: cell text: %w", err)
	}
	s.buf = b
	c.Text = string(b)
	return nil
}

// styleCell resolves a style into a cell's look, palette colours through
// the screen's palette (which a program may have changed with OSC 4).
func styleCell(st *gt.Style, pal *gt.Palette) Cell {
	c := Cell{FgIndex: -1, BgIndex: -1}
	if st == nil {
		return c
	}
	resolve := func(sc gt.StyleColor) (RGB, bool, int16) {
		switch sc.Tag {
		case gt.StyleColorPalette:
			return rgb(pal[sc.Palette]), true, int16(sc.Palette)
		case gt.StyleColorRGB:
			return rgb(sc.RGB), true, -1
		}
		return RGB{}, false, -1
	}
	c.Fg, c.HasFg, c.FgIndex = resolve(st.FgColor())
	c.Bg, c.HasBg, c.BgIndex = resolve(st.BgColor())
	c.Bold, c.Faint, c.Italic = st.Bold(), st.Faint(), st.Italic()
	c.Underline = st.Underline() != gt.UnderlineNone
	c.Strike, c.Inverse, c.Invisible = st.Strikethrough(), st.Inverse(), st.Invisible()
	return c
}

// ascii holds the one-character strings, so a screen of text allocates
// none.
var ascii = func() (t [128]string) {
	for i := range t {
		t[i] = string(rune(i))
	}
	return
}()

// slowGrid makes Grid read a call per field, as it does when the layout
// cannot be read (tests compare the two).
var slowGrid = false

func rgb(c gt.ColorRGB) RGB { return RGB{c.R, c.G, c.B} }

// bitField is where a field sits in a packed value.
type bitField struct{ lsb, width uint }

func (f bitField) get(v uint64) uint64 { return v >> f.lsb & (1<<f.width - 1) }

type layout struct{ tag, content, style, wide, link bitField }

var (
	layoutOnce sync.Once
	layoutVal  *layout
)

// cellLayout reads where GhosttyCell keeps its fields, from the type
// description libghostty publishes (its packed layout is not a stable
// ABI, so it is never written down here). nil when it cannot be read: the
// grid is then read a call per field.
func cellLayout() *layout {
	layoutOnce.Do(func() { layoutVal = parseLayout(gt.TypeJSON()) })
	return layoutVal
}

func parseLayout(desc string) *layout {
	var d struct {
		Types map[string]struct {
			Kind       string `json:"kind"`
			Underlying string `json:"underlying"`
			Bits       map[string]struct {
				Lsb   uint `json:"lsb"`
				Width uint `json:"width"`
			} `json:"bits"`
		} `json:"types"`
	}
	if json.Unmarshal([]byte(desc), &d) != nil {
		return nil
	}
	t, ok := d.Types["GhosttyCell"]
	if !ok || t.Kind != "packed" || t.Underlying != "u64" {
		return nil
	}
	l := &layout{}
	for name, dst := range map[string]*bitField{"content_tag": &l.tag, "content": &l.content, "style_id": &l.style, "wide": &l.wide} {
		b, ok := t.Bits[name]
		if !ok || b.Width == 0 || b.Width > 32 || b.Lsb+b.Width > 64 {
			return nil
		}
		*dst = bitField{b.Lsb, b.Width}
	}
	if l.content.width < 24 {
		return nil
	}
	// The hyperlink flag is optional: without it, rows carry no links.
	if b, ok := t.Bits["hyperlink"]; ok && b.Width == 1 && b.Lsb < 64 {
		l.link = bitField{b.Lsb, b.Width}
	}
	return l
}
