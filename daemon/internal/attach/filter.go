// Package attach is the shared half of a native terminal window: what sits
// between a full terminal emulator (Ghostty's embedding library on macOS,
// and later on Linux; any terminal for `ravenry attach`) and a pane of the
// daemon.
//
// Such a terminal draws the pane's output and runs its own parser, so it
// also answers the queries a program sends. The daemon answers many of them
// already, whether or not a window is attached (PROTOCOL.md section 3), and
// a program that reads two answers shows the second as typed text
// (^[[?62;22c at the prompt). So the queries split in two:
//
//   - What the screen's state decides, the daemon answers: device
//     attributes (DA1, DA2, DA3), status and cursor position (DSR, CPR),
//     modes (DECRQM), settings (DECRQSS), XTVERSION, the Kitty keyboard
//     flags, Kitty graphics, the palette (OSC 4). Filter drops the
//     window's answers to these.
//   - What only the window knows, the window answers: its colours (OSC 10
//     to 19), light or dark (CSI ? 996 n), its size in pixels and
//     characters (XTWINOPS, CSI ... t), terminfo capabilities (XTGETTCAP).
//     The daemon does not answer these, and Filter lets them through.
//
// Filter drops only what a keyboard cannot produce, so no key is ever lost,
// with one exception that it resolves with Queries: a cursor position
// report (CSI row;col R) looks like Ctrl+F3 in the legacy encoding
// (CSI 1;5 R), so it is dropped only while the program has a position
// query outstanding.
package attach

import (
	"bytes"
	"sync"
	"time"
)

// Queries counts the cursor position queries a program sent and the
// terminal has not answered yet. Output feeds it, Filter reads it.
type Queries struct {
	mu   sync.Mutex
	cpr  int
	last time.Time
}

// An answer is expected within this long of its query; an answer that
// never came (a terminal that does not answer) stops counting after it.
const queryTTL = 2 * time.Second

var cprQueries = [][]byte{[]byte("\x1b[6n"), []byte("\x1b[?6n")}

// Output notes the queries in a span of the pane's output.
func (q *Queries) Output(b []byte) {
	if bytes.IndexByte(b, 0x1b) < 0 {
		return
	}
	n := 0
	for _, s := range cprQueries {
		n += bytes.Count(b, s)
	}
	if n == 0 {
		return
	}
	q.mu.Lock()
	if time.Since(q.last) > queryTTL {
		q.cpr = 0
	}
	q.cpr += n
	q.last = time.Now()
	q.mu.Unlock()
}

// takeCPR reports whether a position report is expected, and counts it.
func (q *Queries) takeCPR() bool {
	if q == nil {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cpr == 0 || time.Since(q.last) > queryTTL {
		q.cpr = 0
		return false
	}
	q.cpr--
	return true
}

// Filter drops a terminal's answers from what it writes. Feed it each read
// as it comes: a sequence cut by the end of a read is passed on as it is,
// since a lone ESC, Alt+[ and Alt+] are keys that end a read too, and a
// terminal writes each answer in one write.
type Filter struct {
	Queries *Queries
	paste   bool // inside a bracketed paste: everything passes
}

var (
	pasteStart = []byte("\x1b[200~")
	pasteEnd   = []byte("\x1b[201~")
)

// Write returns in with the answers left out. It may return in itself.
func (f *Filter) Write(in []byte) []byte {
	if !f.paste && bytes.IndexByte(in, 0x1b) < 0 {
		return in
	}
	out := make([]byte, 0, len(in))
	i := 0
	for i < len(in) {
		if f.paste {
			j := bytes.Index(in[i:], pasteEnd)
			if j < 0 {
				return append(out, in[i:]...)
			}
			end := i + j + len(pasteEnd)
			out = append(out, in[i:end]...)
			i = end
			f.paste = false
			continue
		}
		j := bytes.IndexByte(in[i:], 0x1b)
		if j < 0 {
			return append(out, in[i:]...)
		}
		out = append(out, in[i:i+j]...)
		i += j
		n, drop := f.sequence(in[i:])
		if n == 0 {
			// Cut by the end of the read: a key, or not ours to judge.
			return append(out, in[i:]...)
		}
		if !drop {
			out = append(out, in[i:i+n]...)
		}
		i += n
	}
	return out
}

// sequence measures the escape sequence at the start of b (b[0] is ESC)
// and says whether it is an answer. n is 0 when b ends before it does.
func (f *Filter) sequence(b []byte) (n int, drop bool) {
	if len(b) < 2 {
		return 0, false
	}
	switch b[1] {
	case '[':
		return f.csi(b)
	case ']', 'P', '_', '^', 'X':
		// OSC, DCS, APC, PM, SOS: a keyboard sends none of them.
		for k := 2; k < len(b); k++ {
			switch {
			case b[k] == 0x07 && b[1] == ']':
				return k + 1, daemonAnswers(b[1], b[2:k])
			case b[k] == 0x1b && k+1 < len(b) && b[k+1] == '\\':
				return k + 2, daemonAnswers(b[1], b[2:k])
			case b[k] == 0x1b && k+1 < len(b):
				// Another escape before the end: not a string after all
				// (Alt+] then a key). Pass the first two bytes.
				return 2, false
			}
		}
		return 0, false
	default:
		return 2, false // Alt+key, SS3 keys (ESC O A) pass in two steps
	}
}

// daemonAnswers says whether a string answer (OSC, DCS, APC) answers a
// query the daemon answers too.
func daemonAnswers(kind byte, body []byte) bool {
	switch kind {
	case ']': // OSC 4: the palette. OSC 10 to 19 (colours), 52 (clipboard) are the window's.
		return bytes.HasPrefix(body, []byte("4;"))
	case 'P': // XTVERSION, DA3, DECRQSS; not XTGETTCAP (1+r, 0+r)
		return bytes.HasPrefix(body, []byte(">|")) || bytes.HasPrefix(body, []byte("!|")) ||
			bytes.HasPrefix(body, []byte("1$r")) || bytes.HasPrefix(body, []byte("0$r"))
	case '_': // Kitty graphics
		return bytes.HasPrefix(body, []byte("G"))
	}
	return false
}

func (f *Filter) csi(b []byte) (int, bool) {
	k := 2
	for k < len(b) && b[k] >= 0x30 && b[k] <= 0x3f {
		k++
	}
	params := b[2:k]
	for k < len(b) && b[k] >= 0x20 && b[k] <= 0x2f {
		k++
	}
	inter := b[2+len(params) : k]
	if k >= len(b) {
		return 0, false
	}
	final := b[k]
	n := k + 1
	if final < 0x40 || final > 0x7e {
		return 2, false // not a CSI; let the bytes through
	}
	if bytes.Equal(b[:n], pasteStart) {
		f.paste = true
		return n, false
	}
	priv := len(params) > 0 && (params[0] == '?' || params[0] == '>' || params[0] == '=')
	switch {
	case final == 'c' && priv: // DA1, DA2 answers
		return n, true
	case final == 'y' && bytes.Equal(inter, []byte("$")): // DECRPM
		return n, true
	case final == 'n' && !priv: // DSR status (CSI 0 n); not the colour scheme (CSI ? 997 ; n n)
		return n, true
	case final == 'u' && priv: // Kitty keyboard flags (CSI ? flags u)
		return n, true
	case final == 'R' && priv: // DECXCPR (CSI ? row ; col R)
		return n, true
	case final == 'R' && len(inter) == 0 && bytes.IndexByte(params, ';') >= 0:
		// CSI row;col R, or Ctrl/Shift/Alt+F3 (CSI 1;mods R).
		return n, f.Queries.takeCPR()
	}
	return n, false
}
