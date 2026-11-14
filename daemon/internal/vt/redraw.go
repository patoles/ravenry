package vt

/*
#include <stddef.h>
// daemon/patches/ghostty-redraw-history.patch
int ghostty_terminal_ravenry_erase_history(void *terminal, size_t y, size_t x, size_t n, size_t *erased);
*/
import "C"

import (
	"bytes"
	"reflect"
	"strings"
	"unicode/utf8"
	"unsafe"

	gt "go.mitchellh.com/libghostty"
)

// A program's full redraw and the stale copy it leaves in the scrollback.
//
// Claude Code, after a SIGWINCH and whenever its frame is taller than the
// screen and changes, moves to the top left, erases every row of the
// screen and draws its whole frame again from there (as recorded from the
// maintainer's panes: ESC[H, then ESC[2K ESC[1B for each row, then the
// frame, in one synchronized update). What of the frame does not fit
// scrolls into the scrollback, and the rows that held it before stay
// there: the program cannot erase rows above the screen. So each such
// redraw left a copy of the frame's top in the scrollback, and a taller
// screen (which does not pull rows back from the scrollback while the
// cursor is not on the last row: Claude Code's prompt has rows under it)
// left the rows the program drew again at the top of the screen. The
// pane's history, and the Live screen and phone feed read from it, showed
// earlier messages twice.
//
// When such a redraw ends (its synchronized update ends, or the write
// that started it, without one), the longest run of text just above the
// frame's first row that is exactly the text the frame starts with, white
// space aside (a copy laid out at another width matches), is that stale
// copy, and goes: whole rows, and the end of the row it starts in when it
// starts within one (Claude Code's last rows may start in the middle of a
// paragraph). Only rows the program may draw again count: those from the
// first row of its previous full redraw down, or any after a resize. A
// run shorter than staleMin characters, or one shorter text repeated (a
// rule, the same word over and over), is left: either can be shared by
// chance. Otherwise real scrollback does not match: a frame does not
// start with the text right above it unless the program drew it twice,
// or the session itself repeats there exactly (a message and its whole
// answer twice in a row, the frame starting at the second).

// redrawStarts are what a program sends to erase its whole screen from
// the top: Claude Code's row by row erase, and the one sequence forms.
var redrawStarts = [][]byte{
	[]byte("\x1b[H\x1b[2K\x1b[1B\x1b[2K\x1b[1B"),
	[]byte("\x1b[H\x1b[2J"),
	[]byte("\x1b[H\x1b[J"),
	[]byte("\x1b[H\x1b[0J"),
}

// redrawScan bounds how far above a frame the stale copy is looked for.
const redrawScan = 20000

// redrawState is the open full redraw and what the next one compares with.
type redrawState struct {
	// open: a full redraw started and its check is still to run; top is
	// its frame's first row, zone the first row a stale copy may start
	// on (the previous redraw's top), any: a resize came before it, so
	// any row may.
	open bool
	// sync: it started in a synchronized update, and ends with it;
	// inSync: the program's output is in one now.
	sync, inSync bool
	top          *gt.TrackedGridRef
	zone         *gt.TrackedGridRef
	any          bool
	// last is the top of the last full redraw, the next one's zone;
	// resized: a resize since it began.
	last    *gt.TrackedGridRef
	resized bool
	// erased counts the stale rows removed (tests).
	erased int
}

// terminalPtr is libghostty's handle behind t, for the patched call
// above: the first field of gt.Terminal (checked once, below).
func terminalPtr(t *gt.Terminal) unsafe.Pointer {
	if !ptrFieldOK {
		return nil
	}
	return *(*unsafe.Pointer)(unsafe.Pointer(t))
}

var ptrFieldOK = func() bool {
	f, ok := reflect.TypeFor[gt.Terminal]().FieldByName("ptr")
	return ok && f.Offset == 0 && f.Type.Size() == unsafe.Sizeof(unsafe.Pointer(nil))
}()

// redrawAt is where in p a full redraw starts, or -1.
func redrawAt(p []byte) int {
	at := -1
	for _, m := range redrawStarts {
		if i := bytes.Index(p, m); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	return at
}

var (
	syncOnSeq  = []byte("\x1b[?2026h")
	syncOffSeq = []byte("\x1b[?2026l")
)

// writeRedraws feeds p, opening a full redraw where one starts and
// checking it when it ends: at the end of the program's synchronized
// update (followed in its output here: the render hold may end the mode
// before the program does), or at the end of the write without one.
func (s *ghostty) writeRedraws(p []byte) {
	rd := &s.rd
	for len(p) > 0 {
		i := redrawAt(p)
		if rd.open && rd.sync {
			if j := bytes.Index(p, syncOffSeq); j >= 0 && (i < 0 || j < i) {
				j += len(syncOffSeq)
				s.feed(p[:j])
				p = p[j:]
				s.redrawEnd()
				continue
			}
		}
		if i < 0 {
			s.feed(p)
			break
		}
		s.feed(p[:i])
		s.redrawEnd()
		s.redrawBegin()
		// The cursor home (3 bytes) is the start; the rest goes on.
		s.feed(p[i : i+3])
		p = p[i+3:]
	}
	if rd.open && !rd.sync {
		s.redrawEnd()
	}
}

// feed writes p to the terminal, following whether the program is in a
// synchronized update.
func (s *ghostty) feed(p []byte) {
	on, off := bytes.LastIndex(p, syncOnSeq), bytes.LastIndex(p, syncOffSeq)
	if on > off {
		s.rd.inSync = true
	} else if off > on {
		s.rd.inSync = false
	}
	s.t.VTWrite(p)
}

// redrawBegin opens a full redraw: its frame starts on the screen's
// first row.
func (s *ghostty) redrawBegin() {
	rd := &s.rd
	if s.AltScreen() {
		return
	}
	top, err := s.t.TrackGridRef(gt.Point{Tag: gt.PointTagActive})
	if err != nil {
		return
	}
	if rd.zone != nil {
		rd.zone.Close()
	}
	rd.open, rd.top, rd.zone, rd.any, rd.sync = true, top, rd.last, rd.resized, rd.inSync
	rd.resized = false
	if t, err := s.t.TrackGridRef(gt.Point{Tag: gt.PointTagActive}); err == nil {
		rd.last = t
	} else {
		rd.last = nil
	}
}

// redrawEnd runs the open redraw's check.
func (s *ghostty) redrawEnd() {
	rd := &s.rd
	if !rd.open {
		return
	}
	rd.open = false
	top := rd.top
	rd.top = nil
	defer top.Close()
	if s.AltScreen() || !top.HasValue() || (!rd.any && (rd.zone == nil || !rd.zone.HasValue())) {
		return
	}
	tp, err := top.Point(gt.PointTagScreen)
	if err != nil {
		return
	}
	t := int(tp.Y)
	hist := s.history()
	if t <= 0 || t > hist {
		return
	}
	z := max(0, t-redrawScan)
	if !rd.any {
		zp, err := rd.zone.Point(gt.PointTagScreen)
		if err != nil {
			return
		}
		z = max(z, int(zp.Y))
	}
	if z >= t {
		return
	}
	rows, err := s.plainRows(z, hist+s.rows-1)
	if err != nil {
		return
	}
	for len(rows) < hist+s.rows-z {
		rows = append(rows, "")
	}
	r, off, n := staleCopy(rows[:t-z], rows[t-z:])
	if n == 0 {
		return
	}
	x := 0
	if off > 0 {
		x = s.colOf(z+r, rows[r], off)
		if x <= 0 {
			// Its cells could not be told apart: the row stays whole.
			r, n, x = r+1, n-1, 0
			if n == 0 {
				return
			}
		}
	}
	s.eraseHistory(z+r, x, n)
}

// staleMin is the shortest stale run taken, in characters without white
// space: a few characters alike on both sides of the frame's top are
// more likely chance than a copy.
const staleMin = 16

// staleCopy finds the stale copy at the end of old (the rows above a
// frame): the longest text at its end, white space aside, that is also
// the start of the frame's text. It returns the row it starts in, where
// in that row's text without white space (0: the row whole), and how many
// rows from that one to old's end; n is 0 when there is none.
func staleCopy(old, frame []string) (row, off, n int) {
	var f strings.Builder
	for _, r := range frame {
		f.WriteString(squeeze(r))
	}
	fs := f.String()
	if fs == "" {
		return 0, 0, 0
	}
	// The end of old, no longer than the frame's text, and where each of
	// its rows starts in it.
	var parts []string
	size := 0
	first := len(old)
	for i := len(old) - 1; i >= 0 && size < len(fs); i-- {
		sq := squeeze(old[i])
		parts = append(parts, sq)
		size += len(sq)
		first = i
	}
	starts := make([]int, len(parts))
	var o strings.Builder
	for k := len(parts) - 1; k >= 0; k-- {
		starts[len(parts)-1-k] = o.Len()
		o.WriteString(parts[k])
	}
	ot := o.String()
	k := overlap(ot, fs)
	if k < staleMin || periodic(fs[:k]) {
		return 0, 0, 0
	}
	at := len(ot) - k
	// The row the run starts in: the one whose text holds its first
	// character.
	i := 0
	for j := range starts {
		if l := len(parts[len(parts)-1-j]); l > 0 && starts[j] <= at && at < starts[j]+l {
			i = j
		}
	}
	off = at - starts[i]
	row = first + i
	return row, off, len(old) - row
}

// overlap is the length of the longest end of a that is also a start of
// b (the prefix function of b, run over a).
func overlap(a, b string) int {
	pi := make([]int, len(b))
	for i, k := 1, 0; i < len(b); i++ {
		for k > 0 && b[i] != b[k] {
			k = pi[k-1]
		}
		if b[i] == b[k] {
			k++
		}
		pi[i] = k
	}
	k := 0
	for i := 0; i < len(a); i++ {
		for k > 0 && (k == len(b) || a[i] != b[k]) {
			k = pi[k-1]
		}
		if k < len(b) && a[i] == b[k] {
			k++
		}
	}
	return k
}

// periodic reports whether s is a shorter text repeated (twice or more,
// the last time maybe in part): a run of the same words or a rule, which
// the end of real scrollback and the start of a frame can share by
// chance. A stale copy is a frame's text, which is not.
func periodic(s string) bool {
	if len(s) < 2 {
		return true
	}
	pi := 0
	p := make([]int, len(s))
	for i := 1; i < len(s); i++ {
		for pi > 0 && s[i] != s[pi] {
			pi = p[pi-1]
		}
		if s[i] == s[pi] {
			pi++
		}
		p[i] = pi
	}
	return 2*(len(s)-p[len(s)-1]) <= len(s)
}

// colOf is the column of row y (screen coordinates), whose text is text,
// where its off-th character not white space starts; 0 when not found.
func (s *ghostty) colOf(y int, text string, off int) int {
	b, n := -1, 0
	for i := 0; i < len(text); {
		r, w := utf8.DecodeRuneInString(text[i:])
		if !isSpace(r) {
			if n == off {
				b = i
				break
			}
			n += w
		}
		i += w
	}
	if b < 0 {
		return 0
	}
	cells := s.rowCells(y, b+1)
	if b >= len(cells) {
		return 0
	}
	return int(cells[b] & 0xffff)
}

// squeeze is s without its white space (spaces, the no-break space Claude
// Code puts after a tool's result mark, tabs).
func squeeze(s string) string {
	if strings.IndexFunc(s, isSpace) < 0 {
		return s
	}
	return strings.Map(func(r rune) rune {
		if isSpace(r) {
			return -1
		}
		return r
	}, s)
}

func isSpace(r rune) bool { return r == ' ' || r == '\t' || r == ' ' }

// eraseHistory removes n scrollback rows from row y (screen
// coordinates), the first from column x on (x > 0: its cells before x
// stay); the screen keeps its rows.
func (s *ghostty) eraseHistory(y, x, n int) {
	p := terminalPtr(s.t)
	if p == nil {
		return
	}
	var done C.size_t
	if C.ghostty_terminal_ravenry_erase_history(p, C.size_t(y), C.size_t(x), C.size_t(n), &done) != 0 {
		return
	}
	s.gen++
	s.reflow++
	s.rd.erased += int(done)
}

// redrawClose frees the redraw check's tracked rows.
func (s *ghostty) redrawClose() {
	for _, r := range []*gt.TrackedGridRef{s.rd.top, s.rd.zone, s.rd.last} {
		if r != nil {
			r.Close()
		}
	}
	s.rd = redrawState{}
}
