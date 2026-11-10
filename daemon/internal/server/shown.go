package server

import (
	"bytes"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"ravenryd/internal/pane"
)

// What "Typed here" shows of an input record (InputRecord.Shown): the
// lines a person or an agent entered, as a shell's line editing leaves
// them (2026-11-10: the panel showed "<Esc>", arrows and focus reports,
// nothing anyone could read). Backspace and Ctrl+H take back a character,
// Ctrl+U and Ctrl+C the line, Ctrl+W a word; Enter ends a line; a paste
// is its text; arrows, Home, End, Tab, Esc, Alt keys and other control
// keys show nothing. A record with no line left shows nothing (a menu
// answered with arrows and Enter, a lone Esc). Text keeps every key for
// the audit; only what is shown is edited.

// lineEditor replays typed bytes into lines. A gathered keys record keeps
// one while it grows, so a Backspace takes back what an earlier keystroke
// typed. It is only fed bytes already masked.
type lineEditor struct {
	lines []string
	cur   []rune
	paste bool
}

// feed replays one input (one display frame, one item: an Esc at its end
// is the Esc key, not the start of a sequence).
func (e *lineEditor) feed(b []byte) {
	for len(b) > 0 {
		if n, _ := termReport(b); n > 0 {
			b = b[n:]
			continue
		}
		c := b[0]
		if c == 0x1b {
			b = e.escape(b)
			continue
		}
		if e.paste {
			switch {
			case c == '\r' || c == '\n':
				e.end()
			case c == '\t' || c >= 0x20 && c != 0x7f:
				r, n := utf8.DecodeRune(b)
				e.cur = append(e.cur, r)
				b = b[n:]
				continue
			}
			b = b[1:]
			continue
		}
		switch {
		case c == '\r' || c == '\n':
			e.end()
		case c == 0x7f || c == 0x08:
			e.back()
		case c == 0x15 || c == 0x03: // Ctrl+U, Ctrl+C
			e.cur = nil
		case c == 0x17: // Ctrl+W
			e.word()
		case c < 0x20:
			// Tab, Ctrl+A, Ctrl+E, Ctrl+D...: nothing shown
		default:
			r, n := utf8.DecodeRune(b)
			if r != utf8.RuneError || n > 1 {
				e.cur = append(e.cur, r)
			}
			b = b[n:]
			continue
		}
		b = b[1:]
	}
}

// escape takes the sequence at b[0] (an Esc) and returns what follows it.
func (e *lineEditor) escape(b []byte) []byte {
	switch {
	case bytes.HasPrefix(b, []byte("\x1b[200~")):
		e.paste = true
		return b[6:]
	case bytes.HasPrefix(b, []byte("\x1b[201~")):
		e.paste = false
		return b[6:]
	case len(b) >= 2 && b[1] == '[':
		if n := csiLen(b); n > 0 {
			e.csi(b[:n])
			return b[n:]
		}
		return b[2:]
	case len(b) >= 3 && b[1] == 'O': // SS3: arrows, F1 to F4
		return b[3:]
	case len(b) >= 2 && b[1] == '\r': // Alt+Enter: a new line
		e.end()
		return b[2:]
	case len(b) >= 2 && b[1] >= 0x20 && b[1] < 0x7f: // Alt and a key
		return b[2:]
	}
	return b[1:] // the Esc key
}

// csiLen is the length of the CSI sequence at b, or 0.
func csiLen(b []byte) int {
	i := 2
	for i < len(b) && b[i] >= 0x20 && b[i] <= 0x3f {
		i++
	}
	if i >= len(b) || b[i] < 0x40 || b[i] > 0x7e {
		return 0
	}
	return i + 1
}

// csi takes a key the terminal sent as a CSI sequence: a Kitty keyboard
// protocol key (CSI code;mods;text u) by what it does, the rest (arrows,
// Delete, function keys) as nothing shown.
func (e *lineEditor) csi(seq []byte) {
	if seq[len(seq)-1] != 'u' || len(seq) < 4 || seq[2] < '0' || seq[2] > '9' {
		return
	}
	f := strings.Split(string(seq[2:len(seq)-1]), ";")
	code, alt := splitColon(f[0])
	mods, event := 1, 1
	if len(f) > 1 {
		m, ev := splitColon(f[1])
		mods = max(m, 1)
		event = max(ev, 1)
	}
	if event == 3 { // a release
		return
	}
	mods--
	ctrl, other := mods&4 != 0, mods&(2|8|16|32) != 0
	switch {
	case code == 13:
		e.end()
		return
	case code == 127 || code == 8:
		e.back()
		return
	case ctrl:
		switch code {
		case 'u', 'c':
			e.cur = nil
		case 'w':
			e.word()
		case 'h':
			e.back()
		}
		return
	case other || code == 27 || code == 9:
		return
	}
	if len(f) > 2 && f[2] != "" {
		for _, cp := range strings.Split(f[2], ":") {
			if r, err := strconv.Atoi(cp); err == nil && r >= 0x20 {
				e.cur = append(e.cur, rune(r))
			}
		}
		return
	}
	if mods&1 != 0 && alt > 0 {
		code = alt
	}
	if code >= 0x20 && code < 0xe000 { // above: Kitty's functional keys
		e.cur = append(e.cur, rune(code))
	}
}

// splitColon reads "a:b" as two numbers (0 when absent).
func splitColon(s string) (int, int) {
	a, b, _ := strings.Cut(s, ":")
	x, _ := strconv.Atoi(a)
	y, _ := strconv.Atoi(strings.SplitN(b, ":", 2)[0])
	return x, y
}

// key replays a key item of pane.send (vt.ParseKey's names).
func (e *lineEditor) key(name string) {
	switch k := strings.ToLower(name); k {
	case "enter", "return", "kpenter":
		e.end()
	case "backspace", "ctrl+h":
		e.back()
	case "ctrl+u", "ctrl+c":
		e.cur = nil
	case "ctrl+w":
		e.word()
	case "space":
		e.cur = append(e.cur, ' ')
	default:
		if r, n := utf8.DecodeRuneInString(name); n == len(name) && r >= 0x20 {
			e.cur = append(e.cur, r)
		}
	}
}

func (e *lineEditor) back() {
	if len(e.cur) > 0 {
		e.cur = e.cur[:len(e.cur)-1]
	}
}

// word takes back a word as a shell's Ctrl+W does: the spaces before the
// cursor, then the word.
func (e *lineEditor) word() {
	i := len(e.cur)
	for i > 0 && unicode.IsSpace(e.cur[i-1]) {
		i--
	}
	for i > 0 && !unicode.IsSpace(e.cur[i-1]) {
		i--
	}
	e.cur = e.cur[:i]
}

// end ends the line: kept when it has something to show.
func (e *lineEditor) end() {
	if l := strings.TrimRightFunc(string(e.cur), unicode.IsSpace); strings.TrimSpace(l) != "" {
		e.lines = append(e.lines, l)
	}
	e.cur = nil
}

// String is what is shown: the lines entered, then the one being typed.
func (e *lineEditor) String() string {
	out := e.lines
	if l := strings.TrimRightFunc(string(e.cur), unicode.IsSpace); strings.TrimSpace(l) != "" {
		out = append(out[:len(out):len(out)], l)
	}
	return clip(strings.Join(out, "\n"), maxInputText)
}

// feedBytes feeds b, masked as the pane masks its secrets, unless nothing
// of it may be shown (typed at a password prompt).
func feedBytes(p *pane.Pane, b []byte) func(*lineEditor) {
	if p.PasswordPrompt() {
		return nil
	}
	m, _ := p.MaskSecrets(b)
	return func(e *lineEditor) { e.feed(m) }
}

// feedItems feeds pane.send's items, masked as feedBytes does.
func feedItems(p *pane.Pane, items []pane.InputItem) func(*lineEditor) {
	if p.PasswordPrompt() {
		return nil
	}
	type item struct {
		key  string
		text []byte
	}
	its := make([]item, len(items))
	for i, it := range items {
		its[i].key = it.Key
		if it.Key == "" {
			its[i].text, _ = p.MaskSecrets([]byte(it.Text))
		}
	}
	return func(e *lineEditor) {
		for _, it := range its {
			if it.key != "" {
				e.key(it.key)
			} else {
				e.feed(it.text)
			}
		}
	}
}
