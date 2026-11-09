// Package rframe is the render stream's frame format (docs/RENDERING.md):
// the daemon encodes frames of a pane's screen with it, and a client
// written in Go, or a test, decodes them. The layout is written down in
// RENDERING.md; this package is its reference implementation.
package rframe

import (
	"encoding/binary"
	"errors"
	"fmt"

	"ravenryd/internal/vt"
)

// Version is the frame format's version, the payload's first byte. A
// client refuses a frame of a version it does not know.
const Version = 1

// HeaderSize is the size of a frame's fixed header.
const HeaderSize = 30

// Header flags.
const (
	// FlagFull: the frame carries every row; a client clears the rows it
	// has before taking them.
	FlagFull uint8 = 1 << iota
	// FlagHeld: the program holds the screen (synchronized output) and
	// this frame is the last one it finished.
	FlagHeld
)

// Cursor flags.
const (
	CursorInView uint8 = 1 << iota
	CursorVisible
	CursorBlink
	CursorWideTail
	CursorPassword
)

// Section tags.
const (
	TagTitle  = 1
	TagColors = 2
	TagLinks  = 3
	TagRows   = 4
	// TagSelection: the selection, in screen coordinates.
	TagSelection = 5
	// TagFind: a search's count, its selected match and the matches on
	// the frame's rows.
	TagFind = 6
)

// Frame is one render frame.
type Frame struct {
	Seq             uint32
	Flags           uint8
	Cols, Rows      int
	History, Offset int
	Cursor          vt.RenderCursor
	Modes           uint16
	Bell            uint32
	// Title and Colors are sent in a full frame and when they change.
	Title  *string
	Colors *vt.RenderColors
	// Links are the hyperlinks the rows use that the client was not sent
	// before.
	Links []Link
	// Lines are the rows that changed (all of them in a full frame).
	Lines []Row
	// Selection is sent in a full frame and when it changes; Set false
	// is no selection.
	Selection *Selection
	// Find is sent in a full frame and when it changes, while a search
	// runs on the stream; Active false ends it.
	Find *Find
}

// Selection is the pane's selection.
type Selection struct {
	Set   bool
	Range vt.Range
}

// Find is a search's state on a stream.
type Find struct {
	Active bool
	// Count is the number of matches; Selected the index of the one
	// selected, from the newest, or -1.
	Count, Selected int
	// Current is the selected match, when it is on the frame's rows.
	// Matches are the others on the frame's rows.
	Current *vt.Range
	Matches []vt.Range
}

// Link is a hyperlink id and its URI.
type Link struct {
	ID  uint16
	URI string
}

// Row is one encoded row.
type Row struct {
	Y    int
	Wrap bool
	Data []byte
}

// Append encodes f after dst.
func (f *Frame) Append(dst []byte) []byte {
	be := binary.BigEndian
	dst = append(dst, Version, f.Flags)
	dst = be.AppendUint32(dst, f.Seq)
	dst = be.AppendUint16(dst, uint16(f.Cols))
	dst = be.AppendUint16(dst, uint16(f.Rows))
	dst = be.AppendUint32(dst, uint32(f.History))
	dst = be.AppendUint32(dst, uint32(f.Offset))
	c := f.Cursor
	dst = be.AppendUint16(dst, uint16(max(c.X, 0)))
	dst = be.AppendUint16(dst, uint16(max(c.Y, 0)))
	var cf uint8
	for _, b := range []struct {
		on  bool
		bit uint8
	}{{c.InView, CursorInView}, {c.Visible, CursorVisible}, {c.Blink, CursorBlink}, {c.WideTail, CursorWideTail}, {c.Password, CursorPassword}} {
		if b.on {
			cf |= b.bit
		}
	}
	dst = append(dst, cf, c.Style)
	dst = be.AppendUint16(dst, f.Modes)
	dst = be.AppendUint32(dst, f.Bell)
	section := func(tag byte, body func([]byte) []byte) {
		dst = append(dst, tag, 0, 0, 0, 0)
		at := len(dst)
		dst = body(dst)
		be.PutUint32(dst[at-4:], uint32(len(dst)-at))
	}
	if f.Title != nil {
		section(TagTitle, func(b []byte) []byte { return append(b, *f.Title...) })
	}
	if f.Colors != nil {
		section(TagColors, func(b []byte) []byte {
			cl := f.Colors
			var set uint8
			if cl.FgSet {
				set |= 1
			}
			if cl.BgSet {
				set |= 2
			}
			if cl.CursorSet {
				set |= 4
			}
			b = append(b, set, cl.Fg.R, cl.Fg.G, cl.Fg.B, cl.Bg.R, cl.Bg.G, cl.Bg.B, cl.Cursor.R, cl.Cursor.G, cl.Cursor.B)
			b = be.AppendUint16(b, uint16(len(cl.Palette)))
			for _, e := range cl.Palette {
				b = append(b, e.Index, e.Color.R, e.Color.G, e.Color.B)
			}
			return b
		})
	}
	if len(f.Links) > 0 {
		section(TagLinks, func(b []byte) []byte {
			b = be.AppendUint16(b, uint16(len(f.Links)))
			for _, l := range f.Links {
				uri := l.URI
				if len(uri) > 0xffff {
					uri = uri[:0xffff]
				}
				b = be.AppendUint16(b, l.ID)
				b = be.AppendUint16(b, uint16(len(uri)))
				b = append(b, uri...)
			}
			return b
		})
	}
	appendRange := func(b []byte, r vt.Range) []byte {
		b = be.AppendUint16(b, uint16(max(r.X0, 0)))
		b = be.AppendUint32(b, uint32(max(r.Y0, 0)))
		b = be.AppendUint16(b, uint16(max(r.X1, 0)))
		return be.AppendUint32(b, uint32(max(r.Y1, 0)))
	}
	if sel := f.Selection; sel != nil {
		section(TagSelection, func(b []byte) []byte {
			var fl uint8
			if sel.Set {
				fl |= 1
			}
			if sel.Range.Rect {
				fl |= 2
			}
			return appendRange(append(b, fl), sel.Range)
		})
	}
	if fd := f.Find; fd != nil {
		section(TagFind, func(b []byte) []byte {
			var fl uint8
			if fd.Active {
				fl |= 1
			}
			if fd.Current != nil {
				fl |= 2
			}
			b = append(b, fl)
			b = be.AppendUint32(b, uint32(fd.Count))
			b = be.AppendUint32(b, uint32(int32(fd.Selected)))
			if fd.Current != nil {
				b = appendRange(b, *fd.Current)
			}
			n := min(len(fd.Matches), 0xffff)
			b = be.AppendUint16(b, uint16(n))
			for _, m := range fd.Matches[:n] {
				b = appendRange(b, m)
			}
			return b
		})
	}
	if len(f.Lines) > 0 {
		section(TagRows, func(b []byte) []byte {
			b = be.AppendUint16(b, uint16(len(f.Lines)))
			for _, r := range f.Lines {
				b = be.AppendUint16(b, uint16(r.Y))
				var fl uint8
				if r.Wrap {
					fl |= 1
				}
				b = append(b, fl)
				b = be.AppendUint32(b, uint32(len(r.Data)))
				b = append(b, r.Data...)
			}
			return b
		})
	}
	return dst
}

var errShort = errors.New("rframe: frame is cut short")

// Decode reads a frame. Its rows' Data point into b.
func Decode(b []byte) (*Frame, error) {
	if len(b) < HeaderSize {
		return nil, errShort
	}
	if b[0] != Version {
		return nil, fmt.Errorf("rframe: format version %d, not %d", b[0], Version)
	}
	be := binary.BigEndian
	f := &Frame{
		Flags: b[1], Seq: be.Uint32(b[2:]),
		Cols: int(be.Uint16(b[6:])), Rows: int(be.Uint16(b[8:])),
		History: int(be.Uint32(b[10:])), Offset: int(be.Uint32(b[14:])),
		Modes: be.Uint16(b[24:]), Bell: be.Uint32(b[26:]),
	}
	cf := b[22]
	f.Cursor = vt.RenderCursor{
		X: int(be.Uint16(b[18:])), Y: int(be.Uint16(b[20:])),
		InView: cf&CursorInView != 0, Visible: cf&CursorVisible != 0, Blink: cf&CursorBlink != 0,
		WideTail: cf&CursorWideTail != 0, Password: cf&CursorPassword != 0, Style: b[23],
	}
	p := b[HeaderSize:]
	for len(p) > 0 {
		if len(p) < 5 {
			return nil, errShort
		}
		tag, n := p[0], int(be.Uint32(p[1:]))
		if len(p) < 5+n {
			return nil, errShort
		}
		body := p[5 : 5+n]
		p = p[5+n:]
		switch tag {
		case TagTitle:
			t := string(body)
			f.Title = &t
		case TagColors:
			if len(body) < 12 {
				return nil, errShort
			}
			c := &vt.RenderColors{
				FgSet: body[0]&1 != 0, BgSet: body[0]&2 != 0, CursorSet: body[0]&4 != 0,
				Fg: vt.RGB{R: body[1], G: body[2], B: body[3]}, Bg: vt.RGB{R: body[4], G: body[5], B: body[6]},
				Cursor: vt.RGB{R: body[7], G: body[8], B: body[9]},
			}
			n := int(be.Uint16(body[10:]))
			if len(body) < 12+4*n {
				return nil, errShort
			}
			for i := range n {
				e := body[12+4*i:]
				c.Palette = append(c.Palette, vt.PaletteEntry{Index: e[0], Color: vt.RGB{R: e[1], G: e[2], B: e[3]}})
			}
			f.Colors = c
		case TagLinks:
			if len(body) < 2 {
				return nil, errShort
			}
			n, q := int(be.Uint16(body)), body[2:]
			for range n {
				if len(q) < 4 {
					return nil, errShort
				}
				id, l := be.Uint16(q), int(be.Uint16(q[2:]))
				if len(q) < 4+l {
					return nil, errShort
				}
				f.Links = append(f.Links, Link{ID: id, URI: string(q[4 : 4+l])})
				q = q[4+l:]
			}
		case TagSelection:
			if len(body) < 13 {
				return nil, errShort
			}
			r := readRange(body[1:])
			r.Rect = body[0]&2 != 0
			f.Selection = &Selection{Set: body[0]&1 != 0, Range: r}
		case TagFind:
			if len(body) < 11 {
				return nil, errShort
			}
			fd := &Find{Active: body[0]&1 != 0, Count: int(be.Uint32(body[1:])), Selected: int(int32(be.Uint32(body[5:])))}
			q := body[9:]
			if body[0]&2 != 0 {
				if len(q) < 12 {
					return nil, errShort
				}
				r := readRange(q)
				fd.Current = &r
				q = q[12:]
			}
			if len(q) < 2 {
				return nil, errShort
			}
			n := int(be.Uint16(q))
			q = q[2:]
			if len(q) < 12*n {
				return nil, errShort
			}
			for i := range n {
				fd.Matches = append(fd.Matches, readRange(q[12*i:]))
			}
			f.Find = fd
		case TagRows:
			if len(body) < 2 {
				return nil, errShort
			}
			n, q := int(be.Uint16(body)), body[2:]
			for range n {
				if len(q) < 7 {
					return nil, errShort
				}
				y, fl, l := int(be.Uint16(q)), q[2], int(be.Uint32(q[3:]))
				if len(q) < 7+l {
					return nil, errShort
				}
				f.Lines = append(f.Lines, Row{Y: y, Wrap: fl&1 != 0, Data: q[7 : 7+l]})
				q = q[7+l:]
			}
		}
		// Other tags are newer additions: skipped.
	}
	return f, nil
}

// readRange reads a range: x0 (2 bytes), y0 (4), x1 (2), y1 (4).
func readRange(b []byte) vt.Range {
	be := binary.BigEndian
	return vt.Range{X0: int(be.Uint16(b)), Y0: int(be.Uint32(b[2:])), X1: int(be.Uint16(b[6:])), Y1: int(be.Uint32(b[8:]))}
}

// Color is a cell colour: Kind 0 the default, 1 a palette entry (Index),
// 2 direct (R, G, B).
type Color struct {
	Kind, Index, R, G, B uint8
}

// Style is a run's look.
type Style struct {
	Fg, Bg, Underline Color
	// Attrs holds the Attr* bits; UnderlineStyle is 0 none, 1 single,
	// 2 double, 3 curly, 4 dotted, 5 dashed.
	Attrs          uint16
	UnderlineStyle uint8
	Link           uint16
}

// Attribute bits of a Style.
const (
	AttrBold uint16 = 1 << iota
	AttrFaint
	AttrItalic
	AttrBlink
	AttrInverse
	AttrInvisible
	AttrStrike
	AttrOverline
)

// Cell is one decoded cell.
type Cell struct {
	// Text is the grapheme cluster, or "" for an empty cell.
	Text string
	// Wide covers this cell and the next; Spacer is that next cell.
	Wide, Spacer bool
	Style        Style
}

func decodeColor(b []byte) Color {
	switch b[0] {
	case 1:
		return Color{Kind: 1, Index: b[1]}
	case 2:
		return Color{Kind: 2, R: b[1], G: b[2], B: b[3]}
	}
	return Color{}
}

// DecodeRow reads a row's cells; cells past the row's data are empty, in
// the default style, up to cols.
func DecodeRow(data []byte, cols int) ([]Cell, error) {
	cells := make([]Cell, 0, cols)
	be := binary.BigEndian
	for len(data) > 0 {
		if len(data) < 18 {
			return nil, errShort
		}
		a := be.Uint16(data[12:])
		st := Style{
			Fg: decodeColor(data[0:4]), Bg: decodeColor(data[4:8]), Underline: decodeColor(data[8:12]),
			Attrs: a & 0xff, UnderlineStyle: uint8(a >> 8 & 7), Link: be.Uint16(data[14:]),
		}
		n := int(be.Uint16(data[16:]))
		data = data[18:]
		for range n {
			if len(data) < 1 {
				return nil, errShort
			}
			c := Cell{Style: st}
			b := data[0]
			data = data[1:]
			switch {
			case b == 0xff:
				c.Spacer = true
			case b != 0:
				l := int(b & 0x7f)
				c.Wide = b&0x80 != 0
				if len(data) < l {
					return nil, errShort
				}
				c.Text = string(data[:l])
				data = data[l:]
			}
			cells = append(cells, c)
		}
	}
	for len(cells) < cols {
		cells = append(cells, Cell{})
	}
	return cells, nil
}

// RowText is a decoded row's text, a space for each empty cell, trailing
// spaces removed.
func RowText(cells []Cell) string {
	var b []byte
	for _, c := range cells {
		switch {
		case c.Spacer:
		case c.Text == "":
			b = append(b, ' ')
		default:
			b = append(b, c.Text...)
		}
	}
	for len(b) > 0 && b[len(b)-1] == ' ' {
		b = b[:len(b)-1]
	}
	return string(b)
}

// Screen is a client's copy of the screen, built from frames: what a
// client that draws keeps, and what tests compare with the daemon's.
type Screen struct {
	Cols, Rows      int
	History, Offset int
	Cursor          vt.RenderCursor
	Modes           uint16
	Title           string
	Colors          vt.RenderColors
	Links           map[uint16]string
	Lines           [][]Cell
	Wraps           []bool
	Seq             uint32
	Selection       Selection
	Find            Find
}

// Apply takes a frame into the screen.
func (s *Screen) Apply(f *Frame) error {
	if f.Cols != s.Cols || f.Rows != s.Rows || f.Flags&FlagFull != 0 {
		s.Cols, s.Rows = f.Cols, f.Rows
		lines := make([][]Cell, f.Rows)
		for y := range lines {
			if f.Flags&FlagFull == 0 && y < len(s.Lines) {
				// A new size without a full frame: keep what fits until
				// the rows come.
				lines[y] = fit(s.Lines[y], f.Cols)
			} else {
				lines[y] = make([]Cell, f.Cols)
			}
		}
		s.Lines = lines
		wraps := make([]bool, f.Rows)
		copy(wraps, s.Wraps)
		s.Wraps = wraps
	}
	for _, r := range f.Lines {
		if r.Y >= s.Rows {
			continue
		}
		cells, err := DecodeRow(r.Data, s.Cols)
		if err != nil {
			return err
		}
		s.Lines[r.Y] = fit(cells, s.Cols)
		s.Wraps[r.Y] = r.Wrap
	}
	if s.Links == nil {
		s.Links = map[uint16]string{}
	}
	for _, l := range f.Links {
		s.Links[l.ID] = l.URI
	}
	if f.Title != nil {
		s.Title = *f.Title
	}
	if f.Colors != nil {
		s.Colors = *f.Colors
	}
	if f.Selection != nil {
		s.Selection = *f.Selection
	}
	if f.Find != nil {
		s.Find = *f.Find
	}
	s.History, s.Offset, s.Cursor, s.Modes, s.Seq = f.History, f.Offset, f.Cursor, f.Modes, f.Seq
	return nil
}

func fit(cells []Cell, cols int) []Cell {
	out := make([]Cell, cols)
	copy(out, cells)
	return out
}

// Text is the screen's text, one string per row.
func (s *Screen) Text() []string {
	out := make([]string, len(s.Lines))
	for i, l := range s.Lines {
		out[i] = RowText(l)
	}
	return out
}
