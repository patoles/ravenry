package vt

import (
	"fmt"
	"math"
	"strings"
	"time"

	gt "go.mitchellh.com/libghostty"
)

// The one place ravenryd touches go.mitchellh.com/libghostty.

type ghostty struct {
	t     *gt.Terminal
	plain *gt.Formatter
	vtf   *gt.Formatter
	keys  *gt.KeyEncoder
	ev    *gt.KeyEvent
	rs    *gt.RenderState
	ri    *gt.RenderStateRowIterator
	rc    *gt.RenderStateRowCells
	buf   []byte
	cols  int
	rows  int
	title string
	// scrollback is the number of history lines the screen keeps at
	// least (Options.Scrollback).
	scrollback int
	// defPal is the palette the screen starts with, to tell the entries a
	// program changed (OSC 4).
	defPal    [16]RGB
	defPal256 [256]RGB

	// The render stream (render.go): a program's render hold
	// (synchronized output) and since when; the render state of a
	// scrolled view; buffers; the hyperlinks seen, by id.
	held   bool
	heldAt time.Time
	// vcols and vrows are the size the render stream reads the screen
	// at while the grid keeps another (SetView); 0: the grid's.
	vcols, vrows int
	// frozen: Freeze keeps the render state as it was, since frozenAt.
	frozen   bool
	frozenAt time.Time
	hs       *gt.RenderState
	rbuf     []byte
	tbuf     []byte
	rstyles  map[uint64][styleSize]byte
	links    []string
	linkIDs  map[string]uint16
	linkTop  int
	mouse    *gt.MouseEncoder
	mev      *gt.MouseEvent

	// The selection gesture (select.go).
	sel selState

	// gen counts changes to the text (output, a resize, Clear); reflow
	// counts those that may change the history's rows (find.go).
	gen, reflow uint64
}

// snapshotExtras restores everything except the palette: a client keeps
// its own colour theme, and the daemon's default palette is not the
// user's choice.
const snapshotExtras = gt.FormatterExtrasAll &^ gt.FormatterExtraPalette

// modeAltScreen is DEC private mode 1049.
var (
	modeAltScreen = gt.NewMode(1049, false)
)

// New returns a Screen backed by libghostty-vt.
func New(o Options) (Screen, error) {
	if o.Cols <= 0 || o.Rows <= 0 || o.Cols > 0xffff || o.Rows > 0xffff {
		return nil, fmt.Errorf("vt: bad size %dx%d", o.Cols, o.Rows)
	}
	s := &ghostty{cols: o.Cols, rows: o.Rows, scrollback: max(o.Scrollback, 0),
		rstyles: map[uint64][styleSize]byte{}, linkIDs: map[string]uint16{}, linkTop: -1}
	opts := []gt.TerminalOption{
		gt.WithSize(uint16(o.Cols), uint16(o.Rows)),
		// The history is counted in lines only. libghostty also has a byte
		// limit, 10,000 bytes by default, which it rounds up to one page
		// (about 400 KB): left at the default, that page decided, and a
		// pane kept some 600 lines at 100 columns, fewer when wider. With
		// no byte limit the line limit bounds the memory instead.
		gt.WithMaxScrollbackBytes(math.MaxUint),
		gt.WithMaxScrollbackLines(lineLimit(o.Scrollback, o.Cols)),
		gt.WithRenderHold(func(_ *gt.Terminal, held bool) { s.onRenderHold(held) }),
		gt.WithTitleChanged(func(t *gt.Terminal) {
			if title, err := t.Title(); err == nil {
				s.title = title
			}
		}),
	}
	if o.Reply != nil {
		reply, kitty := o.Reply, o.KittyKeyboard
		opts = append(opts, gt.WithWritePty(func(_ *gt.Terminal, p []byte) {
			if kitty != nil && isKittyKeyboardReply(p) && !kitty() {
				return
			}
			reply(p)
		}))
	}
	if o.Bell != nil {
		bell := o.Bell
		opts = append(opts, gt.WithBell(func(*gt.Terminal) { bell() }))
	}
	if o.Prompt != nil {
		fn := o.Prompt
		opts = append(opts, gt.WithSemanticPrompt(func(_ *gt.Terminal, ev gt.TerminalSemanticPrompt) {
			m := PromptMark{Command: ev.Command, ExitCode: ev.ExitCode, HasExitCode: ev.HasExitCode}
			switch ev.Kind {
			case gt.SemanticPromptStart:
				m.Kind = PromptStart
			case gt.SemanticPromptInputStart:
				m.Kind = InputStart
			case gt.SemanticPromptOutputStart:
				m.Kind = OutputStart
			case gt.SemanticPromptCommandEnd:
				m.Kind = CommandEnd
			default:
				return // a kind added after this build
			}
			fn(m)
		}))
	}
	if o.Status != nil {
		fn := o.Status
		opts = append(opts, gt.WithProgramStatus(func(_ *gt.Terminal, st gt.ProgramStatus) {
			r := ProgramStatus{Progress: int(st.Progress), ID: st.ID, App: st.App, Title: st.Title, Message: st.Message}
			switch st.State {
			case gt.ProgramStatusStateIdle:
				r.State = "idle"
			case gt.ProgramStatusStateWorking:
				r.State = "working"
			case gt.ProgramStatusStateDone:
				r.State = "done"
			case gt.ProgramStatusStateBlocked:
				r.State = "blocked"
			case gt.ProgramStatusStateError:
				r.State = "error"
			case gt.ProgramStatusStateClear:
				r.State = "clear"
			default:
				return // a state added after this build
			}
			switch st.Kind {
			case gt.ProgramStatusKindPermission:
				r.Kind = "permission"
			case gt.ProgramStatusKindQuestion:
				r.Kind = "question"
			case gt.ProgramStatusKindAuth:
				r.Kind = "auth"
			}
			fn(r)
		}))
	}
	if o.Pwd != nil {
		fn := o.Pwd
		opts = append(opts, gt.WithPwdChanged(func(t *gt.Terminal) {
			if pwd, err := t.Pwd(); err == nil && pwd != "" {
				fn(pwd)
			}
		}))
	}
	t, err := gt.NewTerminal(opts...)
	if err != nil {
		return nil, fmt.Errorf("vt: new terminal: %w", err)
	}
	s.t = t
	if s.plain, err = gt.NewFormatter(t,
		gt.WithFormatterFormat(gt.FormatterFormatPlain),
		gt.WithFormatterTrim(false),
		gt.WithFormatterUnwrap(false),
	); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: plain formatter: %w", err)
	}
	if s.vtf, err = newVTFormatter(t); err != nil {
		s.Close()
		return nil, err
	}
	if s.keys, err = gt.NewKeyEncoder(); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: key encoder: %w", err)
	}
	if s.ev, err = gt.NewKeyEvent(); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: key event: %w", err)
	}
	if s.rs, err = gt.NewRenderState(); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: render state: %w", err)
	}
	if s.ri, err = gt.NewRenderStateRowIterator(); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: row iterator: %w", err)
	}
	if s.rc, err = gt.NewRenderStateRowCells(); err != nil {
		s.Close()
		return nil, fmt.Errorf("vt: row cells: %w", err)
	}
	if err := s.rs.Update(s.t); err == nil {
		if colors, err := s.rs.Colors(); err == nil {
			for i := range s.defPal256 {
				s.defPal256[i] = rgb(colors.Palette[i])
			}
			copy(s.defPal[:], s.defPal256[:16])
		}
	}
	return s, nil
}

// pageBytes bounds the cell memory of one libghostty page: its standard
// page is 215 by 215 cells in 400 KB (page.zig std_capacity at the pinned
// commit), with some room to spare. TestPageRowsBound checks it.
const pageBytes = 512 << 10

// pageRows bounds how many rows one page holds at this width: a row costs
// 8 bytes of metadata and 8 per cell.
func pageRows(cols int) int { return pageBytes/(8+8*max(cols, 1)) + 1 }

// lineLimit is the line limit to give libghostty for a screen that must
// keep at least n history lines. libghostty prunes whole pages: once the
// history passes its limit it drops the oldest page, so the history falls
// back to the limit less up to a page. One page more than n keeps n.
func lineLimit(n, cols int) uint {
	if n <= 0 {
		return 0
	}
	return uint(n + pageRows(cols))
}

// isKittyKeyboardReply reports whether p is libghostty's answer to the
// Kitty keyboard protocol query: ESC [ ? flags u, written whole in one
// call (stream_terminal.zig queryKittyKeyboard).
func isKittyKeyboardReply(p []byte) bool {
	if len(p) < 5 || p[0] != 0x1b || p[1] != '[' || p[2] != '?' || p[len(p)-1] != 'u' {
		return false
	}
	for _, c := range p[3 : len(p)-1] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func newVTFormatter(t *gt.Terminal) (*gt.Formatter, error) {
	f, err := gt.NewFormatter(t,
		gt.WithFormatterFormat(gt.FormatterFormatVT),
		gt.WithFormatterExtras(snapshotExtras),
		// Untrimmed, so empty rows at the bottom are kept and the cursor
		// lands on the same row as in the source.
		gt.WithFormatterTrim(false),
		gt.WithFormatterUnwrap(false),
	)
	if err != nil {
		return nil, fmt.Errorf("vt: vt formatter: %w", err)
	}
	return f, nil
}

func (s *ghostty) Write(p []byte) {
	s.gen++
	s.t.VTWrite(p)
}

func (s *ghostty) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 0xffff || rows > 0xffff {
		return fmt.Errorf("vt: bad size %dx%d", cols, rows)
	}
	// A wider screen at a shell prompt does not pull rows back out of the
	// scrollback. The shell draws its prompt and command line again
	// itself; what a narrower width had pushed up into the scrollback
	// are old copies of them (zsh's ">...." rows of a command line taller
	// than the screen), and pulled back above the new prompt they show
	// as debris. A taller screen, and any other program's, still pulls.
	s.gen++
	s.reflow++
	pull := !(cols != s.cols && s.AtPrompt())
	s.t.SetResizePullScrollback(pull)
	held, heldAt := s.held, s.heldAt
	err := s.t.Resize(uint16(cols), uint16(rows), 0, 0)
	s.t.SetResizePullScrollback(true)
	if held && !s.held {
		// libghostty ends synchronized output (2026) on every resize, and
		// its render hold with it. A program caught in the middle of its
		// redraw then showed what it had drawn so far: Claude Code, on a
		// SIGWINCH, erases every row and draws them again over 50 to 150
		// ms, and a drag's steps come every 8 to 17 ms, so during a drag
		// the pane showed blank or only a few rows (140 of 234 frames of
		// a recorded drag). The hold goes on until the program ends it
		// (2026l), showing the last frame it finished, and still ends
		// renderHoldMax after it began. Setting the mode does not call
		// onRenderHold, so the render state keeps that frame.
		s.t.SetMode(modeSync, true)
		s.held, s.heldAt = true, heldAt
	}
	if err != nil {
		return fmt.Errorf("vt: resize: %w", err)
	}
	if cols != s.cols {
		limit := lineLimit(s.scrollback, cols)
		if err := s.t.SetScrollbackMaxLines(&limit); err != nil {
			return fmt.Errorf("vt: scrollback limit: %w", err)
		}
	}
	s.cols, s.rows = cols, rows
	return nil
}

func (s *ghostty) Size() (int, int) { return s.cols, s.rows }

func (s *ghostty) Title() string { return s.title }

func (s *ghostty) AltScreen() bool {
	on, err := s.t.Mode(modeAltScreen)
	return err == nil && on
}

// allLines formats the active screen as plain text: scrollback rows first,
// then one line per visible row.
func (s *ghostty) allLines() ([]string, error) {
	out, err := s.plain.FormatString()
	if err != nil {
		return nil, fmt.Errorf("vt: format: %w", err)
	}
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	// The formatter leaves out blank rows at the bottom of the screen: put
	// them back, so the last s.rows lines are the visible rows.
	total, err := s.t.TotalRows()
	if err != nil {
		return nil, fmt.Errorf("vt: total rows: %w", err)
	}
	for len(lines) > int(total) && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) < int(total) {
		lines = append(lines, "")
	}
	return lines, nil
}

// Text reads the visible rows through libghostty's render state, which
// reads a whole row per call and does not touch the scrollback.
func (s *ghostty) Text() ([]string, error) {
	// During a program's render hold this is the last frame it
	// finished, as on a screen.
	if _, err := s.update(); err != nil {
		return nil, err
	}
	if err := s.rs.RowIterator(s.ri); err != nil {
		return nil, fmt.Errorf("vt: row iterator: %w", err)
	}
	lines := make([]string, 0, s.rows)
	for s.ri.Next() {
		b, err := s.ri.AppendText(s.buf[:0], s.rc)
		if err != nil {
			return nil, fmt.Errorf("vt: row text: %w", err)
		}
		s.buf = b
		lines = append(lines, strings.TrimRight(string(b), " "))
	}
	return lastRows(lines, s.rows), nil
}

// lastRows returns the last n lines, padded with empty lines at the end
// when there are fewer.
func lastRows(lines []string, n int) []string {
	if len(lines) >= n {
		return lines[len(lines)-n:]
	}
	out := make([]string, n)
	copy(out, lines)
	return out
}

func (s *ghostty) Capture(o CaptureOptions) (*Capture, error) {
	text, err := s.Text()
	if err != nil {
		return nil, err
	}
	hist := 0
	if o.History > 0 {
		all, err := s.allLines()
		if err != nil {
			return nil, err
		}
		hist = min(o.History, max(len(all)-s.rows, 0))
		text = append(all[len(all)-s.rows-hist:len(all)-s.rows:len(all)-s.rows], text...)
	}
	c := &Capture{Cols: s.cols, Rows: s.rows, History: hist, Alt: s.AltScreen(), Title: s.title}
	c.Lines = make([]Line, len(text))
	for i, l := range text {
		c.Lines[i].Text = l
	}
	x, _ := s.t.CursorX()
	y, _ := s.t.CursorY()
	vis, _ := s.t.CursorVisible()
	c.Cursor = Cursor{X: int(x), Y: int(y), Visible: vis}
	if o.Styles {
		for i := range c.Lines {
			var p gt.Point
			if i < hist {
				// History rows, counted from the top of the scrollback.
				sb, err := s.t.ScrollbackRows()
				if err != nil {
					return nil, fmt.Errorf("vt: scrollback rows: %w", err)
				}
				p = gt.Point{Tag: gt.PointTagHistory, Y: uint32(int(sb) - hist + i)}
			} else {
				p = gt.Point{Tag: gt.PointTagActive, Y: uint32(i - hist)}
			}
			spans, err := s.spans(p)
			if err != nil {
				return nil, err
			}
			c.Lines[i].Spans = spans
		}
	}
	return c, nil
}

// spans reads one row cell by cell and returns its runs of non-default
// style.
func (s *ghostty) spans(row gt.Point) ([]Span, error) {
	var out []Span
	var cur *Span
	var text strings.Builder
	flush := func() {
		if cur != nil {
			cur.Text = text.String()
			out = append(out, *cur)
			cur = nil
		}
		text.Reset()
	}
	for x := 0; x < s.cols; x++ {
		row.X = uint16(x)
		ref, err := s.t.GridRef(row)
		if err != nil {
			return nil, fmt.Errorf("vt: grid ref: %w", err)
		}
		cell, err := ref.Cell()
		if err != nil {
			return nil, fmt.Errorf("vt: cell: %w", err)
		}
		wide, _ := cell.Wide()
		if wide == gt.CellWideSpacerTail || wide == gt.CellWideSpacerHead {
			// The second half of a wide character belongs to the first.
			if cur != nil {
				cur.Width++
			}
			continue
		}
		st, err := ref.Style()
		if err != nil {
			return nil, fmt.Errorf("vt: style: %w", err)
		}
		style := convStyle(st)
		cps, _ := ref.Graphemes()
		if style == (Style{}) {
			flush()
			continue
		}
		if cur == nil || cur.Style != style {
			flush()
			cur = &Span{Col: x, Style: style}
		}
		cur.Width++
		if len(cps) == 0 {
			text.WriteByte(' ')
		}
		for _, cp := range cps {
			text.WriteRune(rune(cp))
		}
	}
	flush()
	// A run of styled blanks at the end of a row (a cleared line with a
	// background) is kept: the colour is information.
	return out, nil
}

func convStyle(st *gt.Style) Style {
	if st == nil || st.IsDefault() {
		return Style{}
	}
	return Style{
		Bold:      st.Bold(),
		Dim:       st.Faint(),
		Italic:    st.Italic(),
		Underline: st.Underline() != gt.UnderlineNone,
		Blink:     st.Blink(),
		Inverse:   st.Inverse(),
		Invisible: st.Invisible(),
		Strike:    st.Strikethrough(),
		Fg:        convColor(st.FgColor()),
		Bg:        convColor(st.BgColor()),
	}
}

func convColor(c gt.StyleColor) Color {
	switch c.Tag {
	case gt.StyleColorPalette:
		return Color{Kind: ColorPalette, Index: c.Palette}
	case gt.StyleColorRGB:
		r, g, b := c.RGB.Components()
		return Color{Kind: ColorRGB, R: r, G: g, B: b}
	}
	return Color{}
}

// Snapshot starts with a full reset (RIS), so it can be written into a
// terminal that already shows something. On the alternate screen it first
// rebuilds the primary screen from a copy of the terminal, then switches to
// the alternate screen and draws it, so the client gets the shell's history
// back when the program leaves the alternate screen.
func (s *ghostty) Snapshot() ([]byte, error) {
	out := []byte("\x1bc")
	if s.AltScreen() {
		prim, err := s.primaryVT()
		if err != nil {
			return nil, err
		}
		out = append(out, prim...)
	}
	b, err := s.vtf.Format()
	if err != nil {
		return nil, fmt.Errorf("vt: format vt: %w", err)
	}
	return append(out, b...), nil
}

// primaryVT formats the primary screen while the alternate one is active:
// it copies the terminal through libghostty's snapshot codec, leaves the
// alternate screen on the copy, and formats that.
func (s *ghostty) primaryVT() ([]byte, error) {
	snap, err := s.t.Snapshot()
	if err != nil {
		return nil, fmt.Errorf("vt: snapshot: %w", err)
	}
	d, err := gt.NewSnapshotDecoderBytes(snap)
	if err != nil {
		return nil, fmt.Errorf("vt: snapshot decoder: %w", err)
	}
	defer d.Close()
	cp, err := d.Decode()
	if err != nil {
		return nil, fmt.Errorf("vt: snapshot decode: %w", err)
	}
	defer cp.Close()
	cp.VTWrite([]byte("\x1b[?1049l"))
	f, err := newVTFormatter(cp)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := f.Format()
	if err != nil {
		return nil, fmt.Errorf("vt: format primary: %w", err)
	}
	return b, nil
}

func (s *ghostty) Clear() (bool, error) {
	if s.AltScreen() {
		return false, nil
	}
	s.gen++
	s.reflow++
	y, err := s.t.CursorY()
	if err != nil {
		return false, fmt.Errorf("vt: cursor: %w", err)
	}
	top := int(y)
	if at, err := s.t.CursorAtPrompt(); err == nil && at {
		top = s.promptTop(top)
	}
	// Scroll the rows above the prompt off the top and follow with the
	// cursor (it keeps its column), then erase the history, which also
	// takes what the scroll pushed into it.
	var b []byte
	if top > 0 {
		b = fmt.Appendf(b, "\x1b[%dS\x1b[%dA", top, top)
	}
	s.t.VTWrite(append(b, "\x1b[3J"...))
	return true, nil
}

// promptTop is the first row of the prompt the cursor's row y belongs
// to: up through the prompt's continuation rows to the row its OSC 133 A
// started on. Without such a row it is y.
func (s *ghostty) promptTop(y int) int {
	sem := func(r int) gt.RowSemanticPrompt {
		ref, err := s.t.GridRef(gt.Point{Tag: gt.PointTagActive, Y: uint32(r)})
		if err != nil {
			return gt.RowSemanticNone
		}
		row, err := ref.Row()
		if err != nil {
			return gt.RowSemanticNone
		}
		v, err := row.Semantic()
		if err != nil {
			return gt.RowSemanticNone
		}
		return v
	}
	for r := y; r >= 0; r-- {
		switch sem(r) {
		case gt.RowSemanticPromptPrimary:
			return r
		case gt.RowSemanticPromptContinuation:
			continue
		}
		return y
	}
	return y
}

func (s *ghostty) EncodeKey(k Key) ([]byte, error) {
	if err := s.keys.SetFromTerminal(s.t); err != nil {
		return nil, fmt.Errorf("vt: key encoder: %w", err)
	}
	var mods gt.Mods
	if k.Ctrl {
		mods |= gt.ModCtrl
	}
	if k.Alt {
		mods |= gt.ModAlt
	}
	if k.Shift {
		mods |= gt.ModShift
	}
	if k.Super {
		mods |= gt.ModSuper
	}
	ev := s.ev
	ev.SetAction(gt.KeyActionPress)
	ev.SetMods(mods)
	ev.SetConsumedMods(0)
	ev.SetComposing(false)
	if k.Name != "" {
		name, ok := keyNames[k.Name]
		if !ok {
			return nil, fmt.Errorf("vt: unknown key %q", k.Name)
		}
		key, err := gt.ParseKey(name.ghostty)
		if err != nil {
			return nil, fmt.Errorf("vt: key %q: %w", k.Name, err)
		}
		ev.SetKey(key)
		ev.SetUnshiftedCodepoint(name.cp)
		utf := ""
		if name.cp != 0 && !k.Ctrl && !k.Alt && !k.Super {
			utf = string(name.cp)
		}
		ev.SetUTF8(utf)
	} else {
		base := k.Char
		key, shifted := charKey(base)
		if shifted {
			base = unshift(base)
		}
		ev.SetKey(key)
		ev.SetUnshiftedCodepoint(base)
		utf := ""
		if !k.Ctrl && !k.Alt && !k.Super {
			ch := k.Char
			if k.Shift && ch >= 'a' && ch <= 'z' {
				ch -= 'a' - 'A'
			}
			utf = string(ch)
			if k.Shift || shifted {
				ev.SetConsumedMods(gt.ModShift)
			}
		}
		if shifted {
			ev.SetMods(mods | gt.ModShift)
		}
		ev.SetUTF8(utf)
	}
	b, err := s.keys.Encode(ev)
	if err != nil {
		return nil, fmt.Errorf("vt: encode key: %w", err)
	}
	if len(b) == 0 && k.Name == "" && !k.Ctrl && !k.Super {
		// A character the encoder has no key for: send its text.
		b = []byte(string(k.Char))
		if k.Alt {
			b = append([]byte{0x1b}, b...)
		}
	}
	return b, nil
}

func (s *ghostty) EncodePaste(text []byte) ([]byte, error) {
	on, err := s.t.Mode(gt.NewMode(2004, false))
	if err != nil {
		return nil, fmt.Errorf("vt: bracketed paste mode: %w", err)
	}
	b, err := gt.PasteEncode(text, on)
	if err != nil {
		return nil, fmt.Errorf("vt: paste: %w", err)
	}
	return b, nil
}

func (s *ghostty) Close() {
	if s.sel.g != nil {
		for _, e := range s.sel.ev {
			e.Close()
		}
		s.sel.g.Close(s.t)
	}
	if s.hs != nil {
		s.hs.Close()
	}
	if s.mev != nil {
		s.mev.Close()
	}
	if s.mouse != nil {
		s.mouse.Close()
	}
	if s.rc != nil {
		s.rc.Close()
	}
	if s.ri != nil {
		s.ri.Close()
	}
	if s.rs != nil {
		s.rs.Close()
	}
	if s.ev != nil {
		s.ev.Close()
	}
	if s.keys != nil {
		s.keys.Close()
	}
	if s.vtf != nil {
		s.vtf.Close()
	}
	if s.plain != nil {
		s.plain.Close()
	}
	if s.t != nil {
		s.t.Close()
	}
	*s = ghostty{}
}

// EngineVersion is the version of libghostty-vt linked into the binary.
func EngineVersion() string { return gt.Version() }

// SetScrollback changes how many history lines are kept (pane.update).
func (s *ghostty) SetScrollback(lines int) error {
	s.scrollback = max(lines, 0)
	s.gen++
	s.reflow++
	limit := lineLimit(s.scrollback, s.cols)
	if err := s.t.SetScrollbackMaxLines(&limit); err != nil {
		return fmt.Errorf("vt: scrollback limit: %w", err)
	}
	return nil
}
