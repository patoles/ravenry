package vt

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"regexp/syntax"
	"sort"
	"strings"
	"unicode/utf8"

	gt "go.mitchellh.com/libghostty"
)

// Find (Cmd+F) searches the screen and its scrollback. It keeps the text
// of the rows, read with libghostty's plain formatter (a native pass over
// the pages, much faster than a cell at a time), soft-wrapped rows joined
// into one line, and matches in Go: a literal in any case or in this case,
// or a regular expression (RE2, Go's regexp), a line at a time. A match
// may run over a soft wrap.
//
// History rows do not change once written, except when libghostty prunes
// the oldest page, the history is erased (CSI 3 J, Clear), or a resize
// reflows the rows. So after new output only the rows from the start of
// the line that held the screen's first row are read again; a tracked
// grid ref on the last settled row tells how many rows a prune took, and
// loses its value when the history goes. Anything else reads every row
// again.

// FindOptions says how a search matches.
type FindOptions struct {
	// CaseSensitive: letters match only in the needle's case. Otherwise
	// any case matches.
	CaseSensitive bool
	// Regex: the needle is a regular expression (Go's regexp, RE2
	// syntax), matched within a line (soft-wrapped rows joined).
	Regex bool
}

// PatternError is a needle that is not a regular expression; Reason is
// Go's words for why ("missing closing )").
type PatternError struct{ Reason string }

func (e *PatternError) Error() string { return "vt: pattern: " + e.Reason }

// findSpan is a match: bytes Off to End of the search's text.
type findSpan struct{ Off, End int32 }

// Find is a search of the screen and its scrollback.
type Find struct {
	s      *ghostty
	needle string
	opts   FindOptions
	re     *regexp.Regexp
	lit    []byte // a literal needle; lowered when it ignores ASCII case
	fold   bool   // lit is lowered: match it on the text lowered
	bad    string // the needle does not parse: why

	// The rows' text: row y is text[rowOff[y]:], joined to the next row
	// when wrap[y], else ended by '\n' (trailing spaces trimmed).
	text   []byte
	rowOff []int32
	wrap   []bool
	// Rows before settled are history read already; pin tracks row
	// settled-1, to tell how many rows a prune took.
	settled int
	pin     *gt.TrackedGridRef
	gen     uint64 // the screen's generation the text is of
	reflow  uint64
	alt     bool
	read    bool // text holds the screen

	matches []findSpan
	sel     int   // the selected match, -1 none
	selOff  int32 // its offset, to keep it over a new read
	cols    map[int][]int32
	low     []byte // the text with A to Z lowered, as far as it was needed
}

// NewFind starts a search with no needle.
func (s *ghostty) NewFind() (*Find, error) {
	return &Find{s: s, sel: -1}, nil
}

// SetNeedle sets what to find and how; an empty needle clears the
// matches. A regular expression that does not parse returns a
// *PatternError, and the search then has no matches.
func (f *Find) SetNeedle(needle string, o FindOptions) error {
	if needle == f.needle && o == f.opts {
		if f.bad != "" {
			return &PatternError{f.bad}
		}
		return nil
	}
	f.needle, f.opts = needle, o
	f.re, f.lit, f.fold, f.bad = nil, nil, false, ""
	f.matches, f.sel = nil, -1
	if needle == "" {
		return nil
	}
	switch {
	case o.Regex:
		expr := needle
		if !o.CaseSensitive {
			expr = "(?i)" + expr
		}
		re, err := regexp.Compile(expr)
		if err != nil {
			f.bad = patternReason(err)
			return &PatternError{f.bad}
		}
		f.re = re
	case o.CaseSensitive:
		f.lit = []byte(needle)
	case asciiOnly(needle):
		f.lit, f.fold = lowerASCII(nil, []byte(needle)), true
	default:
		// Letters past ASCII in any case: Unicode's case folding.
		f.re = regexp.MustCompile("(?i)" + regexp.QuoteMeta(needle))
	}
	if f.read {
		f.matchFrom(0)
	}
	return nil
}

// patternReason is Go's reason a regular expression does not parse,
// without the expression.
func patternReason(err error) string {
	var se *syntax.Error
	if errors.As(err, &se) {
		return se.Code.String()
	}
	return strings.TrimPrefix(err.Error(), "error parsing regexp: ")
}

// Needle is what the search looks for.
func (f *Find) Needle() string { return f.needle }

// Options are how the search matches.
func (f *Find) Options() FindOptions { return f.opts }

// Update brings the matches up to date with the screen.
func (f *Find) Update() error {
	if f.needle == "" {
		return nil
	}
	s := f.s
	if f.read && f.gen == s.gen {
		return nil
	}
	alt := s.AltScreen()
	from := 0
	if f.read && f.reflow == s.reflow && f.alt == alt && f.pin != nil {
		// Only output since the last read: the history read before is
		// still there, less what a prune took.
		if p, err := f.pin.Point(gt.PointTagScreen); err == nil && int(p.Y) <= f.settled-1 {
			if cut := f.settled - 1 - int(p.Y); cut > 0 {
				f.drop(cut)
			}
			from = f.settled
		}
	}
	if err := f.readFrom(from); err != nil {
		return err
	}
	f.gen, f.reflow, f.alt, f.read = s.gen, s.reflow, alt, true
	return nil
}

// readFrom reads the rows from row `from` to the end of the screen,
// replacing what was read of them, and matches them.
func (f *Find) readFrom(from int) error {
	s := f.s
	history := s.history()
	total := history + s.rows
	from = min(from, len(f.rowOff))
	var off int32
	if from < len(f.rowOff) {
		off = f.rowOff[from]
	} else {
		off = int32(len(f.text))
	}
	f.text, f.rowOff, f.wrap = f.text[:off], f.rowOff[:from], f.wrap[:from]
	f.low = f.low[:min(len(f.low), int(off))]
	for y := range f.cols {
		if y >= from {
			delete(f.cols, y)
		}
	}
	if from < total {
		lines, err := s.plainRows(from, total-1)
		if err != nil {
			return err
		}
		for y := from; y < total; y++ {
			var line string
			if i := y - from; i < len(lines) {
				line = lines[i]
			}
			wrap := false
			if ref, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, Y: uint32(y)}); err == nil {
				if row, err := ref.Row(); err == nil {
					wrap, _ = row.Wrap()
				}
			}
			if y == total-1 {
				wrap = false
			}
			f.rowOff = append(f.rowOff, int32(len(f.text)))
			f.wrap = append(f.wrap, wrap)
			if wrap {
				f.text = append(f.text, line...)
			} else {
				f.text = append(f.text, strings.TrimRight(line, " ")...)
				f.text = append(f.text, '\n')
			}
		}
	}
	// Settled: up to the start of the line that holds the screen's
	// first row; the rows from there may still change.
	settled := min(history, len(f.wrap))
	for settled > 0 && f.wrap[settled-1] {
		settled--
	}
	f.settled = settled
	if f.pin != nil {
		f.pin.Close()
		f.pin = nil
	}
	if settled > 0 {
		f.pin, _ = s.t.TrackGridRef(gt.Point{Tag: gt.PointTagScreen, Y: uint32(settled - 1)})
	}
	f.matchFrom(int(off))
	return nil
}

// drop forgets the first n rows (a prune took them).
func (f *Find) drop(n int) {
	n = min(n, len(f.rowOff))
	if n == 0 {
		return
	}
	cut := int32(len(f.text))
	if n < len(f.rowOff) {
		cut = f.rowOff[n]
	}
	f.text = append(f.text[:0], f.text[cut:]...)
	if len(f.low) > int(cut) {
		f.low = append(f.low[:0], f.low[cut:]...)
	} else {
		f.low = f.low[:0]
	}
	f.rowOff = append(f.rowOff[:0], f.rowOff[n:]...)
	for i := range f.rowOff {
		f.rowOff[i] -= cut
	}
	f.wrap = append(f.wrap[:0], f.wrap[n:]...)
	f.settled -= n
	i := sort.Search(len(f.matches), func(i int) bool { return f.matches[i].Off >= cut })
	f.matches = append(f.matches[:0], f.matches[i:]...)
	for i := range f.matches {
		f.matches[i].Off -= cut
		f.matches[i].End -= cut
	}
	if f.sel >= 0 {
		f.selOff -= cut
	}
	f.cols = nil
}

// matchFrom matches the text from byte off (a line's start) on,
// replacing the matches there, and keeps the selected match when it is
// still there.
func (f *Find) matchFrom(off int) {
	i := sort.Search(len(f.matches), func(i int) bool { return int(f.matches[i].Off) >= off })
	f.matches = f.matches[:i]
	text := f.text[off:]
	add := func(a, b int) {
		if b > a {
			f.matches = append(f.matches, findSpan{int32(off + a), int32(off + b)})
		}
	}
	switch {
	case f.bad != "" || f.needle == "":
	case f.re != nil:
		for p := 0; p < len(text); {
			end := bytes.IndexByte(text[p:], '\n')
			if end < 0 {
				end = len(text)
			} else {
				end += p
			}
			for _, m := range f.re.FindAllIndex(text[p:end], -1) {
				add(p+m[0], p+m[1])
			}
			p = end + 1
		}
	case bytes.IndexByte(f.lit, '\n') >= 0:
	default:
		if f.fold {
			f.low = lowerASCII(f.low, f.text[len(f.low):])
			text = f.low[off:]
		}
		for p := 0; ; {
			j := bytes.Index(text[p:], f.lit)
			if j < 0 {
				break
			}
			add(p+j, p+j+len(f.lit))
			p += j + len(f.lit)
		}
	}
	if f.sel >= 0 {
		f.sel = -1
		if k := sort.Search(len(f.matches), func(k int) bool { return f.matches[k].Off >= f.selOff }); k < len(f.matches) && f.matches[k].Off == f.selOff {
			f.sel = k
		}
	}
}

// Step selects the next match toward older output (dir > 0) or newer
// (dir < 0), round at the ends, and returns it. With none selected, the
// newest is next and the oldest previous.
func (f *Find) Step(dir int) (Range, bool, error) {
	n := len(f.matches)
	if n == 0 {
		return Range{}, false, nil
	}
	switch {
	case f.sel < 0 && dir < 0:
		f.sel = 0
	case f.sel < 0:
		f.sel = n - 1
	case dir < 0:
		f.sel = (f.sel + 1) % n
	default:
		f.sel = (f.sel - 1 + n) % n
	}
	f.selOff = f.matches[f.sel].Off
	return f.span(f.matches[f.sel]), true, nil
}

// Matches returns the count of matches, the selected one's index (from
// the newest, -1 for none) and span, and the matches on screen rows top
// to top+rows-1, in reading order.
func (f *Find) Matches(top, rows int) (count, index int, selected *Range, in []Range, err error) {
	count, index = len(f.matches), -1
	if f.sel >= 0 {
		index = count - 1 - f.sel
		sp := f.span(f.matches[f.sel])
		selected = &sp
	}
	if rows <= 0 || count == 0 {
		return count, index, selected, nil, nil
	}
	i := sort.Search(count, func(i int) bool { return f.rowOf(f.matches[i].End-1) >= top })
	for ; i < count && f.rowOf(f.matches[i].Off) < top+rows; i++ {
		in = append(in, f.span(f.matches[i]))
	}
	return count, index, selected, in, nil
}

// rowOf is the row of a byte of the text.
func (f *Find) rowOf(off int32) int {
	return sort.Search(len(f.rowOff), func(y int) bool { return f.rowOff[y] > off }) - 1
}

// span is a match's cells.
func (f *Find) span(m findSpan) Range {
	y0, y1 := f.rowOf(m.Off), f.rowOf(m.End-1)
	x0, _ := f.cellOf(y0, m.Off)
	x1, wide := f.cellOf(y1, m.End-1)
	if wide {
		x1++
	}
	return Range{X0: x0, Y0: y0, X1: x1, Y1: y1}
}

// cellOf is the column of byte off of row y's text, and whether its cell
// is wide. A row of ASCII text has a byte per cell; another row's cells
// are read once and kept.
func (f *Find) cellOf(y int, off int32) (int, bool) {
	if y < 0 {
		return 0, false
	}
	a := f.rowOff[y]
	b := int32(len(f.text))
	if y+1 < len(f.rowOff) {
		b = f.rowOff[y+1]
	}
	i := int(off - a)
	row := f.text[a:b]
	if asciiOnly(string(row)) {
		return min(i, f.s.cols-1), false
	}
	m, ok := f.cols[y]
	if !ok {
		m = f.s.rowCells(y, len(row))
		if f.cols == nil {
			f.cols = map[int][]int32{}
		}
		f.cols[y] = m
	}
	if len(m) == 0 {
		return 0, false
	}
	v := m[min(i, len(m)-1)]
	return int(v & 0xffff), v>>16 != 0
}

// rowCells maps each byte of row y's text (as the plain formatter writes
// it: an empty cell a space, a wide character once) to its cell: the
// column, and 1<<16 when the cell is wide.
func (s *ghostty) rowCells(y, n int) []int32 {
	m := make([]int32, 0, n)
	for x := 0; x < s.cols && len(m) < n; x++ {
		ref, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, X: uint16(x), Y: uint32(y)})
		if err != nil {
			break
		}
		c, err := ref.Cell()
		if err != nil {
			break
		}
		w, _ := c.Wide()
		if w == gt.CellWideSpacerTail || w == gt.CellWideSpacerHead {
			continue
		}
		v := int32(x)
		if w == gt.CellWideWide {
			v |= 1 << 16
		}
		size := 1
		if cps, _ := ref.Graphemes(); len(cps) > 0 {
			size = 0
			for _, cp := range cps {
				size += utf8.RuneLen(rune(cp))
			}
		}
		for range size {
			m = append(m, v)
		}
	}
	return m
}

// plainRows formats rows a to b (screen coordinates) as plain text, one
// line per row; blank rows at the end may be left out.
func (s *ghostty) plainRows(a, b int) ([]string, error) {
	ra, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, Y: uint32(a)})
	if err != nil {
		return nil, fmt.Errorf("vt: find: %w", err)
	}
	rb, err := s.t.GridRef(gt.Point{Tag: gt.PointTagScreen, X: uint16(s.cols - 1), Y: uint32(b)})
	if err != nil {
		return nil, fmt.Errorf("vt: find: %w", err)
	}
	fm, err := gt.NewFormatter(s.t,
		gt.WithFormatterFormat(gt.FormatterFormatPlain),
		gt.WithFormatterTrim(false),
		gt.WithFormatterUnwrap(false),
		gt.WithFormatterSelection(&gt.Selection{Start: *ra, End: *rb}),
	)
	if err != nil {
		return nil, fmt.Errorf("vt: formatter: %w", err)
	}
	defer fm.Close()
	out, err := fm.FormatString()
	if err != nil {
		return nil, fmt.Errorf("vt: format: %w", err)
	}
	return strings.Split(out, "\n"), nil
}

// Close frees the search.
func (f *Find) Close() {
	if f.pin != nil {
		f.pin.Close()
		f.pin = nil
	}
	f.text, f.rowOff, f.wrap, f.matches, f.cols, f.low = nil, nil, nil, nil, nil, nil
}

func asciiOnly(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// lowerASCII appends src with A to Z lowered (every other byte as is,
// so offsets stay the same) to dst.
func lowerASCII(dst, src []byte) []byte {
	for _, c := range src {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		dst = append(dst, c)
	}
	return dst
}
